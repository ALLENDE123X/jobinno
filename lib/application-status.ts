/**
 * `applications.status`: the whole pipeline's status vocabulary.
 *
 * ── JOB-004 ─────────────────────────────────────────────────────────────────
 * The table is `applications` now, not actinno's `job_applications`, and the
 * column is still free text for the reason `lib/db/schema.ts` gives in its
 * header: a status column that rejects a value a running pipeline wants to
 * write fails in the worst possible place, halfway through a real application.
 *
 * One value was added, `discovered`, and nothing was removed. See the note on
 * it below, and see `lib/application-records.ts` for where the *reasons* behind
 * the blocked statuses now live, which is the part of actinno's model that did
 * change.
 *
 * ── Provenance (JOB-001) ────────────────────────────────────────────────────
 * Lifted verbatim from actinno's `lib/create-board-account.ts`, which is the
 * one module in that repo Jobinno deliberately did NOT port: automated account
 * creation on an employer's board is a V2 question, not a V1 one.
 *
 * The enum could not stay there, because it was never really account creation
 * code. Four ported modules read it: `fill-application-form.ts`,
 * `submit-application.ts`, `future-gmail/gmail-verification-listener.ts` and
 * `inngest/job-application-pipeline.ts`, and its own docstring below already
 * admits it had "outgrown" its host file. So it moves to a module whose only
 * job is to hold it, and the four importers point here instead. The values and
 * their comments are unchanged; only the import path moved.
 *
 * The `creating_account` / `awaiting_verification` / `account_gate_blocked`
 * values describe a flow Jobinno does not run yet. They are kept rather than
 * pruned because `gmail-verification-listener.ts` and the pipeline still
 * reference them, and because a status column that quietly loses values is how
 * historical rows stop meaning anything. The ticket that removes the account
 * creation step owns deciding their fate.
 */

/**
 * `applications.status` values this module writes. The column is free text
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
  /**
   * The row exists and nothing has been attempted against it yet.
   *
   * Added by JOB-004, and it is a correction rather than a new idea: this has
   * been the column's default in `lib/db/schema.ts` since JOB-002, and the
   * docstring above has named it since the port. It was simply missing from the
   * table, so the one status every row starts life in could not be referred to
   * in code. `claimApplicationRow` writes it, and ACT-007's `READY_STATUSES`
   * accepts it, which is what makes a freshly claimed row fillable.
   */
  DISCOVERED: "discovered",
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
   * status in this table that can never be undone — `confirmation_text` carries
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
   * The fill step hit a required question the profile, the stored answers and
   * the canonical defaults could not honestly answer, and rather than block the
   * whole pipeline waiting for a person we parked the row and asked them. The
   * questions live on `applications.escalation_questions`, the ask went out
   * over the notifier v1-C wires, and the dashboard queue view (v1-D) is where
   * the person answers.
   *
   * A row in this state must not be picked up by the discovery worker: it is
   * waiting for an answer, not for another retry. Once the user posts their
   * answers the resume path clears `escalation_questions`, writes the answers
   * back to `profiles.stored_answers` keyed by intent, and flips the status
   * back to `discovered` so the next tick fills the form afresh.
   */
  PENDING_USER_INPUT: "pending_user_input",
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

/**
 * The statuses that count against a person's `applications_cap`, as read by
 * `claimApplicationRow`'s live-count guard (JOB-v1-A).
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A row counts if a real attempt was made against the employer, whether or not
 * the attempt succeeded. That covers the four terminal outcomes a real click on
 * the application flow can produce:
 *
 *   · `submitted` and `submission_unconfirmed` — the submit control was pressed,
 *     and by HARD STOP #2 both are terminal and neither can be re-run.
 *   · `form_fill_blocked` — the form was reached, and something the pipeline
 *     could not answer on the person's behalf stopped it (captcha, an
 *     unanswerable required field, a resume upload that would not attach).
 *     The candidate spent our LLM time and the employer's server time.
 *   · `submission_blocked` — the form was filled, and no control on it could be
 *     identified as *the* application submit. Same accounting as above.
 *   · `account_gate_blocked` — a sign in wall existed and could not be answered
 *     safely. The pipeline touched the board with a real intent to apply.
 *
 * Deliberately absent:
 *
 *   · `discovered` — queued and never attempted. A person with 200 discovered
 *     rows has consumed nothing but a queue slot, and refusing them at claim
 *     over rows nothing was ever tried against would be its own bug.
 *   · `error` — the pipeline stopped for an internal reason of its own. Nothing
 *     was really tried at the employer, and the fix is a retry, not a charge.
 *   · Everything in `IN_FLIGHT_STATUSES` — a run that is mid stream may still
 *     become one of the terminal outcomes above, and it is that transition that
 *     writes the count, not the transient state it is passing through.
 *
 * `captcha_blocked` is not in this list because it is not a status: a captcha
 * lands in the database as `form_fill_blocked` with the reason `captcha` in the
 * paired `skip_log` row. Adding `form_fill_blocked` here counts every captcha
 * stop; adding a separate `captcha_blocked` value would need a status vocabulary
 * change nothing else is asking for.
 */
export const CAP_CONSUMING_STATUSES: readonly ApplicationStatus[] = [
  APPLICATION_STATUS.SUBMITTED,
  APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
  APPLICATION_STATUS.FORM_FILL_BLOCKED,
  APPLICATION_STATUS.SUBMISSION_BLOCKED,
  APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED,
];
