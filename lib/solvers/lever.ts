/**
 * JOB-233 — the Lever dedicated solver.
 *
 * Phase 1 (JOB-232) scaffolded `lib/solvers/` and left every ats but Ashby
 * routed through `domFallbackSolver`. This is the second dedicated solver,
 * and its shape is deliberately the same as `domFallbackSolver`'s: fill with
 * `fillApplicationFormRetainingSession` (ACT-007), then submit with
 * `runSubmitPhase` (ACT-008, still defined in `lib/submit-application.ts`),
 * on the same live Browserbase session, in the same order, for the same two
 * reasons that order exists — see `dom-fallback.ts`'s header. Nothing about
 * either of those two functions changes here.
 *
 * ── What this file adds ─────────────────────────────────────────────────────
 * A Lever-specific read of the page immediately after `runSubmitPhase`
 * returns and before the session closes, for exactly one purpose: telling a
 * human WHY a Lever submission stalled, when the reason is a fact about
 * Lever's own template and not a fact this pipeline could have read from page
 * text.
 *
 * ── The diagnosis (JOB-233) ─────────────────────────────────────────────────
 * Six `applications` rows sat at `submission_unconfirmed` with
 * `skip_log.reason='submit_failed'` — three Palantir listings, two Belvedere
 * Trading, one Basis. All six carry the identical message shape from
 * `runSubmitPhase`'s ACT-017 branch: "SUBMIT APPLICATION was clicked, but the
 * application form is still on screen ... with no confirmation of any kind."
 *
 * Re-reading each row's captured HTML (`lib/.submission-screenshots/`) turned
 * up the same three elements on all five captures that still exist locally,
 * across all three employers and across dates from 2026-08-22 to 2026-08-25:
 *
 *   <button id="btn-submit" type="button" ...>SUBMIT APPLICATION</button>
 *   <button id="hcaptchaSubmitBtn" type="submit" class="hidden">
 *   <div class="h-captcha" data-sitekey="e33f87f8-88ec-4e1a-9a13-df9bbb1d8120">
 *   <input name="h-captcha-response" value="">
 *
 * The visible control this pipeline clicks is `type="button"` — clicking it
 * submits nothing. Lever's real submit path is the hidden `#hcaptchaSubmitBtn`,
 * `type="submit"`, reachable only once hCaptcha's own script writes a token
 * into `h-captcha-response`. That input is empty in every one of the six
 * captures. No token, no POST, nothing for Lever's board to accept or reject
 * — which is exactly why the page shows no confirmation, no navigation and no
 * validation text: the board never received anything at all. This is the
 * same sitekey on all three employers, so it is a fact about Lever's hosted
 * apply form, not about any one listing.
 *
 * This mechanism was independently found and documented by issue #122, using
 * application row `b20ecb27-6f69-4d37-887b-2827b83abdd2` — one of these same
 * six rows — as its evidence. What is added here is that the other five rows
 * carry the identical fingerprint, so the fix generalises to every Lever
 * listing rather than to one employer.
 *
 * ── Why this could not be a text-pattern fix ────────────────────────────────
 * `boardRejectedAsAutomated` and every other regex in `submit-application.ts`
 * reads page *text*. Lever's hCaptcha gate produces none: no error banner, no
 * validation copy, nothing any pattern could ever match, because nothing was
 * ever sent to Lever's servers for Lever to write a rejection about. The gap
 * was never a missing pattern — it was that nothing in the pipeline inspected
 * the DOM itself for this gate's shape, which is visible without needing any
 * text to describe it.
 *
 * `runSubmitPhase`'s own `unconfirmed()` helper hardcodes its skip reason as
 * `bot_detected` or `submit_failed` and says explicitly why the shared,
 * ordered classifier in `lib/application-records.ts` is the wrong tool for
 * choosing between them there (a board's own validation copy could contain
 * the word "captcha" and get misfiled). That reasoning holds, and this file
 * does not touch it or the rest of `runSubmitPhase`'s internals. Instead this
 * solver reads the DOM itself, once, right after `runSubmitPhase` returns and
 * before `closeBrowserSession` runs, and — only when the gate's exact shape is
 * present — appends a second, accurate `skip_log` row alongside the one
 * `runSubmitPhase` already wrote for the same click. `skip_log` is append-only
 * by design (see `recordSkip`'s own docstring: "there is no update path...
 * overwriting the previous one would erase the history"), so this supplements
 * rather than rewrites what `runSubmitPhase` recorded; the message says so
 * explicitly. `applications.status` is left exactly as `runSubmitPhase` wrote
 * it — still `submission_unconfirmed`, still terminal, still never retried.
 *
 * ── Why a post-click read rather than a pre-click refusal ──────────────────
 * The hCaptcha container is present on every Lever apply page load, whether
 * or not it ends up blocking a given session — a real applicant's own click
 * on `#btn-submit` is presumably what triggers Lever's own JS to call
 * `hcaptcha.execute()` in the first place, so a static, pre-click check
 * cannot tell "present" apart from "actually blocking us." Reading the
 * response token's state after the click — which by then has had several
 * real seconds to resolve, since `runSubmitPhase`'s own `readConfirmation()`
 * runs an LLM extract call plus several page evaluations before this solver
 * ever gets control back — is an honest read of whether hCaptcha's own
 * invisible check let this session through on its own merits. That is
 * exactly the "let hCaptcha reach its own verdict" line issue #122 draws.
 * Nothing in this file attempts to solve, farm, or influence the challenge.
 *
 * ── The three absorbed sub-tickets ──────────────────────────────────────────
 *  · #122 (invisible hCaptcha gate) is what this file's `probeLeverHcaptchaGate`
 *    / `leverHcaptchaGateBlocked` / `describeLeverHcaptchaGate` exist for.
 *    Escalated to `verification_required`, per the ticket's explicit
 *    instruction not to attempt solving it.
 *  · #81 (location-autocomplete label garbled) and #94's Lever half (the same
 *    bug, filed twice — Lever's custom-question cards concatenating hidden
 *    autocomplete status text into the visible label) needed no code here.
 *    `lib/form-fields.ts`'s `visibleText()` already fixed this, citing #81 by
 *    number, landed in the "v1 launch" merge (2026-08-25) — well before this
 *    ticket, and none of the six rows above show any garbled-label artifact
 *    in their `skip_log` messages. #94's other half (Workable's consent
 *    clause read as free text) is a Workable bug, untouched here.
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

const LOG = "[job-233-lever]";

// Same shape as the private helper of the same name in
// `lib/submit-application.ts`, `lib/solvers/ashby-direct.ts` and
// `lib/solvers/dom-fallback.ts` — each module that needs a Supabase client
// keeps its own copy rather than reaching across files for a private
// function.
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
// #122 — the hCaptcha gate probe
// ───────────────────────────────────

/**
 * What the DOM says about Lever's hCaptcha gate, read as plain values rather
 * than as page text — this is a shape, not a sentence, so nothing here is a
 * text pattern to keep in sync with a rejection message.
 */
