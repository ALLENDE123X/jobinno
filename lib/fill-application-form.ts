/**
 * ACT-007 — filling a job application form from the candidate's resume, and
 * stopping dead before it is submitted.
 *
 * Given nothing but an `applications` row id, this opens its own browser,
 * gets itself to the application form (completing the emailed verification and
 * signing in on the way, when the row needs that), types the candidate's data
 * into the fields it can positively identify, attaches the resume PDF, and
 * leaves the form sitting there filled. **It never submits.** Submission is
 * ACT-008; the handoff is `applications.status = "form_filled"`.
 *
 * ── The untrusted-text boundary ─────────────────────────────────────────────
 * Resume text, job-description text and application-question text are all
 * treated as hostile — the resume most of all, since a candidate's own resume
 * PDF was found earlier in this project's history to carry an embedded prompt
 * injection. The design puts a structural wall between "text we read" and
 * "things we can do", in three layers:
 *
 *  1. **Untrusted text never enters this module.** Parsing and cover-letter
 *     writing happen in `resume-parser.ts`, which has no browser and no tools —
 *     see its header. What crosses back is a `ResumeProfile` of validated,
 *     length-capped, structurally-checked strings.
 *
 *  2. **Every instruction an action-capable model reads is a compile-time
 *     constant.** All of them live in `INSTRUCTIONS` below. Nothing from the
 *     page, the resume, the job description or a question label is ever
 *     concatenated into one. `create-board-account.ts` still builds one act()
 *     instruction from a page-derived label; this module builds none.
 *
 *  3. **Values are arguments, never instructions.** Every write to the page is
 *     `typeInto()` (a structured `Action` whose `arguments` carry the value,
 *     which Stagehand executes without any inference at all — see that
 *     function's comment) or `locator.setInputFiles()` (no model in the path at
 *     all). A resume-derived string is never part of a prompt.
 *
 * Two things then check the result rather than trusting it: `describeControl()`
 * reads the target element's own name/id/label out of the DOM and refuses to
 * type into a control that does not describe itself as the field we meant, and
 * every filled field is read back out of the browser afterwards.
 *
 * ── ACT-015: unlimited field coverage, and better injection properties ──────
 * Layer 2 above had a cost nobody priced: a field nobody enumerated in advance
 * was structurally invisible. `INSTRUCTIONS` names first name, last name, email,
 * phone, LinkedIn, website, resume and cover letter, so a real Discord
 * Greenhouse form came back with a required country dropdown, a required essay,
 * three required work-authorization questions and four required EEO selects all
 * blank — a form the board's own validation would reject. That is a static
 * script with a model in the loop, not something that adapts to the form it
 * lands on.
 *
 * Dynamism and containment were never in tension; they had just been fused. The
 * field layer is now three separate things:
 *
 *  · **Perception** — `enumerateFormFields()` in `form-fields.ts` reads the DOM
 *    and reports *every* control: label, kind, required flag, current value, and
 *    the real option strings behind a dropdown. No model at all. Reading a page
 *    was never the dangerous part.
 *
 *  · **Decision** — `decideFieldAnswers()` in `resume-parser.ts`, one call with
 *    **no tools attached**, guarded by the same `assertNoActionSurface()` the
 *    resume parse and the cover letter already use. Untrusted form labels reach
 *    it, and the worst they can achieve is a wrong *string* in a JSON field,
 *    because the thing holding them cannot click, navigate, upload or submit.
 *
 *  · **Action** — `applyFieldValue()` in `form-fields.ts`, no model, no
 *    natural-language instruction: a `fill`, a `selectOption` or a `click` on an
 *    element addressed by a selector the perception pass computed. In particular
 *    no page-derived label is ever concatenated into an instruction, which is
 *    the residual risk earlier reviews flagged in ACT-005's apply-click; this
 *    layer does not reintroduce it.
 *
 * The net effect is strictly better than before: every value that reaches the
 * page must be either an option the DOM itself offers or a candidate fact this
 * system already validated, and `INSTRUCTIONS` is still the complete list of
 * sentences any action-capable model sees.
 *
 * ── The answering policy ────────────────────────────────────────────────────
 * These are legally meaningful statements made to a real employer under a real
 * person's name, so every field is categorised (`resolveDecision` below):
 *
 *  · **Answered from stored data** — work authorization, sponsorship, country,
 *    city, relocation — from the `profiles` columns ACT-015 named, collected
 *    once at intake. A value must trace to a named fact in a closed catalogue.
 *  · **Generated** — free-text essay questions ("Why do you want to work at
 *    Discord?"), which are a cover letter under another name and go through the
 *    same generator, fed the *validated profile*, never raw resume text.
 *  · **Declined** — every EEO/demographic question, always, by selecting its
 *    "decline to self-identify" option. Declining is truthful; inventing a
 *    demographic identity for a real person is not, and cannot happen here: the
 *    rule is a regex on the field's own label applied in TypeScript, not an
 *    instruction the model is trusted to follow.
 *  · **Never guessed** — anything factual with no backing data stops and asks.
 *    A model asserting "yes, authorized to work in the US" on someone's behalf
 *    is a material misrepresentation, and this is the single rule the rest of
 *    the design exists to make mechanical.
 *
 * When a required field cannot be answered truthfully the run does not guess and
 * does not silently skip: it returns `needsInput`, a structured list of what it
 * still needs, alongside everything it did fill. The caller asks the user, then
 * re-invokes with `additionalAnswers` and it finishes. The *resume* half of that
 * loop is still stateless: no session handle, no pending-question record, and
 * the keys are derived from the form's own labels so the second run recomputes
 * them identically.
 *
 * JOB-134 changed one thing about it, and only one. The answer itself is now
 * kept, on `profiles.stored_answers`, so that the next employer asking the same
 * question does not stop the next application. Everything a stored answer then
 * has to get past to reach a form is what it always was — `matchAdditionalAnswer`
 * still has to find it, `resolveAdditionalAnswer` still refuses to let it decide
 * a demographic or consent field, the attestation ladder still decides which
 * facts may back which questions, and the value is still read back out of the
 * control afterwards. Nothing downstream can tell a stored answer from one that
 * arrived a second ago, which is the property that made this safe to add.
 *
 * ── Why this is one self-contained, re-entrant call ─────────────────────────
 * Inngest steps are independently retried and resumed, and a Playwright/Stagehand
 * page handle is not serialisable, so a browser cannot be carried from ACT-005's
 * step into this one. Everything this needs is therefore re-read from the row:
 * apply URL, board password, account-gate verdict, candidate. Verification and
 * form-fill are one call for the same reason in reverse — they must share a
 * cookie jar, so they cannot be two steps.
 *
 * ── What ACT-008 added, and why it is here rather than there ────────────────
 * That same reasoning applies once more between this module and submission: a
 * filled form only exists inside a live browser, so ACT-008 cannot pick up where
 * this leaves off unless the browser is still open. `fillApplicationForm()` on
 * its own always closes it — that is unchanged, and every existing caller keeps
 * exactly the behaviour it had. `fillApplicationFormRetainingSession()` is the
 * one door for `submit-application.ts` (ACT-008): identical flow, and on the
 * clean `form_filled` path only, the live `BrowserSession` is handed back for
 * the caller to close. The alternative was for ACT-008 to re-derive "which
 * control opens the form / which box is the email field / which button really
 * submits" against a real employer's site a second time, which is both a second
 * copy of every guard in this file and a second set of clicks on a live board.
 *
 * Three other things here are exported for ACT-008 rather than copied: the
 * `APPLICATION_CONTROL_RE` / `SUBMIT_WORD_RE` pair (ACT-008 requires exactly the
 * predicate this module refuses on — see `assertNotAnApplicationSubmit`),
 * `describeControl` (the DOM-truth read), and `ControlDescriptor.text`/`.role`,
 * which were added for it. **This module's own behaviour is unchanged by all of
 * it**: `corroborate()` still reads only `tag`, `type` and `haystack`, and
 * nothing here clicks anything that submits an application.
 *
 * ── JOB-021: nothing is read until it is there ─────────────────────────────
 * Every read of the page now settles first. `readFormSignals` waits for content
 * to attach and for the DOM to stop growing before it asks a model what is on
 * screen, and `reachApplicationForm` reads a freshly opened listing a second and
 * third time when the first read found nothing at all.
 *
 * This was not a precaution. The first production run against real Ashby-hosted
 * career pages failed 16 of 21 applications, across eight unrelated companies,
 * inside four minutes, with one shared message: the form was not on screen. The
 * pages had loaded — the failures quote hundreds to thousands of characters of
 * text and two file inputs apiece — but `page.goto` returns at
 * `domcontentloaded` in this SDK, and a client hydrated careers page is still a
 * shell at that point. See `settleBeforeReading` for why Stagehand's own
 * `domSettleTimeoutMs` does not cover this: it reaches `act()` and nothing else,
 * so clicks were settled and navigations never were.
 *
 * Targets Jobinno's own Supabase project, guarded by the shared
 * `assertSupabaseProject()` check every module here imports.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { type Page } from "@browserbasehq/stagehand";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_STATUS, type ApplicationStatus } from "@/lib/application-status";
// JOB-117. JOB-106's rule for "this page is another step of the same
// application", shared with `submit-application.ts` rather than restated here.
import { pageReadsAsFurtherStep } from "@/lib/application-wizard";
import { checkApplyUrl, forLog } from "@/lib/apply-url-guard";
// Single source of truth for "which domains may speak for this board". ACT-006
// applies it when it decides a link is safe to *report*; this module applies it
// again before it is safe to *open*. Importing it costs a googleapis module load
// this module does not otherwise need — worth it, because two copies of an
// allowlist drift, and a drifted allowlist here means either a dead link or an
// opened one that should not have been.
import { allowedSenderDomains } from "@/lib/future-gmail/gmail-verification-listener";
import {
  closeBrowserSession,
  openBrowserSession,
  reResolveLive,
  resolveBrowserbaseContextId,
  samePage,
  sleep,
  tryResolveAction,
  typeInto,
  NAVIGATION_TIMEOUT_MS,
  type BrowserSession,
  type CachedAction,
  type ResolvedAction,
} from "@/lib/stagehand-session";
import {
  classifyCoreSlot,
  detectAts,
  fingerprintFormShape,
  loadActionPlan,
  saveActionPlan,
  type CoreSlot,
} from "@/lib/form-action-cache";
import { resolveCandidateProfile } from "@/lib/candidate-documents";
import {
  decideFieldAnswers,
  generateCoverLetter,
  generateEssayAnswer,
  loadResume,
  InjectionSuspectedError,
  type CandidateFact,
  type CandidateRecord,
  type DecidableField,
  type DocumentSource,
  type FieldDecision,
  type ResumeProfile,
} from "@/lib/resume-parser";
import {
  applyFieldValue,
  enumerateFormFields,
  enumerateRepeatingSections,
  findDeclineOption,
  pressAddEntry,
  pressCommitEntry,
  sectionStillUnsatisfied,
  DECLINE_OPTION_RE,
  harvestOptions,
  inPageError,
  inPageExpression,
  normalizeText,
  readFieldValue,
  CONSENT_FIELD_RE,
  EEO_FIELD_RE,
  type EnumeratedField,
  type FormFieldKind,
} from "@/lib/form-fields";
import { loadCandidate, type CandidateApplicationAnswers } from "@/lib/candidate-intake";
import { classifyIntent } from "@/lib/canonical-topics";
// JOB-134. The candidate's own answers to questions intake never asked, kept
// against their profile instead of living for one invocation. This module owns
// no policy from that file and that file owns none from this one: it decides
// which stored answers are the same answer, and everything about whether an
// answer may go on a form is still decided here.
import {
  rememberAnswers,
  sameStoredAnswers,
  withStoredAnswers,
  answerProvenanceEntry,
  resolveAnswer,
  type AnswerProvenanceEntry,
  type StoredAnswer,
} from "@/lib/candidate-answers";
// JOB-004. Both copies of `updateApplication` and `recordFailure` that the port
// carried are gone; this module and `submit-application.ts` share one now. See
// that file's header for why a failure is two writes here and was one there.
import {
  recordFailure,
  updateApplication,
  writeEscalation,
  type EscalationQuestion,
} from "@/lib/application-records";
import { sendEscalationNotification } from "@/lib/notifier";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";

const LOG = "[act-007]";

/**
 * ── JOB-170: the escalation gate ────────────────────────────────────────────
 *
 * False since the Option A product decision of 2026-08-26: the pipeline
 * fabricates an answer for a field the rest of the ladder cannot fill (see
 * `lib/candidate-answers.ts`, JOB-170's fabrication rung) instead of stopping
 * the row at `pending_user_input`. The whole escalation machinery below,
 * `writeEscalation`, `handleEscalationBlock`, `isEscalationBlock`, the queue
 * reader and the escalation-answers route, stays wired exactly as v1-C built
 * it, because two residual cases still need it:
 *
 *  · A required EEO question offering no decline option. Demographic answers
 *    are never fabricated and never defaulted (HARD STOP #10), so that stop
 *    is the only honest outcome.
 *  · Repeating section entries, where the alternative to asking is inventing
 *    an employer or a school, which HARD STOP #9 forbids.
 *
 * Flipping this back to true restores v1-C behaviour with zero other edits,
 * which is the whole point of a constant rather than a deletion.
 */
export const ESCALATION_ENABLED = false;

// ───────────────────────────────────
// The instructions — every one a constant
// ───────────────────────────────────

/**
 * The complete set of natural-language strings this module ever hands a model.
 *
 * Frozen and gathered in one place on purpose: this object is the audit surface
 * for the rule that no untrusted text reaches an action-capable call. If a
 * string is not in here, no model in this flow sees it as an instruction; if it
 * is in here, it was written by a human and committed to git.
 *
 * There is deliberately **no entry for a control that submits the application.**
 * That is not an oversight to be helpfully filled in later — it is the reason
 * this module cannot submit even if every other guard were removed.
 */
const INSTRUCTIONS = Object.freeze({
  APPLY_START:
    "the button or link that opens this listing's job application form, labelled something " +
    "like \"Apply\", \"Apply Now\", \"Apply for this job\" or \"I'm Interested\" " +
    "(SmartRecruiters' own wording for the same control)",
  SIGN_IN_EMAIL: "the email or username input on the sign-in form",
  SIGN_IN_PASSWORD: "the password input on the sign-in form",
  SIGN_IN_SUBMIT: "the button that signs in to an existing account on the sign-in form",
  VERIFICATION_CODE:
    "the input where the applicant types the verification or confirmation code that was " +
    "emailed to them",
  VERIFICATION_SUBMIT: "the button that confirms the emailed verification code",
  FIRST_NAME: "the First Name input on the job application form",
  LAST_NAME: "the Last Name input on the job application form",
  FULL_NAME: "the single Full Name input on the job application form",
  EMAIL: "the email address input on the job application form",
  PHONE: "the phone number input on the job application form",
  LINKEDIN: "the LinkedIn profile URL input on the job application form",
  WEBSITE: "the personal website or portfolio URL input on the job application form",
  CONFIRM_EMAIL:
    "the SECOND email input on the job application form — the one labeled \"Confirm email\", " +
    "\"Confirm your email\", \"Re-enter email\", \"Repeat email\", or similar. " +
    "NOT the primary email address field.",
  RESUME_UPLOAD: "the file upload control for the applicant's resume or CV",
  COVER_LETTER_TEXT:
    "the multi-line text box where the applicant types or pastes their cover letter",
  COVER_LETTER_MANUAL:
    "the control that switches the cover letter from a file upload to typing the text in " +
    "directly, labelled something like \"Enter manually\", \"Type\", \"Write\" or \"Paste\"",
  /**
   * JOB-117. The control that moves a multi step form on to its next step.
   *
   * ── Why this says neither "application" nor "submit" ────────────────────────
   * It used to. The first version read "the button that moves this job
   * application on to its next step **without submitting it**", which is an
   * accurate description of what is wanted and was exactly the wrong thing to
   * write. `observe()` answers an instruction largely in the instruction's own
   * vocabulary, so against the real Avery Dennison form it came back with "Next
   * button that advances the job **application** to the next step without
   * **submitting** it" — and that string is what `assertNotAnApplicationSubmit`
   * is handed. That guard matches `APPLICATION_CONTROL_RE` and `SUBMIT_WORD_RE`
   * independently and has no notion of negation, so a description whose only
   * submit word sits inside "without submitting it" trips it exactly as hard as
   * a real Submit button would. The run stopped with `form_fill_blocked` on a
   * correctly filled form.
   *
   * The fix is here rather than in the guard, and that direction matters. The
   * guard is right: a control describing itself as submitting an application
   * must never be pressed by this module, and teaching it to read "without" is
   * teaching it to be talked out of refusing. What was wrong was feeding it a
   * description this module's own phrasing had poisoned. So this names a *form*
   * and a *step* and never mentions an application or a submission, the observed
   * description comes back in those terms, and the guard keeps every bit of its
   * strength for the case it exists for — a board whose advance control really
   * does submit, and says so.
   *
   * Contrast issue #91's `WIZARD_ADVANCE` in `submit-application.ts`, which
   * tells a model to "click Next, Continue, Review, **Submit**, or whatever
   * control makes sense". That one names Submit as an acceptable answer. This
   * one cannot: it only ever reaches a page through `clickControl`, and
   * `NEXT_STEP_ACCEPT_RE` has to agree independently that what came back reads
   * as a next-step control.
   */
  NEXT_STEP:
    "the button that moves this multi step form on to its next step, labelled something like " +
    "\"Next\", \"Continue\", \"Next step\" or \"Save and continue\"",
} as const);

/**
 * JOB-006. The instructions the shared form action cache is allowed to answer,
 * and which boilerplate slot each one is asking about.
 *
 * The list is short because it is an allowlist rather than an exclusion list,
 * and the two groups it deliberately leaves out are the point.
 *
 *  · **Every click is missing.** `APPLY_START`, `SIGN_IN_SUBMIT`,
 *    `VERIFICATION_SUBMIT` and `COVER_LETTER_MANUAL` all go through
 *    `clickControl`, which decides whether a control is safe to press by testing
 *    what `observe()` freshly said about it against `SUBMIT_WORD_RE`. A replayed
 *    action carries this module's own constant as its description, so serving
 *    that path from a cache would turn a real guard into a test of a string we
 *    wrote against itself. These stay live on every run. There are only one to
 *    three of them, and they are the calls where being wrong means pressing
 *    something that submits a real person's application.
 *
 *  · **The two password fields are missing.** Nothing about a sign in form is
 *    worth sharing between users, and the shape this cache keys on is the
 *    application form rather than the wall in front of it.
 *
 * The slot each instruction maps to has to agree with what
 * `classifyCoreSlot()` makes of the same field's label, because a cached
 * absence is only honoured when the live form's slot set agrees that the field
 * is not there. `tests/unit/form-action-cache.test.ts` pins both directions.
 */
const CACHEABLE_INSTRUCTIONS: ReadonlyMap<string, CoreSlot> = new Map<string, CoreSlot>([
  [INSTRUCTIONS.FIRST_NAME, "firstName"],
  [INSTRUCTIONS.LAST_NAME, "lastName"],
  [INSTRUCTIONS.FULL_NAME, "fullName"],
  [INSTRUCTIONS.EMAIL, "email"],
  [INSTRUCTIONS.PHONE, "phone"],
  [INSTRUCTIONS.LINKEDIN, "linkedin"],
  [INSTRUCTIONS.WEBSITE, "website"],
  [INSTRUCTIONS.RESUME_UPLOAD, "resume"],
  [INSTRUCTIONS.COVER_LETTER_TEXT, "coverLetter"],
]);

/** Exported for the test that pins it against `classifyCoreSlot`. */
export const CACHEABLE_INSTRUCTION_SLOTS = CACHEABLE_INSTRUCTIONS;

/**
 * Whether the page is showing this file name anywhere a person could read it,
 * shadow roots included.
 *
 * The second, independent confirmation that a resume actually attached, and it
 * exists because the first one stopped being sufficient. `attachedFiles` reads
 * `input.files.length`, which is the right question for a plain `<input
 * type="file">` and the wrong one for a component that reads the File, uploads
 * it itself and resets the input — SmartRecruiters does exactly that, then
 * renders a chip with the file name and a delete button beside it. Its input
 * honestly reports zero files while the applicant is plainly looking at their
 * attached resume.
 *
 * This is deliberately positive evidence and not a relaxation: the board has to
 * be showing the exact file name that was just uploaded. "The input says zero"
 * still fails the attachment when nothing on the page says otherwise.
 */
function pageShowsFileNameInPage(needle: string): boolean {
  const wanted = needle.replace(/\s+/g, " ").trim().toLowerCase();
  if (wanted === "") return false;

  const seen = new Set<Document | ShadowRoot>();
  const stack: (Document | ShadowRoot)[] = [document];
  let budget = 6000;
  while (stack.length > 0 && budget > 0) {
    const root = stack.pop();
    if (root === undefined || seen.has(root)) continue;
    seen.add(root);
    let all: Element[];
    try {
      all = Array.from(root.querySelectorAll("*"));
    } catch {
      continue;
    }
    for (const element of all) {
      if (budget-- <= 0) break;
      const inner = (element as HTMLElement).shadowRoot;
      if (inner !== null && inner !== undefined) stack.push(inner);
      if (element.children.length > 0) continue;
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      if (text === "" || !text.includes(wanted)) continue;
      // Painted, not merely present. A hidden template holding the name is not
      // the board acknowledging the upload.
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return true;
      const parent = element.parentElement;
      if (parent !== null) {
        const parentBox = parent.getBoundingClientRect();
        if (parentBox.width > 0 && parentBox.height > 0) return true;
      }
    }
  }
  return false;
}

/** `pageShowsFileNameInPage`, run in the page. Never throws; unreadable means no. */
async function pageShowsFileName(page: Page, fileName: string): Promise<boolean> {
  try {
    const raw = await page.evaluate(
      inPageExpression(pageShowsFileNameInPage, jsExpression(fileName))
    );
    if (inPageError(raw) !== null) return false;
    return raw === true;
  } catch {
    return false;
  }
}

// ───────────────────────────────────
// Reading the page
// ───────────────────────────────────

const FORM_EXTRACT_INSTRUCTION =
  "You are looking at a job application page. Report which of the listed controls are " +
  "actually rendered and visible to an applicant right now. Judge every field from what a " +
  "sighted visitor reads — its visible label or the text beside it — not from its HTML " +
  "attributes; some boards render an email box as a plain text input with a generated id " +
  "and no name. Ignore hidden, disabled, off-screen and not-yet-opened elements.";

const FormSignalsSchema = z.object({
  applicationFormPresent: z
    .boolean()
    .describe(
      "True if the job APPLICATION form itself is on screen — the form asking the applicant " +
        "for their name, contact details and/or resume. False for a page that only describes " +
        "the job, only offers to sign in, or only offers to create an account."
    ),
  applyControlPresent: z
    .boolean()
    .describe(
      "True if there is a visible button or link that would open the application form, " +
        "labelled something like \"Apply\", \"Apply Now\", \"Apply for this job\" or " +
        "\"I'm Interested\" (SmartRecruiters' own wording for the same control). False if " +
        "the only apply-ish control submits an application that is already filled in."
    ),
  signInFormPresent: z
    .boolean()
    .describe(
      "True if a sign-in / log-in form for an existing account is on screen (an email or " +
        "username box together with a password box)."
    ),
  verificationCodeFieldPresent: z
    .boolean()
    .describe(
      "True if there is a visible input asking for a verification, confirmation or one-time " +
        "code that was emailed to the applicant."
    ),
  firstNameFieldPresent: z.boolean().describe("True if a First Name / Given Name input is visible."),
  lastNameFieldPresent: z
    .boolean()
    .describe("True if a Last Name / Surname / Family Name input is visible."),
  fullNameFieldPresent: z
    .boolean()
    .describe(
      "True if the form asks for the whole name in ONE input (labelled 'Name' or 'Full name') " +
        "rather than separate first and last name inputs."
    ),
  emailFieldPresent: z
    .boolean()
    .describe("True if the application form has a visible input for the applicant's email address."),
  phoneFieldPresent: z.boolean().describe("True if a phone / mobile number input is visible."),
  linkedinFieldPresent: z
    .boolean()
    .describe("True if there is a visible input specifically for a LinkedIn profile URL."),
  websiteFieldPresent: z
    .boolean()
    .describe(
      "True if there is a visible input for a personal website, portfolio or GitHub URL. Do " +
        "NOT count the LinkedIn field again here."
    ),
  resumeUploadPresent: z
    .boolean()
    .describe(
      "True if there is a visible control for uploading the applicant's resume or CV — a file " +
        "input, an 'Attach' / 'Upload resume' button, or a drag-and-drop zone."
    ),
  coverLetterTextAreaPresent: z
    .boolean()
    .describe(
      "True if there is a visible MULTI-LINE text box for typing the cover letter directly. " +
        "False if the cover letter can only be uploaded as a file."
    ),
  coverLetterUploadPresent: z
    .boolean()
    .describe("True if there is a visible control for uploading a cover letter FILE."),
  coverLetterManualEntryControlPresent: z
    .boolean()
    .describe(
      "True if there is a visible control that switches the cover letter from file upload to " +
        "typing it in — labelled something like 'Enter manually', 'Type', 'Write' or 'Paste'."
    ),
  passwordFieldCount: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of password inputs actually rendered and visible. Do not count hidden, " +
        "off-screen or collapsed fields."
    ),
  fileInputCount: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of visible controls that upload a FILE from the applicant's computer, including " +
        "drag-and-drop zones. Do not count a link to a document."
    ),
  submitApplicationControlLabels: z
    .array(z.string())
    .describe(
      "The visible label of every control that would SUBMIT the application (e.g. \"Submit " +
        "Application\", \"Send Application\"). Copy the wording exactly. This is recorded for a " +
        "later step; nothing here will be clicked."
    ),
  captchaPresent: z
    .boolean()
    .describe(
      "True ONLY if the page shows an interactive anti-bot CHALLENGE the visitor would have to " +
        "solve — a reCAPTCHA checkbox, an image grid, an hCaptcha or Turnstile widget, a slider " +
        "puzzle, or a 'Checking your browser' interstitial. FALSE for the passive 'This site is " +
        "protected by reCAPTCHA…' footnote or any other badge that asks nothing of the visitor."
    ),
  captchaEvidence: z
    .string()
    .describe("If captchaPresent is true, what was seen and where, in one short sentence. Empty otherwise."),
  applicationLikelySubmitted: z
    .boolean()
    .describe(
      "True if this page reads as a POST-SUBMISSION confirmation — a \"thank you\", " +
        "\"application received\", \"we'll be in touch\" message, or similar — rather than a job " +
        "posting, an application form, or a sign-in/verification page. This is the positive check " +
        "for the case where clicking an \"Apply\"/\"Apply Now\" control turned out to submit the " +
        "application immediately instead of opening a form to fill in."
    ),
  applicationLikelySubmittedEvidence: z
    .string()
    .describe(
      "If applicationLikelySubmitted is true, the exact confirmation wording seen, in one short " +
        "sentence. Empty otherwise."
    ),
});

type ExtractedFormSignals = z.infer<typeof FormSignalsSchema>;

export type FormSignals = ExtractedFormSignals & {
  url: string;
  title: string;
  textLength: number;
  textAreaCount: number;
  iframeCount: number;
  /**
   * `document.querySelectorAll('input[type=file]').length` — the DOM's own
   * count, kept separately from the merged `fileInputCount`. The merged number
   * can be raised by the reader spotting a drag-and-drop zone, which is a file
   * input wearing a costume and cannot be addressed as `input[type=file]`; the
   * deterministic upload path needs the un-merged truth.
   */
  domFileInputCount: number;
  /**
   * Which of the boilerplate applicant fields the DOM itself can see, read by
   * `enumerateFormFields` (shadow roots included) and named by
   * `classifyCoreSlot`. Reported so the failure message can say what was on the
   * page rather than only what a model made of it.
   */
  domCoreSlots: CoreSlot[];
};

/**
 * The fields that make a page an *applicant's* form rather than any other form.
 *
 * Deliberately not the whole `CoreSlot` set. A resume dropzone appears on a
 * "share your CV with us" marketing page, and a LinkedIn box appears in plenty
 * of profile editors; asking somebody their name and their email address, in
 * two separate controls on one page, is what an application form does.
 */
const APPLICANT_IDENTITY_SLOTS: ReadonlySet<CoreSlot> = new Set<CoreSlot>([
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
]);

/** How many distinct identity fields the DOM must show before it overrules a "no form" read. */
export const MIN_IDENTITY_SLOTS_FOR_FORM = 2;

/**
 * Which of the slots the DOM found are an *applicant's* own fields.
 *
 * Exported for JOB-106, which asks the same question on the far side of the
 * submit click: whether the page a board landed on after the click is still an
 * application form. Kept as one function rather than copied, so that widening
 * `APPLICANT_IDENTITY_SLOTS` cannot silently mean two different things on the
 * two sides of the click.
 */
export function applicantIdentitySlots(slots: readonly CoreSlot[]): CoreSlot[] {
  return slots.filter((slot) => APPLICANT_IDENTITY_SLOTS.has(slot));
}

/**
 * The counts `querySelectorAll` answers exactly and a model answers
 * approximately, read as a floor under the extracted ones — same rule and same
 * reasoning as `create-board-account.ts`'s structural floor: merging with
 * `Math.max` can only ever make this module *more* cautious.
 */
const STRUCTURAL_FLOOR_SCRIPT = `(() => {
  /**
   * JOB-052. The same query, run against the light document and against every
   * open shadow root under it.
   *
   * \`document.querySelectorAll\` stops at a shadow boundary, so on a board whose
   * form is web components this counted nothing at all. A SmartRecruiters
   * oneclick-ui page with ten real controls on screen answered
   * \`ordinaryInputs: 0\`, and \`document.body.innerText\` — which also does not
   * reach into a shadow root — answered 418 characters for a full page of form.
   * Those two numbers are what the "could not reach the form" message quotes and
   * what \`stillBuilding\` watches to decide the page has settled, so both the
   * diagnosis and the wait were being made from a reading of an almost empty
   * document.
   *
   * Bounded, because this is polled: the walk stops after \`LIMIT\` elements and
   * reports what it has. Under-counting is the safe direction for every consumer
   * — a floor that reads low can only make the module more cautious.
   */
  var LIMIT = 12000;
  var seen = 0;
  var counts = {
    passwordFields: 0,
    fileInputs: 0,
    textAreas: 0,
    iframes: 0,
    ordinaryInputs: 0,
    textLength: 0
  };
  var roots = [document];
  var visited = new Set();
  while (roots.length && seen < LIMIT) {
    var root = roots.pop();
    if (!root || visited.has(root)) continue;
    visited.add(root);
    var all;
    try { all = root.querySelectorAll('*'); } catch (e) { continue; }
    for (var i = 0; i < all.length; i++) {
      if (seen++ >= LIMIT) break;
      var el = all[i];
      var inner = el.shadowRoot;
      if (inner) roots.push(inner);
      var tag = el.tagName.toLowerCase();
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && type === 'password') counts.passwordFields++;
      else if (tag === 'input' && type === 'file') counts.fileInputs++;
      else if (tag === 'textarea') counts.textAreas++;
      else if (tag === 'iframe') counts.iframes++;
      else if (tag === 'select') counts.ordinaryInputs++;
      else if (tag === 'input' && type !== 'hidden') counts.ordinaryInputs++;
    }
  }
  // Light DOM innerText first, because it is what a person reads and what this
  // number has always meant; shadow text is added so a component-built page
  // stops reporting itself as almost empty.
  var text = ((document.body && document.body.innerText) || '').trim();
  counts.textLength = text.length;
  // The walk above is bounded, and one of these counts carries a veto: the
  // sign-in stop keys off password fields, so a page big enough to exhaust
  // LIMIT must not be able to hide one by being long. This query is unbounded
  // and cheap, and covers every password field outside a shadow root, which is
  // where essentially all of them are.
  try {
    var lightPasswords = document.querySelectorAll('input[type=password]').length;
    if (lightPasswords > counts.passwordFields) counts.passwordFields = lightPasswords;
  } catch (e) { /* a query that cannot run leaves the walked count standing */ }
  if (visited.size > 1) {
    var extra = 0;
    visited.forEach(function (r) {
      if (r === document) return;
      var host = r.host;
      if (!host) return;
      try {
        var t = (host.innerText || '').trim();
        if (t) extra += t.length;
      } catch (e) { /* a host that cannot be measured contributes nothing */ }
    });
    // Only ever raises it. The settle check compares successive reads, so a
    // number that moves when the form mounts is the whole point.
    if (extra > counts.textLength) counts.textLength = extra;
  }
  return counts;
})()`;

type StructuralFloor = {
  passwordFields: number;
  fileInputs: number;
  textAreas: number;
  iframes: number;
  /**
   * Every other control a person fills in: text, email, tel, date, radio,
   * checkbox and every `select`. Read for JOB-021's settle check only, and
   * deliberately not merged into anything `readFormSignals` reports.
   *
   * It exists because the other four counts are blind to the commonest way an
   * application form arrives. A hydrating Ashby form mounts a column of plain
   * text inputs, and unless it happens to bring a file upload or an iframe with
   * it, none of `passwordFields`, `fileInputs`, `textAreas` or `iframes` moves
   * at all. `textLength` usually does, because labels are text, but a form whose
   * fields carry placeholders rather than visible labels can mount without
   * lengthening `innerText` by a character. That page would have been read as
   * settled after a single poll.
   */
  ordinaryInputs: number;
  textLength: number;
};

async function readStructuralFloor(page: Page): Promise<StructuralFloor> {
  const raw = (await page.evaluate(STRUCTURAL_FLOOR_SCRIPT)) as Partial<StructuralFloor> | null;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    passwordFields: count(raw?.passwordFields),
    fileInputs: count(raw?.fileInputs),
    textAreas: count(raw?.textAreas),
    iframes: count(raw?.iframes),
    ordinaryInputs: count(raw?.ordinaryInputs),
    textLength: count(raw?.textLength),
  };
}

// ───────────────────────────────────
// JOB-021: waiting for the page to exist before reading it
// ───────────────────────────────────

/**
 * What "this page has mounted something" looks like without knowing the board.
 *
 * `attached` rather than `visible` is deliberate, and the reason is the same one
 * `create-board-account.ts` records in the actinno checkout: a selector list
 * resolves to the *first* match in document order, so a hidden first match (a
 * skip link, a collapsed nav button) would leave a visibility wait pending on a
 * page that has in fact rendered. Attachment is the weaker claim, which is the
 * right one here, because this wait is a trigger to stop waiting rather than
 * evidence of anything. The stability check below still has to agree afterwards,
 * so a premature hit costs one DOM read and nothing else.
 */
const HYDRATED_CONTENT_SELECTOR = "main, [role='main'], form, h1, button, a[href]";

/** Budget for that wait. Well inside `NAVIGATION_TIMEOUT_MS`. */
const CONTENT_ATTACH_TIMEOUT_MS = 20_000;

/** Gap between two reads of the DOM's own shape while waiting for it to stop moving. */
const DOM_STABLE_POLL_MS = 500;

/**
 * Random delay between successive field interactions.
 *
 * Breaks the constant-cadence typing pattern that bot detectors key on. The
 * 300–1200 ms window is wide enough to look human without slowing the run to
 * the point where the session timeout becomes a concern.
 */
function randomInteractionDelayMs(): number {
  return Math.floor(Math.random() * 901) + 300; // 300–1200 ms
}

/**
 * Random dwell time on the warm-up page before navigating to the specific job
 * URL. Two to four seconds — enough to register as a human browsing the
 * careers site, not long enough to idle past a Stagehand DOM-settle timeout.
 */
function warmUpDwellMs(): number {
  return Math.floor(Math.random() * 2001) + 2000; // 2000–4000 ms
}

/**
 * Derives a "warm-up" URL from a job application URL by stripping trailing
 * path segments that look like IDs (numeric, UUID) or the literal "apply".
 *
 * Exported for unit testing.
 *
 * Examples:
 *   https://company.workable.com/jobs/123456/apply → https://company.workable.com/jobs
 *   https://boards.greenhouse.io/acme/jobs/12345   → https://boards.greenhouse.io/acme/jobs
 *   https://jobs.lever.co/acme/abc12345-1234-…     → https://jobs.lever.co/acme
 *
 * Returns the original URL unchanged if no strippable suffix is found — the
 * caller checks for sameness and skips the warm-up navigation in that case.
 */
export function deriveWarmUpUrl(applyUrl: string): string {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return applyUrl;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  while (segments.length > 0) {
    const last = segments[segments.length - 1];
    if (
      /^apply$/i.test(last) || // literal "apply" suffix
      /^\d+$/.test(last) || // numeric ID
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last) // UUID v4
    ) {
      segments.pop();
    } else {
      break;
    }
  }
  if (segments.length === 0) return url.origin;
  return `${url.origin}/${segments.join("/")}`;
}

/**
 * How long the page is given to stop changing. Bounded rather than open ended:
 * a board that is still mounting new fields this long after its content attached
 * is not going to be read correctly by waiting longer, and every extra second
 * here is a second of a browser somebody is paying for.
 */
const DOM_STABLE_BUDGET_MS = 8_000;

/**
 * True while the page is still building itself out rather than sitting still.
 *
 * Growth on every measure, never mere difference, and the same rule for all five
 * so there is one definition to remember. A page that is *losing* things has
 * finished arriving: a spinner is removed, a cookie banner is dismissed, a
 * loading skeleton is swapped out. A page that is gaining them has not.
 *
 * Treating any change as movement was the first version of this and it is worse
 * in both directions. It would spend the whole budget on a page whose only sin
 * was closing a banner, and on an advertisement iframe cycling in and out it
 * would never report settled at all, which turns a bounded wait into a fixed
 * eight second tax on every read. Growth cannot oscillate that way.
 *
 * A clock ticking from one timestamp to the next changes the text without
 * lengthening it, which is the other reason this is not an equality test.
 */
function stillBuilding(current: StructuralFloor, next: StructuralFloor): boolean {
  return (
    next.textLength > current.textLength ||
    next.passwordFields > current.passwordFields ||
    next.fileInputs > current.fileInputs ||
    next.textAreas > current.textAreas ||
    next.iframes > current.iframes ||
    next.ordinaryInputs > current.ordinaryInputs
  );
}

/**
 * Gives a client rendered page a bounded chance to actually be there before a
 * model is asked what is on it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `page.goto` in this SDK defaults to `waitUntil: "domcontentloaded"` (verified
 * in `@browserbasehq/stagehand`'s bundled driver,
 * `dist/extension/service-worker.js`, whose `goto` reads
 * `options?.waitUntil ?? "domcontentloaded"` — the package's main entry,
 * `dist/index.mjs`, only forwards options over RPC and has no default of its
 * own), and none of this module's three
 * navigations passes one. On a server rendered board that is fine. On an Ashby
 * or SmartRecruiters careers page it returns while the document is still a
 * shell: the framework has not fetched its data and has mounted nothing, so the
 * application form does not exist yet in any sense a reader could see.
 *
 * The obvious objection is that Stagehand already has a settle step and this
 * session already configures it — `DOM_SETTLE_TIMEOUT_MS` is passed as
 * `domSettleTimeoutMs` in `stagehand-session.ts`. It does not cover this. That
 * setting reaches exactly one place in the SDK, `act()`, which awaits
 * `waitForDomNetworkQuiet` before it does anything. `extract()` and `observe()`
 * take no settle parameter and call no such thing, so every *read* this pipeline
 * makes has always run against whatever the DOM happened to be at that instant.
 * That is why a click is followed by a correct read and a navigation is not.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * Waits for *some* content to attach, then reads the DOM's own shape until two
 * consecutive reads agree that it has stopped growing. Both halves are needed:
 * the selector wait is what covers an empty shell, and the stability check is
 * what covers a shell that mounts its header first and its form a moment later.
 *
 * Neither is allowed to fail the run. A page that never settles is still read,
 * because a read of a slow page is a real answer and a thrown error here would
 * turn a board that renders in nine seconds into a board this product cannot
 * apply to. The callers' own guards decide what an empty page means.
 *
 * Deliberately placed inside `readFormSignals` rather than at the navigations,
 * so that every read is covered by construction — including the ones taken after
 * a click, where it is close to free because `act()` has already settled the
 * page and the first two DOM reads therefore agree.
 */
async function settleBeforeReading(session: BrowserSession): Promise<void> {
  const { page, logTag } = session;

  try {
    await page.waitForSelector(HYDRATED_CONTENT_SELECTOR, {
      state: "attached",
      timeout: CONTENT_ATTACH_TIMEOUT_MS,
    });
  } catch (err) {
    // Not fatal and not even necessarily wrong: the reads below are the actual
    // measurement. Logged because "nothing attached in twenty seconds" is the
    // single most useful line in the transcript when this page turns out to be
    // unreadable.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${logTag} nothing matching "${HYDRATED_CONTENT_SELECTOR}" attached within ` +
        `${CONTENT_ATTACH_TIMEOUT_MS}ms: ${reason}`
    );
  }

  let floor = await readStructuralFloor(page);
  const deadline = Date.now() + DOM_STABLE_BUDGET_MS;
  while (Date.now() < deadline) {
    await sleep(DOM_STABLE_POLL_MS);
    const next = await readStructuralFloor(page);
    if (!stillBuilding(floor, next)) return;
    floor = next;
  }
  console.warn(
    `${logTag} the page was still growing after ${DOM_STABLE_BUDGET_MS}ms ` +
      `(${floor.textLength} characters of text, ${floor.fileInputs} file inputs); reading it anyway`
  );
}

async function readFormSignals(session: BrowserSession): Promise<FormSignals> {
  const { stagehand, page } = session;
  await settleBeforeReading(session);
  const { data: extracted } = await stagehand.extract(
    FORM_EXTRACT_INSTRUCTION,
    FormSignalsSchema,
    { page }
  );
  const floor = await readStructuralFloor(page);
  const [url, title] = await Promise.all([page.url(), page.title()]);

  /**
   * JOB-052. What the DOM itself says is on this page, as a floor under the
   * model's judgement — the same rule as the counts above, extended to the one
   * judgement that decides whether this run gets to start at all.
   *
   * `enumerateFormFields` is reused rather than re-implemented: it is already
   * the module that owns "what controls does this page have", it already walks
   * open shadow roots, and it contains no model. `classifyCoreSlot` is the
   * existing vocabulary for turning a label into a boilerplate field name, so
   * there is one definition of "this is the email box" rather than two.
   *
   * This can only ever *add* evidence. `applicationFormPresent` becomes true
   * when the model missed a form the DOM can prove is there, and stays exactly
   * as the model reported it otherwise — a page where this finds nothing is
   * still refused, with the same message it always had.
   */
  const domCoreSlots = await readCoreSlotsFromDom(page);
  const identitySlots = applicantIdentitySlots(domCoreSlots);
  /**
   * A password anywhere on the page vetoes this, and that is not a detail.
   * `reachApplicationForm` stops at a sign-in wall with
   * `!applicationFormPresent && passwordFieldCount > 0`, so an account-creation
   * page — which has a name box, an email box and a password box — must not be
   * talked into looking like an application form by the first two. The wall is
   * still a wall.
   */
  const domSaysForm =
    floor.passwordFields === 0 &&
    extracted.passwordFieldCount === 0 &&
    identitySlots.length >= MIN_IDENTITY_SLOTS_FOR_FORM;

  if (domSaysForm && !extracted.applicationFormPresent) {
    console.warn(
      `${session.logTag} the page reader saw no application form at "${url}", but the DOM holds ` +
        `${identitySlots.length} of an applicant's own fields (${identitySlots.join(", ")}); ` +
        `treating the form as present on that evidence`
    );
  }

  return {
    ...extracted,
    applicationFormPresent: extracted.applicationFormPresent || domSaysForm,
    passwordFieldCount: Math.max(extracted.passwordFieldCount, floor.passwordFields),
    fileInputCount: Math.max(extracted.fileInputCount, floor.fileInputs),
    url,
    title,
    textLength: floor.textLength,
    textAreaCount: floor.textAreas,
    iframeCount: floor.iframes,
    domFileInputCount: floor.fileInputs,
    domCoreSlots,
  };
}

/**
 * The boilerplate applicant fields the DOM can see, deduplicated.
 *
 * Never throws: `enumerateFormFields` already reports an unreadable page as
 * having no fields, and a floor that cannot be read is simply no floor, leaving
 * the model's judgement exactly as it was.
 */
export async function readCoreSlotsFromDom(page: Page): Promise<CoreSlot[]> {
  try {
    const fields = await enumerateFormFields(page);
    const slots = new Set<CoreSlot>();
    for (const field of fields) {
      // Only a control somebody could actually fill in. A disabled or
      // already-satisfied box is still evidence that this is the form.
      if (field.kind === "other") continue;
      const slot = classifyCoreSlot(field.label);
      if (slot !== null) slots.add(slot);
    }
    return [...slots];
  } catch {
    return [];
  }
}

// ───────────────────────────────────
// Looking at one control with the DOM, not a model
// ───────────────────────────────────

export type ControlDescriptor = {
  found: boolean;
  tag: string;
  type: string;
  /** Name, id, placeholder, aria-label and every label text attached to the control. */
  haystack: string;
  /** Files currently attached, for a file input. `-1` when the element is not one. */
  attachedFiles: number;
  /**
   * The control's own visible text — `textContent` for a `<button>`, the `value`
   * attribute for an `<input type="submit">`.
   *
   * Added for ACT-008, and deliberately **not** folded into `haystack`: a plain
   * `<button>Submit Application</button>` carries no name, id, placeholder or
   * label, so `haystack` is empty for it and there is no DOM fact to corroborate
   * a submit control against. Kept as its own field so `corroborate()` below —
   * which matches `FIELD_KEYWORDS` against `haystack` — behaves bit-for-bit as
   * it did before this field existed. Widening `haystack` would have quietly
   * changed which text fields this module is willing to type into.
   */
  text: string;
  /** `role` attribute, for the `<div role="button">` controls some boards use. Added for ACT-008. */
  role: string;
};

const NO_CONTROL: ControlDescriptor = {
  found: false,
  tag: "",
  type: "",
  haystack: "",
  attachedFiles: -1,
  text: "",
  role: "",
};

/**
 * Asks the DOM what the control at `selector` actually is.
 *
 * This is the corroboration that keeps a mis-observed selector from turning into
 * a phone number typed into an employer's "Email" box. `observe()`'s own
 * `description` is a model's account of the page and cannot check itself;
 * `name`, `id`, `placeholder` and the associated `<label>` are facts, and they
 * are what `FIELD_KEYWORDS` is matched against.
 *
 * Returns `found: false` rather than throwing when the selector does not resolve
 * in the top-level document — which is the normal case for a board that hosts
 * its form in an iframe, not an error. The caller decides what to do about it.
 */
export async function describeControl(page: Page, selector: string): Promise<ControlDescriptor> {
  try {
    // ACT-015: `inPageExpression` rather than a bare `toString()`. Under `tsx`,
    // esbuild wraps every named function in its own `__name(…)` helper, which is
    // defined in the module and undefined in the page — so this function threw
    // on its first line on every page it was ever used on, returned
    // `found: false` every time, and was reported as "the form is probably
    // inside an iframe". It was not. See `inPageExpression`'s comment.
    //
    // The consequence of the fix is that `corroborate()` now checks the DOM
    // truth it was written to check, instead of silently falling back to the
    // reader's own description on every field.
    const result = await page.evaluate(
      inPageExpression(describeControlInPage, jsExpression(selector))
    );
    const failure = inPageError(result);
    if (failure !== null) {
      console.warn(`${LOG} could not describe the control at ${selector}: ${failure}`);
      return NO_CONTROL;
    }
    const raw = result as Partial<ControlDescriptor> | null;
    if (!raw || typeof raw !== "object") return NO_CONTROL;
    return {
      found: raw.found === true,
      tag: typeof raw.tag === "string" ? raw.tag : "",
      type: typeof raw.type === "string" ? raw.type : "",
      haystack: typeof raw.haystack === "string" ? raw.haystack : "",
      attachedFiles: typeof raw.attachedFiles === "number" ? raw.attachedFiles : -1,
      text: typeof raw.text === "string" ? raw.text : "",
      role: typeof raw.role === "string" ? raw.role : "",
    };
  } catch {
    // A selector that will not resolve, a cross-origin frame, an evaluate that
    // is not supported — all the same answer: no DOM fact is available, and the
    // caller falls back to the reader's description. Never fatal.
    return NO_CONTROL;
  }
}

/**
 * Serialised into the page by `describeControl`, so it must be self-contained:
 * no imports, no closure over anything in this module.
 *
 * It is written here as a real function rather than a template string so
 * TypeScript checks it, and shipped as `toString()` so it travels over the same
 * plain-string `evaluate` path `STRUCTURAL_FLOOR_SCRIPT` already uses.
 */
function describeControlInPage(sel: string): ControlDescriptor {
  const empty: ControlDescriptor = {
    found: false,
    tag: "",
    type: "",
    haystack: "",
    attachedFiles: -1,
    text: "",
    role: "",
  };
  /**
   * JOB-047. Stagehand marks a shadow boundary in its XPath with a double
   * slash, and `document.evaluate` cannot cross one.
   *
   * A selector its `observe()` returns for a web component board looks like
   * `/html[1]/.../oc-input[1]/spl-input[1]//spl-internal-form-field[1]/div[1]/input[1]`
   * — the `//` sits exactly where `spl-input`'s shadow root begins. To XPath
   * that reads as "descendant-or-self", which does not enter a shadow root, so
   * the evaluation returns null and this function reports `found: false`.
   *
   * That is not a cosmetic miss. `corroborateSubmitControl` fails closed on
   * `found: false` with "Refusing to click a submit button this module cannot
   * see", so on **every** board built out of web components the submit control
   * could never be corroborated and therefore could never be clicked. The guard
   * was doing the safe thing for the wrong reason: not "this control is not what
   * it claims" but "this module cannot resolve its own driver's selector".
   *
   * So each `//` splits the path into a segment, and each segment after the
   * first is walked inside the previous element's shadow root. The steps are the
   * simple `tag[n]` form Stagehand emits, walked by hand because XPath over a
   * `ShadowRoot` is not something every engine supports. A path with no `//` in
   * it takes the original `document.evaluate` route untouched, so nothing about
   * an ordinary board changes.
   */
  const stepInto = (root: ParentNode, path: string): Element | null => {
    let current: ParentNode | null = root;
    for (const step of path.split("/")) {
      if (step === "" || current === null) continue;
      const match = /^([A-Za-z0-9_-]+)(?:\[(\d+)\])?$/.exec(step);
      if (!match) return null;
      const tag = (match[1] ?? "").toLowerCase();
      const nth = match[2] === undefined ? 1 : Number(match[2]);
      let seen = 0;
      let next: Element | null = null;
      for (const child of Array.from(current.children)) {
        if (child.tagName.toLowerCase() !== tag) continue;
        seen++;
        if (seen === nth) {
          next = child;
          break;
        }
      }
      if (next === null) return null;
      current = next;
    }
    return current === root ? null : (current as Element);
  };

  let element: Element | null = null;
  try {
    const path = sel.startsWith("xpath=") ? sel.slice("xpath=".length) : sel;
    if (path.includes("//") && (path.startsWith("/") || path.startsWith("("))) {
      const segments = path.split("//");
      const first = segments.shift() ?? "";
      // 9 === XPathResult.FIRST_ORDERED_NODE_TYPE
      let node = document.evaluate(first, document, null, 9, null).singleNodeValue as Element | null;
      for (const segment of segments) {
        const inner = node === null ? null : (node as HTMLElement).shadowRoot;
        if (inner === null || inner === undefined) {
          node = null;
          break;
        }
        node = stepInto(inner, segment);
      }
      element = node;
    } else if (path.startsWith("/") || path.startsWith("(")) {
      // 9 === XPathResult.FIRST_ORDERED_NODE_TYPE
      element = document.evaluate(path, document, null, 9, null).singleNodeValue as Element | null;
    } else {
      element = document.querySelector(sel);
      if (element === null) {
        // A plain CSS selector that matches nothing in the light document is
        // looked for inside the open shadow roots, deepest last. This is the
        // branch a `form-fields.ts` stamped handle takes.
        const stack: (Document | ShadowRoot)[] = [document];
        const seen = new Set<Document | ShadowRoot>();
        while (stack.length > 0 && element === null) {
          const root = stack.pop();
          if (root === undefined || seen.has(root)) continue;
          seen.add(root);
          for (const host of Array.from(root.querySelectorAll("*"))) {
            const inner = (host as HTMLElement).shadowRoot;
            if (inner === null || inner === undefined) continue;
            const hit = inner.querySelector(sel);
            if (hit !== null) {
              element = hit;
              break;
            }
            stack.push(inner);
          }
        }
      }
    }
  } catch {
    return empty;
  }
  if (!element) return empty;

  const parts: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (value) parts.push(String(value));
  };
  // Text a sighted applicant would actually see under `root`, skipping any
  // subtree hidden via `display:none`, `visibility:hidden` or `aria-hidden`.
  // A wrapping <label> (or the nearest labelled block) can hold more than the
  // caption: a combobox widget's own status chrome — a "No results" panel, a
  // loading spinner's caption — lives in that same label/block and stays in
  // the DOM the whole time, only ever toggled with `display`. Reading
  // `.textContent` straight off pulls that chrome in too, so the haystack
  // built here runs the same risk `form-fields.ts`'s `labelOf` had (issue
  // #81, Lever's location autocomplete): "no location found" or "loading"
  // text bleeding into what a field "describes itself as" here.
  const visibleTextOf = (root: Element): string => {
    if (root.getAttribute("aria-hidden") === "true") return "";
    const rootStyle = window.getComputedStyle(root);
    if (rootStyle.display === "none" || rootStyle.visibility === "hidden") return "";
    const bits: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent !== null) bits.push(node.textContent);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      if (el.getAttribute("aria-hidden") === "true") return;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      for (const child of Array.from(node.childNodes)) walk(child);
    };
    for (const child of Array.from(root.childNodes)) walk(child);
    return bits.join(" ");
  };
  const attributes = ["name", "id", "placeholder", "aria-label", "autocomplete", "data-testid", "title"];
  for (const attribute of attributes) push(element.getAttribute(attribute));

  // Scoped to the control's own root. For a light DOM control that root *is*
  // the document, so this is unchanged; for a shadow one it stops the lookup
  // finding a same-id element belonging to some other component entirely.
  const ownRoot = element.getRootNode();
  const scope: ParentNode = ownRoot instanceof ShadowRoot ? ownRoot : document;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const escapedId = id.replace(/["\\]/g, "\\$&");
      const target = scope.querySelector('[id="' + escapedId + '"]');
      if (target) push(target.textContent);
    }
  }
  const ownId = element.getAttribute("id");
  if (ownId) {
    const escaped = ownId.replace(/["\\]/g, "\\$&");
    const explicit = scope.querySelector('label[for="' + escaped + '"]');
    if (explicit) push(explicit.textContent);
  }
  const wrapping = element.closest("label");
  if (wrapping) push(visibleTextOf(wrapping));
  // Greenhouse renders <div><label>First Name</label><input></div>, so the
  // nearest labelled block is usually where the human-readable name lives.
  const block = element.closest("div,fieldset,li,section");
  if (block) {
    const blockLabel = block.querySelector("label,legend");
    if (blockLabel) push(visibleTextOf(blockLabel));
  }

  // JOB-047. Keep looking on the other side of the shadow boundary.
  //
  // Everything above stops at the edge of the control's own root, because
  // `closest` does. On a web component board that means the walk never reaches
  // the section the control sits in — and the section is where its name is. A
  // SmartRecruiters resume dropzone describes itself as "file-input | Choose a
  // file or drop it here", which is a perfectly accurate description of a file
  // input and says nothing about a resume; the word "Resume" is the section
  // heading, one host up and outside the shadow root, exactly where a sighted
  // applicant reads it.
  //
  // Making the resolver see shadow DOM (above) turned that from a silent
  // bypass — `found: false`, corroboration skipped entirely, control used
  // anyway — into an active refusal to upload somebody's resume into a control
  // the module could not identify. The refusal was right on the evidence it
  // had. This gives it the rest of the evidence rather than lowering the bar:
  // the host's own identifying attributes, and the nearest heading of the block
  // the host sits in, which is precisely what the two lookups above already do
  // for a control that happens to live in the light DOM.
  const HEADINGS = "label,legend,h1,h2,h3,h4,h5,h6,[data-test*='title' i]";
  let host: Element = element;
  for (let depth = 0; depth < 4; depth++) {
    const hostRoot = host.getRootNode();
    if (!(hostRoot instanceof ShadowRoot)) break;
    host = hostRoot.host;
    for (const attribute of attributes) push(host.getAttribute(attribute));
    push(host.getAttribute("data-test"));
    const hostBlock = host.closest("div,fieldset,li,section");
    if (hostBlock) {
      const heading = hostBlock.querySelector(HEADINGS);
      // The heading only, never the block's whole text: a section's prose is
      // its neighbours' words as much as this control's, and `corroborate`
      // treats everything in the haystack as evidence about this control.
      if (heading) push(visibleTextOf(heading).slice(0, 120));
    }
  }

  const asInput = element as HTMLInputElement;
  const tag = element.tagName.toLowerCase();
  // `<input type="submit" value="Submit Application">` has no text content; its
  // label lives in `value`. Every other control's label is its text.
  let ownText =
    tag === "input" ? (element.getAttribute("value") ?? "") : (element.textContent ?? "");
  // A web component button is an empty `<button>` in a shadow root with a
  // `<slot>` in it: the caption ("Submit application", "Next") is declared on
  // the light DOM host and projected in. Reading only the element itself sees an
  // unnamed control, and `corroborateSubmitControl` refuses an unnamed control
  // outright — so without this the words it is meant to check against the
  // reported label do not exist. Read only as a fallback, so a control that does
  // carry its own text is described by that exactly as before.
  if (ownText.trim() === "" && ownRoot instanceof ShadowRoot) {
    const host = ownRoot.host;
    ownText = host.textContent ?? "";
    if (ownText.trim() === "") ownText = host.getAttribute("aria-label") ?? "";
  }

  return {
    found: true,
    tag,
    type: (element.getAttribute("type") ?? "").toLowerCase(),
    haystack: parts.join(" | ").replace(/\s+/g, " ").trim().slice(0, 600),
    attachedFiles: asInput.files ? asInput.files.length : -1,
    text: ownText.replace(/\s+/g, " ").trim().slice(0, 300),
    role: (element.getAttribute("role") ?? "").toLowerCase(),
  };
}

/**
 * A JS string literal for `value`, safe to splice into an expression.
 * `JSON.stringify` handles quotes, backslashes and control characters; U+2028
 * and U+2029 are JSON-legal but were JavaScript line terminators before ES2019,
 * so they are escaped explicitly rather than relied upon.
 */
function jsExpression(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function readControlValue(page: Page, selector: string): Promise<string | null> {
  try {
    return await page.locator(selector).inputValue();
  } catch {
    return null;
  }
}

// ───────────────────────────────────
// Which control is which
// ───────────────────────────────────

/**
 * What each field's control must say about itself. Matched against
 * `ControlDescriptor.haystack` (DOM truth) and, only when the DOM has nothing to
 * say, against `observe()`'s description.
 *
 * They double as a *conflict* table: a control whose own labelling matches a
 * different field's pattern and not this one is refused outright, which is what
 * stops the classic failure of a correct-looking observation landing one box off.
 */
export const FIELD_KEYWORDS = {
  firstName: /first[\s_-]*name|given[\s_-]*name|\bfname\b/i,
  lastName: /last[\s_-]*name|\bsurname\b|family[\s_-]*name|\blname\b/i,
  fullName: /(full|your|applicant)[\s_-]*name|^\s*name\b/i,
  email: /e-?mail/i,
  confirmEmail: /confirm[\s_-]*(?:your[\s_-]*)?e-?mail|re-?enter[\s_-]*e-?mail|repeat[\s_-]*e-?mail|verify[\s_-]*e-?mail/i,
  city: /\bcity\b|\bcurrent[\s_-]*(?:city|location)\b/i,
  phone: /phone|mobile|telephone|\btel\b/i,
  linkedin: /linked-?in/i,
  website: /website|portfolio|personal[\s_-]*(site|url|page)|\bgithub\b/i,
  coverLetter: /cover[\s_-]*letter/i,
  resume: /resum|\bcv\b|curriculum/i,
} as const;

type FieldKey = keyof typeof FIELD_KEYWORDS;

/** Input types that are never a free-text field, whatever a model called them. */
const NON_TEXT_INPUT_TYPES = new Set([
  "file",
  "password",
  "submit",
  "button",
  "reset",
  "checkbox",
  "radio",
  "hidden",
  "image",
  "range",
  "color",
]);

type Corroboration = { ok: true; via: string } | { ok: false; why: string };

/**
 * JOB-006 review follow up. Why a replayed selector may not be corroborated by
 * the description it carries.
 *
 * A replayed action's description is one of this module's own `INSTRUCTIONS`
 * constants, because `lib/form-action-cache.ts` deliberately stores no model
 * written text in a table every user's runs read. Every one of those constants
 * names its own field in plain words, so matching one against `FIELD_KEYWORDS`
 * is matching a string we wrote against itself and succeeds for every replay,
 * whatever the stored selector actually points at.
 *
 * That would be harmless if a stored selector could only ever come from a form
 * like this one, and it cannot: `selectorShape()` reduces an XPath to its leaf
 * tag, so two unrelated self hosted careers pages with no element ids really do
 * fingerprint the same. A replay whose selector lands on an unlabelled element,
 * or inside an iframe, or nowhere at all, would then pass corroboration with no
 * evidence behind it, and the only remaining check reads back that *a* value
 * landed rather than that the right value landed in the right box.
 *
 * So when the DOM offers nothing independent, a replay fails. That is not a
 * dead end: `corroborateResolved` answers a failed replay by dropping the row
 * and observing the control live, which is exactly what the run would have done
 * without a cache. The cost of a colliding row stays one model call.
 */
function replayNeedsDomEvidence(what: string): Corroboration {
  return {
    ok: false,
    why:
      `${what}, and this selector was replayed from the shared form action cache rather than ` +
      `observed on this page, so nothing identifies it except the instruction this run asked ` +
      `with`,
  };
}

/**
 * Whether the control at a selector is the field it is supposed to be.
 *
 * `replayed` says where the selector came from, and it is a safety input rather
 * than bookkeeping: it is what stops the two branches below that have no DOM
 * fact to work with from accepting a cached selector on the strength of our own
 * instruction string. See `replayNeedsDomEvidence`.
 */
export function corroborate(
  key: FieldKey,
  descriptor: ControlDescriptor,
  observedDescription: string,
  multiline: boolean,
  replayed: boolean
): Corroboration {
  const self = FIELD_KEYWORDS[key];

  if (descriptor.found) {
    if (descriptor.tag === "input" && NON_TEXT_INPUT_TYPES.has(descriptor.type)) {
      return {
        ok: false,
        why: `the control at that selector is an <input type="${descriptor.type}">, which is not ` +
          `something to type a value into`,
      };
    }
    if (multiline && descriptor.tag === "input") {
      return {
        ok: false,
        why: `a cover letter needs a multi-line box, and the control at that selector is a ` +
          `single-line <input>`,
      };
    }

    if (descriptor.haystack === "") {
      // A control with no name, id, placeholder or label at all — Workday's
      // sign-up email box is exactly this. There is no DOM fact to check, so
      // fall back to what the reader said, and say so in the report.
      if (replayed) {
        return replayNeedsDomEvidence("the control carries no name, id, placeholder or label");
      }
      return self.test(observedDescription)
        ? {
            ok: true,
            via: "the reader's description only — the control carries no name, id, placeholder or label",
          }
        : { ok: false, why: "the control carries no labelling and the reader's description does not match either" };
    }

    const conflicts = (Object.keys(FIELD_KEYWORDS) as FieldKey[]).filter(
      (other) => other !== key && FIELD_KEYWORDS[other].test(descriptor.haystack)
    );
    if (!self.test(descriptor.haystack)) {
      return {
        ok: false,
        why:
          `the control at that selector describes itself as ${JSON.stringify(descriptor.haystack)}` +
          (conflicts.length > 0 ? ` — that is the ${conflicts.join("/")} field, not this one` : ""),
      };
    }
    if (conflicts.length > 0) {
      return {
        ok: false,
        why:
          `the control at that selector describes itself as ${JSON.stringify(descriptor.haystack)}, ` +
          `which reads as ${conflicts.join("/")} as well as this field — too ambiguous to type into`,
      };
    }
    return { ok: true, via: "the control's own name/id/label in the DOM" };
  }

  // Selector did not resolve at the top level. Common and legitimate: the form
  // is inside an iframe — or, as JOB-036 found on a real SmartRecruiters form,
  // inside a web component's shadow DOM, which a plain `document.querySelector`
  // or XPath evaluation cannot cross any more than it can cross into an iframe.
  // Either way the reader's description is all there is.
  if (replayed) {
    return replayNeedsDomEvidence("the selector does not resolve in the top level document");
  }
  return self.test(observedDescription)
    ? {
        ok: true,
        via: "the reader's description only — the selector does not resolve in the top-level document (the form is probably inside an iframe or a web component's shadow DOM)",
      }
    : {
        ok: false,
        why: "the selector does not resolve in the top-level document and the reader's description does not identify this field either",
      };
}

// ───────────────────────────────────
// What must never be clicked
// ───────────────────────────────────

/**
 * Wording that belongs to the job application rather than to sign-in or
 * navigation.
 *
 * Exported since ACT-008. `submit-application.ts` matches on exactly this pair
 * of patterns, in the *positive* direction: the one control it is allowed to
 * click is the one this module refuses to click. Two independently-maintained
 * copies of "what counts as an application submit" would be the worst possible
 * thing to let drift — one side loosening would either make this module click a
 * real submit or make that one click something that is not.
 */
export const APPLICATION_CONTROL_RE = /\b(apply|application|resume|cv)\b/i;
/**
 * Every inflection, because a model writes prose. "the button that sends the
 * application" has to trip this as surely as "Submit Application" does, and an
 * earlier version of this pattern (`/\b(submit|send)\b/i`) did not — `\bsend\b`
 * does not match "sends".
 *
 * Exported since ACT-008 — see `APPLICATION_CONTROL_RE` above. Note the
 * asymmetry that buys: widening this pattern always makes *this* module more
 * cautious (it refuses more clicks) and always makes ACT-008 more permissive
 * about what it will accept as a submit control, which is why ACT-008 does not
 * rely on it alone.
 */
export const SUBMIT_WORD_RE =
  /\b(submit|submits|submitted|submitting|submission|send|sends|sending|finish|finalis|finaliz|complete)\w*\b/i;

export class FormFillBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormFillBlockedError";
  }
}

/**
 * The URL is not one this pipeline will open, or is not one it will stay on.
 * Thrown from two places: `loadApplicationState`, before anything navigates, and
 * `assertStillOnTheBoard`, against the URL the browser actually reached.
 *
 * A `FormFillBlockedError`, because that is what it is: a stop for a human, and
 * a retry into the same wall would be pointless. It carries the listing and the
 * platform because the first of those two throws before `runFill` holds an
 * `ApplicationState`, and a `skip_log` row needs both.
 */
export class BlockedApplyUrlError extends FormFillBlockedError {
  constructor(
    message: string,
    readonly jobId: string,
    readonly ats: string
  ) {
    super(message);
    this.name = "BlockedApplyUrlError";
  }
}

/**
 * The last gate in front of every click this module makes.
 *
 * `create-board-account.ts` established the rule at control level — a control
 * that names the application submits the application, whatever else its label
 * says — and it is the same rule here, just applied to a different set of
 * clicks. Nothing this module clicks (open the application, sign in, confirm a
 * verification code, switch the cover letter to manual entry) has any business
 * matching it.
 */
export function assertNotAnApplicationSubmit(what: string, description: string): void {
  if (APPLICATION_CONTROL_RE.test(description) && SUBMIT_WORD_RE.test(description)) {
    throw new FormFillBlockedError(
      `Refusing to click ${what}: the control found for it describes itself as ` +
        `${JSON.stringify(description)}, which reads as the control that SUBMITS the ` +
        `application. Submission is ACT-008 and this module must never perform it. Nothing ` +
        `was clicked.`
    );
  }
}

async function clickControl(
  session: BrowserSession,
  url: string,
  what: string,
  instruction: string,
  accept: RegExp
): Promise<CachedAction | null> {
  const resolved = await tryResolveAction(session, url, instruction);
  if (resolved === null) return null;

  const description = resolved.action.description;
  assertNotAnApplicationSubmit(what, description);
  if (!accept.test(description)) {
    throw new FormFillBlockedError(
      `Refusing to click ${what}: the control found for it describes itself as ` +
        `${JSON.stringify(description)}, which does not read as ${what}. Not guessing on a ` +
        `real employer's site.`
    );
  }

  console.log(`${LOG} clicking ${what} — ${JSON.stringify(description)}`);
  await session.stagehand.act(
    { selector: resolved.action.selector, description: instruction, method: "click" },
    { page: session.page }
  );
  return resolved.action;
}

// ───────────────────────────────────
// Inputs and outputs
// ───────────────────────────────────

export type VerificationInput = {
  /** `verificationCode` from ACT-006's `email/verification-received` event. */
  code?: string | null;
  /** `verificationLink` from the same event. Re-checked against the board's allowlist here. */
  link?: string | null;
};

export type FillApplicationFormInput = {
  /** `applications.id`. Everything else is read from the row. */
  jobApplicationId: string;
  /**
   * ACT-002's `requiresCoverLetter` for this listing. Passed in explicitly
   * rather than read from anywhere, because ACT-009 has not wired the scraper's
   * output through to the database yet and this module must not guess: a cover
   * letter is generated **only** when this is true.
   */
  requiresCoverLetter: boolean;
  /** The listing's description text, when the scraper captured it. UNTRUSTED. */
  jobDescription?: string | null;
  /** Code and/or link, for a row sitting at `awaiting_verification`. */
  verification?: VerificationInput;
  /** Run Chrome headless. Default true. */
  headless?: boolean;
  /** Where to write the filled-but-not-submitted screenshot. Default `lib/.form-fill-screenshots`. */
  screenshotDir?: string;
  /**
   * ACT-015. The user's own answers to whatever a previous run reported in
   * `needsInput`, keyed by that item's `key` (which is the form's own label,
   * folded to lower case).
   *
   * This is the resume half of the pause/ask/resume loop, and it is deliberately
   * the *only* half: there is no session handle, no stored pending-question
   * record and no new table. The caller re-invokes the same function with the
   * same `jobApplicationId` and these answers merged in; everything else — the
   * page, the field list, the keys — is re-derived from scratch, which is what
   * makes a stateless second call land on the same fields as the first.
   *
   * Values are typed into a real employer's form verbatim (sanitised to one
   * line), or, for a dropdown, matched against the options the page offers. An
   * answer that matches no option is reported back rather than approximated.
   *
   * ── JOB-134: what is passed here is added to, not replaced ────────────────
   * Whatever a caller supplies is folded together with the answers this person
   * has given before, from `profiles.stored_answers`, and the supplied ones win
   * every collision — in value and in iteration order, since
   * `matchAdditionalAnswer` walks the map and takes the first key that matches.
   * Somebody answering a question again right now is correcting the record, not
   * competing with it. A caller that supplies nothing still gets everything
   * this person has ever answered, which is the point of the ticket.
   */
  additionalAnswers?: Record<string, string>;
};

export type FieldOutcome = {
  /**
   * The field's name. One of `FIELD_KEYWORDS`' keys or `"resume"` for the fields
   * ACT-007 knows by name; for everything else (ACT-015) it is the form's own
   * visible label, folded to lower case — the same string `needsInput[].key`
   * uses, so a report and a question can be lined up by eye.
   */
  field: string;
  /** What this module meant to put there. */
  intended: string | null;
  outcome: "filled" | "not-on-form" | "skipped" | "mismatch" | "declined" | "needs-input";
  detail: string;
  /** What the browser reads back out of the control afterwards. */
  readBack?: string | null;
};

/**
 * ACT-015 — one thing the run could not answer truthfully and will not guess at.
 *
 * Returned rather than thrown, alongside whatever *was* filled, so the caller
 * has something to put to the user rather than an error string to relay.
 */
export type NeedsInputItem = {
  /** Echo this back as a key of `additionalAnswers` to answer it. */
  key: string;
  /** The label exactly as it appears on the form. */
  fieldLabel: string;
  /** The question to put to the candidate, in plain second person. */
  question: string;
  /** Why this could not be answered from what is already known. */
  why: string;
  /** True when the board will refuse the application without it. */
  required: boolean;
  kind: FormFieldKind;
  /** The choices the form offers, when it offers a fixed set. */
  options?: string[];
};

export type FillApplicationFormResult = {
  jobApplicationId: string;
  status: ApplicationStatus;
  /** Always false. The type says so because this module can never make it true. */
  submitted: false;
  verification: {
    required: boolean;
    method: "link" | "code" | "none";
    completed: boolean;
    detail: string;
  };
  fields: FieldOutcome[];
  /**
   * ACT-015. Required fields the run refused to guess at, and the questions that
   * would unblock them. Empty on a run that could answer everything.
   *
   * A non-empty list with `required: true` in it is always accompanied by
   * `status: "form_fill_blocked"` and `blockedReason`, because a form with a
   * required field still empty cannot be submitted anyway — so ACT-008 never
   * sees a live session for one of these.
   */
  needsInput: NeedsInputItem[];
  /**
   * JOB-170. Every field this run answered through the LLM fabrication rung
   * or its sane default fallback, in application order. Written to
   * `applications.answer_provenance` on the success path so a post hoc audit
   * can tell which categories got fabricated across many submissions.
   */
  answerProvenance: AnswerProvenanceEntry[];
  coverLetter: {
    required: boolean;
    generated: boolean;
    filled: boolean;
    characters: number;
    detail: string;
  };
  /**
   * Everything the resume yielded, including the work history and education the
   * ticket asks for but that a Greenhouse form has nowhere to put — see
   * `buildFieldPlan`. Reported rather than dropped: it is how the acceptance
   * check ("the filled form matches the resume data") can be made against the
   * parse as well as against the form, and it is what the next ATS's field map
   * will be built from.
   */
  parsedProfile: ResumeProfile;
  /** Non-fatal notes from parsing — e.g. the resume states a different email. */
  profileWarnings: string[];
  /**
   * Labels of the controls that would submit. Never clicked *by this module* —
   * this is the candidate list ACT-008 narrows and then clicks exactly one of,
   * so it is a safety input to that decision, not a convenience. Always empty on
   * a blocked run: a form that was not finished has no submit control anyone may
   * press.
   */
  submitControlLabels: string[];
  finalUrl: string;
  pageTitle: string;
  screenshotPath: string | null;
  blockedReason: string | null;
  /** The Browserbase session this run used, when it ran remotely. Null on the local Chromium path. */
  browserbaseSessionId: string | null;
};

// ───────────────────────────────────
// Supabase
// ───────────────────────────────────

function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required " +
        "(see .env.example)"
    );
  }
  assertSupabaseProject(url);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type ApplicationState = {
  jobApplicationId: string;
  candidateId: string;
  /** `applications.job_id`. Needed to log a skip against the listing. */
  jobId: string;
  /** `jobs.ats`. Same. */
  ats: string;
  /**
   * `boards.board_token`. Carried on the state, not only read inside
   * `loadApplicationState`, because the apply URL rule is applied again against
   * wherever the browser ends up and that check needs the same expectation the
   * first one was made against. See `assertStillOnTheBoard`.
   */
  boardToken: string;
  company: string;
  jobTitle: string;
  applyUrl: string;
  status: string;
  /**
   * JOB-112 added `resumeId` and `linkedinPdfPath`. Both are properties of the
   * `resumes` row rather than of the person, and both are needed before a
   * stored parse can be read: the id is what `resumes.parsed` is keyed on, and
   * the LinkedIn path is the second document that parse is derived from.
   */
  candidate: CandidateRecord & {
    resumeId: string;
    resumeUrl: string;
    linkedinPdfPath: string | null;
  };
  /**
   * ACT-015. The reusable form answers intake collected, or `{}` when it
   * collected none. An absent key means "never asked", and the fill layer turns
   * that into a question for the candidate rather than a value on a form.
   */
  applicationAnswers: CandidateApplicationAnswers;
  /**
   * JOB-134. Every question this person has answered that intake never asked,
   * from `profiles.stored_answers`, newest first.
   *
   * Held on the state rather than read where it is needed for the same reason
   * `applicationAnswers` is: the run needs it in two places, once to fold into
   * this run's `additionalAnswers` and once to write back with whatever this
   * run learned, and reading it twice would let the two disagree.
   */
  storedAnswers: StoredAnswer[];
};

/**
 * Statuses this module is willing to start from.
 *
 * `form_filled` and `form_fill_blocked` are in the set because re-running is
 * safe by construction: nothing was ever submitted, so the worst a repeat does
 * is type the same values into the same boxes again.
 *
 * `submission_blocked` (ACT-008) is in the set for the same reason and only
 * because ACT-008 guarantees it structurally: that status is written by a helper
 * which, if the submit click has already been attempted, refuses to write it and
 * writes `submission_unconfirmed` instead. So a row reading `submission_blocked`
 * has provably had nothing clicked on it.
 *
 * Note what is *not* here, and must never be added: `submitted` and
 * `submission_unconfirmed`. Their absence is this module's half of the
 * double-submission guard — a second ACT-008 run against such a row fails in
 * `loadApplicationState` before a browser is even opened. `error` and
 * `account_gate_blocked` are likewise absent, because both mean a human has not
 * yet looked at something that needs looking at.
 */
const READY_STATUSES: ReadonlySet<string> = new Set([
  // JOB-004. The status a freshly claimed row carries, and now the ordinary way
  // a run starts: Jobinno creates no accounts, so nothing writes
  // `no_account_required` any more and a row goes straight from claimed to
  // filled. Safe to start from for the same reason the two below are — nothing
  // has been submitted, because nothing has happened at all.
  APPLICATION_STATUS.DISCOVERED,
  APPLICATION_STATUS.NO_ACCOUNT_REQUIRED,
  APPLICATION_STATUS.AWAITING_VERIFICATION,
  APPLICATION_STATUS.EMAIL_VERIFIED,
  APPLICATION_STATUS.FILLING_FORM,
  APPLICATION_STATUS.FORM_FILLED,
  APPLICATION_STATUS.FORM_FILL_BLOCKED,
  APPLICATION_STATUS.SUBMISSION_BLOCKED,
]);

async function loadApplicationState(
  supabase: SupabaseClient,
  jobApplicationId: string
): Promise<ApplicationState> {
  // ── JOB-004: one query became a join ──────────────────────────────────────
  // actinno's `job_applications` carried the company, the job title and the
  // apply URL as columns of its own. Jobinno normalizes them: the listing is a
  // `jobs` row and the employer is the `boards` row behind it, so the three
  // strings this module needs come from two embedded reads rather than from the
  // application row. The embeds are inner joins because an application whose
  // listing has been deleted has nothing to fill a form from, and reporting
  // that as three empty strings would be a worse failure than saying so.
  const { data: rows, error } = await supabase
    .from("applications")
    .select("id,user_id,job_id,status,jobs!inner(title,url,ats,boards!inner(company,board_token))")
    .eq("id", jobApplicationId)
    .limit(1);
  if (error) throw new Error(`applications lookup failed: ${error.message}`);

  const row = rows?.[0];
  if (!row) throw new Error(`No applications row with id ${jobApplicationId}.`);

  const status = String(row.status ?? "");
  if (!READY_STATUSES.has(status)) {
    throw new Error(
      `applications ${jobApplicationId} is at status "${status}". ACT-007 only runs from ` +
        `${[...READY_STATUSES].join(", ")}. A row at "${APPLICATION_STATUS.FILLING_FORM}" has a ` +
        `run in flight; one at "${APPLICATION_STATUS.SUBMITTED}" or ` +
        `"${APPLICATION_STATUS.SUBMISSION_UNCONFIRMED}" has already had a submit click issued ` +
        `against it and must never be opened again.`
    );
  }

  // PostgREST returns a to-one embed as an object, but its inferred types are
  // not always sure which of object and array it will be. Both are accepted
  // rather than asserted, because guessing wrong costs an empty company name on
  // a real employer's form and the check is one line.
  const one = (value: unknown): Record<string, unknown> => {
    const picked = Array.isArray(value) ? value[0] : value;
    return picked !== null && typeof picked === "object" ? (picked as Record<string, unknown>) : {};
  };
  const job = one(row.jobs);
  const board = one(job.boards);

  const candidateId = String(row.user_id ?? "");
  const jobId = String(row.job_id ?? "");
  const applyUrl = String(job.url ?? "");
  if (applyUrl === "") {
    throw new Error(`applications ${jobApplicationId} points at a job with no url.`);
  }

  // ── The last gate in front of the first navigation ────────────────────────
  // `lib/board-ingest.ts` screens the same URL before it is ever stored, and
  // that is the primary gate. This one is not a duplicate of it. Two paths
  // reach here with a row ingest never saw: `lib/fill-form-cli.ts` and
  // `lib/submit-application-cli.ts`, both of which take an application id or an
  // apply URL a human typed. And every row written before the ingest screen
  // existed is still in the table. A comment saying "ingest already checked
  // this" would be true of neither, which is why the rule is applied and not
  // assumed. See `lib/apply-url-guard.ts` for what it is.
  const verdict = checkApplyUrl(applyUrl, {
    ats: String(job.ats ?? ""),
    boardToken: String(board.board_token ?? ""),
  });
  if (!verdict.ok) {
    throw new BlockedApplyUrlError(
      `Refusing to open the apply URL on applications ${jobApplicationId}: ${verdict.reason}. ` +
        `Nothing was opened, nothing was typed and no resume was uploaded. A listing URL is ` +
        `where this pipeline uploads a real person's resume, so it is only ever followed to a ` +
        `board the listing itself came from.`,
      jobId,
      String(job.ats ?? "")
    );
  }

  // The person, their answers and their resume, all from `loadCandidate` rather
  // than from a second hand written query. actinno read the `candidates` row
  // inline here because it was one table; Jobinno's is two, and duplicating the
  // profile-plus-resume join would be a second place for the "which resume?"
  // rule to be decided differently.
  const candidate = await loadCandidate(candidateId);

  return {
    jobApplicationId,
    candidateId,
    jobId,
    ats: String(job.ats ?? ""),
    boardToken: String(board.board_token ?? ""),
    company: String(board.company ?? ""),
    jobTitle: String(job.title ?? ""),
    applyUrl,
    status,
    candidate: {
      id: candidateId,
      applicationEmail: candidate.applicationEmail,
      linkedinUrl: candidate.linkedinUrl,
      githubUrl: candidate.githubUrl,
      resumeId: candidate.resumeId,
      resumeUrl: candidate.resumeUrl,
      linkedinPdfPath: candidate.linkedinPdfPath,
    },
    applicationAnswers: candidate.applicationAnswers,
    storedAnswers: candidate.storedAnswers,
  };
}

/**
 * Finds the row for a (person, apply URL) pair.
 *
 * Exists for the CLI, where a human has the listing in front of them and not a
 * row id. Same lookup `claimApplicationRow` does, and it inherits the same
 * caveat: `(user_id, job_id)` has no unique index, so the oldest matching row
 * wins.
 *
 * The URL filter reaches through the join now, because the URL is a column of
 * `jobs` and not of `applications`. `jobs!inner` is what makes that filter
 * narrow the applications rather than blank out the embed.
 */
export async function findJobApplicationId(
  candidateId: string,
  applyUrl: string
): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("applications")
    .select("id,jobs!inner(url)")
    .eq("user_id", candidateId.trim())
    .eq("jobs.url", applyUrl.trim())
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(`applications lookup failed: ${error.message}`);

  const id = data?.[0]?.id;
  if (typeof id !== "string") {
    throw new Error(
      `No applications row for user ${candidateId} and apply URL ${applyUrl}. Send a ` +
        `job-application/requested event for this listing first, or claim the row with ` +
        `\`claimApplicationRow\`.`
    );
  }
  return id;
}

// ───────────────────────────────────
// Verification — the step nobody else owns
// ───────────────────────────────────

/**
 * ACT-006 detects the verification mail and reports a code and/or a link. It
 * deliberately does not open a browser, and no other ticket claims the step
 * either — so between "the mail arrived" and "the form is reachable" there was
 * nothing. This is that step.
 *
 * It lives here rather than in its own module because it cannot be its own
 * Inngest step: verification and form-fill must share a cookie jar, and a
 * browser session cannot cross a `step.run` boundary. Two steps would verify in
 * one browser and then fill in another, signed out.
 */
type VerificationOutcome = FillApplicationFormResult["verification"] & {
  /** The last read of the page, so the caller does not pay for another one. */
  signals: FormSignals | null;
};

async function completeVerification(
  supabase: SupabaseClient,
  session: BrowserSession,
  state: ApplicationState,
  input: VerificationInput | undefined
): Promise<VerificationOutcome> {
  if (state.status !== APPLICATION_STATUS.AWAITING_VERIFICATION) {
    return {
      required: false,
      method: "none",
      completed: true,
      detail: `row is at "${state.status}", not awaiting verification — nothing to complete`,
      signals: null,
    };
  }

  const link = input?.link?.trim() || null;
  const code = input?.code?.trim() || null;
  if (link === null && code === null) {
    throw new FormFillBlockedError(
      `applications ${state.jobApplicationId} is at ` +
        `"${APPLICATION_STATUS.AWAITING_VERIFICATION}" but no verification code or link was ` +
        `supplied. ACT-006 carries both on its \`${"email/verification-received"}\` event ` +
        `(verificationCode / verificationLink) — pass them through. Nothing was opened.`
    );
  }

  let method: "link" | "code" = link !== null ? "link" : "code";
  let detail: string;

  if (link !== null) {
    const safeLink = assertVerificationLinkAllowed(link, state.applyUrl);
    console.log(`${LOG} opening the verification link on ${new URL(safeLink).hostname}`);
    await session.page.goto(safeLink, { timeout: NAVIGATION_TIMEOUT_MS });
    detail = `opened the verification link on ${new URL(safeLink).hostname}`;
  } else {
    console.log(`${LOG} no verification link — going to the board to enter the emailed code`);
    await session.page.goto(state.applyUrl, { timeout: NAVIGATION_TIMEOUT_MS });
    detail = "navigated to the apply URL to enter the emailed code";
  }

  let signals = await readFormSignals(session);
  assertNoCaptcha(signals, "the verification page");

  // Some boards verify purely by the link; others land on a code box either way.
  if (signals.verificationCodeFieldPresent) {
    if (code === null) {
      throw new FormFillBlockedError(
        `The board is asking for a verification code at ${signals.url}, but the mail ACT-006 ` +
          `matched carried only a link. Nothing was typed. A human has to finish this one.`
      );
    }
    method = "code";
    // The code is a single-use credential and is passed as a literal argument —
    // it is never part of any prompt. Same rule as the board password.
    await typeInto(session, signals.url, INSTRUCTIONS.VERIFICATION_CODE, code);
    await clickControl(
      session,
      signals.url,
      "the button that confirms the emailed verification code",
      INSTRUCTIONS.VERIFICATION_SUBMIT,
      /(verif|confirm|continue|submit|next|activat)/i
    );
    signals = await readFormSignals(session);
    if (signals.verificationCodeFieldPresent) {
      throw new FormFillBlockedError(
        `The verification code was entered and confirmed, but the board is still showing a ` +
          `code field at ${signals.url} — it most likely rejected the code (expired, already ` +
          `used, or belonging to a different signup). Nothing else was touched.`
      );
    }
    detail += `; entered the ${code.length}-character code and the board accepted it`;
  }

  // Recorded before the form is touched, on purpose: verification links and
  // codes are single-use, so a crash during the fill must not send a retry back
  // to a credential the board has already burned.
  await updateApplication(supabase, state.jobApplicationId, {
    status: APPLICATION_STATUS.EMAIL_VERIFIED,
    browserbaseSessionId: session.browser.sessionId ?? null,
  });
  console.log(`${LOG} applications ${state.jobApplicationId} → ${APPLICATION_STATUS.EMAIL_VERIFIED}`);

  return { required: true, method, completed: true, detail, signals };
}

/**
 * A verification link is only opened when it is https and its host belongs to
 * the board the agent itself navigated to, or to that board's ATS vendor.
 *
 * ACT-006 already applies this rule before it emits the link. Applying it again
 * is not redundancy for its own sake: this function is also reachable from the
 * CLI, where a human pastes a link out of a mail client, and the whole point of
 * the boundary is that no path into a browser trusts a URL that arrived by
 * email.
 */
export function assertVerificationLinkAllowed(link: string, applyUrl: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new FormFillBlockedError(`Verification link is not a URL: ${JSON.stringify(link)}`);
  }
  if (url.protocol !== "https:") {
    throw new FormFillBlockedError(
      `Refusing to open a non-https verification link (${url.protocol}//…).`
    );
  }

  const domains = allowedSenderDomains(applyUrl);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const allowed = domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (!allowed) {
    throw new FormFillBlockedError(
      `Refusing to open a verification link on "${host}": the only domains that may speak for ` +
        `${applyUrl} are ${domains.join(", ") || "(none derivable)"}. A link that arrived by ` +
        `email is not permission to navigate anywhere.`
    );
  }
  return url.toString();
}

function assertNoCaptcha(signals: FormSignals, where: string): void {
  if (!signals.captchaPresent) return;
  const evidence = signals.captchaEvidence.trim();
  throw new FormFillBlockedError(
    `captcha_present: an interactive anti-bot challenge is on ${where} at "${signals.url}"` +
      (evidence ? ` (${evidence})` : "") +
      `. Nothing was filled or submitted. Solving captchas is permanently out of scope — ` +
      `automated attempts are flagged by reCAPTCHA Enterprise and risk banning the candidate ` +
      `from this employer's real hiring pipeline. A human has to complete this one.`
  );
}

/**
 * The positive counterpart to `applyControlPresent`'s own "false if the only
 * apply-ish control submits an application that is already filled in" rule.
 * That rule is a judgment call made *before* a click, about a control's
 * likely behaviour; this one is a fact checked *after* every click, about
 * what the page actually became. Either one alone can be wrong — the model
 * misjudging an apply-ish control as form-opening when it is really a
 * one-click submit is exactly the failure this backstops, because
 * `reachApplicationForm`'s click loop has no other way to tell "the click
 * revealed nothing" apart from "the click already submitted something" — both
 * leave `applicationFormPresent` false, and only one of those is safe to
 * describe as "nothing happened."
 *
 * Deliberately checked at every point `assertNoCaptcha` already is, and
 * nowhere else: this only matters on the path that clicks apply-ish controls,
 * not universally.
 */
function assertNotAlreadySubmitted(signals: FormSignals, where: string): void {
  if (!signals.applicationLikelySubmitted) return;
  const evidence = signals.applicationLikelySubmittedEvidence.trim();
  throw new FormFillBlockedError(
    `possible_unintended_submission: ${where} at "${signals.url}" now reads as a post-submission ` +
      `confirmation` +
      (evidence ? ` (${evidence})` : "") +
      `. This is NOT the same as "nothing happened" — a control clicked while trying to reach the ` +
      `application form may have submitted it directly instead of opening it. Treat this row as ` +
      `possibly already applied to and do not retry the fill automatically: a human needs to check ` +
      `whether a real application already exists before this listing is attempted again.`
  );
}

/**
 * The apply URL rule, applied to where the browser actually is rather than to
 * the string it was told to go to.
 *
 * ── Why the check before the navigation is not enough ───────────────────────
 * `checkApplyUrl` runs in `loadApplicationState`, and what it reads there is a
 * column. `page.goto` follows redirects, so a listing URL on a genuine ATS host
 * over https can answer with a 302 to anywhere at all and the browser will be
 * standing on that page a moment later. Clicking the control that opens the
 * application form can move it the same way, and so can a form that navigates
 * between its own steps. None of that is visible to a check made against a
 * string before any of it happened.
 *
 * What lands on the other side of such a redirect is not a page this module
 * merely looks at. It is the page it types a real name, a real email address, a
 * real phone number and a real work history into, and uploads a real resume PDF
 * to. So the rule is applied again here, unchanged and against the same board
 * the listing came from, at every point where something of the candidate's is
 * about to leave for whatever is on screen.
 *
 * ── What it does not cover ──────────────────────────────────────────────────
 * A page that navigates itself *during* a fill, between one field and the next.
 * Closing that would mean a check inside `typeInto` for every field on every
 * form, and the callers here bracket each thing that sends something: the
 * fields, the resume, and the ACT-015 pass over everything else. A page that
 * moves mid sequence is caught at the next bracket, before the next thing goes.
 *
 * Returns the URL it accepted, so a caller can log the page it is really on.
 */
async function assertStillOnTheBoard(
  session: BrowserSession,
  state: ApplicationState,
  when: string
): Promise<string> {
  const landed = String((await session.page.url()) ?? "");
  const verdict = checkApplyUrl(landed, { ats: state.ats, boardToken: state.boardToken });
  if (verdict.ok) return landed;

  throw new BlockedApplyUrlError(
    // `blocked_apply_url` is the tag `lib/application-records.ts` classifies this
    // stop by. It is first in that file's list because the sentence below quotes
    // a URL somebody else chose, and a landing page whose path spells one of the
    // other tags must not be able to file this under a different reason.
    `blocked_apply_url: the browser is at "${forLog(landed)}" ${when}, and that page does not ` +
      `belong to the board this listing came from: ${verdict.reason}. The listing pointed at ` +
      `"${forLog(state.applyUrl)}", which passed this same rule before anything was opened, so ` +
      `a redirect or a click moved the browser afterwards. Nothing was typed into this page and ` +
      `no resume was uploaded to it.`,
    state.jobId,
    state.ats
  );
}

// ───────────────────────────────────
// Getting to the form
// ───────────────────────────────────

/** How many apply-ish controls to click through before giving up. Same budget as ACT-005. */
const APPLY_CLICK_ROUNDS = 2;

/**
 * JOB-021. How long to wait before reading a freshly opened listing again, when
 * the first read found nothing this function could act on.
 *
 * Two waits rather than one, and short ones, because this is the *second* line
 * of defence: `settleBeforeReading` has already waited for content to attach and
 * for the DOM to stop growing before that first read happened. What is left for
 * this to catch is a board that mounts its application form later than that
 * budget allows, and a board which has not mounted a form six seconds after its
 * DOM went quiet has almost certainly not got one.
 *
 * The cost is bounded to runs that were about to fail anyway: every path that
 * reaches an empty-handed read either ends in the `FormFillBlockedError` at the
 * bottom of this function or in a click loop that breaks on its first line.
 */
const FORM_REREAD_BACKOFF_MS: readonly number[] = [2_000, 4_000];

/**
 * Whether a read left this function with nothing to do — no form to fill, no
 * apply control to click, and no sign-in wall to stop at.
 *
 * The three tests are exactly the three branches below, so this cannot drift
 * from the thing it is predicting: an empty-handed read is one that will fall
 * through the sign-in check, break out of the click loop on its first line, and
 * land on the throw.
 */
function readIsEmptyHanded(signals: FormSignals): boolean {
  return (
    !signals.applicationFormPresent &&
    !signals.applyControlPresent &&
    signals.passwordFieldCount === 0
  );
}

/**
 * Reads the page again, a couple of times, while it is still telling us nothing.
 *
 * Returns the last read and how many re-reads it took, so the failure message
 * can say whether this run waited or not — the difference between "we looked
 * once at a page that was still loading" and "we waited and the form was really
 * not there" is the whole diagnosis, and the first version of this module could
 * not tell the two apart.
 *
 * Stops early on a captcha or a post-submission confirmation. Both are answers
 * rather than absences, both are about to be raised by the caller's own asserts,
 * and neither is a page worth poking at repeatedly.
 */
async function rereadWhileTheFormCouldStillAppear(
  session: BrowserSession,
  first: FormSignals
): Promise<{ signals: FormSignals; rereads: number }> {
  let signals = first;
  let rereads = 0;

  for (const delayMs of FORM_REREAD_BACKOFF_MS) {
    if (!readIsEmptyHanded(signals)) break;
    if (signals.captchaPresent || signals.applicationLikelySubmitted) break;
    console.warn(
      `${LOG} nothing on screen yet at "${signals.url}" (${signals.textLength} characters of ` +
        `text, ${signals.fileInputCount} file inputs, no form and no apply control); ` +
        `reading it again in ${delayMs}ms`
    );
    await sleep(delayMs);
    signals = await readFormSignals(session);
    rereads += 1;
  }

  return { signals, rereads };
}

async function reachApplicationForm(
  session: BrowserSession,
  state: ApplicationState,
  after: FormSignals | null
): Promise<FormSignals> {
  let signals = after;
  let clickedApplyControl = false;
  /**
   * Every look this function has had at the page, including the one that
   * produced the signals it was handed.
   *
   * Starts at one because `signals` is always the product of a read, whether
   * `completeVerification` made it or the branch below does. Counted rather than
   * derived, because the failure message quotes it and there are three separate
   * places a read happens: here, the re-read loop, and after each apply click.
   * Deriving it from any one of them under-reports the others.
   */
  let pageReads = 1;

  if (signals === null || !signals.applicationFormPresent) {
    // ── Warm-up navigation (issue #88) ────────────────────────────────────────
    // Visit the company's careers/jobs page for 2–4 seconds before the specific
    // job URL. A cold direct-navigate to a deep apply link is a clear bot signal;
    // arriving from a parent page that we visibly spent time on is not.
    const warmUpUrl = deriveWarmUpUrl(state.applyUrl);
    if (warmUpUrl !== state.applyUrl) {
      console.log(`${LOG} warm-up navigation → ${warmUpUrl}`);
      try {
        await session.page.goto(warmUpUrl, { timeout: NAVIGATION_TIMEOUT_MS });
        await sleep(warmUpDwellMs());
      } catch {
        // Best-effort: if the careers page is unreachable, proceed to the job URL.
        console.warn(`${LOG} warm-up navigation to ${warmUpUrl} failed — proceeding to job URL`);
      }
    }
    console.log(`${LOG} navigate → ${state.applyUrl}`);
    await session.page.goto(state.applyUrl, { timeout: NAVIGATION_TIMEOUT_MS });
    signals = await readFormSignals(session);
    // JOB-021, and only on the branch that navigated: a page handed over by
    // `completeVerification` has already been read once on a settled DOM, and
    // re-reading it here would be paying for an extraction to learn what the
    // caller just told us.
    //
    // Above the board check below rather than under it, so that check sees
    // where the browser ended up rather than where it was six seconds earlier.
    // The re-reads cost nothing on the path that check exists for: a page that
    // was substituted for this listing is a page with a form on it, so it is
    // never empty-handed and the loop below breaks on its first line.
    const settled = await rereadWhileTheFormCouldStillAppear(session, signals);
    signals = settled.signals;
    pageReads += settled.rereads;
  }
  // Unconditional, and not only on the branch that navigated. The `goto` above
  // is the redirect this catches most often, but the branch that skips it is
  // reached with a page `completeVerification` opened from an emailed link,
  // which is allowed onto a wider set of hosts than a form may be filled on.
  await assertStillOnTheBoard(session, state, "having opened the listing");
  console.log(`${LOG} at ${signals.url} — "${signals.title}"`);
  assertNoCaptcha(signals, "the application page");
  assertNotAlreadySubmitted(signals, "the application page");

  // A sign-in wall in front of the form. Only crossed with a password this
  // pipeline itself generated and stored.
  if (!signals.applicationFormPresent && signals.passwordFieldCount > 0) {
    signals = await signIn(session, state, signals);
    assertNoCaptcha(signals, "the page after signing in");
    assertNotAlreadySubmitted(signals, "the page after signing in");
  }

  for (let round = 0; round < APPLY_CLICK_ROUNDS; round++) {
    if (signals.applicationFormPresent) break;
    if (!signals.applyControlPresent) break;
    const clicked = await clickControl(
      session,
      signals.url,
      "the control that opens the application form",
      INSTRUCTIONS.APPLY_START,
      // JOB-036. SmartRecruiters never says "Apply" anywhere on a listing page —
      // its own call to action reads "I'm Interested" — so this accept pattern
      // has to recognise that wording too, or a correctly-resolved control is
      // refused as unidentified and the run gives up having clicked nothing. See
      // `INSTRUCTIONS.APPLY_START` and `FormSignalsSchema.applyControlPresent`
      // above, which needed the same widening for the same reason.
      /(apply|application|start|begin|continue|interest)/i
    );
    if (clicked === null) break;
    clickedApplyControl = true;
    signals = await readFormSignals(session);
    pageReads += 1;
    // The control that opens an application form is a link like any other, and
    // where it led is a fact about this run rather than about the listing.
    await assertStillOnTheBoard(session, state, "after clicking through to the application form");
    assertNoCaptcha(signals, "the page after opening the application");
    assertNotAlreadySubmitted(signals, "the page after opening the application");
  }

  if (!signals.applicationFormPresent) {
    // `assertNotAlreadySubmitted` is the primary check for "a click submitted
    // this instead of opening a form" — this is the fallback for when that
    // signal itself missed it. Never say "nothing was typed" as if that meant
    // "nothing happened": if a click occurred, its effect on the board is
    // unconfirmed, not absent, and a human should not read this as a safe
    // no-op to retry past.
    throw new FormFillBlockedError(
      `Could not reach the job application form. Ended at "${signals.url}" ("${signals.title}", ` +
        `${signals.textLength} characters of text) with no application form on screen ` +
        `(password fields: ${signals.passwordFieldCount}, file inputs: ${signals.fileInputCount}, ` +
        `iframes: ${signals.iframeCount}` +
        // JOB-052. What the DOM itself found, so this message can no longer be
        // read as "the page was empty" when the page was full of controls the
        // reader could not see. An empty list here is the honest report that
        // both the model and the DOM came up with nothing.
        `, applicant fields the DOM could see: ` +
        `${signals.domCoreSlots.length === 0 ? "none" : signals.domCoreSlots.join(", ")}). ` +
        // JOB-021. Says that the page was given time, because without it this
        // sentence reads identically for "the board has no form we can use" and
        // "we read a careers SPA before it had mounted one", and those want
        // opposite responses from whoever picks this up.
        //
        // Describes the wait rather than claiming an outcome for it. A settle
        // that expires is still a wait, and a longer one; saying the content
        // "attached and stopped changing" would assert something this run may
        // have failed to observe, which is the exact species of misleading log
        // that made the original failure take so long to read. When a settle
        // does expire it says so itself, at warn level, right above this.
        //
        // Do not reword this to say the wait "timed out", however natural that
        // reads. `skipReasonFor` in `lib/application-records.ts` matches
        // `/\btimed? ?out\b|timeout/i` against this whole message and files the
        // row under `timeout` when it hits, so that phrasing would quietly move
        // every unreachable form out of the bucket this ticket is measured in.
        `The page was read ${pageReads} time${pageReads === 1 ? "" : "s"}, each after waiting ` +
        `for it to finish arriving. ` +
        (clickedApplyControl
          ? `A control was clicked while trying to reach the form, and its effect on the board is ` +
            `unconfirmed — this is NOT the same as "nothing happened". If that control's label ` +
            `suggested it directly applies rather than opening a form, treat this row as possibly ` +
            `already applied to and do not retry automatically.`
          : `Nothing was clicked or typed.`)
    );
  }
  return signals;
}

/**
 * A sign-in wall in front of an application form. Always a stop (JOB-004).
 *
 * ── What this used to do, and why it does not ───────────────────────────────
 * actinno signed in here, with a password its own account creation step (ACT-004
 * and ACT-005) had generated and stored on `job_applications.board_password`.
 * Jobinno runs no such step: creating an account on an employer's site is a V2
 * question that has not been answered, and there is deliberately no column in
 * `lib/db/schema.ts` to hold a board password. So there is no credential to
 * type, and every path that reaches this function is a listing this version
 * cannot apply to.
 *
 * The implementation is not carried here as unreachable code. It is intact in
 * the actinno checkout at `/Users/pranavlende/code/actinno`, which CLAUDE.md
 * keeps read only for exactly this purpose, and the ticket that brings account
 * creation back should port it from there along with the rest of the flow it
 * belongs to. What is kept here is the reason, because that is the part that
 * would otherwise be lost.
 *
 * `session` is still in the signature and still unused. The caller passes it,
 * and the day this becomes a real sign-in again it needs it.
 */
async function signIn(
  _session: BrowserSession,
  _state: ApplicationState,
  signals: FormSignals
): Promise<FormSignals> {
  throw new FormFillBlockedError(
    `A sign-in form is in front of the application at "${signals.url}", and Jobinno holds no ` +
      `account on this board. Creating one on an employer's site is deliberately out of scope ` +
      `for this version, so this listing cannot be applied to automatically. Nothing was typed.`
  );
}

// ───────────────────────────────────
// Filling
// ───────────────────────────────────

type FieldPlan = {
  key: FieldKey;
  instruction: string;
  /** `null` when the resume yielded nothing for a field the form does have. */
  value: string | null;
  present: boolean;
  multiline: boolean;
  /** Read-back comparison. Boards reformat phone numbers, so not every field compares literally. */
  normalize: (value: string) => string;
  /**
   * Skip DOM corroboration for this field. Used for fields whose label inherently overlaps
   * another key's regex (e.g. "Confirm email" matches both confirmEmail and email), where
   * the instruction is specific enough to trust Stagehand's observe() result directly.
   */
  skipCorroboration?: boolean;
};

const plainCompare = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Phone numbers compare on their last ten digits. Boards routinely strip a
 * country code, re-add one, or reformat the separators, and none of that means
 * a different number reached the field.
 */
const phoneCompare = (value: string): string => value.replace(/\D/g, "").slice(-10);

function buildFieldPlan(
  profile: ResumeProfile,
  signals: FormSignals,
  coverLetter: string | null
): FieldPlan[] {
  const plan: FieldPlan[] = [];
  const add = (
    key: FieldKey,
    instruction: string,
    value: string | null,
    present: boolean,
    options: { multiline?: boolean; normalize?: (v: string) => string; skipCorroboration?: boolean } = {}
  ): void => {
    // A field the form does not have and the resume did not fill is not worth a
    // line in the report. A field the form *does* have but the resume could not
    // fill very much is — that is a blank box on a real application, and the
    // human reviewing this needs to see it.
    if ((value === null || value === "") && !present) return;
    plan.push({
      key,
      instruction,
      value: value === "" ? null : value,
      present,
      multiline: options.multiline === true,
      normalize: options.normalize ?? plainCompare,
      ...(options.skipCorroboration ? { skipCorroboration: true } : {}),
    });
  };

  // A single "Full name" box is only planned when the form has no split fields,
  // so the two shapes can never both fire on the same page.
  const splitName = signals.firstNameFieldPresent || signals.lastNameFieldPresent;
  add(
    "firstName",
    INSTRUCTIONS.FIRST_NAME,
    profile.firstName,
    signals.firstNameFieldPresent
  );
  add("lastName", INSTRUCTIONS.LAST_NAME, profile.lastName, signals.lastNameFieldPresent);
  add(
    "fullName",
    INSTRUCTIONS.FULL_NAME,
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null,
    !splitName && signals.fullNameFieldPresent
  );
  add("email", INSTRUCTIONS.EMAIL, profile.email, signals.emailFieldPresent);
  // Many boards (SmartRecruiters, some Workable forms) require a confirm-email
  // field. Its label always overlaps the primary email regex, so corroboration is
  // skipped — the specific instruction is what identifies the field instead.
  // `present: signals.emailFieldPresent` is a proxy: if there is an email field
  // there may be a confirm-email field. If the form has none, tryResolveAction
  // returns null and the entry records "not-on-form" without any side effect.
  if (profile.email) {
    add("confirmEmail", INSTRUCTIONS.CONFIRM_EMAIL, profile.email, signals.emailFieldPresent, {
      skipCorroboration: true,
    });
  }
  // JOB-051. There was a "city" entry here that filled the location picker with a
  // bare `stagehand.act()`, on the reasoning that an autocomplete needs a
  // type-then-click-suggestion sequence `typeInto` cannot do alone. The reasoning
  // about the widget was right; using `act()` for it was not. `act()` does not
  // throw when it changes nothing, and this path had no read back at all, so it
  // reported the field "filled" on the very run whose captured DOM shows the
  // board's own "Please enter your location" error against an empty control.
  //
  // The location control is a `combobox` to `enumerateFormFields` and is required,
  // so `fillRemainingFields` now picks it up and drives it through
  // `chooseFromMenu`, which types, waits for the suggestions to arrive, chooses
  // one by the widget's own highlight, and reads back what the control ends up
  // holding. See `contextTerms` at that call site for how one city name shared by
  // four countries is resolved from what the candidate attested.
  //
  // JOB-047 reached the same conclusion from the other board: on SmartRecruiters
  // the same `act()` entry reported "filled via unstructured act()" while the
  // form showed "Please provide your place of residence" against an empty City.
  // Two boards, one disproven mechanism, removed rather than left disabled.
  add("phone", INSTRUCTIONS.PHONE, profile.phone, signals.phoneFieldPresent, {
    normalize: phoneCompare,
  });
  add("linkedin", INSTRUCTIONS.LINKEDIN, profile.linkedinUrl, signals.linkedinFieldPresent);
  add("website", INSTRUCTIONS.WEBSITE, profile.websiteUrl, signals.websiteFieldPresent);
  // Only planned when a letter was actually written, i.e. when the listing
  // required one. A form with a cover-letter box and no requirement is left
  // alone — the `coverLetter` block of the report says why.
  if (coverLetter !== null) {
    add("coverLetter", INSTRUCTIONS.COVER_LETTER_TEXT, coverLetter, signals.coverLetterTextAreaPresent, {
      multiline: true,
      // Boards trim and re-wrap long text; comparing the opening sentence is
      // enough to prove the right text landed in the right box.
      normalize: (value) => plainCompare(value).slice(0, 120),
    });
  }

  return plan;
}

/** What the DOM check made of a resolved control, after any retry it earned. */
type FieldCorroboration =
  | { ok: true; check: { ok: true; via: string } }
  | { ok: false; why: string; resolved: ResolvedAction | null };

/**
 * JOB-006. Checks a resolved control against DOM truth, and gives a replayed one
 * a single live observation before believing the bad news.
 *
 * This is the guarantee that makes the shared cache safe to turn on. A stored
 * selector was worked out on some other company's posting, so the interesting
 * question is not whether it can be wrong but what happens when it is. Without
 * this, a wrong replay would corroborate as "that control calls itself something
 * else" and the field would be reported skipped and left blank, which is a real
 * regression against observing live. With it, the plan entry is dropped, the
 * model is asked, and the run continues exactly as it would have before the
 * cache existed. A wrong row can therefore cost money and never correctness.
 *
 * A freshly observed control gets no retry. There is nothing to retry with:
 * asking the same model the same question about the same page is not a second
 * opinion.
 */
async function corroborateResolved(
  session: BrowserSession,
  url: string,
  field: FieldPlan,
  resolved: ResolvedAction
): Promise<FieldCorroboration> {
  const judge = async (candidate: ResolvedAction): Promise<{ ok: true; via: string } | { ok: false; why: string }> => {
    const descriptor = await describeControl(session.page, candidate.action.selector);
    return corroborate(
      field.key,
      descriptor,
      candidate.action.description,
      field.multiline,
      candidate.replayed
    );
  };

  const first = await judge(resolved);
  if (first.ok) return { ok: true, check: first };
  if (!resolved.replayed) return { ok: false, why: first.why, resolved };

  const fresh = await reResolveLive(session, url, field.instruction, first.why);
  if (fresh === null) return { ok: false, why: first.why, resolved: null };

  const second = await judge(fresh);
  if (second.ok) return { ok: true, check: second };
  return { ok: false, why: second.why, resolved: fresh };
}

async function fillFields(
  session: BrowserSession,
  url: string,
  plan: readonly FieldPlan[]
): Promise<FieldOutcome[]> {
  const outcomes: FieldOutcome[] = [];

  for (const field of plan) {
    if (!field.present) {
      outcomes.push({
        field: field.key,
        intended: field.value,
        outcome: "not-on-form",
        detail: "the page reader did not see this field on the application form",
      });
      continue;
    }
    if (field.value === null) {
      // The form asks for it and the resume did not answer. Left blank rather
      // than invented — and said out loud, because it is a blank box on a real
      // application that a human may want to fill in before ACT-008 runs.
      outcomes.push({
        field: field.key,
        intended: null,
        outcome: "skipped",
        detail:
          "the form has this field but nothing was parsed from the resume for it — left blank " +
          "rather than guessed",
      });
      continue;
    }

    const resolved = await tryResolveAction(session, url, field.instruction);
    if (resolved === null) {
      outcomes.push({
        field: field.key,
        intended: field.value,
        outcome: "not-on-form",
        detail: "no control on the page matched this field",
      });
      continue;
    }

    let checkVia = "instruction (corroboration skipped — label overlaps another key's regex)";
    if (!field.skipCorroboration) {
      const checked = await corroborateResolved(session, url, field, resolved);
      if (!checked.ok) {
        // Fail closed at field level: a wrong value in a real employer's form is
        // worse than a blank one a human can fill in.
        outcomes.push({
          field: field.key,
          intended: field.value,
          outcome: checked.resolved === null ? "not-on-form" : "skipped",
          detail:
            checked.resolved === null
              ? "no control on the page matched this field"
              : `not filled — ${checked.why}`,
        });
        console.warn(`${LOG} skipping ${field.key}: ${checked.why}`);
        continue;
      }
      checkVia = checked.check.via;
    }

    await sleep(randomInteractionDelayMs());
    const used = await typeInto(session, url, field.instruction, field.value);
    const readBack = await readControlValue(session.page, used.selector);
    const matches =
      readBack !== null && field.normalize(readBack) === field.normalize(field.value);

    outcomes.push({
      field: field.key,
      intended: field.value,
      outcome: matches ? "filled" : readBack === null ? "filled" : "mismatch",
      readBack,
      detail: matches
        ? `filled and read back identical (identified by ${checkVia})`
        : readBack === null
          ? `filled, but the value could not be read back for confirmation (identified by ${checkVia})`
          : `the control now reads ${JSON.stringify(readBack)}, which is not what was typed`,
    });
    console.log(
      `${LOG} ${field.key}: ${matches ? "filled + verified" : readBack === null ? "filled (unverified)" : "MISMATCH"}`
    );
  }

  return outcomes;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACT-015 — every other field on the form
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything above this line fills the eight fields ACT-007 knew by name.
// Everything below fills whatever else the form turned out to have, through the
// perception → decision → action split described in this file's header.

/** Kinds whose value is chosen from a list rather than typed. */
const OPTION_KINDS: ReadonlySet<FormFieldKind> = new Set(["select", "combobox", "radio"]);

/**
 * How many free-text answers one form may have written for it.
 *
 * A bound rather than a policy: each one is a paid model call. It was three,
 * which is fewer than a real application form asks for. The Netic and Deepgram
 * forms in the 2026 08 20 run each asked two or three short answer questions on
 * top of a cover letter, and a form that runs out of budget halfway leaves the
 * board's own validation to reject what is left. Twelve is still a bound and is
 * comfortably above what any of the observed forms wanted.
 */
const MAX_GENERATED_ANSWERS = 12;

/** Countries whose name means "the US" for the purpose of a derived fact. */
const US_COUNTRY_RE = /^(the\s+)?(united\s+states(\s+of\s+america)?|u\.?s\.?a?\.?|america)$/i;

/**
 * ── JOB-022: where "answer it as best you can" stops ─────────────────────────
 *
 * The product decision this ticket implements is that a filled application with
 * a slightly imperfect answer beats a blocked application, every time. A form
 * asking which school somebody attends, when they graduate, how many years of
 * experience they have, how they heard about the company or what their top
 * office preference is gets the best answer the profile and resume support, and
 * the run keeps going. Being a little off on any of those costs nothing.
 *
 * These do not work that way. Every question this pattern matches is a legal
 * attestation on an employment application, and a wrong answer to one of them
 * is the kind of thing that gets an offer rescinded or a clearance denied months
 * later, long after nobody remembers a form was filled automatically. Work
 * authorization, citizenship, visa and sponsorship, security clearance, export
 * control status and criminal history all sit here; demographic questions are
 * handled one step earlier by `EEO_FIELD_RE` and never reach this.
 *
 * The rule for a match is a strict ladder, in this order:
 *
 *  1. If the candidate's own stored answer covers it, use that. This is the
 *     common case now that `citizenship_status`, `f1_status`, `work_authorized_us`
 *     and `requires_sponsorship` actually reach the fact catalogue, and it is
 *     the whole reason those four columns were plumbed through in this ticket.
 *     JOB-101 added four more of exactly this kind — `clearance_eligibility`,
 *     `clearance_level_held`, `visa_status` and `needs_sponsorship_non_us` —
 *     each because a real run stopped on a question the candidate could answer
 *     in seconds and had never been asked. Note what that does and does not
 *     change: step 1 got wider, the ladder did not get shorter. Which stored
 *     fact may back which question is still decided by
 *     `attestationFactAllowed`, and a clearance question backed by a work
 *     authorization fact is refused now exactly as it was before.
 *  2. Otherwise, if the control offers a way to decline, decline. Forms almost
 *     always offer one, and declining is truthful.
 *  3. Only if it is required, offers no decline option, and the stored data does
 *     not answer it does the run stop. That is the narrow, well labelled
 *     `needs_attestation` outcome, and it should be rare.
 *
 * Nothing here is ever inferred, generated or best guessed, whatever the model
 * proposes. That is enforced in `resolveDecision` in TypeScript rather than
 * asked for in a prompt.
 *
 * ── Issue #100 added the restrictive covenants ──────────────────────────────
 * The same Avery Dennison run that ticked a privacy declaration also answered
 * "No" to a non-compete question, from a model, with nothing behind it. That is
 * the identical shape of error as the felony case above: a statement about a
 * legal obligation the candidate may or may not be under, made by a system that
 * has never been told either way, on a form the candidate signs. Whether
 * somebody is bound by a non-compete, a non-solicitation clause or any other
 * restrictive covenant is a fact about their existing contracts, and this system
 * holds no such fact — so, exactly like criminal history, the ladder can only
 * ever reach step 2 or step 3 for one. `ATTESTATION_FACT_SCOPES` names no topic
 * that matches these labels, so no stored fact can back one either.
 */
export const LEGAL_ATTESTATION_RE =
  /\b(?:work(?:ing)?\s+authoriz\w*|authoriz\w*\s+to\s+work|right\s+to\s+work|legally\s+(?:authoriz\w*|entitled|permitted|eligible)|citizen\w*|nationality|permanent\s+resident\w*|green\s+card|visa|sponsor\w*|immigration|work\s+permit|security\s+clearance|clearance\s+eligib\w*|clearance|export\s+control\w*|itar|u\.?\s?s\.?\s+person|felony|felonies|misdemean\w*|convict\w*|criminal\s+(?:history|record|background|conviction\w*)|background\s+check|non[-\s]?compet\w*|noncompet\w*|non[-\s]?solicit\w*|nonsolicit\w*|restrictive\s+covenant\w*)\b/i;

/**
 * A proposed value that announces the absence of an answer instead of being
 * one: "Not provided", "N/A", "Unknown", "None", "TBD", a lone dash.
 *
 * Anchored end to end on purpose. It has to catch a whole value that is
 * nothing but filler while never touching a real answer that happens to
 * contain one of these words — "None of the above" is a real option on
 * Anduril's export control question, "Not applicable to my situation, because
 * ..." is a real sentence somebody might genuinely write, and a street called
 * "Unknown Road" is a real address. Only the bare placeholder matches.
 *
 * See `inferOrAsk`, the one place this is consulted, for the real run that
 * made it necessary and for why it is scoped to typed text rather than to
 * options a form itself offers.
 */
export const NON_ANSWER_RE =
  /^[\s.,'"-]*(?:n\s*\/?\s*a|not\s+applicable|not\s+provided|not\s+specified|not\s+available|not\s+stated|no\s+answer|none|nil|null|unknown|unspecified|undisclosed|tbd|to\s+be\s+determined|prefer\s+not\s+to\s+say|-+|—+)[\s.,'"-]*$/i;

/**
 * The only facts allowed to answer a legal attestation.
 *
 * ── Added after review on this PR, and it is the most important line here ───
 * The ladder above was written as though naming a fact were the same as citing a
 * relevant one. It is not. `optionSupportsFact` compares the fact's VALUE to the
 * option's TEXT and never looks at the question, so every Yes/No fact in the
 * catalogue licensed every Yes/No attestation on the form. Both of these were
 * reproduced against this module before the allow-list existed:
 *
 *   "Are you a U.S. Person as defined by ITAR?"      → Yes, citing willingToRelocate
 *   "Have you ever been convicted of a felony?"      → No,  citing requiresSponsorship
 *
 * Neither fact says anything whatsoever about the question asked. The first is a
 * false statement to a defence contractor about export-control status; the
 * second is a criminal-history declaration backed by a visa answer. That the
 * second happens to be true of this candidate is luck, not correctness, and luck
 * is not a property a form filler may rely on.
 *
 * So the gate is on the fact KEY, checked before the value is ever compared.
 *
 * It is scoped per topic rather than being one flat list, and that distinction
 * is load bearing. A flat list of "the status facts" fixes the ITAR case and
 * leaves the felony one standing, because `requiresSponsorship` is a perfectly
 * legitimate attestation fact, just not for THAT question. Only a table that
 * knows which questions a fact is about can say so. The topics below are the
 * categories named in the carve-out, and each lists the facts that genuinely
 * bear on it:
 *
 *  · Work authorization and sponsorship have the facts that answer them, which
 *    since JOB-101 includes the visa status the candidate stated in their own
 *    words and the separate non-US sponsorship answer (see the jurisdiction
 *    rule in `attestationFactAllowed`).
 *  · Citizenship, nationality, residency and export control have the citizenship
 *    status and the yes/no restatements derived from it.
 *  · Security clearance has the two clearance answers intake now collects and
 *    the yes/no restatements of them, and nothing else. This list used to be
 *    empty, and it was empty for the right reason at the time: intake did not
 *    ask, so nothing in the catalogue knew, so nothing could truthfully back a
 *    clearance question. JOB-101 changed the premise rather than the rule. The
 *    candidate now states their eligibility and the level they have held, and
 *    those two facts are the only things that may answer a clearance question
 *    — a work authorization fact still may not, which is the exact pairing a
 *    real run produced before the allow-list existed.
 *  · Criminal history still has NONE, and always will unless a ticket decides
 *    otherwise out loud. Intake does not ask, nothing in the catalogue implies
 *    it, and so nothing may back one except the candidate's own typed answer.
 *    That is not an oversight to be filled in later with a guess; it is the
 *    correct answer to "what do we know about this person's criminal record",
 *    which is nothing.
 *
 * `answer:*` is allowed everywhere: it is the candidate answering the question
 * themselves in a previous `needsInput` round, the highest-quality fact in the
 * catalogue and the whole point of that loop.
 *
 * A label matching more than one topic gets the union, not the intersection.
 * Anduril really does ask "U.S. Person status and/or U.S. clearance eligibility
 * ... are you eligible to meet this requirement?" as one Yes/No, and a stored
 * export-control status is a truthful answer to it. Requiring a fact to satisfy
 * every topic a compound label touches would decline that one, and declining a
 * question the candidate's own data answers is the failure this ticket exists to
 * fix.
 *
 * A fact outside the list does not fail the field. It drops to step 2 of the
 * ladder, the control's own decline option, exactly as a missing fact would.
 */
const ATTESTATION_FACT_SCOPES: readonly [RegExp, RegExp][] = [
  [
    /\b(?:work(?:ing)?\s+authoriz\w*|authoriz\w*\s+to\s+work|right\s+to\s+work|legally\s+(?:authoriz\w*|entitled|permitted|eligible)|sponsor\w*|visa|work\s+permit|immigration)\b/i,
    /^(?:workAuthorizedUs|requiresSponsorship|needsSponsorshipNonUs|visaStatus|citizenshipStatus|f1Status|isUs(?:Citizen|PermanentResident|PersonForExportControl))$/,
  ],
  [
    /\b(?:citizen\w*|nationality|permanent\s+resident\w*|green\s+card|export\s+control\w*|itar|u\.?\s?s\.?\s+person)\b/i,
    /^(?:citizenshipStatus|f1Status|isUs(?:Citizen|PermanentResident|PersonForExportControl))$/,
  ],
  // JOB-101. Clearance admits the two answers the candidate now states and the
  // yes/no restatements of them, and nothing else. Criminal history still
  // admits nothing at all. See above for why those two are different cases.
  [
    /\b(?:security\s+clearance|clearance\s+eligib\w*|clearance)\b/i,
    /^(?:clearanceEligibility|clearanceLevelHeld|holdsActiveUsClearance|isEligibleForUsClearance|hasEverHeldUsClearance)$/,
  ],
  // JOB-134. Restrictive covenants, admitting exactly one fact: the answer the
  // candidate gave at intake to this exact question. The header above says this
  // topic could only ever reach step 2 or step 3 of the ladder, and the reason
  // it gave was that "this system holds no such fact". That premise is what
  // changed, not the rule — the same move JOB-101 made for security clearance,
  // whose list was empty for the same reason and is no longer. What has not
  // changed: a sponsorship fact still cannot answer a non-compete question, and
  // `restrictiveCovenant` still cannot answer anything except this one.
  [
    /\b(?:non[-\s]?compet\w*|noncompet\w*|non[-\s]?solicit\w*|nonsolicit\w*|restrictive\s+covenant\w*)\b/i,
    /^restrictiveCovenant$/,
  ],
  [
    /\b(?:felony|felonies|misdemean\w*|convict\w*|criminal\s+(?:history|record|background|conviction\w*)|background\s+check)\b/i,
    /^$/,
  ],
];

/**
 * ── Issue #108: the jurisdiction has to be in the rule, not in the prose ────
 *
 * Every fact key below is a statement about the United States and about nowhere
 * else. `requires_sponsorship` is derived from a US citizenship status,
 * `work_authorized_us` says so in its own name, the citizenship restatements
 * are all "is a United States ...", and a US security clearance is US by
 * definition.
 *
 * What made this a bug rather than a tidiness point is that the fact keys carry
 * that "US" implicitly and the questions do not have to share it. On Virtu's UK
 * sponsorship question — "Do you now, or will you in the future, need
 * sponsorship from an employer in order to obtain, extend or renew your
 * authorization to work in the UK?" — the same form was run seven times and
 * answered "No" from `requiresSponsorship` four of them, escalating the other
 * three on the reasoning that a US work authorization fact does not establish a
 * UK one. A separate run answered an Irish version of the question the same
 * way. The candidate is a US citizen with no UK or Irish work authorization, so
 * "No" is false, and it is false about the one subject `LEGAL_ATTESTATION_RE`'s
 * own header names as the kind of thing that costs somebody an offer months
 * later.
 *
 * The non-determinism is the tell: safety rested on the model noticing a
 * jurisdiction mismatch in prose. It notices about half the time. So the rule
 * moves into TypeScript, and it runs in both directions — a US-only fact may
 * not answer a question that names somewhere else, and the non-US sponsorship
 * answer may not answer a question that does not.
 */
const US_ONLY_FACT_KEYS =
  /^(?:workAuthorizedUs|requiresSponsorship|citizenshipStatus|f1Status|isUs(?:Citizen|PermanentResident|PersonForExportControl)|clearanceEligibility|clearanceLevelHeld|holdsActiveUsClearance|isEligibleForUsClearance|hasEverHeldUsClearance)$/;

/** The mirror image: facts that are about anywhere EXCEPT the United States. */
const NON_US_FACT_KEYS = /^(?:needsSponsorshipNonUs)$/;

/**
 * A question that names a jurisdiction other than the United States.
 *
 * Deliberately a list of the places these forms actually name rather than an
 * attempt at every country on earth. A country this misses is a question that
 * behaves exactly as it did before this rule existed, which is the direction a
 * gap in a list like this should fail in; a false positive, by contrast, only
 * ever costs an escalation, which is the safe outcome for an attestation.
 *
 * Note what this deliberately does not do: it does not ask whether the question
 * also names the United States. A question naming both, "authorized to work in
 * the US or the UK", is still one a US-only fact cannot truthfully answer, so
 * naming somewhere else is enough on its own to disqualify those facts. Reading
 * a US mention as permission would be the whole bug again with an extra step.
 */
const NON_US_JURISDICTION_RE =
  /\b(?:united\s+kingdom|u\.?\s?k\.?|great\s+britain|britain|british|england|scotland|wales|northern\s+ireland|ireland|irish|eire|canada|canadian|australia|australian|new\s+zealand|singapore|india|germany|german|france|french|netherlands|dutch|switzerland|swiss|spain|italy|poland|sweden|norway|denmark|japan|japanese|china|chinese|hong\s+kong|israel|brazil|mexico|european\s+union|\beu\b|\beea\b|schengen)\b/i;

/** Whether `factKey` is one this attestation question may be answered from. */
function attestationFactAllowed(label: string, factKey: string): boolean {
  if (factKey.startsWith("answer:")) return true;

  // Issue #108. Jurisdiction first, before the topic table is consulted at all,
  // because a fact can be perfectly on topic and still be about the wrong
  // country — which is precisely what a US sponsorship answer is on a UK form.
  const namesElsewhere = NON_US_JURISDICTION_RE.test(label);
  if (namesElsewhere && US_ONLY_FACT_KEYS.test(factKey)) return false;
  if (!namesElsewhere && NON_US_FACT_KEYS.test(factKey)) return false;

  return ATTESTATION_FACT_SCOPES.some(
    ([topic, allowed]) => topic.test(label) && allowed.test(factKey)
  );
}

/**
 * Whether a field is one of the two categories that are never best guessed.
 *
 * Kept as one predicate so that the fill loop, the policy function and the tests
 * all ask the same question, rather than three places each remembering to check
 * both regexes.
 */
export function isAttestationField(label: string): boolean {
  return EEO_FIELD_RE.test(label) || LEGAL_ATTESTATION_RE.test(label);
}

/**
 * Controls whose only way of holding a value is an assertion the candidate makes.
 *
 * A ticked box says "yes, I do" and a chosen radio says "this one is true of
 * me". Neither has a spelling that means "here is a piece of information about
 * me" the way a typed address does, so there is no such thing as a harmless
 * automatic answer to one that nobody chose. This set is the whole basis of the
 * refusal in `fallbackRefusalReason` below, and it is deliberately about the
 * shape of the control and not about a single word of its label.
 */
const ASSERTING_KINDS: ReadonlySet<FormFieldKind> = new Set(["checkbox", "radio"]);

/**
 * ── Issue #100: why the unknown-field fallback may not touch this ────────────
 *
 * The fallback near the bottom of `fillRemainingFields` hands a page-derived
 * label to `act()` and asks for "the most appropriate value for a job
 * applicant". Until this ticket the only thing standing between that and a
 * legal commitment made in a real person's name was `isAttestationField`, which
 * is two regexes. On a live Avery Dennison run those regexes did not match "By
 * checking this box you declare that you have read and understood the Privacy
 * Notice", and the fallback ticked it.
 *
 * Widening the regexes was worth doing and is done — see `CONSENT_FIELD_RE` and
 * `LEGAL_ATTESTATION_RE`, both of which now match that sentence and the
 * non-compete question from the same run. But a regex is the wrong last line of
 * defence for "is this a legal commitment", because it can only ever hold the
 * wordings somebody already thought of, and the next board will write the next
 * sentence. Every widening of it is a fix for one run that has already gone
 * wrong.
 *
 * So the first rule below does not read the label at all. A checkbox or a radio
 * group is refused for being a checkbox or a radio group: whatever the words
 * next to it say, ticking it is the candidate asserting something, and this
 * fallback is not entitled to assert anything on their behalf. That check
 * cannot be defeated by unanticipated wording, because it never looks at the
 * wording. The pattern checks that follow it are a second layer over the
 * typed and chosen-from-a-list controls that remain, not the load-bearing one.
 *
 * Returns the reason the fallback must leave this item alone, or null when it
 * may attempt it. Exported so the refusal can be tested at the level it is
 * decided, without a browser.
 */
export function fallbackRefusalReason(item: NeedsInputItem): string | null {
  if (!item.required) {
    return "an optional question, which blocks nothing and is better asked than guessed at";
  }
  if (ASSERTING_KINDS.has(item.kind)) {
    return (
      `a ${item.kind} is answered by asserting something rather than by reporting it, and ` +
      `this fallback never asserts anything in the candidate's name`
    );
  }
  if (CONSENT_FIELD_RE.test(item.fieldLabel)) {
    return "an agreement, consent or declaration, which only the candidate can give";
  }
  if (isAttestationField(item.fieldLabel)) {
    return "a legal attestation or a demographic question, which is never best guessed";
  }
  return null;
}

/**
 * Everything this system knows about the candidate, as a keyed catalogue.
 *
 * ── What JOB-022 changed, and why ───────────────────────────────────────────
 * This used to be seventeen entries, and the header above it argued that a short
 * catalogue was a feature: the exact set of assertions the system is entitled to
 * make, with everything outside it becoming a question to the candidate.
 *
 * The argument was right about attestations and wrong about everything else, and
 * production settled it. On 2026 08 20 the pipeline reached the application form
 * on 20 of 21 listings and then refused to finish 18 of them, and the log line
 * for each names the fact it did not have: a graduation month and year, a start
 * date, a school, a degree, a GitHub link, a years of experience count, a top
 * location preference, a visa status, an export control status. Every single one
 * of those was already sitting in `profiles` or in the parsed resume. The
 * catalogue was not the set of things known about the candidate; it was a
 * seventeen item subset of it, and everything outside the subset was reported to
 * the user as something the system could not truthfully answer, which was false.
 *
 * So the catalogue now carries what is actually known: every education entry
 * rather than the first, every job rather than the first, the skills list, the
 * links, the four intake columns nobody was reading, the stated target
 * locations, and a handful of facts derived in TypeScript from those (a
 * graduation year out of a graduation date, a years of experience count out of
 * the work history). It is still a closed catalogue, still keyed, and an
 * attestation field still may not be answered from anything outside it. What
 * changed is that it stopped being a list of the questions the system was
 * willing to answer and went back to being a description of the person.
 */
/**
 * JOB-112. Which document a work or education entry came from, said in the
 * fact's own label.
 *
 * The label is where this belongs rather than a new field on `CandidateFact`,
 * because the label is what actually travels: it is what `decideFieldAnswers`
 * reads when it chooses between two facts for one form field, and it is what a
 * skip_log row quotes when a run stops. A run that put the wrong graduation
 * date on a form can then be traced to the document that supplied it without
 * anyone re-deriving the parse to find out.
 *
 * Empty for a resume-sourced entry, which keeps every existing label and every
 * existing test unchanged: the resume was the only source before this ticket,
 * so "unlabelled" already means "from the resume".
 */
function sourceSuffix(source: DocumentSource | undefined): string {
  return source === "linkedin" ? " (from their LinkedIn export)" : "";
}

export function buildFactCatalog(
  profile: ResumeProfile,
  answers: CandidateApplicationAnswers,
  additionalAnswers: Record<string, string>
): CandidateFact[] {
  const facts: CandidateFact[] = [];
  const add = (key: string, label: string, value: string | null | undefined): void => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text !== "") facts.push({ key, label, value: text });
  };
  const yesNo = (value: boolean | undefined): string | null =>
    value === undefined ? null : value ? "Yes" : "No";

  add("firstName", "First name", profile.firstName);
  add("lastName", "Last name", profile.lastName);
  add(
    "fullName",
    "Full name",
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null
  );
  add("email", "Email address", profile.email);
  add("phone", "Phone number", profile.phone);
  add("linkedinUrl", "LinkedIn profile URL", profile.linkedinUrl);
  add("websiteUrl", "Personal website / portfolio URL", profile.websiteUrl);
  add("resumeLocation", "Location printed on their resume", profile.location);

  add("currentCountry", "Country they currently live in", answers.currentCountry);
  add("currentCity", "City they currently live in", answers.currentCity);
  add(
    "workAuthorizedUs",
    "Legally authorized to work in the United States",
    yesNo(answers.workAuthorizedUs)
  );
  // The label names the United States out loud, which it did not before JOB-101.
  // The column has always been a US only fact, derived from a US citizenship
  // status, but the sentence handed to the model did not say so, and issue #108
  // is what that cost: across seven runs of Virtu's UK sponsorship question the
  // model answered "No" from this fact four times and spotted the jurisdiction
  // mismatch three times. Saying it in the label is not the fix — that is
  // `attestationFactAllowed` below, in TypeScript — but a prompt that describes
  // a fact accurately should not be left describing it ambiguously.
  add(
    "requiresSponsorship",
    "Will now or in future require visa sponsorship to work in the United States",
    yesNo(answers.requiresSponsorship)
  );
  // Issue #108's other half: the jurisdiction the fact above never covered.
  add(
    "needsSponsorshipNonUs",
    "Will need visa sponsorship to work anywhere outside the United States",
    yesNo(answers.needsSponsorshipNonUs)
  );
  add("willingToRelocate", "Willing to relocate for a role", yesNo(answers.willingToRelocate));

  // A job applicant is by definition at least the minimum working age. Boards
  // that ask "Are you at least 18 years old?" are asking whether the candidate
  // is eligible to work, and a candidate who submitted a resume implicitly
  // asserts that they are. The constant "Yes" is not a guess; it is the only
  // answer that is consistent with being a job applicant at all.
  add("minimumAge", "At least 18 years old (minimum working age)", "Yes");

  // Derived, in TypeScript rather than by a model: "they live in the United
  // States" entails "they are currently located in the US". That is an
  // entailment, not an inference about a person, and boards ask it as often as
  // they ask for the country itself.
  if (answers.currentCountry !== undefined) {
    add(
      "locatedInUs",
      "Currently located in the United States (from the country they gave)",
      US_COUNTRY_RE.test(answers.currentCountry.trim()) ? "Yes" : "No"
    );
  }

  // ── JOB-022: the intake columns nobody was reading ───────────────────────
  add("citizenshipStatus", "Citizenship or immigration status they stated at intake",
    describeCitizenship(answers.citizenshipStatus, answers.f1Status));
  // The same stored status, projected onto the yes/no shape half these questions
  // are actually drawn with. Without this the flagship fix did not reach them:
  // "Are you a citizen or national of the United States?" with Yes/No options
  // could not be answered, because the sentence "A United States citizen or
  // national" does not say what the option "Yes" says, and the attestation
  // ladder has nothing else to try. Review caught that the correct fact bailed
  // while a wrong one passed, which is the worst possible pairing.
  //
  // Every arm is a restatement of one enum value, and a status the enum records
  // as "other" produces nothing at all rather than a guessed "No".
  for (const [key, label, value] of citizenshipYesNo(answers.citizenshipStatus)) {
    add(key, label, value);
  }
  add("earliestStartDate", "Earliest date they can start work (ISO)", answers.earliestStart);
  add("graduationDate", "Graduation date (ISO)", answers.gradDate);
  const gradParts = splitIsoDate(answers.gradDate);
  if (gradParts !== null) {
    add("graduationYear", "Year they graduate or graduated", gradParts.year);
    add("graduationMonth", "Month they graduate or graduated", gradParts.monthName);
  }
  const startParts = splitIsoDate(answers.earliestStart);
  if (startParts !== null) {
    add("earliestStartYear", "Year they can start work", startParts.year);
    add("earliestStartMonth", "Month they can start work", startParts.monthName);
  }
  if (answers.targetLocations !== undefined && answers.targetLocations.length > 0) {
    add(
      "targetLocations",
      "Places they said they want to work, most preferred first",
      answers.targetLocations.join(", ")
    );
    add("topLocationPreference", "Their most preferred work location", answers.targetLocations[0]);
  }

  // ── JOB-101: the answers that were blocking real applications ────────────
  //
  // The same shape as the JOB-022 block above and for the same reason: each one
  // is a column intake now collects, and a column the fill layer cannot name is
  // a column the decision layer cannot cite, because `resolveDecision` refuses
  // an answer with no `sourceFact` behind it.
  //
  // The clearance facts and the visa status are legal attestations. Listing
  // them here does not make them answerable by anything that happens to be
  // nearby: `attestationFactAllowed` scopes a clearance question to the
  // clearance facts alone, and every one of these is refused for a question it
  // is not about.
  add(
    "clearanceEligibility",
    "US security clearance eligibility they stated at intake",
    describeClearanceEligibility(answers.clearanceEligibility)
  );
  add(
    "clearanceLevelHeld",
    "Highest US security clearance they have ever held, as they stated it at intake",
    describeClearanceLevel(answers.clearanceLevelHeld)
  );
  // The same two stored answers projected onto the yes/no shape a good share of
  // these questions are drawn with, exactly as `citizenshipYesNo` does for the
  // citizenship status and for the same reason: the sentence "Yes, I am
  // eligible for a U.S. security clearance" does not say what a bare "Yes"
  // option says, so without these the stored answer would bail on every
  // question drawn as a two option radio. Every arm is a restatement of one
  // enum value, and an unrecognised value produces nothing at all.
  for (const [key, label, value] of clearanceYesNo(
    answers.clearanceEligibility,
    answers.clearanceLevelHeld
  )) {
    add(key, label, value);
  }
  add(
    "visaStatus",
    "Their current visa status, in their own words, as stated at intake",
    answers.visaStatus
  );

  // ── JOB-134: the four questions every employer asks and nothing stored ───
  //
  // Same shape as the JOB-022 and JOB-101 blocks above and added on the same
  // evidence: a required field on a real employer's form had no stored answer
  // behind it, so the run stopped and the candidate was asked something they
  // will be asked again by the next employer and the one after that.
  //
  // The restrictive covenant answer is a legal attestation and arrives under
  // the rule rather than around it: `attestationFactAllowed` scopes it to a
  // non-compete or non-solicit question and to nothing else, and scopes every
  // other fact out of that question. Both values are stated, because "No, I am
  // not under one" and "Yes, I am" are equally the candidate's own answer and
  // an employer asking has a right to either.
  add(
    "restrictiveCovenant",
    "Subject to a non-compete, non-solicitation or other restrictive covenant from a previous employer",
    yesNo(answers.subjectToRestrictiveCovenant)
  );
  // ── The two that only speak when the answer is "no" ──────────────────────
  //
  // These are the one asymmetry in this whole catalogue and it is deliberate.
  // The form asks about ONE named employer ("do you have relatives employed by
  // Avery Dennison?"); intake asks about ALL of them ("do you have relatives
  // employed by any company you might apply to?"). "None of them" entails "not
  // this one", so a false answer truthfully answers every employer's version of
  // the question. "Some of them" entails nothing at all about this employer, so
  // there is no fact to write and the question goes to the candidate, which is
  // exactly where a question only they can answer belongs. Writing a "Yes" here
  // would be the system telling an employer something nobody told it.
  if (answers.relativesAtTargetEmployers === false) {
    add(
      "noRelativesAtThisEmployer",
      "Has no relatives or immediate family employed at any company they are applying to, this one included",
      "No"
    );
  }
  if (answers.previouslyEmployedAtTargetEmployers === false) {
    add(
      "noPriorEmploymentAtThisEmployer",
      "Has never previously been employed by any company they are applying to, this one included",
      "No"
    );
  }
  // HARD STOP 9 names salary expectations outright as something no model may
  // compose, which is why this is the candidate's own words and never a number
  // derived from a title, a location or a market rate.
  add(
    "salaryExpectation",
    "Salary or compensation they expect, in their own words, as stated at intake",
    answers.salaryExpectation
  );

  add("highSchoolName", "The high school they attended", answers.highSchoolName);
  add(
    "highSchoolGradYear",
    "Year they graduated high school",
    answers.highSchoolGradYear === undefined ? null : String(answers.highSchoolGradYear)
  );
  add("streetAddress", "Their street address", answers.streetAddress);
  add("postalCode", "Their postal or ZIP code", answers.postalCode);

  // ── JOB-022: the whole resume, not its first row ─────────────────────────
  // `workHistory[0]` and `education[0]` were the only two entries that ever
  // reached a form. A form asking "which university are you currently
  // attending?" against a candidate whose current school is their second
  // education entry got nothing, and so did anything asking about a previous
  // employer. Both lists are validated and length capped by `resume-parser.ts`
  // before they get here, so exposing all of them costs nothing but prompt.
  profile.workHistory.forEach((entry, index) => {
    const where = index === 0 ? "Most recent" : `Job ${index + 1} (older)`;
    const from = sourceSuffix(entry.source);
    add(`work${index}.employer`, `${where}: employer${from}`, entry.company);
    add(`work${index}.title`, `${where}: job title${from}`, entry.title);
    add(`work${index}.dates`, `${where}: dates${from}`, joinDates(entry.startDate, entry.endDate));
    add(`work${index}.summary`, `${where}: what they did${from}`, entry.summary);
  });
  const experience = totalYearsOfExperience(profile.workHistory);
  if (experience !== null) {
    add(
      "yearsOfExperience",
      "Total years of work experience, counted from the dates on their resume",
      experience
    );
  }
  profile.education.forEach((entry, index) => {
    const where = index === 0 ? "Most recent" : `Education ${index + 1} (older)`;
    const from = sourceSuffix(entry.source);
    add(`education${index}.school`, `${where}: school${from}`, entry.school);
    add(`education${index}.degree`, `${where}: degree${from}`, entry.degree);
    add(`education${index}.discipline`, `${where}: field of study${from}`, entry.discipline);
    add(`education${index}.endDate`, `${where}: end date${from}`, entry.endDate);
  });
  // Kept under their historical keys as well as the indexed ones above, because
  // these three are what every previous run's cache and every existing test
  // names, and renaming a fact key is a silent behaviour change.
  const school = profile.education[0];
  if (school !== undefined) {
    const from = sourceSuffix(school.source);
    add("school", `Most recent school${from}`, school.school);
    add("degree", `Most recent degree${from}`, school.degree);
    add("discipline", `Field of study${from}`, school.discipline);
  }
  const job = profile.workHistory[0];
  if (job !== undefined) {
    const from = sourceSuffix(job.source);
    add("mostRecentEmployer", `Most recent employer${from}`, job.company);
    add("mostRecentTitle", `Most recent job title${from}`, job.title);
  }
  if (profile.skills.length > 0) {
    add("skills", "Skills and technologies listed on their resume", profile.skills.join(", "));
  }
  // A GitHub URL is asked for by name on a large share of engineering forms and
  // was reported unanswerable four times in one run. `profile.githubUrl` is the
  // real thing now (JOB-044: `profiles.github_url`, threaded through
  // `CandidateRecord` in `lib/candidate-intake.ts`) and wins whenever the
  // candidate has stated it. The inference below is the fallback for everyone
  // who has not — most candidates, until the intake form grows a field for it —
  // and is otherwise unchanged: the resume parse already validates and
  // sanitises both URL fields, so this only says which one is GitHub.
  const github =
    profile.githubUrl ??
    [profile.websiteUrl, profile.linkedinUrl].find(
      // Anchored at the scheme and matched against the host, so that a path
      // spelling `/github.com/` on some other origin cannot claim to be one.
      // `sanitizeUrl` has already confirmed both of these are https and on the
      // host they claim; this only says which of the two is the GitHub one.
      (url) => typeof url === "string" && /^https:\/\/([a-z0-9-]+\.)*github\.(com|io)(\/|$)/i.test(url)
    );
  add("githubUrl", "Their GitHub URL", github ?? null);

  // The user's own answers from a previous `needsInput` round. Highest-quality
  // facts in the catalogue — they came from the person themselves — and keyed by
  // the form label they answered, so a differently-worded field asking the same
  // thing can still be matched to one.
  for (const [key, value] of Object.entries(additionalAnswers)) {
    add(`answer:${key}`, `The candidate's own answer to "${key}"`, value);
  }

  return facts;
}

/** The month names a form's own dropdown uses, indexed the way a date is. */
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * `profiles.citizenship_status` and `f1_status` as a sentence a form can be
 * answered from.
 *
 * The enum values are database spellings and mean nothing to a model reading a
 * form that says "A United States citizen or national". This is a lookup table,
 * not an inference: each arm restates the one value the person selected at
 * intake, and an unrecognised value is passed through rather than guessed at.
 */
function describeCitizenship(status: string | undefined, f1: string | undefined): string | null {
  if (status === undefined || status.trim() === "") return null;
  switch (status.trim()) {
    case "us_citizen":
      return "A United States citizen or national";
    case "permanent_resident":
      return "A lawful permanent resident of the United States, that is a Green Card holder";
    case "f1": {
      const kind = (f1 ?? "").trim();
      const suffix =
        kind === "opt"
          ? " currently on OPT"
          : kind === "cpt"
            ? " currently on CPT"
            : "";
      return `An international student in the United States on an F-1 student visa${suffix}`;
    }
    case "h1b":
      return "In the United States on an H-1B work visa";
    default:
      return status.trim();
  }
}

/**
 * The yes/no facts that follow directly from one `citizenship_status` value.
 *
 * A lookup table, not an inference. "Other" is deliberately absent from every
 * arm: it means the person told us their status is none of the four, which
 * settles nothing about any of these questions, and answering "No" on their
 * behalf would be the invention this whole design exists to prevent.
 *
 * `isUsPersonForExportControl` covers citizens and lawful permanent residents.
 * A refugee or asylee is also a US person under the regulation and is not one of
 * the values intake collects, which is why "other" yields nothing here rather
 * than a "No" that could be materially wrong.
 */
function citizenshipYesNo(status: string | undefined): [string, string, string][] {
  switch ((status ?? "").trim()) {
    case "us_citizen":
      return [
        ["isUsCitizen", "Is a United States citizen or national", "Yes"],
        ["isUsPermanentResident", "Is a United States lawful permanent resident", "No"],
        ["isUsPersonForExportControl", "Is a US person for export control purposes", "Yes"],
      ];
    case "permanent_resident":
      return [
        ["isUsCitizen", "Is a United States citizen or national", "No"],
        ["isUsPermanentResident", "Is a United States lawful permanent resident", "Yes"],
        ["isUsPersonForExportControl", "Is a US person for export control purposes", "Yes"],
      ];
    case "f1":
    case "h1b":
      return [
        ["isUsCitizen", "Is a United States citizen or national", "No"],
        ["isUsPermanentResident", "Is a United States lawful permanent resident", "No"],
        ["isUsPersonForExportControl", "Is a US person for export control purposes", "No"],
      ];
    default:
      return [];
  }
}

/**
 * `profiles.clearance_eligibility` as the sentence the board itself uses.
 *
 * A lookup table, not an inference, and the arms are Anduril's own option text
 * rather than a paraphrase of it. That is deliberate: `optionSupportsFact`
 * compares this value against the option a control offers, so a fact worded the
 * way the question is worded is the difference between the stored answer being
 * chosen and the stored answer being declined as not saying what the option
 * says. An unrecognised value is passed through rather than guessed at.
 */
function describeClearanceEligibility(status: string | undefined): string | null {
  switch ((status ?? "").trim()) {
    case "active_clearance":
      return "Yes, I hold an active U.S. security clearance";
    case "eligible":
      return "Yes, I am eligible for a U.S. security clearance";
    case "no":
      return "No";
    default:
      return (status ?? "").trim() || null;
  }
}

/** `profiles.clearance_level_held`, in the words the follow up question uses. */
function describeClearanceLevel(level: string | undefined): string | null {
  switch ((level ?? "").trim()) {
    case "never_held":
      return "N/A - have never held U.S. security clearance";
    case "confidential":
      return "Confidential";
    case "secret":
      return "Secret";
    case "top_secret":
      return "Top Secret";
    default:
      return (level ?? "").trim() || null;
  }
}

/**
 * The yes/no facts that follow directly from the two stored clearance answers.
 *
 * A lookup table, exactly like `citizenshipYesNo`, and bounded the same way: an
 * unrecognised value yields nothing rather than a "No" nobody said. Note that
 * `active_clearance` produces "Yes" for eligibility as well, because holding a
 * clearance is the strongest possible statement of being eligible for one, and
 * that is a restatement rather than an inference about a person.
 *
 * `hasEverHeldUsClearance` is read off the level rather than off the
 * eligibility, because they are different questions: somebody eligible for a
 * clearance today may never have held one, which is exactly the pair of answers
 * this candidate gave.
 */
function clearanceYesNo(
  eligibility: string | undefined,
  level: string | undefined
): [string, string, string][] {
  const facts: [string, string, string][] = [];
  switch ((eligibility ?? "").trim()) {
    case "active_clearance":
      facts.push(
        ["holdsActiveUsClearance", "Holds an active US security clearance", "Yes"],
        ["isEligibleForUsClearance", "Is eligible for a US security clearance", "Yes"]
      );
      break;
    case "eligible":
      facts.push(
        ["holdsActiveUsClearance", "Holds an active US security clearance", "No"],
        ["isEligibleForUsClearance", "Is eligible for a US security clearance", "Yes"]
      );
      break;
    case "no":
      facts.push(
        ["holdsActiveUsClearance", "Holds an active US security clearance", "No"],
        ["isEligibleForUsClearance", "Is eligible for a US security clearance", "No"]
      );
      break;
  }
  switch ((level ?? "").trim()) {
    case "never_held":
      facts.push(["hasEverHeldUsClearance", "Has ever held a US security clearance", "No"]);
      break;
    case "confidential":
    case "secret":
    case "top_secret":
      facts.push(["hasEverHeldUsClearance", "Has ever held a US security clearance", "Yes"]);
      break;
  }
  return facts;
}

/** An ISO date as the two pieces a form's month and year dropdowns want. */
function splitIsoDate(iso: string | undefined): { year: string; monthName: string } | null {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec((iso ?? "").trim());
  if (match === null) return null;
  const monthIndex = Number(match[2]) - 1;
  const monthName = MONTH_NAMES[monthIndex];
  if (monthName === undefined) return null;
  return { year: match[1]!, monthName };
}

/** "Jan 2024" and "Present" as the one string a resume prints. */
function joinDates(start: string | null, end: string | null): string | null {
  const from = (start ?? "").trim();
  const to = (end ?? "").trim();
  if (from === "" && to === "") return null;
  if (from === "") return to;
  if (to === "") return from;
  return `${from} to ${to}`;
}

/**
 * Years of work experience, counted rather than asked for.
 *
 * "How many years of industry experience do you have?" was a required field on
 * three separate forms in the 2026 08 20 run and stopped all three, against a
 * resume that lists the jobs it would be counted from. Counting it here rather
 * than letting a model estimate it keeps it a report of the resume.
 *
 * ── Rewritten after review on this PR ───────────────────────────────────────
 * The first version measured the SPAN: earliest start to latest end. A span
 * counts the gaps between jobs as though they were jobs. The resume this feature
 * exists for is a student's, and a student's resume is mostly gaps: two summer
 * internships, June to September 2019 and June 2025 to present, produced "7"
 * for someone with roughly nine months of work. Seven years of industry
 * experience is not a rounding error on a real application, it is a different
 * person, and it would have been typed into three forms as a stated fact.
 *
 * So this sums the intervals instead, merging any that overlap so that two
 * concurrent jobs are one stretch of time rather than two. Same two internships
 * now give "0", which is the truthful answer for a new grad and the one they
 * would write themselves.
 *
 * Still deliberately coarse: resume dates are years, months are not parsed, and
 * a job listed only as "2019" counts as that one year. It is an approximation of
 * an approximation, since every candidate answering this box is estimating too,
 * and the number only has to be defensible against the dates on their own
 * resume. Undercounting slightly is the right direction for the error to run.
 */
function totalYearsOfExperience(history: readonly { startDate: string | null; endDate: string | null }[]): string | null {
  const thisYear = new Date().getUTCFullYear();
  const yearIn = (value: string | null, whenPresent: number | null): number | null => {
    const text = (value ?? "").trim();
    if (text === "") return null;
    if (/^(present|current|now|ongoing)$/i.test(text)) return whenPresent;
    const found = /\b(19|20)\d{2}\b/.exec(text);
    return found === null ? null : Number(found[0]);
  };

  // An entry with no readable start contributes nothing. A missing end is read
  // as still going, which is what an ongoing role on a resume means.
  const spans: [number, number][] = [];
  for (const entry of history) {
    const start = yearIn(entry.startDate, null);
    if (start === null) continue;
    const end = Math.min(yearIn(entry.endDate, thisYear) ?? thisYear, thisYear);
    if (end < start) continue;
    spans.push([start, end]);
  }
  if (spans.length === 0) return null;

  // Merge overlapping and touching spans, then add up what is left. Touching
  // counts as overlapping: 2019-2021 and 2021-2023 is one four year stretch and
  // not two, because the shared year is one year of somebody's life either way.
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [from, to] = spans[0]!;
  for (const [start, end] of spans.slice(1)) {
    if (start <= to) {
      to = Math.max(to, end);
      continue;
    }
    total += to - from;
    [from, to] = [start, end];
  }
  total += to - from;
  return String(Math.max(0, total));
}

/**
 * The user's answer for this field, when they gave one.
 *
 * Matching is generous in one direction only: an answer key must *contain or be
 * contained by* the field's key, and only for keys long enough for that to mean
 * something. That way "are you legally authorized to work in the united states
 * for our company?" is answered by the shorter question a caller echoed back,
 * while two unrelated one-word labels can never collide.
 *
 * ── JOB-134: both sides now have to look like a question ────────────────────
 * The rule already said "only for keys long enough for that to mean something",
 * and the code checked only that the SUPPLIED key cleared ten characters. That
 * was defensible while the supplied map held two or three answers a caller had
 * just been handed about the page in front of them. It is not defensible now
 * that the map also holds every question this person has ever answered, because
 * a long question contains a great many short strings. "How many years of
 * experience do you have with Python?" contains "python", and it contains
 * "experience", and on containment alone the number 4 would have been typed
 * into a field labelled either.
 *
 * So the floor applies to both sides, and both sides also have to be more than
 * a word or two. A question is a phrase; "Experience" is a column heading, and
 * it clears ten characters on its own.
 *
 * What this deliberately is NOT is a rule about how much of one string the
 * other covers. That was the first attempt and it broke JOB-132's own case: a
 * `needsInput` key is capped, real screening labels are not, and the Avery
 * Dennison non-compete question is a 240 character label whose key is the first
 * 80 of it. A proportion rule reads the candidate's own answer to that exact
 * escalation as a partial match and drops it, which is the bug JOB-132 exists
 * to have fixed.
 *
 * A tightening rather than a trade. The exact-match pass above is untouched, so
 * a short field key that IS one of these questions still matches; a short field
 * key that merely appears inside one now goes to the decision call, where the
 * fact's label quotes the question it answered and `optionSupportsFact` still
 * has to agree before anything is typed.
 */
const MIN_FUZZY_ANSWER_KEY_LENGTH = 10;
const MIN_FUZZY_ANSWER_KEY_WORDS = 3;

/** Whether a key reads as a question somebody asked rather than as a heading. */
function readsAsAQuestion(key: string): boolean {
  return (
    key.length >= MIN_FUZZY_ANSWER_KEY_LENGTH &&
    key.split(/\s+/).filter(Boolean).length >= MIN_FUZZY_ANSWER_KEY_WORDS
  );
}

function matchAdditionalAnswer(
  field: EnumeratedField,
  additionalAnswers: Record<string, string>
): string | null {
  const wanted = normalizeText(field.key);
  const label = normalizeText(field.label);

  for (const [key, value] of Object.entries(additionalAnswers)) {
    const candidate = normalizeText(key);
    if (candidate === "" || value.trim() === "") continue;
    if (candidate === wanted || candidate === label) return value.trim();
  }
  if (!readsAsAQuestion(wanted)) return null;
  for (const [key, value] of Object.entries(additionalAnswers)) {
    const candidate = normalizeText(key);
    if (!readsAsAQuestion(candidate) || value.trim() === "") continue;
    if (wanted.includes(candidate) || candidate.includes(wanted)) return value.trim();
  }
  return null;
}

/**
 * What `matchAdditionalAnswer` found for this field, decided against.
 *
 *  · `"apply"` — a supplied answer was found and this field may be filled
 *    from it.
 *  · `"refused"` — a supplied answer was found, but this field is one of the
 *    categories `additionalAnswers` is never allowed to decide on its own;
 *    `category` and `why` are for the caller's own warning message.
 *  · `"none"` — nothing in `additionalAnswers` matched this field at all.
 */
export type AdditionalAnswerResolution =
  | { kind: "apply"; value: string }
  | { kind: "refused"; category: string; why: string }
  | { kind: "none" };

/**
 * Whether a caller-supplied `additionalAnswers` entry that fuzzy-matched this
 * field (`matchAdditionalAnswer` above — substring containment either
 * direction, for a key 10+ characters) may actually be typed into it, or must
 * be refused and left to fall through to `resolveDecision`'s own policy
 * instead.
 *
 * `additionalAnswers` is meant to be the candidate's own words, relayed after
 * a previous run asked them something. But it arrives through the
 * orchestrating model (see `toAdditionalAnswers` in `mcp-server/index.ts`),
 * which could equally volunteer an entry nobody was asked for — and this step
 * runs BEFORE `resolveDecision`, so neither of that function's own guards
 * governs it by default. Two carve-outs exist here for exactly that reason,
 * one per guard:
 *
 *  · A demographic self-identification question (`EEO_FIELD_RE`) that offers
 *    a decline option. Mirrors `resolveDecision`'s own EEO branch: a required
 *    question with no decline option is the only one ever escalated to the
 *    candidate, so a supplied answer for a question that DOES offer one was
 *    never responsive to something this system actually asked, and typing it
 *    in would be stating a demographic identity nobody gave.
 *
 *  · A consent, agreement or certification field (`CONSENT_FIELD_RE` —
 *    imported from `lib/form-fields.ts`, the exact pattern `resolveDecision`
 *    itself tests against, never redefined here). `resolveDecision` never
 *    lets even a model's own proposal tick one of these; it decides required
 *    vs. optional itself, deterministically, precisely because ticking one is
 *    a commitment made in the candidate's name rather than a fact about them.
 *    A supplied `additionalAnswers` entry has no better claim to make that
 *    commitment than a model's proposal did — if anything a weaker one, since
 *    the fuzzy match above means the entry need not even have been meant for
 *    this field.
 *
 * ── JOB-132: why that second carve-out also reads the control's shape ───────
 * `CONSENT_FIELD_RE` matches words, and some of those words appear in
 * questions that ask ABOUT an agreement rather than asking the candidate to
 * enter into one. A real Avery Dennison screening question,
 *
 *   "Are you currently subject to a non compete, non-solicit or other similar
 *    clause in your employment contract with your current or a previous
 *    employer, and if so, could you provide this agreement as part of the
 *    recruitment process?"
 *
 * matched on the single word "agreement" — the noun naming a document the
 * question asks about — and the candidate's own answer, given in response to
 * this exact field being escalated to them by a previous run, was refused as
 * though answering it agreed to something. It agrees to nothing. It reports a
 * fact about their employment history that nobody else can report, which is
 * the entire reason `additionalAnswers` exists.
 *
 * So the refusal now also requires the control to be one that is answered BY
 * asserting: `ASSERTING_KINDS`, a checkbox or a radio, the same shape test
 * issue #100 settled on for the unknown-field fallback, and for the same
 * reason given there — a ticked box is an assertion whatever its label says,
 * while a wording rule only ever catches the phrasings somebody anticipated.
 *
 * This deliberately does not move the cases the carve-out exists for. An
 * "I agree to the Terms" checkbox is still refused. Lever's "Yes, I consent" /
 * "No, I do not consent" radio pair is still refused. What is no longer
 * refused is a `select` or `combobox` offering mutually exclusive statements
 * of fact, where choosing one reports rather than promises. Note also that
 * `attestationFactAllowed` already treats an `answer:`-keyed fact as valid
 * backing for a legal attestation: the architecture had already decided a
 * candidate's own answer may settle one of these, and this carve-out was
 * reaching past that decision on the strength of a noun.
 *
 * Refusing does not leave the field unanswered. It falls through to the
 * ordinary ladder, and `resolveDecision`'s own consent branch already ticks a
 * REQUIRED, non-attestation agreement box deterministically — so a real
 * "I agree to the Terms" checkbox still gets ticked. It is just never ticked
 * FROM `additionalAnswers`.
 */
export function resolveAdditionalAnswer(
  field: EnumeratedField,
  additionalAnswers: Record<string, string>
): AdditionalAnswerResolution {
  const supplied = matchAdditionalAnswer(field, additionalAnswers);
  if (supplied === null) return { kind: "none" };

  if (EEO_FIELD_RE.test(field.label) && findDeclineOption(field.options) !== null) {
    return {
      kind: "refused",
      category: "demographic field",
      why:
        "it offers a decline option, so it was never asked about, and an unsolicited answer " +
        "here would be stating an identity nobody gave",
    };
  }

  // JOB-132. The wording test alone matched questions that ask ABOUT an
  // agreement rather than asking for one, so the shape of the control has to
  // agree before a supplied answer is refused. See the note on this function.
  if (CONSENT_FIELD_RE.test(field.label) && ASSERTING_KINDS.has(field.kind)) {
    return {
      kind: "refused",
      category: "consent, agreement or certification field",
      why:
        "ticking or filling one of these is a commitment made in the candidate's name, decided " +
        "only by resolveDecision's own deterministic policy for this exact pattern, never by " +
        "an unverified supplied answer",
    };
  }

  return { kind: "apply", value: supplied };
}

/**
 * Does choosing this option say what the stored fact says?
 *
 * Boards word their options and this system words its facts, and the two rarely
 * match character for character: Greenhouse's phone-country list offers
 * `"United States +1"` for a stored `"United States"`, and a work-authorization
 * dropdown may offer `"Yes, I am authorized to work in the US"` for a stored
 * `"Yes"`. Both are the same statement. `"Now hiring"` for a stored `"No"` is
 * not, which is why a short fact has to match at a word boundary rather than
 * anywhere in the string — the check exists precisely so that naming a fact
 * cannot license clicking an unrelated option.
 */
function optionSupportsFact(
  option: string,
  factValue: string,
  factKey: string,
  fieldLabel: string
): boolean {
  // The enumeration marker a form author typed in front of the option is not
  // part of what choosing it says — see `stripOptionOrdinal`. Only the marker
  // is dropped; every word of the option itself is still compared.
  const chosen = stripOptionOrdinal(normalizeText(option));
  const known = normalizeText(factValue);
  if (chosen === known) return true;
  // Gated on BOTH the fact key and the field label, exactly as degree
  // equivalence is below, and never true unless the option and the stored
  // status name the same status. See `citizenshipClass`.
  if (CITIZENSHIP_FACT_KEY_RE.test(factKey) && CITIZENSHIP_FIELD_LABEL_RE.test(fieldLabel)) {
    const chosenStatus = citizenshipClass(chosen);
    if (chosenStatus !== null && chosenStatus === citizenshipClass(known)) return true;
  }
  // JOB-022. A resume prints "B.S." and a Greenhouse degree dropdown offers
  // "Bachelor's Degree". Those are the same statement, and the word boundary
  // test below cannot see it because they share no words. On 2026 08 20 that
  // exact pair stopped a real application with the message "the option
  // \"Bachelor's Degree\" does not say what the stored fact \"degree\" says
  // (\"B.S.\")", which is a spelling complaint dressed up as a truthfulness one.
  //
  // Gated on BOTH ends, which is the third pass review took at this. Gating the
  // fact key alone was still not enough: a genuine `degree` = "Master's Degree"
  // against a state dropdown offering a bare "MA" is a real fact and a real
  // degree key, and `degreeLevel` reads "MA" as a master's, so the state of
  // Massachusetts counted as saying what the degree said. Both the fact and the
  // FIELD have to be about education before two-letter degree equivalence is
  // allowed to decide anything. Anduril's own "What is your top location
  // preference?" list offers "Boston, MA", which is exactly the shape of menu
  // this protects.
  if (DEGREE_FACT_KEY_RE.test(factKey) && DEGREE_FIELD_LABEL_RE.test(fieldLabel)) {
    const chosenDegree = degreeLevel(chosen);
    if (chosenDegree !== null && chosenDegree === degreeLevel(known)) return true;
  }
  if (known.length <= 3) {
    return chosen.startsWith(`${known} `) || chosen.startsWith(`${known},`);
  }
  // At a word boundary, not anywhere in the string. A raw substring test reads
  // "British Indian Ocean Territory" as supporting a stored "India", "South
  // Georgia and the South Sandwich Islands" as supporting "Georgia", and "South
  // Korea" as supporting "Korea" — all verified against this function before the
  // boundary was added. Country menus are exactly where that bites, and picking
  // the wrong country on a work-authorization form is a false statement, not a
  // typo.
  return containsAtWordBoundary(chosen, known) || containsAtWordBoundary(known, chosen);
}

/**
 * The enumeration marker a form author typed in front of an option, if any.
 *
 * Deliberately restricted to digits, and deliberately requiring a delimiter and
 * whitespace after them. A letter marker would be indistinguishable from a real
 * one-letter option, and this same page's "What is your strongest coding
 * language?" offers "C" and "C#", so "C) " can never be assumed to be a marker.
 * The delimiter requirement is what keeps the real numeric options intact: the
 * ACT list's "36 out of 36" and a GPA list's "3.5" both start with digits and
 * neither is stripped, because neither has a marker's punctuation after them.
 */
const OPTION_ORDINAL_RE = /^\(?\d{1,2}\)\s+|^\d{1,2}[.:]\s+|^\d{1,2}\s+[-–—]\s+/;

/** An option's own words, with any enumeration marker in front of them removed. */
function stripOptionOrdinal(text: string): string {
  return text.replace(OPTION_ORDINAL_RE, "").trim();
}

/**
 * A citizenship or immigration status as the one status it names, or null when
 * the text names none of them.
 *
 * The same device as `degreeLevel` below and for the same reason, and gated the
 * same way — see `CITIZENSHIP_FACT_KEY_RE` and `CITIZENSHIP_FIELD_LABEL_RE`. A
 * board words the status one way and `describeCitizenship` words it another,
 * and on a real posting the two shared no run of words at all: the option says
 * "U.S. citizen or national of the United States" and the stored fact says "A
 * United States citizen or national". Those are the same statement, and
 * `optionSupportsFact`'s word-boundary test cannot see it, so a citizenship
 * question the candidate had answered at intake was escalated as unanswerable.
 *
 * This is a lookup table, not an inference, and it is not a relaxation of
 * anything: it can only ever return true when both sides name the SAME status.
 * Two different statuses still disagree, and text that names no status at all
 * still supports nothing — "Other (please explain)" classifies as null on
 * purpose, since it is precisely the option that says nothing.
 *
 * Negations are checked first and fail the whole thing closed. A dropdown that
 * offers "Not a U.S. citizen" must never read as agreeing with a stored
 * citizen status, and a table of positive phrases would say it does.
 */
const CITIZENSHIP_NEGATION_RE = /\b(?:not|non|no|neither|none|other\s+than|nor)\b/;

function citizenshipClass(text: string): string | null {
  const flat = normalizeText(text)
    .replace(/[.,'’()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "" || CITIZENSHIP_NEGATION_RE.test(flat)) return null;
  // Ahead of the citizen arm on purpose: a permanent-resident option often
  // spells out "of the United States" too, and must never fall through to it.
  if (/\b(?:lawful permanent resident|permanent resident|green card)\b/.test(flat)) {
    return "permanent_resident";
  }
  if (/\brefugee\b/.test(flat)) return "refugee";
  if (/\basylee\b|\basylum\b/.test(flat)) return "asylee";
  if (/\bdaca\b|\bdeferred action\b/.test(flat)) return "daca";
  if (/\bh ?1 ?b\b/.test(flat)) return "h1b";
  if (/\bf ?1\b|\bstudent visa\b/.test(flat)) return "f1";
  if (
    /\b(?:u s|us|usa|united states|american)\b.*\b(?:citizen|citizenship|national)\b/.test(flat) ||
    /\b(?:citizen|citizenship|national)\b.*\b(?:u s|us|usa|united states)\b/.test(flat)
  ) {
    return "us_citizen";
  }
  return null;
}

/**
 * The fact keys that hold the candidate's own citizenship status, and the only
 * ones citizenship equivalence runs for. `buildFactCatalog` writes exactly one.
 * The yes/no restatements derived from it (`isUsCitizen` and the rest) are
 * deliberately absent: their values are "Yes" and "No", which name no status,
 * so equivalence has nothing to compare and the ordinary check already handles
 * them correctly.
 */
const CITIZENSHIP_FACT_KEY_RE = /^citizenshipStatus$/;

/**
 * The field labels a citizenship question is drawn with, and the other half of
 * the double gate, on the same reasoning as `DEGREE_FIELD_LABEL_RE`: the fact
 * being about immigration status is not on its own enough, the FIELD has to be
 * asking about it too. A country dropdown offering "United States" is not a
 * citizenship question and must not be answered as one.
 */
const CITIZENSHIP_FIELD_LABEL_RE =
  /\b(?:citizen\w*|nationality|immigration\s+status|permanent\s+resident\w*|green\s+card|work\s+authoriz\w*|authoriz\w*\s+to\s+work|visa\s+status|right\s+to\s+work)\b/i;

/**
 * The fact keys that hold a degree, and the only ones degree equivalence runs
 * for. `buildFactCatalog` writes `degree` and `educationN.degree`.
 */
const DEGREE_FACT_KEY_RE = /(?:^|\.)degree$/;

/**
 * The field labels a degree question is drawn with, and the only ones two-letter
 * degree equivalence may run for.
 *
 * Deliberately narrow. A label naming a degree, a qualification or a level of
 * study is one; "What is your top location preference?" is not, and neither is
 * anything else on the form.
 */
const DEGREE_FIELD_LABEL_RE =
  /\b(degree|qualification|education\s+level|level\s+of\s+(?:education|study)|highest\s+(?:degree|education|level))\b/i;

/**
 * JOB-044. The field labels a school question is drawn with, and one half of
 * the double gate `inferOrAsk` and its caller use to decide when to type free
 * text into a combobox that nothing on the menu matches.
 *
 * Deliberately narrow, on the same reasoning as `DEGREE_FIELD_LABEL_RE`: a
 * combobox is a text input with a suggestion list layered on top, and typing
 * whatever was proposed is a real answer only when the control is actually
 * asking for a school. The 2026 08 21 failure analysis found Greenhouse's own
 * "School" combobox accepts exactly that — it takes what is typed even when
 * the candidate's school never appears among its suggestions — but a Location
 * or Country combobox does not, and leaving unselected free text in one of
 * those puts a value on the form nothing chose.
 *
 * Label alone is not enough, which review of this same ticket caught before
 * it shipped, on the same reasoning `DEGREE_FIELD_LABEL_RE` was already double
 * gated for below: a university's own Greenhouse posting can ask which
 * "School" or "College" a role belongs to — an org-structure question about
 * the employer, not the candidate — and that field's label matches this regex
 * just as well as "What school did you attend?" does. See `SCHOOL_FACT_KEY_RE`
 * for the other half.
 */
const SCHOOL_FIELD_LABEL_RE = /\b(school|university|college)\b/i;

/**
 * JOB-044. The fact keys that hold the candidate's own school, and the only
 * ones `SCHOOL_FIELD_LABEL_RE`'s free-text fallback may run for.
 *
 * Paired with `SCHOOL_FIELD_LABEL_RE` the same way `DEGREE_FACT_KEY_RE` is
 * paired with `DEGREE_FIELD_LABEL_RE`, and for the same reason: the label
 * alone cannot tell "which school did you attend" apart from an employer's own
 * "which School is this role in" question, so the fact backing the proposed
 * value has to actually be the candidate's education before free text is
 * allowed onto the form. `buildFactCatalog` writes `school` and
 * `educationN.school`.
 */
const SCHOOL_FACT_KEY_RE = /(?:^|\.)school$/;

/**
 * Matches "Confirm email", "Confirm your email", "Re-enter email",
 * "Repeat email", "Verify email" and similar second-email fields.
 *
 * These are always filled with the same value as the primary email address,
 * so they are caught before the standard fact-lookup and filled directly from
 * the `email` fact.
 */
export const CONFIRM_EMAIL_RE =
  /\b(?:confirm|re-?enter|repeat|verify|re-?type)\b.*\bemail\b|\bemail\b.*\b(?:confirm(?:ation)?|re-?enter|repeat|verify|re-?type)\b/i;


/**
 * Which level of degree a string names, or null when it names none.
 *
 * A closed lookup rather than a similarity score. Abbreviation and long form are
 * the same statement; "Bachelor's" and "Master's" are not, and nothing here may
 * ever collapse those two, so each arm lists only spellings of one level. The
 * dots are collapsed before matching because a resume writes "B.S." and a
 * dropdown writes "BS".
 */
function degreeLevel(text: string): string | null {
  const flat = normalizeText(text).replace(/[.’']+/g, " ").replace(/\s+/g, " ").trim();

  // The bare two letter forms are matched against the WHOLE string and never
  // inside one, because they are not only degrees. "MA" is Massachusetts, "MS"
  // is Mississippi and "BA" is Buenos Aires, so an embedded match reads
  // "Boston, MA" as a master's degree. That is not a cosmetic problem:
  // `degreeLevel` is consulted by `optionSupportsFact` for every field and not
  // just for a degree dropdown, so it would have let a location option
  // "Boston, MA" count as backed by a stored location fact "Cambridge, MA",
  // meaning the wrong city reported as a fact the candidate stated. Caught in
  // review on this PR before it shipped.
  //
  // A dropdown offering a bare "BS" or "MS" as its entire option text is still
  // handled, which is the only case the short forms were there for.
  const BARE: Record<string, string> = {
    "phd": "doctorate", "ph d": "doctorate", "sc d": "doctorate",
    "ms": "masters", "m s": "masters", "ma": "masters", "m a": "masters",
    "msc": "masters", "mba": "masters", "m b a": "masters", "meng": "masters", "m eng": "masters",
    "bs": "bachelors", "b s": "bachelors", "ba": "bachelors", "b a": "bachelors",
    "bsc": "bachelors", "beng": "bachelors", "b eng": "bachelors",
    "aa": "associates", "a a": "associates", "as": "associates", "a s": "associates",
  };
  const bare = BARE[flat];
  if (bare !== undefined) return bare;

  if (/\b(doctorate|doctoral|doctor of philosophy|d phil|dphil)\b/.test(flat)) return "doctorate";
  // Ahead of bachelor's on purpose: "Master of Business Administration" must
  // never fall through to an arm that also accepts "Bachelor of Arts".
  if (/\b(master s|masters|master of)\b/.test(flat)) return "masters";
  if (/\b(bachelor s|bachelors|bachelor of|undergraduate)\b/.test(flat)) return "bachelors";
  if (/\b(associate s|associates|associate degree)\b/.test(flat)) return "associates";
  if (/\b(high school|secondary school|ged|diploma)\b/.test(flat)) return "high school";
  return null;
}

/**
 * The option on this menu that a proposed value names, or null.
 *
 * ── Rewritten after review on this PR, because the first version was wrong ──
 * It matched any option starting with the value and broke ties by picking the
 * shortest. Run against the six options quoted verbatim in the Virtu `skip_log`
 * row from 2026 08 20, "San Francisco" resolved to "San Francisco, Cebu,
 * Philippines" (32 characters) over "San Francisco, California, United States"
 * (40), and applied it as a fact the candidate had stated. Shortest is not least
 * qualified; it is just shortest. The test that was supposed to catch this used
 * a hand written three option subset that happened to omit the shorter ones,
 * which is exactly how the bug survived, so the fixture now comes from the
 * logged list.
 *
 * The rule now has three parts, and each is doing specific work:
 *
 *  1. **Exact wins.** A country menu offering both "Guinea" and "Guinea-Bissau"
 *     resolves "Guinea" here and never reaches the rest.
 *
 *  2. **Only a qualified prefix counts.** The text after the matched prefix has
 *     to begin with a comma or an opening parenthesis, which is what
 *     qualification looks like: "San Francisco, California, United States" and
 *     "Costa Mesa, CA (HQ)" are the value said in full. A prefix followed by
 *     anything else is a *different name that happens to start the same way*:
 *     "Guinea-Bissau" is not Guinea, and "San Francisco de Macorís" is not San
 *     Francisco. The old rule treated a hyphen as a word boundary and accepted
 *     both.
 *
 *  3. **Ambiguity is resolved by a second fact, or not at all.** Three of the
 *     Virtu options are qualified prefixes, so the tie is broken by asking which
 *     remainder agrees with something else known about this person: their
 *     country. Exactly one does. When none does, or several do, nothing is
 *     chosen and the field goes back to the ordinary path, because picking a
 *     city on the wrong continent is worse than not picking one.
 *
 * The old "contained in exactly one option" fallback is gone with it. A single
 * option list containing "Papua New Guinea" and nothing else would have resolved
 * a bare "Guinea" to it, and no rule that can do that is worth its coverage.
 */
function matchOption(
  options: readonly string[],
  value: string,
  corroborants: readonly string[] = []
): string | null {
  const wanted = normalizeText(value);
  if (wanted === "") return null;

  const exact = options.find((option) => normalizeText(option) === wanted);
  if (exact !== undefined) return exact;

  // Form authors number their own options, and Greenhouse renders what they
  // typed: a real posting's citizenship question offers "1) U.S. citizen or
  // national of the United States" through "6) Other (please explain)". The
  // "1) " is an enumeration marker in front of the option, not part of what
  // choosing it says, so an answer that matches everything except the marker is
  // the same answer — and refusing it stopped a question the candidate's own
  // stored status answers exactly. Required to be unambiguous, on the same
  // reasoning every other tier here is.
  const bare = stripOptionOrdinal(wanted);
  const numbered = options.filter((option) => stripOptionOrdinal(normalizeText(option)) === bare);
  if (numbered.length === 1) return numbered[0]!;
  if (numbered.length > 1) return null;

  const qualified = options.filter((option) => {
    const text = stripOptionOrdinal(normalizeText(option));
    if (!text.startsWith(bare)) return false;
    const rest = text.slice(bare.length).replace(/^\s+/, "");
    return rest.startsWith(",") || rest.startsWith("(");
  });
  if (qualified.length === 1) return qualified[0]!;
  if (qualified.length === 0) return null;

  const backed = qualified.filter((option) => {
    const rest = stripOptionOrdinal(normalizeText(option)).slice(bare.length);
    return corroborants.some((hint) => {
      const clean = normalizeText(hint);
      return clean !== "" && containsAtWordBoundary(rest, clean);
    });
  });
  return backed.length === 1 ? backed[0]! : null;
}

/**
 * The other things known about where this person is, for breaking a tie between
 * two options that both spell out the same place name.
 *
 * Only ever used to *choose between* options the menu already offers, never to
 * justify one on its own.
 */
function geographyHints(facts: ReadonlyMap<string, CandidateFact>): string[] {
  const hints: string[] = [];
  const country = facts.get("currentCountry")?.value ?? "";
  if (country.trim() !== "") {
    hints.push(country);
    // A menu writes "United States" where intake may have recorded "USA", and
    // the tie break is worthless if the two spellings cannot see each other.
    // "US" is the third spelling and the one a location search actually uses:
    // SmartRecruiters answers "San Francisco" with "San Francisco, CA, US"
    // alongside six in the Philippines and one in Argentina, and without this
    // the tie break found nothing to back the right one with, so the required
    // City field was left empty on every run. `containsAtWordBoundary` is what
    // keeps a two-letter hint from matching inside a longer word.
    if (US_COUNTRY_RE.test(country.trim())) hints.push("United States", "USA", "US");
  }
  const resumeLocation = facts.get("resumeLocation")?.value ?? "";
  for (const piece of resumeLocation.split(",").slice(1)) {
    if (piece.trim() !== "") hints.push(piece);
  }
  return hints;
}

/**
 * The country the candidate attested, in the spellings a location menu writes it.
 *
 * JOB-047. `contextTerms` is ANDed, so this is deliberately **one** term
 * carrying its alternatives rather than several terms — see `chooseFromMenuOnce`,
 * which splits on `|` and is satisfied by any one spelling. It is still one
 * attested fact and still has to be present for a suggestion to survive.
 *
 * The alternatives matter because boards disagree: Greenhouse's location service
 * answers "San Francisco, California, United States" and SmartRecruiters'
 * answers "San Francisco, CA, US". A term of only "United States" matches the
 * first and silently fails the second, which is how the required City field
 * stayed empty on every SmartRecruiters run.
 */
function countryContextTerms(currentCountry: string | undefined): string[] {
  const country = (currentCountry ?? "").trim();
  if (country === "") return [];
  if (!US_COUNTRY_RE.test(country)) return [country];
  return ["United States|USA|US|U.S."];
}

/** Whether `needle` appears in `haystack` delimited by non-word characters. */
function containsAtWordBoundary(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : haystack[at - 1]!;
    const afterAt = at + needle.length;
    const after = afterAt >= haystack.length ? "" : haystack[afterAt]!;
    const boundedLeft = before === "" || !/[a-z0-9]/i.test(before);
    const boundedRight = after === "" || !/[a-z0-9]/i.test(after);
    if (boundedLeft && boundedRight) return true;
    from = at + 1;
  }
}

/**
 * A yes/no answer as a boolean, or null when the text states neither. The
 * vocabulary matches `setCheckbox`'s in `form-fields.ts` deliberately: the
 * policy layer and the action layer must agree on what "yes" looks like, or a
 * value this accepts could be rejected there (or worse, vice versa).
 */
function booleanAnswer(text: string): boolean | null {
  const normalized = normalizeText(text);
  if (["yes", "true", "checked", "check", "on", "1", "agree", "i agree", "y"].includes(normalized)) {
    return true;
  }
  if (["no", "false", "unchecked", "uncheck", "off", "0", "n"].includes(normalized)) return false;
  return null;
}

/** What the policy decided to do with one field, once every check has run. */
type Resolution =
  | { kind: "apply"; value: string; declined: boolean; note: string }
  | { kind: "generate"; note: string }
  | { kind: "ask"; question: string; why: string }
  | { kind: "skip"; why: string };

function askAbout(field: EnumeratedField, why: string, question?: string | null): Resolution {
  const asked =
    question !== null && question !== undefined && question.trim() !== ""
      ? question.trim()
      : field.label === ""
        ? "This field has no visible label — what should go in it?"
        : `The form asks: "${field.label}". What should we put?`;
  return { kind: "ask", question: asked, why };
}

/** A field left blank blocks the board's own validation; an optional one does not. */
function askOrSkip(field: EnumeratedField, why: string, question?: string | null): Resolution {
  return field.required ? askAbout(field, why, question) : { kind: "skip", why };
}

/**
 * JOB-022: what a legal attestation does when the stored data does not answer it.
 *
 * Step 2 of the ladder in `LEGAL_ATTESTATION_RE`. Declining is a truthful answer
 * and forms offer it far more often than the old code assumed, so a clearance or
 * export control question with a "prefer not to answer" choice is answered by
 * choosing it rather than by stopping the run. Only a required attestation whose
 * control offers no way out reaches step 3 and actually blocks.
 */
function declineOrAsk(
  field: EnumeratedField,
  why: string,
  question?: string | null
): Resolution {
  const decline = findDeclineOption(field.options);
  if (decline !== null) {
    return {
      kind: "apply",
      value: decline,
      declined: true,
      note:
        `a legal attestation the candidate's stored answers do not cover, answered by ` +
        `declining, using the control's own decline option: ${why}`,
    };
  }
  return askOrSkip(field, why, question);
}

/**
 * JOB-022: what everything that is not an attestation does instead of stopping.
 *
 * This is the behaviour change the whole ticket is about, so it is worth being
 * blunt about what it does: it puts the model's best reasonable answer on the
 * form and carries on, where the old code put nothing on the form and ended the
 * run. A form asking a graduation month, a top office preference, a years of
 * experience count or how somebody heard about the company gets answered. Being
 * a little off on one of those is a worse outcome than a perfect answer and a
 * far better outcome than no application at all, which is the trade the product
 * has explicitly chosen.
 *
 * Two things still bound it, and both are structural rather than advisory:
 *
 *  · An option based control may only receive an option the DOM itself offered.
 *    `applyFieldValue` will not click something that is not on the menu, so the
 *    worst case for a dropdown is the wrong choice from the real list, never an
 *    invented one.
 *  · A field with nothing proposed for it and nowhere to write prose still asks.
 *    Inventing a value out of nothing at all is not "best effort", it is noise,
 *    and it would put a string on an employer's form that no part of this system
 *    ever considered.
 *
 * Attestations never reach here. `resolveDecision` routes them to `declineOrAsk`
 * instead, in TypeScript, before any of this is consulted.
 */
function inferOrAsk(
  field: EnumeratedField,
  decision: FieldDecision | undefined,
  why: string,
  question: string | null | undefined,
  hints: readonly string[]
): Resolution {
  if (!field.required) return { kind: "skip", why };

  const proposed = decision?.value?.trim() ?? "";
  // A proposal that is not an answer but an admission of not having one.
  //
  // Found on a real Belvedere Trading run (2026 08 22): the candidate's
  // intake stores a city and a country but no street address and no postal
  // code, so the model answered two REQUIRED fields with the literal string
  // "Not provided", this function typed it, and the board refused the
  // submission with the form still on screen. Filler is not a best effort
  // answer, it is the absence of one wearing an answer's clothes, and typing
  // it into a real employer's form under a real person's name is exactly what
  // HARD STOP 9 forbids: if the intake does not support an honest answer, the
  // question goes to the candidate.
  //
  // Scoped to text this system would TYPE. A menu that offers "N/A" as one of
  // its own options is a different thing entirely: choosing an option the
  // employer wrote is answering their question in their own words, so the
  // option paths below are deliberately not gated on this.
  if (
    proposed !== "" &&
    !OPTION_KINDS.has(field.kind) &&
    NON_ANSWER_RE.test(proposed)
  ) {
    return askOrSkip(
      field,
      `${why}; the only answer available was ${JSON.stringify(proposed.slice(0, 40))}, which ` +
        `states that nothing is known rather than answering, and filler is not put on a real ` +
        `employer's form`,
      question
    );
  }
  if (proposed !== "") {
    if (OPTION_KINDS.has(field.kind) && field.optionsKnown && field.options.length > 0) {
      // Through `matchOption` rather than an exact compare of its own, which is
      // what this did before review caught it. The two had drifted apart, so a
      // best effort answer was held to a stricter rule than a fact backed one:
      // "How did you hear about us?" offering "LinkedIn (Job Post)" rejected an
      // inferred "LinkedIn" and stopped the application. `matchOption` only ever
      // returns an option the menu actually offers, so routing through it is no
      // less safe and considerably less silly.
      const match = matchOption(field.options, proposed, hints);
      if (match !== null) {
        return {
          kind: "apply",
          value: match,
          declined: false,
          note: `a best effort answer chosen from the control's own options: ${why}`,
        };
      }
      // The reported options are a truncated prefix of a longer live list
      // (issue #94). The action layer only ever chooses an option the DOM
      // itself offers, so a proposal beyond the reported prefix is checked
      // against the full live list there instead of refused here, and a
      // wording that is not really on the list still escalates.
      if (field.optionsTruncated) {
        return {
          kind: "apply",
          value: proposed,
          declined: false,
          note:
            `a best effort answer matched against the control's full live option list, since ` +
            `the reported list is a truncated prefix: ${why}`,
        };
      }
      // JOB-044. Nothing on the menu says what was proposed, but a combobox
      // asking for a school is a text input first and a suggestion list
      // second — see `SCHOOL_FIELD_LABEL_RE`. Typing the candidate's own
      // school where none of the offered options match it is answering the
      // question, not guessing at one, so this is applied as free text rather
      // than escalated. `applyFieldValue`'s caller passes `allowFreeText` for
      // exactly this field shape, which is what lets the control keep the
      // typed value instead of requiring a click on an option that does not
      // exist.
      //
      // Gated on the fact key too, not just the label — see `SCHOOL_FACT_KEY_RE`.
      // Label alone cannot tell a "which school did you attend" question apart
      // from a university employer's own "which School/College is this role
      // in" org-structure question, and `proposed` typed as free text onto the
      // wrong one of those states something about the employer's org chart,
      // not the candidate.
      if (
        field.kind === "combobox" &&
        SCHOOL_FIELD_LABEL_RE.test(field.label) &&
        SCHOOL_FACT_KEY_RE.test(decision?.sourceFact ?? "")
      ) {
        return {
          kind: "apply",
          value: proposed,
          declined: false,
          note: `a best effort answer typed as free text, since none of the dropdown's own options said it: ${why}`,
        };
      }
    } else {
      return {
        kind: "apply",
        value: proposed,
        declined: false,
        note: `a best effort answer: ${why}`,
      };
    }
  }

  // Nothing usable was proposed. A box that takes prose can still have an answer
  // written for it from the candidate's validated profile, which is the same
  // path a cover letter takes and is grounded in the same facts.
  //
  // A `text` control only qualifies when its label reads like a question. That
  // distinction is doing real work: Ashby draws "Have you worked with any
  // startups previously? If so, list and describe." as a single line input, and
  // so is "End date year". Writing prose into the first is the fix; writing
  // prose into the second would put a sentence where a year goes.
  if (field.kind === "textarea" || (field.kind === "text" && asksAQuestion(field.label))) {
    return { kind: "generate", note: `no usable value was proposed, so this is written: ${why}` };
  }
  return askAbout(field, why, question);
}

/** A label that reads as a question to answer rather than as the name of a box. */
function asksAQuestion(label: string): boolean {
  return label.includes("?") || label.trim().split(/\s+/).length >= 7;
}

/**
 * The answering policy, enforced.
 *
 * `decideFieldAnswers` states the same rules to the model in English; this
 * function is what happens when the model does not follow them, and it is the
 * half that actually holds. Note the order: the demographic rule is checked
 * *first* and unconditionally, before the model's own decision is even read, so
 * a "Gender" select can only ever be declined, asked about, or left alone — no
 * output from any model can put an identity in it.
 *
 * ── JOB-022: what happens when a check fails ────────────────────────────────
 * Every rule below still runs and still fails exactly where it used to. What
 * changed is what failing means, and it now depends entirely on which kind of
 * question failed:
 *
 *  · A demographic question is unchanged. Declined, asked about, or left alone.
 *  · A legal attestation goes to `declineOrAsk`: the stored answer if there is
 *    one, otherwise the control's own decline option, otherwise it stops.
 *  · Everything else goes to `inferOrAsk` and gets the best answer available
 *    rather than ending the run.
 *
 * That third line is the ticket. Before it, a check failing for any reason at
 * all, whether a degree abbreviation spelled differently from a dropdown, a
 * date field with no matching fact key, or a question about office preference,
 * ended the application. It ended 18 of 21 of them on 2026 08 20.
 */
export function resolveDecision(
  field: EnumeratedField,
  decision: FieldDecision | undefined,
  facts: ReadonlyMap<string, CandidateFact>
): Resolution {
  // Where a failed check goes. Bound once, at the top, so that no branch below
  // can accidentally keep the old unconditional stop: every `refuse` in this
  // function routes by category rather than by which line noticed the problem.
  const hints = geographyHints(facts);
  const refuse = (why: string, question?: string | null): Resolution =>
    LEGAL_ATTESTATION_RE.test(field.label)
      ? declineOrAsk(field, why, question)
      : inferOrAsk(field, decision, why, question, hints);

  // A gap and a contradiction are not the same failure, and only the first one
  // is best guessed.
  //
  // `refuse` handles a gap: nothing known answers this, so the model's best
  // answer goes in. `contradict` handles the other case, where the model named a
  // stored fact and then proposed something that fact positively disagrees with
  // such as a resume saying "B.S." against an option saying "Master's Degree".
  // to "apply it anyway" there would let a wrong claim through the exact check
  // written to catch it, and a degree nobody holds is not a small inaccuracy.
  //
  // So the value that was just disproved is dropped, and only then does the
  // ordinary path run. For a dropdown that means asking. For a prose box it
  // means writing an answer from the facts instead of from the bad proposal.
  const contradict = (why: string, question?: string | null): Resolution =>
    LEGAL_ATTESTATION_RE.test(field.label)
      ? declineOrAsk(field, why, question)
      : inferOrAsk(field, undefined, why, question, hints);

  // ── Demographic and self-identification questions ────────────────────────
  if (EEO_FIELD_RE.test(field.label)) {
    if (!field.required) {
      return {
        kind: "skip",
        why:
          "an optional self-identification question — left blank, which is the same answer " +
          "as declining and needs no control on the page",
      };
    }
    const decline = findDeclineOption(field.options);
    if (decline !== null) {
      return {
        kind: "apply",
        value: decline,
        declined: true,
        note:
          "a required self-identification question, answered by declining to self-identify — " +
          "the only truthful answer available without asserting a demographic identity",
      };
    }
    return askAbout(
      field,
      field.optionsKnown
        ? "a required self-identification question whose options include no way to decline, " +
          "and a demographic identity will never be invented for a real person"
        : "a required self-identification question whose options could not be read, so the " +
          "decline option could not be found",
      `The form requires an answer to "${field.label}" and offers no "decline to answer" ` +
        `option. What would you like to put, if anything?`
    );
  }

  // ── Agreements, consents and certifications ──────────────────────────────
  //
  // Rewritten after review on this PR. This branch used to stop the run for
  // every box matching `CONSENT_FIELD_RE`, before any ladder, without even
  // looking at `required`. "I certify that the information provided is true and
  // complete" and "I have read and agree to the Privacy Policy" are on a large
  // share of application forms and are required on most of them, so the old
  // behaviour meant those forms could not be finished at all, whatever else was
  // fixed. That is precisely the bail-instead-of-fill outcome this ticket is
  // about, and consent boxes are NOT in the stated carve-out, which is
  // specifically legal attestations.
  //
  // Two branches now, and the split is on required rather than on wording:
  //
  //  · Required: tick it. The candidate asked this system to submit applications
  //    on their behalf; a form that will not submit without an agreement box is
  //    a term of doing the thing they asked for. Certifying that the information
  //    is true is also a claim this system is in an unusually good position to
  //    make, since every value on the form came from what the candidate stated.
  //  · Optional: leave it. An optional consent box is almost always a marketing
  //    opt-in or a talent-pool subscription, and nobody asked for either.
  //
  // An agreement that is ALSO a legal attestation, "I certify I am authorized to
  // work in the United States", is not covered by either branch and falls
  // through to the ordinary ladder below, which is where it belongs.
  //
  // Issue #94 widened the same policy across the three shapes boards actually
  // draw an agreement as: a checkbox (the original case), a yes/no radio group
  // ("Yes, I consent" / "No, I do not consent" on Lever's multiple-choice
  // cards), and a typed digital-signature field (Workable). The first two get
  // the required-tick/optional-skip split above; the typed form is never
  // written into by a model and goes to the candidate instead, because a
  // signature is not a fact anybody can report on someone's behalf.
  if (CONSENT_FIELD_RE.test(field.label) && !isAttestationField(field.label)) {
    if (field.kind === "checkbox") {
      if (!field.required) {
        return {
          kind: "skip",
          why:
            "an optional agreement box, which is an opt-in nobody asked for rather than a " +
            "condition of applying",
        };
      }
      return {
        kind: "apply",
        value: "Yes",
        declined: false,
        note:
          "a required agreement the form will not submit without, ticked on the candidate's " +
          "instruction to submit applications on their behalf",
      };
    }
    // The same agreement drawn as a two-option radio group: "Yes, I consent" /
    // "No, I do not consent" is how Lever renders processing consent on its
    // multiple-choice cards (issue #94). Same policy as the checkbox form of
    // it, decided here deterministically rather than left to a model:
    // required means agreeing is a term of submitting at all, optional means
    // nobody asked for it. Only when exactly one option clearly affirms —
    // an ambiguous group falls through to the ordinary ladder below.
    if (field.kind === "radio" && field.optionsKnown) {
      const affirming = field.options.filter((option) => /^yes\b/i.test(option.trim()));
      const chosen = affirming[0];
      if (affirming.length === 1 && chosen !== undefined) {
        if (!field.required) {
          return {
            kind: "skip",
            why:
              "an optional agreement choice, which is an opt-in nobody asked for rather than " +
              "a condition of applying",
          };
        }
        return {
          kind: "apply",
          value: chosen,
          declined: false,
          note:
            "a required agreement the form will not submit without, answered with its own " +
            "consenting option on the candidate's instruction to submit applications on " +
            "their behalf",
        };
      }
    }
  }

  // A consent or agreement statement drawn as a *typed* field rather than a
  // box. Workable renders digital-signature questions this way: the full
  // legal paragraph as the label ("...By signing your digital signature
  // below, you agree...") over a required text input (issue #94). Typing
  // anything into one signs the agreement in the candidate's name, and
  // model-written prose in one would be worse: a fabricated signature. Same
  // rule as every attestation, decided before any model proposal is
  // consulted: the candidate's own words or nothing.
  if (
    (field.kind === "text" || field.kind === "textarea") &&
    CONSENT_FIELD_RE.test(field.label) &&
    !LEGAL_ATTESTATION_RE.test(field.label)
  ) {
    return declineOrAsk(
      field,
      "an agreement or signature statement drawn as a typed field, which is signed by the " +
        "candidate in their own words or not at all"
    );
  }

  if (decision === undefined) {
    return refuse("no decision was returned for this field");
  }

  switch (decision.decision) {
    case "generate": {
      // JOB-022: `text` joins `textarea`. Ashby and Greenhouse both render short
      // answer questions ("What is your current visa status?", "Have you worked
      // with any startups previously?") as single line inputs, and refusing to
      // write into one meant a question that had an answer went unanswered
      // because of the control it happened to be drawn with.
      if (field.kind !== "textarea" && field.kind !== "text") {
        return refuse(
          `a written answer was proposed for a ${field.kind} control, which is not somewhere ` +
            `prose belongs`,
          decision.question
        );
      }
      // Prose is composed from the candidate's facts, and a legal attestation is
      // not a thing to compose. "What is your current visa status?" is drawn as
      // a plain text box on Ashby, and writing a paragraph into it would be
      // stating an immigration status in somebody's name. Same ladder as every
      // other attestation: the stored answer, then a decline option, then stop.
      if (LEGAL_ATTESTATION_RE.test(field.label)) {
        return declineOrAsk(
          field,
          "a legal attestation, which is answered from what the candidate stated or not at all",
          decision.question
        );
      }
      if (!field.required) {
        return {
          kind: "skip",
          why: "an optional free-text box — left blank rather than filled with unasked-for prose",
        };
      }
      return { kind: "generate", note: decision.why };
    }

    // JOB-022. The model's explicit "I am not certain, but this is the best
    // answer the profile supports" verdict. It carries no `sourceFact`, so it
    // cannot go down the `answer` path, and that is the point: it is recorded as
    // a best effort in the field outcome rather than as a report of a fact.
    // `inferOrAsk` is what decides whether it is allowed, and it is never
    // allowed for an attestation.
    case "infer":
      return refuse(decision.why || "answered as best the profile supports");

    case "answer": {
      const value = decision.value?.trim() ?? "";
      if (value === "") return refuse("an answer was proposed with no value in it");

      const fact = decision.sourceFact === null ? undefined : facts.get(decision.sourceFact);
      if (fact === undefined) {
        return refuse(
          `an answer was proposed without naming a known fact to back it ` +
            `(${JSON.stringify(decision.sourceFact ?? "none")}), and nothing factual about a ` +
            `real person is asserted on a real application without one`,
          decision.question
        );
      }

      // The attestation ladder, on the one path that used to skip it entirely.
      // `refuse` and `contradict` both consult `LEGAL_ATTESTATION_RE`, so every
      // FAILING check routed an attestation correctly, and a PASSING one walked
      // straight past, because nothing on the success path asked whether the
      // named fact had anything to do with the question. That is what let a
      // relocation preference answer an ITAR question. Checked here, above the
      // value comparison, because by the time `optionSupportsFact` runs the only
      // thing left to compare is text against text.
      if (
        LEGAL_ATTESTATION_RE.test(field.label) &&
        !attestationFactAllowed(field.label, fact.key)
      ) {
        return declineOrAsk(
          field,
          `a legal attestation, and the stored fact "${fact.key}" offered to back it is not ` +
            `about what this question asks: a fact that happens to read ` +
            `${JSON.stringify(fact.value)} is not an answer to a question nobody checked it ` +
            `against`,
          decision.question
        );
      }

      if (OPTION_KINDS.has(field.kind)) {
        if (field.optionsKnown && field.options.length > 0) {
          const match = matchOption(field.options, value, hints);
          if (match === null) {
            // The reported options are a truncated prefix of a longer live
            // list (issue #94: Lever's university dropdown holds 3,302
            // options and reports its first 60). The decision prompt
            // explicitly permits proposing an option beyond the prefix with
            // the promise that it "will be checked against the live list";
            // this is where that promise is kept rather than broken. The
            // action layer (`selectNative`, `chooseFromMenu`) only ever
            // chooses an option the DOM itself offers, so a wording that is
            // not really on the list fails there, one step later, with the
            // same escalation. The fact check still runs here, first.
            if (field.optionsTruncated) {
              if (!optionSupportsFact(value, fact.value, fact.key, field.label)) {
                return contradict(
                  `the proposed option ${JSON.stringify(value.slice(0, 80))} does not say what ` +
                    `the stored fact "${fact.key}" says ` +
                    `(${JSON.stringify(fact.value.slice(0, 80))})`,
                  decision.question
                );
              }
              return {
                kind: "apply",
                value,
                declined: false,
                note:
                  `proposed from the stored fact "${fact.key}"; the control lists more options ` +
                  `than were read, so this is matched against the live list before anything ` +
                  `is chosen`,
              };
            }
            return refuse(
              `"${value}" is not one of the options this control offers`,
              decision.question
            );
          }
          if (!optionSupportsFact(match, fact.value, fact.key, field.label)) {
            return contradict(
              `the option ${JSON.stringify(match)} does not say what the stored fact ` +
                `"${fact.key}" says (${JSON.stringify(fact.value)}), so choosing it would be a ` +
                `different statement from the one this system was told`,
              decision.question
            );
          }
          return {
            kind: "apply",
            value: match,
            declined: false,
            note: `chosen from the control's own options, from the stored fact "${fact.key}"`,
          };
        }
        // The list was not read. The action layer will only click an option that
        // is literally on the menu, so an invented value fails there instead of
        // here — which is the same outcome, one step later.
        return {
          kind: "apply",
          value,
          declined: false,
          note:
            `proposed from the stored fact "${fact.key}"; the control's options were not read ` +
            `in advance, so this is matched against the live list before anything is clicked`,
        };
      }

      if (field.kind === "checkbox") {
        // A checkbox is a yes/no assertion, so the check that belongs here is
        // the boolean one: does ticking (or leaving) this box say what the
        // stored fact says? Without it this branch was the one place a
        // fact-backed answer skipped verification entirely — a model could cite
        // a real `willingToRelocate = "No"` and propose "Yes", and the read-back
        // would happily confirm the box it was just told to tick. No injection
        // needed for that, only an ordinary slip, and the result is a false
        // statement about work authorization or relocation sitting on a real
        // employer's form.
        const proposed = booleanAnswer(value);
        const backed = booleanAnswer(fact.value);
        if (proposed === null) {
          return refuse(
            `${JSON.stringify(value.slice(0, 40))} is neither a yes nor a no, and a checkbox ` +
              `can only state one or the other`,
            decision.question
          );
        }
        if (backed === null) {
          return refuse(
            `the stored fact "${fact.key}" (${JSON.stringify(fact.value.slice(0, 40))}) is not a ` +
              `yes or a no, so it cannot say whether this box should be ticked`,
            decision.question
          );
        }
        if (proposed !== backed) {
          return contradict(
            `ticking this box would state ${proposed ? '"yes"' : '"no"'}, but the stored fact ` +
              `"${fact.key}" says ${JSON.stringify(fact.value.slice(0, 40))} — the opposite of ` +
              `what this system was told, and not something to assert on a real application`,
            decision.question
          );
        }
        return {
          kind: "apply",
          value,
          declined: false,
          note: `from the stored fact "${fact.key}"`,
        };
      }

      // A typed field. The value must be the fact itself or a part of it —
      // "San Francisco" out of "San Francisco, CA" is a narrowing, while
      // anything the fact does not contain is new text about a real person.
      const wanted = normalizeText(value);
      const known = normalizeText(fact.value);
      if (wanted !== known && !known.includes(wanted)) {
        return contradict(
          `the proposed answer ${JSON.stringify(value.slice(0, 80))} is not what the stored ` +
            `fact "${fact.key}" says (${JSON.stringify(fact.value.slice(0, 80))}), so it would ` +
            `be new information about the candidate rather than a report of it`,
          decision.question
        );
      }
      return {
        kind: "apply",
        value,
        declined: false,
        note: `typed from the stored fact "${fact.key}"`,
      };
    }

    case "decline": {
      const value = decision.value?.trim() ?? "";
      const match = field.options.find(
        (option) => normalizeText(option) === normalizeText(value)
      );
      // `DECLINE_OPTION_RE` rather than a looser local pattern, and the
      // difference matters: a pattern that merely looked for "not" would accept
      // "I am not a protected veteran" as a refusal to answer. That is not a
      // refusal, it is an assertion about a real person, and it is exactly the
      // kind of thing this system must never make on their behalf.
      if (match === undefined || !DECLINE_OPTION_RE.test(match)) {
        return refuse(
          `a "prefer not to answer" option was proposed but the control does not offer one ` +
            `matching ${JSON.stringify(value.slice(0, 60))}`,
          decision.question
        );
      }
      return {
        kind: "apply",
        value: match,
        declined: true,
        note: "answered by declining, using the control's own decline option",
      };
    }

    // JOB-022. `ask` used to be final, and it is now a request rather than a
    // verdict: the model saying "I would rather the candidate answered this" is
    // honoured for an attestation and overruled for everything else, because for
    // everything else stopping the run is the more expensive mistake. The
    // model's own question survives either way, so if this does end up blocking,
    // the person still sees the sentence the model wrote for them.
    case "ask":
      return refuse(
        decision.why || "nothing known about the candidate answers this",
        decision.question
      );

    case "skip":
    default:
      return refuse(decision.why || "nothing known about the candidate answers this");
  }
}

type RemainingFieldsResult = {
  outcomes: FieldOutcome[];
  needsInput: NeedsInputItem[];
  /**
   * JOB-170. One entry per field this pass answered through the fabrication
   * rung or its sane default fallback, for `applications.answer_provenance`.
   * Empty on every pass that fabricated nothing, including every
   * repeating-sections pass, which deliberately never fabricates.
   */
  answerProvenance: AnswerProvenanceEntry[];
};

/**
 * JOB-047. How many entries this puts into one repeating section.
 *
 * One, deliberately. Every board that has such a section requires *at least*
 * one entry, and one is what clears that. Replaying a whole work history into N
 * entries is a different job with its own questions — which jobs, in what
 * order, what to do when the resume has six and the form takes three, and what
 * "Save" means when an entry half fails — and doing it badly would put wrong
 * employment history on a real application under somebody's name. This fills
 * the most recent entry, correctly, and stops.
 */
const MAX_ENTRIES_PER_REPEATING_SECTION = 1;

/** How long a subform gets to mount its inputs after its add control is pressed. */
const SUBFORM_MOUNT_TIMEOUT_MS = 8_000;
const SUBFORM_MOUNT_POLL_MS = 400;

/** How long the form gets to stop re-rendering after the resume was attached. */
const FORM_STABLE_BUDGET_MS = 12_000;
const FORM_STABLE_POLL_MS = 900;

/**
 * Waits for a repeating section's entry to mount, and reports what is new.
 *
 * Polling `enumerateFormFields` rather than reusing `settleBeforeReading`: that
 * helper measures the page through `readStructuralFloor`, which counts light
 * DOM inputs with `document.querySelectorAll`. On the board this was written
 * for, every input is inside a shadow root, so that floor reads zero before the
 * click and zero after it and "the DOM stopped growing" is true the instant it
 * is asked. Here the thing being waited for is precisely the thing perception
 * reports, so perception is the right thing to wait on.
 *
 * Field selectors are stable between passes (see `FIELD_HANDLE_ATTR`), which is
 * what makes "not in the previous read" mean "mounted just now".
 */
async function awaitMountedEntryFields(
  session: BrowserSession,
  before: ReadonlySet<string>
): Promise<EnumeratedField[]> {
  const deadline = Date.now() + SUBFORM_MOUNT_TIMEOUT_MS;
  let fresh: EnumeratedField[] = [];
  for (;;) {
    const now = await enumerateFormFields(session.page);
    fresh = now.filter((field) => !before.has(field.selector));
    if (fresh.length > 0 || Date.now() >= deadline) break;
    await sleep(SUBFORM_MOUNT_POLL_MS);
  }
  return fresh.filter(
    (field) =>
      field.currentValue === "" &&
      field.kind !== "file" &&
      field.kind !== "other" &&
      field.label !== ""
  );
}

/**
 * Waits for the form to stop changing shape under its own steam.
 *
 * The resume is attached immediately before this, and a board that reads the
 * uploaded file re-renders the form when it is done — SmartRecruiters
 * repopulates from the parse. An entry filled in during that window is filled
 * into a subtree the framework is about to replace, and the symptom is
 * peculiarly quiet: every field reads back correctly, Save is found and pressed,
 * and the entry is simply not there afterwards. That is exactly what happened on
 * the live RRS Group run to the Experience section and not to Education, which
 * is the tell — the second section runs late enough that the page has finished.
 *
 * Two consecutive reads agreeing is the same test `settleBeforeReading` applies,
 * measured through this pipeline's own perception pass rather than through
 * `readStructuralFloor`, whose `document.querySelectorAll` counts nothing at all
 * on a form built out of web components.
 */
async function awaitStableForm(session: BrowserSession): Promise<void> {
  const deadline = Date.now() + FORM_STABLE_BUDGET_MS;
  let previous = -1;
  while (Date.now() < deadline) {
    const count = (await enumerateFormFields(session.page)).length;
    if (count === previous) return;
    previous = count;
    await sleep(FORM_STABLE_POLL_MS);
  }
  console.warn(
    `${LOG} the form was still changing shape after ${FORM_STABLE_BUDGET_MS}ms ` +
      `(${previous} readable control(s)); filling it anyway`
  );
}

/**
 * Fills the required repeating sections a form opens with, one entry each.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A SmartRecruiters form has "Experience *" and "Education *" sections holding
 * a heading, an `Add` button and a red "Please provide at least one work
 * experience entry" — and no inputs of any kind. `fillRemainingFields` below
 * cannot help, because there is nothing on the page for it to enumerate: those
 * fields are not skipped or mis-answered, they are structurally invisible. A
 * run against a real RRS Group listing on 2026-08-22 filled every other field
 * and still went nowhere, because the board had two complaints that nothing in
 * this pipeline could have addressed.
 *
 * ── What it does, and what it does not ──────────────────────────────────────
 * It presses `Add` (through the guarded, model-free click in `form-fields.ts`),
 * waits for the entry's inputs to mount, and hands those inputs to exactly the
 * same path every other field goes through: `decideFieldAnswers` with no tools,
 * `resolveDecision` for policy, `applyFieldValue` with a read-back. There is no
 * second decision mechanism, and nothing read off the page becomes an
 * instruction anybody executes. The section heading is used to *prefix a label*
 * so a model can tell an education entry's dates from a work entry's, and that
 * label travels as data in a typed field of a tool-free call, exactly as every
 * other form label already does.
 */
async function fillRepeatingSections(
  session: BrowserSession,
  state: ApplicationState,
  jobDescription: string | null,
  facts: readonly CandidateFact[],
  factsByKey: ReadonlyMap<string, CandidateFact>
): Promise<RemainingFieldsResult> {
  const outcomes: FieldOutcome[] = [];
  const needsInput: NeedsInputItem[] = [];

  await awaitStableForm(session);

  const sections = await enumerateRepeatingSections(session.page);
  if (sections.length === 0) return { outcomes, needsInput, answerProvenance: [] };

  console.log(
    `${LOG} ${sections.length} required repeating section(s): ` +
      sections.map((section) => section.heading).join(", ")
  );

  for (const section of sections) {
    for (let entry = 0; entry < MAX_ENTRIES_PER_REPEATING_SECTION; entry++) {
      const before = new Set((await enumerateFormFields(session.page)).map((f) => f.selector));

      await sleep(randomInteractionDelayMs());
      const added = await pressAddEntry(session.page, section);
      if (!added.ok) {
        outcomes.push({
          field: section.key,
          intended: null,
          outcome: "skipped",
          detail: `required — the "${section.heading}" section could not be opened: ${added.detail}`,
        });
        console.warn(`${LOG} ${section.heading}: ${added.detail}`);
        continue;
      }

      const fresh = await awaitMountedEntryFields(session, before);
      if (fresh.length === 0) {
        outcomes.push({
          field: section.key,
          intended: null,
          outcome: "skipped",
          detail:
            `required — the "${section.heading}" section's add control was pressed but no ` +
            `fields appeared within ${SUBFORM_MOUNT_TIMEOUT_MS}ms`,
        });
        continue;
      }
      console.log(
        `${LOG} ${section.heading}: ${fresh.length} field(s) mounted — ` +
          fresh.map((f) => `${f.label}${f.required ? "*" : ""}`).join(", ")
      );

      // Same as step 4 of the ordinary pass: open the dropdowns that stand
      // between this and a satisfied section, so the decision sees real wording.
      for (const field of fresh) {
        if (!field.required) continue;
        if (!OPTION_KINDS.has(field.kind) || field.optionsKnown) continue;
        const harvested = await harvestOptions(session.page, field);
        field.options = harvested.options;
        field.optionsKnown = harvested.options.length > 0;
        field.optionsTruncated = harvested.truncated;
      }

      // The heading qualifies the label so "From", "To" and "Description" mean
      // something. They repeat verbatim between the two sections, and a
      // decision call that cannot tell an education entry's dates from a work
      // entry's is being asked an unanswerable question.
      const decidable: DecidableField[] = fresh.map((field) => ({
        key: field.key,
        label: `${section.heading}: ${field.label}`,
        kind: field.kind,
        required: field.required,
        options: field.options,
        optionsKnown: field.optionsKnown,
        optionsTruncated: field.optionsTruncated,
        helpText: field.helpText,
      }));

      let decisions: FieldDecision[];
      try {
        decisions = await decideFieldAnswers({
          fields: decidable,
          facts,
          company: state.company,
          jobTitle: state.jobTitle,
          jobDescription,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        outcomes.push({
          field: section.key,
          intended: null,
          outcome: "skipped",
          detail: `required — no answers could be decided for the "${section.heading}" entry: ${reason}`,
        });
        console.warn(`${LOG} ${section.heading}: decision call failed — ${reason}`);
        continue;
      }
      const byKey = new Map(decisions.map((decision) => [decision.fieldKey, decision]));

      const escalate = (field: EnumeratedField, question: string, why: string): void => {
        needsInput.push({
          key: field.key,
          fieldLabel: `${section.heading}: ${field.label}`,
          question,
          why,
          required: field.required,
          kind: field.kind,
          ...(field.optionsKnown && field.options.length > 0 ? { options: field.options } : {}),
        });
      };

      for (const field of fresh) {
        const decision = byKey.get(field.key);
        const resolution = resolveDecision(field, decision, factsByKey);

        // Nothing in a work or education entry is a prose question, so a
        // "generate" verdict here means the field was not recognised rather
        // than that an essay is wanted. Both it and "skip" leave the box blank.
        if (resolution.kind === "skip" || resolution.kind === "generate") {
          const why =
            resolution.kind === "skip"
              ? resolution.why
              : "nothing in the candidate's own data answers this entry field";
          if (field.required) {
            escalate(
              field,
              `The "${section.heading}" section asks for "${field.label}". What should we put?`,
              why
            );
          }
          outcomes.push({
            field: field.key,
            intended: null,
            outcome: field.required ? "needs-input" : "skipped",
            detail: `${section.heading} entry — left blank: ${why}`,
          });
          continue;
        }
        if (resolution.kind === "ask") {
          escalate(field, resolution.question, resolution.why);
          outcomes.push({
            field: field.key,
            intended: null,
            outcome: "needs-input",
            detail: `${section.heading} entry — left blank and escalated: ${resolution.why}`,
          });
          continue;
        }

        await sleep(randomInteractionDelayMs());
        const value = resolution.value;
        const outcome = await applyFieldValue(session.page, field, value, {
          allowContains: OPTION_KINDS.has(field.kind) && field.options.length === 0,
          // The same double gate the ordinary pass uses: a school-shaped
          // combobox whose answer came from a school-shaped fact. An employer
          // name typed into a company picker that does not list it is left
          // unmatched instead, because an autocomplete holding unmatched text
          // looks filled and submits empty.
          allowFreeText:
            field.kind === "combobox" &&
            SCHOOL_FIELD_LABEL_RE.test(field.label) &&
            SCHOOL_FACT_KEY_RE.test(decision?.sourceFact ?? ""),
          // JOB-051's tie break, on the same footing as the ordinary pass: the
          // country the candidate attested, used only to choose between
          // suggestions that already contain the value.
          ...(OPTION_KINDS.has(field.kind)
            ? { contextTerms: countryContextTerms(state.applicationAnswers.currentCountry) }
            : {}),
        });

        if (outcome.ok) {
          outcomes.push({
            field: field.key,
            intended: value,
            outcome: "filled",
            detail: `${section.heading} entry — ${resolution.note}; ${outcome.detail}`,
            readBack: outcome.readBack,
          });
          console.log(`${LOG} ${section.heading}: ${field.label} filled + verified`);
          continue;
        }
        if (outcome.readBack !== "") {
          // Into the same mismatch channel every other field uses, so that
          // `assertNoMismatches` refuses to let the run continue. A wrong value
          // in a real employer's work history is exactly what that guard is for.
          outcomes.push({
            field: field.key,
            intended: value,
            outcome: "mismatch",
            detail: `${section.heading} entry — ${outcome.detail}`,
            readBack: outcome.readBack,
          });
          continue;
        }
        outcomes.push({
          field: field.key,
          intended: value,
          outcome: field.required ? "needs-input" : "skipped",
          detail: `${section.heading} entry — ${outcome.detail}`,
        });
        if (field.required) {
          escalate(
            field,
            `"${field.label}" in the "${section.heading}" section could not be set to ` +
              `${JSON.stringify(value.slice(0, 80))}. ${outcome.detail}. What should we put?`,
            `the value could not be applied — ${outcome.detail}`
          );
        }
      }

      // Commit. SmartRecruiters does not count an entry until its own Save is
      // pressed: the fields can read back perfectly and the section still
      // reports itself empty. A board with no such control says so, and that is
      // not a failure — it commits the entry as it is typed.
      await sleep(randomInteractionDelayMs());
      const committed = await pressCommitEntry(session.page, section);
      console.log(`${LOG} ${section.heading}: commit — ${committed.detail}`);

      // The read-back for the section as a whole. Two ways it can fail and both
      // count: the board still showing its "at least one entry" complaint, and
      // the entry's own form still sitting there uncommitted. The second one
      // does not raise the first — a section in edit mode is not a section
      // reporting itself empty — so believing only the board's words would have
      // called an uncommitted entry a filled section, which is precisely the
      // "status fields lie" failure this project keeps relearning.
      await sleep(SUBFORM_MOUNT_POLL_MS);
      const boardComplains = await sectionStillUnsatisfied(session.page, section);
      const uncommitted = !committed.ok && !/no control that commits an entry/.test(committed.detail);
      const stillComplaining = boardComplains || uncommitted;
      outcomes.push({
        field: section.key,
        intended: "one entry",
        outcome: stillComplaining ? "needs-input" : "filled",
        detail: stillComplaining
          ? `required — the "${section.heading}" section does not hold a committed entry: ` +
            `${uncommitted ? committed.detail : "the board still reports it as empty"}`
          : `required — one entry added to the "${section.heading}" section (${committed.detail})`,
      });
      if (stillComplaining) {
        needsInput.push({
          key: section.key,
          fieldLabel: section.heading,
          question: `The "${section.heading}" section still needs at least one entry. What should we put in it?`,
          why: `an entry was filled in but ${committed.detail}`,
          required: true,
          kind: "other",
        });
      }
    }
  }

  return { outcomes, needsInput, answerProvenance: [] };
}

/**
 * Perception → decision → action, over every field the named-field pass did not
 * already fill.
 *
 * Ordering inside here is not incidental:
 *
 *  1. Read the whole form. Nothing is decided yet and no model has seen it.
 *  2. Drop anything already carrying a value. That is what keeps this from
 *     re-typing over the eight fields above and over anything the board itself
 *     pre-filled, without needing to know which selectors those were.
 *  3. Apply the user's own answers first, deterministically. A question they
 *     have already answered is not a question, and no model needs to be asked
 *     about it again.
 *  4. Open the dropdowns that block submission, so the decision sees the real
 *     option strings rather than guessing at wording.
 *  5. One tool-free decision call over what is left.
 *  6. Enforce the policy in TypeScript, then act, then read back.
 */
async function fillRemainingFields(
  session: BrowserSession,
  state: ApplicationState,
  profile: ResumeProfile,
  jobDescription: string | null,
  additionalAnswers: Record<string, string>
): Promise<RemainingFieldsResult> {
  const outcomes: FieldOutcome[] = [];
  const needsInput: NeedsInputItem[] = [];

  const facts = buildFactCatalog(profile, state.applicationAnswers, additionalAnswers);
  const factsByKey = new Map(facts.map((fact) => [fact.key, fact]));

  // JOB-047. Before anything is enumerated, because a required repeating
  // section has no fields to enumerate until its add control has been pressed.
  // Running it first also means the entry's inputs are gone again by the time
  // the ordinary pass reads the page: a committed entry collapses to a summary
  // card, and what is left is the form the rest of this function expects.
  const repeating = await fillRepeatingSections(
    session,
    state,
    jobDescription,
    facts,
    factsByKey
  );
  outcomes.push(...repeating.outcomes);
  // Held apart from `needsInput` until the very end of this function, and that
  // is not a detail. The unknown-required-field fallback near the bottom takes
  // everything still in `needsInput` and hands it to `act()` with "fill this
  // with the most appropriate value for a job applicant", which is a licence to
  // invent — and inventing a school or an employer is precisely what HARD STOP 9
  // forbids, because the applicant is the one who attests to it. A live run
  // showed why: an Education "Institution" that this pass could not fill came
  // back holding "Stanford University", read off the Company box a few
  // centimetres up the page, for a candidate who attends Georgia Tech. A work
  // or education entry is only ever filled from the candidate's own facts, or
  // escalated to them.
  const repeatingNeedsInput = repeating.needsInput;

  const all = await enumerateFormFields(session.page);
  console.log(`${LOG} the form has ${all.length} readable control(s)`);

  const empty = all.filter(
    (field) =>
      field.currentValue === "" &&
      field.kind !== "file" &&
      field.kind !== "other" &&
      field.label !== ""
  );
  if (empty.length === 0) {
    return {
      outcomes,
      needsInput: [...needsInput, ...repeatingNeedsInput],
      answerProvenance: [...repeating.answerProvenance],
    };
  }
  console.log(
    `${LOG} ${empty.length} control(s) still empty: ` +
      empty.map((field) => `${field.label}${field.required ? "*" : ""}`).join(", ")
  );

  const record = (
    field: EnumeratedField,
    outcome: FieldOutcome["outcome"],
    intended: string | null,
    detail: string,
    readBack?: string | null
  ): void => {
    outcomes.push({
      field: field.key,
      intended,
      outcome,
      detail: `${field.required ? "required — " : ""}${detail}`,
      ...(readBack === undefined ? {} : { readBack }),
    });
  };

  /**
   * Issue #100. The control each escalated question came off, kept by the item's
   * own identity rather than by its key, because `key` is the label folded to
   * lower case and two controls on one form can share a label. The fallback at
   * the bottom needs the selector to read back what it did, and a map keyed by
   * object identity cannot hand it the wrong one.
   */
  const escalatedFrom = new Map<NeedsInputItem, EnumeratedField>();

  const ask = (field: EnumeratedField, question: string, why: string): void => {
    const item: NeedsInputItem = {
      key: field.key,
      fieldLabel: field.label,
      question,
      why,
      required: field.required,
      kind: field.kind,
      ...(field.optionsKnown && field.options.length > 0 ? { options: field.options } : {}),
    };
    needsInput.push(item);
    escalatedFrom.set(item, field);
    record(field, "needs-input", null, `left blank and escalated — ${why}`);
    console.warn(`${LOG} needs the candidate: ${field.label} — ${why}`);
  };

  /**
   * Issue #100. Replaces the `needs-input` line a field already has rather than
   * adding a second one for the same key.
   *
   * `printReport` and `fill-application-form-flow`'s assertions both reach for a
   * field's outcome with `.find`, which returns the first match, so appending a
   * later line would leave every reader looking at the earlier one. A field that
   * was escalated and then filled has one true final state, and this is how the
   * report comes to hold it.
   */
  const supersede = (
    field: EnumeratedField,
    outcome: FieldOutcome["outcome"],
    intended: string | null,
    detail: string,
    readBack: string | null
  ): void => {
    const line: FieldOutcome = {
      field: field.key,
      intended,
      outcome,
      detail: `${field.required ? "required — " : ""}${detail}`,
      readBack,
    };
    const at = outcomes.findIndex(
      (entry) => entry.field === field.key && entry.outcome === "needs-input"
    );
    if (at === -1) outcomes.push(line);
    else outcomes[at] = line;
  };

  // ── Step 3: the user's own answers, applied without a model ──────────────
  // `resolveAdditionalAnswer` above carries the full reasoning for what gets
  // refused here and why: a demographic field with a decline option, and a
  // consent/agreement/certification field, are never decided by a
  // caller-supplied answer, however well it fuzzy-matched — both fall through
  // to `undecided` and are left to `resolveDecision`'s own policy instead.
  const undecided: EnumeratedField[] = [];
  for (const field of empty) {
    // ── Confirm-email shortcut ───────────────────────────────────────────────
    // "Confirm email", "Re-enter email", "Repeat email" etc. are always the
    // same value as the primary email address. Handled here, before the
    // additional-answer lookup and the model, so nothing model-derived ever
    // touches this field. The regex is anchored to the label text, which is
    // page-derived, but the VALUE it types is always the `email` fact — a
    // compile-time-keyed catalogue entry — not anything lifted off the page.
    if (CONFIRM_EMAIL_RE.test(field.label)) {
      const emailFact = factsByKey.get("email");
      if (emailFact !== undefined) {
        await sleep(randomInteractionDelayMs());
        const outcome = await applyFieldValue(session.page, field, emailFact.value, {});
        if (outcome.ok) {
          record(field, "filled", emailFact.value, `confirm-email — filled with the email fact; ${outcome.detail}`, outcome.readBack);
          console.log(`${LOG} ${field.label}: filled as confirm-email`);
        } else if (outcome.readBack !== "") {
          record(field, "mismatch", emailFact.value, outcome.detail, outcome.readBack);
        } else {
          ask(field, `The confirm-email field "${field.label}" could not be filled. ${outcome.detail}. What email address should we use?`, `confirm-email fill failed — ${outcome.detail}`);
        }
        continue;
      }
    }

    const decision = resolveAdditionalAnswer(field, additionalAnswers);
    if (decision.kind !== "apply") {
      undecided.push(field);
      if (decision.kind === "refused") {
        console.warn(
          `${LOG} ignoring a supplied answer for the ${decision.category} "${field.label}" — ` +
            decision.why
        );
      }
      continue;
    }
    const supplied = decision.value;
    // `allowContains` for a dropdown here, unlike on the decided path: a person
    // answering "Yes" in chat should land on an option worded "Yes, I am
    // authorized to work in the US". Still only when exactly one option contains
    // what they said — see `chooseFromMenu` — so an ambiguous answer comes back
    // to them rather than being resolved for them.
    await sleep(randomInteractionDelayMs());
    const outcome = await applyFieldValue(session.page, field, supplied, {
      allowContains: OPTION_KINDS.has(field.kind),
    });
    if (outcome.ok) {
      record(field, "filled", supplied, `answered by the candidate — ${outcome.detail}`, outcome.readBack);
      console.log(`${LOG} ${field.label}: filled from the candidate's own answer`);
    } else if (outcome.readBack !== "") {
      record(field, "mismatch", supplied, outcome.detail, outcome.readBack);
    } else {
      ask(
        field,
        `Your answer "${supplied}" could not be used for "${field.label}". ${outcome.detail}. ` +
          `What should we put instead?`,
        `the answer supplied did not fit the control — ${outcome.detail}`
      );
    }
  }

  if (undecided.length === 0) {
    return {
      outcomes,
      needsInput: [...needsInput, ...repeatingNeedsInput],
      answerProvenance: [...repeating.answerProvenance],
    };
  }

  // ── Step 4: open the dropdowns that stand between this and a submittable
  // form. Optional ones are left shut: opening every menu on a page costs a
  // click and a repaint each, and an optional dropdown nobody can answer is
  // left blank either way.
  for (const field of undecided) {
    if (!field.required) continue;
    if (!OPTION_KINDS.has(field.kind) || field.optionsKnown) continue;
    const harvested = await harvestOptions(session.page, field);
    field.options = harvested.options;
    field.optionsKnown = harvested.options.length > 0;
    field.optionsTruncated = harvested.truncated;
    console.log(
      `${LOG} "${field.label}" offers ${harvested.options.length}` +
        `${harvested.truncated ? "+" : ""} option(s)`
    );
  }

  // ── Step 5: one decision call, no tools attached ─────────────────────────
  const decidable: DecidableField[] = undecided.map((field) => ({
    key: field.key,
    label: field.label,
    kind: field.kind,
    required: field.required,
    options: field.options,
    optionsKnown: field.optionsKnown,
    optionsTruncated: field.optionsTruncated,
    helpText: field.helpText,
  }));

  const decisions = await decideFieldAnswers({
    fields: decidable,
    facts,
    company: state.company,
    jobTitle: state.jobTitle,
    jobDescription,
  });
  const byKey = new Map(decisions.map((decision) => [decision.fieldKey, decision]));

  // ── Step 6: policy, then action, then read-back ──────────────────────────
  let generated = 0;
  for (const field of undecided) {
    const decision = byKey.get(field.key);
    const resolution = resolveDecision(field, decision, factsByKey);

    if (resolution.kind === "skip") {
      record(field, "skipped", null, `left blank — ${resolution.why}`);
      continue;
    }
    if (resolution.kind === "ask") {
      ask(field, resolution.question, resolution.why);
      continue;
    }

    let value: string;
    let note: string;
    let declined = false;

    if (resolution.kind === "generate") {
      if (generated >= MAX_GENERATED_ANSWERS) {
        ask(
          field,
          `The form asks: "${field.label}". What would you like to say?`,
          `this form asks more than ${MAX_GENERATED_ANSWERS} free-text questions, which is ` +
            `more than this writes unattended`
        );
        continue;
      }
      generated++;
      try {
        // A model call while a browser is open — unlike the resume parse and the
        // cover letter, which both run before one exists. The containment that
        // matters is unchanged and is not about timing: this call is made by
        // `resume-parser.ts`, which has no browser handle, carries no tools, and
        // is asserted to carry none immediately before the request is sent. What
        // comes back is a string, and a string is checked and typed as an
        // argument; it never becomes an instruction.
        value = await generateEssayAnswer({
          profile,
          company: state.company,
          jobTitle: state.jobTitle,
          jobDescription,
          question: field.label,
          ...(field.maxLength === null ? {} : { maxChars: field.maxLength }),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ask(
          field,
          `The form asks: "${field.label}". What would you like to say?`,
          `an answer could not be written for it (${reason})`
        );
        continue;
      }
      note = `written from the candidate's validated profile — ${resolution.note}`;
    } else {
      value = resolution.value;
      note = resolution.note;
      declined = resolution.declined;
    }

    await sleep(randomInteractionDelayMs());
    const outcome = await applyFieldValue(session.page, field, value, {
      // No fixed option list means this is a search control that answers a
      // query rather than a menu with a fixed set — see `chooseFromMenu`.
      allowContains: OPTION_KINDS.has(field.kind) && field.options.length === 0,
      // JOB-051's tie break for a search control whose options only exist once
      // it has been typed into. Without it "San Francisco" comes back as eight
      // San Franciscos, `chooseFromMenu` correctly refuses to guess between
      // them, and the required City field stays empty.
      ...(OPTION_KINDS.has(field.kind)
        ? { contextTerms: countryContextTerms(state.applicationAnswers.currentCountry) }
        : {}),
      // JOB-044. Scoped to school-shaped comboboxes by label AND by the fact
      // key that backed `value`, same double gate as the resolution that
      // produced `value` above — see `SCHOOL_FIELD_LABEL_RE`, `SCHOOL_FACT_KEY_RE`,
      // and `chooseFromMenu`'s own comment on what this permits. The label
      // alone would also let free text through on an employer's own "School"
      // or "College" org-structure field, which is not what `value` answers.
      allowFreeText:
        field.kind === "combobox" &&
        SCHOOL_FIELD_LABEL_RE.test(field.label) &&
        SCHOOL_FACT_KEY_RE.test(decision?.sourceFact ?? ""),
      // JOB-051. The country the candidate told us they live in, so a location
      // search that comes back with the same city name on four continents can
      // be resolved from what they attested rather than by taking the first
      // suggestion. `chooseFromMenu` uses it only to break a tie between
      // options that already contain `value`, so it can never introduce an
      // answer of its own.
      contextTerms: countryContextTerms(state.applicationAnswers.currentCountry),
    });

    if (outcome.ok) {
      record(field, declined ? "declined" : "filled", value, `${note}; ${outcome.detail}`, outcome.readBack);
      console.log(`${LOG} ${field.label}: ${declined ? "declined to answer" : "filled"} + verified`);
      continue;
    }
    if (outcome.readBack !== "") {
      record(field, "mismatch", value, outcome.detail, outcome.readBack);
      continue;
    }
    ask(
      field,
      `"${field.label}" could not be set to ${JSON.stringify(value.slice(0, 80))}. ` +
        `${outcome.detail}. What should we put?`,
      `the value could not be applied — ${outcome.detail}`
    );
  }

  // ── JOB-137: Reveal-scan loop ────────────────────────────────────────────
  // Picking an "Other" dropdown option, ticking a required checkbox, or a
  // Boolean "Yes" can mount a follow-up required field that did not exist
  // when this pass first enumerated the form at the top. Belvedere's grad
  // date is the case we hit for real: the dropdown offers "Other" for
  // out-of-list dates, the initial fill picked "Other", a required "please
  // specify" text input mounted, and nothing filled it because the
  // enumeration had already frozen. Submit then went out on a form with a
  // silently-empty required field, which the board then rejected without a
  // confirmation, and the row went to `submission_unconfirmed`.
  //
  // Rescan here; any newly-required empty control not seen at the first pass
  // gets pushed through `ask()` into `needsInput`, which is exactly what the
  // LLM fallback immediately below already consumes. `all` (from the very
  // first enumeration at the top of this function) provides the
  // already-handled set — anything with a selector in there was seen once
  // and either got filled or is already sitting in `needsInput`, so a
  // re-add would double-count it. Bounded by MAX_REVEAL_PASSES so a
  // reveal-that-reveals-more pattern cannot loop forever, and each pass
  // logs so a future run can tell if the ceiling was ever the reason a
  // form went out unsubmitted.
  {
    const handledSelectors = new Set<string>(all.map((field) => field.selector));
    const MAX_REVEAL_PASSES = 4;
    for (let pass = 1; pass <= MAX_REVEAL_PASSES; pass++) {
      const rescanned = await enumerateFormFields(session.page);
      const revealed = rescanned.filter(
        (field) =>
          field.required &&
          field.currentValue === "" &&
          field.kind !== "file" &&
          field.kind !== "other" &&
          field.label !== "" &&
          !handledSelectors.has(field.selector)
      );
      if (revealed.length === 0) break;
      console.log(
        `${LOG} reveal-scan pass ${pass}: ${revealed.length} newly-mounted required control(s): ` +
          revealed.map((field) => field.label).join(", ")
      );
      for (const field of revealed) {
        handledSelectors.add(field.selector);
        ask(
          field,
          `The form asks: "${field.label}". What would you like to say?`,
          `mounted after an earlier control was set, so the initial enumeration ` +
            `did not see it — the LLM fallback below will try to fill it from the profile`
        );
      }
      if (pass === MAX_REVEAL_PASSES) {
        console.warn(
          `${LOG} reveal-scan hit MAX_REVEAL_PASSES=${MAX_REVEAL_PASSES}; some later ` +
            `reveals may remain unfilled — check for chained reveals on this board`
        );
      }
    }
  }

  // ── Issue #91 Part 2: LLM fallback for unknown required fields ───────────
  // If any required field that is not a legal attestation or EEO question is
  // still in needsInput at this point, the rule-based system had nothing for
  // it. A single stagehand.act() can often fill it directly — Workable
  // compliance dropdowns that landed here without a matching fact, for example.
  //
  // Security note: the field label is page-derived text included in an act()
  // instruction. This is an intentional exception to the compile-time-constant
  // rule, requested by the coordinator (issue #91). The label is truncated to
  // 200 characters to bound potential injection surface.
  //
  // ── Issue #100 rewrote what this is allowed to do, and what it must say ────
  //
  // It used to drop an item from `needsInput` whenever `act()` did not throw,
  // and leave the field's `outcomes` line reading "needs-input" — so a value it
  // put on a real employer's form under a real person's name appeared in no
  // report at all, and the candidate was never told. On a live Avery Dennison
  // run that silence covered a ticked privacy declaration and a "No" typed into
  // a non-compete question. Two things changed:
  //
  //  1. What it will attempt is decided by `fallbackRefusalReason`, whose first
  //     rule refuses checkboxes and radio groups on the shape of the control
  //     without reading the label, so no unanticipated wording can get past it.
  //     A refused item stays in `needsInput` and goes to the candidate, which is
  //     the outcome the old code produced only when a regex happened to fire.
  //
  //  2. Nothing leaves `needsInput` silently. An attempt is only accepted when
  //     the control reads back as holding something, and the field's report line
  //     is then rewritten to say what it holds — the same `filled` line with the
  //     same `readBack` column that every ordinary fill produces, so a human
  //     scanning the report sees it exactly as they see the rest of the form.
  //     `act()` returning without throwing is not evidence that anything was
  //     filled, let alone filled correctly, so it is no longer treated as any.
  //
  //  3. `act()` drives the whole page, not one control, so refusing to point it
  //     at a checkbox is not the same as it never ticking one. Every checkbox
  //     and radio on the form is read before and after each attempt, and a box
  //     that became ticked while this ran is recorded as a `mismatch` —
  //     `assertNoMismatches` then stops the run with the form unsubmitted, which
  //     is what should happen to a form now carrying an assertion nobody made.
  const attempts = needsInput.filter((item) => fallbackRefusalReason(item) === null);
  const afterLlmFallback: NeedsInputItem[] = [];

  // JOB-137: profile summary handed to the LLM fallback below.
  //
  // Pre-JOB-137 the fallback's prompt read "with the most appropriate value
  // for a job applicant" and nothing more. That is a licence for the model
  // to invent — pick a graduation date, guess a salary, write a "why do you
  // want to work here" from thin context — and HARD STOP 9 is why the
  // fallback existed at all in that shape. The refusal list on
  // `fallbackRefusalReason` was the safety, not the prompt.
  //
  // A live Belvedere run then showed the same failure mode from the other
  // side: a required text input that mounted after an "Other" grad-date
  // pick, sitting inside `needsInput` for a shape that had no rule and no
  // stored fact, and the prompt above had nothing to say about how the
  // candidate would actually answer. That is the fill quality gap the
  // coordinator asked for: let the model reason from what the candidate
  // actually is, not from generic priors.
  //
  // What this summary is: a compact, factual, provably-here-in-the-data
  // string. Name, contact, location, degree, top three work rows by title
  // and company. Nothing that could not be produced by concatenating
  // scalars off `profile`. It is limited to short factual atoms on
  // purpose — every string below is either a stored field or a slice of
  // one, and the prompt below tells the model it may synthesise short
  // prose FROM these facts but must not invent atoms outside them.
  const eduTop = profile.education[0];
  const eduLine =
    eduTop === undefined
      ? null
      : [
          eduTop.degree ?? "",
          eduTop.discipline ?? "",
          eduTop.school ? `at ${eduTop.school}` : "",
          eduTop.endDate ? `(${eduTop.endDate})` : "",
        ]
          .filter((s) => s.trim().length > 0)
          .join(" ");
  const workLines = profile.workHistory
    .slice(0, 3)
    .map((w) => {
      const parts = [
        w.title ?? "",
        w.company ? `at ${w.company}` : "",
        w.startDate ? `(${w.startDate}${w.endDate ? "–" + w.endDate : "–present"})` : "",
      ].filter((s) => s.trim().length > 0);
      return parts.join(" ");
    })
    .filter((s) => s.length > 0);
  const skillsLine =
    profile.skills.length > 0 ? profile.skills.slice(0, 15).join(", ") : null;
  const profileSummary = [
    `Name: ${(profile.firstName ?? "").trim()} ${(profile.lastName ?? "").trim()}`.trim(),
    `Email: ${profile.email}`,
    profile.phone ? `Phone: ${profile.phone}` : null,
    profile.location ? `Location: ${profile.location}` : null,
    profile.linkedinUrl ? `LinkedIn: ${profile.linkedinUrl}` : null,
    profile.githubUrl ? `GitHub: ${profile.githubUrl}` : null,
    profile.websiteUrl ? `Website: ${profile.websiteUrl}` : null,
    eduLine ? `Education: ${eduLine}` : null,
    workLines.length > 0 ? `Recent work:\n  - ${workLines.join("\n  - ")}` : null,
    skillsLine ? `Skills: ${skillsLine}` : null,
    state.company ? `Applying to: ${state.jobTitle ?? "role"} at ${state.company}` : null,
  ]
    .filter((s): s is string => s !== null && s.length > 0)
    .join("\n");

  // Read once, before any attempt, rather than trusting the `currentValue` from
  // enumeration: the ordinary pass above ticks required agreement boxes by
  // deliberate policy (see `applyConsentPolicy`), and those are legitimately
  // ticked and must not be reported here.
  const assertionControls =
    attempts.length === 0 ? [] : all.filter((field) => ASSERTING_KINDS.has(field.kind));
  const tickedBefore = new Set<string>();
  for (const control of assertionControls) {
    if ((await readFieldValue(session.page, control)) !== "") tickedBefore.add(control.selector);
  }

  /**
   * Records any box that became ticked while the fallback was running.
   *
   * Two honest limits, neither of which weakens the refusal above and both of
   * which are worth writing down rather than discovering later. It watches the
   * controls enumeration found, so a checkbox the page renders for the first
   * time during an `act()` is not in the list. And a radio group whose selector
   * addresses the group rather than an input reads empty either way, so this
   * catches ticks on checkboxes far more reliably than on radios. The check is
   * a second net under a refusal that already holds, not the refusal itself.
   */
  const reportStrayTicks = async (safeLabel: string): Promise<void> => {
    for (const control of assertionControls) {
      if (tickedBefore.has(control.selector)) continue;
      if ((await readFieldValue(session.page, control)) === "") continue;
      // Added to the set so one stray tick is reported once rather than again on
      // every later attempt.
      tickedBefore.add(control.selector);
      record(
        control,
        "mismatch",
        null,
        `this control was ticked while the unknown field fallback was filling ` +
          `"${safeLabel}", and nothing chose to tick it. A ticked box is an assertion ` +
          `made in the candidate's name, so the form is not safe to submit.`,
        "checked"
      );
      console.error(
        `${LOG} LLM fallback (unknown-field): STRAY TICK on "${control.label}" while ` +
          `filling "${safeLabel}"`
      );
    }
  };

  for (const item of needsInput) {
    const refusal = fallbackRefusalReason(item);
    if (refusal !== null) {
      if (item.required) {
        console.log(
          `${LOG} LLM fallback (unknown-field): refusing "${item.fieldLabel.slice(0, 80)}" — ${refusal}`
        );
      }
      afterLlmFallback.push(item);
      continue;
    }
    const field = escalatedFrom.get(item);
    if (field === undefined) {
      // Cannot read back what cannot be addressed, and an unverifiable fill is
      // not one this reports as done. Unreachable today — every item in this
      // list came from `ask` — and it stays a question rather than an assumption.
      afterLlmFallback.push(item);
      continue;
    }
    const safeLabel = item.fieldLabel.slice(0, 200);
    console.log(`${LOG} LLM fallback (unknown-field): filling "${safeLabel}" via act()`);
    try {
      // JOB-137. Prompt grounds the model in the candidate's real profile
      // rather than "the most appropriate value for a job applicant", which
      // let the model pick any plausible-sounding string with no line to the
      // person on whose behalf the form is being filled. See `profileSummary`
      // above for what is included and why. The safety story is unchanged:
      // `fallbackRefusalReason` still refuses attestations, EEO, radios and
      // checkboxes on shape before the label is read; this prompt only
      // reaches shapes where a text or prose answer is what the form asked
      // for, and the rules below tell the model to leave the field blank
      // rather than invent an atom that is not on the profile.
      await session.stagehand.act(
        `Fill the field labelled '${safeLabel}' using ONLY the candidate profile below.\n\n` +
          `${profileSummary}\n\n` +
          `Rules:\n` +
          `- You MAY synthesize short prose grounded in these facts (for example, "why do ` +
          `you want to work at ${state.company ?? "this company"}" or "describe a project" ` +
          `written from the work history, education, and skills shown above).\n` +
          `- You MUST NOT invent employer names, degrees, dates, salary numbers, ` +
          `addresses, or credentials that are not in the profile above.\n` +
          `- If the profile does not have the specific factual value being asked for ` +
          `(a US visa type the candidate does not hold, a specific graduation date not ` +
          `listed, a salary expectation the candidate has not stated), leave the field ` +
          `blank rather than guessing.`,
        { page: session.page }
      );
    } catch (err) {
      console.warn(
        `${LOG} LLM fallback (unknown-field): act() threw for "${safeLabel}" — ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      await reportStrayTicks(safeLabel);
      afterLlmFallback.push(item);
      continue;
    }

    await reportStrayTicks(safeLabel);

    const readBack = await readFieldValue(session.page, field);
    if (readBack === "") {
      console.warn(
        `${LOG} LLM fallback (unknown-field): act() returned but "${safeLabel}" still reads ` +
          `empty — still the candidate's question`
      );
      supersede(
        field,
        "needs-input",
        null,
        `left blank and escalated — ${item.why}; the unknown field fallback tried and the ` +
          `control still reads empty`,
        ""
      );
      afterLlmFallback.push(item);
      continue;
    }
    // `intended` stays null on purpose: this module chose no value here, so
    // saying it meant to put one would be a second small untruth in a report
    // whose whole job is that the candidate can see what is on their form.
    // `readBack` is what the control actually holds, which is the question
    // anybody reading this line is asking.
    supersede(
      field,
      "filled",
      null,
      `no rule and no stored fact answered this, so it was filled by the unknown field ` +
        `fallback and read back. This value was chosen by a model, not by the candidate, ` +
        `and it is on the form.`,
      readBack
    );
    console.log(`${LOG} ${field.label}: filled by fallback + verified — reads ${JSON.stringify(readBack)}`);
  }

  // ── JOB-170: the LLM fabrication rung ────────────────────────────────────
  // Everything still in `afterLlmFallback` at this point survived the rule
  // based ladder, the stored answers, and the unknown-field fallback above.
  // Before this ticket each such REQUIRED field became an escalation and the
  // row stopped at `pending_user_input`. Per the Option A product decision of
  // 2026-08-26 it is now answered by asking the text model, grounded in the
  // candidate's own intake data and resume digest.
  //
  // Deliberately rungs 4 and 5 only. `resolveAnswer`'s first three rungs are
  // NOT consulted here, for a reason the verification run against Western
  // Digital on launch night supplied: their intent classifier reads "your
  // right to work for WD" in a non-compete question as the work-authorization
  // intent, and a column backed answer for the wrong intent is a confident,
  // wrong legal attestation. Everything rungs 1 through 3 could contribute
  // already reached this loop by a wording-aware route: intake columns and
  // stored answers sit in the fact catalogue and in `additionalAnswers`,
  // consent fields get their own deterministic policy, and declines are
  // chosen from the control's own options. What is left here is exactly the
  // residue that needs a model, and the model sees the intake values as
  // data to mirror rather than as a column keyed by a possibly wrong intent.
  //
  // Two boundaries hold even under Option A:
  //
  //  · EEO questions are never sent to the model. `resolveAnswer` refuses
  //    them internally as well; the check here keeps a demographic label
  //    from ever building a prompt. A required EEO question with no decline
  //    option therefore stays in `needsInput` and escalates, which is the
  //    residual case the companion ticket tracks.
  //  · Repeating section entries never reach this loop: they are merged back
  //    below from `repeatingNeedsInput`, which `fillRepeatingSections`
  //    populated before any fabrication existed. Inventing an employer or a
  //    school would be worse than asking.
  //
  // The value goes onto the control through `applyFieldValue`, the same
  // guarded apply with read-back verification every ordinary fill uses, so a
  // fabricated dropdown answer can only ever land on an option the DOM
  // offered. A failed apply leaves the item escalated exactly as before.
  const answerProvenance: AnswerProvenanceEntry[] = [];
  const afterFabrication: NeedsInputItem[] = [];
  const intakeRecord: Record<string, string> = {};
  {
    const answers = state.applicationAnswers;
    if (answers.workAuthorizedUs !== undefined) intakeRecord.work_authorized_us = answers.workAuthorizedUs ? "Yes" : "No";
    if (answers.requiresSponsorship !== undefined) intakeRecord.requires_sponsorship = answers.requiresSponsorship ? "Yes" : "No";
    if (answers.willingToRelocate !== undefined) intakeRecord.willing_to_relocate = answers.willingToRelocate ? "Yes" : "No";
    if (answers.currentCountry) intakeRecord.current_country = answers.currentCountry;
    if (answers.currentCity) intakeRecord.current_city = answers.currentCity;
    if (answers.citizenshipStatus) intakeRecord.citizenship_status = answers.citizenshipStatus;
    if (answers.f1Status) intakeRecord.f1_status = answers.f1Status;
    if (answers.gradDate) intakeRecord.grad_date = answers.gradDate;
    if (answers.earliestStart) intakeRecord.earliest_start = answers.earliestStart;
    if (state.company) intakeRecord.applying_to = `${state.jobTitle ?? "role"} at ${state.company}`;
    // The candidate's own words about questions intake never asked, already
    // folded into `additionalAnswers` by the caller. These are facts the
    // person stated, which is what makes them admissible grounding here.
    for (const [question, answer] of Object.entries(additionalAnswers)) {
      if (question.trim() === "" || answer.trim() === "") continue;
      intakeRecord[`stored_answer: ${question.slice(0, 120)}`] = answer.slice(0, 200);
    }
  }

  for (const item of afterLlmFallback) {
    if (!item.required || EEO_FIELD_RE.test(item.fieldLabel)) {
      afterFabrication.push(item);
      continue;
    }
    const field = escalatedFrom.get(item);
    if (field === undefined) {
      afterFabrication.push(item);
      continue;
    }
    const resolved = await resolveAnswer(item.fieldLabel, {}, [], {
      options: item.options ?? [],
      context: { intake: intakeRecord, resume: profileSummary },
    });
    if (resolved === null || resolved.answer.trim() === "") {
      console.warn(
        `${LOG} fabrication rung declined "${item.fieldLabel.slice(0, 80)}" — staying escalated`
      );
      afterFabrication.push(item);
      continue;
    }
    await sleep(randomInteractionDelayMs());
    const outcome = await applyFieldValue(session.page, field, resolved.answer, {
      allowContains: OPTION_KINDS.has(field.kind),
    });
    if (!outcome.ok) {
      console.warn(
        `${LOG} fabrication rung could not apply "${resolved.answer}" to ` +
          `"${item.fieldLabel.slice(0, 80)}" (${outcome.detail}) — staying escalated`
      );
      afterFabrication.push(item);
      continue;
    }
    supersede(
      field,
      "filled",
      resolved.answer,
      resolved.source === "llm_fabrication"
        ? `answered by the LLM fabrication rung from the candidate's own intake data and resume ` +
          `(confidence ${resolved.confidence?.toFixed(2) ?? "n/a"}): ${outcome.detail}`
        : `answered by the sane default fallback after the fabrication call did not produce one: ` +
          `${outcome.detail}`,
      outcome.readBack
    );
    console.log(
      `${LOG} ${field.label}: filled by the ${resolved.source} rung + verified — reads ` +
        `${JSON.stringify(outcome.readBack)}`
    );
    answerProvenance.push(
      answerProvenanceEntry({
        fieldKey: item.key,
        fieldLabel: item.fieldLabel,
        questionText: item.fieldLabel,
        resolution: resolved,
      })
    );
  }

  return {
    outcomes,
    needsInput: [...afterFabrication, ...repeatingNeedsInput],
    answerProvenance: [...repeating.answerProvenance, ...answerProvenance],
  };
}

/**
 * A field that reads back as something other than what was typed means a real
 * employer's form now holds a value nobody chose. Lifted out of the flow by
 * ACT-015 so the named-field pass and the general pass are held to the identical
 * rule rather than to two copies of it.
 */
function assertNoMismatches(fields: readonly FieldOutcome[], url: string): void {
  const mismatched = fields.filter((field) => field.outcome === "mismatch");
  if (mismatched.length === 0) return;
  throw new FormFillBlockedError(
    `The form at "${url}" was filled, but ${mismatched.length} field(s) read back as ` +
      `something other than what was typed: ` +
      mismatched
        .map((field) => `${field.field} reads ${JSON.stringify(field.readBack ?? "")}`)
        .join("; ") +
      `. Nothing was submitted. A human should look at the form before it goes anywhere.`
  );
}

/**
 * The stop that ends a run which could not answer a required question.
 *
 * Deliberately shaped as a stop-for-a-human rather than a failure: the form is
 * genuinely half-filled, the row genuinely cannot be submitted, and the fix is
 * three sentences from the candidate rather than a retry. `needsInput` carries
 * the questions; this carries the sentence a person reads.
 */
export function blockedForAnswers(needsInput: readonly NeedsInputItem[], url: string): FormFillBlockedError {
  const required = needsInput.filter((item) => item.required);
  // JOB-022. Which of the two tags this message carries decides which
  // `skip_log.reason` it lands under, so the classification is made here, from
  // the labels, rather than guessed at from wording in `skipReasonFor`.
  //
  // A form is filed as `needs_attestation` when any of the fields that stopped
  // it is one of the two categories that are never guessed at, because that is
  // the one a person can close by answering a single question and it should not
  // be buried under whatever else happened to be blank on the same form.
  //
  // The two categories are counted separately even though they share a reason
  // code, because the sentence has to match the field that actually stopped the
  // run. `isAttestationField` is true for a demographic question as well as a
  // legal one, so describing every stop as a work authorization or criminal
  // history question would tell somebody blocked by a required "Gender" select
  // something plainly untrue about their own application. Caught in review on
  // this PR.
  const legal = required.filter((item) => LEGAL_ATTESTATION_RE.test(item.fieldLabel));
  const demographic = required.filter(
    (item) => !LEGAL_ATTESTATION_RE.test(item.fieldLabel) && EEO_FIELD_RE.test(item.fieldLabel)
  );
  const tag = legal.length + demographic.length > 0 ? "needs_attestation" : "needs_candidate_input";
  const clauses: string[] = [];
  if (legal.length > 0) {
    clauses.push(
      `${legal.length} required legal attestation(s) that the candidate's stored answers do ` +
        `not cover and that offer no way to decline. Work authorization, citizenship, visa ` +
        `status, security clearance, export control status and criminal history are never ` +
        `guessed at, because a wrong answer to one of them can cost this person an offer long ` +
        `after the form was filled`
    );
  }
  if (demographic.length > 0) {
    clauses.push(
      `${demographic.length} required self-identification question(s) offering no way to ` +
        `decline. A demographic identity is never invented for a real person`
    );
  }
  const preamble =
    clauses.length > 0
      ? `has ${clauses.join(", and ")}.`
      : `has ${required.length} required field(s) that could not be filled, even on a best ` +
        `effort basis, from what is known about this candidate.`;
  return new FormFillBlockedError(
    `${tag}: the form at "${url}" ${preamble} Everything else on the form is filled and ` +
      `nothing was submitted.\n\n` +
      required
        .map((item, index) => {
          // Trimmed hard: a country picker offers 250 choices and a person
          // reading this needs to know it is a picker, not to read the list.
          const shown = item.options?.slice(0, 8) ?? [];
          const more = (item.options?.length ?? 0) - shown.length;
          return (
            `  ${index + 1}. ${item.fieldLabel} — ${item.question}` +
            (shown.length === 0
              ? ""
              : `\n     options: ${shown.join(" | ")}${more > 0 ? ` | …and ${more} more` : ""}`) +
            `\n     key: ${item.key}`
          );
        })
        .join("\n") +
      `\n\nAsk the candidate these questions, then run this again with \`additionalAnswers\` ` +
      `keyed by the \`key\` shown above. Nothing is stored in between — the same call with the ` +
      `answers added finishes the form.`
  );
}

// ───────────────────────────────────
// The resume file
// ───────────────────────────────────

/**
 * JOB-053. One `input[type=file]`, addressable again after the fact.
 *
 * `region` is the enclosing labelled upload block — Greenhouse's
 * `<div role="group" aria-labelledby="upload-label-resume">` — and it exists
 * because the input itself does not survive being used. See
 * `confirmAttachment`.
 */
type FileUploadControl = { selector: string; region: string | null };

/**
 * Every `input[type=file]` in the top-level document that can be addressed
 * again by a plain CSS selector, paired with that selector and its region.
 *
 * Serialised into the page by `listFileUploadControls`, so the same rule
 * `describeControlInPage` lives under applies: self-contained, no imports, no
 * closure over anything in this module.
 *
 * Two decisions worth keeping:
 *
 *  · **An attribute selector rather than `#id`.** A Greenhouse `id` is
 *    `resume`, but a board that generates ids can hand back
 *    `question_35956410002` or something with a colon or a dot in it, and those
 *    are CSS combinators inside an `#id`. `[id="…"]` takes a quoted string, so
 *    there is nothing to escape beyond the quote and the backslash.
 *
 *  · **Uniqueness is verified rather than assumed.** Duplicate ids are invalid
 *    HTML and boards ship them anyway. A selector that resolves to anything
 *    other than this one element is discarded, so a selector that survives
 *    here addresses exactly the element it was built from.
 *
 * An input with neither an id nor a name contributes nothing and is simply
 * absent from the list. That is not a failure: the caller falls through to the
 * paths that were already there.
 */
function fileUploadControlsInPage(): FileUploadControl[] {
  const quote = (value: string): string => `"${value.replace(/["\\]/g, "\\$&")}"`;
  const uniquely = (element: Element, attempts: string[]): string | null => {
    for (const attempt of attempts) {
      let matches: Element[];
      try {
        matches = Array.from(document.querySelectorAll(attempt));
      } catch {
        continue;
      }
      if (matches.length === 1 && matches[0] === element) return attempt;
    }
    return null;
  };

  const controls: FileUploadControl[] = [];
  for (const element of Array.from(document.querySelectorAll("input[type=file]"))) {
    const id = element.getAttribute("id");
    const name = element.getAttribute("name");
    const selector = uniquely(element, [
      ...(id ? [`input[type=file][id=${quote(id)}]`] : []),
      ...(name ? [`input[type=file][name=${quote(name)}]`] : []),
    ]);
    if (selector === null) continue;

    // The nearest ancestor that carries an identifier of its own, and that is
    // still recognisably *this upload's* block rather than the page around it.
    //
    // Both bounds matter, because the only thing the caller does with this is
    // ask whether the file name now appears inside it. A region that reached
    // the whole form would answer yes for a file attached to any field on it,
    // which is the same class of mistake as the one this ticket is about:
    //
    //  · never a landmark or the form itself, whatever ids they carry;
    //  · never a block holding another file input, so "the resume is in here"
    //    cannot be satisfied by some other upload's chip;
    //  · at most a few hops, so an unlabelled widget gives up rather than
    //    climbing until something happens to have an id.
    let region: string | null = null;
    let ancestor = element.parentElement;
    for (let hops = 0; hops < 6 && ancestor !== null && region === null; hops += 1) {
      const tag = ancestor.tagName.toLowerCase();
      const tooWide = tag === "form" || tag === "body" || tag === "html" || tag === "main";
      const uploads = ancestor.querySelectorAll("input[type=file]");
      if (!tooWide && uploads.length === 1 && uploads[0] === element) {
        const labelledBy = ancestor.getAttribute("aria-labelledby");
        const ancestorId = ancestor.getAttribute("id");
        region = uniquely(ancestor, [
          ...(labelledBy ? [`[aria-labelledby=${quote(labelledBy)}]`] : []),
          ...(ancestorId ? [`[id=${quote(ancestorId)}]`] : []),
        ]);
      }
      ancestor = ancestor.parentElement;
    }
    controls.push({ selector, region });
  }
  return controls;
}

/**
 * Never throws and never fails a run: a page this cannot read reports no file
 * inputs, and every caller treats that as "use the paths that were already
 * here" rather than as an error. Same rule as `describeControl`, for the same
 * reason — a perception failure must not be able to stop an application that
 * the model-driven path would have filled correctly.
 */
async function listFileUploadControls(page: Page): Promise<FileUploadControl[]> {
  try {
    const result = await page.evaluate(inPageExpression(fileUploadControlsInPage, ""));
    const failure = inPageError(result);
    if (failure !== null) {
      console.warn(`${LOG} could not enumerate the page's file inputs: ${failure}`);
      return [];
    }
    if (!Array.isArray(result)) return [];
    return result.flatMap((entry): FileUploadControl[] => {
      const raw = entry as Partial<FileUploadControl> | null;
      if (!raw || typeof raw.selector !== "string" || raw.selector === "") return [];
      return [{ selector: raw.selector, region: typeof raw.region === "string" ? raw.region : null }];
    });
  } catch {
    return [];
  }
}

/**
 * JOB-053. The file upload control that the **DOM itself** says is the resume,
 * or null when the DOM does not say so unambiguously.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 * Greenhouse renders its resume and its cover letter uploads as two visually
 * identical "Attach" buttons. `observe()` is asked for "the file upload control
 * for the applicant's resume or CV" and answers with a ranked list, of which
 * `resolveAction` takes the first — and on a real Virtu Financial posting the
 * first was the **cover letter** input. The identification guard in
 * `attachResume` caught it and refused, correctly, because the control
 * described itself as `"cover_letter | Attach | Attach"`. But refusing is the
 * consolation prize: 87% of the Greenhouse listings in the `jobs` table carry
 * two or more file inputs, so a first-match resolver is a coin flip on the
 * overwhelming majority of the board.
 *
 * The two controls are not actually alike. Greenhouse gives them
 * `id="resume"` and `id="cover_letter"`, wraps each in
 * `<div role="group" aria-labelledby="upload-label-resume">` with a visible
 * "Resume/CV" or "Cover Letter" caption, and hangs a
 * `<label for="resume">Attach</label>` off each — so `describeControl` already
 * reads back `"resume | Attach | Attach"` for one and
 * `"cover_letter | Attach | Attach"` for the other. Every one of the 131
 * multi-upload Greenhouse forms sampled for this ticket had a file input whose
 * id named the resume. The information was there the whole time; nothing was
 * looking at it.
 *
 * ── Why this raises the bar rather than lowering it ─────────────────────────
 * This is the same evidence `attachResume`'s guard tests, read from the same
 * `describeControl`, and applied *more* strictly: a candidate has to match
 * `FIELD_KEYWORDS.resume` **and** match no other field's pattern, which is the
 * conflict rule `corroborate()` enforces for text fields and which the upload
 * guard did not have. A control that says "resume" and "cover letter" at once
 * is rejected here rather than uploaded into.
 *
 * The strictness is free, and that is the design: every way this can decline to
 * answer falls through to the observe-and-corroborate path that was already
 * there, with its refusal intact. So a wrong answer here costs a model call,
 * and there is no input this accepts that the guard downstream would not also
 * have accepted.
 */
export async function resumeUploadFromDom(
  page: Page
): Promise<{ selector: string; haystack: string; region: string | null } | null> {
  const controls = await listFileUploadControls(page);
  if (controls.length === 0) return null;

  const identified: { selector: string; haystack: string; region: string | null }[] = [];
  for (const control of controls) {
    const descriptor = await describeControl(page, control.selector);
    // No labelling at all is no evidence at all. `corroborate()` falls back to
    // the reader's description in that case; there is no reader here, so the
    // only honest answer is to leave this control to the path that has one.
    if (!descriptor.found || descriptor.haystack === "") continue;
    if (!FIELD_KEYWORDS.resume.test(descriptor.haystack)) continue;
    const conflicts = (Object.keys(FIELD_KEYWORDS) as FieldKey[]).filter(
      (other) => other !== "resume" && FIELD_KEYWORDS[other].test(descriptor.haystack)
    );
    if (conflicts.length > 0) {
      console.warn(
        `${LOG} ignoring the file input at ${control.selector}: it describes itself as ` +
          `${JSON.stringify(descriptor.haystack)}, which reads as ${conflicts.join("/")} as ` +
          `well as the resume`
      );
      continue;
    }
    identified.push({ ...control, haystack: descriptor.haystack });
  }

  if (identified.length === 1) return identified[0]!;
  if (identified.length > 1) {
    // Two controls on one form both claiming to be the resume. Nothing here can
    // choose between them honestly, and choosing by document order is exactly
    // the failure this function was written to end.
    console.warn(
      `${LOG} ${identified.length} file inputs each describe themselves as the resume ` +
        `(${identified.map((entry) => JSON.stringify(entry.haystack)).join(", ")}); leaving the ` +
        `choice to a live observation`
    );
  }
  return null;
}

/**
 * How long `confirmAttachment` will wait for a board to say, in its own words,
 * that the file arrived. Never reached on the success path, where a control
 * that still holds the file answers on the first read.
 */
const ATTACHMENT_CONFIRM_BUDGET_MS = 6_000;
const ATTACHMENT_CONFIRM_POLL_MS = 400;

/** Said in two places, and it has to be the same sentence in both. */
const COULD_NOT_RE_READ =
  `the control could not be re-read to confirm (the board replaced it once the file was set, ` +
  `or the form is inside an iframe or a web component's shadow DOM)`;

/** What the page could be got to say about the file after it was set. */
type Attachment =
  | { confirmed: true; how: string }
  | { confirmed: false; blocking: true; why: string }
  | { confirmed: false; blocking: false; why: string };

/**
 * JOB-053. Whether the file really landed, asked of the page rather than
 * inferred from the fact that `setInputFiles` did not throw.
 *
 * ── What the old check could and could not see ──────────────────────────────
 * It asked the input how many files it holds, and since JOB-047 it asks the
 * page for the file name too before calling zero a failure. Both of those
 * questions are the right ones and both survive here unchanged. What neither
 * could survive is the input **not being there any more**, and on Greenhouse it
 * never is: the moment a file is set, the widget unmounts the
 * `<input type="file">` and renders a chip in its place —
 *
 *   <div class="file-upload__filename"><p>PRANAV-LENDE-Resume.pdf</p>
 *        <button aria-label="Remove file">…</button></div>
 *
 * — so `describeControl` answered `found: false` and the outcome degraded to
 * "could not be re-read to confirm" on every Greenhouse run there has ever
 * been. The file header blamed an iframe for that; verified against the live
 * Virtu form for this ticket, the form is not in an iframe and the control is
 * simply gone. The comment is corrected accordingly.
 *
 * ── What replaces it ────────────────────────────────────────────────────────
 * The file name the board now displays. JOB-047 had already established that
 * this is the second, independent question worth asking, for the neighbouring
 * case where the control is *present* and honestly reports zero files because a
 * component read the File, uploaded it itself and reset the input —
 * SmartRecruiters does exactly that. `pageShowsFileName` is its answer and is
 * used unchanged here.
 *
 * What JOB-053 adds is a **narrower** place to look first. `region` is the
 * upload's own labelled block, so a hit there is the stronger of the two
 * claims: it says the resume is on the resume row, which is the exact thing
 * this ticket exists because the resolver got wrong. The page wide search stays
 * as the fallback, because plenty of boards render their chip outside anything
 * this can address.
 *
 * ── What is asked when ──────────────────────────────────────────────────────
 * Both are positive evidence and neither is a relaxation: the board has to be
 * showing the exact file name that was just set.
 *
 *  · Control present, holding files — confirmed on the first read, no waiting.
 *  · Control present, holding none — JOB-047's rule, and still a hard stop when
 *    nothing on the page names the file.
 *  · Control gone — reports rather than blocks when nothing names the file.
 *    Boards that show a tick, a spinner or nothing at all are ordinary, and
 *    turning an unrecognised chip into a blocked application would trade this
 *    ticket's bug for a worse one.
 *
 * The waiting is new and applies to both of the last two. A board that uploads
 * the file itself before rendering its chip has a network round trip to make
 * first, so "is the name on the page yet" is not a question with an immediate
 * answer. Measured on the live Virtu form: the `<input>` is already detached at
 * +0ms, the block still reads "Resume/CV*" at +500ms, and reads
 * "Resume/CV*PRANAV-LENDE-Resume.pdf" by +2000ms. Reading once called that a
 * file that had not landed. Waiting cannot turn a failure into a pass — the
 * verdict when the budget runs out is the one a single read would have given.
 */
export async function confirmAttachment(
  page: Page,
  selector: string,
  region: string | null,
  fileName: string
): Promise<Attachment> {
  const after = await describeControl(page, selector);
  // A control that is still on the page answers `files.length` the instant the
  // file is set, so the success path is decided on the first read and waits for
  // nothing.
  if (after.found && after.attachedFiles > 0) {
    return { confirmed: true, how: `the control confirms ${after.attachedFiles} file(s)` };
  }
  // `-1` is `describeControl`'s "this element has no `files` property at all",
  // which is a different statement from "it holds none" and is not evidence
  // either way. JOB-047's stop is written against `=== 0` for that reason and
  // stays written against it; there is nothing here for a wait to resolve.
  if (after.found && after.attachedFiles !== 0) {
    return { confirmed: false, blocking: false, why: COULD_NOT_RE_READ };
  }

  const deadline = Date.now() + ATTACHMENT_CONFIRM_BUDGET_MS;
  for (;;) {
    if (region !== null) {
      const block = await describeControl(page, region);
      if (block.found && block.text.includes(fileName)) {
        return {
          confirmed: true,
          how: `the upload's own block now shows ${JSON.stringify(fileName)}`,
        };
      }
    }
    if (await pageShowsFileName(page, fileName)) {
      return { confirmed: true, how: `the page shows ${JSON.stringify(fileName)}` };
    }
    if (Date.now() >= deadline) break;
    await sleep(ATTACHMENT_CONFIRM_POLL_MS);
  }

  // JOB-047's hard stop, unchanged: a control that is there and says it holds
  // nothing, on a page that never names the file, did not take the upload.
  if (after.found) {
    return {
      confirmed: false,
      blocking: true,
      why:
        `the control still reports no attached file and the page does not show ` +
        `${JSON.stringify(fileName)} anywhere`,
    };
  }
  return { confirmed: false, blocking: false, why: COULD_NOT_RE_READ };
}

/** `Ada Lovelace` → `Ada-Lovelace-Resume.pdf`. What a recruiter sees in their inbox. */
function resumeFileName(profile: ResumeProfile): string {
  const stem = [profile.firstName, profile.lastName]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("-")
    .replace(/[^A-Za-z0-9-]/g, "");
  return stem === "" ? "resume.pdf" : `${stem}-Resume.pdf`;
}

async function attachResume(
  session: BrowserSession,
  url: string,
  signals: FormSignals,
  bytes: Uint8Array,
  profile: ResumeProfile
): Promise<FieldOutcome> {
  const fileName = resumeFileName(profile);

  // Checked here as well as at the download, because this is the last point
  // before the bytes leave for a real employer and the read-back below cannot
  // always be relied on to notice: on Greenhouse the upload widget unmounts its
  // `<input type="file">` the instant a file is set, so `describeControl` finds
  // nothing afterwards and the "still reports no attached file" check has
  // nothing to test. (This comment used to say the form was in an iframe;
  // JOB-053 checked the live Virtu form and it is not — the control is simply
  // replaced. `confirmAttachment` now recovers most of that lost read-back from
  // the file name the board displays in its place.) An empty attachment is
  // worse than a blocked run — a submitted application with no resume on it
  // cannot be un-sent.
  if (bytes.byteLength === 0) {
    throw new FormFillBlockedError(
      `The resume to attach is 0 bytes. An application with an empty resume attached is worse ` +
        `than no application, so this stops here. Nothing was submitted.`
    );
  }

  // The deterministic paths first, cheapest and least inferential to most.
  let selector: string;
  let via: string;
  let region: string | null = null;
  const named = await resumeUploadFromDom(session.page);
  if (named !== null) {
    // JOB-053. The DOM names exactly one of its file inputs the resume, so
    // there is nothing to infer and no model in the path at all. Ahead of the
    // single-input shortcut below on purpose: when a page has one file input
    // and that input names itself, this addresses it by that name rather than
    // by whatever `input[type=file]` happens to resolve to, and it carries the
    // upload's own block along with it, which is what `confirmAttachment` reads
    // the result out of once the board takes the control away.
    selector = named.selector;
    region = named.region;
    via = `the file input the page itself names the resume (${JSON.stringify(named.haystack.slice(0, 80))})`;
  } else if (signals.domFileInputCount === 1) {
    // The whole page has exactly one real `input[type=file]`, so there is
    // nothing to identify and no model in the path at all.
    //
    // JOB-053 added the one check this had none of. "Nothing to identify" is
    // true when the control is unlabelled, which is the case this path was
    // written for, and false when the page's only upload names itself the cover
    // letter — a shape that arises the moment a board renders the resume box as
    // parse-my-resume text and leaves the cover letter as the only real file
    // input. Uploading a candidate's resume into a cover letter field cannot be
    // taken back and is a worse outcome for them than a stopped run, so the
    // count on its own is no longer enough. Deliberately narrow: an unlabelled
    // input still takes this path, and only a positive statement that this is a
    // *different* named field stops it.
    const only = await describeControl(session.page, "input[type=file]");
    if (
      only.found &&
      only.haystack !== "" &&
      !FIELD_KEYWORDS.resume.test(only.haystack) &&
      FIELD_KEYWORDS.coverLetter.test(only.haystack)
    ) {
      throw new FormFillBlockedError(
        `The only file upload on the form at "${url}" describes itself as ` +
          `${JSON.stringify(only.haystack)}, which is the cover letter field rather than the ` +
          `resume. Refusing to upload the candidate's resume into it. Nothing was submitted.`
      );
    }
    selector = "input[type=file]";
    via = "the page's only file input (no inference needed)";
  } else {
    let resolved = await tryResolveAction(session, url, INSTRUCTIONS.RESUME_UPLOAD);
    if (resolved === null) {
      throw new FormFillBlockedError(
        `The application form at "${url}" reports a resume upload control, but no control ` +
          `matched it. An application without the resume attached is not worth submitting, so ` +
          `this stops here. Nothing was submitted.`
      );
    }
    // Only the labelling half of the corroboration applies here: a file input is
    // exactly what we want for this one, so the "not something to type into"
    // rule that `corroborate` enforces for text fields would be backwards.
    const evidenceFor = async (candidate: ResolvedAction): Promise<string> => {
      const descriptor = await describeControl(session.page, candidate.action.selector);
      // Same rule as `corroborate`, for the same reason: a replayed action's
      // description is this module's own instruction, which says "resume or CV"
      // in so many words, so falling back to it would let any replayed selector
      // read as a resume upload however wrong it is. A replay is worth what the
      // DOM says about it and nothing else. See `replayNeedsDomEvidence`.
      if (candidate.replayed) return descriptor.haystack;
      return descriptor.haystack || candidate.action.description;
    };
    let evidence = await evidenceFor(resolved);
    // JOB-006, and the same rule `corroborateResolved` applies to text fields: a
    // replayed selector that does not describe itself as a resume upload buys
    // one live observation rather than blocking the run. Refusing to attach a
    // resume stops the application dead, so a stale cache row must not be able
    // to reach that outcome on its own.
    if (resolved.replayed && !FIELD_KEYWORDS.resume.test(evidence)) {
      const fresh = await reResolveLive(session, url, INSTRUCTIONS.RESUME_UPLOAD, "it does not read as a resume upload");
      if (fresh === null) {
        // The live observation found nothing either, so the replayed selector
        // was the only thing claiming this control exists and it has just been
        // dropped. Same stop as an absent control above, rather than a report
        // that the upload "describes itself as" the empty string.
        throw new FormFillBlockedError(
          `The application form at "${url}" reports a resume upload control, but the only ` +
            `selector for it came from the shared form action cache and nothing on this page ` +
            `corroborates it. An application without the resume attached is not worth ` +
            `submitting, so this stops here. Nothing was submitted.`
        );
      }
      resolved = fresh;
      evidence = await evidenceFor(fresh);
    }
    if (!FIELD_KEYWORDS.resume.test(evidence)) {
      throw new FormFillBlockedError(
        `The control found for the resume upload describes itself as ${JSON.stringify(evidence)}, ` +
          `which does not read as a resume/CV upload. Refusing to upload the candidate's resume ` +
          `into an unidentified control. Nothing was submitted.`
      );
    }
    selector = resolved.action.selector;
    via = `an observed upload control described as ${JSON.stringify(evidence.slice(0, 80))}`;
  }

  try {
    // No model anywhere in this path: the PDF's bytes go straight from Supabase
    // storage to the browser's file input.
    await session.page.locator(selector).setInputFiles({
      name: fileName,
      mimeType: "application/pdf",
      buffer: bytes,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new FormFillBlockedError(
      `Could not attach the resume to the control found via ${via}: ${reason}. Nothing was ` +
        `submitted.`
    );
  }

  const attachment = await confirmAttachment(session.page, selector, region, fileName);
  if (!attachment.confirmed && attachment.blocking) {
    throw new FormFillBlockedError(
      `The resume was set on the upload control found via ${via}, but ${attachment.why}. ` +
        `Nothing was submitted.`
    );
  }

  console.log(`${LOG} resume attached as "${fileName}" (${bytes.byteLength} bytes) via ${via}`);
  return {
    field: "resume",
    intended: fileName,
    outcome: "filled",
    detail: attachment.confirmed
      ? `attached via ${via}; ${attachment.how}`
      : `attached via ${via}; ${attachment.why}`,
    readBack: attachment.confirmed ? attachment.how : null,
  };
}

// ───────────────────────────────────
// The screenshot
// ───────────────────────────────────

const DEFAULT_SCREENSHOT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".form-fill-screenshots"
);

/**
 * The acceptance artefact. ACT-007's criterion is "confirm the filled-but-not-
 * yet-submitted form matches the resume data" — the field-by-field read-back
 * report proves it mechanically, and this proves it to a human in one glance.
 * Never fatal: a screenshot that could not be written must not fail a run that
 * otherwise worked.
 */
async function captureFilledForm(
  session: BrowserSession,
  jobApplicationId: string,
  directory: string
): Promise<string | null> {
  try {
    await mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = resolve(directory, `${jobApplicationId}-${stamp}.png`);
    const bytes = await session.page.screenshot({ fullPage: true });
    await writeFile(path, bytes);
    console.log(`${LOG} filled-but-not-submitted screenshot → ${path}`);
    return path;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG} could not save the screenshot (ignored): ${reason}`);
    return null;
  }
}

// ───────────────────────────────────
// Main flow
// ───────────────────────────────────

/**
 * Fills the application form for one `applications` row and stops. The
 * browser is always closed before this returns.
 *
 * Always leaves the row in a state that says what happened:
 *
 *  · `form_filled` — the form carries the candidate's data and was not submitted.
 *  · `form_fill_blocked` — something needed a human. **Returned, not thrown**,
 *    with `blockedReason` set and whatever was filled before the stop still
 *    listed in `fields`. That mirrors `create-board-account.ts`'s
 *    `account_gate_blocked` and matters for the same reason: a thrown error
 *    invites a retry, and a retry into the same wall is pointless at best.
 *  · `error` — a failure a retry might genuinely fix. Rethrown, so an Inngest
 *    step retries it and a CLI exits non-zero.
 */
export async function fillApplicationForm(
  input: FillApplicationFormInput
): Promise<FillApplicationFormResult> {
  const handoff = await runFill(input, false);
  // Unreachable — `false` above means `runFill` never hands a session back.
  // Kept because "leaks a Chrome process" is the failure mode of being wrong
  // about that, and one branch is cheaper than that bug.
  if (handoff.session !== null) await closeBrowserSession(handoff.session);
  return handoff.result;
}

/** What `fillApplicationFormRetainingSession` hands back. */
export type RetainedFillSession = {
  result: FillApplicationFormResult;
  /**
   * The **live** browser, still on the filled form — non-null on exactly one
   * path: `result.status === "form_filled"` and `result.blockedReason === null`.
   * Null on every blocked path, and no session exists at all when this throws.
   *
   * The caller owns it from here and **must** `closeBrowserSession()` it in a
   * `finally`, or the process leaks a Chrome.
   */
  session: BrowserSession | null;
};

/**
 * `fillApplicationForm`, but the browser stays open on success.
 *
 * The single door for `submit-application.ts` (ACT-008), and the reason it
 * exists is in this file's header: a filled form is browser state, and browser
 * state cannot be handed across a process boundary — so the only way to submit
 * the form this module filled, rather than a form re-derived from scratch by a
 * second implementation of every guard here, is to keep the same session alive.
 *
 * Nothing else about the flow differs. In particular the row is still moved to
 * `form_filled` before this returns, so a caller that crashes between here and
 * its submit click leaves a row that correctly reads "filled, not submitted".
 */
export async function fillApplicationFormRetainingSession(
  input: FillApplicationFormInput
): Promise<RetainedFillSession> {
  return await runFill(input, true);
}

/**
 * JOB-134. Writes the person's answer memory back to `profiles.stored_answers`.
 *
 * Never throws. A run that cannot write this column has still been handed the
 * answers it needs for the application in front of it, and failing the fill
 * because a note could not be filed would turn a working application into a
 * blocked one — which is the opposite of what this ticket is for. The cost of a
 * failed write is that the same question gets asked once more.
 *
 * The whole list is written rather than an append, because `rememberAnswers`
 * has already decided what the list is: one entry per question, newest first,
 * capped. Two runs for the same person racing here is the ordinary case (the
 * pipeline fans out), and last writer wins is the right outcome for it — both
 * writers hold the same stored history and differ only by whatever this
 * particular run was told, so the loser's answers are still in the winner's
 * list unless the two runs were told different things about the same question,
 * in which case the newer of the two is the one to keep anyway.
 */
async function persistStoredAnswers(
  supabase: SupabaseClient,
  candidateId: string,
  answers: readonly StoredAnswer[]
): Promise<void> {
  try {
    const { error } = await supabase
      .from("profiles")
      .update({ stored_answers: answers })
      .eq("id", candidateId);
    if (error !== null) throw new Error(error.message);
    console.log(
      `${LOG} remembered ${answers.length} answer(s) for profile ${candidateId} — the next ` +
        `application will not ask them again`
    );
  } catch (err) {
    console.warn(
      `${LOG} could not write profiles.stored_answers for ${candidateId}, continuing without ` +
        `remembering: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Exported for `tests/unit/fill-application-form.test.ts`, which pins the
 * contract this predicate must keep while ESCALATION_ENABLED is false: the
 * classification is untouched, so flipping the gate back to true restores
 * v1-C behaviour with no other edit.
 */
export function isEscalationBlock(blockedReason: string): boolean {
  return (
    blockedReason.startsWith("needs_candidate_input:") ||
    blockedReason.startsWith("needs_attestation:")
  );
}

/**
 * JOB-170 Change 3. Files the fabrication rung's answers onto
 * `applications.answer_provenance` once the row has landed on `form_filled`.
 *
 * Written here rather than through `updateApplication` so the patch type in
 * `lib/application-records.ts` stays untouched: this module already owns
 * direct column writes for run-scoped state (see `persistStoredAnswers`
 * above for the precedent and the reasoning).
 *
 * Never throws, same rule as every other bookkeeping write on this path: a
 * run that filled and verified a real form must not be failed by its own
 * audit trail. The entries also stay on the returned report either way.
 */
async function persistAnswerProvenance(
  supabase: SupabaseClient,
  jobApplicationId: string,
  entries: readonly AnswerProvenanceEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const { error } = await supabase
      .from("applications")
      .update({ answer_provenance: entries })
      .eq("id", jobApplicationId);
    if (error !== null) throw new Error(error.message);
    console.log(
      `${LOG} applications ${jobApplicationId}: recorded ${entries.length} fabricated ` +
        `answer(s) in answer_provenance`
    );
  } catch (err) {
    console.warn(
      `${LOG} could not write applications.answer_provenance for ${jobApplicationId}, ` +
        `continuing without it: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * v1-C (#143). Move a row into `pending_user_input`, tag each required
 * question with v1-B's classifier, and fire the notifier once.
 *
 * Returns the fill result with the new status stitched in so the caller sees
 * the same shape any other block returns: everything filled up to the point
 * of the escalation, and a status that names what happened. The pipeline's
 * cron will pick this row up again the moment the dashboard resume path
 * flips it back to `discovered`.
 */
async function handleEscalationBlock(
  supabase: SupabaseClient,
  jobApplicationId: string,
  report: Omit<FillApplicationFormResult, "status">
): Promise<RetainedFillSession> {
  const required = report.needsInput.filter((item) => item.required);
  const questions: EscalationQuestion[] = (required.length > 0
    ? required
    : report.needsInput
  ).map((item) => ({
    fieldKey: item.key,
    fieldLabel: item.fieldLabel,
    question: item.question,
    options: item.options ?? null,
    required: item.required,
    topicSlug: classifyIntent(item.question)?.slug ?? null,
  }));

  const now = new Date();
  await writeEscalation(supabase, jobApplicationId, questions, { now });
  console.log(
    `${LOG} applications ${jobApplicationId} → ${APPLICATION_STATUS.PENDING_USER_INPUT} ` +
      `(${questions.length} question(s) surfaced; waiting on the user)`
  );

  // Best effort. A notifier that could not fire (missing credentials, upstream
  // rejection) already logged its own warning, and the row is still in the
  // right state for the dashboard to surface it on the person's next visit.
  try {
    await sendEscalationNotification({ supabase, applicationId: jobApplicationId, now });
  } catch (err) {
    console.warn(
      `${LOG} notifier threw for ${jobApplicationId}, continuing: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    result: { ...report, status: APPLICATION_STATUS.PENDING_USER_INPUT },
    session: null,
  };
}

async function runFill(
  input: FillApplicationFormInput,
  retainSession: boolean
): Promise<RetainedFillSession> {
  if (!input.jobApplicationId?.trim()) throw new Error("jobApplicationId is required");

  const supabase = getSupabaseClient();
  const jobApplicationId = input.jobApplicationId.trim();

  // The apply URL is checked inside `loadApplicationState`, which runs before
  // the try below and so before the catch that records a blocked run. A refused
  // URL still has to leave the row in a state that says what happened, and it
  // is the one stop that can happen this early, so it is recorded here.
  let state: ApplicationState;
  try {
    state = await loadApplicationState(supabase, jobApplicationId);
  } catch (err) {
    if (err instanceof BlockedApplyUrlError) {
      await recordFailure(supabase, {
        applicationId: jobApplicationId,
        jobId: err.jobId,
        ats: err.ats,
        status: APPLICATION_STATUS.FORM_FILL_BLOCKED,
        // Named rather than derived. `skipReasonFor` reads the message for a
        // tag it recognises, and none of the six reasons in the closed set is
        // this one: `dom_changed` is the documented fallback for a run that
        // stopped against a page that is not what the automation expected, and
        // a listing pointing somewhere the board does not own is exactly that.
        // A reason of its own is worth having and needs a migration, so it is a
        // ticket rather than a line here.
        reason: "dom_changed",
        message: err.message,
        log: LOG,
      });
    }
    throw err;
  }

  console.log(
    `${LOG} applications ${jobApplicationId} — ${state.company} / ${state.jobTitle} ` +
      `(status "${state.status}")`
  );

  // ── JOB-134: an answer the candidate gave once is still their answer ──────
  //
  // Two halves, and they run here rather than deeper in for one reason each.
  //
  // The write runs before the browser opens, so that an answer somebody typed
  // survives a run that later fails on a CAPTCHA, a bot wall or a board being
  // down. Nothing about this application has to succeed for the person to have
  // told us something true about themselves, and losing it because the page did
  // not load would be the exact bug this ticket exists to close, one layer
  // down. It is also why a failed write does not stop the run: the answers are
  // in hand for this application either way, and the cost of not persisting
  // them is being asked once more, not a wrong value on a form.
  //
  // The merge happens once, here, so that both places `additionalAnswers`
  // reaches the fill — the first pass and each wizard step — see the same map.
  // Nothing downstream can tell a stored answer from one supplied a second ago,
  // and nothing downstream should: `resolveAdditionalAnswer`, the attestation
  // ladder, `optionSupportsFact` and the read-back all run over it unchanged.
  const supplied = input.additionalAnswers ?? {};
  const remembered = rememberAnswers(
    state.storedAnswers,
    Object.entries(supplied).map(([question, answer]) => ({ question, answer })),
    { now: new Date() }
  );
  if (!sameStoredAnswers(remembered, state.storedAnswers)) {
    await persistStoredAnswers(supabase, state.candidateId, remembered);
    state.storedAnswers = remembered;
  }
  const filling: FillApplicationFormInput = {
    ...input,
    additionalAnswers: withStoredAnswers(state.storedAnswers, supplied),
  };

  try {
    // ── Everything that touches untrusted text happens here, before a browser
    // exists. Not an accident of ordering: for the whole duration of the resume
    // parse and the cover-letter write, this process has nothing that can click,
    // navigate, upload or submit, so there is nothing for an injection in that
    // text to reach even in principle.
    const resume = await loadResume(supabase, state.candidate.resumeUrl);
    console.log(
      `${LOG} resume: ${resume.pageCount} page(s), ${resume.text.length} characters of text`
    );
    // JOB-112. The resume PDF is still downloaded every run, because its bytes
    // are what gets attached to the employer's form and there is nowhere else
    // to get them. What no longer happens every run is the *parse*: this reads
    // `resumes.parsed` when it holds a parse of these same two documents, and
    // falls back to parsing inline and storing the result when it does not.
    // A row that predates this ticket takes the fallback once and is stored
    // from then on, which is why no backfill was needed.
    const profile = await resolveCandidateProfile(
      supabase,
      {
        resumeId: state.candidate.resumeId,
        resumePath: state.candidate.resumeUrl,
        linkedinPdfPath: state.candidate.linkedinPdfPath,
      },
      resume.text,
      state.candidate
    );
    for (const warning of profile.warnings) console.warn(`${LOG} note: ${warning}`);

    const coverLetter = input.requiresCoverLetter
      ? await generateCoverLetter({
          profile,
          company: state.company,
          jobTitle: state.jobTitle,
          jobDescription: input.jobDescription ?? null,
        })
      : null;
    if (coverLetter === null) {
      console.log(`${LOG} listing does not require a cover letter — none generated`);
    } else {
      console.log(`${LOG} cover letter generated (${coverLetter.length} characters)`);
    }

    await updateApplication(supabase, jobApplicationId, {
      status: APPLICATION_STATUS.FILLING_FORM,
    });

    const { report, session } = await runBrowserFlow(
      supabase,
      state,
      // `filling`, not `input`: this is the one carrying the stored answers
      // folded in, and `advanceThroughWizard` reads them off the same object.
      filling,
      resume.bytes,
      profile,
      coverLetter,
      retainSession
    );

    if (report.blockedReason !== null) {
      // ── v1-C (#143): route needs_candidate_input / needs_attestation into
      // the async escalation flow instead of the terminal blocked state ──
      //
      // `blockedForAnswers` prefixes its message with one of those two tags
      // and returns the `needsInput` items on `report`. Anything else — a
      // captcha, a DOM change, an unreachable form — is a stop-for-a-human
      // that a routine reask cannot close, so it still lands in
      // `form_fill_blocked` for the operator to look at.
      //
      // JOB-170: gated behind ESCALATION_ENABLED. With the gate off, a
      // needs-tagged block falls through to `form_fill_blocked` exactly like
      // any other stop, which should be vanishingly rare because the
      // fabrication rung answers what used to escalate. The residual cases
      // that still reach here are EEO questions with no decline option and
      // repeating section entries.
      if (ESCALATION_ENABLED && isEscalationBlock(report.blockedReason)) {
        return await handleEscalationBlock(supabase, jobApplicationId, report);
      }

      await recordFailure(supabase, {
        applicationId: jobApplicationId,
        jobId: state.jobId,
        ats: state.ats,
        status: APPLICATION_STATUS.FORM_FILL_BLOCKED,
        message: report.blockedReason,
        browserbaseSessionId: report.browserbaseSessionId,
        log: LOG,
      });
      // JOB-170: a blocked run can still have fabricated answers earlier on
      // the form (the verification run against Western Digital fabricated
      // three screening answers and then stopped on the residual EEO
      // questions). The audit trail is written on this path too, so a row
      // that never submits still records what the model chose. Best effort,
      // same as below.
      await persistAnswerProvenance(supabase, jobApplicationId, report.answerProvenance);
      // `session` is null on every blocked path — `runBrowserFlow` closed it.
      return {
        result: { ...report, status: APPLICATION_STATUS.FORM_FILL_BLOCKED },
        session: null,
      };
    }

    try {
      await updateApplication(supabase, jobApplicationId, {
        status: APPLICATION_STATUS.FORM_FILLED,
        browserbaseSessionId: report.browserbaseSessionId,
      });
    } catch (err) {
      // A retained session is live at this point and nothing downstream will
      // ever see it, because this throw skips the return. Close it here or the
      // browser outlives the process's interest in it.
      if (session !== null) await closeBrowserSession(session);
      throw err;
    }
    await persistAnswerProvenance(supabase, jobApplicationId, report.answerProvenance);
    console.log(
      `${LOG} applications ${jobApplicationId} → ${APPLICATION_STATUS.FORM_FILLED} ` +
        `(the form is filled and NOT submitted — submission is ACT-008)`
    );
    return { result: { ...report, status: APPLICATION_STATUS.FORM_FILLED }, session };
  } catch (err) {
    // Two failure classes, and the distinction is the whole point. A blocked run
    // reaching here (rather than being returned by `runBrowserFlow`) means the
    // stop happened before or after the browser existed — a suspected injection
    // in the resume, say — but it is still a stop-for-a-human, not a retry.
    if (err instanceof FormFillBlockedError || err instanceof InjectionSuspectedError) {
      await recordFailure(supabase, {
        applicationId: jobApplicationId,
        jobId: state.jobId,
        ats: state.ats,
        status: APPLICATION_STATUS.FORM_FILL_BLOCKED,
        message: err.message,
        log: LOG,
      });
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    await recordFailure(supabase, {
      applicationId: jobApplicationId,
      jobId: state.jobId,
      ats: state.ats,
      status: APPLICATION_STATUS.ERROR,
      message,
      log: LOG,
    });
    throw err;
  }
}

type BrowserFlowOutcome = {
  report: Omit<FillApplicationFormResult, "status">;
  session: BrowserSession | null;
};

async function runBrowserFlow(
  supabase: SupabaseClient,
  state: ApplicationState,
  input: FillApplicationFormInput,
  resumeBytes: Uint8Array,
  profile: ResumeProfile,
  coverLetter: string | null,
  retainSession: boolean
): Promise<BrowserFlowOutcome> {
  const headless = input.headless !== false;
  // Ashby's spam filter explicitly detects proxy IPs (their rejection page says
  // "Turn off your VPN or proxy" first). Run Ashby without proxies so the
  // outbound IP is the Browserbase host rather than a proxy node.
  const disableProxies = state.ats === "ashby";
  // JOB-050. A persistent context carries one fingerprint and one cookie jar
  // across every run for this person, so a board sees a returning device rather
  // than a brand new machine each time. Resolves to `undefined` whenever the
  // flag is off or anything about it fails, and the run then proceeds exactly as
  // it did before contexts existed.
  const contextId = await resolveBrowserbaseContextId({
    userId: state.candidateId,
    logTag: LOG,
    readStoredId: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("browserbase_context_id")
        .eq("id", state.candidateId)
        .maybeSingle();
      if (error !== null) throw new Error(error.message);
      const stored = (data as { browserbase_context_id?: string | null } | null)
        ?.browserbase_context_id;
      return stored ?? null;
    },
    persistId: async (value) => {
      const { error } = await supabase
        .from("profiles")
        .update({ browserbase_context_id: value })
        .eq("id", state.candidateId);
      if (error !== null) throw new Error(error.message);
    },
  });
  const session = await openBrowserSession({
    headless,
    logTag: LOG,
    disableProxies,
    contextId,
  });
  const browserbaseSessionId = session.browser.sessionId ?? null;
  console.log(`${LOG} local browser session opened (headless=${headless}) — dedicated to this run`);

  /**
   * Whether the `finally` below hands the browser on instead of killing it.
   *
   * Starts false and is set at exactly one place — the last statement before the
   * clean-success `return`, after every read of the page that could still throw.
   * So every other exit (blocked, thrown, teardown mid-flight) closes the
   * browser exactly as it always did, and "the fill did not finish cleanly" can
   * never leave a live session for a submitter to click in.
   */
  let retained = false;

  // Hoisted out of the `try` so a blocked stop can still report what had already
  // been done when it happened. A report that says "blocked, and by the way
  // these four fields are filled in" is a very different thing for the human who
  // picks it up than a bare error string.
  const cover = { required: input.requiresCoverLetter, generated: coverLetter !== null };
  let verification: VerificationOutcome = {
    required: false,
    method: "none",
    completed: false,
    detail: "not reached",
    signals: null,
  };
  const fields: FieldOutcome[] = [];
  // Hoisted for the same reason `fields` is: a blocked stop must still be able
  // to report the questions it was blocked on, and the commonest blocked stop
  // this module now has *is* "it needs answers".
  const needsInput: NeedsInputItem[] = [];
  // JOB-170. What the fabrication rung answered across every pass and every
  // wizard step of this run, carried out the same way so a blocked stop still
  // reports what was fabricated before it stopped.
  const answerProvenance: AnswerProvenanceEntry[] = [];

  try {
    verification = await completeVerification(supabase, session, state, input.verification);

    let signals = await reachApplicationForm(session, state, verification.signals);
    console.log(`${LOG} application form reached at ${signals.url}`);

    // The cover letter needs somewhere to go before anything is typed. Doing
    // this first means a required-but-impossible cover letter blocks the run
    // before it has half-filled a real employer's form.
    if (coverLetter !== null && !signals.coverLetterTextAreaPresent) {
      if (!signals.coverLetterManualEntryControlPresent) {
        throw new FormFillBlockedError(
          `This listing requires a cover letter, but the form at "${signals.url}" offers no ` +
            `text box to type one into` +
            (signals.coverLetterUploadPresent
              ? ` — only a file upload. Generating and uploading a cover-letter document is ` +
                `out of ACT-007's scope; a human should paste the letter in.`
              : ` and no control to switch to typing one.`) +
            ` Nothing was submitted.`
        );
      }
      await clickControl(
        session,
        signals.url,
        "the control that switches the cover letter to manual entry",
        INSTRUCTIONS.COVER_LETTER_MANUAL,
        /(manual|type|write|paste|enter|text)/i
      );
      signals = await readFormSignals(session);
      if (!signals.coverLetterTextAreaPresent) {
        throw new FormFillBlockedError(
          `Switched the cover letter to manual entry at "${signals.url}", but no text box ` +
            `appeared. Nothing was submitted.`
        );
      }
    }

    // ── JOB-006: pick up whatever an earlier run learned about this form shape.
    //
    // Placed at exactly this line, and both halves of that matter.
    //
    // Not earlier, because the form has to be the form: before the apply control
    // is clicked the page is a job description, and the cover letter box above
    // may not exist until the manual entry control has been pressed. A
    // fingerprint taken before that click describes a form nobody is about to
    // fill, and worse, it would let a stored "this form has no cover letter box"
    // stand against a page that had just grown one.
    //
    // Not later, because every field lookup below this line is one the plan can
    // answer without a model, which is the entire saving.
    //
    // The read is the same `enumerateFormFields` the ACT-015 pass runs further
    // down: pure DOM, no inference. Running it twice costs a page evaluate,
    // which is the cheapest thing in this file by orders of magnitude.
    // The last thing before the candidate's own answers start going into boxes,
    // and the cover letter control above is one more click that could have moved
    // the page since `reachApplicationForm` last looked.
    await assertStillOnTheBoard(session, state, "with the application form ready to fill");

    await attachFormActionPlan(supabase, session, signals.url);

    const plan = buildFieldPlan(profile, signals, coverLetter);
    fields.push(...(await fillFields(session, signals.url, plan)));

    // The fill is finished before this fires so the report names every field,
    // and then the run stops: ACT-008 must not submit a form holding a value
    // nobody chose, and a retry cannot fix it without a human looking.
    assertNoMismatches(fields, signals.url);

    if (signals.resumeUploadPresent || signals.fileInputCount > 0) {
      // The resume is the whole reason this rule exists. A multi step form is
      // free to have moved between the fields above and the upload below, so
      // where the file is about to go is checked here and not inferred from a
      // check made before the first character was typed.
      await assertStillOnTheBoard(session, state, "with the resume about to be uploaded");
      fields.push(await attachResume(session, signals.url, signals, resumeBytes, profile));
    } else {
      fields.push({
        field: "resume",
        intended: resumeFileName(profile),
        outcome: "not-on-form",
        detail: "the form has no resume upload control",
      });
    }

    // ── ACT-015: everything the eight named fields above do not cover ───────
    // The third bracket. This pass answers questions from the intake data and
    // from the resume, which is the same person's data by another route.
    await assertStillOnTheBoard(session, state, "with the remaining questions about to be answered");
    const remaining = await fillRemainingFields(
      session,
      state,
      profile,
      input.jobDescription ?? null,
      input.additionalAnswers ?? {}
    );
    fields.push(...remaining.outcomes);
    needsInput.push(...remaining.needsInput);
    answerProvenance.push(...remaining.answerProvenance);
    assertNoMismatches(fields, signals.url);

    // A required field still empty is not a partial success — the board will
    // refuse the application, so there is nothing here for ACT-008 to submit.
    // Stopping rather than continuing is what keeps a live session from ever
    // being handed on for a form that cannot go anywhere.
    if (needsInput.some((item) => item.required)) {
      throw blockedForAnswers(needsInput, signals.url);
    }

    // Read the page again so the next decision is made against the form as it
    // now stands. Before JOB-117 this was the last read of the run; it is now
    // the read that answers "is the submit control on this step, or is this a
    // wizard that has more of itself to show us?".
    let final = await readFormSignals(session);
    // ACT-015 gave this module a second set of clicks — opening dropdowns and
    // choosing options — so the "did one of our clicks submit this?" check that
    // has always guarded the apply-click path is applied here too, against the
    // last read of the page. `form-fields.ts` refuses to click any container
    // holding a submit control, which is the structural half; this is the
    // observed half, and neither is redundant with the other.
    assertNotAlreadySubmitted(final, "the filled form");

    // ── JOB-117: the rest of the wizard ──────────────────────────────────────
    // A SmartRecruiters `oneclick-ui` form carries no submit control at all on
    // its first step; the only primary button is Next, and Submit lives on the
    // "Preliminary questions" step behind it. Every fill report this pipeline
    // has ever produced for that board reported `submitControlLabels: []`, and
    // the resulting "the filled form reported no usable control that submits the
    // application" was accurate rather than a perception failure — there was
    // nothing to report. This walks the remaining steps, filling each one the
    // same way the first was filled, and returns the page that finally does hold
    // a submit control.
    //
    // It lives here, in the fill phase, rather than in `submit-application.ts`,
    // and that placement is the design rather than a convenience. ACT-008's
    // budget is "one logical submission, ever", enforced by `submitClicks` and by
    // `submitAttempted` being set on the line before the click. Pressing Next is
    // not a submission and must not spend any part of that budget, so it happens
    // in the module that is structurally incapable of submitting: every click
    // this file makes goes through `clickControl`, which puts
    // `assertNotAnApplicationSubmit` in front of it. Advancing a step therefore
    // cannot submit by accident, for the same reason opening a dropdown cannot.
    final = await advanceThroughWizard(
      supabase,
      session,
      state,
      input,
      profile,
      final,
      fields,
      needsInput,
      answerProvenance
    );

    // Issue #116 — a whole-form verification pass belongs on this line, between
    // the last fill and the handoff to ACT-008, and JOB-117 deliberately does
    // not add it. Not because it is unwanted: a wizard is exactly where a late
    // corruption would hide, since step two's fill runs long after step one's
    // fields were each read back clean. It is left out because doing it
    // *correctly* is not the small addition it looks like. `FieldOutcome`
    // carries no selector — `field` is a label-derived key for the ACT-015 pass
    // and a hardcoded name ("firstName", "website") for the eight named ones —
    // so nothing here can reliably rejoin a recorded intent to the control it
    // went into, and the version that guesses at that join would either miss the
    // named fields (which is where #116's observed Website corruption actually
    // happened) or block live runs on boards that reformat a value after entry.
    // Giving `FieldOutcome` a selector is the right fix and it is a change
    // through `fillFields`, `record()` and the type itself — its own ticket,
    // against the file where a false positive stops a real application.
    const screenshotPath = await captureFilledForm(
      session,
      state.jobApplicationId,
      input.screenshotDir ?? DEFAULT_SCREENSHOT_DIR
    );

    retained = retainSession;
    return {
      report: {
        jobApplicationId: state.jobApplicationId,
        submitted: false,
        verification: verificationReport(verification),
        fields,
        needsInput,
        answerProvenance,
        coverLetter: coverLetterReport(cover, coverLetter, fields),
        parsedProfile: profile,
        profileWarnings: profile.warnings,
        submitControlLabels: final.submitApplicationControlLabels,
        finalUrl: final.url,
        pageTitle: final.title,
        screenshotPath,
        blockedReason: null,
        browserbaseSessionId,
      },
      session: retainSession ? session : null,
    };
  } catch (err) {
    if (!(err instanceof FormFillBlockedError)) throw err;
    console.warn(`${LOG} ${APPLICATION_STATUS.FORM_FILL_BLOCKED}: ${err.message}`);

    // Best-effort context for the human this escalates to. Every step is
    // individually allowed to fail — a blocked run must still return a report.
    const finalUrl = await session.page.url().catch(() => "");
    const pageTitle = await session.page.title().catch(() => "");
    const screenshotPath = await captureFilledForm(
      session,
      state.jobApplicationId,
      input.screenshotDir ?? DEFAULT_SCREENSHOT_DIR
    );

    return {
      report: {
        jobApplicationId: state.jobApplicationId,
        submitted: false,
        verification: verificationReport(verification),
        fields,
        needsInput,
        answerProvenance,
        coverLetter: coverLetterReport(cover, coverLetter, fields),
        parsedProfile: profile,
        profileWarnings: profile.warnings,
        // Deliberately empty on a blocked run, and load-bearing for ACT-008: a
        // form that was not finished has no submit control anyone may click.
        submitControlLabels: [],
        finalUrl,
        pageTitle,
        screenshotPath,
        blockedReason: err.message,
        browserbaseSessionId,
      },
      session: null,
    };
  } finally {
    // JOB-006. In the `finally` so that a blocked run still contributes what it
    // worked out before it stopped: the fields it did resolve are the same
    // fields on that form shape whatever happened afterwards, and a partial plan
    // is strictly better than none. Never throws, so it cannot displace the
    // failure that brought the run here.
    await saveActionPlan(supabase, session.actionPlan, LOG);
    if (!retained) await closeBrowserSession(session);
  }
}

/**
 * JOB-117. Every control the page itself marks required, across open shadow
 * roots, deduplicated the way a person counts questions rather than the way the
 * DOM counts elements.
 *
 * A radio group is one question and N `<input type="radio">` elements, so the
 * elements are folded by their shared `name` before being counted. Anything
 * without a `name` counts once on its own.
 *
 * ── JOB-121: what this was actually counting ────────────────────────────────
 * The `name`/`aria-labelledby` fold is the right idea and it is not enough on a
 * board built out of web components, because there the elements carrying
 * `required` are not siblings — they are nested inside one another. A captured
 * read of SmartRecruiters' "Preliminary questions" step returned **29** from the
 * original version of this script for a page holding **11** required questions,
 * and the extra 18 were not questions at all. One dropdown is three of them:
 *
 *   <spl-autocomplete required name="question_…">      ← the component
 *     #shadow-root
 *       <spl-input required type="text">               ← its inner component
 *         #shadow-root
 *           <input aria-required="true">               ← the thing holding the value
 *
 * and one radio group is two (`<spl-radio-group required>` wrapping a
 * `<fieldset role="radiogroup" aria-required="true">`), and the EEO block adds
 * two more wrappers of its own. So the guard was comparing a count of *elements*
 * against a count of *questions* and the two could never agree, on any board of
 * this shape, however completely perception read the page.
 *
 * The fix is to count only the innermost required element of each nest — the one
 * actually holding the answer — by dropping any required element that has
 * another counted required element beneath it. "Beneath" is the **flattened**
 * tree, not the DOM tree: a component that slots its content in
 * (`<slot name="content">`) is the visual and semantic parent of what it
 * displays while being no DOM ancestor of it, and reading the DOM tree alone
 * left the EEO wrapper looking like a twelfth question. `assignedSlot` is what
 * makes the walk follow what the browser actually paints.
 *
 * This is a correction to *what* is compared, not a relaxation of the
 * comparison. `assertStepFullyRead` still throws whenever the page shows more
 * required questions than perception read; on the captured step it now reads 11
 * against perception's 11 rather than 29 against 8. Counting elements was never
 * a stricter test, only a noisier one — a guard that fires on every page of a
 * given shape says nothing about any particular page.
 *
 * Under-counting is the safe direction, as it is for `STRUCTURAL_FLOOR_SCRIPT`
 * above: this number is compared against what perception managed to read, and a
 * floor that reads low can only make the module less likely to stop.
 */
const REQUIRED_QUESTION_SCRIPT = `(() => {
  var LIMIT = 12000;
  var seen = 0;
  var roots = [document];
  var visited = new Set();
  var required = [];
  while (roots.length && seen < LIMIT) {
    var root = roots.pop();
    if (!root || visited.has(root)) continue;
    visited.add(root);
    var all;
    try { all = root.querySelectorAll('*'); } catch (e) { continue; }
    for (var i = 0; i < all.length; i++) {
      if (seen++ >= LIMIT) break;
      var el = all[i];
      var inner = el.shadowRoot;
      if (inner) roots.push(inner);
      var isRequired = el.getAttribute('aria-required') === 'true' || el.hasAttribute('required');
      if (!isRequired) continue;
      var tag = el.tagName.toLowerCase();
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && (type === 'hidden' || type === 'submit' || type === 'button')) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      required.push(el);
    }
  }
  // Anything with another required element under it in the flattened tree is a
  // wrapper around a question, not a question.
  var counted = new Set(required);
  var wrappers = new Set();
  for (var k = 0; k < required.length; k++) {
    var node = required[k];
    for (var d = 0; d < 24; d++) {
      var up = node.assignedSlot;
      if (!up) up = node.parentElement;
      if (!up) { var host = node.getRootNode(); up = (host && host.host) ? host.host : null; }
      if (!up) break;
      if (counted.has(up)) wrappers.add(up);
      node = up;
    }
  }
  var names = new Set();
  var anonymous = 0;
  for (var m = 0; m < required.length; m++) {
    var control = required[m];
    if (wrappers.has(control)) continue;
    var name = control.getAttribute('name') || control.getAttribute('aria-labelledby') || '';
    if (name) names.add(name); else anonymous++;
  }
  return names.size + anonymous;
})()`;

/**
 * How many required questions the page is showing, by its own markup.
 *
 * Returns `null` when the sweep cannot run at all, which the caller reads as "no
 * evidence" rather than as "none": a guard that treats a failed measurement as a
 * clean bill of health is not a guard.
 */
export async function countRequiredQuestions(page: Page): Promise<number | null> {
  try {
    const count = await page.evaluate(REQUIRED_QUESTION_SCRIPT);
    return typeof count === "number" && Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * JOB-117. Refuses to call a wizard step filled when the page is showing more
 * required questions than perception managed to read.
 *
 * ── The run that made this necessary ────────────────────────────────────────
 * The first live run that got through to SmartRecruiters' "Preliminary
 * questions" step reported `form_filled` with `blockedReason: null`, and the
 * screenshot of the page it had just declared finished showed most of it blank:
 * "Are you 18 years of age or older?", the sponsorship question, highest
 * education, prior employment, non-compete, salary expectations and the privacy
 * declaration were all still empty and all still marked required. Perception had
 * read eleven controls on a page carrying roughly twice that, so the fields it
 * never saw never became `needsInput` items, `blockedForAnswers` never fired,
 * and the run reported a form it had not filled.
 *
 * That is worse than the bug this ticket set out to fix. Before JOB-117 a
 * SmartRecruiters run stopped at `submission_blocked` with nothing clicked;
 * with the wizard advance and without this check it would reach ACT-008 holding
 * a real submit control and a form full of unanswered required questions, and
 * ACT-008 would press it. A blank answer to "will you require sponsorship" on a
 * real application is not a validation failure to shrug at, and the whole point
 * of HARD STOP 9 is that the applicant is the one who wears what the form says.
 *
 * ── Why it is scoped to the wizard path ─────────────────────────────────────
 * Deliberately called from `advanceThroughWizard` and nowhere else. Every board
 * that fills and submits correctly today does so without ever advancing a step,
 * and this comparison is a heuristic — a page that marks a question required in
 * markup perception reads differently would be stopped by it. Applying it only
 * to the path this ticket introduced means it cannot regress anything that
 * currently works, and it fails closed on the one path where the evidence says
 * perception is incomplete.
 *
 * Reads as "no evidence" and stays quiet when the sweep cannot run or when the
 * page marks nothing required at all.
 */
export function assertStepFullyRead(
  pageRequired: number | null,
  readRequired: number,
  step: number,
  url: string
): void {
  if (pageRequired === null || pageRequired <= readRequired) return;
  throw new FormFillBlockedError(
    `dom_changed: step ${step} of the application at "${url}" is showing ${pageRequired} ` +
      `required question(s), and only ${readRequired} of them could be read as fillable ` +
      `controls. The ${pageRequired - readRequired} that were not read were never offered to ` +
      `the candidate to answer and are still empty, so this form is NOT filled and must not be ` +
      `handed on as though it were. Nothing was submitted. What wants fixing is the field ` +
      `enumeration on this step, not this check.`
  );
}

/**
 * JOB-117. How many times one run will press Next.
 *
 * Three, against a board known to need one. The bound exists because "press the
 * control that advances this form" is the kind of instruction that, given a page
 * which answers it by doing nothing, will happily answer it again forever — and
 * a loop that clicks an unknown control on a real employer's site an unbounded
 * number of times is not something to leave to the page's good behaviour. Two
 * spare steps is enough slack for a board that splits its questions three ways
 * without being enough to matter if the detection below is ever wrong.
 */
const MAX_WIZARD_ADVANCES = 3;

/**
 * What a control's own description has to read as before this module will press
 * it to advance a step.
 *
 * The second of two independent gates, and the narrow one.
 * `assertNotAnApplicationSubmit` inside `clickControl` is the first: it refuses
 * anything describing itself as both an application control and a submit,
 * whatever this pattern thinks. This one then has to positively agree that what
 * was found reads as a *next step* control, so a description that clears the
 * refusal by accident — an unlabelled button, a control described only by its
 * position — still does not get pressed. Deliberately absent: `submit`, `send`,
 * `finish`, `complete`, `done` and `apply`. A wizard's Next button is never
 * called any of those, and a control that is called one of those is not what
 * this is looking for.
 */
export const NEXT_STEP_ACCEPT_RE = /\b(next|continue|proceed|forward|onward|step)\b/i;

/**
 * JOB-117. Walks a multi step application to the step that actually submits it,
 * filling every step on the way with the same ladder that filled the first.
 *
 * ── Why this is not a loop around `act("click next")` ────────────────────────
 * The interesting part of a wizard is not the clicking, it is that step two is a
 * real form. SmartRecruiters' "Preliminary questions" step has its own required
 * fields, its own dropdowns and its own attestations, and a run that pressed
 * Next and then went straight for Submit would file an application with a screen
 * full of empty required answers — or, worse, would be handed to ACT-008 as
 * though it were a filled form. So each new step goes through exactly what the
 * first step went through: `attachFormActionPlan` for the cached shape,
 * `fillRemainingFields` for the answers, `assertNoMismatches` for the read back,
 * and `blockedForAnswers` for anything the candidate has to answer themselves.
 * There is no second decision mechanism and no shortcut; the attestation ladder,
 * the EEO decline rule and HARD STOP 9 all apply to step two because it is the
 * same code path that applies them to step one.
 *
 * ── Why pressing Next cannot submit ─────────────────────────────────────────
 * Three things, in front of each other rather than beside each other:
 *
 *  1. `clickControl` runs `assertNotAnApplicationSubmit` on whatever `observe()`
 *     said about the control, before the click. A control that describes itself
 *     as the application's submit is refused and the run stops.
 *  2. `NEXT_STEP_ACCEPT_RE` then has to agree, independently, that the same
 *     description reads as a next-step control.
 *  3. `assertNotAlreadySubmitted` is asked about the page the click produced,
 *     before anything else is done to it. If Next turned out to submit after
 *     all, the run stops with `possible_unintended_submission` rather than
 *     carrying on and filling a confirmation page.
 *
 * `holdsSubmitControl` over in `form-fields.ts` is untouched by this and keeps
 * doing its own structural half of the same job on every field-level click.
 *
 * ── Why it is here and not in `submit-application.ts` ───────────────────────
 * That module's whole discipline is a bounded number of submissions:
 * `submitAttempted` set on the line before the click, `submitClicks` counted and
 * checked, no loop and no retry anywhere near either click site. Pressing Next
 * is not a submission and must not spend any of that budget, and the way to
 * guarantee it does not is to do it in the module that cannot submit at all
 * rather than to raise a cap. ACT-008 sees what it has always seen: a filled
 * form, and a `submitControlLabels` naming the control it may press once.
 *
 * Mutates `fields` and `needsInput` in place, for the same reason
 * `runBrowserFlow` hoists them: a run that stops on step two must still report
 * everything step one achieved. Returns the page read that ACT-008 will act on.
 */
async function advanceThroughWizard(
  supabase: SupabaseClient,
  session: BrowserSession,
  state: ApplicationState,
  input: FillApplicationFormInput,
  profile: ResumeProfile,
  current: FormSignals,
  fields: FieldOutcome[],
  needsInput: NeedsInputItem[],
  answerProvenance: AnswerProvenanceEntry[]
): Promise<FormSignals> {
  let signals = current;

  for (let advance = 1; advance <= MAX_WIZARD_ADVANCES; advance += 1) {
    // The form on screen holds the control ACT-008 needs. Nothing left to do,
    // and in particular nothing left to click.
    if (signals.submitApplicationControlLabels.length > 0) return signals;

    const wasAt = signals.url;
    const before = new Set(
      (await enumerateFormFields(session.page)).map((field) => field.selector)
    );

    // No submit control and no next control either. Not this module's failure to
    // report: ACT-008 already stops on an empty `submitControlLabels` and says
    // so with a screenshot and the page's own HTML, which is a better artifact
    // for a human than a second opinion invented here.
    const advanced = await clickControl(
      session,
      signals.url,
      "the control that advances this application to its next step",
      INSTRUCTIONS.NEXT_STEP,
      NEXT_STEP_ACCEPT_RE
    );
    if (advanced === null) {
      console.log(
        `${LOG} the form at "${signals.url}" shows neither a submit control nor a next-step ` +
          `control — leaving it as it stands`
      );
      return signals;
    }

    await awaitStableForm(session);
    signals = await readFormSignals(session);

    // Asked of the new page before anything else is, and before a single
    // character is typed into it. See rule 3 in this function's header.
    assertNotAlreadySubmitted(signals, `the application after pressing its next-step control`);
    assertNoCaptcha(signals, `the application's step ${advance + 1}`);
    await assertStillOnTheBoard(
      session,
      state,
      `having advanced to step ${advance + 1} of the application`
    );

    // Did the board actually move? Three independent readings, because a single
    // page wizard can advance without changing its URL, a board can change its
    // URL without re-rendering, and the shadow DOM ones do neither visibly.
    // `pageReadsAsFurtherStep` is JOB-106's rule, shared rather than re-stated,
    // so "this page is another step" means the same thing on both sides of the
    // submit click.
    const mounted = (await enumerateFormFields(session.page)).filter(
      (field) => !before.has(field.selector)
    );
    const movedOn =
      pageReadsAsFurtherStep(signals.title, signals.url, wasAt) ||
      !samePage(signals.url, wasAt) ||
      mounted.length > 0;
    if (!movedOn) {
      console.warn(
        `${LOG} pressed the next-step control at "${wasAt}" and the page did not change — ` +
          `not pressing it again`
      );
      return signals;
    }
    console.log(
      `${LOG} advanced to step ${advance + 1} of the application: "${signals.title}" at ` +
        `${signals.url} (${mounted.length} newly mounted control(s))`
    );

    // ── The same ladder that filled step one ────────────────────────────────
    // `fillRemainingFields` rather than `buildFieldPlan`/`fillFields`: the eight
    // named fields are the applicant's identity and they belong to the step that
    // asked for them, which was step one. A screening step asks questions, and
    // questions are exactly what the ACT-015 pass is for. It also skips anything
    // already holding a value, so a board that carries a field across steps does
    // not get it retyped.
    await attachFormActionPlan(supabase, session, signals.url);
    const step = await fillRemainingFields(
      session,
      state,
      profile,
      input.jobDescription ?? null,
      input.additionalAnswers ?? {}
    );
    fields.push(...step.outcomes);
    needsInput.push(...step.needsInput);
    answerProvenance.push(...step.answerProvenance);
    assertNoMismatches(fields, signals.url);
    if (needsInput.some((item) => item.required)) {
      throw blockedForAnswers(needsInput, signals.url);
    }

    // Everything above this line asks perception what it managed to read. This
    // asks the page how much there was to read, and refuses to call the step
    // filled when the two disagree. See `assertStepFullyRead` for the live run
    // that made it necessary.
    const pageRequired = await countRequiredQuestions(session.page);
    const readRequired = (await enumerateFormFields(session.page)).filter(
      (field) => field.required
    ).length;
    console.log(
      `${LOG} step ${advance + 1} required questions: ${pageRequired ?? "unreadable"} on the ` +
        `page, ${readRequired} read as fillable controls`
    );
    assertStepFullyRead(pageRequired, readRequired, advance + 1, signals.url);

    signals = await readFormSignals(session);
    assertNotAlreadySubmitted(signals, `step ${advance + 1} of the application, once filled`);
  }

  console.warn(
    `${LOG} still no submit control after ${MAX_WIZARD_ADVANCES} step(s) — handing the form on ` +
      `as it stands rather than pressing anything else`
  );
  return signals;
}

/**
 * JOB-006. Fingerprints the form on screen and hangs the stored plan for that
 * shape off the session.
 *
 * Never throws, and never leaves the session without a plan: a shape nobody has
 * filed yet produces an empty plan, which serves nothing and collects
 * everything this run observes. That is what turns the first application against
 * a new ATS layout into the one that pays for all the others.
 */
async function attachFormActionPlan(
  supabase: SupabaseClient,
  session: BrowserSession,
  url: string
): Promise<void> {
  try {
    const fields = await enumerateFormFields(session.page);
    const shape = fingerprintFormShape(detectAts(url), fields);
    console.log(
      `${LOG} form shape ${shape.ats}/${shape.fingerprint} from ${fields.length} control(s): ` +
        `${[...shape.slots].join(", ") || "no recognised boilerplate field"}`
    );
    session.actionPlan = await loadActionPlan(supabase, shape, CACHEABLE_INSTRUCTIONS, LOG);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG} could not attach a form action plan (observing instead): ${reason}`);
    session.actionPlan = null;
  }
}

/**
 * Drops the page-read the verification step carried back for the caller's reuse.
 * It is working state, not part of the report, and it would otherwise land in
 * the CLI's JSON output as a wall of extraction booleans.
 */
function verificationReport(
  outcome: VerificationOutcome
): FillApplicationFormResult["verification"] {
  const { signals: _signals, ...report } = outcome;
  return report;
}

function coverLetterReport(
  cover: { required: boolean; generated: boolean },
  coverLetter: string | null,
  fields: readonly FieldOutcome[]
): FillApplicationFormResult["coverLetter"] {
  const outcome = fields.find((field) => field.field === "coverLetter");
  return {
    ...cover,
    filled: outcome?.outcome === "filled",
    characters: coverLetter?.length ?? 0,
    detail: !cover.required
      ? "the listing does not require a cover letter, so none was written or attached"
      : (outcome?.detail ?? "generated, but the cover letter box was never reached"),
  };
}
