/**
 * Opens a Stripe hosted checkout for the signed in person (JOB-010).
 *
 * ── POST only, and the Origin has to match ours (JOB-033) ──────────────────
 * A route handler gets none of the CSRF protection a Next.js Server Action
 * gets for free: nothing here stops a hidden auto-submitting form on another
 * origin from POSTing a signed-in visitor straight into a live Checkout
 * Session for a plan they never chose. `isTrustedOrigin` below is that check,
 * and it runs before anything else in the handler does.
 *
 * There used to be a GET handler too, kept for the trip back from sign in:
 * somebody who presses "Get Starter" while signed out is sent to `/login`,
 * and the magic link they follow lands on `app/auth/callback/route.ts`, which
 * finishes with a redirect, and a redirect is a GET. But a GET handler on a
 * route that opens a real payment flow is its own problem independent of
 * CSRF — `<img src="/api/billing/checkout?plan=season_pass">` on any page
 * fires it with zero interaction and no preflight, since a plain GET carries
 * no Origin header for this check to even catch. It is deleted rather than
 * defended. Nothing here still points at it: the post-login return leg was
 * already going nowhere before this change (see the destination cookie below
 * and JOB-033's PR description for why), so this removes an open door
 * without closing a route anything currently completes through. Wiring the
 * return leg back up — a page that itself POSTs, or an idempotent resume —
 * is separate follow-up work, not this fix.
 */

import { NextResponse, type NextRequest } from "next/server";

import { createCheckoutSession } from "@/lib/billing/stripe";
import {
  BILLING_ERROR_PARAM,
  CHECKOUT_PLAN_PARAM,
  alreadyCoveredBy,
  isPaidPlanSlug,
  planSlugOf,
  type BillingErrorCode,
} from "@/lib/billing/plans";
import {
  LOCAL_DEV_ORIGIN,
  POST_LOGIN_DESTINATION_COOKIE,
  POST_LOGIN_DESTINATION_MAX_AGE_SECONDS,
  PRODUCTION_ORIGIN,
  WWW_PRODUCTION_ORIGIN,
} from "@/lib/auth/redirect-urls";
import { createServerClient } from "@/lib/supabase/server";

/** Where a person is sent to sign in. */
const LOGIN_PATH = "/login";

/**
 * The origins this app is actually served from — the same three
 * `lib/auth/redirect-urls.ts` allowlists a magic link against, minus the
 * callback path, because this checks where a request came from rather than
 * where one is allowed to land.
 */
const ALLOWED_ORIGINS: readonly string[] = [
  LOCAL_DEV_ORIGIN,
  PRODUCTION_ORIGIN,
  WWW_PRODUCTION_ORIGIN,
];

/**
 * Whether this request can be trusted to have come from our own pricing page.
 *
 * `Origin` is the primary signal: browsers attach it to every same-origin or
 * cross-origin POST, and it cannot be set by a form or a script, only by the
 * browser itself. A mismatch is refused outright.
 *
 * A request with no `Origin` header at all is not automatically trusted —
 * that would fail open, and the whole point of this check is to not do that.
 * Some legitimate same-origin submissions omit `Origin` depending on browser
 * and referrer-policy, so the fallback is `Referer`, which a real browser
 * still attaches to a same-origin form POST even when `Origin` is stripped.
 * It has to name one of our own origins to pass; missing entirely, or naming
 * something else, is refused. An attacker's page has no reason to carry a
 * `Referer` pointing at us, so this costs a genuine submission nothing while
 * giving a forged one nowhere to hide.
 */
function isTrustedOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return ALLOWED_ORIGINS.includes(origin);
  }

  const referer = request.headers.get("referer");
  if (!referer) return false;

  try {
    return ALLOWED_ORIGINS.includes(new URL(referer).origin);
  } catch {
    return false;
  }
}

