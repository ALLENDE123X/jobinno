/**
 * JOB-232 — the per-board solver registry.
 *
 * One dedicated solver per ats platform that has one, keyed by
 * `AtsPlatform`. Every platform without an entry here — and, today, a
 * registered entry whose own gate is closed — falls through to
 * `domFallbackSolver` at the call site in `lib/submit-application.ts`:
 * `const platform = isAtsPlatform(row.ats) ? row.ats : null;`
 * `const solver = (platform && lookupSolver(platform)) ?? domFallbackSolver`.
 *
 * Adding the next dedicated solver (Greenhouse, Lever, ...) is meant to be
 * one new file under `lib/solvers/` plus one line in `solvers` below — no
 * other file changes, and nothing in `lib/submit-application.ts` has to move
 * again.
 *
 * `lookupSolver` takes `AtsPlatform`, not `string`: the row `submitApplication`'s
 * `preflight()` reads carries `ats` as a plain string off the `jobs` table (see
 * `PreflightRow` in `lib/submit-application.ts`), so the router narrows it with
 * an `isAtsPlatform()` type guard before calling in here. That keeps the
 * runtime check at the one call site this ticket authorizes touching, and
 * keeps a typo'd platform key inside `solvers` below a compile time error
 * rather than a silent `null`.
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

import type { AtsPlatform } from "@/lib/db/schema";
import type { SolverFn } from "@/lib/solvers/types";
import { ashbyDirectSolver, shouldRouteAshbyDirectHttp } from "@/lib/solvers/ashby-direct";
import { leverSolver } from "@/lib/solvers/lever";

const solvers: Record<AtsPlatform, SolverFn | undefined> = {
  greenhouse: undefined,
  // JOB-233. Unconditional, unlike Ashby's gate below — the Lever solver has
  // no feature flag of its own, because unlike JOB-214's Ashby direct HTTP
  // path it does not bypass ACT-007/ACT-008 at all; it is the same DOM fill
  // and submit flow `domFallbackSolver` already ran for Lever, plus a
  // Lever-specific read of the page afterward. There is no riskier code path
  // here to gate behind a flag.
  lever: leverSolver,
  ashby: ashbyDirectSolver,
  workable: undefined,
  bamboohr: undefined,
  breezy: undefined,
  jazzhr: undefined,
  recruitee: undefined,
  teamtailor: undefined,
  smartrecruiters: undefined,
};

/**
 * Returns the dedicated solver for `ats`, or null when there is none
 * registered, or a registered entry's own gate is closed. A null return is
 * the router's signal to fall through to `domFallbackSolver`.
 *
 * Takes `AtsPlatform`, already narrowed by the caller's `isAtsPlatform()`
 * guard — see the module header for why the narrowing lives at the router
 * rather than in here.
 */
export function lookupSolver(ats: AtsPlatform): SolverFn | null {
  const entry = solvers[ats];
  if (entry === undefined) return null;
  if (ats === "ashby" && !shouldRouteAshbyDirectHttp(ats)) return null;
  return entry;
}
