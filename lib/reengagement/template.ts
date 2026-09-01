/**
 * JOB-311 — the copy for the 24h re engagement email.
 *
 * A pure function on purpose, with no database and no network in it. The
 * body has to read as one real person writing to another, which is a
 * property of the words themselves and not of anything the cron does around
 * them, so it is worth being able to check the words with nothing else
 * involved.
 *
 * ── Why the greeting is an email address ─────────────────────────────────
 * Every candidate this cron reaches bounced out of intake before a name was
 * ever collected, so `profiles.email` is the only thing there is to greet
 * them by. "Hi there" reads like a mail merge that failed; the address at
 * least proves a real person is on the other end of this, sent to the exact
 * inbox that will receive it.
 *
 * ── Subject and copy are fixed by the ticket, not tunable here ──────────────
 * JOB-311 names the subject line exactly, and the body is the founder
 * personal draft that already went out once, by hand, to aryareed before
 * this cron existed to send it. Keeping the wording out of any config or env
 * var is deliberate: a copy change is a code review of prose that reaches
 * real people, not a runtime toggle.
 *
 * No em dashes and no prose hyphens anywhere below, per HARD STOP 8 in
 * CLAUDE.md. "new grad" and "one time", not the hyphenated forms.
 */

/** Where the email sends somebody back to, to finish what they started. */
export const REENGAGEMENT_ONBOARDING_URL = "https://jobinno.app/onboarding/step/1";

export type ReEngagementEmailContent = {
  subject: string;
  text: string;
};

/**
 * Builds the subject and plain text body for one send. `email` is the only
 * input, because it is the only fact about the person this cron is allowed
 * to assume: HARD STOP 9 forbids inventing anything the intake data does not
 * already support, and a profile in this cron's window has not gotten far
 * enough into intake for there to be anything else true about them yet.
 */
export function buildReEngagementEmail(email: string): ReEngagementEmailContent {
  const subject = "the signup was too much all at once, that is on me";

  const text = [
    `Hi ${email},`,
    "",
    "I am Pranav, the person building Jobinno. I saw you signed up and then " +
      "the intake asked for a lot all at once, and you stepped away before " +
      "finishing it. That is on me, not on you. I should have made the first " +
      "few minutes lighter.",
    "",
    "If you want to give it another look, you can pick up right where you " +
      "left off here:",
    REENGAGEMENT_ONBOARDING_URL,
    "",
    "It only takes a few minutes to finish, and once it is done Jobinno " +
      "starts applying to real internships and new grad roles on your behalf.",
    "",
    "If it is not the right time, no worries at all, and you will not hear " +
      "from me again about this. If something about the signup felt off or " +
      "confusing, just reply to this email and tell me. I read every reply " +
      "myself.",
    "",
    "Pranav",
  ].join("\n");

  return { subject, text };
}
