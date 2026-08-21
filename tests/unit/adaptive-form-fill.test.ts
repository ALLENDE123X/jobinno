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
    // Jan 2023 to Sep 2024, rounded down to whole years. Coarse on purpose:
    // every candidate answering this box is estimating too, and the number only
    // has to be defensible against the dates on their own resume.
    expect(facts().get("yearsOfExperience")?.value).toBe("1");
  });

  it("names the GitHub URL that four separate forms asked for by name", () => {
    expect(facts().get("githubUrl")?.value).toBe("https://github.com/pat-example");
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
      field({
        label: "Location (City)",
        kind: "combobox",
        options: [
          "San Francisco, California, United States",
          "San Francisco de Macorís, Duarte, Dominican Republic",
          "South San Francisco, California, United States",
        ],
        optionsKnown: true,
      }),
      decision({ fieldKey: "location (city)", decision: "answer", value: "San Francisco", sourceFact: "currentCity" }),
      facts()
    );
    expect(resolution.kind).toBe("apply");
    if (resolution.kind === "apply") {
      expect(resolution.value).toBe("San Francisco, California, United States");
    }
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

  it("never ticks an agreement box on the candidate's behalf", () => {
    const resolution = resolveDecision(
      field({ label: "I certify that the information given is true", kind: "checkbox" }),
      decision({ fieldKey: "i certify", decision: "infer", value: "Yes", why: "best guess" }),
      facts()
    );
    expect(resolution.kind).toBe("ask");
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