/**
 * Where the pricing cards live, for sending somebody back with a message. The
 * failure is rendered by the landing page rather than as raw JSON, because the
 * caller here is a person who pressed a button and not a script.
 *
 * What travels in the query string is a code and never a sentence. The landing
 * page owns the copy for each one, so a link with a made up value in it cannot
 * put words on our own marketing page, and a raw Stripe error, which can name a
 * price id, never reaches a browser. See `BILLING_ERROR_PARAM`.
 */
function pricingRedirect(request: NextRequest, code: BillingErrorCode) {
  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set(BILLING_ERROR_PARAM, code);
  return NextResponse.redirect(url, 303);
}

async function startCheckout(request: NextRequest, planSlug: string | null) {
  if (!isPaidPlanSlug(planSlug)) {
    return pricingRedirect(request, "unknown_plan");
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    // Remember what they were buying, then send them to sign in. The callback
    // reads this cookie and finishes the journey. See the comment on the cookie
    // in `lib/auth/redirect-urls.ts` for why this is not a query parameter.
    const login = request.nextUrl.clone();
    login.pathname = LOGIN_PATH;
    login.search = "";
    login.hash = "";

    const destination = `${request.nextUrl.pathname}?${CHECKOUT_PLAN_PARAM}=${planSlug}`;

    const response = NextResponse.redirect(login, 303);
    response.cookies.set(POST_LOGIN_DESTINATION_COOKIE, destination, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: POST_LOGIN_DESTINATION_MAX_AGE_SECONDS,
    });
    return response;
  }

  // The plan they are on, and the Stripe customer from an earlier purchase when
  // there is one, so a second plan does not mint a duplicate customer. Read
  // through the user's own session rather than the service role:
  // `profiles_select_own` already limits this to their row, and nothing here
  // needs more power than that.
  const { data: profile } = await supabase
    .from("profiles")
    .select("plan, stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();

  // ── Do not sell somebody something they already have ──────────────────────
  // Pressing "Get Starter" a second time used to open a second Checkout
  // Session, and Stripe creates a second live subscription from it quite
  // happily: same person, same card, $29 a month twice, and nothing downstream
  // notices because the webhook writes the same plan either way. The double
  // press is the ordinary case here, not an attack. Somebody presses the button
  // again because the first checkout was slow to open, or they came back to the
  // pricing section later and forgot.
  //
  // Upgrading is still allowed. Only the same tier or a lower one is refused,
  // because that is the shape a duplicate takes. `alreadyCoveredBy` owns that
  // comparison.
  //
  // This is a guard and not a guarantee. Two requests racing each other can
  // still both read `free` and both open a session, and the real fix for that
  // is Stripe's own idempotency rather than a read here. It closes the case
  // that actually happens, which is a person pressing a button twice minutes
  // apart with the plan already written in between.
  const currentPlan = planSlugOf(profile?.plan);

  if (alreadyCoveredBy(currentPlan, planSlug)) {
    console.info(
      `[billing-checkout] refused a duplicate purchase: ${user.id} is on ${currentPlan} and asked for ${planSlug}`
    );
    return pricingRedirect(request, "already_subscribed");
  }

  const result = await createCheckoutSession({
    userId: user.id,
    email: user.email,
    planSlug,
    origin: request.nextUrl.origin,
    stripeCustomerId: profile?.stripe_customer_id ?? null,
  });

  if (!result.ok) {
    // The reason is logged rather than shown. It comes from Stripe and can name
    // a price id or an account, neither of which belongs in a URL a person can
    // read, forward, or find in their browser history.
    console.error(`[billing-checkout] could not open a session: ${result.message}`);
    return pricingRedirect(request, "checkout_failed");
  }

  return NextResponse.redirect(result.url, 303);
}

export async function POST(request: NextRequest) {
  if (!isTrustedOrigin(request)) {
    console.warn(
      `[billing-checkout] refused a cross-origin request: origin=${request.headers.get("origin")} referer=${request.headers.get("referer")}`
    );
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });
  }

  const form = await request.formData();
  const plan = form.get(CHECKOUT_PLAN_PARAM);
  return startCheckout(request, typeof plan === "string" ? plan : null);
}
