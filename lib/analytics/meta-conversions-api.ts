/**
 * JOB-328. Meta Conversions API server to server client.
 *
 * ── Why a second analytics path at all ──────────────────────────────────────
 * PostHog is the product funnel and stays where it is. Meta needs its own
 * events for a different job: the ad auction picks which impressions to buy
 * based on which impressions historically produced Purchase and
 * CompleteRegistration events, and if Meta never sees those events the auction
 * falls back to buying cheap clicks, which is exactly the failure mode the
 * funnel workflow of 2026 09 01 caught. See the ticket body on issue #344 for
 * the numbers.
 *
 * The Meta Pixel in the browser handles page view style events. Two of the
 * three events this file cares about happen after the browser closed the tab
 * or was never involved at all (INTAKE_COMPLETED runs in a server action;
 * Purchase runs from a Stripe webhook), so those go through Meta's
 * Conversions API by way of this file.
 *
 * ── Why nothing here throws ─────────────────────────────────────────────────
 * Same reason `posthog-server.ts` documents at length: analytics is the least
 * important thing happening on any path that fires an event. A missing
 * `META_CAPI_ACCESS_TOKEN`, a missing `NEXT_PUBLIC_META_PIXEL_ID`, a Meta
 * outage, and a bad JSON body all come out the same way: one console warn and
 * a resolved promise. This is important for launch: the code ships before
 * Pranav sets the vars in Vercel prod, so the no op path is the safe default.
 *
 * ── Why the email is hashed and the raw address never sent ──────────────────
 * HARD STOP 9 forbids letting the user's attestation carrying data leak into
 * places that would surprise them. Meta's CAPI documents SHA-256 of the
 * lowercased trimmed email as the canonical user identifier for exactly this
 * reason: the ad platform can match against its own hashed email index
 * without receiving anyone's actual email address. So the caller hands in a
 * raw email, this file hashes it, and only the hash goes on the wire.
 *
 * ── Why there is no retry ───────────────────────────────────────────────────
 * The three call sites are `submitIntake` (a person waiting on their intake
 * to save), the Stripe webhook (Stripe retrying is not on our timeline), and
 * later the pixel client fallback. None of them can afford the ~40 seconds
 * of retry Meta's SDKs bake in by default. One fast attempt with a 2 second
 * timeout, and a lost event is an acceptable loss.
 */

import { createHash } from "node:crypto";

import type { MetaEventName } from "@/lib/analytics/meta-pixel-client";

const LOG = "[job-328]";

/**
 * Meta's Conversions API version pin. Meta rolls the version number roughly
 * quarterly; pinning here means an unrelated dashboard change does not shift
 * the wire format under us. Bump this when Meta deprecates the version.
 */
const META_API_VERSION = "v21.0";

export interface MetaCapiEvent {
  eventName: MetaEventName;
  /**
   * Raw email. Hashed inside this file before sending. Never logged, never
   * echoed back to a browser, and never sent as plain text on the wire.
   * Optional because a Purchase from a checkout without an email on record
   * (rare, but possible) is still a real Purchase.
   */
  email?: string | null;
  /**
   * Unix seconds. Defaults to now. Passed through so a Stripe webhook can
   * report the moment the payment landed rather than the moment we got
   * around to processing the event, which matters for Meta's attribution
   * window calculations.
   */
  eventTime?: number;
  /**
   * Idempotency key. Meta deduplicates events with the same eventId across
   * Pixel and CAPI, so a Purchase fired from the Stripe webhook does not
   * double count if the browser side also fired one. The Stripe event id is
   * a natural choice here.
   */
  eventId?: string;
  /**
   * The URL a person was on when the event happened, if known. Meta uses it
   * to attribute the event to a landing page. Optional.
   */
  eventSourceUrl?: string;
  /**
   * Purchase requires a value and a currency. Ignored for the other event
   * types. Currency defaults to "usd" in the caller, this file just passes
   * both through.
   */
  value?: number;
  currency?: string;
}

