import { describe, expect, it } from "vitest";

import {
  earliestIncompleteStep,
  postAuthOnboardingPath,
  resolveIntakeStep,
  type ProfileForRouting,
  type ResumeForRouting,
} from "@/lib/onboarding/step-routing";

function profile(
  overrides: Partial<ProfileForRouting> = {},
): ProfileForRouting {
  return {
    citizenshipStatus: null,
    currentCity: null,
    clearanceEligibility: null,
    attestedAt: null,
    ...overrides,
  };
}

function resume(
  storagePath: string = "resumes/user/abc.pdf",
): ResumeForRouting {
  return { storagePath };
}

describe("earliestIncompleteStep", () => {
  it("returns 1 when no resumes row exists", () => {
    expect(earliestIncompleteStep(profile({}), null)).toBe(1);
    // Default second arg is null.
    expect(earliestIncompleteStep(profile({}))).toBe(1);
  });

  it("returns 2 when a resume exists but citizenship is missing", () => {
    expect(earliestIncompleteStep(profile({}), resume())).toBe(2);
  });

  it("returns 3 when the location is missing", () => {
    expect(
      earliestIncompleteStep(
        profile({ citizenshipStatus: "f1" }),
        resume(),
      ),
    ).toBe(3);
  });

  it("returns 4 when the clearance gate is missing", () => {
    expect(
      earliestIncompleteStep(
        profile({ citizenshipStatus: "f1", currentCity: "Austin" }),
        resume(),
      ),
    ).toBe(4);
  });

  // JOB-310: step 4 no longer collects salaryExpectation, so it must not be
  // the signal step routing reads. A profile that answered the clearance
  // gate but left every other JOB-134 field null (the normal shape after
  // this ticket) still has to advance past step 4.
  it("returns 5 once the clearance gate is answered, even with every other JOB-134 field null", () => {
    expect(
      earliestIncompleteStep(
        profile({
          citizenshipStatus: "f1",
          currentCity: "Austin",
          clearanceEligibility: "no",
        }),
        resume(),
      ),
    ).toBe(5);
  });

  it("returns 6 when everything is complete", () => {
    expect(
      earliestIncompleteStep(
        profile({
          citizenshipStatus: "f1",
          currentCity: "Austin",
          clearanceEligibility: "no",
          attestedAt: new Date("2026-08-31"),
        }),
        resume(),
      ),
    ).toBe(6);
  });

  // Integration-style test matching the real query shape from
  // app/onboarding/page.tsx and app/onboarding/step/[step]/page.tsx.
  // Mocks the shape of the two Supabase queries and verifies the
  // routing decision, so a future change to those queries has to update
  // this fixture.
  it("routes to step 2 when the resumes-table lookup returns a row", () => {
    const profileRow = {
      citizenship_status: null,
      current_city: null,
      clearance_eligibility: null,
      attested_at: null,
    };
    const resumeRow = {
      storage_path: "resumes/11111111-1111-1111-1111-111111111111/abc.pdf",
    };
    const result = earliestIncompleteStep(
      {
        citizenshipStatus: profileRow.citizenship_status,
        currentCity: profileRow.current_city,
        clearanceEligibility: profileRow.clearance_eligibility,
        attestedAt: profileRow.attested_at,
      },
      resumeRow ? { storagePath: resumeRow.storage_path } : null,
    );
    expect(result).toBe(2);
  });

  it("routes to step 1 when the resumes-table lookup returns no row", () => {
    const profileRow = {
      citizenship_status: null,
      current_city: null,
      clearance_eligibility: null,
      attested_at: null,
    };
    const resumeRow = null;
    const result = earliestIncompleteStep(
      {
        citizenshipStatus: profileRow.citizenship_status,
        currentCity: profileRow.current_city,
        clearanceEligibility: profileRow.clearance_eligibility,
        attestedAt: profileRow.attested_at,
      },
      resumeRow,
    );
    expect(result).toBe(1);
  });

  // JOB-330. The second lane on step 1 stores a LinkedIn URL on
  // `profiles.linkedin_url_pending` and lets the person move on without
  // a resumes row. Step routing must treat that as "step 1 complete" so
  // the person is not looped back to a resume upload they still cannot
  // do; the pipeline gate in `inngest/job-application-pipeline.ts`
  // enforces HARD STOP 9 by refusing to open a browser until a real
  // `resumes` row exists.
  it("returns 2 when a LinkedIn URL pending is set but no resumes row exists (JOB-330)", () => {
    expect(
      earliestIncompleteStep(
        profile({ linkedinUrlPending: "https://linkedin.com/in/pat" }),
        null,
      ),
    ).toBe(2);
  });

  it("still returns 1 when neither a resumes row nor a LinkedIn URL pending exists", () => {
    expect(
      earliestIncompleteStep(
        profile({ linkedinUrlPending: null }),
        null,
      ),
    ).toBe(1);
  });

  it("prefers whichever step 1 signal exists (resume OR pending URL)", () => {
    // Both signals present: still counts as step 1 complete; the person
    // moves to step 2 regardless of which one landed first.
    expect(
      earliestIncompleteStep(
        profile({ linkedinUrlPending: "https://linkedin.com/in/pat" }),
        resume(),
      ),
    ).toBe(2);
  });
});

