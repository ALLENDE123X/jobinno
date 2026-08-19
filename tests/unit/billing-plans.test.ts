// @vitest-environment node
/**
 * The billing catalog, and the Checkout parameters built from it (JOB-010).
 *
 * The expensive mistake this file exists to catch is a plan sold in the wrong
 * Checkout mode. Starter in `payment` mode takes one $29 payment for a
 * subscription that then never renews; Season Pass in `subscription` mode bills
 * somebody $99 every month for something they bought once. Neither shows up in
 * a type check, because both strings are valid `mode` values.
 */

import { describe, expect, it } from "vitest";

import {
  BILLING_ERROR_CODES,
  BILLING_ERROR_MESSAGES,
  GENERIC_BILLING_ERROR_MESSAGE,
  LAPSED_PLAN_CAP,
  PAID_PLANS,
  PAID_PLAN_SLUGS,
  alreadyCoveredBy,
  billingErrorMessageFor,
  isPaidPlanSlug,
  paidPlanFor,
  planSlugOf,
  priceIdFor,
} from "@/lib/billing/plans";
import {
  CHECKOUT_CANCEL_PATH,
  CHECKOUT_SUCCESS_PATH,
  buildCheckoutSessionParams,
} from "@/lib/billing/stripe";
import { planEnum } from "@/lib/db/schema";

const ORIGIN = "https://jobinno.app";
const USER_ID = "11111111-2222-3333-4444-555555555555";

describe("the catalog and the plan_tier enum", () => {
  it("sells every tier the database knows about except free", () => {
    // The one assertion holding the two lists together. `plans.ts` restates the
    // slugs rather than importing them, so that a server component can read the
    // catalog without dragging Drizzle's pg-core into a browser bundle, and
    // this is the check that keeps the restatement honest.
    expect([...PAID_PLAN_SLUGS].sort()).toEqual(
      planEnum.enumValues.filter((value) => value !== "free").sort()
    );
  });

  it("knows free is not something it sells", () => {
    expect(isPaidPlanSlug("free")).toBe(false);
    expect(paidPlanFor("free")).toBeNull();
  });

  it("refuses a slug that is not a plan", () => {
    expect(isPaidPlanSlug("enterprise")).toBe(false);
    expect(isPaidPlanSlug(undefined)).toBe(false);
    expect(isPaidPlanSlug(150)).toBe(false);
    expect(paidPlanFor("../../etc/passwd")).toBeNull();
  });
});

describe("what each plan costs and buys", () => {
  it("sells Starter as a recurring subscription worth 150 applications", () => {
    expect(PAID_PLANS.starter.mode).toBe("subscription");
    expect(PAID_PLANS.starter.applicationsCap).toBe(150);
  });

  it("sells the Season Pass as a single payment worth 500 applications", () => {
    expect(PAID_PLANS.season_pass.mode).toBe("payment");
    expect(PAID_PLANS.season_pass.applicationsCap).toBe(500);
  });

  it("drops a lapsed plan to a cap of zero rather than back to the free ten", () => {
    // The free ten are a one time trial. Handing them back every time a card
    // expires would mint a fresh trial on every failed renewal.
    expect(LAPSED_PLAN_CAP).toBe(0);
  });
});

describe("priceIdFor", () => {
  it("reads the price id out of the environment", () => {
    expect(
      priceIdFor(PAID_PLANS.starter, {
        STRIPE_PRICE_STARTER: "price_test_starter",
      })
    ).toBe("price_test_starter");
  });

  it("names the empty variable when it is not set", () => {
    // The whole point of throwing here. Handing Stripe `price: undefined` fails
    // some distance from the cause, and the person reading the log should be
    // told which line of .env.local is blank.
    expect(() =>
      priceIdFor(PAID_PLANS.season_pass, {})
    ).toThrow("STRIPE_PRICE_SEASON_PASS");
  });
});

