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
 * ── A registered solver does not mean a live platform ───────────────────────
 * Registering an entry here says the code exists to run a listing on that
 * platform through. It says nothing about whether `boards` rows for that
 * platform are actually matched against candidates: that is
 * `boards.active`, a separate, manually curated gate (see its column comment
 * in `lib/db/schema.ts`), and it stays `false` until a real submission on
 * that exact ATS has actually been confirmed working. `bamboohr.ts` is the
 * clearest example: it is registered below the same as every other entry,
 * and its own header explains why it ships as a deliberate stub with no
 * board specific classifier, because BambooHR's real obstacle is not
 * something a classifier can fix — a reCAPTCHA v2 iframe in front of the
 * form, confirmed unsolvable by synthetic clicks (see
 * `lib/known-unsolved-platforms.ts`). A solver landing here is necessary
 * work toward a platform going live; it is never by itself the signal that
 * it should.
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
import { bamboohrSolver } from "@/lib/solvers/bamboohr";
import { greenhouseSolver } from "@/lib/solvers/greenhouse";
import { leverSolver } from "@/lib/solvers/lever";
import { recruiteeSolver } from "@/lib/solvers/recruitee";
import { workableSolver } from "@/lib/solvers/workable";

const solvers: Record<AtsPlatform, SolverFn | undefined> = {
  // JOB-234. Unconditional, unlike Ashby's gate below, for the same reason
  // Lever's entry is unconditional — see that comment just below. This is
  // the same DOM fill and submit flow `domFallbackSolver` already ran for
  // Greenhouse, plus a Greenhouse specific read of the page afterward.
  // There is no riskier code path here to gate behind a flag.
  greenhouse: greenhouseSolver,
  // JOB-233. Unconditional, unlike Ashby's gate below — the Lever solver has
  // no feature flag of its own, because unlike JOB-214's Ashby direct HTTP
  // path it does not bypass ACT-007/ACT-008 at all; it is the same DOM fill
  // and submit flow `domFallbackSolver` already ran for Lever, plus a
  // Lever-specific read of the page afterward. There is no riskier code path
  // here to gate behind a flag.
  lever: leverSolver,
  ashby: ashbyDirectSolver,
  // JOB-235. Unconditional, unlike Ashby's gate below, for the same reason
  // Lever's and Greenhouse's entries are — see those comments above. This is
  // the same DOM fill and submit flow `domFallbackSolver` already ran for
  // Workable, plus a Workable specific read of the one confirmed failure
  // shape (see `lib/solvers/workable.ts`'s header).
  workable: workableSolver,
  // JOB-236. Unconditional, unlike Ashby's gate below, for the same reason
  // the other four entries above are — see those comments. This is the same
  // DOM fill and submit flow `domFallbackSolver` already ran for Recruitee,
  // plus the #140 phone country code fix and a Recruitee specific read of
  // the one confirmed failure shape (see `lib/solvers/recruitee.ts`'s
  // header).
  recruitee: recruiteeSolver,
  // JOB-237. A deliberate stub, unlike the five entries above: the same DOM
  // fill and submit flow `domFallbackSolver` already ran for BambooHR, with
  // no board specific read added on top yet. See `lib/solvers/bamboohr.ts`'s
  // header for why this ships without one — no real `applications` row has
  // ever hit a BambooHR submission to diagnose a patch from.
  bamboohr: bamboohrSolver,
  breezy: undefined,
  jazzhr: undefined,
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
