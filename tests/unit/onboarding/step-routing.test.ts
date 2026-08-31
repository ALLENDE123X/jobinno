import { describe, expect, it } from "vitest";

import {
  earliestIncompleteStep,
  type ProfileForRouting,
} from "@/lib/onboarding/step-routing";

function profile(
  overrides: Partial<ProfileForRouting> = {},
): ProfileForRouting {
  return {
    resumePath: null,
    citizenshipStatus: null,
    currentCity: null,
    salaryExpectation: null,
    attestedAt: null,
    ...overrides,
  };
}

describe("earliestIncompleteStep", () => {
  it("returns 1 when the resume is missing", () => {
    expect(earliestIncompleteStep(profile({ resumePath: null }))).toBe(1);
    expect(earliestIncompleteStep(profile({}))).toBe(1);
  });

  it("returns 2 when citizenship is missing after a resume", () => {
    expect(
      earliestIncompleteStep(profile({ resumePath: "/resume.pdf" })),
    ).toBe(2);
  });

  it("returns 3 when the location is missing", () => {
    expect(
      earliestIncompleteStep(
        profile({ resumePath: "/resume.pdf", citizenshipStatus: "f1" }),
      ),
    ).toBe(3);
  });

  it("returns 4 when compliance and comp are missing", () => {
    expect(
      earliestIncompleteStep(
        profile({
          resumePath: "/resume.pdf",
          citizenshipStatus: "f1",
          currentCity: "Austin",
        }),
      ),
    ).toBe(4);
  });

  it("returns 5 when the attestation is missing", () => {
    expect(
      earliestIncompleteStep(
        profile({
          resumePath: "/resume.pdf",
          citizenshipStatus: "f1",
          currentCity: "Austin",
          salaryExpectation: "negotiable",
        }),
      ),
    ).toBe(5);
  });

  it("returns 6 when everything is complete", () => {
    expect(
      earliestIncompleteStep(
        profile({
          resumePath: "/resume.pdf",
          citizenshipStatus: "f1",
          currentCity: "Austin",
          salaryExpectation: "negotiable",
          attestedAt: new Date("2026-08-31"),
        }),
      ),
    ).toBe(6);
  });
});
