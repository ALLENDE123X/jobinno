// @vitest-environment node
/**
 * The checkout route (JOB-010), and the things it must refuse.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `tests/unit/billing-plans.test.ts` proves `alreadyCoveredBy` computes the
 * right answer. That is not the same as proving the route asks it, and the
 * failure mode if it does not is two live $29 a month subscriptions on one
 * person's card. So this drives the real handler and asserts that no Checkout
 * Session is opened at all in that case, rather than testing the predicate
 * twice.
 *
 * JOB-033 adds the Origin check. `pressBuy` sends a trusted `Origin` by
 * default so every test above stays about what it always tested; the "Origin
 * check" describe block below is where cross-origin and missing-header
 * requests are exercised directly.
 *
 * Nothing here reaches Stripe. `createCheckoutSession` is mocked, and the
 * assertion that matters most is `not.toHaveBeenCalled()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BILLING_ERROR_PARAM, CHECKOUT_PLAN_PARAM } from "@/lib/billing/plans";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const EMAIL = "someone@university.edu";

const createCheckoutSession = vi.fn();
const createServerClient = vi.fn();
const createServiceRoleClient = vi.fn();

/**
 * A signed in session, with none of the profile reads the route no longer
 * asks it for. Since JOB-192 revoked `authenticated`'s SELECT on
 * `stripe_customer_id`, both columns the checkout handler needs (`plan` and
 * `stripe_customer_id`) are read through the service role instead, so this
 * stub only has to answer "who is this".
 */
function sessionStub() {
  return {
    auth: {
      async getUser() {
        return { data: { user: { id: USER_ID, email: EMAIL } } };
      },
    },
  };
}

/**
 * The service role client, answering the one query the handler makes: read
 * `plan, stripe_customer_id` for this user's own row. `profile` of null
 * stands for somebody with no row yet, matching what
 * `.maybeSingle()` returns when a filter matches nothing.
 */
function serviceRoleStub(profile: Record<string, unknown> | null) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: profile, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

/**
 * Presses "Get Starter" with a trusted, same-origin `Origin` header by
 * default, since that is what every browser actually sends on this form post
 * and it is not what the tests above are about. Pass `headers` to override it
 * for the Origin-check tests themselves.
 */
async function pressBuy(plan: string, headers?: HeadersInit) {
  const { POST } = await import("@/app/api/billing/checkout/route");
  const { NextRequest } = await import("next/server");

  const form = new FormData();
  form.set(CHECKOUT_PLAN_PARAM, plan);

  return POST(
    new NextRequest("https://jobinno.app/api/billing/checkout", {
      method: "POST",
      body: form,
      headers: headers ?? { origin: "https://jobinno.app" },
    })
  );
}

/** The value of `?billing_error=` on a redirect back to the pricing cards. */
function billingErrorOf(response: Response): string | null {
  const location = response.headers.get("location");
  if (!location) return null;
  return new URL(location).searchParams.get(BILLING_ERROR_PARAM);
}

/**
 * Wires up both Supabase clients for one test: `createServerClient` returns
 * a session that answers `getUser()`, and `createServiceRoleClient` returns
 * a client that answers the single `profiles` read the handler makes.
 * `profile` of null is the "no row yet" case.
 */
function mockSession(profile: Record<string, unknown> | null) {
  createServerClient.mockResolvedValue(sessionStub());
  createServiceRoleClient.mockReturnValue(serviceRoleStub(profile));
}

