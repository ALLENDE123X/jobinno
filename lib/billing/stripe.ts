/**
 * The server half of billing (JOB-010): the Stripe client, and the parameters
 * a Checkout Session is created from.
 *
 * Never import this from a client component. It reads `STRIPE_SECRET_KEY`, and
 * a module that touches a secret has no business being reachable from anything
 * that gets bundled for a browser. `lib/billing/plans.ts` holds the parts the
 * landing page is allowed to see.
 *
 * ── Why the parameter builder is its own exported function ──────────────────
 * `buildCheckoutSessionParams` is pure. That is what lets a test assert that
 * the Season Pass is sold in `payment` mode and the Starter in `subscription`
 * mode without a network call and without a live key. Getting that pair wrong
 * is the expensive mistake in this file: one of them bills a person every month
 * for something they bought once.
 */

import Stripe from "stripe";

import {
  paidPlanFor,
  priceIdFor,
  type EnvLookup,
  type PaidPlan,
} from "@/lib/billing/plans";

/**
 * Where Stripe sends a person afterwards. Relative paths, resolved against the
 * request's own origin by the caller, so that a preview deployment returns to
 * itself rather than to production.
 */
export const CHECKOUT_SUCCESS_PATH = "/billing/success";
export const CHECKOUT_CANCEL_PATH = "/#pricing";

/**
 * The Stripe client. Built per call rather than kept in a module level
 * singleton, because a route handler on Vercel is already one instance per
 * invocation and a cached client only adds a way for a rotated key to keep
 * being used by a warm lambda.
 *
 * No `apiVersion` is pinned: the SDK defaults to the version its own types were
 * generated from, so pinning a different string here is how the types and the
 * wire format quietly stop agreeing.
 */
export function createStripeClient(env: EnvLookup = process.env): Stripe {
  const secretKey = env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set, so nothing can be sold. See .env.example."
    );
  }

  return new Stripe(secretKey);
}

export interface CheckoutSessionInput {
  /** `profiles.id`, which is also `auth.users.id`. */
  userId: string;
  /** The address the account is under, so Stripe can prefill the form. */
  email: string;
  plan: PaidPlan;
  /** The Stripe price id, already read from the environment. */
  priceId: string;
  /** The origin this request arrived on, with no trailing slash. */
  origin: string;
  /**
   * An existing Stripe customer for this person, when we have one on file.
   * Passing it keeps a second purchase attached to the same customer rather
   * than minting a duplicate, which is what makes the subscription lifecycle
   * events resolvable back to one profile row.
   */
  stripeCustomerId?: string | null;
}

/**
 * Everything Stripe needs to open a hosted checkout for one person and one
 * plan.
 *
 * ── Why the user id is written in three places ──────────────────────────────
 * `client_reference_id` and `metadata.user_id` both ride on the session, and
 * `subscription_data.metadata.user_id` rides on the subscription the session
 * creates. The webhook reads the first two off `checkout.session.completed`.
 * The third exists because `customer.subscription.deleted` arrives months later
 * with no session attached to it at all, and something has to say whose
 * subscription it was.
 */
export function buildCheckoutSessionParams(
  input: CheckoutSessionInput
): Stripe.Checkout.SessionCreateParams {
  const { userId, email, plan, priceId, origin, stripeCustomerId } = input;

  // Stripe substitutes the real session id for this token. It is a literal
  // Stripe placeholder and not a template string of ours, so it stays as is.
  const successUrl = `${origin}${CHECKOUT_SUCCESS_PATH}?session_id={CHECKOUT_SESSION_ID}`;

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: plan.mode,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: `${origin}${CHECKOUT_CANCEL_PATH}`,
    client_reference_id: userId,
    metadata: { user_id: userId, plan: plan.slug },
  };

  // `customer` and `customer_email` are mutually exclusive: Stripe rejects a
  // session carrying both. Prefer the customer we already know about.
  if (stripeCustomerId) {
    params.customer = stripeCustomerId;
  } else {
    params.customer_email = email;
  }

  if (plan.mode === "subscription") {
    params.subscription_data = {
      metadata: { user_id: userId, plan: plan.slug },
    };
  }

  return params;
}

export type CreateCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

/**
 * Opens a hosted checkout and hands back the URL to send the browser to.
 *
 * Never throws. The caller is a route handler standing behind a button on a
 * pricing card, and the useful outcome of a misconfigured price id is a person
 * seeing that something went wrong, not a stack trace rendered as a 500.
 */
export async function createCheckoutSession(
  input: Omit<CheckoutSessionInput, "priceId" | "plan"> & { planSlug: string },
  env: EnvLookup = process.env
): Promise<CreateCheckoutResult> {
  const plan = paidPlanFor(input.planSlug);

  if (!plan) {
    return { ok: false, message: "That is not a plan we sell." };
  }

  try {
    const priceId = priceIdFor(plan, env);
    const stripe = createStripeClient(env);

    const session = await stripe.checkout.sessions.create(
      buildCheckoutSessionParams({ ...input, plan, priceId })
    );

    if (!session.url) {
      return {
        ok: false,
        message: "Stripe opened a checkout without a URL to send you to.",
      };
    }

    return { ok: true, url: session.url };
  } catch (thrown) {
    return {
      ok: false,
      message:
        thrown instanceof Error ? thrown.message : "Checkout could not start.",
    };
  }
}
