/**
 * JOB-234 — the Greenhouse dedicated solver.
 *
 * Phase 3 of the per-board solver architecture. Its shape is deliberately
 * the same as `domFallbackSolver` and `leverSolver`: fill with
 * `fillApplicationFormRetainingSession` (ACT-007), then submit with
 * `runSubmitPhase` (ACT-008, still defined in `lib/submit-application.ts`),
 * on the same live Browserbase session, in the same order. Nothing about
 * either of those two functions changes here. See `dom-fallback.ts`'s header
 * for why that call order exists and `lever.ts`'s header for the second
 * worked example of a dedicated solver built on top of it.
 *
 * ── The diagnosis (JOB-234) ─────────────────────────────────────────────────
 * Five `applications` rows sit at `submission_unconfirmed` for a Greenhouse
 * board, all created 2026 08 22, all Virtu Financial, PDT Partners or
 * Anduril Industries. Unlike Lever's six rows in JOB-233, these five do not
 * share one signature. Read individually, by `applications.id`:
 *
 *   2ec2cf69 (Virtu, Software Engineer Java) — four skip_log rows across
 *     retries: a `needs_attestation` for a UK sponsorship question with no
 *     stored answer and no decline option (working as intended, not a bug);
 *     a `submit_failed` because the board asked for an emailed security code
 *     and `GOOGLE_OAUTH_CLIENT_ID` was not set (an environment gap, not a
 *     Greenhouse bug); and an `internal_error` because the resume upload
 *     control read back as "cover_letter | Attach | Attach" and the fill
 *     correctly refused to upload into an unidentified control. None of
 *     these three is something a post submit DOM read can fix — they are a
 *     legitimate stop, a missing credential, and a resume upload heuristic
 *     bug in a different part of the fill path. Left alone here; the resume
 *     upload heuristic is worth its own ticket.
 *
 *   6e735684 (Virtu, 2027 Internship) and 959f884e (Virtu, 2027 Internship,
 *     a second run) — both `submit_failed`, both read "Submit application"
 *     was clicked and the form stayed on screen with the board's own
 *     validation text visible: "This field is required." and "Please enter
 *     your location; This field is required." The captured page HTML for
 *     both (still on disk under `lib/.submission-screenshots/`) shows the
 *     same shape: a `label` carrying `select__label--error`, its paired
 *     `select__control--error`, and a `helper-text--error` with the literal
 *     validation copy, on Greenhouse's own react-select combobox widget.
 *     959f884e has two such fields (Location (City), and a university
 *     picker); 6e735684 has one (expected graduation year). This is the
 *     shape `probeGreenhouseRequiredFieldGate` below reads.
 *
 *   e3bd87c4 (PDT Partners) and 58ba500a (Anduril) — both `internal_error`,
 *     both read back several fields as something other than what was typed:
 *     degree, work authorization, sponsorship, an export controls question,
 *     a "how did you hear about us" picker. This is the exact symptom
 *     issue #93 names.
 *
 * ── Issue #93's status ───────────────────────────────────────────────────────
 * Already fixed, before this ticket started. `lib/form-fields.ts`'s
 * `highlightOption` carries its own dated account of the same bug: every one
 * of the react-select widgets Greenhouse draws its dropdowns with opens with
 * its first option already highlighted, so the old "press ArrowDown index
 * plus one times" convention chose the option one past the one it meant to
 * — degree "Bachelor's Degree" became "Certification", and so on. That fix
 * (reading the real highlighted option and steering to it, refusing to
 * commit anything it cannot confirm) landed in the "v1 launch" merge,
 * commit 4f2d76c, 2026 08 25 — three days after e3bd87c4 and 58ba500a were
 * created. Both rows are stale, pre fix evidence, not a live gap. Nothing in
 * this file re implements that fix or duplicates it: it already lives in
 * shared code every board's fill already goes through, so Greenhouse gets
 * it for free.
 *
 * ── What this file adds instead ─────────────────────────────────────────────
 * A Greenhouse specific read of the page immediately after `runSubmitPhase`
 * returns and before the session closes, for the one symptom that survives:
 * a required react-select field that the fill wrote something into, but
 * that Greenhouse's own client side check never counted as an answer.
 * `runSubmitPhase`'s generic classifier already captures the validation
 * text verbatim in its message, which is honest but not diagnostic — it
 * cannot say *which* field, or that every occurrence so far is the same
 * kind of widget. This solver names the field labels directly off the DOM
 * and, only when at least one is found, writes a second, more specific
 * `skip_log` row alongside the one `runSubmitPhase` already wrote — the
 * same append only pattern `leverSolver` uses and for the same reason
 * (`recordSkip`'s own docstring: there is no update path here, because
 * overwriting the previous row would erase the history). `applications.status`
 * is left exactly as `runSubmitPhase` wrote it: still `submission_unconfirmed`,
 * still terminal, still never retried.
 *
 * The widget these two rows show (a typed search that asks a server for
 * matching results, per the "type to refine list" guidance text captured in
 * both HTML snapshots) is not the same one issue #93's fix covers. That fix
 * steers a menu that already lists every option; this one has to type a
 * query and wait for the server to answer before anything can be chosen at
 * all. Whatever broke here broke earlier, in how the fill commits a choice
 * out of that search flow, not in menu positioning. That is a fill time
 * question and belongs in `lib/fill-application-form.ts` or
 * `lib/form-fields.ts`, not in a solver file that is not supposed to touch
 * either — see this file's own scope below. What ships here is an accurate,
 * field named diagnosis in place of the generic hedge, so the next person
 * who picks this up starts from a fact instead of a guess. That next ticket
 * is filed: issue #246 tracks the actual fill time fix.
 *
 * ── Why DOM, not direct HTTP ─────────────────────────────────────────────────
 * The ticket authorizes a direct HTTP solver, on the Ashby model, only if
 * diagnosis shows the DOM path is fundamentally blocked. It is not: the fill
 * completed cleanly on four of the five rows above (the fifth, 2ec2cf69,
 * stopped for a legitimate attestation gate before submission was ever
 * attempted), and Greenhouse's own submit control was reached and clicked on
 * every row that got that far. What is failing is one narrow step inside
 * the fill (committing a value out of an async search combobox), not
 * navigation, not the submit click, and not Greenhouse's page structure
 * rejecting this pipeline outright. A direct HTTP solver would still have to
 * solve the exact same "what value does this field actually hold" question,
 * just against Greenhouse's private JSON endpoint instead of its DOM, for no
 * clear reduction in the actual gap. DOM is the right answer here.
 *
 * ── The one real circular import ─────────────────────────────────────────────
 * Same cycle `lever.ts`'s header documents in detail, for the same reason:
 * `submit-application.ts` imports `lookupSolver` from `solvers/index.ts`,
 * `index.ts` imports `greenhouseSolver` from this file, and this file
 * imports the real (not type only) `gateName`/`runSubmitPhase` back out of
 * `submit-application.ts`. `greenhouseSolver` is declared with `function`,
 * not a `const` arrow binding, for exactly the reason `lever.ts` and
 * `dom-fallback.ts` already give: a `const` initializer is not available
 * until its own module finishes evaluating, and whichever of the three
 * modules a given entry point resolves first can otherwise reach
 * `index.ts`'s object literal before this file's own top level code has
 * run, throwing `ReferenceError: Cannot access 'greenhouseSolver' before
 * initialization`. A function declaration is hoisted and bound before any
 * module's top level code runs at all, immune to that ordering question.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type Page } from "@browserbasehq/stagehand";

import { recordSkipQuietly } from "@/lib/application-records";
import { APPLICATION_STATUS } from "@/lib/application-status";
import { type SkipReason } from "@/lib/db/schema";
import { fillApplicationFormRetainingSession } from "@/lib/fill-application-form";
import { closeBrowserSession } from "@/lib/stagehand-session";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";
import { gateName, runSubmitPhase } from "@/lib/submit-application";
import type { SolverContext, SolverInput, SolverResult } from "@/lib/solvers/types";

const LOG = "[job-234-greenhouse]";

// Same shape as the private helper of the same name in
// `lib/submit-application.ts`, `lib/solvers/ashby-direct.ts`,
// `lib/solvers/dom-fallback.ts` and `lib/solvers/lever.ts` — each module
// that needs a Supabase client keeps its own copy rather than reaching
// across files for a private function.
function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required (see .env.example)"
    );
  }
  assertSupabaseProject(url);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ───────────────────────────────────
// The required react-select field probe
// ───────────────────────────────────

/**
 * What the DOM says about Greenhouse's own required field validation, read
 * as plain values rather than as page text — a shape, not a sentence, so
 * nothing here is a text pattern to keep in sync with a validation message
 * that could read differently for a different field or a different locale.
 */
