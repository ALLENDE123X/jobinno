// @vitest-environment node
/**
 * JOB-360. Pure function coverage for `lib/onboarding/resume-prefill.ts`:
 * the deterministic citizenship phrase match, the graduation date
 * normaliser, the defaults derivation, and the version gated read back.
 * None of these touch the network or an LLM, so no mocking is needed.
 */
import { describe, expect, it } from "vitest";

import {
  ResumePrefillDefaultsSchema,
  deriveResumePrefillDefaults,
  detectCitizenshipFromResumeText,
  parseGradDateToIso,
  readResumePrefillDefaults,
} from "@/lib/onboarding/resume-prefill";
import type { ResumeProfile } from "@/lib/resume-parser";

function emptyProfile(overrides: Partial<ResumeProfile> = {}): ResumeProfile {
  return {
    firstName: null,
    lastName: null,
    email: "person@example.com",
    phone: null,
    location: null,
    linkedinUrl: null,
    websiteUrl: null,
    githubUrl: null,
    workHistory: [],
    education: [],
    skills: [],
    resumeStatedEmail: null,
    warnings: [],
    ...overrides,
  };
}

describe("detectCitizenshipFromResumeText", () => {
  it("finds a direct US citizen statement", () => {
    expect(detectCitizenshipFromResumeText("Authorized to work: US Citizen")).toBe(
      "us_citizen",
    );
  });

  it("finds a direct permanent resident statement", () => {
    expect(detectCitizenshipFromResumeText("Status: Green Card Holder")).toBe(
      "permanent_resident",
    );
  });

  it("never reads a negated statement as a claim", () => {
    expect(detectCitizenshipFromResumeText("Not a US citizen")).toBeNull();
    expect(detectCitizenshipFromResumeText("Non US citizen applicant")).toBeNull();
  });

  it("returns null when nothing is stated, including for F1 or H1B mentions", () => {
    expect(detectCitizenshipFromResumeText("Software Engineer, five years")).toBeNull();
    expect(
      detectCitizenshipFromResumeText("H1B sponsorship required for this role"),
    ).toBeNull();
  });
});

describe("parseGradDateToIso", () => {
  it("resolves an unambiguous month and year", () => {
    expect(parseGradDateToIso("May 2024")).toBe("2024-05-01");
    expect(parseGradDateToIso("Expected Dec. 2025")).toBe("2025-12-01");
  });

  it("resolves a numeric month and year", () => {
    expect(parseGradDateToIso("05/2024")).toBe("2024-05-01");
  });

  it("passes through an already ISO date", () => {
    expect(parseGradDateToIso("2024-05-15")).toBe("2024-05-15");
  });

  it("leaves a bare year or a season unresolved rather than guessing", () => {
    expect(parseGradDateToIso("2025")).toBeNull();
    expect(parseGradDateToIso("Spring 2025")).toBeNull();
  });

  it("handles null and empty input", () => {
    expect(parseGradDateToIso(null)).toBeNull();
    expect(parseGradDateToIso("")).toBeNull();
  });
});

describe("deriveResumePrefillDefaults", () => {
  it("sets workAuthorizedUs true only when citizenship was directly stated", () => {
    const profile = emptyProfile({ location: "Austin, TX" });
    const defaults = deriveResumePrefillDefaults("US Citizen", profile);
    expect(defaults.citizenshipStatus).toBe("us_citizen");
    expect(defaults.workAuthorizedUs).toBe(true);
  });

  it("never sets workAuthorizedUs false from resume silence", () => {
    const profile = emptyProfile();
    const defaults = deriveResumePrefillDefaults(
      "Requires visa sponsorship for this role",
      profile,
    );
    expect(defaults.citizenshipStatus).toBeNull();
    expect(defaults.workAuthorizedUs).toBeNull();
  });

  it("mirrors location into targetLocations and reads the most recent grad date", () => {
    const profile = emptyProfile({
      location: "Boston, MA",
      education: [
        { school: "State University", degree: "BS", discipline: "CS", endDate: "May 2026" },
      ],
    });
    const defaults = deriveResumePrefillDefaults("no citizenship claim here", profile);
    expect(defaults.currentCity).toBe("Boston, MA");
    expect(defaults.targetLocations).toEqual(["Boston, MA"]);
    expect(defaults.gradDate).toBe("2026-05-01");
  });

  it("leaves every field null when the resume carries nothing usable", () => {
    const defaults = deriveResumePrefillDefaults("", emptyProfile());
    expect(defaults).toEqual({
      citizenshipStatus: null,
      workAuthorizedUs: null,
      currentCity: null,
      targetLocations: null,
      gradDate: null,
    });
  });
});

describe("ResumePrefillDefaultsSchema", () => {
  it("accepts a fully null shape", () => {
    const result = ResumePrefillDefaultsSchema.safeParse({
      citizenshipStatus: null,
      workAuthorizedUs: null,
      currentCity: null,
      targetLocations: null,
      gradDate: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a citizenship value outside the two allowed states", () => {
    const result = ResumePrefillDefaultsSchema.safeParse({
      citizenshipStatus: "f1",
      workAuthorizedUs: null,
      currentCity: null,
      targetLocations: null,
      gradDate: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("readResumePrefillDefaults", () => {
  function supabaseWithParsed(parsed: unknown) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: { parsed }, error: null }),
            }),
          }),
        }),
      }),
    } as never;
  }

  it("returns null when the column is empty", async () => {
    const result = await readResumePrefillDefaults(supabaseWithParsed(null), "resume-1");
    expect(result).toBeNull();
  });

  it("returns null for a parse with no onboardingDefaults at all", async () => {
    const result = await readResumePrefillDefaults(
      supabaseWithParsed({ version: 1, resume: {}, linkedin: null }),
      "resume-1",
    );
    expect(result).toBeNull();
  });

  it("returns null when the onboardingDefaults version does not match", async () => {
    const result = await readResumePrefillDefaults(
      supabaseWithParsed({ onboardingDefaults: { version: 999, citizenshipStatus: null } }),
      "resume-1",
    );
    expect(result).toBeNull();
  });

  it("returns the defaults when the shape and version are valid", async () => {
    const result = await readResumePrefillDefaults(
      supabaseWithParsed({
        onboardingDefaults: {
          version: 1,
          citizenshipStatus: "us_citizen",
          workAuthorizedUs: true,
          currentCity: "Denver, CO",
          targetLocations: ["Denver, CO"],
          gradDate: "2026-05-01",
        },
      }),
      "resume-1",
    );
    expect(result).toEqual({
      citizenshipStatus: "us_citizen",
      workAuthorizedUs: true,
      currentCity: "Denver, CO",
      targetLocations: ["Denver, CO"],
      gradDate: "2026-05-01",
    });
  });
});
