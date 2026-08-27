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
 *
 * ── It carries a code, never a message ──────────────────────────────────────
 * The value is one of `BILLING_ERROR_CODES` and nothing else. It used to be the
 * message itself, which meant the landing page rendered whatever text was in
 * the query string into a styled alert, and anybody could hand somebody a link
 * that put words of their choosing on our marketing page under our own
 * branding. It also meant a raw Stripe error, which can name a price id or an
 * account, was printed to whoever pressed the button.
 *
 * So the wire format is a short opaque code, the copy lives here next to it,
 * and anything unrecognised falls back to the generic line below.
 */
export const BILLING_ERROR_PARAM = "billing_error";

export const BILLING_ERROR_CODES = [
  "already_subscribed",
  "unknown_plan",
  "checkout_failed",
] as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

/**
 * What each code says to a person. Deliberately vague about the cause: the
 * detail that would help debugging is in the server log, where it does not
 * double as a way to probe our Stripe configuration from the outside.
 */
export const BILLING_ERROR_MESSAGES: Record<BillingErrorCode, string> = {
  already_subscribed:
    "Your account is already on a plan that covers this one, so there is nothing to buy.",
  unknown_plan: "That is not a plan we sell.",
  checkout_failed:
    "Something went wrong opening checkout. Please try that again in a moment.",
};

/** Shown for a code that is not one of ours, rather than the code itself. */
export const GENERIC_BILLING_ERROR_MESSAGE =
  "Something went wrong. Please try that again in a moment.";

export function isBillingErrorCode(value: unknown): value is BillingErrorCode {
  return (
    typeof value === "string" &&
    (BILLING_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * The copy for whatever arrived in the query string, or null when nothing did.
 *
 * Never returns its argument. A value that is not a code we issued still gets a
 * message, because a person who somehow reached this state is better served by
 * a vague sentence than by silence, but it is our sentence and not theirs.
 */
export function billingErrorMessageFor(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;

  return isBillingErrorCode(value)
    ? BILLING_ERROR_MESSAGES[value]
    : GENERIC_BILLING_ERROR_MESSAGE;
}

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

/**
 * What `applications_cap` becomes the one time a free signup finishes intake.
 *
 * Granted by `lib/onboarding/attestation.ts`, in the same statement that stamps
 * `attested_at`, and nowhere else. `free` has no entry in `PAID_PLANS` because
 * nothing is bought to get it, but the number still belongs here rather than
 * inline at the grant site: the landing page's pricing card
 * (`app/page.tsx`) and `tests/e2e/smoke.spec.ts`'s assertion on "3
 * applications, total" both promise this exact figure, and JOB-010 already
 * proved what happens when a number like this lives in two places, which is
 * that they drift.
 */
export const FREE_PLAN_APPLICATIONS_CAP = 3;

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
 * Zero, and not `FREE_PLAN_APPLICATIONS_CAP`. The free tier's three applications
 * are a one time trial granted the moment intake is first completed (see
 * `lib/onboarding/attestation.ts`), not something signup itself hands out, so
 * handing them back to somebody whose subscription just lapsed would mint a
 * fresh trial every time a card expired. `schema.ts` makes the same argument
 * for the column default: an unset cap has to mean "cannot apply yet" rather
 * than "apply without limit", because the failure of a wrong guess here is
 * billable work done for free on somebody else's job board.
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
 * How the tiers order against each other, for deciding whether a purchase would
 * be buying something the person already has.
 *
 * The Season Pass outranks Starter on both of the axes that matter: it costs
 * more up front and it carries 500 applications against 150. Ordering them is
 * not a claim that one replaces the other, only that somebody holding the pass
 * pressing "Get Starter" is far more likely to be double buying by accident
 * than to be deliberately taking a smaller allowance as well.
 */
export const PLAN_RANK: Record<PlanSlug, number> = {
  free: 0,
  starter: 1,
  season_pass: 2,
};

/** Whatever `profiles.plan` held, narrowed to a slug we understand. */
export function planSlugOf(value: unknown): PlanSlug {
  return isPaidPlanSlug(value) ? value : "free";
}

/**
 * Whether the plan somebody is already on makes buying `wanted` a duplicate.
 *
 * True when they hold a paid plan of the same tier or better. Pressing "Get
 * Starter" twice is the case this exists for: without it the second press opens
 * a second Checkout Session and Stripe will happily create a second live
 * subscription against the same card, billing the person $29 a month twice for
 * one account. Upgrading is still allowed, because that is a real thing to want.
 */
export function alreadyCoveredBy(current: PlanSlug, wanted: PaidPlanSlug): boolean {
  return PLAN_RANK[current] > 0 && PLAN_RANK[current] >= PLAN_RANK[wanted];
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