// JOB-309. postAuthOnboardingPath is what actually decides where a signed in
// user lands: app/onboarding/page.tsx (the real post-auth destination) and
// app/onboarding/preview/page.tsx both redirect through it rather than each
// hardcoding their own view of what step 1 or step 6 means.
describe("postAuthOnboardingPath", () => {
  it("sends someone who has not started step 1 to the preview page, not straight to step 1", () => {
    expect(postAuthOnboardingPath(1)).toBe("/onboarding/preview");
  });

  it("sends an already attested profile to the dashboard", () => {
    expect(postAuthOnboardingPath(6)).toBe("/dashboard");
  });

  it("sends anyone mid intake to their own numbered step", () => {
    expect(postAuthOnboardingPath(2)).toBe("/onboarding/step/2");
    expect(postAuthOnboardingPath(3)).toBe("/onboarding/step/3");
    expect(postAuthOnboardingPath(4)).toBe("/onboarding/step/4");
    expect(postAuthOnboardingPath(5)).toBe("/onboarding/step/5");
  });
});

// JOB-319. resolveIntakeStep is the shim both app/onboarding/page.tsx and
// app/onboarding/preview/page.tsx run their two Supabase reads through, so
// a transient PostgREST failure never falls through as a null row and gets
// misread as "profile not filled in yet". The pages fail closed on a
// kind: "error" result; the tests below lock in that the helper flags
// either read failing, and that a clean pair still produces a step.
describe("resolveIntakeStep", () => {
  const profileRow = {
    citizenship_status: "f1",
    current_city: "Austin",
    clearance_eligibility: "no",
    attested_at: null,
  };
  const resumeRow = {
    storage_path: "resumes/11111111-1111-1111-1111-111111111111/abc.pdf",
  };

  it("returns a step branch when both reads succeed", () => {
    const result = resolveIntakeStep(
      { data: profileRow, error: null },
      { data: resumeRow, error: null },
    );
    expect(result).toEqual({ kind: "step", step: 5 });
  });

  it("returns a step branch when both rows are absent but neither read errored", () => {
    // No profile, no resume: still a legitimate "brand new signup" case.
    // Only an error should trip the error branch.
    const result = resolveIntakeStep(
      { data: null, error: null },
      { data: null, error: null },
    );
    expect(result).toEqual({ kind: "step", step: 1 });
  });

  it("flags the profile read when it errored, and preserves the underlying error", () => {
    const err = { message: "connection reset", code: "PGRST000" };
    const result = resolveIntakeStep(
      { data: null, error: err },
      { data: resumeRow, error: null },
    );
    expect(result).toEqual({ kind: "error", where: "profile", error: err });
  });

  it("flags the resume read when it errored, and preserves the underlying error", () => {
    const err = { message: "statement timeout", code: "57014" };
    const result = resolveIntakeStep(
      { data: profileRow, error: null },
      { data: null, error: err },
    );
    expect(result).toEqual({ kind: "error", where: "resume", error: err });
  });

  // Regression: an attested profile whose resume read failed transiently
  // used to fall through as { data: profile, data: null } and route the
  // person back into onboarding. This asserts the resume error alone is
  // enough to trip the error branch, even when the profile itself proves
  // the person is past step 1.
  it("flags a resume read error even when the profile alone says the person is attested", () => {
    const attestedProfile = {
      citizenship_status: "f1",
      current_city: "Austin",
      clearance_eligibility: "no",
      attested_at: "2026-08-31T00:00:00.000Z",
    };
    const result = resolveIntakeStep(
      { data: attestedProfile, error: null },
      { data: null, error: { message: "statement timeout" } },
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.where).toBe("resume");
  });

  // Regression: profile error alone must not silently pin an already
  // attested user to step 1 by turning the profile row into null.
  it("prefers the profile error over the resume error when both fail", () => {
    const profErr = { message: "profile timeout" };
    const resErr = { message: "resume timeout" };
    const result = resolveIntakeStep(
      { data: null, error: profErr },
      { data: null, error: resErr },
    );
    expect(result).toEqual({ kind: "error", where: "profile", error: profErr });
  });
});
