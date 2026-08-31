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
 */

const LOG = "[job-311-reengagement]";

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
    console.warn(`${LOG} RESEND_API_KEY is not set; email to ${input.to} was not sent.`);
    return { sent: false, reason: "missing_api_key" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
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
      const body = await response.text();
      console.warn(`${LOG} resend rejected ${response.status}: ${body.slice(0, 300)}`);
      return { sent: false, reason: "rejected" };
    }
    return { sent: true };
  } catch (err) {
    console.warn(`${LOG} resend send threw: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: false, reason: "threw" };
  }
}
