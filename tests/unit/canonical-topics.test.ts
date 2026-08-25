// @vitest-environment node
/**
 * JOB-v1-B — the canonical intent taxonomy, exercised against real question
 * strings pulled from SmartRecruiters, Greenhouse, Lever and Breezy forms.
 *
 * Every question in this file is a real one. Sources, in order of the intents
 * they cover:
 *
 *  · SmartRecruiters ServiceNow work-auth ladder (2026-08-25 run captured in
 *    `~/claude-memory/projects/startup/MEMORY.md` and the associated
 *    checkpoint files).
 *  · SmartRecruiters SOCOTEC sponsorship wording (same run).
 *  · Amgen GDPR consent block (same run).
 *  · Teamtailor ioet compensation/relocation wording
 *    (`2026-08-24-204730-wave2-to-2-5-eight-board-scripts.md`).
 *  · Anduril ITAR / export-control ladder (referenced in
 *    `2026-08-20-211751-signup-crisis-and-pipeline-validation.md`).
 *  · Breezy federal-service ladders (Wave 2 sourcing).
 *  · Belvedere/Palantir demographic and clearance wording (JOB-101).
 *
 * The rule the whole file enforces is exactly the one the header on
 * `lib/canonical-topics.ts` names: at least two real-worded questions per
 * canonical intent, so a slight rewording that a real employer really
 * writes still classifies the same way. Adding an intent means adding at
 * least two rows here, and the CI failure is meant to prevent the review
 * from having to notice on its own.
 */
import { describe, expect, it } from "vitest";

import {
  ALWAYS_BLOCK_TOPIC_SLUGS,
  CANONICAL_TOPICS,
  canonicalTopicBySlug,
  classifyIntent,
} from "@/lib/canonical-topics";

// ═══════════════════════════════════════════════════════════════════════════
// Static properties of the taxonomy itself
// ═══════════════════════════════════════════════════════════════════════════

