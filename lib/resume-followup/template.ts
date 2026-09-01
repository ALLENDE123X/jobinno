/**
 * JOB-330 — the copy for the resume upload follow-up email.
 *
 * Sent immediately after a person takes the second lane on step 1 of
 * onboarding (`profiles.linkedin_url_pending`), because that lane exists
 * precisely for someone who cannot produce a PDF from their phone right
 * now. The email carries the deep link back to `/onboarding/step/1` in
 * upload-only mode so they can finish from a laptop later.
 *
 * A pure function on purpose, mirroring `lib/reengagement/template.ts`:
 * the body has to read cleanly and never carry the sensitive parts of a
 * profile beyond what the ticket allows, and testing prose is easier when
 * nothing else is in the loop.
 *
 * ── HARD STOP 8: no em dashes and no prose hyphens ─────────────────────
 * Every user visible line below is checked against that in
 * `tests/unit/resume-followup/template.test.ts`. The single deep link is
 * a URL, not prose, so its slashes and question mark are fine; the
 * greeting and the closing lines are pure prose.
 */

/**
 * Where the email sends the person back to. Deep links to step 1 with a
 * query flag so that page renders the upload-only view (no LinkedIn URL
 * lane visible again). See `app/onboarding/step/step-1.tsx` for the
 * `?resumeUpload=1` handler.
 */
export const RESUME_FOLLOWUP_DEEP_LINK =
  "https://jobinno.app/onboarding/step/1?resumeUpload=1";

export type ResumeFollowupEmailContent = {
  subject: string;
  text: string;
};

/**
 * Builds the subject and plain text body for one send. `email` is the
 * only input for the same reason `buildReEngagementEmail` takes only
 * `email`: HARD STOP 9 forbids inventing anything the intake data does
 * not already support, and a profile at this point has not filled in a
 * name yet either. The LinkedIn URL is deliberately not echoed back
 * because a Resend delivery bounce log would then carry two personally
 * identifying strings for one person; the deep link is enough for the
 * person to know which signup this is about.
 */
export function buildResumeFollowupEmail(
  email: string,
): ResumeFollowupEmailContent {
  const subject = "finish your Jobinno signup from your laptop";

  const text = [
    `Hi ${email},`,
    "",
    "You saved your LinkedIn on the phone signup earlier. Once your resume " +
      "PDF lands, Jobinno starts applying to real internships and new grad " +
      "roles on your behalf.",
    "",
    "Open this link on your laptop and upload the PDF:",
    RESUME_FOLLOWUP_DEEP_LINK,
    "",
    "It only takes a minute, and the queue picks up right after the " +
      "upload. If you cannot find a PDF, save your resume from Google Docs " +
      "or Word as PDF and drop that in.",
    "",
    "If this is not the right time, no worries at all. Reply to this email " +
      "if anything about the signup felt off and I will read it myself.",
    "",
    "Pranav",
  ].join("\n");

  return { subject, text };
}
