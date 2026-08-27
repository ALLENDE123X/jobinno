/**
 * JOB-189 — shared plumbing for the live Gmail OAuth wiring:
 * `app/api/auth/gmail/start/route.ts` starts the consent flow, and
 * `app/api/auth/gmail/callback/route.ts` finishes it. Two things live here
 * rather than in either route file, because both routes need them to agree
 * on the same value or the same computation.
 *
 * ── The redirect_uri ─────────────────────────────────────────────────────
 * Google checks the `redirect_uri` on the token exchange against the one the
 * authorization request carried, and refuses the exchange on a mismatch. The
 * start leg and the callback leg have to compute the identical string from
 * the identical rule, so it is written once here.
 *
 * ── The state signature ──────────────────────────────────────────────────
 * `start` signs a state parameter naming the user who began the flow;
 * `callback` verifies it. Two independent implementations of the same HMAC
 * is exactly how one of them quietly drifts from the other, so this is
 * written once too.
 *
 * ── Not the same GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET the
 *    names suggest ─────────────────────────────────────────────────────────
 * `lib/future-gmail/gmail-client.ts` already reads those two names, for a
 * different, still unwired flow: the one time consent CLI that mints
 * `GOOGLE_OAUTH_REFRESH_TOKEN` for the emailed verification code listener.
 * That file's own comment says the OAuth client it expects is either a
 * Desktop app client, or a Web application client with
 * `http://localhost:53682/oauth/callback` registered. Per the ticket, the
 * OAuth client Google Cloud now holds these two env vars for is a Web
 * application client authorized for
 * `https://jobinno.app/api/auth/gmail/callback` and
 * `http://localhost:3000/api/auth/gmail/callback`, which does not include
 * that loopback URI. The two flows now share one client id and secret,
 * intentionally or not; see the PR description for why this is left as a
 * flagged open question rather than silently reconciled here.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { LOCAL_DEV_ORIGIN, PRODUCTION_ORIGIN } from "@/lib/auth/redirect-urls";

/** Read only, the narrowest scope that can still see a message body. */
export const GMAIL_OAUTH_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/**
 * Where the Google Cloud OAuth client's "Authorized redirect URIs" point.
 * Deliberately narrower than `lib/auth/redirect-urls.ts`'s
 * `AUTH_REDIRECT_ALLOWLIST`: that allowlist also covers `www.jobinno.app` and
 * Vercel previews, neither of which the ticket says was registered on this
 * OAuth client, so this list stays exactly the two origins that were.
 */
const GMAIL_OAUTH_ALLOWED_ORIGINS: readonly string[] = [LOCAL_DEV_ORIGIN, PRODUCTION_ORIGIN];

const GMAIL_OAUTH_CALLBACK_PATH = "/api/auth/gmail/callback";

/**
 * The redirect_uri for one leg of the flow, or a thrown error naming the
 * fix. Throwing rather than falling back to a default matches
 * `authCallbackUrlFor` in `lib/auth/redirect-urls.ts`, and for the same
 * reason: Google does not substitute anything for a redirect_uri it does not
 * recognize, it refuses the whole exchange, so a caller on an origin nobody
 * registered should find out here rather than from a Google error page.
 */
export function gmailOAuthRedirectUri(origin: string): string {
  const normalizedOrigin = origin.replace(/\/+$/, "");
  if (!GMAIL_OAUTH_ALLOWED_ORIGINS.includes(normalizedOrigin)) {
    throw new Error(
      `Refusing to build a Gmail OAuth redirect for ${normalizedOrigin}: it is not one of ` +
        `the origins Google's OAuth client has registered (${GMAIL_OAUTH_ALLOWED_ORIGINS.join(", ")}). ` +
        `Register it on the OAuth client in Google Cloud Console first, then add it here.`
    );
  }
  return `${normalizedOrigin}${GMAIL_OAUTH_CALLBACK_PATH}`;
}

/**
 * A state parameter that failed to verify. The message never carries the raw
 * state value or the signing secret, only what kind of check it failed.
 */
export class GmailOAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailOAuthStateError";
  }
}

