/**
 * JOB-329 — the Resend HTTP client behind the morning recap cron.
 *
 * A third narrow Resend caller alongside `lib/notifier.ts`'s
 * `resendAndTwilioAdapter` and `lib/reengagement/email.ts`'s
 * `sendReEngagementEmail`, rather than a shared one, for the same reason
 * `lib/reengagement/email.ts` gives: the three send different things under
 * different rules. This one goes out at most once per 20 hour window per
 * profile, from whatever `RESEND_FROM_ADDRESS` happens to be, and always
 * carries a fixed `Reply-To` that puts a reply straight into the founder's
 * own inbox, because the whole point of this email is that it reads as one
 * person writing to another rather than as a system notification.
 *
 * `fetch` rather than the Resend SDK, matching the project wide rule of not
 * adding a dependency for one HTTP call that `lib/notifier.ts` already
 * established.
 *
 * The `redactEmail` helper is imported from `lib/reengagement/email.ts`
 * rather than duplicated: the JOB-322 guard against non string input is the
 * one place that check lives, and re copying it here would defeat the
 * reason that guard exists (see the header on `redactEmail`). Every log
 * line in this module and in `inngest/recap-cron.ts` routes through it.
 *
 * Idempotency key
 *   `inngest/recap-cron.ts` claims a profile (stamps
 *   `recap_email_last_sent_at`) before calling this function, not after, so
 *   a send that fails partway through never leaves a profile both stamped
 *   and unemailed with no way to tell. `buildRecapIdempotencyKey` gives
 *   that claim a matching Resend side guard: a versioned key per profile
 *   per calendar day means a retried request within Resend's documented
 *   24 hour retention window is deduplicated on Resend's end too, and the
 *   day suffix means the next morning is a genuinely new send rather than
 *   a silent dedup against yesterday's key.
 */

import { createHash } from "node:crypto";

import { redactEmail } from "@/lib/reengagement/email";

// Re export from JOB-311 so callers in this module and its tests reach for
// the same helper. See that module's header for why the guard against non
// string input matters, and CLAUDE.md's HARD STOP 9 for the rule it
// enforces.
export { redactEmail };

const LOG = "[job-329-recap]";

/**
 * A deterministic key, one per profile per calendar day, for Resend's
 * `Idempotency-Key` header. See the module header for why this exists; the
 * string it hashes is versioned (`recap-v1`) so a future, deliberately
 * different email to the same profile on the same day would not be
 * silently deduplicated against this one.
 *
 * `dayStamp` is an ISO date string (`YYYY-MM-DD`) in UTC, taken from the
 * `now` the cron passes down. Passing it in rather than reading `Date.now()`
 * here keeps this function pure so a test can pin the key it produces.
 */
export function buildRecapIdempotencyKey(profileId: string, dayStamp: string): string {
  return createHash("sha256").update(`${profileId}-recap-v1-${dayStamp}`).digest("hex");
}

/**
 * Formats a Date as `YYYY-MM-DD` in UTC. The dayStamp `buildRecapIdempotencyKey`
 * consumes. A tiny helper of its own so the cron and the test build the same
 * string the same way, and so a stray call to `.toISOString().slice(0, 10)`
 * elsewhere cannot drift out of sync with the key.
 */
export function utcDayStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Where a reply to this email actually lands. Fixed rather than read from
 * an env var, matching JOB-311: this is the one address the whole email
 * exists to route replies to, and a value that could drift out from under
 * the copy promising a real person is on the other end is worse than one
 * that cannot.
 */
export const RECAP_REPLY_TO = "pranavlende123@gmail.com";

export type SendRecapEmailInput = {
  to: string;
  subject: string;
  text: string;
  /**
   * Passed through to Resend as `Idempotency-Key`. Optional in the type
   * only so a caller who has not yet minted one does not fail to type
   * check; the cron itself always supplies one, built with
   * `buildRecapIdempotencyKey`.
   */
  idempotencyKey?: string;
};

/**
 * Why a send did not happen. Same shape as the re engagement variant, for
 * the same reason: a batch of fifty candidates should not lose all fifty
 * because one address bounced or one key was rotated mid run.
 */
export type SendRecapEmailResult =
  | { sent: true }
  | { sent: false; reason: "missing_api_key" | "rejected" | "threw" };

/**
 * One Resend send. Never throws. A missing `RESEND_API_KEY`, a non 2xx
 * response, or a network error are all reported back as `{ sent: false,
 * reason }` so the caller can log and continue to the next candidate.
 */
export async function sendRecapEmail(
  input: SendRecapEmailInput
): Promise<SendRecapEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_ADDRESS ?? "noreply@jobinno.app";

  if (!apiKey || apiKey.trim() === "") {
    console.warn(`${LOG} RESEND_API_KEY is not set; email to ${redactEmail(input.to)} was not sent.`);
    return { sent: false, reason: "missing_api_key" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: input.to,
        reply_to: RECAP_REPLY_TO,
        subject: input.subject,
        text: input.text,
      }),
    });
    if (!response.ok) {
      // Same policy as JOB-311: the response body is never logged, even
      // truncated. A Resend rejection body can itself echo back the
      // recipient address, which is exactly the data this log line exists
      // to avoid writing anywhere. The status code is enough to tell a bad
      // key apart from a bad address.
      console.warn(`${LOG} resend rejected the request for ${redactEmail(input.to)}: status ${response.status}.`);
      return { sent: false, reason: "rejected" };
    }
    return { sent: true };
  } catch (err) {
    console.warn(`${LOG} resend send threw: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: false, reason: "threw" };
  }
}
