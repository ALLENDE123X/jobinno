/**
 * JOB-217 — the deploy time gate for JOB-211's Gmail auto-read wiring.
 *
 * The reader itself (`lib/gmail-verification-reader.ts`) is off by default in
 * production: the deploy that ships it must not silently begin reading the
 * mailbox of every user who has already connected Gmail through JOB-189's
 * OAuth flow. This gate is the on switch, and its default is off.
 *
 * ── The one variable, and the one accepted value ─────────────────────────────
 * `JOBINNO_GMAIL_AUTO_READ` must be exactly the string `"on"` for the wiring
 * in `completeVerification` to reach `findVerificationCode`. Anything else,
 * including unset, empty, `"off"`, `"true"`, `"1"`, and uppercase variants
 * such as `"ON"`, keeps the pre JOB-211 behaviour: the row parked at
 * `awaiting_verification` throws the same `FormFillBlockedError` it always
 * has when the caller passed no verification input.
 *
 * The single accepted value is deliberate. Environment variables that
 * accept a family of truthy strings ("on", "yes", "true", "1", "enabled",
 * uppercase or not) drift into different meanings across services over
 * time. The demo test account run this ticket is built for either sets the
 * variable exactly or does not, and the flip in Vercel prod is a
 * deliberate act by a person who read this file.
 */

const AUTO_READ_ENV = "JOBINNO_GMAIL_AUTO_READ";
const AUTO_READ_ON_VALUE = "on";

/**
 * True only when `JOBINNO_GMAIL_AUTO_READ` is set to exactly `"on"`. Reads
 * `process.env` at call time on purpose, so a test can set the variable and
 * observe the change without a module reload.
 */
export function isGmailAutoReadEnabled(): boolean {
  return process.env[AUTO_READ_ENV] === AUTO_READ_ON_VALUE;
}