export type LeverHcaptchaGateProbe = {
  /** Whether `#hcaptchaSubmitBtn` — Lever's real, hidden submit control — exists. */
  hiddenSubmitPresent: boolean;
  /** That element's own `type` attribute, or null when it is not present. */
  hiddenSubmitType: string | null;
  /** Whether `input[name="h-captcha-response"]` exists on the page. */
  responseTokenPresent: boolean;
  /** That input's `value`, or null when the input is not present. */
  responseTokenValue: string | null;
  /** The `data-sitekey` of the first `[data-sitekey]` element found, if any. */
  sitekey: string | null;
  /** `#btn-submit`'s own `type` attribute — Lever's visible control. */
  visibleSubmitType: string | null;
};

// A string expression, not a function passed to `page.evaluate()`. Every
// arrow function this file's callbacks would otherwise be compiled through
// tsx first, which wraps them in an `__name(fn, "name")` call that does not
// exist in the page's own global scope and throws `ReferenceError` on the
// first evaluated line — see the comment on the Ashby reCAPTCHA patch in
// `lib/submit-application.ts` for the fuller account of why. A plain string
// expression sidesteps the whole problem, the same way `PAGE_TEXT_SCRIPT` and
// `BODY_INNER_HTML_SCRIPT` do in that file.
const LEVER_HCAPTCHA_GATE_SCRIPT = `(() => {
  const hidden = document.querySelector('#hcaptchaSubmitBtn');
  const response = document.querySelector('input[name="h-captcha-response"]');
  const sitekeyEl = document.querySelector('[data-sitekey]');
  const visible = document.querySelector('#btn-submit');
  return {
    hiddenSubmitPresent: hidden !== null,
    hiddenSubmitType: hidden ? hidden.getAttribute('type') : null,
    responseTokenPresent: response !== null,
    responseTokenValue: response ? response.value : null,
    sitekey: sitekeyEl ? sitekeyEl.getAttribute('data-sitekey') : null,
    visibleSubmitType: visible ? visible.getAttribute('type') : null,
  };
})()`;

