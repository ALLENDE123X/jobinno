// @vitest-environment node
/**
 * JOB-022: the answering policy, exercised against the questions that actually
 * stopped production.
 *
 * Every case in this file is taken from the run of 2026 08 20, in which the
 * pipeline reached the application form on 20 of 21 listings and then finished
 * none of them. Eighteen ended as `unanswerable_required`, and the reasons the
 * run wrote down are quoted in the tests below verbatim, because the point of
 * this file is that they were not unanswerable:
 *
 *  · "The degree completion year is not provided". `profiles.grad_date` held
 *    2025 12 31 and was never in the SELECT.
 *  · "U.S. person or qualifying immigration status is not provided".
 *    `profiles.citizenship_status` held "us_citizen" and was never in the SELECT.
 *  · "the option \"Bachelor's Degree\" does not say what the stored fact
 *    \"degree\" says (\"B.S.\")". The same statement, spelled two ways.
 *  · "No top location preference is provided". `profiles.target_locations` held
 *    four of them.
 *  · "The candidate's years of industry experience are not provided". The
 *    resume lists the jobs it would be counted from.
 *
 * The split this file is really testing is the one the product asked for: fill
 * it in and submit by default, and stop only for a legal attestation that the
 * candidate's own data does not answer and the form gives no way to decline.
 *
 * Nothing here opens a browser, calls a model or touches a database. Both
 * functions under test are pure, which is what makes this the right level for
 * them: `tests/unit/fill-application-form-flow.test.ts` owns the sequence.
 */
import { describe, expect, it } from "vitest";

import {
  blockedForAnswers,
  buildFactCatalog,
  countryContextTermsWithResumeFallback,
  currentCityWithResumeFallback,
  isAttestationField,
  isSmartRecruitersPostalCodeCombobox,
  isOngoingRole,
  resolveAdditionalAnswer,
  resolveDecision,
  fallbackRefusalReason,
  CONFIRM_EMAIL_RE,
  CURRENT_ROLE_CHECKBOX_RE,
  END_DATE_FIELD_RE,
  EXPERIENCE_SECTION_HEADING_RE,
  LEGAL_ATTESTATION_RE,
  type NeedsInputItem,
} from "@/lib/fill-application-form";
import type { CandidateApplicationAnswers } from "@/lib/candidate-intake";
import type { CandidateFact, FieldDecision, ResumeProfile } from "@/lib/resume-parser";
import { CONSENT_FIELD_RE, type EnumeratedField } from "@/lib/form-fields";
// JOB-134. The answer memory, exercised here rather than only in its own test
// file because what this ticket promises is a second run that does not ask, and
// that promise is only kept where the memory meets the fill layer's own rules.
import { rememberAnswers, withStoredAnswers } from "@/lib/candidate-answers";

/**
 * The real user's profile row, as production held it on the day of the run.
 *
 * Copied rather than invented, because the whole finding is that this data was
 * present and unread. Weakening it to a convenient fixture would test a
 * different system from the one that failed.
 */
const ANSWERS: CandidateApplicationAnswers = {
  workAuthorizedUs: true,
  requiresSponsorship: false,
  currentCountry: "United States",
  currentCity: "San Francisco",
  willingToRelocate: true,
  citizenshipStatus: "us_citizen",
  gradDate: "2025-12-31",
  earliestStart: "2026-08-20",
  targetLocations: ["San Francisco", "Remote", "Atlanta", "Austin"],
};

const PROFILE: ResumeProfile = {
  firstName: "Pat",
  lastName: "Example",
  email: "pat@example.com",
  phone: "+1 415 555 0142",
  location: "San Francisco, CA",
  linkedinUrl: "https://www.linkedin.com/in/pat-example",
  websiteUrl: "https://github.com/pat-example",
  // Null, deliberately: this fixture is the one used by "names the GitHub URL
  // that four separate forms asked for by name" below, which exists to prove
  // the *inference* off websiteUrl still works for a candidate who has not
  // stated a real githubUrl. A separate fixture covers the stated case.
  githubUrl: null,
  workHistory: [
    { company: "Northwind", title: "Software Engineering Intern", startDate: "Jun 2024", endDate: "Sep 2024", summary: "Built an ingest pipeline." },
    { company: "Contoso", title: "Student Researcher", startDate: "Jan 2023", endDate: "May 2023", summary: "Wrote evaluation tooling." },
  ],
  education: [
    { school: "Georgia Institute of Technology", degree: "B.S.", discipline: "Computer Science", endDate: "Dec 2025" },
  ],
  skills: ["TypeScript", "Python", "Postgres"],
  resumeStatedEmail: "pat@example.com",
  warnings: [],
};

function facts(overrides: Partial<CandidateApplicationAnswers> = {}): Map<string, CandidateFact> {
  const list = buildFactCatalog(PROFILE, { ...ANSWERS, ...overrides }, {});
  return new Map(list.map((fact) => [fact.key, fact]));
}

/**
 * The six options the Virtu "Location (City)" combobox offered, verbatim.
 *
 * Copied out of the `skip_log` row this feature failed on, in the order the run
 * quoted them, and not trimmed. The previous version of the city test used a
 * hand written three option subset, and the two options it happened to leave out
 * are the two that broke the matcher. A fixture that is a convenient subset of
 * the real thing tests a menu no board serves.
 */
const VIRTU_CITY_OPTIONS = [
  "San Francisco, California, United States",
  "San Francisco de Macorís, Duarte, Dominican Republic",
  "San Francisco, Agusan del Sur, Philippines",
  "San Francisco De Borja, Lima, Peru",
  "San Francisco, Cebu, Philippines",
  "South San Francisco, California, United States",
];

/**
 * The five options Anduril's EXPORT CONTROLS question offered, verbatim.
 *
 * From the `skip_log`, including the curly quotes around "Green Card" as the
 * board writes them.
 */
const ANDURIL_EXPORT_CONTROL_OPTIONS = [
  "A United States citizen or national",
  "A person lawfully admitted for permanent residence of the United States (i.e., “Green Card” holder)",
  "A person admitted as a refugee to the United States under 8 U.S.C. 1157",
  "A person admitted as an asylee to the United States under 8 U.S.C. 1158",
  "None of the above",
];

/**
 * Anduril's "What is your top location preference?" list, verbatim.
 *
 * Here for one reason: it contains "Boston, MA", and a bare two letter state
 * code is also a degree abbreviation.
 */
const ANDURIL_LOCATION_OPTIONS = [
  "Costa Mesa, CA (HQ)",
  "Irvine, CA",
  "Atlanta, GA",
  "Reston, VA",
  "Boston, MA",
  "Seattle, WA",
];

/**
 * A country dropdown, as every real one is built.
 *
 * Unlike the lists above this is NOT from a `skip_log` row: no country field
 * appears in the 21 logged rows, because no form in that run got far enough to
 * stop on one. It is the ISO 3166 short-name set that Greenhouse, Ashby and
 * Workday all serve, kept complete around the confusable entries rather than
 * trimmed to the ones under test. The trimming is the bug.
 */
const COUNTRY_OPTIONS = [
  "Equatorial Guinea",
  "Guinea",
  "Guinea-Bissau",
  "Papua New Guinea",
  "Congo, Democratic Republic of the",
  "Congo, Republic of the",
  "Georgia",
  "South Georgia and the South Sandwich Islands",
  "India",
  "British Indian Ocean Territory",
  "Korea, Republic of",
  "United States",
  "United States Minor Outlying Islands",
];

/** One control, with the boring parts of `EnumeratedField` filled in. */
function field(over: Partial<EnumeratedField> & { label: string }): EnumeratedField {
  return {
    key: over.label.toLowerCase(),
    selector: "#x",
    activateSelectors: ["#x"],
    kind: "text",
    required: true,
    currentValue: "",
    options: [],
    optionSelectors: [],
    optionValues: [],
    optionsKnown: false,
    optionsTruncated: false,
    maxLength: null,
    helpText: "",
    ...over,
  };
}

