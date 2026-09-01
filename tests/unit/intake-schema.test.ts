/**
 * The intake schema is the last thing standing between a half filled form and a
 * pipeline that fills real application forms from it, so what it rejects
 * matters at least as much as what it accepts. HARD STOP 9 in CLAUDE.md is the
 * reason: nothing downstream is allowed to invent a fact to cover a gap, which
 * only works if the gaps are caught here.
 */

import { describe, expect, it } from "vitest";

import { intakeFieldErrors, intakeSchema } from "@/lib/onboarding/intake-schema";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555";
const RESUME_PATH = `${USER_ID}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf`;
const LINKEDIN_PATH = `${USER_ID}/ffffffff-1111-4222-8333-444444444444.pdf`;

const schema = intakeSchema(USER_ID);

/** A complete, internally consistent submission. Every test starts here. */
function validIntake() {
  return {
    citizenshipStatus: "f1" as const,
    f1Status: "opt" as const,
    workAuthorizedUs: true,
    requiresSponsorship: true,
    needsSponsorshipNonUs: true,
    visaStatus: "F-1, currently on OPT",
    clearanceEligibility: "no" as const,
    clearanceLevelHeld: "never_held" as const,
    streetAddress: "12 Peachtree Street NE",
    currentCity: "Atlanta",
    postalCode: "30303",
    currentCountry: "United States",
    willingToRelocate: true,
    targetLocations: ["San Francisco", "New York", "Remote"],
    gradDate: "2027-05-15",
    earliestStart: "2027-06-01",
    highSchoolName: "Northview High School",
    highSchoolGradYear: 2022,
    subjectToRestrictiveCovenant: false,
    relativesAtTargetEmployers: false,
    previouslyEmployedAtTargetEmployers: false,
    salaryExpectation: "$120,000, or negotiable",
    resumePath: RESUME_PATH,
    linkedinPdfPath: LINKEDIN_PATH,
    githubUrl: "https://github.com/pranavlende",
    attestation: true as const,
  };
}

/** The field names a failed parse complained about. */
function failedFields(input: unknown): string[] {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) return [];
  return Object.keys(intakeFieldErrors(result.error)).sort();
}

