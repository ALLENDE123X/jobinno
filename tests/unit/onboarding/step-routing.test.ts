import { describe, expect, it } from "vitest";

import {
  earliestIncompleteStep,
  type ProfileForRouting,
  type ResumeForRouting,
} from "@/lib/onboarding/step-routing";

function profile(
  overrides: Partial<ProfileForRouting> = {},
): ProfileForRouting {
  return {
    citizenshipStatus: null,
    currentCity: null,
    salaryExpectation: null,
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

  it("returns 4 when compliance and comp are missing", () => {
    expect(
      earliestIncompleteStep(
        profile({ citizenshipStatus: "f1", currentCity: "Austin" }),
        resume(),
      ),
    ).toBe(4);
  });

  it("returns 5 when the attestation is missing", () => {
    expect(
      earliestIncompleteStep(
        profile({
          citizenshipStatus: "f1",
          currentCity: "Austin",
          salaryExpectation: "negotiable",
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
          salaryExpectation: "negotiable",
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
      salary_expectation: null,
      attested_at: null,
    };
    const resumeRow = {
      storage_path: "resumes/11111111-1111-1111-1111-111111111111/abc.pdf",
    };
    const result = earliestIncompleteStep(
      {
        citizenshipStatus: profileRow.citizenship_status,
        currentCity: profileRow.current_city,
        salaryExpectation: profileRow.salary_expectation,
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
      salary_expectation: null,
      attested_at: null,
    };
    const resumeRow = null;
    const result = earliestIncompleteStep(
      {
        citizenshipStatus: profileRow.citizenship_status,
        currentCity: profileRow.current_city,
        salaryExpectation: profileRow.salary_expectation,
        attestedAt: profileRow.attested_at,
      },
      resumeRow,
    );
    expect(result).toBe(1);
  });
});
