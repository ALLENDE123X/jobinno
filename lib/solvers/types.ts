/**
 * JOB-232 — Phase 1 of the per-board solver architecture.
 *
 * A solver is anything that can take a filled-form job all the way to a
 * terminal `SubmitApplicationResult`, given the same input `submitApplication`
 * already accepts and the same preflighted row it already reads. This file
 * declares the shape of that seam and nothing else. `SolverInput` and
 * `SolverResult` are type aliases of `SubmitApplicationInput` and
 * `SubmitApplicationResult` from `lib/submit-application.ts`, not new shapes:
 * mirroring them with `import type` keeps the two definitions identical by
 * construction instead of by convention, so they cannot drift apart the way a
 * hand copied duplicate could.
 *
 * `SolverContext` is `PreflightRow`, also from `lib/submit-application.ts` —
 * the row `preflight()` already reads there before any solver is chosen. A
 * solver never re-reads it itself; it is handed the same row the router read.
 *
 * Every import here is `import type`, so this file adds no runtime
 * dependency on `lib/submit-application.ts` — only a type-checking one that
 * is erased by compilation. See `lib/solvers/dom-fallback.ts` for the one
 * file in this directory that does take a real, runtime dependency on it,
 * and why that is unavoidable given what it wraps.
 */

import type {
  PreflightRow,
  SubmitApplicationInput,
  SubmitApplicationResult,
} from "@/lib/submit-application";

/** Verbatim `SubmitApplicationInput` — see that type for every field's meaning. */
export type SolverInput = SubmitApplicationInput;

/** Verbatim `SubmitApplicationResult` — see that type for every field's meaning. */
export type SolverResult = SubmitApplicationResult;

/**
 * The row `submitApplication`'s `preflight()` already read, handed to a
 * solver so it never has to read it a second time. Verbatim `PreflightRow`.
 */
export type SolverContext = PreflightRow;

/**
 * The one shape every solver, dedicated or fallback, has to satisfy. Takes
 * the same input `submitApplication` was called with plus the row its own
 * preflight already read, and returns the same terminal result shape either
 * path has always returned. Never throws for anything short of a programming
 * error — the same rule `runSubmitPhase` documents for itself, inherited
 * here because a solver is what `runSubmitPhase` has become one instance of.
 */
export type SolverFn = (input: SolverInput, row: SolverContext) => Promise<SolverResult>;
