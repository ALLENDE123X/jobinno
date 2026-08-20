/**
 * Where a magic link lands. Turns whatever Supabase put in the query string
 * into a real session cookie, makes sure the person has a `profiles` row, and
 * sends them on to intake.
 *
 * ── Two shapes of link, both handled ────────────────────────────────────────
 * The browser client uses PKCE, so the ordinary case is `?code=`, exchanged for
 * a session using the verifier cookie the client wrote when it asked for the
 * link. A project whose email template was switched to `{{ .TokenHash }}` sends
 * `?token_hash=&type=` instead. Handling only the first works right up until
 * somebody edits a template in the dashboard, and then fails in a way that
 * looks like broken auth rather than a changed template.
 *
 * ── Why the profile row is created here ─────────────────────────────────────
 * `profiles` has no insert policy, deliberately: a client that could insert one
 * could mint a profile for an id it does not own. So the row is created by the
 * service role, and this is the first moment there is a confirmed identity to
 * create it for. It is an upsert because a second sign in is the normal case,
 * not an error.
 */

import { NextResponse, type NextRequest } from "next/server";

import { ANALYTICS_EVENT } from "@/lib/analytics/events";
import { captureServerEvent } from "@/lib/analytics/posthog-server";
import {
  POST_LOGIN_DESTINATION_COOKIE,
  safeRelativeDestination,
} from "@/lib/auth/redirect-urls";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

/** Where someone goes once the session exists. */
const DEFAULT_DESTINATION = "/onboarding";

/**
 * Where to send somebody once the session exists.
 *
 * Three sources, in order. An explicit `?next=`, then the cookie JOB-010's
 * checkout route sets before sending a signed out buyer here, then intake.
 * Both of the first two are run through `safeRelativeDestination`: a `next` of
 * `//evil.example` is a caller trying to use our domain to launder a redirect,
 * and browsers read a protocol relative `//host` as an absolute URL. The cookie
 * gets the same treatment, because a cookie is no more trustworthy than a query
 * string once anything else on the origin can write one.
 */
function destinationFor(request: NextRequest): {
  destination: string;
  fromCookie: boolean;
} {
  const fromNext = safeRelativeDestination(
    request.nextUrl.searchParams.get("next")
  );
  if (fromNext) return { destination: fromNext, fromCookie: false };

  const fromCookie = safeRelativeDestination(
    request.cookies.get(POST_LOGIN_DESTINATION_COOKIE)?.value
  );
  if (fromCookie) return { destination: fromCookie, fromCookie: true };

  return { destination: DEFAULT_DESTINATION, fromCookie: false };
}

/**
 * The destination as an analytics property: one of the routes this app actually
 * sends people to, or "other".
 *
 * `safeDestination` has already refused anything that is not a relative path,
 * so this is not a security check. It is the difference between a property with
 * three possible values and one that can be any path a caller invents, and the
 * second of those is a free text field in a funnel by another name.
 */
function knownDestination(destination: string): string {
  return destination === "/onboarding" || destination === "/dashboard" ? destination : "other";
}

/**
 * Redirects are built from `request.nextUrl`, which Next resolves against the
 * proxy headers a deployment sits behind. Nothing here reads a host out of the
 * query string, so there is no way to steer the redirect off our own origin.
 */
function redirectTo(
  request: NextRequest,
  pathname: string,
  params?: Record<string, string>
) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  url.hash = "";

  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const { destination, fromCookie } = destinationFor(request);

  // Supabase reports a refused or expired link by redirecting here with an
  // error rather than by failing the request, so this is a real branch.
  const errorDescription = params.get("error_description") ?? params.get("error");
  if (errorDescription) {
    return redirectTo(request, "/login", { error: errorDescription });
  }

  const supabase = await createServerClient();

  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type");

  let failure: string | null = null;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    failure = error?.message ?? null;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as "magiclink" | "email" | "signup" | "recovery" | "invite",
      token_hash: tokenHash,
    });
    failure = error?.message ?? null;
  } else {
    failure = "That sign in link is missing its code. Ask for a new one.";
  }

  if (failure) {
    return redirectTo(request, "/login", { error: failure });
  }

  // Read the user back rather than trusting the exchange. This is also the
  // check that the session cookie really did get written.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return redirectTo(request, "/login", {
      error: "That link signed in without an email address. Ask for a new one.",
    });
  }

  const { error: profileError } = await createServiceRoleClient()
    .from("profiles")
    .upsert({ id: user.id, email: user.email }, { onConflict: "id" });

  if (profileError) {
    return redirectTo(request, "/login", {
      error: `Signed in, but your profile could not be created: ${profileError.message}`,
    });
  }

  const response = redirectTo(request, destination);

  // Spent, so it goes. Leaving it set would send the next sign in from this
  // browser back to a checkout the person already completed.
  if (fromCookie) {
    response.cookies.delete(POST_LOGIN_DESTINATION_COOKIE);
  }

  // JOB-014. Fired here rather than in the browser because this route is where
  // the session actually starts to exist, and the browser is mid redirect with
  // none of our JavaScript running.
  //
  // `user.email` is in scope on this line and is deliberately not sent. The
  // distinct id is the Supabase `auth.uid()`, which is the same opaque UUID
  // every table in `lib/db/schema.ts` scopes on.
  //
  // There is no "was this a signup" property, and the upsert above cannot
  // honestly supply one: it affects exactly one row whether it inserted or
  // updated. PostHog already knows whether it has seen a distinct id before,
  // which is the same question asked of something that can answer it.
  await captureServerEvent({
    event: ANALYTICS_EVENT.SESSION_ESTABLISHED,
    distinctId: user.id,
    // Bucketed rather than passed through. `safeDestination` already refuses
    // anything but a relative path, but a relative path is still a string a
    // caller chose, and a funnel only needs to know which of the real
    // destinations somebody landed on.
    properties: { destination: knownDestination(destination) },
  });

  return response;
}
