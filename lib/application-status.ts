/**
 * `job_applications.status` — the whole pipeline's status vocabulary.
 *
 * ── Provenance (JOB-001) ────────────────────────────────────────────────────
 * Lifted verbatim from actinno's `lib/create-board-account.ts`, which is the
 * one module in that repo Jobinno deliberately did NOT port: automated account
 * creation on an employer's board is a V2 question, not a V1 one.
 *
 * The enum could not stay there, because it was never really account-creation
 * code. Four ported modules read it — `fill-application-form.ts`,
 * `submit-application.ts`, `future-gmail/gmail-verification-listener.ts` and
 * `inngest/job-application-pipeline.ts` — and its own docstring below already
 * admits it had "outgrown" its host file. So it moves to a module whose only
 * job is to hold it, and the four importers point here instead. The values and
 * their comments are unchanged; only the import path moved.
 *
 * The `creating_account` / `awaiting_verification` / `account_gate_blocked`
 * values describe a flow Jobinno does not run yet. They are kept rather than
 * pruned because `gmail-verification-listener.ts` and the pipeline still
 * reference them, and because a status column that quietly loses values is how
 * historical rows stop meaning anything. The ticket that removes the
 * account-creation step owns deciding their fate.
 */

/**
 * `job_applications.status` values this module writes. The column is free text
 * with a `discovered` default, so these are a convention, not a constraint.
 *
 * `no_account_required` is this ticket's addition: ACT-005's brief names
 * `creating_account` and `awaiting_verification`, but neither describes the
 * direct-apply outcome, and reusing `awaiting_verification` for it would tell
 * ACT-006 to sit waiting for a verification email that is never coming. The
 * ACT-007 form-fill step should treat `no_account_required` and
 * `email_verified` as equally ready to proceed.
 *
 * The table has outgrown "values *this module* writes" — it is now the whole
 * pipeline's status vocabulary, and it lives here because
 * `gmail-verification-listener.ts` already imports it from here. The lower half
 * is written by `fill-application-form.ts` (ACT-007) and
 * `submit-application.ts` (ACT-008). ACT-012's brief forbade
 * changing the values above; nothing forbids a later ticket adding values below
 * for a capability that did not exist yet, and the alternative — a second,
 * competing enum in another file — is how a status column stops meaning
 * anything.
 */
export const APPLICATION_STATUS = {
  /** Row created; browser work in flight. */
  CREATING_ACCOUNT: "creating_account",
  /** Direct-apply board — no signup exists, proceed straight to form fill. */
  NO_ACCOUNT_REQUIRED: "no_account_required",
  /** Signup submitted; waiting on the email verification listener (ACT-006). */
  AWAITING_VERIFICATION: "awaiting_verification",
  /**
   * An account gate exists but could not be filled safely — e.g. the signup
   * lives behind an SSO-only button, or the fields could not be identified
   * unambiguously. Needs a human; we do not guess-click on a real employer's
   * site. `error_message` carries the detail.
   */
  ACCOUNT_GATE_BLOCKED: "account_gate_blocked",
  /** Unrecoverable failure. `error_message` carries the detail. */
  ERROR: "error",

  // ── written by ACT-007 (`fill-application-form.ts`) ────────────────────────

  /**
   * The emailed verification ACT-006 detected has actually been completed — the
   * link was opened, or the code was entered — and the board accepted it.
   *
   * ACT-006 only *reports* the mail; nobody clicked anything. ACT-007 is what
   * completes it, and it records the fact here immediately, before it touches
   * the application form, because verification links and codes are single-use:
   * a crash between "verified" and "filled" must not send a retry back to a
   * link the board has already burned.
   */
  EMAIL_VERIFIED: "email_verified",
  /** Form-fill browser work in flight. Mirrors `creating_account`. */
  FILLING_FORM: "filling_form",
  /**
   * ACT-007's terminal success, and ACT-008's pickup signal: the application
   * form carries the candidate's data and has **not** been submitted.
   */
  FORM_FILLED: "form_filled",
  /**
   * The form could not be filled safely — an unreachable form, a captcha, a
   * required cover letter with nowhere to type it, a field whose identity could
   * not be corroborated. Nothing was submitted. Needs a human.
   * `error_message` carries the detail. Mirrors `account_gate_blocked`.
   */
  FORM_FILL_BLOCKED: "form_fill_blocked",

  // ── written by ACT-008 (`submit-application.ts`) ───────────────────────────
  //
  // On the naming: ACT-008's brief says "on failure, set status to `failed`".
  // These three values implement that requirement without adding a `failed`
  // synonym for the `error` above, because a single "failed" would collapse the
  // one distinction that matters most in this pipeline — whether the submit
  // button was pressed. `error` already means "a failure a retry might genuinely
  // fix" everywhere else here, and after a real submit a retry is precisely the
  // forbidden action, so the post-click case needs a value of its own that no
  // retry path will ever match.

  /**
   * The application was really submitted to the employer. Terminal, and the one
   * status in this table that can never be undone — `confirmation_ref` carries
   * whatever the board showed back (a reference number, the confirmation
   * wording, or "email confirmation incoming").
   *
   * Deliberately absent from ACT-007's `READY_STATUSES`, which is what stops a
   * second submission attempt against the same row before a browser is opened.
   */
  SUBMITTED: "submitted",
  /**
   * ACT-008 stopped **before** clicking anything — no control on the filled form
   * could be identified as *the* application submit, the candidates were
   * ambiguous, or a review gate declined. Nothing was sent; the form is still
   * sitting filled in a now-closed browser. `error_message` carries the detail.
   * Mirrors `form_fill_blocked`, and is safe to re-run from for the same reason.
   */
  SUBMISSION_BLOCKED: "submission_blocked",
  /**
   * The submit control **was clicked** and the result could not be confirmed —
   * the session died mid-click, the page could not be read afterwards, or the
   * board still shows the form. Whether a real application now exists at the
   * employer is unknown.
   *
   * This is not `error` on purpose. Never retry a row in this state
   * automatically: a human has to check the employer's side (and the inbox from
   * ACT-006) for an application that may already be there. `error_message`
   * carries the detail.
   */
  SUBMISSION_UNCONFIRMED: "submission_unconfirmed",
} as const;

export type ApplicationStatus =
  (typeof APPLICATION_STATUS)[keyof typeof APPLICATION_STATUS];
