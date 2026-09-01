/**
 * JOB-330 — the Resend HTTP client behind the resume upload follow-up
 * email.
 *
 * Sent once from `submitLinkedInDeferred` in `app/onboarding/actions.ts`
 * the moment a person takes the second lane on step 1. A third narrow
 * Resend caller alongside `lib/notifier.ts`'s `resendAndTwilioAdapter`
 * and `lib/reengagement/email.ts`'s `sendReEngagementEmail`, rather
 * than a shared one, for the same reasons those two are separate: each
 * sends different content under different rules (idempotency key
 * strategy, `Reply-To` behavior, and the failure posture the caller
 * expects), and combining them behind one signature is exactly how one
 * caller's assumptions silently start applying to another's.
 *
 * `fetch` rather than the Resend SDK, matching the project wide rule
 * `lib/notifier.ts` established of not adding a dependency for one HTTP
 * call.
 *
 * ── Idempotency key ─────────────────────────────────────────────────
 * `buildResumeFollowupIdempotencyKey` hashes the profile id under a
 * versioned suffix so a retried send inside Resend's 24 hour retention
 * window is deduplicated on Resend's end too. Version bumped when the
 * email template changes in a way that a re-send is legitimately a new
 * message.
 */

import { createHash } from "node:crypto";

const LOG = "[job-330-resume-followup]";

/**
 * Redacts an email address for logging: keeps the first two characters
 * of the local part and the full domain, masks the rest. Same shape as
 * `lib/reengagement/email.ts`'s `redactEmail`, duplicated here rather
 * than imported to keep this module self-contained the way that one is.
 * The typeof guard is a runtime backstop; the signature stays `string`
 * so a caller passing an obviously wrong shape still fails to type
 * check.
 */
export function redactEmail(email: string): string {
  if (typeof email !== "string") return "[invalid]";
  const [local, domain] = email.split("@");
  if (!local || !domain) return "[invalid]";
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * A deterministic key, one per profile, for Resend's `Idempotency-Key`
 * header. The suffix is versioned so a future, deliberately different
 * email to the same profile is not silently deduplicated against this
 * one.
 */
export function buildResumeFollowupIdempotencyKey(profileId: string): string {
  return createHash("sha256")
    .update(`${profileId}-resume-followup-v1`)
    .digest("hex");
}

/**
 * Where a reply lands. Fixed rather than read from an env var: this
 * email opens a real conversation with the person about their signup
 * and the founder personal address is where those replies belong, the
 * same posture `REENGAGEMENT_REPLY_TO` in `lib/reengagement/email.ts`
 * takes for the same reason.
 */
export const RESUME_FOLLOWUP_REPLY_TO = "pranavlende123@gmail.com";

export type SendResumeFollowupEmailInput = {
  to: string;
  subject: string;
  text: string;
  /** Optional so a caller without a key still type checks; the server action always supplies one. */
  idempotencyKey?: string;
};

/**
 * Why a send did not happen. Same three soft failures the reengagement
 * caller distinguishes, for the same reason: onboarding cannot stop for
 * one email that could not go out, so a missing key, a rejection or a
 * network throw all come back as tagged non-throws and the caller logs
 * and moves on.
 */
export type SendResumeFollowupEmailResult =
  | { sent: true }
  | { sent: false; reason: "missing_api_key" | "rejected" | "threw" };

/**
 * One Resend send. Never throws. A missing `RESEND_API_KEY`, a non 2xx
 * response, or a network error are all reported back as `{ sent: false,
 * reason }` so the caller can log without failing the server action.
 */
export async function sendResumeFollowupEmail(
  input: SendResumeFollowupEmailInput,
): Promise<SendResumeFollowupEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_ADDRESS ?? "noreply@jobinno.app";

  if (!apiKey || apiKey.trim() === "") {
    console.warn(
      `${LOG} RESEND_API_KEY is not set; email to ${redactEmail(input.to)} was not sent.`,
    );
    return { sent: false, reason: "missing_api_key" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(input.idempotencyKey
          ? { "Idempotency-Key": input.idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        from,
        to: input.to,
        reply_to: RESUME_FOLLOWUP_REPLY_TO,
        subject: input.subject,
        text: input.text,
      }),
    });
    if (!response.ok) {
      // Response body never logged; a Resend rejection body echoes the
      // recipient address, which is exactly what this log line exists to
      // avoid writing anywhere. Status code alone tells a bad key apart
      // from a bad address.
      console.warn(
        `${LOG} resend rejected the request for ${redactEmail(input.to)}: status ${response.status}.`,
      );
      return { sent: false, reason: "rejected" };
    }
    return { sent: true };
  } catch (err) {
    console.warn(
      `${LOG} resend send threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { sent: false, reason: "threw" };
  }
}
