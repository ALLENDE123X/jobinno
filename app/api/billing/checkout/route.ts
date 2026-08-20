/**
 * Opens a Stripe hosted checkout for the signed in person (JOB-010).
 *
 * ── Why it answers both POST and GET ────────────────────────────────────────
 * POST is the real entry point: the pricing cards are plain forms, so the
 * buttons work with no client JavaScript and the landing page stays a server
 * component.
 *
 * GET exists for the trip back from sign in. Somebody who presses "Get Starter"
 * while signed out is sent to `/login`, and the magic link they follow lands on
 * `app/auth/callback/route.ts`, which finishes with a redirect. A redirect is a
 * GET, so the return leg has to be one too. Creating a Checkout Session on a
 * GET is safe: a session is an empty form on Stripe's side and nothing is
 * charged until a person types a card into it and presses pay.
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
  POST_LOGIN_DESTINATION_COOKIE,
  POST_LOGIN_DESTINATION_MAX_AGE_SECONDS,
} from "@/lib/auth/redirect-urls";
import { createServerClient } from "@/lib/supabase/server";

/** Where a person is sent to sign in. */
const LOGIN_PATH = "/login";

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
  const form = await request.formData();
  const plan = form.get(CHECKOUT_PLAN_PARAM);
  return startCheckout(request, typeof plan === "string" ? plan : null);
}

export async function GET(request: NextRequest) {
  return startCheckout(request, request.nextUrl.searchParams.get(CHECKOUT_PLAN_PARAM));
}
