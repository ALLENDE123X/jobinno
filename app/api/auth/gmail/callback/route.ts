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
/**
 * Where a signed in user goes when something after the session check fails.
 * This is the same route as `SUCCESS_PATH` on purpose. That page already
 * exists to represent the outcome of the Gmail connect flow, and it reads
 * its `error` search param: with no `error` it renders the success card,
 * and with `error` set it renders an error card whose description is the
 * reason string this handler put there. Sending both branches to the same
 * outcome page keeps every finish of this flow, good or bad, on the page
 * that was built to explain it, rather than on a page that silently drops
 * the `error` info. `/login` is wrong for this case: `app/login/page.tsx`
 * redirects a signed in visitor straight to `/dashboard` before it ever
 * reads `error`, so a signed in user bounced there never sees why the
 * connection failed. `/dashboard` was tried once for the same reason and
 * has the same silent drop problem: its page component takes no
 * `searchParams` and its view never reads them, so an `error` sent there
 * was never rendered either.
 */
const POST_AUTH_FAILURE_PATH = SUCCESS_PATH;
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

/**
 * `OAuth2Client#getToken` has no documented way to accept a signal or a per
 * call timeout of its own: it always runs to completion through Gaxios's
 * default, timeout free transporter. Left alone, a stalled call to Google's
 * token endpoint hangs until the platform's own function timeout (about 30s
 * on Vercel) cuts the request off with no typed error and no chance to send
 * the user anywhere useful. Racing it against a timer, below, cannot cancel
 * the underlying socket, but it does guarantee this handler stops waiting,
 * and fails closed, well before the platform does it for us.
 */
class GmailTokenExchangeTimeoutError extends Error {
  constructor() {
    super(`Gmail token exchange timed out after ${TOKEN_EXCHANGE_TIMEOUT_MS}ms.`);
    this.name = "GmailTokenExchangeTimeoutError";
  }
}

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
    return redirectTo(request, POST_AUTH_FAILURE_PATH, {
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
    return redirectTo(request, POST_AUTH_FAILURE_PATH, {
      error: "Gmail connect is not available from this origin right now.",
    });
  }

  const oauthClient = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  let refreshToken: string | null;
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
  try {
    const tokenExchange = oauthClient.getToken(code);
    const timedOut = new Promise<never>((_, reject) => {
      timeoutController.signal.addEventListener("abort", () => {
        reject(new GmailTokenExchangeTimeoutError());
      });
    });
    const { tokens } = await Promise.race([tokenExchange, timedOut]);
    refreshToken = tokens.refresh_token ?? null;
  } catch (err) {
    const timedOut = err instanceof GmailTokenExchangeTimeoutError;
    console.error(
      `${LOG} token exchange failed for user ${user.id}: ` +
        `${err instanceof Error ? err.message : "unknown error"}`
    );
    return redirectTo(request, POST_AUTH_FAILURE_PATH, {
      error: timedOut
        ? "Google took too long to respond. Try again."
        : "Could not complete the Gmail connection. Try again.",
    });
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (!refreshToken) {
    // `access_type=offline` plus `prompt=consent` on the start leg exists
    // specifically to prevent this: without it, a user who already granted
    // this app consent once gets a code that exchanges into no
    // refresh_token at all. Landing here anyway means Google did not honor
    // that, which is worth a loud log line rather than a silent partial
    // connection.
    console.error(`${LOG} token exchange for user ${user.id} returned no refresh_token`);
    return redirectTo(request, POST_AUTH_FAILURE_PATH, {
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
    return redirectTo(request, POST_AUTH_FAILURE_PATH, {
      error: "Gmail connected, but saving it failed. Try again.",
    });
  }

  // JOB-200: the service role factory throws a bare `Error` when
  // `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are unset. Unwrapped that
  // surfaces as a framework 500 with a stack trace, past the redirect the
  // rest of this handler uses on every other failure branch. The detail
  // names which SUPABASE_* variable is empty and stays in the log; the
  // redirect reason is generic on purpose. Neither `refreshToken` nor
  // `encryptedRefreshToken` appears in the log line, matching the header's
  // "Never logged" rule above.
  let serviceClient: ReturnType<typeof createServiceRoleClient>;
  try {
    serviceClient = createServiceRoleClient();
  } catch (thrown) {
    const detail =
      thrown instanceof Error ? thrown.message : "service role client unavailable";
    console.error(
      `${LOG} service role client unavailable for user ${user.id}: ${detail}`
    );
    return redirectTo(request, POST_AUTH_FAILURE_PATH, {
      error: "Gmail connected, but saving it failed. Try again.",
    });
  }

  const { data: updatedRows, error: writeError } = await serviceClient
    .from("profiles")
    .update({ gmail_refresh_token: encryptedRefreshToken })
    .eq("id", user.id)
    .select("id");

  if (writeError) {
    console.error(`${LOG} could not store refresh token for user ${user.id}: ${writeError.message}`);
    return redirectTo(request, POST_AUTH_FAILURE_PATH, {
      error: "Gmail connected, but saving it failed. Try again.",
    });
  }

  if (updatedRows?.length !== 1) {
    // Supabase reports no error at all when an UPDATE matches zero rows, so
    // `writeError` above stays null even though nothing was actually stored.
    // Reporting success here would show "Gmail is connected" for a refresh
    // token that has nowhere to live; the encrypted value is discarded and
    // the only recovery is a full re-consent.
    console.error(
      `${LOG} update matched ${updatedRows?.length ?? 0} profiles rows for user ${user.id}; ` +
        "refresh token not stored"
    );
    return redirectTo(request, POST_AUTH_FAILURE_PATH, {
      error: "Gmail connected, but the profile row was not found. Try again.",
    });
  }

  return redirectTo(request, SUCCESS_PATH);
}
