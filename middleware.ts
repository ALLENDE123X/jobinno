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
  isExemptFromWaitlistGate,
  WAITLIST_CONTENT_PATH,
  WAITLIST_PATH,
} from "@/lib/waitlist-gate";

export async function middleware(request: NextRequest) {
  // ── JOB-031: the waitlist gate ────────────────────────────────────────────
  // Checked first, and before anything async, so a request that is about to be
  // redirected anyway never pays for a Supabase Auth round trip below. See
  // lib/waitlist-gate.ts for the exact exempt list and why each entry is on
  // it. Removing this block, and the import above, is the whole revert.
  //
  // Two different responses, not one, because "the waitlist is the front
  // page" and "every other URL leads there" are different operations. `/`
  // itself is rewritten — the browser's address bar stays on `/`, but the
  // actual page rendered is `app/waitlist/page.tsx`, at `WAITLIST_CONTENT_PATH`
  // — so the real `app/page.tsx` (JOB-016's marketing site) is never touched,
  // reachable again the instant this block is removed. Everything else,
  // `/login`, `/dashboard`, a stray `/waitlist` visited directly, whatever a
  // future route adds, is redirected: the browser's address bar changes to
  // `/`, which is what makes "no other URL path" actually true rather than
  // just true of the content.
  if (!isExemptFromWaitlistGate(request.nextUrl.pathname)) {
    if (request.nextUrl.pathname === WAITLIST_PATH) {
      const url = request.nextUrl.clone();
      url.pathname = WAITLIST_CONTENT_PATH;
      return NextResponse.rewrite(url);
    }
    const url = request.nextUrl.clone();
    url.pathname = WAITLIST_PATH;
    url.search = "";
    return NextResponse.redirect(url);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Nothing to refresh without a configured project. Failing open here is safe
  // because no page trusts middleware to have run; they check for themselves.
  if (!url || !anonKey) return NextResponse.next({ request });

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
    return response;
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except Next's own static output and image files. Middleware
    // that runs on every asset request is a per request round trip to the Auth
    // server for a favicon, which is a real cost for no benefit.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
