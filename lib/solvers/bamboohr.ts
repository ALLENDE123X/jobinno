/**
 * JOB-237 — the BambooHR solver bootstrap.
 *
 * Phase 5 of the per board solver architecture, the second entry of it (after
 * Recruitee, JOB-236). Unlike `lever.ts`, `greenhouse.ts`, `workable.ts` and
 * `recruitee.ts`, this file carries no board specific classifier of its own.
 * It is a deliberate stub: the same DOM fill and submit flow
 * `domFallbackSolver` already runs, given its own name and its own place in
 * the registry so that `lib/solvers/index.ts` has a real `bamboohr` entry to
 * point at once one is warranted, rather than staying `undefined` forever.
 *
 * ── Why no classifier patch ships with this file ────────────────────────────
 * Every other dedicated solver in this directory exists because a real,
 * captured failure on a real `applications` row named a specific mechanism to
 * fix — Lever's hidden hCaptcha submit button, Greenhouse's required field
 * gate, Workable's `/oops` redirect, Recruitee's missing phone calling code.
 * BambooHR has no such row yet: this ticket's own sourcing investigation
 * found `jobs` carried zero BambooHR listings before this change (see the
 * PR body for the full account), so there was nothing to diagnose a
 * BambooHR-specific failure from. Writing a speculative patch against a
 * mechanism nobody has actually observed would be guessing, not fixing —
 * exactly the trap this ticket's own instructions name directly: "Only add
 * BambooHR-specific classifier patches after the first live run reveals what
 * needs patching." This file is what a dedicated solver looks like before
 * that first live run, and it is meant to gain a classifier the same way
 * `recruitee.ts` did, once a real row exists to diagnose one from.
 *
 * Also worth naming: cross-session memory recorded on 2026-08-24 that
 * BambooHR's own apply form sits behind a reCAPTCHA v2 iframe challenge that
 * synthetic (non-human) clicks cannot solve, confirmed independently of this
 * ticket. Whatever a future BambooHR-specific patch turns out to fix, it is
 * unlikely to be able to fix that on its own — a captcha gate is a platform
 * level fact, not a per-listing one, and no amount of classifier logic reads
 * past it. That is one more reason not to guess at a patch here: the honest
 * next step, once real `applications` rows exist, is a live run that finds
 * out what actually blocks a BambooHR submission before writing code against
 * it.
 *
 * ── The one real circular import in this scaffolding ────────────────────────
 * Same cycle every other file in this directory documents, for the same
 * reason: `lib/submit-application.ts` imports `lookupSolver` from
 * `lib/solvers/index.ts`, `index.ts` imports `bamboohrSolver` from this file,
 * and this file imports the real (not type only) `gateName`/`runSubmitPhase`
 * back out of `lib/submit-application.ts`. `bamboohrSolver` is declared with
 * `function`, not a `const` arrow binding, for exactly the reason
 * `lever.ts`, `greenhouse.ts`, `workable.ts` and `recruitee.ts` already give:
 * a `const` initializer is not available until its own module finishes
 * evaluating, and whichever of these modules a given entry point resolves
 * first can otherwise reach `index.ts`'s object literal before this file's
 * own top level code has run, throwing `ReferenceError: Cannot access
 * 'bamboohrSolver' before initialization`. A function declaration is hoisted
 * and bound before any module's top level code runs at all, immune to that
 * ordering question. `lib/solvers/dom-fallback.ts`'s own `domFallbackSolver`
 * gets away with a `const` arrow only because nothing in `index.ts`'s object
 * literal ever names it; it is reached solely through the fallback default at
 * the router's own call site in `lib/submit-application.ts`, never through
 * this registry.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { fillApplicationFormRetainingSession } from "@/lib/fill-application-form";
import { closeBrowserSession } from "@/lib/stagehand-session";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";
import { gateName, runSubmitPhase } from "@/lib/submit-application";
import type { SolverContext, SolverInput, SolverResult } from "@/lib/solvers/types";

const LOG = "[job-237-bamboohr]";

// Same shape as the private helper of the same name in
// `lib/submit-application.ts`, `lib/solvers/dom-fallback.ts`,
// `lib/solvers/ashby-direct.ts`, `lib/solvers/lever.ts`,
// `lib/solvers/greenhouse.ts`, `lib/solvers/workable.ts` and
// `lib/solvers/recruitee.ts` — each module that needs a Supabase client keeps
// its own copy rather than reaching across files for a private function.
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

// A `function` declaration, not a `const` arrow binding assigned `: SolverFn`
// — see this module's own header for the full account of why.
export async function bamboohrSolver(
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

  // ── Phase 2: submit. The browser is live and on the filled form from here.
  // No BambooHR-specific read follows — see the module header for why.
  try {
    return await runSubmitPhase(supabase, session, input, jobApplicationId, row, fill);
  } finally {
    await closeBrowserSession(session);
  }
}
