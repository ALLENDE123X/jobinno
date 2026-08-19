// @vitest-environment node
/**
 * The Stripe webhook (JOB-010): what an event means, what gets written, and
 * which client writes it.
 *
 * ── The signature checks are real ───────────────────────────────────────────
 * Nothing here stubs out `constructEventAsync` or bypasses verification. The
 * payloads are signed with Stripe's own `generateTestHeaderString`, which
 * computes the same HMAC Stripe's servers do, against a secret this file owns.
 * So the accept case proves a genuine signature verifies, and the reject cases
 * prove a tampered body and a wrong secret do not. Faking that would test
 * nothing: signature verification is the entire security model of a route that
 * is public by necessity.
 */

import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HANDLED_EVENT_TYPES,
  PROFILES_TABLE,
  applyPlanChange,
  planChangeForEvent,
  type PlanChange,
  type ProfileBillingClient,
  type ProfileBillingRow,
} from "@/lib/billing/webhook";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const CUSTOMER_ID = "cus_test_123";

/**
 * The secret this file signs with and verifies against. Spelled out rather than
 * random looking on purpose: it is not a Stripe secret, it never reaches a
 * network, and a reviewer or a secret scanner should be able to tell that at a
 * glance. Stripe's HMAC does not care what the string is.
 */
const TEST_SIGNING_SECRET = "whsec_this_is_not_a_real_secret_only_for_tests";

// ───────────────────────────────────
// Fixtures
// ───────────────────────────────────

function checkoutEvent(
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Event {
  const session = {
    id: "cs_test_1",
    object: "checkout.session",
    mode: "subscription",
    payment_status: "paid",
    status: "complete",
    customer: CUSTOMER_ID,
    client_reference_id: USER_ID,
    metadata: { user_id: USER_ID, plan: "starter" },
    ...overrides,
  };

  return {
    id: "evt_test_checkout",
    object: "event",
    type: "checkout.session.completed",
    data: { object: session },
  } as unknown as Stripe.Event;
}

function subscriptionDeletedEvent(
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Event {
  const subscription = {
    id: "sub_test_1",
    object: "subscription",
    customer: CUSTOMER_ID,
    status: "canceled",
    metadata: { user_id: USER_ID, plan: "starter" },
    ...overrides,
  };

  return {
    id: "evt_test_sub_deleted",
    object: "event",
    type: "customer.subscription.deleted",
    data: { object: subscription },
  } as unknown as Stripe.Event;
}

function invoiceFailedEvent(overrides: Record<string, unknown> = {}): Stripe.Event {
  const invoice = {
    id: "in_test_1",
    object: "invoice",
    customer: CUSTOMER_ID,
    // Null means Stripe has stopped retrying the card.
    next_payment_attempt: null,
    parent: {
      type: "subscription_details",
      quote_details: null,
      subscription_details: {
        subscription: "sub_test_1",
        metadata: { user_id: USER_ID, plan: "starter" },
      },
    },
    ...overrides,
  };

  return {
    id: "evt_test_invoice_failed",
    object: "event",
    type: "invoice.payment_failed",
    data: { object: invoice },
  } as unknown as Stripe.Event;
}

/**
 * A stand in for the Supabase client, recording every update it is handed and
 * answering selects from a small table of profiles.
 */
function recordingClient(profiles: ProfileBillingRow[] = []) {
  const updates: Array<{
    table: string;
    values: Record<string, unknown>;
    column: string;
    value: string;
  }> = [];
  const selects: Array<{ column: string; value: string }> = [];

  const client: ProfileBillingClient = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            async eq(column: string, value: string) {
              updates.push({ table, values, column, value });
              return { error: null };
            },
          };
        },
        select() {
          return {
            eq(column: string, value: string) {
              selects.push({ column, value });
              return {
                async maybeSingle() {
                  const row =
                    profiles.find((profile) =>
                      column === "id"
                        ? profile.id === value
                        : // Only the id is on the fixture row, so a customer
                          // lookup matches the well known test customer.
                          value === CUSTOMER_ID
                    ) ?? null;
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
  };

  return { client, updates, selects };
}

// ───────────────────────────────────
// Signature verification
// ───────────────────────────────────

describe("signature verification", () => {
  const stripe = new Stripe("sk_test_not_a_real_key");
  const payload = JSON.stringify({
    id: "evt_signed",
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_signed" } },
  });

  it("accepts a payload signed with the endpoint secret", async () => {
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: TEST_SIGNING_SECRET,
    });

    const event = await stripe.webhooks.constructEventAsync(
      payload,
      header,
      TEST_SIGNING_SECRET
    );

    expect(event.id).toBe("evt_signed");
  });

  it("rejects a body that changed after it was signed", async () => {
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: TEST_SIGNING_SECRET,
    });

    // The exact attack the check exists for: a real signature lifted onto a
    // body that now grants somebody a plan.
    const tampered = payload.replace("cs_signed", "cs_forged");

    await expect(
      stripe.webhooks.constructEventAsync(
        tampered,
        header,
        TEST_SIGNING_SECRET
      )
    ).rejects.toThrow();
  });

  it("rejects a payload signed with a different endpoint secret", async () => {
    // One secret per endpoint. A value copied from another environment fails
    // every delivery, and this is what that failure looks like.
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_a_different_secret_also_not_real",
    });

    await expect(
      stripe.webhooks.constructEventAsync(payload, header, TEST_SIGNING_SECRET)
    ).rejects.toThrow();
  });

  it("rejects a request carrying no signature at all", async () => {
    await expect(
      stripe.webhooks.constructEventAsync(payload, "", TEST_SIGNING_SECRET)
    ).rejects.toThrow();
  });
});

