/**
 * The billing catalog (JOB-010). What each plan costs, what it is worth in
 * applications, and which Stripe price sells it.
 *
 * ── Why this module imports nothing ─────────────────────────────────────────
 * The pricing cards on the landing page need the plan slugs, and the webhook
 * handler needs the caps. If those two read different lists they will drift,
 * and the way that drift surfaces is somebody paying $99 and being given the
 * $29 allowance. So there is one list, and it is kept free of imports so that
 * a server component can read it without pulling the Stripe SDK or Drizzle's
 * `pg-core` into a browser bundle. `lib/billing/stripe.ts` is the server half.
 *
 * The slugs here are the same strings as the `plan_tier` Postgres enum in
 * `lib/db/schema.ts`. That is not a coincidence and it is not left to trust:
 * `tests/unit/billing-plans.test.ts` asserts the two agree, in Node, where
 * importing the schema is free.
 */

/**
 * Where the pricing cards post to, and the field naming the plan. Shared with
 * `app/api/billing/checkout/route.ts` so the form and the handler that reads it
 * cannot drift apart.
 */
export const CHECKOUT_PATH = "/api/billing/checkout";
export const CHECKOUT_PLAN_PARAM = "plan";

/**
 * The query parameter the checkout route sends somebody back to the pricing
 * cards with when a session could not be opened. Read by
 * `components/landing/billing-error.tsx`.
 */
export const BILLING_ERROR_PARAM = "billing_error";

/**
 * Just enough of an environment to look a variable up in. Narrower than
 * `NodeJS.ProcessEnv` so a test can pass the one variable under test rather
 * than a whole process environment, and `process.env` still satisfies it.
 */
export type EnvLookup = Record<string, string | undefined>;

/** The tiers a person can pay for. `free` is the absence of these. */
export const PAID_PLAN_SLUGS = ["starter", "season_pass"] as const;

export type PaidPlanSlug = (typeof PAID_PLAN_SLUGS)[number];

/** Every value `profiles.plan` can hold. */
export type PlanSlug = "free" | PaidPlanSlug;

export interface PaidPlan {
  slug: PaidPlanSlug;
  /** How the plan is named to a person, matching the landing page copy. */
  label: string;
  /**
   * Which Checkout mode sells it. Starter is a recurring subscription, the
   * Season Pass is a single payment, and handing Stripe the wrong one either
   * bills somebody monthly for a one time product or takes one payment for a
   * subscription that then never renews.
   */
  mode: "subscription" | "payment";
  /** What `profiles.applications_cap` becomes once the payment lands. */
  applicationsCap: number;
  /** The environment variable holding this plan's Stripe price id. */
  priceEnvVar: string;
}

export const PAID_PLANS: Record<PaidPlanSlug, PaidPlan> = {
  starter: {
    slug: "starter",
    label: "Starter",
    mode: "subscription",
    applicationsCap: 150,
    priceEnvVar: "STRIPE_PRICE_STARTER",
  },
  season_pass: {
    slug: "season_pass",
    label: "Season Pass",
    mode: "payment",
    applicationsCap: 500,
    priceEnvVar: "STRIPE_PRICE_SEASON_PASS",
  },
};

/**
 * What `applications_cap` becomes when a paid plan goes away.
 *
 * Zero, and not ten. The free tier's ten applications are a one time trial
 * granted at signup, so handing them back to somebody whose subscription just
 * lapsed would mint a fresh trial every time a card expired. `schema.ts` makes
 * the same argument for the column default: an unset cap has to mean "cannot
 * apply yet" rather than "apply without limit", because the failure of a wrong
 * guess here is billable work done for free on somebody else's job board.
 */
export const LAPSED_PLAN_CAP = 0;

export function isPaidPlanSlug(value: unknown): value is PaidPlanSlug {
  return (
    typeof value === "string" &&
    (PAID_PLAN_SLUGS as readonly string[]).includes(value)
  );
}

/** The plan for a slug, or null when the slug is not one we sell. */
export function paidPlanFor(value: unknown): PaidPlan | null {
  return isPaidPlanSlug(value) ? PAID_PLANS[value] : null;
}

/**
 * The Stripe price id for a plan, read from the environment.
 *
 * Throws rather than returning undefined. A missing price id reaches Stripe as
 * `price: undefined`, which fails with an argument error some distance from the
 * cause; naming the variable here means the person reading the log is told
 * which line of `.env.local` is empty.
 */
export function priceIdFor(
  plan: PaidPlan,
  env: EnvLookup = process.env
): string {
  const priceId = env[plan.priceEnvVar];

  if (!priceId) {
    throw new Error(
      `${plan.priceEnvVar} is not set, so the ${plan.label} plan cannot be ` +
        `sold. Put the Stripe price id for ${plan.label} in .env.local (see ` +
        `.env.example).`
    );
  }

  return priceId;
}