function decision(over: Partial<FieldDecision> & { fieldKey: string }): FieldDecision {
  return { decision: "answer", value: null, sourceFact: null, question: null, why: "", ...over };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("the fact catalogue carries what the person actually told us", () => {
  it("knows the graduation year and month, which stopped two Anduril forms", () => {
    const known = facts();
    expect(known.get("graduationYear")?.value).toBe("2025");
    expect(known.get("graduationMonth")?.value).toBe("December");
  });

  it("knows the earliest start date behind every \"Pick date...\" field", () => {
    expect(facts().get("earliestStartDate")?.value).toBe("2026-08-20");
  });

  it("states the export control and visa answer in the words a form uses", () => {
    // The Anduril and Virtu forms offer "A United States citizen or national"
    // verbatim. Storing "us_citizen" and expecting a model to bridge to that on
    // a legal attestation is the wrong place to put the bridge.
    expect(facts().get("citizenshipStatus")?.value).toBe("A United States citizen or national");
    expect(facts({ citizenshipStatus: "f1", f1Status: "opt" }).get("citizenshipStatus")?.value).toContain(
      "F-1"
    );
  });

  it("knows the location preferences the run reported as not provided", () => {
    expect(facts().get("topLocationPreference")?.value).toBe("San Francisco");
    expect(facts().get("targetLocations")?.value).toContain("Atlanta");
  });

  it("counts years of experience off the resume rather than asking for them", () => {
    // Two internships, Jan to May 2023 and Jun to Sep 2024. Summed, not spanned:
    // that is roughly nine months of work, so the honest whole-number answer is
    // zero. The old code measured earliest start to latest end and returned "1",
    // counting the fourteen month gap between two summer jobs as experience.
    expect(facts().get("yearsOfExperience")?.value).toBe("0");
  });

  it("does not count the gap between two internships as experience", () => {
    // The regression, at the scale it actually bites. A new grad whose resume
    // shows a 2019 summer internship and a job started in 2025 got "7" from the
    // span rule, and it was typed into three separate forms as a stated fact.
    // Seven years of industry experience is not a rounding error on a real
    // application, it is a different person.
    const spanned = buildFactCatalog(
      {
        ...PROFILE,
        workHistory: [
          { company: "Summer Co", title: "Intern", startDate: "Jun 2019", endDate: "Sep 2019", summary: "" },
          { company: "Now Inc", title: "Engineer", startDate: "Jun 2025", endDate: "Present", summary: "" },
        ],
      },
      ANSWERS,
      {}
    );
    const years = new Map(spanned.map((f) => [f.key, f])).get("yearsOfExperience")?.value;
    expect(years).not.toBe("7");
    expect(Number(years)).toBeLessThanOrEqual(2);
  });

  it("merges overlapping jobs instead of double counting them", () => {
    // Two concurrent roles are one stretch of somebody's life, not two.
    const overlapping = buildFactCatalog(
      {
        ...PROFILE,
        workHistory: [
          { company: "A", title: "Engineer", startDate: "Jan 2019", endDate: "Jan 2023", summary: "" },
          { company: "B", title: "Advisor", startDate: "Jan 2020", endDate: "Jan 2022", summary: "" },
        ],
      },
      ANSWERS,
      {}
    );
    expect(new Map(overlapping.map((f) => [f.key, f])).get("yearsOfExperience")?.value).toBe("4");
  });

  it("names the GitHub URL that four separate forms asked for by name", () => {
    expect(facts().get("githubUrl")?.value).toBe("https://github.com/pat-example");
  });

  it("prefers a stated githubUrl over one inferred from websiteUrl or linkedinUrl", () => {
    // JOB-044. `profile.githubUrl` is the candidate's own stated answer
    // (`profiles.github_url`, read through `CandidateRecord`), and it must win
    // even when the inferred URL below points somewhere real too — the stated
    // one is the one the candidate actually meant.
    const stated = buildFactCatalog(
      { ...PROFILE, githubUrl: "https://github.com/pat-real-account" },
      ANSWERS,
      {}
    );
    expect(new Map(stated.map((f) => [f.key, f])).get("githubUrl")?.value).toBe(
      "https://github.com/pat-real-account"
    );
  });

  it("carries every education entry, not only the first", () => {
    const twoDegrees: ResumeProfile = {
      ...PROFILE,
      education: [
        ...PROFILE.education,
        { school: "City College", degree: "Associate's", discipline: "Maths", endDate: "May 2023" },
      ],
    };
    const known = new Map(buildFactCatalog(twoDegrees, ANSWERS, {}).map((f) => [f.key, f]));
    expect(known.get("education1.school")?.value).toBe("City College");
  });

  it("leaves out what nobody stated, rather than filling it with a placeholder", () => {
    const known = facts({ citizenshipStatus: undefined, gradDate: undefined });
    expect(known.has("citizenshipStatus")).toBe(false);
    expect(known.has("graduationYear")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("which questions are legal attestations", () => {
  it.each([
    "Are you legally authorized to work in the United States?",
    "What is your current visa status?",
    "Will you now or in the future require sponsorship?",
    "CLEARANCE ELIGIBILITY - This position may require eligibility to obtain and maintain a U.S. security clearance.",
    "EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls.",
    "Have you ever been convicted of a felony?",
    "Are you a citizen or national of the United States?",
  ])("treats %j as one", (label) => {
    expect(LEGAL_ATTESTATION_RE.test(label)).toBe(true);
    expect(isAttestationField(label)).toBe(true);
  });

  it.each([
    "School",
    "Degree",
    "End date year",
    "What is your top location preference?",
    "How did you hear about Anduril?",
    "How many years of industry experience do you have?",
    "Pick date...",
    "Please link your Github profile",
    "Can you work on-site in San Francisco during the week?",
  ])("does not treat %j as one", (label) => {
    expect(isAttestationField(label)).toBe(false);
  });

  it("still catches demographic questions through the EEO rule", () => {
    expect(isAttestationField("Gender")).toBe(true);
    expect(isAttestationField("Are you a protected veteran?")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("an ordinary required field is answered rather than escalated", () => {
  it("takes the model's best answer when no fact backs it exactly", () => {
    // Before JOB-022 an `infer` did not exist and an `ask` was final, so this
    // field ended the application. It is the single most common shape in the
    // 18 blocked runs.
    const resolution = resolveDecision(
      field({ label: "How did you hear about Anduril?", kind: "select", options: ["Google job search", "BuiltIn", "Indeed"], optionsKnown: true }),
      decision({ fieldKey: "how did you hear about anduril?", decision: "infer", value: "Google job search", why: "no fact records this" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Google job search");
      expect(resolution.declined).toBe(false);
    }
  });

  it("overrules the model asking to escalate an ordinary question", () => {
    const resolution = resolveDecision(
      field({ label: "What is your top location preference?", kind: "select", options: ["Costa Mesa, CA (HQ)", "Atlanta, GA", "Seattle, WA"], optionsKnown: true }),
      decision({ fieldKey: "what is your top location preference?", decision: "ask", value: "Atlanta, GA", question: "Where would you prefer?", why: "No top location preference is provided." }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
  });

  it("writes an answer for a short answer box nothing else can fill", () => {
    const resolution = resolveDecision(
      field({ label: "Have you worked with any startups previously? If so, list and describe.", kind: "text" }),
      decision({ fieldKey: "have you worked with any startups previously? if so, list and describe.", decision: "ask", question: "Have you?", why: "No validated candidate fact establishes prior startup experience." }),
      facts()
    );
    // A single line input used to refuse prose outright, which is why this exact
    // Pylon Labs question stopped two applications.
    expect(resolution.kind).toBe("generate");
  });

  it("reads a degree abbreviation and a dropdown's long form as the same degree", () => {
    const resolution = resolveDecision(
      field({ label: "Degree", kind: "select", options: ["Associate's Degree", "Bachelor's Degree", "Master's Degree"], optionsKnown: true }),
      decision({ fieldKey: "degree", decision: "answer", value: "Bachelor's Degree", sourceFact: "degree" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("Bachelor's Degree");
  });

  it("does not read a bachelor's degree as a master's", () => {
    const resolution = resolveDecision(
      field({ label: "Degree", kind: "select", options: ["Master's Degree"], optionsKnown: true }),
      decision({ fieldKey: "degree", decision: "answer", value: "Master's Degree", sourceFact: "degree" }),
      facts()
    );
    // The stored degree says "B.S.", so this is a contradiction and not a gap,
    // and best effort does not cover a contradiction: the value just disproved
    // is dropped rather than applied anyway. A degree nobody holds is not the
    // kind of "slightly wrong" this ticket signed up for.
    expect(resolution.kind).toBe("ask");
  });

  it("resolves a city to the one option that spells it out in full", () => {
    const resolution = resolveDecision(
      field({ label: "Location (City)", kind: "combobox", options: VIRTU_CITY_OPTIONS, optionsKnown: true }),
      decision({ fieldKey: "location (city)", decision: "answer", value: "San Francisco", sourceFact: "currentCity" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("San Francisco, California, United States");
    }
  });

  it("does not pick the shortest qualified option, which is a different city", () => {
    // The regression this fixture exists for. The first implementation broke a
    // tie by picking the shortest option, so against the real logged list the
    // answer was "San Francisco, Cebu, Philippines" (32 characters) over "San
    // Francisco, California, United States" (40). It was then written onto the
    // form as a fact the candidate had stated about where they live.
    //
    // The test that was supposed to catch this used a three option subset that
    // omitted both Philippine entries, which is exactly how the bug survived.
    const resolution = resolveDecision(
      field({ label: "Location (City)", kind: "combobox", options: VIRTU_CITY_OPTIONS, optionsKnown: true }),
      decision({ fieldKey: "location (city)", decision: "answer", value: "San Francisco", sourceFact: "currentCity" }),
      facts()
    );
    const wrong = VIRTU_CITY_OPTIONS.filter((o) => o !== "San Francisco, California, United States");
    expect(wrong).toContain("San Francisco, Cebu, Philippines");
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(wrong).not.toContain(resolution.value);
  });

  it("refuses a city it cannot tell apart, rather than guessing between two", () => {
    // Same menu, but nothing known about the country to break the tie with.
    // Three of the six options are qualified prefixes of "San Francisco" and no
    // second fact separates them, so this declines to choose. A city on the
    // wrong continent reported as a stated fact is worse than an empty field.
    const resolution = resolveDecision(
      field({ label: "Location (City)", kind: "combobox", options: VIRTU_CITY_OPTIONS, optionsKnown: true }),
      decision({ fieldKey: "location (city)", decision: "answer", value: "San Francisco", sourceFact: "currentCity" }),
      facts({ currentCountry: undefined })
    );
    expect(resolution.kind).not.toBe("apply");
  });

  describe("the context term a search combobox is given when nothing was attested", () => {
    // JOB-246. `resolveDecision`'s own `matchOption` already breaks a location
    // tie with `geographyHints`, which falls back to the resume's own printed
    // location when `currentCountry` was never attested. `chooseFromMenuOnce`'s
    // `contextTerms` — used at fill time for a search combobox like Greenhouse's
    // Location (City), whose options do not exist until something is typed —
    // had no equivalent fallback, which is what left Freeform's Location field
    // unresolved on a live 2026-08-28 run even though the candidate's resume
    // plainly read "San Francisco, California, United States". These tests
    // cover `countryContextTermsWithResumeFallback` directly, the pure
    // function `fillRemainingFields` and `fillRepeatingSections` both call to
    // compute that value.

    it("prefers the attested country and never reads the resume when one was given", () => {
      expect(
        countryContextTermsWithResumeFallback(
          "Canada",
          "San Francisco, California, United States"
        )
      ).toEqual(["Canada"]);
    });

    it("falls back to the resume's own country when nothing was attested", () => {
      expect(
        countryContextTermsWithResumeFallback(undefined, "San Francisco, California, United States")
      ).toEqual(["United States|USA|US|U.S."]);
    });

    it("reads the resume's last comma-separated segment for a non-US country too", () => {
      expect(countryContextTermsWithResumeFallback(undefined, "London, England, United Kingdom")).toEqual([
        "United Kingdom",
      ]);
    });

    it("returns nothing when neither the intake nor the resume names a country", () => {
      expect(countryContextTermsWithResumeFallback(undefined, undefined)).toEqual([]);
      expect(countryContextTermsWithResumeFallback("", "")).toEqual([]);
    });
  });

  describe("JOB-271: the SmartRecruiters postal code combobox's locality term", () => {
    // `currentCityWithResumeFallback` is `countryContextTermsWithResumeFallback`'s
    // city twin, same fallback order and same reason: `currentCity` is a
    // question intake accepts as optional, and the resume's own printed
    // location carries the same city a person would have typed in had it
    // been asked.
    it("prefers the attested city and never reads the resume when one was given", () => {
      expect(
        currentCityWithResumeFallback("Oakland", "San Francisco, California, United States")
      ).toBe("Oakland");
    });

    it("falls back to the resume's own leading segment when nothing was attested", () => {
      expect(
        currentCityWithResumeFallback(undefined, "San Francisco, California, United States")
      ).toBe("San Francisco");
    });

    it("returns empty when neither the intake nor the resume names a city", () => {
      expect(currentCityWithResumeFallback(undefined, undefined)).toBe("");
      expect(currentCityWithResumeFallback("", "")).toBe("");
    });

    // `isSmartRecruitersPostalCodeCombobox` gates the whole fix to the one
    // field it exists for: a SmartRecruiters, DOM confirmed combobox whose
    // label names a postal or ZIP code. Every other board, every other
    // field kind and every other label falls through untouched, matching
    // this ticket's own non goals.
    it("is true only for a SmartRecruiters postal code combobox", () => {
      expect(
        isSmartRecruitersPostalCodeCombobox(
          "smartrecruiters",
          field({ label: "Postal Code", kind: "combobox" })
        )
      ).toBe(true);
      expect(
        isSmartRecruitersPostalCodeCombobox(
          "smartrecruiters",
          field({ label: "ZIP/Postal Code", kind: "combobox" })
        )
      ).toBe(true);
    });

    it("is false on any other board", () => {
      expect(
        isSmartRecruitersPostalCodeCombobox(
          "greenhouse",
          field({ label: "Postal Code", kind: "combobox" })
        )
      ).toBe(false);
    });

    it("is false for a plain text postal code input, never widening past a combobox", () => {
      // JOB-271's own non goal: the postal code TYPED into the field never
      // changes, and a plain text input is not the field this fixes.
      expect(
        isSmartRecruitersPostalCodeCombobox(
          "smartrecruiters",
          field({ label: "Postal Code", kind: "text" })
        )
      ).toBe(false);
    });

    it("is false for a SmartRecruiters combobox that is not a postal or ZIP code field", () => {
      expect(
        isSmartRecruitersPostalCodeCombobox(
          "smartrecruiters",
          field({ label: "Location (City)", kind: "combobox" })
        )
      ).toBe(false);
    });
  });

  it("leaves an optional field it cannot answer blank instead of asking", () => {
    const resolution = resolveDecision(
      field({ label: "Referral code", required: false }),
      decision({ fieldKey: "referral code", decision: "ask", question: "Do you have one?", why: "nothing supplies this" }),
      facts()
    );
    expect(resolution.kind).toBe("skip");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a legal attestation is never best guessed", () => {
  it("answers one from the candidate's own stored status", () => {
    const resolution = resolveDecision(
      field({
        label: "EXPORT CONTROLS - Which status applies to you?",
        kind: "select",
        options: ["A United States citizen or national", "A person lawfully admitted for permanent residence", "None of the above"],
        optionsKnown: true,
      }),
      decision({ fieldKey: "export controls", decision: "answer", value: "A United States citizen or national", sourceFact: "citizenshipStatus" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
  });

  it("declines a clearance question the profile does not answer", () => {
    const resolution = resolveDecision(
      field({
        label: "CLEARANCE ELIGIBILITY - do you hold a U.S. security clearance?",
        kind: "select",
        options: ["Yes, I hold an active U.S. security clearance", "No", "Prefer not to answer"],
        optionsKnown: true,
      }),
      decision({ fieldKey: "clearance eligibility", decision: "ask", question: "Do you hold one?", why: "not established" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Prefer not to answer");
      expect(resolution.declined).toBe(true);
    }
  });

  it("stops when a required attestation offers no way to decline", () => {
    const resolution = resolveDecision(
      field({
        label: "Have you ever been convicted of a felony?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({ fieldKey: "felony", decision: "ask", question: "Have you?", why: "nothing supplies this" }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });

  it("refuses to infer one even when the model proposes a value", () => {
    // The nearest thing to a real hazard in this whole change: a model that
    // ignores its instructions and returns `infer` for a clearance question. The
    // refusal is in TypeScript, so the instruction being ignored costs nothing.
    const resolution = resolveDecision(
      field({ label: "Are you eligible for a U.S. security clearance?", kind: "select", options: ["Yes", "No"], optionsKnown: true }),
      decision({ fieldKey: "clearance", decision: "infer", value: "Yes", why: "seems likely" }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });

  it("refuses to write prose into a visa status box the profile cannot answer", () => {
    const resolution = resolveDecision(
      field({ label: "What is your current visa status?", kind: "text" }),
      decision({ fieldKey: "what is your current visa status?", decision: "generate", why: "free text" }),
      facts({ citizenshipStatus: undefined, workAuthorizedUs: undefined, requiresSponsorship: undefined })
    );
    // No decline option on a plain text box, so this is the narrow, labelled
    // stop rather than an invented immigration status.
    expect(resolution.kind).toBe("ask");
  });

  it("still declines every demographic question, unchanged", () => {
    const resolution = resolveDecision(
      field({ label: "Gender", kind: "select", options: ["Male", "Female", "Decline to self identify"], optionsKnown: true }),
      decision({ fieldKey: "gender", decision: "infer", value: "Male", why: "best guess" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Decline to self identify");
      expect(resolution.declined).toBe(true);
    }
  });

  it("ticks a required certification rather than abandoning the form", () => {
    // Changed deliberately on this PR, and it is a policy change rather than a
    // bug fix, so it is worth stating plainly. This used to return "ask" for
    // every box matching CONSENT_FIELD_RE, before any ladder and without looking
    // at `required`. "I certify that the information provided is true and
    // complete" is on a large share of forms and required on most of them, so
    // the old rule meant those forms could not be completed at all.
    //
    // A consent box is not in the stated carve-out, which covers legal
    // attestations. And this particular certification is one this system is in
    // an unusually good position to make: every value on the form came from what
    // the candidate themselves stated.
    const resolution = resolveDecision(
      field({ label: "I certify that the information given is true", kind: "checkbox", required: true }),
      decision({ fieldKey: "i certify", decision: "infer", value: "Yes", why: "best guess" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
  });

  it("leaves an optional agreement box alone, because nobody asked for it", () => {
    // The other half of the split. An optional consent box is a marketing
    // opt-in or a talent-pool subscription, and the instruction was to submit
    // applications, not to sign up for mailing lists.
    const resolution = resolveDecision(
      field({
        label: "I agree to receive marketing emails about future opportunities",
        kind: "checkbox",
        required: false,
      }),
      decision({ fieldKey: "marketing", decision: "infer", value: "Yes", why: "best guess" }),
      facts()
    );
    expect(resolution.kind).toBe("skip");
  });

  it("still refuses an agreement that is also a legal attestation", () => {
    // A box wording an attestation as a certification does not escape the ladder
    // by being a checkbox. Nothing backs it here, and there is no decline option
    // on a lone checkbox, so it stops.
    const resolution = resolveDecision(
      field({
        label: "I certify that I am authorized to work in the United States without sponsorship",
        kind: "checkbox",
        required: true,
      }),
      decision({ fieldKey: "certify auth", decision: "infer", value: "Yes", why: "best guess" }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("additionalAnswers may never decide a demographic or consent field", () => {
  // Issue #20, found in the security audit of 2026 08 19. `additionalAnswers`
  // is applied to the form BEFORE `resolveDecision` ever runs, and its key
  // matching is deliberately fuzzy (substring containment either direction,
  // for a key 10+ characters — see `matchAdditionalAnswer`). That combination
  // meant a caller-supplied entry that was never meant for a given field could
  // still land on it, and for a consent or certification checkbox, get ticked
  // directly from that unverified string — bypassing `resolveDecision`'s own
  // `CONSENT_FIELD_RE` guard entirely, since this step runs first and never
  // reaches it. Ticking one of these on the candidate's behalf is a
  // commitment made in their name, the same posture that already kept the EEO
  // carve-out just above from ever letting a demographic field go this way.
  //
  // `resolveAdditionalAnswer` is the fix: the exact `CONSENT_FIELD_RE` pattern
  // `resolveDecision` itself tests against (imported, not redefined), applied
  // as a mirror of the existing EEO carve-out, before either check gets a
  // chance to be bypassed by the fuzzy match.

  it("refuses a fuzzy-matched answer for a certification checkbox worded like the issue's own example", () => {
    // "I certify that the information provided is true and complete" is the
    // literal example from the audit. The supplied key is deliberately not a
    // verbatim match for the field's label — it only overlaps by substring —
    // which is exactly the fuzzy path the audit flagged as exploitable.
    const consentField = field({
      label: "I certify that the information provided in this application is true and complete",
      kind: "checkbox",
      required: true,
    });
    const resolution = resolveAdditionalAnswer(consentField, {
      "certify that the information provided": "Yes",
    });
    expect(resolution.kind).toBe("refused");
    if (resolution.kind === "refused") {
      expect(resolution.category).toBe("consent, agreement or certification field");
    }
  });

  it("refuses a fuzzy-matched answer even when the checkbox is also a legal attestation", () => {
    // Same label `resolveDecision` itself is tested against just above ("still
    // refuses an agreement that is also a legal attestation"). This guard does
    // not carve out an exception for that overlap the way `resolveDecision`'s
    // own auto-tick branch does with `isAttestationField` — every consent
    // pattern match is refused here, which is the more conservative choice for
    // the box that would otherwise assert an immigration status from a string
    // nobody verified.
    const attestationCheckbox = field({
      label: "I certify that I am authorized to work in the United States without sponsorship",
      kind: "checkbox",
      required: true,
    });
    const resolution = resolveAdditionalAnswer(attestationCheckbox, {
      "certify that i am authorized to work": "Yes",
    });
    expect(resolution.kind).toBe("refused");
  });

  it("still refuses a fuzzy-matched answer for a demographic field with a decline option", () => {
    // The pre-existing EEO carve-out, now covered directly rather than only
    // through the flow it sits inside — the same protection this test file
    // already gives `resolveDecision` itself.
    const eeoField = field({
      label: "What is your gender identity?",
      kind: "select",
      options: ["Male", "Female", "Non-binary", "Prefer not to say"],
      optionsKnown: true,
    });
    const resolution = resolveAdditionalAnswer(eeoField, {
      "what is your gender identity": "Male",
    });
    expect(resolution.kind).toBe("refused");
    if (resolution.kind === "refused") {
      expect(resolution.category).toBe("demographic field");
    }
  });

  // ── JOB-132 ───────────────────────────────────────────────────────────────
  // The consent carve-out above tested wording alone, and wording alone cannot
  // tell "do you agree to this" from "are you subject to one of these". The
  // label below is verbatim from a real Avery Dennison screening step and
  // matches `CONSENT_FIELD_RE` on exactly one word: "agreement", the noun
  // naming a document the question asks about.

  it("applies a supplied answer to a factual question that merely mentions an agreement", () => {
    const nonCompete = field({
      label:
        "Are you currently subject to a non compete, non-solicit or other similar clause in " +
        "your employment contract with your current or a previous employer, and if so, could " +
        "you provide this agreement as part of the recruitment process?",
      kind: "combobox",
      required: true,
      options: [
        "No, I'm not currently subject to a non complete or other similar clause.",
        "Yes, and I would be able to supply that as part of the recruitment process.",
        "Yes, but I would not be able to supply that as part of the recruitment process.",
      ],
      optionsKnown: true,
    });
    // The key is the one a previous run printed for this field, so this answer
    // is provably responsive to this exact escalation.
    const resolution = resolveAdditionalAnswer(nonCompete, {
      "are you currently subject to a non compete, non-solicit or other similar clause ":
        "No, I'm not currently subject to a non complete or other similar clause.",
    });
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe(
        "No, I'm not currently subject to a non complete or other similar clause."
      );
    }
  });

  it("still refuses a consent radio group, where choosing an option is the act of consenting", () => {
    // Lever draws processing consent as a two-option radio rather than a box.
    // Choosing here is agreeing, so the shape test must keep catching it.
    const consentRadio = field({
      label: "Do you consent to us processing your personal data for this application?",
      kind: "radio",
      required: true,
      options: ["Yes, I consent", "No, I do not consent"],
      optionsKnown: true,
    });
    const resolution = resolveAdditionalAnswer(consentRadio, {
      "do you consent to us processing your personal data": "Yes, I consent",
    });
    expect(resolution.kind).toBe("refused");
    if (resolution.kind === "refused") {
      expect(resolution.category).toBe("consent, agreement or certification field");
    }
  });

  it("still refuses an agreement checkbox even when the supplied key matches it exactly", () => {
    // The strongest provenance a supplied answer can have does not buy the
    // right to tick a box. `resolveDecision`'s own deterministic policy still
    // owns that decision, which is the whole point of the carve-out.
    const terms = field({
      label: "I agree to the Terms of Service and Privacy Policy",
      kind: "checkbox",
      required: true,
    });
    const resolution = resolveAdditionalAnswer(terms, {
      "i agree to the terms of service and privacy policy": "Yes",
    });
    expect(resolution.kind).toBe("refused");
  });

  it("still applies a fuzzy-matched answer to an ordinary required field", () => {
    // The common case this whole pass exists for. A real additionalAnswers
    // entry, keyed close to but not identical to the field's own label, still
    // reaches and fills an ordinary text field after this change.
    const linkedin = field({
      label: "What is your LinkedIn profile URL?",
      kind: "text",
      required: true,
    });
    const resolution = resolveAdditionalAnswer(linkedin, {
      "linkedin profile url": "https://www.linkedin.com/in/pat-example",
    });
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("https://www.linkedin.com/in/pat-example");
    }
  });

  it("reports no match at all as \"none\", not a refusal", () => {
    // A refusal and a plain miss are different outcomes for the caller
    // (`fillRemainingFields` only warns for the former), so the two must stay
    // distinguishable.
    const linkedin = field({ label: "What is your LinkedIn profile URL?", kind: "text", required: true });
    const resolution = resolveAdditionalAnswer(linkedin, { "favorite editor": "vim" });
    expect(resolution.kind).toBe("none");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a US state abbreviation is not a degree", () => {
  // Caught in review on this PR. `degreeLevel` is consulted by
  // `optionSupportsFact` for every field, not only for a degree dropdown, and it
  // matched a bare "ma"/"ms"/"ba" anywhere inside a string. So "Boston, MA" read
  // as a master's degree, and a location option could count as backed by a
  // stored location fact naming a different city in the same state.
  it("does not accept a different city in the same state as backed by the stored one", () => {
    const resolution = resolveDecision(
      field({
        label: "Which office are you closest to?",
        kind: "select",
        options: ["Boston, MA"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "which office are you closest to?",
        decision: "answer",
        value: "Boston, MA",
        sourceFact: "resumeLocation",
      }),
      new Map(
        buildFactCatalog({ ...PROFILE, location: "Cambridge, MA" }, ANSWERS, {}).map((f) => [f.key, f])
      )
    );
    // The stored location says Cambridge. Boston is a different place, and
    // nothing may report it as what the candidate stated.
    expect(resolution.kind).toBe("ask");
  });

  it("does not let a degree fact satisfy a bare state code on a location menu", () => {
    // The residual case review flagged after the first fix: "MA" is a master's
    // and it is Massachusetts, so degree equivalence now runs only when the
    // fact being cited is itself a degree. A location menu of bare state codes
    // can no longer be satisfied by a stored "B.S.".
    const resolution = resolveDecision(
      field({ label: "Which state are you based in?", kind: "select", options: ["MA", "CA", "NY"], optionsKnown: true }),
      decision({ fieldKey: "which state are you based in?", decision: "answer", value: "MA", sourceFact: "degree" }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });

  it("still reads a dropdown offering a bare abbreviation as the degree it is", () => {
    const resolution = resolveDecision(
      field({ label: "Degree", kind: "select", options: ["BS", "MS", "PhD"], optionsKnown: true }),
      decision({ fieldKey: "degree", decision: "answer", value: "BS", sourceFact: "degree" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("BS");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("what a best effort answer may not do", () => {
  it("does not put a value on a menu that does not offer it", () => {
    const resolution = resolveDecision(
      field({ label: "Overall GPA", kind: "select", options: ["3.5-3.9", "3.0-3.4", "below 3.0"], optionsKnown: true }),
      decision({ fieldKey: "overall gpa", decision: "infer", value: "4.2", why: "guessed" }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });

  it("does not resolve an ambiguous value to whichever option came first", () => {
    const resolution = resolveDecision(
      field({
        label: "Country",
        kind: "select",
        options: ["Papua New Guinea", "Equatorial Guinea"],
        optionsKnown: true,
      }),
      decision({ fieldKey: "country", decision: "answer", value: "Guinea", sourceFact: "currentCountry" }),
      facts({ currentCountry: "Guinea" })
    );
    // Neither option begins with the value and both contain it, so nothing is
    // chosen on this person's behalf. This is the property that keeps the looser
    // city match from turning a country picker into a hazard.
    expect(resolution.kind).not.toBe("apply");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a school combobox with no matching option is answered as free text", () => {
  // JOB-044. The 2026 08 21 failure analysis found the agent giving up on
  // Greenhouse's "School" field entirely whenever the candidate's own school
  // was not one of the dropdown's own suggestions, even though that combobox
  // is a text input that accepts whatever is typed into it. `lib/form-fields.ts`'s
  // `chooseFromMenu` is what actually leaves the typed text in place; this file
  // covers the policy half, which is deciding that a school-labelled combobox
  // gets to try that at all.
  it("types the candidate's own school when the dropdown does not offer it", () => {
    const resolution = resolveDecision(
      field({
        label: "School",
        kind: "combobox",
        options: ["Georgia State University", "Georgia Southern University"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "school",
        decision: "answer",
        value: "Georgia Institute of Technology",
        sourceFact: "school",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Georgia Institute of Technology");
    }
  });

  it("still asks about a non-school combobox with no matching option", () => {
    // The same gap on a "Location" combobox is not a licence to leave typed,
    // unselected text sitting where a chosen suggestion belongs — that is
    // exactly the failure `chooseFromMenu`'s keyboard selection exists to fix
    // instead. See `SCHOOL_FIELD_LABEL_RE`'s own comment for why this stays
    // scoped by label.
    const resolution = resolveDecision(
      field({
        label: "Location (City)",
        kind: "combobox",
        options: ["Atlanta, GA", "Boston, MA"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "location (city)",
        decision: "answer",
        value: "Georgia Institute of Technology",
        sourceFact: "school",
      }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("still asks about a School-labelled combobox when the proposed value is not the candidate's own school", () => {
    // Review of this same ticket caught the gap `DEGREE_FIELD_LABEL_RE` was
    // already double gated against: a label containing "School"/"University"/
    // "College" is not always asking which school the candidate attended. A
    // university's own Greenhouse posting can ask which "School" or "College"
    // a role belongs to — an org-structure question about the *employer* — and
    // that field's label matches `SCHOOL_FIELD_LABEL_RE` exactly as well as a
    // real "What school did you attend?" does. Free text may only land when
    // the proposed value is actually backed by the candidate's own school fact,
    // not merely when the label contains the word.
    const resolution = resolveDecision(
      field({
        label: "School",
        kind: "combobox",
        options: ["School of Engineering", "School of Business"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "school",
        decision: "answer",
        value: "Georgia Institute of Technology",
        // Not a school fact — the model named the wrong kind of fact to back
        // this org-structure question, same shape as the "MA"-for-degree case
        // `DEGREE_FACT_KEY_RE` protects against.
        sourceFact: "currentCity",
      }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("does not type free text into a native select labelled School", () => {
    // A native <select> cannot hold a value nobody chose from its own list, so
    // the fallback stays scoped to `kind: "combobox"` even when the label says
    // "School".
    const resolution = resolveDecision(
      field({
        label: "School",
        kind: "select",
        options: ["Georgia State University", "Georgia Southern University"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "school",
        decision: "answer",
        value: "Georgia Institute of Technology",
        sourceFact: "school",
      }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the message a blocked run leaves behind", () => {
  const item = (fieldLabel: string, topic: string | null = null) => ({
    key: fieldLabel.toLowerCase(),
    fieldLabel,
    question: `What about "${fieldLabel}"?`,
    why: "nothing supplies this",
    required: true,
    kind: "select" as const,
    topic,
  });

  it("tags a legal attestation so skipReasonFor can file it as one", () => {
    const message = blockedForAnswers([item("Are you eligible for a U.S. security clearance?")], "https://x.example").message;
    expect(message).toContain("needs_attestation:");
    expect(message).toContain("legal attestation");
  });

  it("does not describe a demographic block as a work authorization question", () => {
    // Caught in review on this PR. `isAttestationField` is true for both
    // categories, so a run stopped only by a required "Gender" select was told
    // its form asked about work authorization and criminal history. It did not.
    const message = blockedForAnswers([item("Gender")], "https://x.example").message;
    expect(message).toContain("needs_attestation:");
    expect(message).toContain("self-identification");
    expect(message).not.toContain("criminal history");
    expect(message).not.toContain("Work authorization");
  });

  it("counts the two categories separately when a form asks both", () => {
    const message = blockedForAnswers(
      [item("Gender"), item("Have you ever been convicted of a felony?")],
      "https://x.example"
    ).message;
    expect(message).toContain("1 required legal attestation(s)");
    expect(message).toContain("1 required self-identification question(s)");
  });

  it("uses the ordinary tag when nothing that stopped it was either category", () => {
    const message = blockedForAnswers([item("Referral code")], "https://x.example").message;
    expect(message).toContain("needs_candidate_input:");
    expect(message).not.toContain("needs_attestation");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * The review findings on this PR, each one reproduced before it was fixed.
 *
 * These are not hypotheses. Every case below was run against this module and
 * observed doing the wrong thing, and the assertions are written against the
 * observed wrong answer rather than against a general property, so that a
 * regression fails loudly and specifically.
 */
describe("an attestation is answered only from a fact about the question", () => {
  it("refuses an ITAR question backed by a relocation preference", () => {
    // Observed: applied "Yes" citing `willingToRelocate`. `optionSupportsFact`
    // compares the fact's VALUE to the option's TEXT and never looks at the
    // question, so any Yes/No fact licensed any Yes/No attestation. This is a
    // false statement to a defence contractor about export control status.
    const resolution = resolveDecision(
      field({ label: "Are you a U.S. Person as defined by ITAR?", kind: "select", options: ["Yes", "No"], optionsKnown: true }),
      decision({ fieldKey: "itar", decision: "answer", value: "Yes", sourceFact: "willingToRelocate" }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("refuses a criminal history question backed by a sponsorship answer", () => {
    // Observed: applied "No" citing `requiresSponsorship`. That the answer
    // happens to be true of this candidate is luck, and luck is not a property a
    // form filler may rely on. Nothing in the catalogue knows anything about
    // anybody's criminal record, which is the correct state of affairs.
    //
    // Note this one is not caught by a flat allow-list of "the status facts":
    // `requiresSponsorship` is a perfectly legitimate attestation fact, just not
    // for this question. Only a per-topic scope can tell the difference.
    const resolution = resolveDecision(
      field({ label: "Have you ever been convicted of a felony?", kind: "select", options: ["Yes", "No"], optionsKnown: true }),
      decision({ fieldKey: "felony", decision: "answer", value: "No", sourceFact: "requiresSponsorship" }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("refuses a clearance question backed by a work authorization fact", () => {
    const resolution = resolveDecision(
      field({
        label: "CLEARANCE ELIGIBILITY - This position may require eligibility to obtain and maintain a U.S. security clearance.",
        kind: "select",
        options: [
          "Yes, I hold an active U.S. security clearance",
          "Yes, I am eligible for a U.S. security clearance",
          "No",
        ],
        optionsKnown: true,
      }),
      decision({ fieldKey: "clearance", decision: "answer", value: "Yes, I am eligible for a U.S. security clearance", sourceFact: "workAuthorizedUs" }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("still answers an export control question from the citizenship status", () => {
    // The other side of the gate, and the case the whole ticket is about. The
    // real Anduril option list, and the stored status is genuinely about it.
    const resolution = resolveDecision(
      field({
        label: "EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls.",
        kind: "select",
        options: ANDURIL_EXPORT_CONTROL_OPTIONS,
        optionsKnown: true,
      }),
      decision({ fieldKey: "export controls", decision: "answer", value: "A United States citizen or national", sourceFact: "citizenshipStatus" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("A United States citizen or national");
      expect(resolution.declined).toBe(false);
    }
  });

  it("lets the candidate's own typed answer back any attestation", () => {
    // `answer:*` is the candidate answering the question themselves in a
    // previous needsInput round. It is allowed everywhere, including the two
    // topics that admit no stored fact at all.
    const resolution = resolveDecision(
      field({ label: "Have you ever been convicted of a felony?", kind: "select", options: ["Yes", "No"], optionsKnown: true }),
      decision({ fieldKey: "felony", decision: "answer", value: "No", sourceFact: "answer:have you ever been convicted of a felony?" }),
      buildFactCatalog(PROFILE, ANSWERS, {
        "have you ever been convicted of a felony?": "No",
      }).reduce((m, f) => m.set(f.key, f), new Map<string, CandidateFact>())
    );
    expect(resolution.kind).toBe("apply");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a yes/no attestation is answerable from the stored status", () => {
  it("answers \"Are you a citizen or national of the United States?\"", () => {
    // M1. The stored sentence "A United States citizen or national" does not say
    // what the option "Yes" says, so before the yes/no restatements existed the
    // correct fact bailed while, per the tests above, a wrong one passed. That
    // pairing is the worst possible one.
    const resolution = resolveDecision(
      field({ label: "Are you a citizen or national of the United States?", kind: "select", options: ["Yes", "No"], optionsKnown: true }),
      decision({ fieldKey: "citizen", decision: "answer", value: "Yes", sourceFact: "isUsCitizen" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("Yes");
  });

  it("says No to permanent residence for a citizen, which is the truthful answer", () => {
    const resolution = resolveDecision(
      field({ label: "Are you a lawful permanent resident (green card holder)?", kind: "select", options: ["Yes", "No"], optionsKnown: true }),
      decision({ fieldKey: "lpr", decision: "answer", value: "No", sourceFact: "isUsPermanentResident" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("No");
  });

  it("derives nothing at all from a citizenship status of \"other\"", () => {
    // "Other" means the person told us their status is none of the four, which
    // settles nothing. Answering "No" on their behalf would be the invention the
    // whole design exists to prevent. A refugee or asylee is a US person under
    // the export control regulation and is not one of the values intake offers.
    const other = facts({ citizenshipStatus: "other" });
    expect(other.has("isUsCitizen")).toBe(false);
    expect(other.has("isUsPersonForExportControl")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a country menu never resolves to a country nobody named", () => {
  it("resolves Guinea to Guinea and not to Guinea-Bissau", () => {
    // B4. The old prefix rule treated the hyphen as a word boundary, so
    // "Guinea-Bissau" counted as "Guinea said in full" and then won the
    // shortest-option tiebreak against the real entries. The existing test
    // omitted Guinea-Bissau, which is in every real country dropdown.
    const resolution = resolveDecision(
      field({ label: "Country", kind: "select", options: COUNTRY_OPTIONS, optionsKnown: true }),
      decision({ fieldKey: "country", decision: "answer", value: "Guinea", sourceFact: "currentCountry" }),
      facts({ currentCountry: "Guinea" })
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("Guinea");
  });

  it("refuses to choose between the two Congos", () => {
    // No bare "Congo" on the menu and two qualified prefixes, with nothing to
    // separate them. The old rule picked "Congo, Republic of the" because it is
    // shorter, which is a coin flip reported as a fact about where somebody
    // lives.
    const resolution = resolveDecision(
      field({ label: "Country", kind: "select", options: COUNTRY_OPTIONS, optionsKnown: true }),
      decision({ fieldKey: "country", decision: "answer", value: "Congo", sourceFact: "currentCountry" }),
      facts({ currentCountry: "Congo" })
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("never reaches a country that merely contains the value", () => {
    const menu = ["Papua New Guinea", "Equatorial Guinea"];
    for (const value of ["Guinea", "Georgia", "India", "Korea"]) {
      const resolution = resolveDecision(
        field({ label: "Country", kind: "select", options: menu, optionsKnown: true }),
        decision({ fieldKey: "country", decision: "answer", value, sourceFact: "currentCountry" }),
        facts({ currentCountry: value })
      );
      expect(resolution.kind).not.toBe("apply");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the best effort path is held to the same matching rule as a fact", () => {
  it("infers \"LinkedIn\" onto the option that spells it out", () => {
    // M2. `inferOrAsk` hand-rolled a normalized equality check instead of
    // calling `matchOption`, so the two drifted apart and a best effort answer
    // was held to a STRICTER rule than a fact backed one. Observed: this exact
    // field returned "ask" and stopped the application. `matchOption` only ever
    // returns an option the menu offers, so routing through it is no less safe.
    const resolution = resolveDecision(
      field({
        label: "How did you hear about us?",
        kind: "select",
        options: ["LinkedIn (Job Post)", "Referral", "Other"],
        optionsKnown: true,
      }),
      decision({ fieldKey: "how did you hear", decision: "infer", value: "LinkedIn", why: "best guess" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("LinkedIn (Job Post)");
  });

  it("still never invents an option that is not on the menu", () => {
    const resolution = resolveDecision(
      field({
        label: "How did you hear about us?",
        kind: "select",
        options: ["LinkedIn (Job Post)", "Referral", "Other"],
        optionsKnown: true,
      }),
      decision({ fieldKey: "how did you hear", decision: "infer", value: "Hacker News", why: "best guess" }),
      facts()
    );
    expect(resolution.kind === "apply" && resolution.value).not.toBe("Hacker News");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("degree equivalence stays inside degree fields", () => {
  it("does not let a master's degree satisfy the state of Massachusetts", () => {
    // Gating the fact KEY alone was not enough: a genuine `degree` fact against
    // a bare "MA" is a real fact and a real degree key, and `degreeLevel` reads
    // "MA" as a master's. Both the fact and the FIELD have to be about education
    // before two-letter equivalence decides anything.
    const resolution = resolveDecision(
      field({ label: "State", kind: "select", options: ["CA", "MA", "NY"], optionsKnown: true }),
      decision({ fieldKey: "state", decision: "answer", value: "MA", sourceFact: "degree" }),
      buildFactCatalog(
        { ...PROFILE, education: [{ school: "Georgia Institute of Technology", degree: "Master's Degree", discipline: "CS", endDate: "Dec 2025" }] },
        ANSWERS,
        {}
      ).reduce((m, f) => m.set(f.key, f), new Map<string, CandidateFact>())
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("does not let a degree fact reach a city option ending in a state code", () => {
    // The real Anduril location list, which contains "Boston, MA".
    const resolution = resolveDecision(
      field({ label: "What is your top location preference?", kind: "select", options: ANDURIL_LOCATION_OPTIONS, optionsKnown: true }),
      decision({ fieldKey: "top location", decision: "answer", value: "Boston, MA", sourceFact: "degree" }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("still reads B.S. onto \"Bachelor's Degree\" on an actual degree field", () => {
    const resolution = resolveDecision(
      field({ label: "Degree", kind: "select", options: ["Associate's Degree", "Bachelor's Degree", "Master's Degree"], optionsKnown: true }),
      decision({ fieldKey: "degree", decision: "answer", value: "Bachelor's Degree", sourceFact: "degree" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("Bachelor's Degree");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//
// The real "Citizenship Status" question from a live Greenhouse posting, in the
// wording that form actually renders. Every option carries the enumeration
// marker its author typed, and the first option says the same thing the stored
// `citizenship_status` says in different words and a different order. Both of
// those defeated the matching, so a question this candidate had answered at
// intake came back as `needs_attestation`.
const FREEFORM_CITIZENSHIP_OPTIONS = [
  "1) U.S. citizen or national of the United States",
  "2) U.S. lawful permanent resident (green card holder)",
  "3) Refugee under 8 U.S.C 1157",
  "4) Asylee under 8 U.S.C 1158",
  "5) Authorized to work in the United States under the Deferred Action For Childhood Arrivals (DACA Program)",
  "6) Other (please explain)",
];

describe("a numbered citizenship option is matched, and only by the citizenship fact", () => {
  const citizenshipField = (options = FREEFORM_CITIZENSHIP_OPTIONS) =>
    field({ label: "Citizenship Status", kind: "combobox", options, optionsKnown: true });

  it("chooses the option the stored status names, marker and all", () => {
    const resolution = resolveDecision(
      citizenshipField(),
      decision({
        fieldKey: "citizenship status",
        decision: "answer",
        value: "1) U.S. citizen or national of the United States",
        sourceFact: "citizenshipStatus",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("1) U.S. citizen or national of the United States");
    }
  });

  it("chooses it when the proposal leaves the marker off", () => {
    const resolution = resolveDecision(
      citizenshipField(),
      decision({
        fieldKey: "citizenship status",
        decision: "answer",
        value: "U.S. citizen or national of the United States",
        sourceFact: "citizenshipStatus",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("1) U.S. citizen or national of the United States");
    }
  });

  it("still refuses a status the stored one disagrees with", () => {
    // A citizen is not a lawful permanent resident, and the option saying so
    // must not become choosable just because the wording gap was closed.
    const resolution = resolveDecision(
      citizenshipField(),
      decision({
        fieldKey: "citizenship status",
        decision: "answer",
        value: "2) U.S. lawful permanent resident (green card holder)",
        sourceFact: "citizenshipStatus",
      }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("still refuses an option that names no status at all", () => {
    const resolution = resolveDecision(
      citizenshipField(),
      decision({
        fieldKey: "citizenship status",
        decision: "answer",
        value: "6) Other (please explain)",
        sourceFact: "citizenshipStatus",
      }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("never reads a negated option as agreeing with the stored status", () => {
    const resolution = resolveDecision(
      citizenshipField(["1) A U.S. citizen or national", "2) Not a U.S. citizen or national"]),
      decision({
        fieldKey: "citizenship status",
        decision: "answer",
        value: "2) Not a U.S. citizen or national",
        sourceFact: "citizenshipStatus",
      }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("still refuses a fact that is not about citizenship at all", () => {
    // The allow-list this must not weaken. Closing the wording gap for
    // `citizenshipStatus` may not open the question to anything else.
    const resolution = resolveDecision(
      citizenshipField(),
      decision({
        fieldKey: "citizenship status",
        decision: "answer",
        value: "1) U.S. citizen or national of the United States",
        sourceFact: "willingToRelocate",
      }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("does not let citizenship equivalence run on a field that is not asking", () => {
    // The same double gate degree equivalence has: the fact being a citizenship
    // status is not enough, the FIELD has to be asking about one.
    const resolution = resolveDecision(
      field({ label: "Degree", kind: "combobox", options: FREEFORM_CITIZENSHIP_OPTIONS, optionsKnown: true }),
      decision({
        fieldKey: "degree",
        decision: "answer",
        value: "1) U.S. citizen or national of the United States",
        sourceFact: "citizenshipStatus",
      }),
      facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("leaves an option that merely starts with digits alone", () => {
    // The marker rule has to be narrow enough that the ACT list on this same
    // form survives it: "36 out of 36" starts with a number and is not numbered.
    const options = ["Did not take", "36 out of 36", "35 out of 36", "34 out of 36"];
    const resolution = resolveDecision(
      field({ label: "ACT Score", kind: "combobox", options, optionsKnown: true }),
      decision({
        fieldKey: "act score",
        decision: "infer",
        value: "35 out of 36",
        why: "from the resume",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("35 out of 36");
  });
});

// ── CONFIRM_EMAIL_RE ────────────────────────────────────────────────────────
//
// Confirms that all the common "re-enter your email" label patterns the Workable
// and Greenhouse boards use are matched, and that primary email fields are not.
describe("CONFIRM_EMAIL_RE", () => {
  const matches = [
    "Confirm email",
    "Confirm your email",
    "Confirm Email Address",
    "Re-enter email",
    "Reenter your email address",
    "Repeat email",
    "Verify email",
    "Retype email",
    "Email confirmation",
  ];
  for (const label of matches) {
    it(`matches "${label}"`, () => {
      expect(CONFIRM_EMAIL_RE.test(label)).toBe(true);
    });
  }

  const nonMatches = [
    "Email",
    "Email address",
    "Work email",
    "Your email",
    "Primary email",
  ];
  for (const label of nonMatches) {
    it(`does not match primary-email field "${label}"`, () => {
      expect(CONFIRM_EMAIL_RE.test(label)).toBe(false);
    });
  }
});

// ── minimumAge fact ─────────────────────────────────────────────────────────
//
// `buildFactCatalog` should always produce a `minimumAge` fact with value "Yes"
// so that Workable compliance dropdowns asking "Are you at least 18 years old?"
// are answered deterministically.
describe("buildFactCatalog minimumAge fact", () => {
  it("always includes minimumAge: Yes", () => {
    const catalog = buildFactCatalog(PROFILE, ANSWERS, {});
    const fact = catalog.find((f) => f.key === "minimumAge");
    expect(fact).toBeDefined();
    expect(fact?.value).toBe("Yes");
  });

  it("minimumAge is not treated as a legal attestation", () => {
    // The minimum-age question is NOT a work-authorization or criminal-history
    // attestation, so isAttestationField must return false for it. The model is
    // allowed to use the `minimumAge` fact to answer it via inferOrAsk.
    expect(isAttestationField("Are you at least 18 years old?")).toBe(false);
  });
});

// ── JOB-270: SmartRecruiters OneClick Experience section autofill ───────────
//
// The batch of 2026 08 29 lost three SR submits to the same message: "the
// Experience section still needs at least one entry." `fillRepeatingSections`
// already hands a mounted entry's fields through the ordinary decide-then-apply
// path, but that path had only one joined `work0.dates` fact to cite for
// whatever separate Start Date / End Date controls the widget renders, and
// nothing at all backed a "currently work here" checkbox. These prove the two
// pieces `buildFactCatalog` now supplies: a start/end date split per entry, and
// an `isCurrent` fact that never asks a real date field to hold the word
// "Present".
describe("JOB-270: buildFactCatalog splits a work entry's dates for repeating sections", () => {
  it("keeps the joined work0.dates fact and adds separate start/end facts for a role that ended", () => {
    // PROFILE's most recent entry, Northwind, ran Jun 2024 to Sep 2024.
    const catalog = facts();
    expect(catalog.get("work0.dates")?.value).toBe("Jun 2024 to Sep 2024");
    expect(catalog.get("work0.startDate")?.value).toBe("Jun 2024");
    expect(catalog.get("work0.endDate")?.value).toBe("Sep 2024");
    expect(catalog.get("work0.isCurrent")?.value).toBe("No");
  });

  it("never exposes a work0.endDate fact for a role the resume shows as still ongoing", () => {
    // A form's End Date control is built to hold a real date. Citing a fact
    // that reads "Present" would type that word into it — the exact failure
    // mode this ticket exists to close.
    const ongoing = buildFactCatalog(
      {
        ...PROFILE,
        workHistory: [
          { company: "Now Inc", title: "Engineer", startDate: "Jun 2025", endDate: "Present", summary: "" },
        ],
      },
      ANSWERS,
      {}
    );
    const catalog = new Map(ongoing.map((f) => [f.key, f]));
    expect(catalog.get("work0.startDate")?.value).toBe("Jun 2025");
    expect(catalog.has("work0.endDate")).toBe(false);
    expect(catalog.get("work0.isCurrent")?.value).toBe("Yes");
  });

  it("also treats a blank end date as still ongoing", () => {
    const ongoing = buildFactCatalog(
      {
        ...PROFILE,
        workHistory: [
          { company: "Now Inc", title: "Engineer", startDate: "Jun 2025", endDate: null, summary: "" },
        ],
      },
      ANSWERS,
      {}
    );
    const catalog = new Map(ongoing.map((f) => [f.key, f]));
    expect(catalog.has("work0.endDate")).toBe(false);
    expect(catalog.get("work0.isCurrent")?.value).toBe("Yes");
  });

  it("adds no work0.* facts at all when the resume carries no work history", () => {
    // The non-goal this ticket names explicitly: no work history on the resume
    // means the Experience section falls through to the ordinary
    // unanswerable_required escalation rather than anything being invented.
    const empty = buildFactCatalog({ ...PROFILE, workHistory: [] }, ANSWERS, {});
    const catalog = new Map(empty.map((f) => [f.key, f]));
    expect(catalog.has("work0.isCurrent")).toBe(false);
    expect(catalog.has("work0.startDate")).toBe(false);
    expect(catalog.has("work0.endDate")).toBe(false);
  });
});

describe("JOB-270: isOngoingRole", () => {
  it("reads the resume's own vocabulary for a role that has not ended", () => {
    for (const value of ["Present", "present", "Current", "Now", "Ongoing"]) {
      expect(isOngoingRole(value)).toBe(true);
    }
  });

  it("reads null and blank the same way a resume with no end date printed would", () => {
    expect(isOngoingRole(null)).toBe(true);
    expect(isOngoingRole(undefined)).toBe(true);
    expect(isOngoingRole("  ")).toBe(true);
  });

  it("does not mistake an actual end date for one of its own words", () => {
    for (const value of ["Sep 2024", "December 2023", "2022"]) {
      expect(isOngoingRole(value)).toBe(false);
    }
  });
});

describe("JOB-270: the Experience section's own field-recognition patterns", () => {
  it("EXPERIENCE_SECTION_HEADING_RE matches the Experience section and not Education", () => {
    expect(EXPERIENCE_SECTION_HEADING_RE.test("Experience")).toBe(true);
    expect(EXPERIENCE_SECTION_HEADING_RE.test("Experience *")).toBe(true);
    expect(EXPERIENCE_SECTION_HEADING_RE.test("Work Experience")).toBe(true);
    expect(EXPERIENCE_SECTION_HEADING_RE.test("Education")).toBe(false);
    expect(EXPERIENCE_SECTION_HEADING_RE.test("Education *")).toBe(false);
  });

  it("CURRENT_ROLE_CHECKBOX_RE matches the wordings a board plausibly renders", () => {
    for (const label of [
      "I currently work here",
      "Currently work here",
      "I am still working here",
      "Current position",
      "Current role",
      "Currently employed here",
    ]) {
      expect(CURRENT_ROLE_CHECKBOX_RE.test(label)).toBe(true);
    }
  });

  it("does not mistake an unrelated label for the current-role checkbox", () => {
    for (const label of ["Company", "Job title", "Description", "Start date", "End date"]) {
      expect(CURRENT_ROLE_CHECKBOX_RE.test(label)).toBe(false);
    }
  });

  it("END_DATE_FIELD_RE matches End Date and does not match Start Date", () => {
    expect(END_DATE_FIELD_RE.test("End Date")).toBe(true);
    expect(END_DATE_FIELD_RE.test("End date *")).toBe(true);
    expect(END_DATE_FIELD_RE.test("Start Date")).toBe(false);
    expect(END_DATE_FIELD_RE.test("Description")).toBe(false);
  });
});

// ── Issue #94: options truncated to a prefix of a longer live list ──────────
//
// Lever's university dropdown holds 3,302 options and the enumeration reports
// its first 60. The decision prompt tells the model it may propose an option
// beyond a truncated prefix "and it will be checked against the live list";
// these confirm the policy layer keeps that promise instead of refusing first.
// The action layer (`selectNative`) still only chooses options the DOM itself
// offers, covered in form-fields-enumeration.test.ts.
describe("a fact-backed answer beyond a truncated option prefix", () => {
  const A_UNIVERSITIES = [
    "Aalborg University",
    "Aalto University",
    "Aarhus University",
  ];

  it("applies the school for the live list to verify, rather than refusing", () => {
    const resolution = resolveDecision(
      field({
        label: "Which university are you currently attending or did you last attend?",
        kind: "select",
        options: A_UNIVERSITIES,
        optionsKnown: true,
        optionsTruncated: true,
      }),
      decision({
        fieldKey: "which university are you currently attending or did you last attend?",
        value: "Georgia Institute of Technology",
        sourceFact: "school",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Georgia Institute of Technology");
    }
  });

  it("still checks the proposal against the named fact first", () => {
    const resolution = resolveDecision(
      field({
        label: "Which university are you currently attending or did you last attend?",
        kind: "select",
        options: A_UNIVERSITIES,
        optionsKnown: true,
        optionsTruncated: true,
      }),
      decision({
        fieldKey: "which university are you currently attending or did you last attend?",
        value: "Stanford University",
        sourceFact: "school",
      }),
      facts()
    );
    // The proposed wording contradicts the stored school, so the bad value is
    // dropped and the question escalates rather than being clicked.
    expect(resolution.kind).toBe("ask");
  });

  it("does not loosen the rule for a list that is NOT truncated", () => {
    const resolution = resolveDecision(
      field({
        label: "Which university are you currently attending or did you last attend?",
        kind: "select",
        options: A_UNIVERSITIES,
        optionsKnown: true,
        optionsTruncated: false,
      }),
      decision({
        fieldKey: "which university are you currently attending or did you last attend?",
        value: "Georgia Institute of Technology",
        sourceFact: "school",
      }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });

  it("lets a best-effort proposal past the prefix through to the live check", () => {
    const resolution = resolveDecision(
      field({
        label: "Which university are you currently attending or did you last attend?",
        kind: "select",
        options: A_UNIVERSITIES,
        optionsKnown: true,
        optionsTruncated: true,
      }),
      decision({
        fieldKey: "which university are you currently attending or did you last attend?",
        decision: "infer",
        value: "Georgia Institute of Technology",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Georgia Institute of Technology");
    }
  });
});

// ── Issue #94: agreements drawn as radio groups and as typed fields ─────────
//
// Lever renders processing consent as a two-option radio group ("Yes, I
// consent" / "No, I do not consent"); Workable renders digital-signature
// agreements as a required text input under the full legal paragraph. Both get
// the same deterministic policy the checkbox form of an agreement already had:
// required and not an attestation means the consenting option, optional means
// skip, and a typed signature is never written by a model at all.
describe("a consent radio group follows the checkbox agreement policy", () => {
  // The real Palantir card's question, verbatim, not trimmed: the sentence
  // pointing at the candidate privacy policy is the one CONSENT_FIELD_RE
  // actually matches, and an earlier draft of this test trimmed it out and
  // proved nothing.
  const LEVER_AI_CONSENT_LABEL =
    "As part of our interview process, we may use AI notetakers to transcribe " +
    "conversations for accuracy and efficiency. Please see our candidate privacy policy " +
    "for more information on how we process your data. Your decision to opt in or out " +
    "of this tooling will not impact your candidacy.";

  it("answers a required group with its own consenting option, deterministically", () => {
    const resolution = resolveDecision(
      field({
        label: LEVER_AI_CONSENT_LABEL,
        kind: "radio",
        options: ["Yes, I consent", "No, I do not consent"],
        optionsKnown: true,
        required: true,
      }),
      undefined,
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("Yes, I consent");
  });

  it("skips an optional group, which is an opt-in nobody asked for", () => {
    const resolution = resolveDecision(
      field({
        label: LEVER_AI_CONSENT_LABEL,
        kind: "radio",
        options: ["Yes, I consent", "No, I do not consent"],
        optionsKnown: true,
        required: false,
      }),
      undefined,
      facts()
    );
    expect(resolution.kind).toBe("skip");
  });

  it("escalates a group whose options do not clearly affirm", () => {
    const resolution = resolveDecision(
      field({
        label: LEVER_AI_CONSENT_LABEL,
        kind: "radio",
        options: ["I consent to recording", "I consent to transcription only"],
        optionsKnown: true,
        required: true,
      }),
      undefined,
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });
});

describe("a consent statement drawn as a typed field is never model-written", () => {
  // The first 300 characters of the real TMEIC digital-signature question, as
  // the enumeration reports it (labels are capped at 300).
  const TMEIC_SIGNATURE_LABEL =
    "I understand that TMEIC Corporation Americas, hereinafter referred to as " +
    "“the Company,” requires certain information about me to evaluate my " +
    "qualifications for employment and to conduct its business if I become an employee. " +
    "Therefore, I authorize the Company to investigate my past employment, educat";

  it("escalates a required signature box instead of generating prose for it", () => {
    const resolution = resolveDecision(
      field({ label: TMEIC_SIGNATURE_LABEL, kind: "text", required: true }),
      decision({ fieldKey: TMEIC_SIGNATURE_LABEL.toLowerCase(), decision: "generate", value: null }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });

  it("escalates even when the model proposes a value for it", () => {
    const resolution = resolveDecision(
      field({ label: TMEIC_SIGNATURE_LABEL, kind: "text", required: true }),
      decision({ fieldKey: TMEIC_SIGNATURE_LABEL.toLowerCase(), value: "Pat Example" }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });

  it("skips an optional one", () => {
    const resolution = resolveDecision(
      field({ label: TMEIC_SIGNATURE_LABEL, kind: "text", required: false }),
      decision({ fieldKey: TMEIC_SIGNATURE_LABEL.toLowerCase(), decision: "generate", value: null }),
      facts()
    );
    expect(resolution.kind).toBe("skip");
  });

  it("leaves a visa-status text box on its existing attestation ladder", () => {
    // "authorized to work" is a legal attestation, not a consent statement;
    // the stored answer still applies through the existing path.
    const resolution = resolveDecision(
      field({ label: "Are you authorized to work in the United States?", kind: "text", required: true }),
      decision({
        fieldKey: "are you authorized to work in the united states?",
        value: "Yes",
        sourceFact: "workAuthorizedUs",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("Yes");
  });
});

// ── Issue #94 follow up: filler is not an answer ────────────────────────────
//
// On the real Belvedere Trading run of 2026 08 22 (application c32122c7) the
// model answered two REQUIRED fields the intake cannot support, Street Address
// and Zip Code, with the literal string "Not provided". The pipeline typed it
// and the board refused the submission. Filler on a real employer's form under
// a real person's name is what HARD STOP 9 forbids, so a proposal that only
// announces the absence of an answer now escalates to the candidate.
describe("a proposed value that is not an answer but an admission", () => {
  const addressField = () => field({ label: "Street Address", kind: "text", required: true });

  for (const filler of ["Not provided", "N/A", "n/a", "Unknown", "None", "TBD", "-", "  none  "]) {
    it(`escalates rather than typing ${JSON.stringify(filler)} into a required text field`, () => {
      const resolution = resolveDecision(
        addressField(),
        decision({ fieldKey: "street address", decision: "infer", value: filler }),
        facts()
      );
      expect(resolution.kind).toBe("ask");
    });
  }

  it("still types a real answer into the same field", () => {
    const resolution = resolveDecision(
      field({ label: "City they live in", kind: "text", required: true }),
      decision({ fieldKey: "city they live in", decision: "infer", value: "San Francisco" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("San Francisco");
  });

  it("does not mistake a real answer that merely contains one of the words", () => {
    // "None of the above" is a real option on Anduril's export control
    // question, and a sentence that starts by saying something is not
    // applicable is still a written answer.
    const resolution = resolveDecision(
      field({ label: "Describe any work restrictions", kind: "textarea", required: true }),
      decision({
        fieldKey: "describe any work restrictions",
        decision: "infer",
        value: "Not applicable to this role, since the position is fully on site.",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
  });

  it("leaves a menu's own N/A option alone, since choosing it answers the question", () => {
    const resolution = resolveDecision(
      field({
        label: "Do you currently have pending offers from other employers?",
        kind: "radio",
        options: ["Yes", "No", "N/A"],
        optionsKnown: true,
        required: true,
      }),
      decision({
        fieldKey: "do you currently have pending offers from other employers?",
        decision: "infer",
        value: "N/A",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("N/A");
  });

  it("skips rather than asks when the unanswerable field is optional", () => {
    const resolution = resolveDecision(
      field({ label: "Street Address", kind: "text", required: false }),
      decision({ fieldKey: "street address", decision: "infer", value: "Not provided" }),
      facts()
    );
    expect(resolution.kind).toBe("skip");
  });
});

// ── HARD STOP 10: veteran status by any wording ─────────────────────────────
//
// Found while triaging Point72's Greenhouse form, which asks "Have you served
// in the military?" — a protected characteristic that EEO_FIELD_RE did not
// match, so it would have been answered by a model and sent to an employer.
describe("a veteran status question is caught whatever a board calls it", () => {
  for (const label of [
    "Have you served in the military?",
    "Military service status",
    "Are you a protected veteran?",
    "Veteran Status",
    "Have you served in the armed forces?",
  ]) {
    it(`treats ${JSON.stringify(label)} as a demographic question`, () => {
      expect(isAttestationField(label)).toBe(true);
    });
  }

  it("declines it through the control's own decline option rather than answering", () => {
    const resolution = resolveDecision(
      field({
        label: "Have you served in the military?",
        kind: "select",
        options: ["Yes", "No", "I decline to self identify"],
        optionsKnown: true,
        required: true,
      }),
      decision({
        fieldKey: "have you served in the military?",
        decision: "answer",
        value: "No",
        sourceFact: "currentCountry",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("I decline to self identify");
      expect(resolution.declined).toBe(true);
    }
  });

  it("does not answer one that offers no way to decline", () => {
    const resolution = resolveDecision(
      field({
        label: "Have you served in the military?",
        kind: "radio",
        options: ["Yes", "No"],
        optionsKnown: true,
        required: true,
      }),
      decision({ fieldKey: "have you served in the military?", decision: "infer", value: "No" }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * JOB-262: SmartRecruiters and Breezy only, and only when the form itself
 * offers something honest adjacent. The fixtures are the three rows from the
 * 2026 08 28 live verify pass that stopped at `needs_attestation`:
 *
 *  · Bosch Group (SR) and Wabtec Engineering (SR) — a demographic select that
 *    offered "N/A" but nothing `DECLINE_OPTION_RE` recognised.
 *  · VetsEZ Tampa Cloud Integration (Breezy) — "Are you a veteran of any
 *    branch of the United States Armed Forces", a plain Yes/No with no
 *    honest adjacent option at all, which stays escalated on purpose.
 */
describe("JOB-262: the SmartRecruiters and Breezy EEO decline analog carve out", () => {
  it("selects \"N/A\" on SmartRecruiters when nothing DECLINE_OPTION_RE recognises is offered", () => {
    const resolution = resolveDecision(
      field({
        label: "Race/Ethnicity",
        kind: "select",
        options: ["Hispanic or Latino", "White", "Black or African American", "N/A"],
        optionsKnown: true,
        required: true,
      }),
      decision({ fieldKey: "race/ethnicity", decision: "infer", value: "White", why: "best guess" }),
      facts(),
      "smartrecruiters"
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("N/A");
      expect(resolution.declined).toBe(true);
      expect(resolution.fabricatedDecline).toBe(true);
    }
  });

  it("selects \"Not Applicable\" on Breezy the same way", () => {
    const resolution = resolveDecision(
      field({
        label: "Gender Identity",
        kind: "select",
        options: ["Male", "Female", "Non-binary", "Not Applicable"],
        optionsKnown: true,
        required: true,
      }),
      decision({ fieldKey: "gender identity", decision: "infer", value: "Male", why: "best guess" }),
      facts(),
      "breezy"
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Not Applicable");
      expect(resolution.fabricatedDecline).toBe(true);
    }
  });

  it("still escalates a veteran question with no honest adjacent option at all, ats or not", () => {
    // The VetsEZ Tampa Cloud Integration case: a plain Yes/No leaves nothing
    // for the widened pattern to find either, so the fabrication path never
    // engages and `needs_attestation` behaviour is preserved.
    const resolution = resolveDecision(
      field({
        label: "Are you a veteran of any branch of the United States Armed Forces?",
        kind: "radio",
        options: ["Yes", "No"],
        optionsKnown: true,
        required: true,
      }),
      decision({ fieldKey: "veteran", decision: "infer", value: "No", why: "best guess" }),
      facts(),
      "breezy"
    );
    expect(resolution.kind).toBe("ask");
  });

  it("does not widen the decline search on any other board", () => {
    // Same options as the Bosch fixture above, but no ats — or an ats outside
    // the ticket's scope — must still stop the run rather than picking "N/A".
    // This is the boundary the ticket's non-goals list by name: Ashby, Lever,
    // Workable, Greenhouse, Recruitee, BambooHR and JazzHR are all untouched.
    for (const ats of [undefined, "ashby", "greenhouse", "lever", "workable"]) {
      const resolution = resolveDecision(
        field({
          label: "Race/Ethnicity",
          kind: "select",
          options: ["Hispanic or Latino", "White", "Black or African American", "N/A"],
          optionsKnown: true,
          required: true,
        }),
        decision({ fieldKey: "race/ethnicity", decision: "infer", value: "White", why: "best guess" }),
        facts(),
        ats
      );
      expect(resolution.kind).toBe("ask");
    }
  });

  it("still prefers an explicitly labelled decline option over the widened search", () => {
    // A real decline option, even on an ats in the carve out, is answered by
    // `findDeclineOption` exactly as before — the widened search only ever
    // runs once that has already come back null.
    const resolution = resolveDecision(
      field({
        label: "Gender",
        kind: "select",
        options: ["Male", "Female", "Decline to self identify"],
        optionsKnown: true,
        required: true,
      }),
      decision({ fieldKey: "gender", decision: "infer", value: "Male", why: "best guess" }),
      facts(),
      "smartrecruiters"
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Decline to self identify");
      expect(resolution.fabricatedDecline).toBeUndefined();
    }
  });

  it("never widens the search when the form's options could not be read", () => {
    // `optionsKnown: false` means this system never actually saw what the
    // control offers, so it must never be treated as though it offered "N/A".
    const resolution = resolveDecision(
      field({
        label: "Disability Status",
        kind: "select",
        options: [],
        optionsKnown: false,
        required: true,
      }),
      decision({ fieldKey: "disability status", decision: "infer", value: "No", why: "best guess" }),
      facts(),
      "smartrecruiters"
    );
    expect(resolution.kind).toBe("ask");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * JOB-101: the intake answers that were blocking real applications, and the
 * jurisdiction rule that closes issue #108.
 *
 * The candidate below is the real one, with the answers he actually gave on
 * 2026 08 22: eligible for a US security clearance, has never held one, would
 * need sponsorship to work outside the United States, and no visa because he is
 * a US citizen. He deliberately has no street address and no postal code,
 * because he did not supply either, and the tests say so rather than inventing
 * them.
 */
const JOB_101_ANSWERS: CandidateApplicationAnswers = {
  ...ANSWERS,
  clearanceEligibility: "eligible",
  clearanceLevelHeld: "never_held",
  needsSponsorshipNonUs: true,
  visaStatus: "Not applicable, US citizen",
  highSchoolName: "Northview High School",
  highSchoolGradYear: 2022,
};

function job101Facts(
  overrides: Partial<CandidateApplicationAnswers> = {}
): Map<string, CandidateFact> {
  const list = buildFactCatalog(PROFILE, { ...JOB_101_ANSWERS, ...overrides }, {});
  return new Map(list.map((fact) => [fact.key, fact]));
}

/** Anduril's two clearance questions, verbatim, from the skip_log rows. */
const ANDURIL_CLEARANCE_LABEL =
  "CLEARANCE ELIGIBILITY - This position may require eligibility to obtain and maintain a U.S. security clearance.";
const ANDURIL_CLEARANCE_OPTIONS = [
  "Yes, I hold an active U.S. security clearance",
  "Yes, I am eligible for a U.S. security clearance",
  "No",
];
const ANDURIL_CLEARANCE_LEVEL_LABEL =
  "If you have held a U.S. security clearance in the past, what clearance level have you held?";
const ANDURIL_CLEARANCE_LEVEL_OPTIONS = [
  "N/A - have never held U.S. security clearance",
  "Confidential",
  "Secret",
  "Top Secret",
];

describe("a clearance question is answered from the candidate's own answer", () => {
  it("states the clearance answers in the words Anduril's own options use", () => {
    const known = job101Facts();
    expect(known.get("clearanceEligibility")?.value).toBe(
      "Yes, I am eligible for a U.S. security clearance"
    );
    expect(known.get("clearanceLevelHeld")?.value).toBe(
      "N/A - have never held U.S. security clearance"
    );
  });

  it("answers Anduril's eligibility question rather than escalating it", () => {
    // The whole ticket, in one case. This exact question stopped two real
    // Anduril applications as `needs_attestation`, against a candidate who can
    // answer it in a second and had simply never been asked.
    const resolution = resolveDecision(
      field({
        label: ANDURIL_CLEARANCE_LABEL,
        kind: "select",
        options: ANDURIL_CLEARANCE_OPTIONS,
        optionsKnown: true,
      }),
      decision({
        fieldKey: "clearance eligibility",
        decision: "answer",
        value: "Yes, I am eligible for a U.S. security clearance",
        sourceFact: "clearanceEligibility",
      }),
      job101Facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Yes, I am eligible for a U.S. security clearance");
      expect(resolution.declined).toBe(false);
    }
  });

  it("answers the follow up about which level has ever been held", () => {
    const resolution = resolveDecision(
      field({
        label: ANDURIL_CLEARANCE_LEVEL_LABEL,
        kind: "select",
        options: ANDURIL_CLEARANCE_LEVEL_OPTIONS,
        optionsKnown: true,
      }),
      decision({
        fieldKey: "clearance level",
        decision: "answer",
        value: "N/A - have never held U.S. security clearance",
        sourceFact: "clearanceLevelHeld",
      }),
      job101Facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("N/A - have never held U.S. security clearance");
    }
  });

  it("answers the yes/no wording of the same question", () => {
    // Not every board draws it the way Anduril does. "Yes, I am eligible for a
    // U.S. security clearance" does not say what a bare "Yes" says, so without
    // the derived restatement the correct stored answer would bail on a two
    // option radio while nothing else could answer it either.
    const resolution = resolveDecision(
      field({
        label: "Are you eligible for a U.S. security clearance?",
        kind: "radio",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "clearance",
        decision: "answer",
        value: "Yes",
        sourceFact: "isEligibleForUsClearance",
      }),
      job101Facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("Yes");
  });

  it("says No to holding an active clearance, which is the truthful answer", () => {
    // Eligible and holding are different questions, and the derived facts keep
    // them apart. Answering "Yes" to holding one out of a true statement about
    // eligibility would be a false statement to a defence contractor.
    expect(job101Facts().get("holdsActiveUsClearance")?.value).toBe("No");
    expect(job101Facts().get("hasEverHeldUsClearance")?.value).toBe("No");
  });

  it("still refuses a clearance question backed by a work authorization fact", () => {
    // The guard that existed before this ticket, unchanged by it. Storing a
    // clearance answer widened step 1 of the ladder; it did not widen what may
    // back a clearance question, and a work authorization fact still may not.
    const resolution = resolveDecision(
      field({
        label: ANDURIL_CLEARANCE_LABEL,
        kind: "select",
        options: ANDURIL_CLEARANCE_OPTIONS,
        optionsKnown: true,
      }),
      decision({
        fieldKey: "clearance",
        decision: "answer",
        value: "Yes, I am eligible for a U.S. security clearance",
        sourceFact: "workAuthorizedUs",
      }),
      job101Facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("refuses a criminal history question backed by a clearance fact", () => {
    // The mirror of the case above, and the reason the scope table is per topic
    // rather than one flat list of "the status facts". Being eligible for a
    // clearance says nothing about a criminal record, and the criminal history
    // topic still admits nothing at all.
    const resolution = resolveDecision(
      field({
        label: "Have you ever been convicted of a felony?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "felony",
        decision: "answer",
        value: "No",
        sourceFact: "isEligibleForUsClearance",
      }),
      job101Facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("still declines for a candidate who has not answered the clearance question", () => {
    // Nothing about this ticket makes an unanswered question answerable. A
    // profile with no stored clearance takes exactly the path it took before.
    const resolution = resolveDecision(
      field({
        label: ANDURIL_CLEARANCE_LABEL,
        kind: "select",
        options: [...ANDURIL_CLEARANCE_OPTIONS, "Prefer not to answer"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "clearance",
        decision: "ask",
        question: "Do you hold one?",
        why: "not established",
      }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.declined).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("issue #108: a sponsorship question is answered in its own jurisdiction", () => {
  /** Virtu's UK question, verbatim. */
  const VIRTU_UK_LABEL =
    "Do you now, or will you in the future, need sponsorship from an employer in order to obtain, extend or renew your authorization to work in the UK?";

  it("refuses to answer a UK sponsorship question from the US sponsorship fact", () => {
    // Observed on a real form, non-deterministically: across seven runs the
    // model answered "No" from `requiresSponsorship` four times and escalated
    // three times, reasoning on those three that a US work authorization fact
    // does not establish a UK one. The escalating branch was right. Safety that
    // rests on the model noticing is not safety, so the rule is in TypeScript.
    const resolution = resolveDecision(
      field({ label: VIRTU_UK_LABEL, kind: "select", options: ["Yes", "No"], optionsKnown: true }),
      decision({
        fieldKey: "uk sponsorship",
        decision: "answer",
        value: "No",
        sourceFact: "requiresSponsorship",
      }),
      job101Facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("refuses the Irish version of the same question from the same fact", () => {
    const resolution = resolveDecision(
      field({
        label: "Will you now or in the future require sponsorship to work in Ireland?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "ireland sponsorship",
        decision: "answer",
        value: "No",
        sourceFact: "requiresSponsorship",
      }),
      job101Facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("refuses a UK work authorization question from the US authorization fact", () => {
    const resolution = resolveDecision(
      field({
        label: "Are you legally authorized to work in the United Kingdom?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "uk work auth",
        decision: "answer",
        value: "Yes",
        sourceFact: "workAuthorizedUs",
      }),
      job101Facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("refuses a Canadian citizenship question from the US citizenship fact", () => {
    // The other place a US specific fact becomes prose that a form of any
    // nationality might read, named in the issue as worth the same treatment.
    const resolution = resolveDecision(
      field({
        label: "Are you a citizen of Canada?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "canada citizen",
        decision: "answer",
        value: "Yes",
        sourceFact: "isUsCitizen",
      }),
      job101Facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("answers the UK question from the answer that is actually about it", () => {
    // The point of the new column. "Yes" is the truthful answer for a US citizen
    // with no UK work authorization, and it is the candidate's own stated answer
    // rather than anything derived across a border.
    const resolution = resolveDecision(
      field({ label: VIRTU_UK_LABEL, kind: "select", options: ["Yes", "No"], optionsKnown: true }),
      decision({
        fieldKey: "uk sponsorship",
        decision: "answer",
        value: "Yes",
        sourceFact: "needsSponsorshipNonUs",
      }),
      job101Facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("Yes");
  });

  it("refuses to answer a US sponsorship question from the non-US fact", () => {
    // The rule runs both ways. "Yes, I would need sponsorship outside the US" is
    // not an answer to a US form either, and letting it through would be the
    // same bug pointing the other direction.
    const resolution = resolveDecision(
      field({
        label:
          "Will you now or in the future require sponsorship for employment visa status in the United States?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "us sponsorship",
        decision: "answer",
        value: "Yes",
        sourceFact: "needsSponsorshipNonUs",
      }),
      job101Facts()
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("still answers the ordinary US sponsorship question exactly as it did", () => {
    // The regression that matters most: the jurisdiction rule must not cost a
    // single answer on the forms that were already working.
    const resolution = resolveDecision(
      field({
        label: "Will you now or in the future require sponsorship for employment visa status?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "sponsorship",
        decision: "answer",
        value: "No",
        sourceFact: "requiresSponsorship",
      }),
      job101Facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("No");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the visa status, high school and address a form asks for by name", () => {
  it("answers Pylon's plain text visa status box from the stated answer", () => {
    // "What is your current visa status?" is a legal attestation drawn as a text
    // input, so prose is never composed for it. Before this ticket there was
    // nothing to type and the run stopped; now there is the candidate's own
    // sentence, and nothing else.
    const resolution = resolveDecision(
      field({ label: "What is your current visa status?", kind: "text" }),
      decision({
        fieldKey: "what is your current visa status?",
        decision: "answer",
        value: "Not applicable, US citizen",
        sourceFact: "visaStatus",
      }),
      job101Facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Not applicable, US citizen");
    }
  });

  it("still stops on a visa status box for a candidate who never gave one", () => {
    const resolution = resolveDecision(
      field({ label: "What is your current visa status?", kind: "text" }),
      decision({
        fieldKey: "what is your current visa status?",
        decision: "generate",
        why: "free text",
      }),
      job101Facts({
        visaStatus: undefined,
        citizenshipStatus: undefined,
        workAuthorizedUs: undefined,
        requiresSponsorship: undefined,
      })
    );
    expect(resolution.kind).toBe("ask");
  });

  it("names the high school all 128 Palantir listings ask for", () => {
    const known = job101Facts();
    expect(known.get("highSchoolName")?.value).toBe("Northview High School");
    expect(known.get("highSchoolGradYear")?.value).toBe("2022");
  });

  it("types the high school into Palantir's own field", () => {
    const resolution = resolveDecision(
      field({ label: "High School Name", kind: "text" }),
      decision({
        fieldKey: "high school name",
        decision: "answer",
        value: "Northview High School",
        sourceFact: "highSchoolName",
      }),
      job101Facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("Northview High School");
  });

  it("answers Belvedere's address fields once they are stored", () => {
    const stored = job101Facts({ streetAddress: "12 Peachtree Street NE", postalCode: "30303" });
    expect(stored.get("streetAddress")?.value).toBe("12 Peachtree Street NE");
    expect(stored.get("postalCode")?.value).toBe("30303");

    const resolution = resolveDecision(
      field({ label: "Street Address", kind: "text" }),
      decision({
        fieldKey: "street address",
        decision: "answer",
        value: "12 Peachtree Street NE",
        sourceFact: "streetAddress",
      }),
      stored
    );
    expect(resolution.kind).toBe("apply");
  });

  it("carries no address fact at all for a candidate who has not given one", () => {
    // This candidate has not, so Belvedere stays blocked. Said out loud in a
    // test rather than papered over: the honest outcome of an unanswered
    // required field is a stopped run and a question, and the run of 2026 08 22
    // that typed "Not provided" into two of these boxes is what the alternative
    // looks like.
    const known = job101Facts();
    expect(known.has("streetAddress")).toBe(false);
    expect(known.has("postalCode")).toBe(false);
  });
});

// ── Issue #100: the declaration the patterns missed, and the refusal that does
// not depend on a pattern at all ────────────────────────────────────────────
//
// A live Avery Dennison run ticked "By checking this box you declare that you
// have read and understood the Privacy Notice" and typed "No" into a non-compete
// question, and reported neither, because a required `needsInput` item that did
// not match `isAttestationField` was handed to `act()` and then dropped from the
// list whenever `act()` did not throw.
//
// The two halves of the fix are tested separately here on purpose, because they
// are not the same kind of thing. The first block is a regex getting wider,
// which fixes the wordings somebody has now seen. The second is a refusal that
// never reads the label, which is what covers the wordings nobody has seen yet.
describe("the agreement wordings the consent pattern used to miss", () => {
  it.each([
    "By checking this box you declare that you have read and understood the Privacy Notice",
    "I declare that the information given in this application is true and complete",
    "I have read and understood the Candidate Privacy Notice",
    "I have read and accept the Terms of Use",
    "Please confirm you have read our Recruitment Privacy Statement",
    "Data Protection Notice",
    "I consent to the processing of my personal data under GDPR",
    "I acknowledge the recruitment privacy notice",
  ])("treats %j as an agreement", (label) => {
    expect(CONSENT_FIELD_RE.test(label)).toBe(true);
  });

  it.each([
    // Every one of these is an ordinary question, and a pattern wide enough to
    // catch a privacy declaration must not start ticking or escalating them.
    // "certificate" is the near miss worth naming: `certify` was deliberately
    // not widened to the stem `certif\w*`, because a skills question about a
    // certificate is not an agreement about anything.
    "Do you hold an AWS certificate?",
    "Which of these books have you read?",
    "How did you hear about us?",
    "Are you at least 18 years old?",
    "What is your expected graduation date?",
    "Describe a project you are proud of",
    "Preferred office location",
    "How many years of professional experience do you have?",
    "Highest level of education completed",
    "Desired salary",
  ])("does not treat %j as one", (label) => {
    expect(CONSENT_FIELD_RE.test(label)).toBe(false);
  });
});

describe("where the widened wording sends the declaration instead", () => {
  const AVERY =
    "By checking this box you declare that you have read and understood the Privacy Notice";

  it("hands a required declaration to the deterministic consent policy, which reports it", () => {
    // Worth being blunt about what widening the pattern actually changes. It
    // does not stop this box being ticked — `applyConsentPolicy` has ticked
    // required agreement boxes since issue #94, on the deliberate product
    // decision recorded there, and this ticket does not revisit it. What
    // changes is which code path does it: a branch that decides in TypeScript
    // and returns a note that reaches the candidate's report, rather than an
    // `act()` call whose work appeared in no report at all.
    const resolution = resolveDecision(
      field({ label: AVERY, kind: "checkbox", required: true }),
      undefined,
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("Yes");
      expect(resolution.note).toContain("a required agreement the form will not submit without");
    }
  });

  it("leaves the same declaration alone when the form does not require it", () => {
    const resolution = resolveDecision(
      field({ label: AVERY, kind: "checkbox", required: false }),
      undefined,
      facts()
    );
    expect(resolution.kind).toBe("skip");
  });
});

describe("a restrictive covenant question is a legal attestation", () => {
  it.each([
    // The second thing the same run answered from nothing. Whether somebody is
    // bound by one of these is a fact about their existing contracts, and this
    // system holds no such fact — so "No" was a statement about a legal
    // obligation made by something that had never been told either way.
    "Are you subject to a non-compete agreement with a current or former employer?",
    "Are you bound by any noncompete or non-solicitation obligations?",
    "Do you have any restrictive covenants that would affect your employment?",
  ])("treats %j as one", (label) => {
    expect(LEGAL_ATTESTATION_RE.test(label)).toBe(true);
    expect(isAttestationField(label)).toBe(true);
  });

  it.each([
    "Are you comfortable working in a competitive environment?",
    "Describe a competition you have won",
    "How competitive is your desired salary?",
  ])("does not treat %j as one", (label) => {
    expect(isAttestationField(label)).toBe(false);
  });

  it("still has nothing in the catalogue that could answer one", () => {
    // The same property criminal history has. `ATTESTATION_FACT_SCOPES` names no
    // topic matching these labels, so the ladder can only ever reach "decline"
    // or "ask" — never "answer it from a stored fact".
    const resolution = resolveDecision(
      field({
        label: "Are you subject to a non-compete agreement?",
        kind: "radio",
        options: ["Yes", "No"],
        optionsKnown: true,
        required: true,
      }),
      decision({
        fieldKey: "are you subject to a non-compete agreement?",
        decision: "answer",
        value: "No",
        sourceFact: "requiresSponsorship",
      }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
  });
});

describe("what the unknown-field fallback refuses, and why", () => {
  const item = (over: Partial<NeedsInputItem> & { fieldLabel: string }): NeedsInputItem => ({
    key: over.fieldLabel.toLowerCase(),
    question: "What should we put?",
    why: "nothing answered it",
    required: true,
    kind: "text",
    ...over,
  });

  it("refuses a checkbox whose label matches nothing at all", () => {
    // This is the whole point of the ticket. The label is as ordinary as a
    // label gets and matches no consent, attestation or demographic pattern
    // anywhere in this codebase, so a regex-based gate lets it through. The
    // refusal is on the shape of the control, so it does not.
    const reason = fallbackRefusalReason(
      item({ fieldLabel: "Which team interests you most?", kind: "checkbox" })
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("never asserts anything in the candidate's name");
  });

  it("refuses a radio group on the same grounds", () => {
    const reason = fallbackRefusalReason(
      item({ fieldLabel: "Which office would you prefer?", kind: "radio" })
    );
    expect(reason).toContain("never asserts anything in the candidate's name");
  });

  it("refuses the Avery Dennison declaration on shape before wording is consulted", () => {
    // Both layers now catch this one, and the order matters for what it proves:
    // the reason given is the structural one, so the run would have refused it
    // even on the day `CONSENT_FIELD_RE` still returned false for this sentence.
    const reason = fallbackRefusalReason(
      item({
        fieldLabel:
          "By checking this box you declare that you have read and understood the Privacy Notice",
        kind: "checkbox",
      })
    );
    expect(reason).toContain("never asserts anything in the candidate's name");
  });

  it("refuses an agreement drawn as a typed field, on the widened wording", () => {
    // A typed control is not refused by shape, so this is the layer the regex
    // is genuinely load bearing for — and the wording it now matches.
    expect(
      fallbackRefusalReason(
        item({
          fieldLabel: "I declare that I have read and understood the Privacy Notice",
          kind: "text",
        })
      )
    ).toContain("only the candidate can give");
  });

  it("refuses a legal attestation and a demographic question", () => {
    expect(
      fallbackRefusalReason(item({ fieldLabel: "Are you subject to a non-compete?", kind: "text" }))
    ).toContain("never best guessed");
    expect(
      fallbackRefusalReason(item({ fieldLabel: "Gender", kind: "combobox" }))
    ).toContain("never best guessed");
  });

  it("leaves an optional question alone rather than guessing at it", () => {
    expect(
      fallbackRefusalReason(
        item({ fieldLabel: "Anything else we should know?", kind: "textarea", required: false })
      )
    ).toContain("blocks nothing");
  });

  it("still allows the ordinary unknown required field it exists for", () => {
    // The Workable compliance dropdown issue #91 added this path for. Refusing
    // everything would be safe and useless; the point is that what survives is
    // typed or chosen from a list the page itself offers, and is now reported.
    expect(
      fallbackRefusalReason(
        item({ fieldLabel: "Which team interests you most?", kind: "combobox" })
      )
    ).toBeNull();
    expect(
      fallbackRefusalReason(item({ fieldLabel: "How did you hear about us?", kind: "text" }))
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("JOB-134: the four questions intake now asks", () => {
  it("states the restrictive covenant answer as the sentence a form asks for", () => {
    // The question that stopped the Avery Dennison run. Both values are stated,
    // because "No, I am not under one" and "Yes, I am" are equally the
    // candidate's own answer and an employer asking has a right to either.
    expect(facts({ subjectToRestrictiveCovenant: false }).get("restrictiveCovenant")?.value).toBe(
      "No"
    );
    expect(facts({ subjectToRestrictiveCovenant: true }).get("restrictiveCovenant")?.value).toBe(
      "Yes"
    );
    expect(facts().get("restrictiveCovenant")).toBeUndefined();
  });

  it("carries the salary expectation in the candidate's own words", () => {
    // HARD STOP 9 names salary expectations outright as something no model may
    // compose, so what reaches a form is the sentence the person wrote.
    expect(facts({ salaryExpectation: "negotiable" }).get("salaryExpectation")?.value).toBe(
      "negotiable"
    );
    expect(facts().get("salaryExpectation")).toBeUndefined();
  });

  it("answers the relatives question from a no and refuses to answer it from a yes", () => {
    // The one asymmetry in the catalogue, and the whole reason these two
    // columns are safe. Intake asks about EVERY employer the person might apply
    // to; the form asks about one named company. "None of them" entails "not
    // this one", so it answers the form. "Some of them" entails nothing about
    // this one, so there is no fact and the question goes to the candidate.
    expect(
      facts({ relativesAtTargetEmployers: false }).get("noRelativesAtThisEmployer")?.value
    ).toBe("No");
    expect(
      facts({ relativesAtTargetEmployers: true }).get("noRelativesAtThisEmployer")
    ).toBeUndefined();
    expect(facts().get("noRelativesAtThisEmployer")).toBeUndefined();
  });

  it("answers the prior employment question the same way and with the same asymmetry", () => {
    expect(
      facts({ previouslyEmployedAtTargetEmployers: false }).get("noPriorEmploymentAtThisEmployer")
        ?.value
    ).toBe("No");
    expect(
      facts({ previouslyEmployedAtTargetEmployers: true }).get("noPriorEmploymentAtThisEmployer")
    ).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("JOB-134: the restrictive covenant scope admits one fact and no other", () => {
  it("answers a non-compete question from the candidate's own stored answer", () => {
    // `ATTESTATION_FACT_SCOPES` used to name no topic matching these labels,
    // for the right reason at the time: nothing in this system knew, so
    // anything answering would have been a guess. Intake asks now, so the
    // premise changed and the rule did not. Same move JOB-101 made for
    // security clearance.
    const resolution = resolveDecision(
      field({
        label: "Are you subject to a non-compete or non-solicitation agreement?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "non-compete",
        decision: "answer",
        value: "No",
        sourceFact: "restrictiveCovenant",
      }),
      facts({ subjectToRestrictiveCovenant: false })
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("No");
  });

  it("still refuses a sponsorship answer for a non-compete question", () => {
    // The pairing the allow-list exists for, tested on the new topic. A
    // sponsorship answer says nothing whatsoever about whether a previous
    // employer's contract binds this person, and both happening to be "No" is
    // luck rather than correctness.
    const resolution = resolveDecision(
      field({
        label: "Are you subject to a non-compete agreement?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "non-compete",
        decision: "answer",
        value: "No",
        sourceFact: "requiresSponsorship",
      }),
      facts({ subjectToRestrictiveCovenant: false })
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("still refuses the covenant answer for a criminal history question", () => {
    // Criminal history admits nothing at all, and always will unless a ticket
    // decides otherwise out loud. Adding a topic next to it must not widen it.
    const resolution = resolveDecision(
      field({
        label: "Have you ever been convicted of a felony?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "felony",
        decision: "answer",
        value: "No",
        sourceFact: "restrictiveCovenant",
      }),
      facts({ subjectToRestrictiveCovenant: false })
    );
    expect(resolution.kind).not.toBe("apply");
  });

  it("still refuses the covenant answer for a work authorization question", () => {
    const resolution = resolveDecision(
      field({
        label: "Are you legally authorized to work in the United States?",
        kind: "select",
        options: ["Yes", "No"],
        optionsKnown: true,
      }),
      decision({
        fieldKey: "work auth",
        decision: "answer",
        value: "Yes",
        sourceFact: "restrictiveCovenant",
      }),
      facts({ subjectToRestrictiveCovenant: true })
    );
    expect(resolution.kind).not.toBe("apply");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("JOB-134: the second run does not ask what the first run was told", () => {
  /**
   * The whole ticket, end to end, with the browser taken out.
   *
   * Run one reaches a required question no stored fact covers and escalates it,
   * reporting a `needsInput` item whose `key` is the form's own label. The
   * candidate answers. Run two is a fresh process against a fresh page with
   * nothing supplied at all, and the question is answered from what they said.
   */
  const question = "are you subject to a non-compete agreement?";
  const nonCompete = () =>
    field({
      label: "Are you subject to a non-compete agreement?",
      kind: "select",
      options: ["Yes", "No"],
      optionsKnown: true,
    });

  it("has nothing to answer the question with on the first run", () => {
    expect(resolveAdditionalAnswer(nonCompete(), {}).kind).toBe("none");
    // And no stored fact covers it either, so the run escalates rather than
    // guessing. That is the state this ticket starts from.
    expect(facts().get("restrictiveCovenant")).toBeUndefined();
  });

  it("answers it on the second run from what the candidate said on the first", () => {
    const stored = rememberAnswers(
      [],
      [{ question, answer: "No" }],
      { now: new Date() }
    );
    // A second run supplies nothing: this is a different application, on a
    // different board, started by a pipeline that was told nothing new.
    const supplied = withStoredAnswers(stored, {});

    const resolution = resolveAdditionalAnswer(nonCompete(), supplied);
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") expect(resolution.value).toBe("No");
  });

  it("puts the answer in the fact catalogue quoting the question it answered", () => {
    // The other half of the reuse, and the half that reaches a differently
    // worded field. The fact's label carries the original question verbatim, so
    // the decision layer can see what was actually answered rather than being
    // handed a bare "No" with no subject attached — and `attestationFactAllowed`
    // has always accepted an `answer:` fact, which is what makes this the
    // existing mechanism rather than a new one.
    const stored = rememberAnswers(
      [],
      [{ question, answer: "No" }],
      { now: new Date() }
    );
    const catalogue = buildFactCatalog(PROFILE, ANSWERS, withStoredAnswers(stored, {}));
    const fact = catalogue.find((entry) => entry.key === `answer:${question}`);

    expect(fact?.value).toBe("No");
    expect(fact?.label).toContain("non-compete agreement");
  });

  it("never carries a demographic answer into the second run", () => {
    // HARD STOP 10, at the seam this ticket created. Nothing that reaches a
    // second run may have come from a demographic question.
    const stored = rememberAnswers(
      [],
      [
        { question: "what is your gender?", answer: "prefer not to say" },
        { question, answer: "No" },
      ],
      { now: new Date() }
    );

    expect(Object.keys(withStoredAnswers(stored, {}))).toEqual([question]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("JOB-134: a remembered answer cannot be swallowed by a short label", () => {
  /**
   * The risk persistence adds, and the tightening that answers it.
   *
   * The fuzzy match has always been substring containment either way round, and
   * it only checked that the SUPPLIED key was long enough to mean something.
   * That was fine while the map held two answers a caller had just been handed
   * about the page in front of them. It is not fine now that it holds every
   * question this person has ever answered, because a long question contains a
   * great many short strings.
   */
  const remembered = { "how many years of experience do you have with python?": "4" };

  it("does not type a python answer into a field labelled Experience", () => {
    expect(resolveAdditionalAnswer(field({ label: "Experience" }), remembered).kind).toBe("none");
    expect(resolveAdditionalAnswer(field({ label: "Python" }), remembered).kind).toBe("none");
    // And the one that would have been most wrong: a short label that appears
    // inside a stored question about something else entirely.
    expect(resolveAdditionalAnswer(field({ label: "Years" }), remembered).kind).toBe("none");
  });

  it("still matches a three word heading, which is where this rule stops", () => {
    // Asserted so the boundary is visible rather than assumed. "Years of
    // experience" is three words, so it still takes the answer to a question
    // about Python years, and that is not obviously right. It is left alone
    // here because it is exactly what this rule did before this ticket, and
    // because narrowing it further starts costing real matches: JOB-132's own
    // key is a truncation of a 240 character label, and every rule that would
    // reject a heading also came close to rejecting that.
    expect(
      resolveAdditionalAnswer(field({ label: "Years of experience" }), remembered).kind
    ).toBe("apply");
  });

  it("still answers the question that was actually asked", () => {
    // The exact-match pass is untouched, and the fuzzy pass still works between
    // two questions that are both long enough to mean something.
    const exact = resolveAdditionalAnswer(
      field({ label: "How many years of experience do you have with Python?" }),
      remembered
    );
    expect(exact.kind).toBe("apply");

    const contained = resolveAdditionalAnswer(
      field({
        label: "For our records: how many years of experience do you have with Python? (required)",
      }),
      remembered
    );
    expect(contained.kind).toBe("apply");
  });
});