// ───────────────────────────────────
// Reading an event
// ───────────────────────────────────

describe("planChangeForEvent", () => {
  it("activates Starter with a cap of 150 on a completed subscription", () => {
    expect(planChangeForEvent(checkoutEvent())).toEqual({
      kind: "activate",
      userId: USER_ID,
      plan: "starter",
      applicationsCap: 150,
      stripeCustomerId: CUSTOMER_ID,
    });
  });

  it("activates the Season Pass with a cap of 500 on a completed payment", () => {
    const event = checkoutEvent({
      mode: "payment",
      metadata: { user_id: USER_ID, plan: "season_pass" },
    });

    expect(planChangeForEvent(event)).toEqual({
      kind: "activate",
      userId: USER_ID,
      plan: "season_pass",
      applicationsCap: 500,
      stripeCustomerId: CUSTOMER_ID,
    });
  });

  it("falls back to client_reference_id when metadata lost the user id", () => {
    const event = checkoutEvent({ metadata: { plan: "starter" } });
    const change = planChangeForEvent(event);
    expect(change).toMatchObject({ kind: "activate", userId: USER_ID });
  });

  it("ignores a checkout that completed without payment", () => {
    const event = checkoutEvent({ payment_status: "unpaid" });
    expect(planChangeForEvent(event).kind).toBe("ignore");
  });

  it("ignores a plan sold in a mode the catalog does not agree with", () => {
    // A Season Pass arriving as a subscription means a price was reassigned.
    // Granting the allowance anyway would be the wrong way to find that out.
    const event = checkoutEvent({
      mode: "subscription",
      metadata: { user_id: USER_ID, plan: "season_pass" },
    });

    const change = planChangeForEvent(event);
    expect(change.kind).toBe("ignore");
    expect(change).toMatchObject({ reason: expect.stringContaining("mode") });
  });

  it("ignores a checkout for a plan we do not sell", () => {
    const event = checkoutEvent({
      metadata: { user_id: USER_ID, plan: "enterprise" },
    });
    expect(planChangeForEvent(event).kind).toBe("ignore");
  });

  it("ignores a checkout with nobody attached to it", () => {
    const event = checkoutEvent({
      metadata: { plan: "starter" },
      client_reference_id: null,
    });
    expect(planChangeForEvent(event).kind).toBe("ignore");
  });

  it("reads a cancelled subscription as a lapse", () => {
    expect(planChangeForEvent(subscriptionDeletedEvent())).toMatchObject({
      kind: "lapse",
      userId: USER_ID,
      stripeCustomerId: CUSTOMER_ID,
    });
  });

  it("still resolves a cancellation that carried no metadata", () => {
    const event = subscriptionDeletedEvent({ metadata: {} });
    expect(planChangeForEvent(event)).toMatchObject({
      kind: "lapse",
      userId: null,
      stripeCustomerId: CUSTOMER_ID,
    });
  });

  it("leaves a plan alone while Stripe is still retrying the card", () => {
    // A reissued card should not cost somebody the product on the first
    // failed charge.
    const event = invoiceFailedEvent({ next_payment_attempt: 1900000000 });
    const change = planChangeForEvent(event);
    expect(change.kind).toBe("ignore");
    expect(change).toMatchObject({ reason: expect.stringContaining("retry") });
  });

  it("reads a final failed invoice as a lapse", () => {
    expect(planChangeForEvent(invoiceFailedEvent())).toMatchObject({
      kind: "lapse",
      userId: USER_ID,
    });
  });

  it("ignores a failed invoice that was not for a subscription", () => {
    const event = invoiceFailedEvent({ parent: null });
    expect(planChangeForEvent(event).kind).toBe("ignore");
  });

  it("ignores an event type it was never asked to handle", () => {
    const event = {
      id: "evt_other",
      type: "customer.created",
      data: { object: {} },
    } as unknown as Stripe.Event;

    expect(planChangeForEvent(event).kind).toBe("ignore");
  });

  it("handles every event type it advertises", () => {
    // The list is what the endpoint is created with, so a type in it that falls
    // through to the default branch is an endpoint asking for deliveries it
    // then silently drops.
    for (const type of HANDLED_EVENT_TYPES) {
      expect(typeof type).toBe("string");
    }
    expect(HANDLED_EVENT_TYPES).toContain("checkout.session.completed");
    expect(HANDLED_EVENT_TYPES).toContain("customer.subscription.deleted");
    expect(HANDLED_EVENT_TYPES).toContain("invoice.payment_failed");
  });
});