/**
 * Reads `META_CAPI_ACCESS_TOKEN` and `NEXT_PUBLIC_META_PIXEL_ID` and returns
 * both when they are set, or null when either is missing. Split out for the
 * tests, which cannot mutate `process.env` inside a jsdom module scope
 * cleanly.
 *
 * The pixel id is public. The access token is the secret half and is read
 * as a static member expression rather than through a dynamic lookup for the
 * same reason `analytics/events.ts` documents: Next inlines `NEXT_PUBLIC_`
 * reads at build time by matching the literal spelling.
 */
export function metaCapiConfig(): {
  pixelId: string;
  accessToken: string;
} | null {
  const pixelId = (process.env.NEXT_PUBLIC_META_PIXEL_ID ?? "").trim();
  const accessToken = (process.env.META_CAPI_ACCESS_TOKEN ?? "").trim();
  if (pixelId === "" || accessToken === "") return null;
  return { pixelId, accessToken };
}

/**
 * Meta's canonical user identifier. Lowercase and trim first, then SHA-256,
 * then hex. The order matters: hashing "Alice@Example.com" and hashing
 * "alice@example.com" produce different digests, and Meta's own index is
 * built off the lowercased trimmed form. See Meta CAPI docs on
 * `user_data.em`.
 */
export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/**
 * A once-per-process guard so a missing env var logs once at startup rather
 * than on every event. Reset between tests through the export below.
 */
let missingEnvWarned = false;

export function resetMetaCapiWarningForTests(): void {
  missingEnvWarned = false;
}

/**
 * Send one event to Meta's Conversions API. Resolves either way; see the
 * header on why it cannot reject.
 */
export async function sendMetaCapiEvent(event: MetaCapiEvent): Promise<void> {
  const config = metaCapiConfig();
  if (config === null) {
    if (!missingEnvWarned) {
      console.warn(
        `${LOG} NEXT_PUBLIC_META_PIXEL_ID or META_CAPI_ACCESS_TOKEN not set, Meta CAPI events are off`,
      );
      missingEnvWarned = true;
    }
    return;
  }

  const eventTime = event.eventTime ?? Math.floor(Date.now() / 1000);
  const userData: Record<string, string[] | string> = {};
  if (event.email && event.email.trim() !== "") {
    userData.em = [hashEmail(event.email)];
  }

  const customData: Record<string, unknown> = {};
  if (typeof event.value === "number" && Number.isFinite(event.value)) {
    customData.value = event.value;
  }
  if (event.currency) {
    customData.currency = event.currency;
  }

  const eventPayload: Record<string, unknown> = {
    event_name: event.eventName,
    event_time: eventTime,
    action_source: "website",
    user_data: userData,
  };
  if (event.eventId) eventPayload.event_id = event.eventId;
  if (event.eventSourceUrl) eventPayload.event_source_url = event.eventSourceUrl;
  if (Object.keys(customData).length > 0) eventPayload.custom_data = customData;

  const body = JSON.stringify({
    data: [eventPayload],
    access_token: config.accessToken,
  });

  const url = `https://graph.facebook.com/${META_API_VERSION}/${config.pixelId}/events`;

  // AbortSignal.timeout is available on every Node runtime this project
  // targets. Two seconds matches the `posthog-server.ts` budget and for the
  // same reason: a webhook or a server action cannot afford Meta's default
  // wait when their edge is slow.
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      // Read at most one KB of the body for the log. Meta returns JSON with
      // an `error.message` that names the exact field it rejected, which is
      // exactly what a debugging session wants and exactly what a customer
      // has no business seeing. This function's callers never surface this
      // string.
      const text = (await response.text()).slice(0, 1024);
      console.warn(
        `${LOG} Meta CAPI rejected ${event.eventName}: ${response.status} ${text}`,
      );
    }
  } catch (err) {
    console.warn(
      `${LOG} Meta CAPI ${event.eventName} could not be sent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