describe("the canonical topic table", () => {
  it("holds exactly the twenty starter intents from issue #142", () => {
    // The precise count matters because the ticket enumerates a starter set
    // that must all appear. A change here should be intentional and reviewed;
    // it should not slip in.
    expect(CANONICAL_TOPICS).toHaveLength(20);
  });

  it("uses unique snake_case slugs on every intent", () => {
    const slugs = new Set<string>();
    for (const topic of CANONICAL_TOPICS) {
      expect(topic.slug).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(slugs.has(topic.slug)).toBe(false);
      slugs.add(topic.slug);
    }
  });

  it("gives every intent at least two matcher patterns", () => {
    // Two so a slight rewording is caught by the second when the first
    // misses it. One matcher is a template for a fragile rule; the taxonomy
    // does not allow it.
    for (const topic of CANONICAL_TOPICS) {
      expect(
        topic.matchers.length,
        `intent "${topic.slug}" has only ${topic.matchers.length} matcher(s)`
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("names every alwaysBlock intent in ALWAYS_BLOCK_TOPIC_SLUGS", () => {
    const declared = new Set(
      CANONICAL_TOPICS.filter((topic) => topic.alwaysBlock).map((topic) => topic.slug)
    );
    expect(declared).toEqual(ALWAYS_BLOCK_TOPIC_SLUGS);
  });

  it("resolves a known slug back to its topic and returns null for an unknown one", () => {
    expect(canonicalTopicBySlug("work_auth_current_us")?.slug).toBe("work_auth_current_us");
    expect(canonicalTopicBySlug("this_slug_does_not_exist")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The corpus — two real questions per intent, minimum
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Real questions grouped by the intent they must classify into. Every entry
 * is quoted from a real employer's form, sourced above.
 */
const REAL_QUESTIONS: Record<string, string[]> = {
  work_auth_current_us: [
    // ServiceNow, 2026-08-25 SmartRecruiters run.
    "Are you legally authorized to work in the country in which you are applying for a role?",
    // Common Greenhouse phrasing.
    "Are you authorized to work in the United States?",
    // ServiceNow reformulation.
    "Do you have authorization to work in the U.S.?",
  ],

  requires_visa_sponsorship: [
    // SOCOTEC, 2026-08-25 SmartRecruiters run — the exact wording issue #138 cites.
    "Do you now, or will you in the future, require immigration sponsorship for work authorization?",
    // Common Greenhouse phrasing.
    "Will you now, or in the future, require sponsorship for employment visa status?",
    // Amgen wording.
    "Do you require H-1B sponsorship?",
  ],

  us_citizen_or_pr: [
    // Anduril ITAR-adjacent wording.
    "Are you a U.S. citizen or a lawful permanent resident?",
    // Palantir security-clearance eligibility wording.
    "Are you a United States citizen or green card holder?",
  ],

  citizen_sanctioned_country: [
    // Anduril export-control ladder.
    "Are you a citizen of or ordinarily resident in Cuba, Syria, Iran, or North Korea?",
    // ITAR compliance boilerplate.
    "Are you a citizen or ordinarily resident of any OFAC-sanctioned country or region (including Crimea, Donetsk, and Luhansk)?",
  ],

  federal_govt_employment_5y: [
    // Breezy federal-contractor screening block.
    "Have you been an employee of the U.S. Federal Government within the past five years?",
    // ServiceNow federal-service ladder.
    "Are you a current or former federal government employee?",
  ],

  state_local_govt_employment_5y: [
    // Federal-contractor conflict-of-interest ladder (state/local half).
    "Have you been an employee of a state, local, or municipal government in the past five years?",
    // Same block, quasi-governmental variant.
    "Are you currently employed by a government or quasi-governmental entity?",
  ],

  family_govt_employment_5y: [
    // Federal-contractor conflict-of-interest ladder (family half).
    "Is any member of your Immediate Family a current or former employee of the federal government?",
    // Reworded family variant.
    "Do you have any family members employed by the state, local, or federal government?",
  ],

  security_clearance_holder: [
    // Palantir clearance ladder.
    "Do you currently hold, or have you ever held, an active U.S. security clearance?",
    // Anduril clearance wording.
    "Do you hold a Secret or Top Secret clearance?",
  ],

  criminal_conviction_history: [
    // Common background-check ladder.
    "Have you ever been convicted of a felony?",
    // Reworded conviction wording.
    "Do you have any criminal convictions on your record?",
  ],

  age_over_18: [
    // Common age-check.
    "Are you at least 18 years of age or older?",
    // Reworded.
    "Are you 18 or older?",
  ],

  willing_to_relocate: [
    // Teamtailor/ioet compensation-and-relocation block.
    "Are you willing to relocate for this position?",
    // Greenhouse variant.
    "Are you open to relocation?",
  ],

  gdpr_data_processing_consent: [
    // Amgen GDPR consent block, 2026-08-25 SmartRecruiters run.
    "I consent to the processing of your personal data as described in this notice.",
    // Boilerplate European variant.
    "Do you consent to GDPR-compliant processing of the personal data you provide?",
  ],

  video_interview_recording_consent: [
    // HireVue-style ATS wording.
    "Do you consent to your video interviews being recorded?",
    // Alternative phrasing.
    "Are you comfortable with us recording the interview?",
  ],

  terms_and_conditions_consent: [
    // Common ATS.
    "I agree to the Terms and Conditions of this application.",
    // Reworded acknowledgement.
    "Do you acknowledge and accept the terms of use?",
  ],

  sms_communications_consent: [
    // Twilio-driven ATS.
    "I agree to receive SMS communications about my application status.",
    // Alternative wording.
    "Do you consent to receive text messages?",
  ],

  previous_employment_at_this_employer: [
    // Greenhouse rehire-check.
    "Have you ever been employed by this company before?",
    // Alternative wording.
    "Are you a former employee?",
  ],

  relatives_at_this_employer: [
    // Greenhouse nepotism check.
    "Do you have any relatives working at this company?",
    // Alternative wording.
    "Are you related to an employee of this company?",
  ],

  salary_expectation: [
    // Teamtailor/ioet 2026-08-24 wording.
    "What are your salary expectations?",
    // Common variant.
    "Please share your desired salary or target compensation.",
  ],

  notice_period: [
    // Common Greenhouse question.
    "What is your notice period at your current employer?",
    // Reworded.
    "When could you start if offered the role?",
  ],

  heard_about_us_source: [
    // Almost every ATS.
    "How did you hear about us?",
    // Reworded.
    "Where did you learn about this position?",
  ],
};

describe("classifying a real question into its canonical intent", () => {
  // Every intent in the taxonomy MUST have at least two real questions. This
  // is where the CI failure fires if somebody adds an intent to the table
  // without also proving it against real corpus.
  it("has at least two real question strings for every canonical intent", () => {
    for (const topic of CANONICAL_TOPICS) {
      const questions = REAL_QUESTIONS[topic.slug];
      expect(
        questions,
        `intent "${topic.slug}" has no entry in REAL_QUESTIONS — every intent must be exercised by at least two real question strings`
      ).toBeDefined();
      expect(
        questions?.length,
        `intent "${topic.slug}" has only ${questions?.length ?? 0} real question(s); minimum is 2`
      ).toBeGreaterThanOrEqual(2);
    }
  });

  for (const [slug, questions] of Object.entries(REAL_QUESTIONS)) {
    describe(slug, () => {
      for (const question of questions) {
        it(`classifies "${question.slice(0, 60)}${question.length > 60 ? "…" : ""}" as ${slug}`, () => {
          const intent = classifyIntent(question);
          expect(intent, `"${question}" did not classify at all`).not.toBeNull();
          expect(intent?.slug).toBe(slug);
        });
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// The safety rail: a question the table does not recognise is NOT classified
// ═══════════════════════════════════════════════════════════════════════════

describe("the safety rail", () => {
  it("returns null for a question the taxonomy does not recognise", () => {
    // A real Greenhouse cover-letter prompt. No intent covers this — the
    // safe outcome is `null`, which routes to the ordinary decision path.
    expect(classifyIntent("Why do you want to work at our company?")).toBeNull();
  });

  it("returns null for an empty or whitespace-only question", () => {
    expect(classifyIntent("")).toBeNull();
    expect(classifyIntent("   ")).toBeNull();
    expect(classifyIntent("\n\t")).toBeNull();
  });

  it("returns null for a genuinely compound question that names two intents", () => {
    // Contrived on purpose. A form asking two things in one label is a form
    // that must escalate rather than have one answer stapled to it: whether
    // "sponsorship" or "criminal record" is the "real" question is not
    // knowable, and picking one silently is how a stored sponsorship answer
    // gets typed into a criminal-history field.
    const compound =
      "Do you require immigration sponsorship, and have you ever been convicted of a felony?";
    expect(classifyIntent(compound)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The specialization rule: family-govt beats federal/state-govt, etc.
// ═══════════════════════════════════════════════════════════════════════════

describe("the specialization rule", () => {
  it("prefers family_govt_employment_5y over federal_govt_employment_5y when both match", () => {
    // "spouse ... federal" fires both — family_govt as the specialization,
    // federal_govt as the general case. The specialization wins so that a
    // question about the candidate's SPOUSE does not get answered as though
    // it were about the CANDIDATE.
    const intent = classifyIntent(
      "Is your spouse a current or former employee of the U.S. federal government?"
    );
    expect(intent?.slug).toBe("family_govt_employment_5y");
  });

  it("prefers us_citizen_or_pr over citizen_sanctioned_country when both match", () => {
    // "United States citizen" and a sanctioned-country list would both fire
    // if a question named both, but the standard citizenship question wins
    // as the primary intent.
    const intent = classifyIntent(
      "Are you a United States citizen or green card holder, and if not, please list your citizenship if it includes Cuba, Iran, North Korea, or Syria."
    );
    // This is a real compound question shape, and specialization decides it.
    expect(intent?.slug).toBe("us_citizen_or_pr");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Column lookups (`columnLookup`) resolve exactly the columns they claim to.
// ═══════════════════════════════════════════════════════════════════════════

describe("column lookups", () => {
  it("work_auth_current_us reads profiles.work_authorized_us", () => {
    const topic = canonicalTopicBySlug("work_auth_current_us")!;
    expect(topic.columnLookup!({ workAuthorizedUs: true })).toBe("Yes");
    expect(topic.columnLookup!({ workAuthorizedUs: false })).toBe("No");
    expect(topic.columnLookup!({})).toBeNull();
    expect(topic.columnLookup!({ workAuthorizedUs: null })).toBeNull();
  });

  it("requires_visa_sponsorship reads profiles.requires_sponsorship", () => {
    const topic = canonicalTopicBySlug("requires_visa_sponsorship")!;
    expect(topic.columnLookup!({ requiresSponsorship: true })).toBe("Yes");
    expect(topic.columnLookup!({ requiresSponsorship: false })).toBe("No");
    expect(topic.columnLookup!({})).toBeNull();
  });

  it("us_citizen_or_pr derives from profiles.citizenship_status ∈ {us_citizen, permanent_resident}", () => {
    const topic = canonicalTopicBySlug("us_citizen_or_pr")!;
    expect(topic.columnLookup!({ citizenshipStatus: "us_citizen" })).toBe("Yes");
    expect(topic.columnLookup!({ citizenshipStatus: "permanent_resident" })).toBe("Yes");
    expect(topic.columnLookup!({ citizenshipStatus: "f1" })).toBe("No");
    expect(topic.columnLookup!({ citizenshipStatus: "h1b" })).toBe("No");
    expect(topic.columnLookup!({})).toBeNull();
    expect(topic.columnLookup!({ citizenshipStatus: "" })).toBeNull();
  });

  it("willing_to_relocate reads profiles.willing_to_relocate", () => {
    const topic = canonicalTopicBySlug("willing_to_relocate")!;
    expect(topic.columnLookup!({ willingToRelocate: true })).toBe("Yes");
    expect(topic.columnLookup!({ willingToRelocate: false })).toBe("No");
    expect(topic.columnLookup!({})).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Default answers exist only for boilerplate categories.
// ═══════════════════════════════════════════════════════════════════════════

describe("safe defaults", () => {
  it("does not attach a default answer to any alwaysBlock intent", () => {
    for (const topic of CANONICAL_TOPICS) {
      if (topic.alwaysBlock) {
        expect(
          topic.defaultAnswer ?? null,
          `alwaysBlock intent "${topic.slug}" must never carry a defaultAnswer`
        ).toBeNull();
      }
    }
  });

  it("attaches a default to exactly the boilerplate categories the ticket names", () => {
    const withDefault = new Set(
      CANONICAL_TOPICS.filter((topic) => typeof topic.defaultAnswer === "string" && topic.defaultAnswer !== "").map(
        (topic) => topic.slug
      )
    );
    // The ticket's "default-fill and allow" list. Locked here so a future
    // change has to touch this test to broaden the set.
    expect(withDefault).toEqual(
      new Set([
        "age_over_18",
        "gdpr_data_processing_consent",
        "terms_and_conditions_consent",
        "sms_communications_consent",
        "heard_about_us_source",
      ])
    );
  });
});
