// @vitest-environment node
/**
 * JOB-237 round 2 — the auto-skip registry.
 *
 * `knownUnsolvedPlatform` is the pure lookup `applyToJob` in
 * `inngest/job-application-pipeline.ts` calls before
 * `reserve-application-slot`. What matters here is exactly what the pipeline
 * relies on: BambooHR matches, an active dedicated-solver platform like
 * Greenhouse does not, and an unrecognised string does not throw. The
 * Inngest wiring itself is not unit tested, consistent with the rest of
 * `job-application-pipeline.ts` — see e.g. `settleApplicationSlot`, which has
 * no dedicated test file either, because a `step.run` closure is exercised
 * through the running pipeline rather than in isolation.
 */
import { describe, expect, it } from "vitest";

import { ATS_PLATFORMS, SKIP_REASONS } from "@/lib/db/schema";
import {
  KNOWN_UNSOLVED_PLATFORMS,
  knownUnsolvedPlatform,
} from "@/lib/known-unsolved-platforms";
import { CAP_CONSUMING_STATUSES } from "@/lib/application-status";

describe("knownUnsolvedPlatform", () => {
  it("matches bamboohr, with a reason and a confirmation date", () => {
    const result = knownUnsolvedPlatform("bamboohr");
    expect(result).not.toBeNull();
    expect(result?.ats).toBe("bamboohr");
    expect(result?.reason.length).toBeGreaterThan(0);
    expect(result?.confirmedAt).toBe("2026-08-24");
  });

  it("does not match a platform with a working dedicated solver", () => {
    // Greenhouse, Lever, Ashby, Workable and Recruitee all have dedicated
    // solvers registered in lib/solvers/index.ts and confirmed submissions
    // behind boards.active — none belongs in this registry.
    for (const ats of ["greenhouse", "lever", "ashby", "workable", "recruitee"]) {
      expect(knownUnsolvedPlatform(ats)).toBeNull();
    }
  });

  it("does not match a platform with no registered entry at all", () => {
    for (const ats of ["breezy", "jazzhr", "teamtailor", "smartrecruiters"]) {
      expect(knownUnsolvedPlatform(ats)).toBeNull();
    }
  });

  it("returns null for a string that names no ATS platform, rather than throwing", () => {
    expect(knownUnsolvedPlatform("")).toBeNull();
    expect(knownUnsolvedPlatform("not-a-real-platform")).toBeNull();
  });

  it("every key in the registry is a real ATS_PLATFORMS value", () => {
    // Guards against a typo'd key silently registering an entry nothing ever
    // reads: TypeScript already refuses this at compile time because the
    // registry is typed `Partial<Record<AtsPlatform, ...>>`, but this keeps
    // the guarantee visible as a runtime assertion too.
    for (const key of Object.keys(KNOWN_UNSOLVED_PLATFORMS)) {
      expect(ATS_PLATFORMS).toContain(key);
    }
  });
});

describe("the platform_unsolved skip reason", () => {
  it("is part of the closed SKIP_REASONS set the skip_log CHECK constraint enforces", () => {
    expect(SKIP_REASONS).toContain("platform_unsolved");
  });

  it("has no applications.status counterpart in CAP_CONSUMING_STATUSES", () => {
    // The auto-skip path never writes a status at all — the row stays
    // `discovered` — so there is no status for `platform_unsolved` to appear
    // beside here. This test exists so a future edit that starts writing a
    // status for this path is forced to look at this list and decide
    // deliberately, rather than by accident, whether that status belongs in
    // it. Accidentally landing on any status this file makes cap consuming
    // would be exactly the bug this ticket exists to prevent.
    expect(CAP_CONSUMING_STATUSES).not.toContain("platform_unsolved");
  });
});