describe("buildCheckoutSessionParams", () => {
  const base = {
    userId: USER_ID,
    email: "someone@university.edu",
    origin: ORIGIN,
    priceId: "price_test",
  };

  it("opens Starter in subscription mode", () => {
    const params = buildCheckoutSessionParams({
      ...base,
      plan: PAID_PLANS.starter,
    });
    expect(params.mode).toBe("subscription");
  });

  it("opens the Season Pass in payment mode", () => {
    const params = buildCheckoutSessionParams({
      ...base,
      plan: PAID_PLANS.season_pass,
    });
    expect(params.mode).toBe("payment");
  });

  it("writes the user id everywhere the webhook will look for it", () => {
    const params = buildCheckoutSessionParams({
      ...base,
      plan: PAID_PLANS.starter,
    });

    expect(params.client_reference_id).toBe(USER_ID);
    expect(params.metadata).toEqual({ user_id: USER_ID, plan: "starter" });
    // The third copy is the one that matters months later: a
    // `customer.subscription.deleted` arrives with no session attached, and
    // this is the only thing on it that says whose subscription it was.
    expect(params.subscription_data?.metadata).toEqual({
      user_id: USER_ID,
      plan: "starter",
    });
  });

  it("puts no subscription metadata on a one time purchase", () => {
    const params = buildCheckoutSessionParams({
      ...base,
      plan: PAID_PLANS.season_pass,
    });
    expect(params.subscription_data).toBeUndefined();
  });

  it("returns to this origin rather than to a hardcoded one", () => {
    const params = buildCheckoutSessionParams({
      ...base,
      origin: "https://jobinno-preview.vercel.app",
      plan: PAID_PLANS.starter,
    });

    expect(params.success_url).toContain(
      `https://jobinno-preview.vercel.app${CHECKOUT_SUCCESS_PATH}`
    );
    expect(params.cancel_url).toBe(
      `https://jobinno-preview.vercel.app${CHECKOUT_CANCEL_PATH}`
    );
  });

  it("asks Stripe to name the session on the way back", () => {
    const params = buildCheckoutSessionParams({
      ...base,
      plan: PAID_PLANS.starter,
    });
    expect(params.success_url).toContain("{CHECKOUT_SESSION_ID}");
  });

  it("reuses a known customer instead of sending an email", () => {
    const params = buildCheckoutSessionParams({
      ...base,
      plan: PAID_PLANS.season_pass,
      stripeCustomerId: "cus_existing",
    });

    // Stripe rejects a session carrying both, and a second purchase that mints
    // a duplicate customer is what makes a later lapse unresolvable.
    expect(params.customer).toBe("cus_existing");
    expect(params.customer_email).toBeUndefined();
  });

  it("falls back to the email for somebody buying for the first time", () => {
    const params = buildCheckoutSessionParams({
      ...base,
      plan: PAID_PLANS.starter,
      stripeCustomerId: null,
    });

    expect(params.customer).toBeUndefined();
    expect(params.customer_email).toBe("someone@university.edu");
  });
});

// ───────────────────────────────────
// Not selling somebody what they already have
// ───────────────────────────────────

/**
 * The bug this guards: pressing "Get Starter" twice created two live $29 a
 * month subscriptions against the same card. Stripe has no objection to that,
 * and the webhook writes the same plan for both, so nothing downstream notices
 * until the second charge appears on a statement.
 */
describe("alreadyCoveredBy", () => {
  it("refuses to sell the same plan twice", () => {
    expect(alreadyCoveredBy("starter", "starter")).toBe(true);
    expect(alreadyCoveredBy("season_pass", "season_pass")).toBe(true);
  });

  it("refuses to sell a smaller plan to somebody holding a bigger one", () => {
    expect(alreadyCoveredBy("season_pass", "starter")).toBe(true);
  });

  it("still lets somebody upgrade", () => {
    expect(alreadyCoveredBy("starter", "season_pass")).toBe(false);
  });

  it("sells anything to somebody on the free tier", () => {
    for (const slug of PAID_PLAN_SLUGS) {
      expect(alreadyCoveredBy("free", slug)).toBe(false);
    }
  });
});

describe("planSlugOf", () => {
  it("reads a paid plan back as itself", () => {
    expect(planSlugOf("starter")).toBe("starter");
    expect(planSlugOf("season_pass")).toBe("season_pass");
  });

  it("treats anything it does not recognise as free", () => {
    // Fail open on the guard rather than closed: a column holding something
    // unexpected must not lock a person out of buying anything at all.
    expect(planSlugOf("free")).toBe("free");
    expect(planSlugOf(null)).toBe("free");
    expect(planSlugOf(undefined)).toBe("free");
    expect(planSlugOf("enterprise")).toBe("free");
  });
});

// ───────────────────────────────────
// The billing error parameter
// ───────────────────────────────────

/**
 * `?billing_error=` used to be the message itself, rendered straight into a
 * styled alert on the landing page. Anybody could therefore hand somebody a
 * jobinno.app link that put a sentence of their choosing on our own marketing
 * page, wearing our own branding.
 */
describe("billingErrorMessageFor", () => {
  it("has copy for every code it can issue", () => {
    for (const code of BILLING_ERROR_CODES) {
      expect(BILLING_ERROR_MESSAGES[code]).toBeTruthy();
      expect(billingErrorMessageFor(code)).toBe(BILLING_ERROR_MESSAGES[code]);
    }
  });

  it("shows nothing at all when the parameter is absent", () => {
    expect(billingErrorMessageFor(null)).toBeNull();
    expect(billingErrorMessageFor(undefined)).toBeNull();
    expect(billingErrorMessageFor("")).toBeNull();
  });

  it("never renders back what it was handed", () => {
    const attacks = [
      "Your account has been suspended. Call 555 0100 to restore it.",
      "<img src=x onerror=alert(1)>",
      "checkout_failed_but_not_really",
      "  already_subscribed  ",
    ];

    for (const attack of attacks) {
      const message = billingErrorMessageFor(attack);
      expect(message).toBe(GENERIC_BILLING_ERROR_MESSAGE);
      expect(message).not.toContain(attack);
    }
  });

  it("refuses a non string without throwing", () => {
    expect(billingErrorMessageFor(42)).toBeNull();
    expect(billingErrorMessageFor({ toString: () => "already_subscribed" })).toBeNull();
  });
});
