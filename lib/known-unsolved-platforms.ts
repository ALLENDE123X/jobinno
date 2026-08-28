/**
 * JOB-237 round 2 — the auto-skip registry for ATS platforms with a confirmed,
 * unsolvable submission blocker.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 * `boards.active` is a manual curation gate: a human sets it to `true` only
 * once a submission on that platform has actually worked, and it has been kept
 * that way by hand for months (see the header on `boards` in
 * `lib/db/schema.ts`). Nothing in code enforced that convention, so nothing
 * stopped a future change from flipping a board's `active` column to `true`
 * without a working submission path behind it. `applyToJob` in
 * `inngest/job-application-pipeline.ts` has no platform-level awareness at
 * all: it reserves a slot off `profiles.applications_cap` and opens a browser
 * for any matched listing, on the assumption that `boards.active` already
 * screened out anything that cannot go through.
 *
 * BambooHR is the concrete case. Its apply form sits behind a reCAPTCHA v2
 * iframe challenge that synthetic (non-human) clicks cannot solve — confirmed
 * independently of any one ticket, recorded in cross session memory dated
 * 2026-08-24, with five or more distinct techniques tried and failed there.
 * `form_fill_blocked`, the status a captcha stop writes, IS in
 * `CAP_CONSUMING_STATUSES` (see `lib/application-status.ts`): a real,
 * unsolvable captcha burns a real applicant's capped `applications_used` slot
 * on a run that was never going to succeed. If `boards.active` is ever flipped
 * to `true` for a platform like this again — by hand, by a future ticket, by a
 * mistake — every match against it is a guaranteed, quota-consuming failure.
 *
 * ── What this registry is, and is not ───────────────────────────────────────
 * This is a second, independent gate that sits in code rather than in data,
 * checked in `applyToJob` before `reserveApplicationSlot` and before any
 * browser opens. It exists so a platform-level known-unsolvable block is
 * caught even if `boards.active` is wrong, rather than relying on manual
 * curation being the only thing standing between a candidate match and a
 * wasted slot.
 *
 * It is not a replacement for `boards.active`. That column still decides
 * whether a platform's listings are matched against candidates at all — see
 * `lib/job-matching.ts`'s `eq(boards.active, true)` filter. This registry is
 * the second line of defense for the case that first gate does not catch: a
 * match happens anyway, and the run needs to refuse before it spends anything.
 *
 * ── Adding an entry ──────────────────────────────────────────────────────────
 * Only for a platform level blocker confirmed against a real form: a captcha
 * or challenge that sits in front of every application on that ATS, not a
 * per-listing quirk (that belongs in a dedicated solver under
 * `lib/solvers/`, the way `lever.ts`'s hCaptcha submit button fix does). State
 * the mechanism and the date it was confirmed, the same way the BambooHR entry
 * below does, so a future reader can tell a stale entry from a live one.
 *
 * Removing an entry is a coordinated code and data change: the platform has to
 * actually be solvable (a new solver, a captcha-solving integration, whatever
 * closes the gap), and `boards.active` for that platform's rows has to be
 * flipped to `true` in the same change, not before it and not separately —
 * flipping `boards.active` alone, without removing the entry here, leaves the
 * board matched but still auto-skipped, which is a silent no-op rather than a
 * working reactivation.
 */

import type { AtsPlatform } from "@/lib/db/schema";

export type UnsolvedPlatformEntry = {
  /** Human readable explanation of the blocker, for the `skip_log` message and for whoever reads this file next. */
  readonly reason: string;
  /** The date (YYYY-MM-DD) this was confirmed, so staleness is visible at a glance. */
  readonly confirmedAt: string;
};

/**
 * Platforms with a confirmed, unsolvable, platform level submission blocker.
 * Keyed by `AtsPlatform` so a typo'd key is a compile time error rather than a
 * registry entry nothing ever reads.
 */
export const KNOWN_UNSOLVED_PLATFORMS: Partial<Record<AtsPlatform, UnsolvedPlatformEntry>> = {
  bamboohr: {
    reason:
      "BambooHR's apply form sits behind a reCAPTCHA v2 iframe challenge that " +
      "synthetic clicks cannot solve, confirmed across five or more distinct " +
      "automation techniques.",
    confirmedAt: "2026-08-24",
  },
};

/**
 * Looks `ats` up in the registry above. Returns `null` for anything not
 * listed, including a platform this repo has never heard of — the caller's
 * job is to decide what an unrecognised `ats` means, not this function's.
 *
 * Takes a plain `string` rather than `AtsPlatform` because the pipeline reads
 * `jobs.ats` as free text off the row (see `ListingBrief.ats` in
 * `inngest/job-application-pipeline.ts`), the same way
 * `lib/submit-application.ts`'s `isAtsPlatform()` guard exists to narrow it
 * at its own call site rather than trusting the column's shape.
 */
export function knownUnsolvedPlatform(
  ats: string
): (UnsolvedPlatformEntry & { ats: AtsPlatform }) | null {
  const entry = KNOWN_UNSOLVED_PLATFORMS[ats as AtsPlatform];
  if (!entry) return null;
  return { ats: ats as AtsPlatform, ...entry };
}
