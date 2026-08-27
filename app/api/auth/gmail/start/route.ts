/**
 * JOB-189 — kicks off the Gmail OAuth consent flow.
 *
 * GET /api/auth/gmail/start
 *  1. Requires a signed in user. Anyone else is sent to /login.
 *  2. Signs a state parameter naming this user (see lib/gmail-oauth.ts), so
 *     the callback can tell a real return trip from a forged one.
 *  3. Redirects to Google's consent screen with the gmail.readonly scope,
 *     access_type=offline and prompt=consent, which together are what makes
 *     Google actually include a refresh_token on the callback even for a
 *     user who has already granted this app consent before.
 *
 * This is the first half of the flow `lib/future-gmail/README.md` describes
 * as V2 reference code. Nothing downstream reads `gmail_refresh_token` yet;
 * wiring it into automated account creation is a later, separate ticket.
 */

import { NextResponse, type NextRequest } from "next/server";

import { GMAIL_OAUTH_SCOPE, gmailOAuthRedirectUri, signGmailOAuthState } from "@/lib/gmail-oauth";
import { createServerClient } from "@/lib/supabase/server";

const LOG = "[gmail-oauth-start]";
const LOGIN_PATH = "/login";
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

function requireGoogleOAuthClientId(): string {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID is required but not set. See .env.example.");
  }
  return clientId;
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

export async function GET(request: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectTo(request, LOGIN_PATH);
  }

  let redirectUri: string;
  let clientId: string;
  try {
    redirectUri = gmailOAuthRedirectUri(request.nextUrl.origin);
    clientId = requireGoogleOAuthClientId();
  } catch (err) {
    // Naming what failed in the log is fine here: neither message ever
    // carries a secret, only an origin or an env var name.
    console.error(`${LOG} ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { error: "Gmail connect is not available from this origin right now." },
      { status: 400 }
    );
  }

  const state = signGmailOAuthState(user.id);

  const authorizeUrl = new URL(GOOGLE_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", GMAIL_OAUTH_SCOPE);
  authorizeUrl.searchParams.set("access_type", "offline");
  authorizeUrl.searchParams.set("prompt", "consent");
  authorizeUrl.searchParams.set("state", state);

  return NextResponse.redirect(authorizeUrl, 303);
}