export type GreenhouseRequiredFieldGateProbe = {
  /**
   * Every required react-select field Greenhouse's own validation currently
   * marks as empty, in document order. Empty when the probe found none —
   * the "nothing to see here" outcome, same as a page that was never gated
   * at all.
   */
  emptyRequiredFields: ReadonlyArray<{
    /** The field's own label text, with the required-marker asterisk stripped. */
    label: string;
    /** The label's `for` attribute — the id of the control it names — or null. */
    controlId: string | null;
  }>;
};

// A string expression, not a function passed to `page.evaluate()` — the
// same reason `LEVER_HCAPTCHA_GATE_SCRIPT` in `lib/solvers/lever.ts` is one:
// an arrow function this file's callbacks would otherwise be compiled
// through tsx first, which wraps it in an `__name(fn, "name")` call that
// does not exist in the page's own global scope and throws `ReferenceError`
// on the first evaluated line. See the comment on the Ashby reCAPTCHA patch
// in `lib/submit-application.ts` for the fuller account of why.
const GREENHOUSE_REQUIRED_FIELD_GATE_SCRIPT = `(() => {
  const labels = Array.from(document.querySelectorAll('[class*="select__label--error"]'));
  const fields = labels.map((label) => {
    const clone = label.cloneNode(true);
    const marker = clone.querySelector('[aria-hidden="true"]');
    if (marker) marker.remove();
    const text = (clone.textContent || '').trim();
    const controlId = label.getAttribute('for');
    return { label: text, controlId: controlId || null };
  });
  return { emptyRequiredFields: fields };
})()`;

