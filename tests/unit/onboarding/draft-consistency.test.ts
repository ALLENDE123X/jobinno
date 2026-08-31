import { describe, expect, it } from "vitest";

import {
  deriveNeedsSponsorshipNonUs,
  deriveRequiresSponsorship,
  deriveWorkAuthorizedUs,
} from "@/lib/onboarding/intake-derivation";
import { intakeSchema } from "@/lib/onboarding/intake-schema";

/**
 * The point of saving as you go is that a partially filled profile is never
 * stored in a state the full intakeSchema would reject as a contradiction.
 * These tests compose the step derivation helpers the way saveIntakeDraft does
 * and prove the result is internally consistent enough for intakeSchema to
 * accept, given the user's own answers.
 */

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OBJECT_PATH = `${USER_ID}/22222222-2222-2222-2222-222222222222.pdf`;

type Derived = {
  workAuthorizedUs: boolean;
  requiresSponsorship: boolean;
  needsSponsorshipNonUs: boolean;
};

function deriveStep2And3(
  citizenship: string,
  willingToRelocate: boolean,
  targetLocations: string[],
): Derived {
  return {
    workAuthorizedUs: deriveWorkAuthorizedUs(citizenship, true),
    requiresSponsorship: deriveRequiresSponsorship(citizenship, true),
    needsSponsorshipNonUs: deriveNeedsSponsorshipNonUs(
      targetLocations,
      willingToRelocate,
      true,
    ),
  };
}

function completePayload(
  citizenship: string,
  f1Status: string | null,
  derived: Derived,
  overrides: Record<string, unknown> = {},
) {
  return {
    citizenshipStatus: citizenship,
    f1Status,
    ...derived,
    visaStatus: citizenship === "f1" ? "F-1 on OPT" : "None, US citizen",
    clearanceEligibility: "eligible",
    clearanceLevelHeld: "never_held",
    subjectToRestrictiveCovenant: false,
    relativesAtTargetEmployers: false,
    previouslyEmployedAtTargetEmployers: false,
    salaryExpectation: "market rate",
    currentCity: "Austin",
    currentCountry: "US",
    streetAddress: "100 Main St",
    postalCode: "78701",
    willingToRelocate: true,
    targetLocations: ["Austin, US"],
    gradDate: "2027-05-01",
    earliestStart: "2027-06-01",
    highSchoolName: "Lincoln High School",
    highSchoolGradYear: 2021,
    resumePath: OBJECT_PATH,
    linkedinPdfPath: null,
    githubUrl: null,
    attestation: true,
    ...overrides,
  };
}

describe("save as you go produces intakeSchema valid data", () => {
  it("a US citizen is derived authorized with no sponsorship and accepts", () => {
    const derived = deriveStep2And3(
      "us_citizen",
      true,
      ["Austin, US", "Toronto, Canada"],
    );
    expect(derived.workAuthorizedUs).toBe(true);
    expect(derived.requiresSponsorship).toBe(false);

    const result = intakeSchema(USER_ID).safeParse(
      completePayload("us_citizen", null, derived),
    );
    expect(result.success).toBe(true);
  });

  it("an F1 targeting only the US and not relocating drops sponsorship", () => {
    const derived = deriveStep2And3("f1", false, ["Austin, US"]);
    expect(derived.needsSponsorshipNonUs).toBe(false);
    expect(derived.requiresSponsorship).toBe(true);

    const result = intakeSchema(USER_ID).safeParse(
      completePayload("f1", "opt", derived),
    );
    expect(result.success).toBe(true);
  });

  it("an F1 targeting a non US location keeps non US sponsorship", () => {
    const derived = deriveStep2And3("f1", false, ["Toronto, Canada"]);
    expect(derived.needsSponsorshipNonUs).toBe(true);

    const result = intakeSchema(USER_ID).safeParse(
      completePayload("f1", "opt", derived),
    );
    expect(result.success).toBe(true);
  });
});

describe("derived answers never contradict", () => {
  it("an inherently authorized person is always authorized and never needs sponsorship", () => {
    for (const citizenship of ["us_citizen", "permanent_resident"]) {
      const d = deriveStep2And3(citizenship, true, ["Toronto, Canada"]);
      expect(d.workAuthorizedUs).toBe(true);
      expect(d.requiresSponsorship).toBe(false);
    }
  });
});
