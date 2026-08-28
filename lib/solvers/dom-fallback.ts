/**
 * JOB-232 — the universal DOM fallback solver.
 *
 * Every ats without a dedicated solver in `lib/solvers/index.ts`'s registry
 * — and, today, a gated-off Ashby, since `lib/solvers/ashby-direct.ts`'s
 * `JOBINNO_ASHBY_SUBMIT_MODE` gate is off by default in prod — runs through
 * this file. Before this ticket, `submitApplication()` in
 * `lib/submit-application.ts` did this work itself, inline, after its own
 * `if (shouldRouteAshbyDirectHttp) ...` branch. This is that same code,
 * unchanged, moved behind the `SolverFn` seam so the router can pick it the
 * same way it picks a dedicated solver, with `(platform && lookupSolver(platform))
 * ?? domFallbackSolver`.
 *
 * It calls `fillApplicationFormRetainingSession()` (ACT-007) then
 * `runSubmitPhase()` (ACT-008's own submit phase, still defined and now
 * exported from `lib/submit-application.ts`) in the same order, on the same
 * live Browserbase session, with the same status writes — neither function's
 * own logic changed by this move. See `lib/submit-application.ts`'s header
 * for why the two compose the way they do, and for the two rules ("one
 * logical submission, ever" and "nothing after the click reads as
 * retryable") that call order exists to protect.
 *
 * ── The one real circular import in this scaffolding ────────────────────────
 * `lib/submit-application.ts` imports `domFallbackSolver` from this file, and
 * this file imports `gateName` and `runSubmitPhase` from
 * `lib/submit-application.ts`. That is unavoidable given what this file
 * wraps: `runSubmitPhase` has to keep living in `lib/submit-application.ts`
 * (moving it would be exactly the "modify submit-application.ts's internals"
 * this ticket rules out), and this solver has to call it. It is safe because
 * both are `function` declarations, not `const` arrow bindings — function
 * declarations are hoisted and bound before any module's top level code runs,
 * so the live binding this file imports is populated by the time
 * `domFallbackSolver` is ever actually called, regardless of which of the two
 * modules a given entry point happens to import first.
 * `lib/solvers/ashby-direct.ts` avoids this same cycle entirely by only ever
 * taking a type-only import from
 * `lib/submit-application.ts`; this file cannot, because it needs the real
 * function, not just its type.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { fillApplicationFormRetainingSession } from "@/lib/fill-application-form";
import { closeBrowserSession } from "@/lib/stagehand-session";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";
import { gateName, runSubmitPhase } from "@/lib/submit-application";
import type { SolverFn } from "@/lib/solvers/types";

const LOG = "[job-232-dom-fallback]";

// Same shape as the private helper of the same name in
// `lib/submit-application.ts` and `lib/solvers/ashby-direct.ts` — each module
// that needs a Supabase client keeps its own copy rather than reaching across
// files for a private function, matching the pattern JOB-214 already
// established.
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

export const domFallbackSolver: SolverFn = async (input, row) => {
  const jobApplicationId = input.jobApplicationId.trim();
  const supabase = getSupabaseClient();

  // ── Phase 1: fill. ACT-007 owns every guard, every status write and every
  // failure mode here; this module adds nothing to it and second-guesses none
  // of it. A throw propagates untouched (ACT-007 has already recorded
  // `form_fill_blocked` or `error` on the row), and no browser exists yet on
  // that path — `runBrowserFlow` closed it before rethrowing.
  const { result: fill, session } = await fillApplicationFormRetainingSession({
    jobApplicationId,
    requiresCoverLetter: input.requiresCoverLetter,
    // The caller's copy if it gave one, otherwise the listing's own, off the
    // row the router already preflighted. Never undefined: the fill layer
    // reads null as "no description available" and would read undefined the
    // same way, but only one of the two is a decision.
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
    // ACT-007 stopped for a human and closed its own browser. Nothing was
    // clicked here, and nothing here writes to the row: `form_fill_blocked`
    // and its `skip_log` row are already recorded and are the accurate
    // description.
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

  // ── Phase 2: submit. The browser is live and on the filled form from here.
  try {
    return await runSubmitPhase(supabase, session, input, jobApplicationId, row, fill);
  } finally {
    // Ours to close, whatever happened. `closeBrowserSession` never throws,
    // so this cannot replace a result or an error with a teardown failure.
    await closeBrowserSession(session);
  }
};
