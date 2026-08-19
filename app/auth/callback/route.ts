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

import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

/** Where someone goes once the session exists. */
const DEFAULT_DESTINATION = "/onboarding";

/**
 * A `next` of `/dashboard` is a caller saying where to go afterwards. A `next`
 * of `//evil.example` or `https://evil.example` is a caller trying to use our
 * domain to launder a redirect, and browsers read a protocol relative `//host`
 * as an absolute URL. Relative paths only, and never two leading slashes.
 */
function safeDestination(next: string | null): string {
  if (!next) return DEFAULT_DESTINATION;
  if (!next.startsWith("/") || next.startsWith("//")) {
    return DEFAULT_DESTINATION;
  }
  return next;
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
  const destination = safeDestination(params.get("next"));

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

  return redirectTo(request, destination);
}
