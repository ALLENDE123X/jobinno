/**
 * JOB-232 — the per-board solver registry.
 *
 * One dedicated solver per ats platform that has one, keyed by
 * `AtsPlatform`. Every platform without an entry here — and, today, a
 * registered entry whose own gate is closed — falls through to
 * `domFallbackSolver` at the call site in `lib/submit-application.ts`:
 * `const solver = lookupSolver(row.ats) ?? domFallbackSolver`.
 *
 * Adding the next dedicated solver (Greenhouse, Lever, ...) is meant to be
 * one new file under `lib/solvers/` plus one line in `solvers` below — no
 * other file changes, and nothing in `lib/submit-application.ts` has to move
 * again.
 *
 * ── The Ashby gate ───────────────────────────────────────────────────────────
 * JOB-214's Ashby direct HTTP path is still off by default in prod, behind
 * `JOBINNO_ASHBY_SUBMIT_MODE=direct-http`. Before this ticket that gate was a
 * plain `if` at the top of `submitApplication()`, checked before the fill was
 * ever called. It has moved here, into `lookupSolver`, rather than into
 * `ashbyDirectSolver` itself: a solver that silently declined to run when its
 * own gate was closed would leave the router with a non-null solver it still
 * cannot use, and no path back to `domFallbackSolver`. Gating in the lookup
 * instead means a closed gate simply looks like no dedicated solver being
 * registered at all, which is the behavior this ticket is required to leave
 * unchanged.
 */

import { ATS_PLATFORMS, type AtsPlatform } from "@/lib/db/schema";
import type { SolverFn } from "@/lib/solvers/types";
import { ashbyDirectSolver, shouldRouteAshbyDirectHttp } from "@/lib/solvers/ashby-direct";

const solvers: Record<AtsPlatform, SolverFn | undefined> = {
  greenhouse: undefined,
  lever: undefined,
  ashby: ashbyDirectSolver,
  workable: undefined,
  bamboohr: undefined,
  breezy: undefined,
  jazzhr: undefined,
  recruitee: undefined,
  teamtailor: undefined,
  smartrecruiters: undefined,
};

const ATS_PLATFORM_SET: ReadonlySet<string> = new Set(ATS_PLATFORMS);

/**
 * Returns the dedicated solver for `ats`, or null when there is none
 * registered, `ats` is not a recognized platform, or a registered entry's
 * own gate is closed. A null return is the router's signal to fall through
 * to `domFallbackSolver`.
 *
 * Takes `string` rather than `AtsPlatform`: the row `submitApplication`'s
 * `preflight()` reads carries `ats` straight off the `jobs` table as a plain
 * string (see `PreflightRow` in `lib/submit-application.ts`), not narrowed to
 * the platform union, and narrowing it there is outside this ticket's scope
 * of "only the router changes". This function does the narrowing itself
 * instead, so a value that is not one of `ATS_PLATFORMS` reads the same as
 * "no solver registered" rather than a type error at the call site.
 */
export function lookupSolver(ats: string): SolverFn | null {
  if (!ATS_PLATFORM_SET.has(ats)) return null;
  const platform = ats as AtsPlatform;
  const entry = solvers[platform];
  if (entry === undefined) return null;
  if (platform === "ashby" && !shouldRouteAshbyDirectHttp(platform)) return null;
  return entry;
}
