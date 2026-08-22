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
  isAttestationField,
  resolveAdditionalAnswer,
  resolveDecision,
  LEGAL_ATTESTATION_RE,
} from "@/lib/fill-application-form";
import type { CandidateApplicationAnswers } from "@/lib/candidate-intake";
import type { CandidateFact, FieldDecision, ResumeProfile } from "@/lib/resume-parser";
import type { EnumeratedField } from "@/lib/form-fields";

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
  const item = (fieldLabel: string) => ({
    key: fieldLabel.toLowerCase(),
    fieldLabel,
    question: `What about "${fieldLabel}"?`,
    why: "nothing supplies this",
    required: true,
    kind: "select" as const,
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