function isGreenhouseRequiredFieldGateProbe(
  value: unknown
): value is GreenhouseRequiredFieldGateProbe {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.emptyRequiredFields)) return false;
  return v.emptyRequiredFields.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return typeof e.label === "string" && (typeof e.controlId === "string" || e.controlId === null);
  });
}

/**
 * Reads the gate's shape off the live page. Never throws — a page that has
 * navigated away, closed, or simply carries none of these elements reads as
 * `null`, the same "nothing to see here" outcome as a page that was never
 * gated in the first place. Nothing downstream distinguishes those two
 * cases, because nothing needs to: either way, this probe found no evidence
 * and the caller falls back to the message `runSubmitPhase` already wrote.
 */
async function probeGreenhouseRequiredFieldGate(
  page: Page
): Promise<GreenhouseRequiredFieldGateProbe | null> {
  return page.evaluate(GREENHOUSE_REQUIRED_FIELD_GATE_SCRIPT).then(
    (value) => (isGreenhouseRequiredFieldGateProbe(value) ? value : null),
    () => null
  );
}

/**
 * Whether the probe found at least one required field Greenhouse's own
 * validation is still calling empty.
 *
 * Pure and exported so this is pinned by fixtures rather than only by a
 * live board — the same pattern `leverHcaptchaGateBlocked` and
 * `boardRejectedAsAutomated` use elsewhere in this codebase for exactly
 * this reason. Unlike Lever's hCaptcha gate, this needs no multi signal
 * agreement: the class Greenhouse's own template adds to a label
 * (`select__label--error`) only appears once its own client side check has
 * actually run and actually found the field empty, so its mere presence
 * already is the fact, not weak evidence for one.
 */
export function greenhouseRequiredFieldsGateBlocked(
  probe: GreenhouseRequiredFieldGateProbe
): boolean {
  return probe.emptyRequiredFields.length > 0;
}

/**
 * The sentence a human reads in `skip_log.raw_context.message`. Names the
 * specific field labels rather than repeating `runSubmitPhase`'s own hedge
 * ("most likely rejected... validation, or an anti bot check"), because
 * this row exists specifically to replace a guess with a fact once one is
 * available: which named fields Greenhouse's own validation marked empty
 * at submit time. It stops there deliberately. The probe's only signal is
 * the `select__label--error` class, and react-select puts that same class
 * on every required combobox variant alike, fixed option list and async
 * search alike, so this message never claims which widget flow is behind
 * a given field. Saying more than the probe can actually tell would risk
 * misreading a real regression of issue #93 as something else entirely.
 * Establishing which widget variant is at fault, field by field, and fixing
 * the fill time commit bug behind it, is issue #246's job, not this one's.
 */
export function describeGreenhouseRequiredFieldsGate(
  probe: GreenhouseRequiredFieldGateProbe,
  finalUrl: string
): string {
  const count = probe.emptyRequiredFields.length;
  const names = probe.emptyRequiredFields
    .map((field) => field.label || "an unlabeled field")
    .join(", ");
  const plural = count === 1 ? "field" : "fields";
  const pronoun = count === 1 ? "it" : "them";
  return (
    `Greenhouse's own client side validation blocked this submission. It was not a bot check, ` +
    `and it is not the generic guess the reading above already made. ${count} required ${plural} ` +
    `still read as empty at "${finalUrl}" after the click: ${names}. Greenhouse's own validation ` +
    `marked ${pronoun} as empty at submit time; that reading is a fact, not a guess, but nothing ` +
    `here identifies which kind of dropdown widget is behind ${pronoun}. Whether the fill wrote ` +
    `anything into ${pronoun}, and if so what became of that write, is not something this probe ` +
    `can see. That is where the probe's own reach ends: it can see that the ` +
    `client side check still called ${pronoun} empty right then, and it says nothing about whether ` +
    `a request ever reached Greenhouse's server, whether a value was written and failed to commit, ` +
    `or whether nothing was ever written at all. This row stays submission unconfirmed for exactly ` +
    `that reason: the click happened and what became of it past that point is not known. See issue ` +
    `#246 for the tracked follow up that will fix how these fields commit their value during fill. ` +
    `A person should check whether the candidate's stored data actually answers ${pronoun} and ` +
    `should treat this row as unresolved, not as a confirmed non submission, before deciding ` +
    `whether and how to proceed by hand. Nothing here is retried automatically.`
  );
}