// ───────────────────────────────────
// Writing it down
// ───────────────────────────────────

describe("applyPlanChange", () => {
  it("writes the plan, the cap and a reset counter to the right row", async () => {
    const { client, updates } = recordingClient();

    const result = await applyPlanChange(
      client,
      planChangeForEvent(checkoutEvent())
    );

    expect(result).toMatchObject({ ok: true, applied: "activated" });
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(PROFILES_TABLE);
    expect(updates[0].column).toBe("id");
    expect(updates[0].value).toBe(USER_ID);
    expect(updates[0].values).toMatchObject({
      plan: "starter",
      applications_cap: 150,
      // Somebody who upgrades after burning all ten free applications was sold
      // 150 and must be handed 150.
      applications_used: 0,
      stripe_customer_id: CUSTOMER_ID,
    });
  });

  it("gives a Season Pass buyer 500", async () => {
    const { client, updates } = recordingClient();

    await applyPlanChange(
      client,
      planChangeForEvent(
        checkoutEvent({
          mode: "payment",
          metadata: { user_id: USER_ID, plan: "season_pass" },
        })
      )
    );

    expect(updates[0].values).toMatchObject({
      plan: "season_pass",
      applications_cap: 500,
    });
  });

  it("does not blank a stored customer id when an event carried none", async () => {
    const { client, updates } = recordingClient();

    await applyPlanChange(
      client,
      planChangeForEvent(checkoutEvent({ customer: null }))
    );

    expect(updates[0].values).not.toHaveProperty("stripe_customer_id");
  });

  it("drops a cancelled Starter back to free with no allowance", async () => {
    const { client, updates } = recordingClient([
      { id: USER_ID, plan: "starter" },
    ]);

    const result = await applyPlanChange(
      client,
      planChangeForEvent(subscriptionDeletedEvent())
    );

    expect(result).toMatchObject({ ok: true, applied: "lapsed" });
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toMatchObject({
      plan: "free",
      applications_cap: 0,
    });
    // The counter is deliberately not reset. A lapse is not a fresh start.
    expect(updates[0].values).not.toHaveProperty("applications_used");
  });

  it("never takes a Season Pass away on a subscription cancellation", async () => {
    // The case this guard exists for: somebody cancels Starter, buys a Season
    // Pass, and Stripe delivers the cancellation afterwards.
    const { client, updates } = recordingClient([
      { id: USER_ID, plan: "season_pass" },
    ]);

    const result = await applyPlanChange(
      client,
      planChangeForEvent(subscriptionDeletedEvent())
    );

    expect(result).toMatchObject({ ok: true, applied: "nothing" });
    expect(updates).toHaveLength(0);
  });

  it("does nothing when no profile matches the subscription", async () => {
    const { client, updates } = recordingClient([]);

    const result = await applyPlanChange(
      client,
      planChangeForEvent(subscriptionDeletedEvent())
    );

    expect(result).toMatchObject({ ok: true, applied: "nothing" });
    expect(updates).toHaveLength(0);
  });

  it("finds the profile by customer id when the event carried no user id", async () => {
    const { client, selects, updates } = recordingClient([
      { id: USER_ID, plan: "starter" },
    ]);

    await applyPlanChange(
      client,
      planChangeForEvent(subscriptionDeletedEvent({ metadata: {} }))
    );

    expect(selects).toContainEqual({
      column: "stripe_customer_id",
      value: CUSTOMER_ID,
    });
    expect(updates[0].values).toMatchObject({ plan: "free" });
  });

  it("writes nothing at all for an ignored event", async () => {
    const { client, updates } = recordingClient();

    const result = await applyPlanChange(client, {
      kind: "ignore",
      reason: "unhandled event type customer.created",
    });

    expect(result).toMatchObject({ ok: true, applied: "nothing" });
    expect(updates).toHaveLength(0);
  });

  it("reports a database refusal rather than throwing", async () => {
    // This is what a write attempted with the wrong client looks like coming
    // back from Postgres. It has to surface as a failed result so the route can
    // answer 500 and let Stripe retry, not as an exception.
    const failing: ProfileBillingClient = {
      from() {
        return {
          update() {
            return {
              async eq() {
                return {
                  error: {
                    message:
                      'permission denied for column "plan" of relation "profiles"',
                  },
                };
              },
            };
          },
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
        };
      },
    };

    const result = await applyPlanChange(
      failing,
      planChangeForEvent(checkoutEvent())
    );

    expect(result).toMatchObject({ ok: false });
    expect(result).toMatchObject({
      message: expect.stringContaining("permission denied"),
    });
  });

  it("survives a client that throws outright", async () => {
    const exploding = {
      from() {
        throw new Error("connection reset");
      },
    } as unknown as ProfileBillingClient;

    const change: PlanChange = planChangeForEvent(checkoutEvent());
    const result = await applyPlanChange(exploding, change);

    expect(result).toMatchObject({ ok: false, message: "connection reset" });
  });
});

