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

  // JOB-361: streetAddress and postalCode are optional now.
  describe("optional address fields", () => {
    it("accepts a payload missing both streetAddress and postalCode", () => {
      const input: Record<string, unknown> = { ...base };
      delete input.streetAddress;
      delete input.postalCode;

      const result = step3Schema.safeParse(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.streetAddress).toBeNull();
      expect(result.data.postalCode).toBeNull();
    });

    it("treats a blank streetAddress the same as none given", () => {
      const result = step3Schema.safeParse({ ...base, streetAddress: "" });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.streetAddress).toBeNull();
    });
  });

  // JOB-361: currentCountry defaults to "United States" for a US citizen,
  // and still has to be answered outright for anyone else.
  describe("currentCountry default", () => {
    it("defaults to United States for a US citizen who leaves it blank", () => {
      const input: Record<string, unknown> = { ...base };
      delete input.currentCountry;
      input.citizenshipStatus = "us_citizen";

      const result = step3Schema.safeParse(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.currentCountry).toBe("United States");
    });

    it("still requires an explicit answer for a non US citizenship", () => {
      const input: Record<string, unknown> = { ...base };
      delete input.currentCountry;
      input.citizenshipStatus = "h1b";

      const result = step3Schema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success)
        expect(
          result.error.issues.map((issue) => issue.path[0]),
        ).toContain("currentCountry");
    });

    it("still requires an explicit answer when citizenship is unknown", () => {
      const input: Record<string, unknown> = { ...base };
      delete input.currentCountry;

      const result = step3Schema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("keeps a real answer even for a US citizen rather than overwriting it", () => {
      const result = step3Schema.safeParse({
        ...base,
        currentCountry: "Puerto Rico",
        citizenshipStatus: "us_citizen",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.currentCountry).toBe("Puerto Rico");
    });
  });

  // JOB-361: willingToRelocate defaults to true once a target location has
  // been picked, since targetLocations is already required to be non-empty.
  describe("willingToRelocate default", () => {
    it("defaults to true when left unanswered", () => {
      const input: Record<string, unknown> = { ...base };
      delete input.willingToRelocate;

      const result = step3Schema.safeParse(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.willingToRelocate).toBe(true);
    });

    it("keeps an explicit no rather than overwriting it", () => {
      const result = step3Schema.safeParse({
        ...base,
        willingToRelocate: false,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.willingToRelocate).toBe(false);
    });
  });

  // JOB-361: earliestStart defaults to gradDate plus 30 days.
  describe("earliestStart default", () => {
    it("defaults to 30 days after gradDate when left unanswered", () => {
      const input: Record<string, unknown> = { ...base, gradDate: "2027-05-01" };
      delete input.earliestStart;

      const result = step3Schema.safeParse(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.earliestStart).toBe("2027-05-31");
    });

    it("keeps an explicit earliestStart rather than overwriting it", () => {
      const result = step3Schema.safeParse({
        ...base,
        gradDate: "2027-05-01",
        earliestStart: "2027-08-15",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.earliestStart).toBe("2027-08-15");
    });

    it("rolls a month boundary correctly", () => {
      const input: Record<string, unknown> = { ...base, gradDate: "2027-12-15" };
      delete input.earliestStart;

      const result = step3Schema.safeParse(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.earliestStart).toBe("2028-01-14");
    });
  });

  it("matches JOB-361's success criterion: a US citizen with a target location picked needs no other new answers", () => {
    // streetAddress and postalCode omitted (optional), currentCountry and
    // willingToRelocate omitted (defaulted), earliestStart omitted
    // (defaulted). currentCity, targetLocations and gradDate are outside
    // this ticket's scope and stay required and typed, the same as before.
    const result = step3Schema.safeParse({
      currentCity: "Austin",
      citizenshipStatus: "us_citizen",
      targetLocations: ["Austin, US"],
      needsSponsorshipNonUs: false,
      gradDate: "2027-05-01",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.currentCountry).toBe("United States");
    expect(result.data.willingToRelocate).toBe(true);
    expect(result.data.earliestStart).toBe("2027-05-31");
    expect(result.data.streetAddress).toBeNull();
    expect(result.data.postalCode).toBeNull();
  });
});

describe("step4Schema", () => {
  // JOB-310: only the clearance gate is required now. `base` intentionally
  // omits the other six JOB-134 fields to match what step 4's form actually
  // sends after this ticket.
  const base = {
    clearanceEligibility: "eligible",
    clearanceLevelHeld: "never_held",
  };

  it("accepts the minimum viable step 4: clearance gate alone", () => {
    const result = step4Schema.safeParse(base);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.salaryExpectation).toBeNull();
    expect(result.data.highSchoolName).toBeNull();
    expect(result.data.highSchoolGradYear).toBeNull();
    expect(result.data.subjectToRestrictiveCovenant).toBeNull();
    expect(result.data.relativesAtTargetEmployers).toBeNull();
    expect(result.data.previouslyEmployedAtTargetEmployers).toBeNull();
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

  it("rejects an empty submission, since clearance eligibility alone is still required", () => {
    const result = step4Schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path[0]);
      expect(paths).toContain("clearanceEligibility");
      expect(paths).toContain("clearanceLevelHeld");
    }
  });

  // The six lazy loaded fields still validate their shape when a value is
  // actually given, even though none of them is required any more.
  it("accepts every optional field fully filled in, unchanged from before", () => {
    const result = step4Schema.safeParse({
      ...base,
      salaryExpectation: "market rate",
      subjectToRestrictiveCovenant: false,
      relativesAtTargetEmployers: false,
      previouslyEmployedAtTargetEmployers: false,
      highSchoolName: "Lincoln High School",
      highSchoolGradYear: 2021,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a graduation year outside the bounds, when one is given", () => {
    const result = step4Schema.safeParse({ ...base, highSchoolGradYear: 1800 });
    expect(result.success).toBe(false);
  });

  it("treats a blank salary expectation the same as none given", () => {
    const result = step4Schema.safeParse({ ...base, salaryExpectation: "" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.salaryExpectation).toBeNull();
  });

  it("treats a blank high school name the same as none given", () => {
    const result = step4Schema.safeParse({ ...base, highSchoolName: "   " });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.highSchoolName).toBeNull();
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