const GREENHOUSE_REQUIRED_FIELD_REASON: SkipReason = "internal_error";

// A `function` declaration, not a `const` arrow binding assigned `: SolverFn`
// — see this module's own header for the full account of why.
export async function greenhouseSolver(
  input: SolverInput,
  row: SolverContext
): Promise<SolverResult> {
  const jobApplicationId = input.jobApplicationId.trim();
  const supabase = getSupabaseClient();

  // ── Phase 1: fill. Unchanged from `domFallbackSolver` — see that file's
  // header for why ACT-007 owns every guard and status write here.
  const { result: fill, session } = await fillApplicationFormRetainingSession({
    jobApplicationId,
    requiresCoverLetter: input.requiresCoverLetter,
    jobDescription: input.jobDescription ?? row.jobDescription,
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.additionalAnswers === undefined
      ? {}
      : { additionalAnswers: input.additionalAnswers }),
    ...(input.headless === undefined ? {} : { headless: input.headless }),
    ...(input.fillScreenshotDir === undefined
      ? {}
      : { screenshotDir: input.fillScreenshotDir }),
  });

  if (fill.blockedReason !== null || session === null) {
    if (session !== null) await closeBrowserSession(session);
    console.warn(`${LOG} the fill did not complete — nothing to submit. Not clicking anything.`);
    return {
      jobApplicationId,
      status: fill.status,
      submitted: false,
      submitAttempted: false,
      confirmationRef: null,
      confirmation: null,
      securityCode: null,
      approval: { approved: false, gate: gateName(input), detail: "never reached — the fill stopped first" },
      submitControlLabel: null,
      fill,
      finalUrl: fill.finalUrl,
      pageTitle: fill.pageTitle,
      screenshotPath: fill.screenshotPath,
      blockedReason:
        fill.blockedReason ??
        "the form fill returned no live browser session, so there was nothing to submit",
      unconfirmedReason: null,
      rowUpdated: false,
    };
  }

  // ── Phase 2: submit, then the Greenhouse specific read. The browser is
  // live and on the filled form from here, and stays live until this
  // function's own `finally` closes it — after the probe below has had its
  // one chance to run.
  try {
    const result = await runSubmitPhase(supabase, session, input, jobApplicationId, row, fill);

    // Only worth a look when `runSubmitPhase` could not confirm anything: a
    // genuine `submitted` result has nothing for this to add to, and a
    // pre-click `blocked()` result never reached a state Greenhouse's own
    // validation could have had any bearing on.
    if (!result.submitted && result.status === APPLICATION_STATUS.SUBMISSION_UNCONFIRMED) {
      const probe = await probeGreenhouseRequiredFieldGate(session.page);
      if (probe !== null && greenhouseRequiredFieldsGateBlocked(probe)) {
        console.warn(
          `${LOG} Greenhouse's own required field validation is still blocking ${jobApplicationId} — ` +
            `writing a supplementary internal_error skip_log row alongside the generic one ` +
            `runSubmitPhase already wrote.`
        );
        await recordSkipQuietly(
          supabase,
          {
            applicationId: jobApplicationId,
            jobId: row.jobId,
            ats: row.ats,
            reason: GREENHOUSE_REQUIRED_FIELD_REASON,
            message: describeGreenhouseRequiredFieldsGate(probe, result.finalUrl),
            browserbaseSessionId: session.browser.sessionId ?? null,
          },
          LOG
        );
        return {
          ...result,
          unconfirmedReason:
            result.unconfirmedReason === null
              ? describeGreenhouseRequiredFieldsGate(probe, result.finalUrl)
              : `${result.unconfirmedReason} Greenhouse's required field check also confirmed: ${describeGreenhouseRequiredFieldsGate(probe, result.finalUrl)}`,
        };
      }
    }

    return result;
  } finally {
    await closeBrowserSession(session);
  }
}