describe("the checkout route", () => {
  beforeEach(() => {
    vi.resetModules();
    createCheckoutSession.mockReset();
    createServerClient.mockReset();
    createServiceRoleClient.mockReset();

    createCheckoutSession.mockResolvedValue({
      ok: true,
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
    });

    vi.doMock("@/lib/billing/stripe", () => ({ createCheckoutSession }));
    vi.doMock("@/lib/supabase/server", () => ({
      createServerClient,
      createServiceRoleClient,
      RESUMES_BUCKET: "resumes",
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/billing/stripe");
    vi.doUnmock("@/lib/supabase/server");
  });

  it("opens a checkout for somebody on the free tier", async () => {
    mockSession({ plan: "free", stripe_customer_id: null });

    const response = await pressBuy("starter");

    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("checkout.stripe.com");
  });

  it("refuses to open a second checkout for a plan somebody already has", async () => {
    // The reported bug, pressed twice: the plan is already written, so the
    // second press must not reach Stripe at all.
    mockSession({ plan: "starter", stripe_customer_id: "cus_test_starter" });

    const response = await pressBuy("starter");

    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(billingErrorOf(response)).toBe("already_subscribed");
  });

  it("refuses to sell Starter to somebody holding the Season Pass", async () => {
    mockSession({ plan: "season_pass", stripe_customer_id: "cus_test_sp" });

    await pressBuy("starter");

    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it("still lets somebody upgrade from Starter to the Season Pass", async () => {
    mockSession({ plan: "starter", stripe_customer_id: "cus_test_starter" });

    await pressBuy("season_pass");

    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it("sells to somebody who has no profile row yet", async () => {
    mockSession(null);

    await pressBuy("starter");

    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it("sends back a code and never a plan slug of the caller's choosing", async () => {
    mockSession({ plan: "free", stripe_customer_id: null });

    const response = await pressBuy("<b>enterprise</b>");

    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(billingErrorOf(response)).toBe("unknown_plan");
    expect(response.headers.get("location")).not.toContain("enterprise");
  });

  it("does not put a Stripe failure into the URL", async () => {
    mockSession({ plan: "free", stripe_customer_id: null });
    createCheckoutSession.mockResolvedValue({
      ok: false,
      message:
        "No such price: 'price_1ABCdefGHIjklMNO'; a similar object exists in test mode.",
    });

    const response = await pressBuy("starter");
    const location = response.headers.get("location") ?? "";

    // A price id in a URL is something a person can read, forward, or leave in
    // their browser history. The reason belongs in the server log.
    expect(billingErrorOf(response)).toBe("checkout_failed");
    expect(location).not.toContain("price_1ABCdefGHIjklMNO");
  });

  /**
   * JOB-033. `pressBuy`'s default `Origin` header is exactly what the
   * "opens a checkout for somebody on the free tier" test above already
   * proves works, so it is not repeated here — this block is only the cases
   * where the Origin is wrong, or missing.
   */
  describe("the Origin check", () => {
    it("refuses a cross-origin POST, the hidden-form attack the ticket describes", async () => {
      mockSession({ plan: "free", stripe_customer_id: null });

      const response = await pressBuy("starter", {
        origin: "https://evil.example",
      });

      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
    });

    it("refuses a request with neither an Origin nor a Referer, rather than failing open", async () => {
      mockSession({ plan: "free", stripe_customer_id: null });

      const response = await pressBuy("starter", {});

      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
    });

    it("refuses a request with no Origin and a Referer pointing elsewhere", async () => {
      mockSession({ plan: "free", stripe_customer_id: null });

      const response = await pressBuy("starter", {
        referer: "https://evil.example/attack.html",
      });

      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
    });

    it("falls back to a same-origin Referer when Origin is missing", async () => {
      // Some browser/referrer-policy combinations omit Origin on a same-origin
      // form post. That should not be treated as an attack.
      mockSession({ plan: "free", stripe_customer_id: null });

      const response = await pressBuy("starter", {
        referer: "https://jobinno.app/",
      });

      expect(createCheckoutSession).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(303);
    });

    it("accepts the www production origin, JOB-023's second real hostname", async () => {
      mockSession({ plan: "free", stripe_customer_id: null });

      const response = await pressBuy("starter", {
        origin: "https://www.jobinno.app",
      });

      expect(createCheckoutSession).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(303);
    });
  });
});