describe("intakeSchema", () => {
  it("accepts a complete valid submission", () => {
    const result = schema.safeParse(validIntake());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.targetLocations).toEqual([
      "San Francisco",
      "New York",
      "Remote",
    ]);
    expect(result.data.attestation).toBe(true);
  });

  it("accepts a submission with no LinkedIn export", () => {
    const result = schema.safeParse({
      ...validIntake(),
      linkedinPdfPath: null,
    });

    expect(result.success).toBe(true);
  });

  it("rejects an empty submission and names every missing field", () => {
    // No f1Status and no linkedinPdfPath in this list, and that is correct.
    // Both default to null, so an empty submission is not missing them; the F1
    // sub status only becomes required once the citizenship answer asks for it.
    //
    // JOB-310 lazy loaded six of these out of intake: highSchoolGradYear,
    // highSchoolName, previouslyEmployedAtTargetEmployers,
    // relativesAtTargetEmployers, salaryExpectation and
    // subjectToRestrictiveCovenant all default to null now, the same way
    // f1Status and linkedinPdfPath already did, so none of them belongs in
    // this list any more either.
    //
    // JOB-330 lazy loaded resumePath out too: the second lane on step 1 of
    // onboarding lets a person paste a LinkedIn URL and finish the rest
    // of intake without a PDF right now (they upload later via the
    // follow-up email's deep link). The "either lane taken" rule is
    // enforced server side in `submitIntake`, not in this schema, and
    // the pipeline gate refuses to open a browser at any listing until a
    // real `resumes` row exists (HARD STOP 9). So resumePath is optional
    // here now, matching the other lazy loaded fields above.
    expect(failedFields({})).toEqual([
      "attestation",
      "citizenshipStatus",
      "clearanceEligibility",
      "clearanceLevelHeld",
      "currentCity",
      "currentCountry",
      "earliestStart",
      "gradDate",
      "needsSponsorshipNonUs",
      "postalCode",
      "requiresSponsorship",
      "streetAddress",
      "targetLocations",
      "visaStatus",
      "willingToRelocate",
      "workAuthorizedUs",
    ]);
  });

  it("accepts a submission with no resume path (JOB-330 deferred lane)", () => {
    // The second lane on step 1 lets a person paste a LinkedIn URL
    // instead of uploading a PDF. Step 5's client validation and
    // `submitIntake`'s server parse both call this schema, and both
    // must accept `resumePath: null` so a deferred-lane person can
    // reach attestation. `submitIntake` then checks that either
    // `intake.resumePath` OR `profiles.linkedin_url_pending` is set;
    // that server-side check is what actually enforces HARD STOP 9
    // together with the pipeline gate in
    // `inngest/job-application-pipeline.ts`.
    const result = schema.safeParse({ ...validIntake(), resumePath: null });
    expect(result.success).toBe(true);
  });

  it.each([
    "citizenshipStatus",
    "workAuthorizedUs",
    "requiresSponsorship",
    "needsSponsorshipNonUs",
    "visaStatus",
    "clearanceEligibility",
    "clearanceLevelHeld",
    "streetAddress",
    "currentCity",
    "postalCode",
    "currentCountry",
    "willingToRelocate",
    "targetLocations",
    "gradDate",
    "earliestStart",
    // JOB-330 moved resumePath off this list: the second lane on step 1
    // lets a person attest without a PDF right now, and the "either
    // lane taken" rule is enforced server-side in `submitIntake`, not
    // by the schema. See the JOB-330 acceptance test above and the
    // pipeline gate in `inngest/job-application-pipeline.ts`.
    "attestation",
  ])("rejects a submission missing %s", (field) => {
    const input: Record<string, unknown> = validIntake();
    delete input[field];

    expect(failedFields(input)).toContain(field);
  });

  // JOB-310: the mirror of the six-field removal above. Deleting any one of
  // these from an otherwise complete submission must not fail it, which is
  // the acceptance bar the ticket names: skipping them still lets intake
  // complete and attested_at stamp.
  describe("JOB-310: lazy loaded compliance fields", () => {
    it.each([
      "salaryExpectation",
      "highSchoolName",
      "highSchoolGradYear",
      "subjectToRestrictiveCovenant",
      "relativesAtTargetEmployers",
      "previouslyEmployedAtTargetEmployers",
    ])("accepts a submission missing %s", (field) => {
      const input: Record<string, unknown> = validIntake();
      delete input[field];

      const result = schema.safeParse(input);
      expect(result.success, `field ${field}`).toBe(true);
    });

    it("accepts a minimum viable submission with none of the six answered", () => {
      const input = validIntake() as Record<string, unknown>;
      delete input.salaryExpectation;
      delete input.highSchoolName;
      delete input.highSchoolGradYear;
      delete input.subjectToRestrictiveCovenant;
      delete input.relativesAtTargetEmployers;
      delete input.previouslyEmployedAtTargetEmployers;

      const result = schema.safeParse(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.salaryExpectation).toBeNull();
      expect(result.data.highSchoolName).toBeNull();
      expect(result.data.highSchoolGradYear).toBeNull();
      expect(result.data.subjectToRestrictiveCovenant).toBeNull();
      expect(result.data.relativesAtTargetEmployers).toBeNull();
      expect(result.data.previouslyEmployedAtTargetEmployers).toBeNull();
      // The attestation itself still requires the one field JOB-310 kept.
      expect(result.data.clearanceEligibility).toBe("no");
    });
  });

  it("rejects blank and whitespace only text", () => {
    expect(
      failedFields({ ...validIntake(), currentCity: "   " })
    ).toContain("currentCity");
  });

  it("rejects an empty list of target locations", () => {
    expect(
      failedFields({ ...validIntake(), targetLocations: [] })
    ).toContain("targetLocations");
  });

  it("rejects a date that is not a date", () => {
    expect(failedFields({ ...validIntake(), gradDate: "May 2027" })).toContain(
      "gradDate"
    );
  });

  it("rejects an unchecked attestation, which is the whole point of it", () => {
    expect(failedFields({ ...validIntake(), attestation: false })).toContain(
      "attestation"
    );
  });

  describe("F1 sub status", () => {
    it("requires one when the citizenship status is F1", () => {
      expect(
        failedFields({ ...validIntake(), citizenshipStatus: "f1", f1Status: null })
      ).toContain("f1Status");
    });

    it("refuses one when the citizenship status is not F1", () => {
      expect(
        failedFields({
          ...validIntake(),
          citizenshipStatus: "h1b",
          f1Status: "opt",
        })
      ).toContain("f1Status");
    });

    it("accepts each of the three F1 answers", () => {
      for (const f1Status of ["opt", "cpt", "none"]) {
        const result = schema.safeParse({ ...validIntake(), f1Status });
        expect(result.success, `f1Status ${f1Status}`).toBe(true);
      }
    });
  });

  describe("answers that contradict each other", () => {
    // Two answers that cannot both be true would become two answers on one
    // employer's form that cannot both be true, under someone's real name.
    it("rejects a US citizen who says they are not authorized to work", () => {
      expect(
        failedFields({
          ...validIntake(),
          citizenshipStatus: "us_citizen",
          f1Status: null,
          workAuthorizedUs: false,
          requiresSponsorship: false,
        })
      ).toContain("workAuthorizedUs");
    });

    it("rejects a permanent resident who says they need sponsorship", () => {
      expect(
        failedFields({
          ...validIntake(),
          citizenshipStatus: "permanent_resident",
          f1Status: null,
          workAuthorizedUs: true,
          requiresSponsorship: true,
        })
      ).toContain("requiresSponsorship");
    });

    it("allows an F1 holder to be authorized now and still need sponsorship later", () => {
      const result = schema.safeParse({
        ...validIntake(),
        citizenshipStatus: "f1",
        f1Status: "opt",
        workAuthorizedUs: true,
        requiresSponsorship: true,
      });

      expect(result.success).toBe(true);
    });
  });

  describe("storage paths", () => {
    it("rejects a path in another user's folder", () => {
      expect(
        failedFields({
          ...validIntake(),
          resumePath: `${OTHER_USER_ID}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf`,
        })
      ).toContain("resumePath");
    });

    it("rejects a path that tries to climb out of the folder", () => {
      expect(
        failedFields({ ...validIntake(), resumePath: `${USER_ID}/../secrets.pdf` })
      ).toContain("resumePath");
    });

    it("rejects a bucket qualified path, which is the database's spelling and not Storage's", () => {
      expect(
        failedFields({ ...validIntake(), resumePath: `resumes/${RESUME_PATH}` })
      ).toContain("resumePath");
    });

    it("rejects a LinkedIn path in another user's folder", () => {
      expect(
        failedFields({
          ...validIntake(),
          linkedinPdfPath: `${OTHER_USER_ID}/ffffffff-1111-4222-8333-444444444444.pdf`,
        })
      ).toContain("linkedinPdfPath");
    });
  });

  // JOB-230. Optional, so a submission with none is not a rejected one, but
  // whatever is given has to actually be a GitHub URL: `candidateValueForField`
  // in `lib/ashby-direct-submit.ts` trusts this column outright once it is
  // set, per HARD STOP 9, so nothing that is not really a GitHub link should
  // ever land in it.
  describe("GitHub URL", () => {
    it("accepts a submission with no GitHub URL", () => {
      const result = schema.safeParse({ ...validIntake(), githubUrl: null });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.githubUrl).toBeNull();
    });

    it("treats an empty string the same as none given", () => {
      const result = schema.safeParse({ ...validIntake(), githubUrl: "" });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.githubUrl).toBeNull();
    });

    it("accepts a full https URL unchanged", () => {
      const result = schema.safeParse({
        ...validIntake(),
        githubUrl: "https://github.com/pranavlende",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.githubUrl).toBe("https://github.com/pranavlende");
    });

    it("normalizes a bare github.com handle to a real https URL", () => {
      const result = schema.safeParse({
        ...validIntake(),
        githubUrl: "github.com/pranavlende",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.githubUrl).toBe("https://github.com/pranavlende");
    });

    it("rejects a URL from a different domain", () => {
      expect(
        failedFields({
          ...validIntake(),
          githubUrl: "https://gitlab.com/pranavlende",
        })
      ).toContain("githubUrl");
      expect(
        failedFields({
          ...validIntake(),
          githubUrl: "https://linkedin.com/in/pranavlende",
        })
      ).toContain("githubUrl");
    });

    it("rejects a GitHub domain with nothing after it", () => {
      expect(
        failedFields({ ...validIntake(), githubUrl: "https://github.com" })
      ).toContain("githubUrl");
    });
  });

  describe("EEO and demographic data", () => {
    // HARD STOP 10. There is nowhere to put this, on purpose, and a schema that
    // silently accepted it would be the first step to somewhere to put it.
    it("does not carry a field for race, gender, veteran or disability status", () => {
      const result = schema.safeParse({
        ...validIntake(),
        race: "prefer not to say",
        gender: "prefer not to say",
        veteranStatus: "no",
        disabilityStatus: "no",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(Object.keys(result.data).sort()).toEqual(
        Object.keys(validIntake()).sort()
      );
    });
  });
});
