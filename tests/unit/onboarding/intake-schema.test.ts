import { describe, expect, it } from "vitest";

import {
  step1Schema,
  step2Schema,
  step3Schema,
  step4Schema,
  step5Schema,
} from "@/lib/onboarding/intake-schema";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const RESUME_PATH = `${USER_ID}/22222222-2222-2222-2222-222222222222.pdf`;
const OTHER_USER_PATH =
  "33333333-3333-3333-3333-333333333333/22222222-2222-2222-2222-222222222222.pdf";

describe("step1Schema", () => {
  it("accepts a githubUrl", () => {
    const result = step1Schema().safeParse({
      githubUrl: "https://github.com/handle",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.githubUrl).toBe("https://github.com/handle");
  });

  it("normalizes a bare github handle to a URL", () => {
    const result = step1Schema().safeParse({ githubUrl: "github.com/handle" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.githubUrl).toBe("https://github.com/handle");
  });

  it("defaults a missing githubUrl to null", () => {
    const result = step1Schema().safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.githubUrl).toBeNull();
  });

  it("rejects a URL for a different domain", () => {
    const result = step1Schema().safeParse({ githubUrl: "https://gitlab.com/x" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid owned resumePath when userId is provided", () => {
    const result = step1Schema(USER_ID).safeParse({
      githubUrl: null,
      resumePath: RESUME_PATH,
      linkedinPdfPath: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a resumePath naming a different user's folder", () => {
    const result = step1Schema(USER_ID).safeParse({
      resumePath: OTHER_USER_PATH,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0].path[0]).toBe("resumePath");
  });

  it("rejects a resumePath with a bad shape", () => {
    const result = step1Schema(USER_ID).safeParse({
      resumePath: "not-a-valid-path",
    });
    expect(result.success).toBe(false);
  });

  it("defaults resumePath and linkedinPdfPath to null when omitted", () => {
    const result = step1Schema(USER_ID).safeParse({ githubUrl: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resumePath).toBeNull();
      expect(result.data.linkedinPdfPath).toBeNull();
    }
  });
});

describe("step2Schema", () => {
  const base = {
    citizenshipStatus: "f1",
    visaStatus: "F-1 on OPT",
    workAuthorizedUs: true,
    requiresSponsorship: true,
  };

  it("accepts an F1 with a status", () => {
    const result = step2Schema.safeParse({ ...base, f1Status: "opt" });
    expect(result.success).toBe(true);
  });

  it("rejects an F1 without a status", () => {
    const result = step2Schema.safeParse({ ...base, f1Status: null });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0].path[0]).toBe("f1Status");
  });

  it("rejects an F1 status on a non F1 citizenship", () => {
    const result = step2Schema.safeParse({
      ...base,
      citizenshipStatus: "us_citizen",
      f1Status: "opt",
    });
    expect(result.success).toBe(false);
  });

  it("defaults f1Status to null for a non F1 user", () => {
    const result = step2Schema.safeParse({
      ...base,
      citizenshipStatus: "us_citizen",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.f1Status).toBeNull();
  });

  // JOB-308 round two BLOCKING 1: US and PR are allowed to omit
  // workAuthorizedUs and requiresSponsorship (the server derives them);
  // other citizenships must supply both.
  it("accepts a US citizen who omits workAuthorizedUs and requiresSponsorship", () => {
    const result = step2Schema.safeParse({
      citizenshipStatus: "us_citizen",
      visaStatus: "None, US citizen",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workAuthorizedUs).toBeNull();
      expect(result.data.requiresSponsorship).toBeNull();
    }
  });

  it("accepts a permanent resident who omits work authorization booleans", () => {
    const result = step2Schema.safeParse({
      citizenshipStatus: "permanent_resident",
      visaStatus: "Permanent resident",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an F1 who omits workAuthorizedUs", () => {
    const result = step2Schema.safeParse({
      citizenshipStatus: "f1",
      f1Status: "opt",
      visaStatus: "F-1 on OPT",
      requiresSponsorship: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path[0]);
      expect(paths).toContain("workAuthorizedUs");
    }
  });

  it("rejects an F1 who omits requiresSponsorship", () => {
    const result = step2Schema.safeParse({
      citizenshipStatus: "f1",
      f1Status: "opt",
      visaStatus: "F-1 on OPT",
      workAuthorizedUs: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path[0]);
      expect(paths).toContain("requiresSponsorship");
    }
  });

  it("accepts an F1 not yet on OPT with workAuthorizedUs=false", () => {
    const result = step2Schema.safeParse({
      citizenshipStatus: "f1",
      f1Status: "none",
      visaStatus: "F-1",
      workAuthorizedUs: false,
      requiresSponsorship: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("step3Schema", () => {
  const base = {
    streetAddress: "100 Main St",
    currentCity: "Austin",
    currentCountry: "US",
    postalCode: "78701",
    targetLocations: ["Austin, US"],
    willingToRelocate: false,
    needsSponsorshipNonUs: false,
    gradDate: "2027-05-01",
    earliestStart: "2027-06-01",
  };

  it("accepts a complete location and timing payload", () => {
    const result = step3Schema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("rejects when there are no target locations", () => {
    const result = step3Schema.safeParse({ ...base, targetLocations: [] });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0].path[0]).toBe("targetLocations");
  });

  it("rejects a grad date that is not a real date", () => {
    const result = step3Schema.safeParse({ ...base, gradDate: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing current city", () => {
    const result = step3Schema.safeParse({ ...base, currentCity: "" });
    expect(result.success).toBe(false);
  });
});

describe("step4Schema", () => {
  const base = {
    salaryExpectation: "market rate",
    subjectToRestrictiveCovenant: false,
    relativesAtTargetEmployers: false,
    previouslyEmployedAtTargetEmployers: false,
    clearanceEligibility: "eligible",
    clearanceLevelHeld: "never_held",
    highSchoolName: "Lincoln High School",
    highSchoolGradYear: 2021,
  };

  it("accepts a complete compliance and comp payload", () => {
    const result = step4Schema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("rejects an active clearance that says never held", () => {
    const result = step4Schema.safeParse({
      ...base,
      clearanceEligibility: "active_clearance",
      clearanceLevelHeld: "never_held",
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0].path[0]).toBe("clearanceLevelHeld");
  });

  it("accepts an active clearance with a real level", () => {
    const result = step4Schema.safeParse({
      ...base,
      clearanceEligibility: "active_clearance",
      clearanceLevelHeld: "secret",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a graduation year outside the bounds", () => {
    const result = step4Schema.safeParse({ ...base, highSchoolGradYear: 1800 });
    expect(result.success).toBe(false);
  });

  it("rejects a missing salary expectation", () => {
    const result = step4Schema.safeParse({ ...base, salaryExpectation: "" });
    expect(result.success).toBe(false);
  });
});

describe("step5Schema", () => {
  it("accepts an attestation of true", () => {
    const result = step5Schema.safeParse({ attestation: true });
    expect(result.success).toBe(true);
  });

  it("rejects when not attested", () => {
    const result = step5Schema.safeParse({ attestation: false });
    expect(result.success).toBe(false);
  });
});
