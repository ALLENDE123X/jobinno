/**
 * What a Stripe event means for a profile row, and how that meaning gets
 * written (JOB-010).
 *
 * Split in two on purpose. `planChangeForEvent` is a pure function from an
 * event to an intent, so every branch below is testable without a database and
 * without a network. `applyPlanChange` does the write, against an injected
 * client, so the test can hand it a recorder and assert the exact row.
 *
 * ── The write is service role only, and that is enforced by Postgres ────────
 * `plan`, `applications_used` and `applications_cap` are not writable by the
 * `authenticated` role at all. `drizzle/0003_profiles_column_privileges.sql`
 * took the table wide UPDATE grant away and handed back only the columns a
 * person answers about themselves, so a user session attempting this write gets
 * a permission error from the database rather than a policy denial.
 *
 * That is the correct behavior and not something to route around. The caller in
 * `app/api/webhooks/stripe/route.ts` passes `createServiceRoleClient()`, which
 * bypasses row level security, and there is no second path. A webhook has no
 * user session to act as in any case: the request comes from Stripe, not from a
 * browser holding anybody's cookies.
 */

import type Stripe from "stripe";

import {
  LAPSED_PLAN_CAP,
  paidPlanFor,
  type PaidPlanSlug,
} from "@/lib/billing/plans";

/** The table every write below lands on. Named once so a test cannot drift. */
export const PROFILES_TABLE = "profiles";

/**
 * The events this handler acts on. Anything else is acknowledged and dropped:
 * a webhook endpoint that 400s on an event type it did not ask for teaches
 * Stripe to retry it forever.
 */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.deleted",
  "invoice.payment_failed",
] as const;

export type PlanChange =
  | {
      kind: "activate";
      userId: string;
      plan: PaidPlanSlug;
      applicationsCap: number;
      stripeCustomerId: string | null;
    }
  | {
      kind: "lapse";
      /** From subscription metadata when Stripe carried it through. */
      userId: string | null;
      stripeCustomerId: string | null;
      reason: string;
    }
  | { kind: "ignore"; reason: string };

/**
 * A Stripe reference field is either the id or the expanded object, and a
 * customer can additionally be a deleted one. All three shapes carry an id.
 */
function customerIdOf(
  value: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined
): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/** A metadata value only counts when it is a non empty string. */
function metadataString(
  metadata: Stripe.Metadata | null | undefined,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A completed checkout means somebody paid. Turn it into the plan they bought.
 *
 * The plan comes from metadata we wrote ourselves in
 * `buildCheckoutSessionParams`, which is trustworthy because the signature
 * check upstream already proved the event is Stripe reporting on a session this
 * server created. The mode is cross checked against the catalog anyway: if a
 * price is ever reassigned so that the Season Pass arrives as a subscription,
 * the mismatch should stop the write rather than silently grant an allowance.
 */
function planChangeForCheckout(session: Stripe.Checkout.Session): PlanChange {
  if (session.payment_status === "unpaid") {
    return { kind: "ignore", reason: "checkout completed without payment" };
  }

  const planSlug = metadataString(session.metadata, "plan");
  const plan = paidPlanFor(planSlug);

  if (!plan) {
    return {
      kind: "ignore",
      reason: `checkout carried no plan we sell (${planSlug ?? "absent"})`,
    };
  }

  if (plan.mode !== session.mode) {
    return {
      kind: "ignore",
      reason: `${plan.slug} is sold in ${plan.mode} mode but this session was ${session.mode}`,
    };
  }

  const userId =
    metadataString(session.metadata, "user_id") ?? session.client_reference_id;

  if (!userId) {
    return { kind: "ignore", reason: "checkout carried no user id" };
  }

  return {
    kind: "activate",
    userId,
    plan: plan.slug,
    applicationsCap: plan.applicationsCap,
    stripeCustomerId: customerIdOf(session.customer),
  };
}

/**
 * A failed invoice is not by itself a cancellation. Stripe retries a card on
 * its own dunning schedule, and downgrading on the first failure takes the
 * product away from somebody whose card was merely reissued.
 *
 * `next_payment_attempt` is null once Stripe has stopped retrying, so that is
 * the point where the subscription really is not going to pay, and the point
 * this treats as a lapse. Everything earlier is acknowledged and left alone.
 */
function planChangeForFailedInvoice(invoice: Stripe.Invoice): PlanChange {
  const subscriptionDetails = invoice.parent?.subscription_details;

  if (!subscriptionDetails) {
    return { kind: "ignore", reason: "failed invoice is not for a subscription" };
  }

  if (invoice.next_payment_attempt !== null) {
    return {
      kind: "ignore",
      reason: "payment failed but Stripe will retry the card",
    };
  }

  return {
    kind: "lapse",
    userId: metadataString(subscriptionDetails.metadata, "user_id"),
    stripeCustomerId: customerIdOf(invoice.customer),
    reason: "subscription invoice failed and Stripe stopped retrying",
  };
}

/** The intent an event carries, or an explicit reason to do nothing. */
export function planChangeForEvent(event: Stripe.Event): PlanChange {
  switch (event.type) {
    case "checkout.session.completed":
      return planChangeForCheckout(event.data.object);

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      return {
        kind: "lapse",
        userId: metadataString(subscription.metadata, "user_id"),
        stripeCustomerId: customerIdOf(subscription.customer),
        reason: "subscription ended",
      };
    }

    case "invoice.payment_failed":
      return planChangeForFailedInvoice(event.data.object);

    default:
      return { kind: "ignore", reason: `unhandled event type ${event.type}` };
  }
}

