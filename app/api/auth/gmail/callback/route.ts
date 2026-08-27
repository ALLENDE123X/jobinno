/**
 * JOB-189 — completes the Gmail OAuth consent flow
 * app/api/auth/gmail/start/route.ts began.
 *
 * GET /api/auth/gmail/callback?code=...&state=...
 *  1. Requires the same signed in user the state was signed for. A missing
 *     session, a missing code or state, or a state that fails to verify all
 *     stop the request before any code is exchanged.
 *  2. Exchanges the authorization code for tokens via googleapis' OAuth2
 *     client, using the exact same redirect_uri the start leg sent.
 *  3. Encrypts the refresh token (lib/gmail-token-crypto.ts) and writes it
 *     to profiles.gmail_refresh_token through the service role client,
 *     because that column has no user side UPDATE grant at all — see
 *     drizzle/0026_profiles_gmail_refresh_token_privileges.sql.
 *  4. Sends the user to the success page.
 *
 * ── Never logged ─────────────────────────────────────────────────────────
 * The raw refresh token, the access token, and GMAIL_TOKEN_ENCRYPTION_KEY
 * never appear in a log line anywhere in this file, per the ticket's
 * guardrail and CLAUDE.md's rule that a secret belongs in .env.local and
 * nowhere a log line could put it. A token exchange failure is logged by its
 * message only, since a Google error message can echo back fragments of the
 * request that carried a real authorization code.
 */

import { google } from "googleapis";
import { NextResponse, type NextRequest } from "next/server";

import { GmailOAuthStateError, gmailOAuthRedirectUri, verifyGmailOAuthState } from "@/lib/gmail-oauth";
import { encryptGmailRefreshToken } from "@/lib/gmail-token-crypto";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

const LOG = "[gmail-oauth-callback]";
const LOGIN_PATH = "/login";
const SUCCESS_PATH = "/settings/gmail/success";

function redirectTo(request: NextRequest, pathname: string, params?: Record<string, string>) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, 303);
}

function requireGoogleOAuthCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must both be set. See .env.example."
    );
  }
  return { clientId, clientSecret };
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // Google reports a declined consent screen, or a refusal of its own, by
  // redirecting here with `error` set rather than by failing outright. Not a
  // bug on our side, so this does not log as one.
  const googleError = params.get("error");
  if (googleError) {
    console.warn(`${LOG} Google returned an error: ${googleError}`);
    return redirectTo(request, LOGIN_PATH, { error: "Gmail connection was not completed." });
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    return redirectTo(request, LOGIN_PATH, {
      error: "Gmail callback is missing its code or state.",
    });
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectTo(request, LOGIN_PATH);
  }

  try {
    verifyGmailOAuthState(state, user.id);
  } catch (err) {
    const reason = err instanceof GmailOAuthStateError ? err.message : "invalid state";
    console.warn(`${LOG} state verification failed for user ${user.id}: ${reason}`);
    return redirectTo(request, LOGIN_PATH, {
      error: "Gmail connection request expired or was invalid. Try again.",
    });
  }

  let redirectUri: string;
  let clientId: string;
  let clientSecret: string;
  try {
    redirectUri = gmailOAuthRedirectUri(request.nextUrl.origin);
    ({ clientId, clientSecret } = requireGoogleOAuthCredentials());
  } catch (err) {
    console.error(`${LOG} ${err instanceof Error ? err.message : String(err)}`);
    return redirectTo(request, LOGIN_PATH, {
      error: "Gmail connect is not available from this origin right now.",
    });
  }

  const oauthClient = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  let refreshToken: string | null;
  try {
    const { tokens } = await oauthClient.getToken(code);
    refreshToken = tokens.refresh_token ?? null;
  } catch (err) {
    console.error(
      `${LOG} token exchange failed for user ${user.id}: ` +
        `${err instanceof Error ? err.message : "unknown error"}`
    );
    return redirectTo(request, LOGIN_PATH, {
      error: "Could not complete the Gmail connection. Try again.",
    });
  }

  if (!refreshToken) {
    // `access_type=offline` plus `prompt=consent` on the start leg exists
    // specifically to prevent this: without it, a user who already granted
    // this app consent once gets a code that exchanges into no
    // refresh_token at all. Landing here anyway means Google did not honor
    // that, which is worth a loud log line rather than a silent partial
    // connection.
    console.error(`${LOG} token exchange for user ${user.id} returned no refresh_token`);
    return redirectTo(request, LOGIN_PATH, {
      error: "Google did not issue a refresh token for this Gmail connection. Try again.",
    });
  }

  let encryptedRefreshToken: string;
  try {
    encryptedRefreshToken = encryptGmailRefreshToken(refreshToken);
  } catch (err) {
    // Never `refreshToken` itself, and `GmailTokenCryptoError`'s own message
    // never carries the key or the token either — see lib/gmail-token-crypto.ts.
    console.error(
      `${LOG} could not encrypt the refresh token for user ${user.id}: ` +
        `${err instanceof Error ? err.message : "unknown error"}`
    );
    return redirectTo(request, LOGIN_PATH, {
      error: "Gmail connected, but saving it failed. Try again.",
    });
  }

  const { error: writeError } = await createServiceRoleClient()
    .from("profiles")
    .update({ gmail_refresh_token: encryptedRefreshToken })
    .eq("id", user.id);

  if (writeError) {
    console.error(`${LOG} could not store refresh token for user ${user.id}: ${writeError.message}`);
    return redirectTo(request, LOGIN_PATH, {
      error: "Gmail connected, but saving it failed. Try again.",
    });
  }

  return redirectTo(request, SUCCESS_PATH);
}