function isLeverHcaptchaGateProbe(value: unknown): value is LeverHcaptchaGateProbe {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.hiddenSubmitPresent === "boolean" &&
    (typeof v.hiddenSubmitType === "string" || v.hiddenSubmitType === null) &&
    typeof v.responseTokenPresent === "boolean" &&
    (typeof v.responseTokenValue === "string" || v.responseTokenValue === null) &&
    (typeof v.sitekey === "string" || v.sitekey === null) &&
    (typeof v.visibleSubmitType === "string" || v.visibleSubmitType === null)
  );
}

/**
 * Reads the gate's shape off the live page. Never throws — a page that has
 * navigated away, closed, or simply does not have any of these elements reads
 * as `null`, the same "nothing to see here" outcome as a page that was never
 * gated in the first place. Nothing downstream distinguishes those two cases,
 * because nothing needs to: either way, this probe found no evidence and the
 * caller falls back to the message `runSubmitPhase` already wrote.
 */
async function probeLeverHcaptchaGate(page: Page): Promise<LeverHcaptchaGateProbe | null> {
  return page.evaluate(LEVER_HCAPTCHA_GATE_SCRIPT).then(
    (value) => (isLeverHcaptchaGateProbe(value) ? value : null),
    () => null
  );
}

/**
 * Whether the probe's shape is Lever's hCaptcha gate having withheld a token.
 *
 * Pure and exported so this is pinned by fixtures rather than only by a live
 * board — the same pattern `boardRejectedAsAutomated` and
 * `pageReadsAsFurtherStep` use elsewhere in this codebase for exactly this
 * reason.
 *
 * Two signals have to agree, the same "not either alone" rule
 * `runSubmitPhase` applies to its own security-code check: the real submit
 * control has to actually exist and actually be the `submit` type Lever wires
 * up (not just any element happening to share the id), and the token field
 * it depends on has to exist and be empty. Either alone is weaker evidence —
 * a hidden submit button with a *populated* token means hCaptcha succeeded
 * and something else is the real story; an empty token with no hidden submit
 * button in sight means this was never Lever's template to begin with.
 */
export function leverHcaptchaGateBlocked(probe: LeverHcaptchaGateProbe): boolean {
  return (
    probe.hiddenSubmitPresent &&
    probe.hiddenSubmitType === "submit" &&
    probe.responseTokenPresent &&
    (probe.responseTokenValue ?? "").trim() === ""
  );
}

/**
 * The sentence a human reads in `skip_log.raw_context.message`. Names the
 * mechanism rather than repeating `runSubmitPhase`'s own hedge ("most likely
 * rejected... validation, or an anti-bot check"), because this row exists
 * specifically to replace a guess with a fact once one is available.
 */