// ───────────────────────────────────
// Writing it down
// ───────────────────────────────────

interface QueryError {
  message: string;
}

/** One profile, in the two columns the lapse path has to reason about. */
export interface ProfileBillingRow {
  id: string;
  plan: string;
}

/**
 * The narrow slice of a Supabase client this module uses. Structural, so a test
 * can pass a recorder and a real client still satisfies it.
 */
export interface ProfileBillingClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(
        column: string,
        value: string
      ): PromiseLike<{ error: QueryError | null }>;
    };
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        maybeSingle(): PromiseLike<{
          data: ProfileBillingRow | null;
          error: QueryError | null;
        }>;
      };
    };
  };
}

export type ApplyPlanChangeResult =
  | { ok: true; applied: "activated" | "lapsed" | "nothing"; detail: string }
  | { ok: false; message: string };

/**
 * Activating a paid plan resets the counter as well as raising the cap.
 *
 * "150 applications per month" has to mean 150 from the moment the person pays,
 * and somebody who upgrades after burning all ten free applications would
 * otherwise be sold 150 and handed 140. The recurring monthly reset for a
 * Starter subscription is a separate job on `invoice.paid` and is deliberately
 * not built here; see the PR for the follow up.
 */
function activationRow(change: Extract<PlanChange, { kind: "activate" }>) {
  const row: Record<string, unknown> = {
    plan: change.plan,
    applications_cap: change.applicationsCap,
    applications_used: 0,
    updated_at: new Date().toISOString(),
  };

  // Only write the customer id when Stripe gave us one, so that a retry of an
  // event that carried none cannot blank a value an earlier event stored.
  if (change.stripeCustomerId) {
    row.stripe_customer_id = change.stripeCustomerId;
  }

  return row;
}

/**
 * Finds the profile a lapse is about, by whichever handle the event carried.
 * The user id is preferred because it is the primary key; the customer id is
 * the fallback for an event that never saw our metadata.
 */
async function findLapsedProfile(
  client: ProfileBillingClient,
  change: Extract<PlanChange, { kind: "lapse" }>
): Promise<{ row: ProfileBillingRow | null; error: QueryError | null }> {
  const table = client.from(PROFILES_TABLE);

  if (change.userId) {
    const { data, error } = await table
      .select("id, plan")
      .eq("id", change.userId)
      .maybeSingle();
    if (data || error) return { row: data, error };
  }

  if (change.stripeCustomerId) {
    const { data, error } = await table
      .select("id, plan")
      .eq("stripe_customer_id", change.stripeCustomerId)
      .maybeSingle();
    return { row: data, error };
  }

  return { row: null, error: null };
}

/**
 * Applies one intent. Never throws: the caller answers Stripe, and an
 * exception escaping here becomes a 500 that Stripe reads as "retry this",
 * which turns one bad row into a retry storm.
 */
export async function applyPlanChange(
  client: ProfileBillingClient,
  change: PlanChange
): Promise<ApplyPlanChangeResult> {
  try {
    if (change.kind === "ignore") {
      return { ok: true, applied: "nothing", detail: change.reason };
    }

    if (change.kind === "activate") {
      const { error } = await client
        .from(PROFILES_TABLE)
        .update(activationRow(change))
        .eq("id", change.userId);

      if (error) return { ok: false, message: error.message };

      return {
        ok: true,
        applied: "activated",
        detail: `${change.plan} with a cap of ${change.applicationsCap}`,
      };
    }

    const { row, error } = await findLapsedProfile(client, change);

    if (error) return { ok: false, message: error.message };

    if (!row) {
      return {
        ok: true,
        applied: "nothing",
        detail: "no profile matched that subscription",
      };
    }

    // Only a Starter subscription can lapse. A Season Pass is a single payment
    // with no subscription behind it, so a cancellation arriving after somebody
    // bought one must not take the pass away, and a profile already on the free
    // tier has nothing to take.
    if (row.plan !== "starter") {
      return {
        ok: true,
        applied: "nothing",
        detail: `profile is on ${row.plan}, which no subscription pays for`,
      };
    }

    const { error: updateError } = await client
      .from(PROFILES_TABLE)
      .update({
        plan: "free",
        applications_cap: LAPSED_PLAN_CAP,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    if (updateError) return { ok: false, message: updateError.message };

    return { ok: true, applied: "lapsed", detail: change.reason };
  } catch (thrown) {
    return {
      ok: false,
      message:
        thrown instanceof Error ? thrown.message : "The profile write failed.",
    };
  }
}
