/**
 * JOB-311 — the Resend HTTP client behind the 24h re engagement cron.
 *
 * A second, narrower Resend caller alongside `lib/notifier.ts`'s
 * `resendAndTwilioAdapter`, rather than a shared one, because the two send
 * different things under different rules. The escalation notifier fires per
 * `pending_user_input` row, rate limited every six hours, from whatever
 * `RESEND_FROM_ADDRESS` happens to be, with no reply routing of its own. This
 * one sends at most once ever per profile (`inngest/reengagement-cron.ts`'s
 * query and stamp is what makes that true) and always carries a fixed
 * `Reply-To` that puts a reply straight into the founder's own inbox, because
 * the whole point of this email is that it reads as one person writing to
 * another rather than as a system notification.
 *
 * `fetch` rather than the Resend SDK, matching the project wide rule of not
 * adding a dependency for one HTTP call that `lib/notifier.ts` already
 * established.
 *
 * ── Idempotency key ───────────────────────────────────────────────────────
 * `inngest/reengagement-cron.ts` claims a profile (stamps
 * `re_engagement_sent_at`) before calling this function, not after, so a send
 * that fails partway through never leaves a profile both stamped and
 * unemailed with no way to tell. `buildReEngagementIdempotencyKey` gives that
 * claim a matching Resend side guard: the same deterministic key for the same
 * profile means a retried request against Resend within its documented 24
 * hour retention window is deduplicated on Resend's end too, so replaying a
 * send for a profile that already claimed its row (through an ops action, for
 * example) can never double email that person.
 */

import { createHash } from "node:crypto";

const LOG = "[job-311-reengagement]";

/**
 * Redacts an email address for logging: keeps the first two characters of
 * the local part and the full domain, masks the rest. Enough to tell log
 * lines about different people apart without writing a real recipient
 * address into logs a person other than that recipient can read.
 */
export function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "[invalid]";
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * A deterministic key, one per profile, for Resend's `Idempotency-Key` header. See
 * the module header for why this exists; the string it hashes is versioned
 * (`-reengagement-v1`) so a future, deliberately different email to the same
 * profile would not be silently deduplicated against this one.
 */
export function buildReEngagementIdempotencyKey(profileId: string): string {
  return createHash("sha256").update(`${profileId}-reengagement-v1`).digest("hex");
}

/**
 * Where a reply to this email actually lands. Fixed rather than read from an
 * env var: this is the one address the whole email exists to route replies
 * to, and a value that could drift out from under the copy promising "I read
 * every reply myself" is worse than one that cannot.
 */
export const REENGAGEMENT_REPLY_TO = "pranavlende123@gmail.com";

export type SendReEngagementEmailInput = {
  to: string;
  subject: string;
  text: string;
  /**
   * Passed through to Resend as `Idempotency-Key`. Optional in the type only
   * so a caller who has not yet minted one does not fail to type check; the
   * cron itself always supplies one, built with
   * `buildReEngagementIdempotencyKey`.
   */
  idempotencyKey?: string;
};

/**
 * Why a send did not happen. `missingApiKey` and `rejected` and `threw` are
 * all soft failures the cron logs and moves past rather than stopping a
 * whole run over, the same posture `lib/notifier.ts` takes for the same
 * reason: a batch of fifty candidates should not lose all fifty because one
 * address bounced or one key was rotated mid run.
 */
export type SendReEngagementEmailResult =
  | { sent: true }
  | { sent: false; reason: "missing_api_key" | "rejected" | "threw" };

/**
 * One Resend send. Never throws. A missing `RESEND_API_KEY`, a non 2xx
 * response, or a network error are all reported back as `{ sent: false,
 * reason }` so the caller can log and continue to the next candidate.
 */
export async function sendReEngagementEmail(
  input: SendReEngagementEmailInput
): Promise<SendReEngagementEmailResult> {
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
        reply_to: REENGAGEMENT_REPLY_TO,
        subject: input.subject,
        text: input.text,
      }),
    });
    if (!response.ok) {
      // The response body is never logged, even truncated: a Resend
      // rejection body can itself echo back the recipient address, which is
      // exactly the data this log line exists to avoid writing anywhere.
      // The status code is enough to tell a bad key apart from a bad address.
      console.warn(`${LOG} resend rejected the request for ${redactEmail(input.to)}: status ${response.status}.`);
      return { sent: false, reason: "rejected" };
    }
    return { sent: true };
  } catch (err) {
    console.warn(`${LOG} resend send threw: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: false, reason: "threw" };
  }
}
