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
  isPaidPlanSlug,
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
 */
function pricingRedirect(request: NextRequest, message: string) {
  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set(BILLING_ERROR_PARAM, message);
  return NextResponse.redirect(url, 303);
}

async function startCheckout(request: NextRequest, planSlug: string | null) {
  if (!isPaidPlanSlug(planSlug)) {
    return pricingRedirect(request, "That is not a plan we sell.");
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

  // Reuse the Stripe customer from an earlier purchase when there is one, so a
  // second plan does not mint a duplicate customer. Read through the user's own
  // session rather than the service role: `profiles_select_own` already limits
  // this to their row, and nothing here needs more power than that.
  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();

  const result = await createCheckoutSession({
    userId: user.id,
    email: user.email,
    planSlug,
    origin: request.nextUrl.origin,
    stripeCustomerId: profile?.stripe_customer_id ?? null,
  });

  if (!result.ok) {
    return pricingRedirect(request, result.message);
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