export function describeLeverHcaptchaGate(
  probe: LeverHcaptchaGateProbe,
  finalUrl: string
): string {
  return (
    `Lever's own hCaptcha gate withheld this submission — not the board's validation and ` +
    `not a bot rejection with words to match, which is why the generic submit-phase reading ` +
    `above could only guess. The control this pipeline can see and click is a decoy ` +
    `(#btn-submit${probe.visibleSubmitType ? `, type="${probe.visibleSubmitType}"` : ""}); ` +
    `Lever's real submit path is a hidden #hcaptchaSubmitBtn (type=` +
    `${probe.hiddenSubmitType ? `"${probe.hiddenSubmitType}"` : "unknown"}) that only fires ` +
    `once hCaptcha${probe.sitekey ? ` (sitekey ${probe.sitekey})` : ""} writes a token into ` +
    `input[name="h-captcha-response"]. That input was still empty at "${finalUrl}" after the ` +
    `click, so nothing was ever posted to Lever — there was nothing for the board to accept or ` +
    `reject. See issue #122 for the forensic trail that first established this mechanism. ` +
    `Nothing here attempted to solve, farm or influence the challenge: a human should decide ` +
    `whether and how to proceed, and this row is not retried automatically.`
  );
}

const LEVER_VERIFICATION_REQUIRED_REASON: SkipReason = "verification_required";

// A `function` declaration, not a `const` arrow binding assigned `: SolverFn`
// — this is the same fix `dom-fallback.ts`'s header documents for `gateName`
// and `runSubmitPhase`, needed here for the same reason and by the same
// mechanism. `lib/solvers/index.ts` imports `leverSolver` and reads it at its
// own module top level (`const solvers = { ..., lever: leverSolver, ... }`),
// and `lib/submit-application.ts` imports `lookupSolver` from
// `lib/solvers/index.ts` — so the real, non-type-only import of
// `runSubmitPhase`/`gateName` a few lines up makes this file, `index.ts` and
// `submit-application.ts` a three-file cycle. A `const` initializer is not
// available until its own module has finished evaluating, so whichever of
// the three modules a given entry point resolves first can reach `index.ts`'s
// object literal before this file's `const leverSolver = async (...) => {}`
// has run, and throw `ReferenceError: Cannot access 'leverSolver' before
// initialization` — reproduced with `lookupSolver("lever")` before this fix.
// A function declaration is hoisted and bound before any module's top level
// code runs at all, immune to the ordering question entirely, which is
// exactly why `gateName` and `runSubmitPhase` are declared the same way on
// the other side of this same cycle.
export async function leverSolver(input: SolverInput, row: SolverContext): Promise<SolverResult> {
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

  // ── Phase 2: submit, then the Lever-specific read. The browser is live and
  // on the filled form from here, and stays live until this function's own
  // `finally` closes it — after the probe below has had its one chance to run.
  try {
    const result = await runSubmitPhase(supabase, session, input, jobApplicationId, row, fill);

    // Only worth a look when `runSubmitPhase` could not confirm anything: a
    // genuine `submitted` result has nothing for this to add to, and a
    // pre-click `blocked()` result never reached a state hCaptcha could have
    // had any bearing on.
    if (!result.submitted && result.status === APPLICATION_STATUS.SUBMISSION_UNCONFIRMED) {
      const probe = await probeLeverHcaptchaGate(session.page);
      if (probe !== null && leverHcaptchaGateBlocked(probe)) {
        console.warn(
          `${LOG} Lever's hCaptcha gate withheld a token for ${jobApplicationId} — writing a ` +
            `supplementary verification_required skip_log row alongside the generic one ` +
            `runSubmitPhase already wrote.`
        );
        await recordSkipQuietly(
          supabase,
          {
            applicationId: jobApplicationId,
            jobId: row.jobId,
            ats: row.ats,
            reason: LEVER_VERIFICATION_REQUIRED_REASON,
            message: describeLeverHcaptchaGate(probe, result.finalUrl),
            browserbaseSessionId: session.browser.sessionId ?? null,
          },
          LOG
        );
        return {
          ...result,
          unconfirmedReason:
            result.unconfirmedReason === null
              ? describeLeverHcaptchaGate(probe, result.finalUrl)
              : `${result.unconfirmedReason} Lever's hCaptcha gate also confirmed: ${describeLeverHcaptchaGate(probe, result.finalUrl)}`,
        };
      }
    }

    return result;
  } finally {
    await closeBrowserSession(session);
  }
}