/** How long a signed state parameter is considered fresh, per the ticket. */
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/** `.env.example` documents this as 32 hex characters (16 bytes). */
const STATE_SECRET_LENGTH_BYTES = 16;

interface GmailOAuthStatePayload {
  userId: string;
  ts: number;
}

/**
 * Reads and validates `GMAIL_OAUTH_STATE_SECRET`. Fails closed, mirroring
 * `loadKey()` in `lib/gmail-token-crypto.ts`: an unset, short, or non hex
 * value is a `GmailOAuthStateError` rather than a weak secret silently
 * accepted, since an HMAC key shorter than intended is easier to guess and a
 * malformed one would only fail confusingly the first time `sign` ran.
 */
function requireStateSecret(): string {
  const secret = process.env.GMAIL_OAUTH_STATE_SECRET?.trim();
  if (!secret) {
    throw new GmailOAuthStateError(
      "GMAIL_OAUTH_STATE_SECRET is required but not set. See .env.example; " +
        "generate one with `openssl rand -hex 16`."
    );
  }
  const expectedHexLength = STATE_SECRET_LENGTH_BYTES * 2;
  if (secret.length !== expectedHexLength || !/^[0-9a-f]+$/i.test(secret)) {
    throw new GmailOAuthStateError(
      `GMAIL_OAUTH_STATE_SECRET must be exactly ${expectedHexLength} hex characters ` +
        `(${STATE_SECRET_LENGTH_BYTES} bytes). Generate one with \`openssl rand -hex 16\`.`
    );
  }
  return secret;
}

function sign(payloadB64Url: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64Url).digest("hex");
}

function safeHexBuffer(hex: string): Buffer | null {
  if (hex === "" || !/^[0-9a-f]+$/i.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/**
 * Signs a state parameter naming the user starting the flow, right now.
 * `app/api/auth/gmail/start/route.ts` puts the result straight on the
 * authorization URL's `state` query parameter.
 */
export function signGmailOAuthState(userId: string): string {
  const payload: GmailOAuthStatePayload = { userId, ts: Date.now() };
  const payloadB64Url = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64Url}.${sign(payloadB64Url, requireStateSecret())}`;
}

/**
 * Verifies a state parameter round tripped from Google: the signature is
 * intact, the payload names `expectedUserId`, and it was signed less than
 * `STATE_MAX_AGE_MS` ago. Throws `GmailOAuthStateError` naming what failed;
 * returns nothing on success.
 *
 * The signature check runs before the payload is ever parsed as JSON, and
 * `timingSafeEqual` rather than `===`, so a caller who does not hold
 * `GMAIL_OAUTH_STATE_SECRET` learns nothing from how this function fails
 * about which byte of their forged state was wrong.
 */
export function verifyGmailOAuthState(state: string, expectedUserId: string): void {
  const secret = requireStateSecret();
  const parts = state.split(".");
  if (parts.length !== 2) {
    throw new GmailOAuthStateError("State parameter is malformed.");
  }
  const [payloadB64Url, signatureHex] = parts;

  const expectedSignatureHex = sign(payloadB64Url, secret);
  const signatureBuf = safeHexBuffer(signatureHex);
  const expectedBuf = Buffer.from(expectedSignatureHex, "hex");
  if (
    signatureBuf === null ||
    signatureBuf.length !== expectedBuf.length ||
    !timingSafeEqual(signatureBuf, expectedBuf)
  ) {
    throw new GmailOAuthStateError("State signature does not match.");
  }

  let payload: GmailOAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64Url, "base64url").toString("utf8"));
  } catch {
    throw new GmailOAuthStateError("State payload is not valid JSON.");
  }
  if (typeof payload?.userId !== "string" || typeof payload?.ts !== "number") {
    throw new GmailOAuthStateError("State payload is missing required fields.");
  }
  if (payload.userId !== expectedUserId) {
    throw new GmailOAuthStateError("State was issued for a different user.");
  }

  const age = Date.now() - payload.ts;
  if (age < 0 || age > STATE_MAX_AGE_MS) {
    throw new GmailOAuthStateError("State has expired. Start the Gmail connection again.");
  }
}