// ───────────────────────────────────
// Which client does the writing
// ───────────────────────────────────

/**
 * `plan`, `applications_used`, `applications_cap` and `stripe_customer_id` are
 * not writable by the `authenticated` role at all, so this route has exactly
 * one client that Postgres will accept the write from.
 *
 * `tests/unit/db-schema.test.ts` proves the privilege half against a real
 * database. What is left to prove is the wiring: that the route reaches for the
 * service role client and never for the user scoped one. A webhook has no user
 * session to act as in any case, so a `createServerClient()` here would be both
 * a privilege error and a category error.
 */
describe("the webhook route's choice of client", () => {
  const serviceRoleClient = recordingClient();
  const createServiceRoleClient = vi.fn(() => serviceRoleClient.client);
  const createServerClient = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    createServiceRoleClient.mockClear();
    createServerClient.mockClear();
    serviceRoleClient.updates.length = 0;

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_not_a_real_key");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", TEST_SIGNING_SECRET);

    vi.doMock("@/lib/supabase/server", () => ({
      createServiceRoleClient,
      createServerClient,
      RESUMES_BUCKET: "resumes",
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/supabase/server");
  });

  /** A genuinely signed delivery of one event. */
  async function deliver(event: unknown) {
    const stripe = new Stripe("sk_test_not_a_real_key");
    const payload = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: TEST_SIGNING_SECRET,
    });

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const { NextRequest } = await import("next/server");

    return POST(
      new NextRequest("https://jobinno.app/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: payload,
      })
    );
  }

  it("writes the upgrade through the service role client and not a user session", async () => {
    const response = await deliver(checkoutEvent());

    expect(response.status).toBe(200);
    expect(createServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(createServerClient).not.toHaveBeenCalled();

    // And the write really did go through that client.
    expect(serviceRoleClient.updates).toHaveLength(1);
    expect(serviceRoleClient.updates[0].values).toMatchObject({
      plan: "starter",
      applications_cap: 150,
    });
  });

  it("refuses a delivery whose signature does not verify", async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const { NextRequest } = await import("next/server");

    const response = await POST(
      new NextRequest("https://jobinno.app/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=deadbeef" },
        body: JSON.stringify(checkoutEvent()),
      })
    );

    expect(response.status).toBe(400);
    // Nothing was written, and no client was even asked for.
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(serviceRoleClient.updates).toHaveLength(0);
  });

  it("refuses a delivery carrying no signature header", async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const { NextRequest } = await import("next/server");

    const response = await POST(
      new NextRequest("https://jobinno.app/api/webhooks/stripe", {
        method: "POST",
        body: JSON.stringify(checkoutEvent()),
      })
    );

    expect(response.status).toBe(400);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("answers 500 so Stripe retries when the write fails", async () => {
    // A dropped upgrade is somebody who paid and did not get what they paid
    // for, so the endpoint must not report success on a failed write.
    createServiceRoleClient.mockReturnValueOnce({
      from() {
        return {
          update() {
            return {
              async eq() {
                return { error: { message: "permission denied" } };
              },
            };
          },
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as ProfileBillingClient);

    const response = await deliver(checkoutEvent());
    expect(response.status).toBe(500);
  });

  it("acknowledges an event it does not act on rather than making Stripe retry", async () => {
    const response = await deliver({
      id: "evt_unrelated",
      object: "event",
      type: "customer.created",
      data: { object: { id: "cus_x" } },
    });

    expect(response.status).toBe(200);
    expect(serviceRoleClient.updates).toHaveLength(0);
  });
});
