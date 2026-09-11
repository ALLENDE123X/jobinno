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

  // Round one red team's BLOCKING 1: a bare substring match let "US
  // Citizenship" match "US Citizen", and the negation scan never looked
  // forward, so a trailing disqualifier slipped through. Every exploit red
  // team verified is its own case here rather than folded together, so a
  // regression in any one of them fails loudly and by name.
  describe("round one red team false positives", () => {
    it("does not read a mention of USCIS as a personal citizenship claim", () => {
      expect(
        detectCitizenshipFromResumeText(
          "I helped clients apply for US Citizenship & Immigration Services (USCIS) grants",
        ),
      ).toBeNull();
    });

    it("does not read a company name in a bullet as a personal citizenship claim", () => {
      expect(detectCitizenshipFromResumeText("US Citizen Corp (client)")).toBeNull();
    });

    it("does not read work performed for other people as a personal citizenship claim", () => {
      expect(
        detectCitizenshipFromResumeText(
          "Immigration paralegal handling US citizen naturalization cases for clients",
        ),
      ).toBeNull();
    });

    it("does not read a volunteer organization's name as a personal citizenship claim", () => {
      expect(
        detectCitizenshipFromResumeText("Volunteer at US Citizen Advocacy Network"),
      ).toBeNull();
    });

    it("does not read a stated need for a green card as already holding one", () => {
      expect(detectCitizenshipFromResumeText("Green card sponsorship needed")).toBeNull();
    });

    it("does not read a future sponsorship need mentioning a green card as holding one", () => {
      expect(
        detectCitizenshipFromResumeText(
          "Will require sponsorship for an employment visa (e.g., green card) in the future",
        ),
      ).toBeNull();
    });
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

  it("reads current city and the most recent grad date, never target locations", () => {
    const profile = emptyProfile({
      location: "Boston, MA",
      education: [
        { school: "State University", degree: "BS", discipline: "CS", endDate: "May 2026" },
      ],
    });
    const defaults = deriveResumePrefillDefaults("no citizenship claim here", profile);
    expect(defaults.currentCity).toBe("Boston, MA");
    expect(defaults.gradDate).toBe("2026-05-01");
    expect(defaults).not.toHaveProperty("targetLocations");
  });

  it("leaves every field null when the resume carries nothing usable", () => {
    const defaults = deriveResumePrefillDefaults("", emptyProfile());
    expect(defaults).toEqual({
      citizenshipStatus: null,
      workAuthorizedUs: null,
      currentCity: null,
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
      gradDate: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a citizenship value outside the two allowed states", () => {
    const result = ResumePrefillDefaultsSchema.safeParse({
      citizenshipStatus: "f1",
      workAuthorizedUs: null,
      currentCity: null,
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
          gradDate: "2026-05-01",
        },
      }),
      "resume-1",
    );
    expect(result).toEqual({
      citizenshipStatus: "us_citizen",
      workAuthorizedUs: true,
      currentCity: "Denver, CO",
      gradDate: "2026-05-01",
    });
  });
});
