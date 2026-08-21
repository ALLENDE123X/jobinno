/**
 * Refreshes the Supabase session on every request that could render a page,
 * and, while JOB-031's waitlist gate is active, makes the waitlist the only
 * thing a visitor can reach: every path serves it, at `/`.
 *
 * A Server Component cannot set a cookie. That is a Next.js rule, not a
 * Supabase one, and it means the usual "read the session, notice the access
 * token expired, write a fresh one" cycle has nowhere to write. Without this
 * file the app works for exactly as long as the first access token lives and
 * then starts logging people out mid session, which is a confusing bug to chase
 * because nothing about it looks like an auth problem.
 *
 * Middleware runs before rendering and can set cookies, so the refresh happens
 * here and every page downstream reads an already current session.
 *
 * This file does not authorise anything beyond the waitlist gate below.
 * Deciding who may see a page that does render is done by the page, where a
 * redirect can carry a reason and where the check sits next to the thing it
 * protects.
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import {
  WAITLIST_REFERRAL_COOKIE,
  WAITLIST_REFERRAL_COOKIE_MAX_AGE_SECONDS,
  WAITLIST_REFERRAL_QUERY_PARAM,
} from "@/lib/waitlist";
import { isExemptFromWaitlistGate, WAITLIST_PATH } from "@/lib/waitlist-gate";

export async function middleware(request: NextRequest) {
  // ── JOB-031: the waitlist gate ────────────────────────────────────────────
  // Checked first, and before anything async, so a request that is about to be
  // redirected anyway never pays for a Supabase Auth round trip below. See
  // lib/waitlist-gate.ts for the exact exempt list, why each entry is on it,
  // and how to revert this. Removing this block, and the import above, is
  // most of the revert.
  //
  // One response, not two (JOB-032 simplified this from the rewrite based
  // design JOB-031 shipped first): `/` is on the exempt list and falls
  // through to render normally, `app/page.tsx` itself carries the waitlist
  // form now, so there is nothing left to rewrite it to. Everything else,
  // `/login`, `/dashboard`, a stray `/waitlist` link left over from before
  // this change, whatever a future route adds, is redirected: the browser's
  // address bar changes to `/`, which is what makes "no other URL path"
  // actually true rather than just true of the content.
  if (!isExemptFromWaitlistGate(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = WAITLIST_PATH;
    url.search = "";
    return NextResponse.redirect(url);
  }

  // ── JOB-041: capture a creator referral code ────────────────────────────
  // A Server Component cannot set a cookie, so `app/page.tsx` cannot do this
  // itself even though it is the one that reads `?ref=` for a live request.
  // Read up here, ahead of the Supabase configuration check below, so a
  // deploy with no project configured still captures it. `stampReferralCookie`
  // is what actually applies it, called right before every return in this
  // function rather than once on `response` the moment it is created: `setAll`
  // further down reassigns `response` to a brand new `NextResponse` whenever
  // the Supabase session needs refreshing, which would silently drop a cookie
  // set on the response object that exists right now. Only overwrites the
  // cookie when `?ref=` is actually present on this request, so a later
  // navigation with no param at all leaves an earlier attribution alone
  // instead of clobbering it with nothing.
  const referralCode = request.nextUrl.searchParams
    .get(WAITLIST_REFERRAL_QUERY_PARAM)
    ?.trim();
  function stampReferralCookie(res: NextResponse) {
    if (referralCode) {
      res.cookies.set(WAITLIST_REFERRAL_COOKIE, referralCode, {
        maxAge: WAITLIST_REFERRAL_COOKIE_MAX_AGE_SECONDS,
        path: "/",
        sameSite: "lax",
      });
    }
    return res;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Nothing to refresh without a configured project. Failing open here is safe
  // because no page trusts middleware to have run; they check for themselves.
  if (!url || !anonKey) {
    return stampReferralCookie(NextResponse.next({ request }));
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Written twice on purpose. The request copy is what a Server Component
        // in this same pass will read; the response copy is what the browser
        // keeps for the next request. Setting only one of them gives you a
        // session that works on this page and is gone on the next.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // `getUser()` and not `getSession()`. `getSession()` returns whatever the
  // cookie says without checking it, so a forged cookie reads as a valid
  // session; `getUser()` asks the Auth server. It is also the call that
  // triggers the refresh this whole file exists for.
  //
  // Wrapped because this is the one network call standing in front of every
  // page in the app. An Auth server that is slow, down, or simply not reachable
  // from a CI runner must not turn every route into a 500: the pages do their
  // own check and will send an unauthenticated visitor to sign in, which is the
  // right outcome anyway when we cannot confirm who they are.
  try {
    await supabase.auth.getUser();
  } catch {
    return stampReferralCookie(response);
  }

  return stampReferralCookie(response);
}

export const config = {
  matcher: [
    // Everything except Next's own static output and image files. Middleware
    // that runs on every asset request is a per request round trip to the Auth
    // server for a favicon, which is a real cost for no benefit.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
