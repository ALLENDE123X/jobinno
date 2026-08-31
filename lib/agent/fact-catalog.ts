/**
 * JOB-277 (sub ticket A of #276): scaffold for the agent's fact catalog.
 *
 * The fact catalog is the read only view of a user's intake data the agent
 * loop sees. Every free text answer the agent produces has to trace back to a
 * path in this catalog, or it must decline the field. That is what enforces
 * HARD STOP 9 (no fabricated facts) at the tool boundary in `tools.ts` rather
 * than as a review after the fact.
 *
 * JOB-296 (sub ticket G): `buildFactCatalog` was hoisted here from
 * `lib/fill-application-form.ts`, where the widget fill built the same fact
 * catalogue for its own decision layer. Both layers now read one builder, so
 * the fact keys, labels and sources a fill consumes are the same ones the
 * agent loop is grounded in. The hoisted block keeps its fill layer narrative
 * (JOB-022, JOB-101, JOB-134) intact because that reasoning is load bearing.
 * `US_COUNTRY_RE` and `geographyHints` belong to the fill layer, so the regex
 * is re-exported for it while the hints stay home.
 *
 * The database backed builder sub ticket B of #277 promises is still a stub:
 * `buildAgentFactCatalog` below reads nothing yet and throws, so no caller can
 * accidentally ship a run that thinks it read from the catalog.
 */

import { AgentFillNotImplementedError } from "@/lib/agent";
import type { CandidateApplicationAnswers } from "@/lib/candidate-intake";
import type { CandidateFact, DocumentSource, ResumeProfile } from "@/lib/resume-parser";

/**
 * The shape the agent loop reads. Kept intentionally narrow at scaffold time;
 * sub ticket B widens it in the same file.
 *
 * `entries` is the flat list of facts. A single `FactEntry` binds a dotted
 * `path` (the identifier the agent quotes on `setFieldValue` calls via
 * `intakeFactPath`) to the underlying `value`, plus a short human `label` for
 * prompt inclusion and the `source` the fact came from (which is what makes it
 * possible to audit later whether the agent quoted a real answer or something
 * it inferred).
 */
export interface FactEntry {
  path: string;
  label: string;
  value: string | number | boolean | null;
  source: "profile" | "resume" | "candidate_answer";
}

export interface FactCatalog {
  userId: string;
  entries: FactEntry[];
}

/** Countries whose name means "the US" for the purpose of a derived fact. */
export const US_COUNTRY_RE = /^(the\s+)?(united\s+states(\s+of\s+america)?|u\.?s\.?a?\.?|america)$/i;

/**
 * Everything this system knows about the candidate, as a keyed catalogue.
 * The keys are the same ones the widget fill's `fillMergeFields` matches
 * against, so a fill and the agent view of the same person stay congruent:
 * intent here is one narration of the same facts, not a competing one.
 *
 * The catalogue is built from two sources: the intake answers for fields the
 * intake knows, and the profile the resume parser produced (plus the resume
 * text itself for the linkedin URL when the profile doesn't have one). Every
 * entry carries the source it came from so the agent loop can answer "where
 * did you get that?" and so the attestation gate in the fill layer can tell
 * a fact the user gave us from one the model produced.
 *
 * It is a closed catalogue: every key is computed, none are added at hit time,
 * and the run's read of the catalogue cannot influence its build. That is what
 * keeps the swift path prompt deterministic and the attestation gate sound.
 * The first version of this catalogue was not the set of things known about
 * the candidate; it was a seventeen item subset of it, and everything outside
 * the subset was reported to the user as something the system could not
 * truthfully answer, which was false.
 *
 * So the catalogue now carries what is actually known: every education entry
 * rather than the first, every job rather than the first, the skills list, the
 * links, the four intake columns nobody was reading, the stated target
 * locations, and a handful of facts derived in TypeScript from those (a
 * graduation year out of a graduation date, a years of experience count out of
 * the work history). It is still a closed catalogue, still keyed, and an
 * attestation field still may not be answered from anything outside it. What
 * changed is that it stopped being a list of the questions the system was
 * willing to answer and went back to being a description of the person.
 */
/**
 * JOB-112. Which document a work or education entry came from, said in the
 * fact's own label.
 *
 * The label is where this belongs rather than a new field on `CandidateFact`,
 * because the label is what actually travels: it is what `decideFieldAnswers`
 * reads when it chooses between two facts for one form field, and it is what a
 * skip_log row quotes when a run stops. A run that put the wrong graduation
 * date on a form can then be traced to the document that supplied it without
 * anyone re-deriving the parse to find out.
 *
 * Empty for a resume-sourced entry, which keeps every existing label and every
 * existing test unchanged: the resume was the only source before this ticket,
 * so "unlabelled" already means "from the resume".
 */
function sourceSuffix(source: DocumentSource | undefined): string {
  return source === "linkedin" ? " (from their LinkedIn export)" : "";
}

export function buildFactCatalog(
  profile: ResumeProfile,
  answers: CandidateApplicationAnswers,
  additionalAnswers: Record<string, string>
): CandidateFact[] {
  const facts: CandidateFact[] = [];
  const add = (key: string, label: string, value: string | null | undefined): void => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text !== "") facts.push({ key, label, value: text });
  };
  const yesNo = (value: boolean | undefined): string | null =>
    value === undefined ? null : value ? "Yes" : "No";

  add("firstName", "First name", profile.firstName);
  add("lastName", "Last name", profile.lastName);
  add(
    "fullName",
    "Full name",
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null
  );
  add("email", "Email address", profile.email);
  add("phone", "Phone number", profile.phone);
  add("linkedinUrl", "LinkedIn profile URL", profile.linkedinUrl);
  add("websiteUrl", "Personal website / portfolio URL", profile.websiteUrl);
  add("resumeLocation", "Location printed on their resume", profile.location);

  add("currentCountry", "Country they currently live in", answers.currentCountry);
  add("currentCity", "City they currently live in", answers.currentCity);
  add(
    "workAuthorizedUs",
    "Legally authorized to work in the United States",
    yesNo(answers.workAuthorizedUs)
  );
  // The label names the United States out loud, which it did not before JOB-101.
  // The column has always been a US only fact, derived from a US citizenship
  // status, but the sentence handed to the model did not say so, and issue #108
  // is what that cost: across seven runs of Virtu's UK sponsorship question the
  // model answered "No" from this fact four times and spotted the jurisdiction
  // mismatch three times. Saying it in the label is not the fix — that is
  // `attestationFactAllowed` below, in TypeScript — but a prompt that describes
  // a fact accurately should not be left describing it ambiguously.
  add(
    "requiresSponsorship",
    "Will now or in future require visa sponsorship to work in the United States",
    yesNo(answers.requiresSponsorship)
  );
  // Issue #108's other half: the jurisdiction the fact above never covered.
  add(
    "needsSponsorshipNonUs",
    "Will need visa sponsorship to work anywhere outside the United States",
    yesNo(answers.needsSponsorshipNonUs)
  );
  add("willingToRelocate", "Willing to relocate for a role", yesNo(answers.willingToRelocate));

  // A job applicant is by definition at least the minimum working age. Boards
  // that ask "Are you at least 18 years old?" are asking whether the candidate
  // is eligible to work, and a candidate who submitted a resume implicitly
  // asserts that they are. The constant "Yes" is not a guess; it is the only
  // answer that is consistent with being a job applicant at all.
  add("minimumAge", "At least 18 years old (minimum working age)", "Yes");

  // Derived, in TypeScript rather than by a model: "they live in the United
  // States" entails "they are currently located in the US". That is an
  // entailment, not an inference about a person, and boards ask it as often as
  // they ask for the country itself.
  if (answers.currentCountry !== undefined) {
    add(
      "locatedInUs",
      "Currently located in the United States (from the country they gave)",
      US_COUNTRY_RE.test(answers.currentCountry.trim()) ? "Yes" : "No"
    );
  }

  // ── JOB-022: the intake columns nobody was reading ───────────────────────
  add("citizenshipStatus", "Citizenship or immigration status they stated at intake",
    describeCitizenship(answers.citizenshipStatus, answers.f1Status));
  // The same stored status, projected onto the yes/no shape half these questions
  // are actually drawn with. Without this the flagship fix did not reach them:
  // "Are you a citizen or national of the United States?" with Yes/No options
  // could not be answered, because the sentence "A United States citizen or
  // national" does not say what the option "Yes" says, and the attestation
  // ladder has nothing else to try. Review caught that the correct fact bailed
  // while a wrong one passed, which is the worst possible pairing.
  //
  // Every arm is a restatement of one enum value, and a status the enum records
  // as "other" produces nothing at all rather than a guessed "No".
  for (const [key, label, value] of citizenshipYesNo(answers.citizenshipStatus)) {
    add(key, label, value);
  }
  add("earliestStartDate", "Earliest date they can start work (ISO)", answers.earliestStart);
  add("graduationDate", "Graduation date (ISO)", answers.gradDate);
  const gradParts = splitIsoDate(answers.gradDate);
  if (gradParts !== null) {
    add("graduationYear", "Year they graduate or graduated", gradParts.year);
    add("graduationMonth", "Month they graduate or graduated", gradParts.monthName);
  }
  const startParts = splitIsoDate(answers.earliestStart);
  if (startParts !== null) {
    add("earliestStartYear", "Year they can start work", startParts.year);
    add("earliestStartMonth", "Month they can start work", startParts.monthName);
  }
  if (answers.targetLocations !== undefined && answers.targetLocations.length > 0) {
    add(
      "targetLocations",
      "Places they said they want to work, most preferred first",
      answers.targetLocations.join(", ")
    );
    add("topLocationPreference", "Their most preferred work location", answers.targetLocations[0]);
  }

  // ── JOB-101: the answers that were blocking real applications ────────────
  //
  // The same shape as the JOB-022 block above and for the same reason: each one
  // is a column intake now collects, and a column the fill layer cannot name is
  // a column the decision layer cannot cite, because `resolveDecision` refuses
  // an answer with no `sourceFact` behind it.
  //
  // The clearance facts and the visa status are legal attestations. Listing
  // them here does not make them answerable by anything that happens to be
  // nearby: `attestationFactAllowed` scopes a clearance question to the
  // clearance facts alone, and every one of these is refused for a question it
  // is not about.
  add(
    "clearanceEligibility",
    "US security clearance eligibility they stated at intake",
    describeClearanceEligibility(answers.clearanceEligibility)
  );
  add(
    "clearanceLevelHeld",
    "Highest US security clearance they have ever held, as they stated it at intake",
    describeClearanceLevel(answers.clearanceLevelHeld)
  );
  // The same two stored answers projected onto the yes/no shape a good share of
  // these questions are drawn with, exactly as `citizenshipYesNo` does for the
  // citizenship status and for the same reason: the sentence "Yes, I am
  // eligible for a U.S. security clearance" does not say what a bare "Yes"
  // option says, so without these the stored answer would bail on every
  // question drawn as a two option radio. Every arm is a restatement of one
  // enum value, and an unrecognised value produces nothing at all.
  for (const [key, label, value] of clearanceYesNo(
    answers.clearanceEligibility,
    answers.clearanceLevelHeld
  )) {
    add(key, label, value);
  }
  add(
    "visaStatus",
    "Their current visa status, in their own words, as stated at intake",
    answers.visaStatus
  );

  // ── JOB-134: the four questions every employer asks and nothing stored ───
  //
  // Same shape as the JOB-022 and JOB-101 blocks above and added on the same
  // evidence: a required field on a real employer's form had no stored answer
  // behind it, so the run stopped and the candidate was asked something they
  // will be asked again by the next employer and the one after that.
  //
  // The restrictive covenant answer is a legal attestation and arrives under
  // the rule rather than around it: `attestationFactAllowed` scopes it to a
  // non-compete or non-solicit question and to nothing else, and scopes every
  // other fact out of that question. Both values are stated, because "No, I am
  // not under one" and "Yes, I am" are equally the candidate's own answer and
  // an employer asking has a right to either.
  add(
    "restrictiveCovenant",
    "Subject to a non-compete, non-solicitation or other restrictive covenant from a previous employer",
    yesNo(answers.subjectToRestrictiveCovenant)
  );
  // ── The two that only speak when the answer is "no" ──────────────────────
  //
  // These are the one asymmetry in this whole catalogue and it is deliberate.
  // The form asks about ONE named employer ("do you have relatives employed by
  // Avery Dennison?"); intake asks about ALL of them ("do you have relatives
  // employed by any company you might apply to?"). "None of them" entails "not
  // this one", so a false answer truthfully answers every employer's version of
  // the question. "Some of them" entails nothing at all about this employer, so
  // there is no fact to write and the question goes to the candidate, which is
  // exactly where a question only they can answer belongs. Writing a "Yes" here
  // would be the system telling an employer something nobody told it.
  if (answers.relativesAtTargetEmployers === false) {
    add(
      "noRelativesAtThisEmployer",
      "Has no relatives or immediate family employed at any company they are applying to, this one included",
      "No"
    );
  }
  if (answers.previouslyEmployedAtTargetEmployers === false) {
    add(
      "noPriorEmploymentAtThisEmployer",
      "Has never previously been employed by any company they are applying to, this one included",
      "No"
    );
  }
  // HARD STOP 9 names salary expectations outright as something no model may
  // compose, which is why this is the candidate's own words and never a number
  // derived from a title, a location or a market rate.
  add(
    "salaryExpectation",
    "Salary or compensation they expect, in their own words, as stated at intake",
    answers.salaryExpectation
  );

  add("highSchoolName", "The high school they attended", answers.highSchoolName);
  add(
    "highSchoolGradYear",
    "Year they graduated high school",
    answers.highSchoolGradYear === undefined ? null : String(answers.highSchoolGradYear)
  );
  add("streetAddress", "Their street address", answers.streetAddress);
  add("postalCode", "Their postal or ZIP code", answers.postalCode);

  // ── JOB-022: the whole resume, not its first row ─────────────────────────
  // `workHistory[0]` and `education[0]` were the only two entries that ever
  // reached a form. A form asking "which university are you currently
  // attending?" against a candidate whose current school is their second
  // education entry got nothing, and so did anything asking about a previous
  // employer. Both lists are validated and length capped by `resume-parser.ts`
  // before they get here, so exposing all of them costs nothing but prompt.
  profile.workHistory.forEach((entry, index) => {
    const where = index === 0 ? "Most recent" : `Job ${index + 1} (older)`;
    const from = sourceSuffix(entry.source);
    add(`work${index}.employer`, `${where}: employer${from}`, entry.company);
    add(`work${index}.title`, `${where}: job title${from}`, entry.title);
    add(`work${index}.dates`, `${where}: dates${from}`, joinDates(entry.startDate, entry.endDate));
    add(`work${index}.summary`, `${where}: what they did${from}`, entry.summary);
  });
  const experience = totalYearsOfExperience(profile.workHistory);
  if (experience !== null) {
    add(
      "yearsOfExperience",
      "Total years of work experience, counted from the dates on their resume",
      experience
    );
  }
  profile.education.forEach((entry, index) => {
    const where = index === 0 ? "Most recent" : `Education ${index + 1} (older)`;
    const from = sourceSuffix(entry.source);
    add(`education${index}.school`, `${where}: school${from}`, entry.school);
    add(`education${index}.degree`, `${where}: degree${from}`, entry.degree);
    add(`education${index}.discipline`, `${where}: field of study${from}`, entry.discipline);
    add(`education${index}.endDate`, `${where}: end date${from}`, entry.endDate);
  });
  // Kept under their historical keys as well as the indexed ones above, because
  // these three are what every previous run's cache and every existing test
  // names, and renaming a fact key is a silent behaviour change.
  const school = profile.education[0];
  if (school !== undefined) {
    const from = sourceSuffix(school.source);
    add("school", `Most recent school${from}`, school.school);
    add("degree", `Most recent degree${from}`, school.degree);
    add("discipline", `Field of study${from}`, school.discipline);
  }
  const job = profile.workHistory[0];
  if (job !== undefined) {
    const from = sourceSuffix(job.source);
    add("mostRecentEmployer", `Most recent employer${from}`, job.company);
    add("mostRecentTitle", `Most recent job title${from}`, job.title);
  }
  if (profile.skills.length > 0) {
    add("skills", "Skills and technologies listed on their resume", profile.skills.join(", "));
  }
  // A GitHub URL is asked for by name on a large share of engineering forms and
  // was reported unanswerable four times in one run. `profile.githubUrl` is the
  // real thing now (JOB-044: `profiles.github_url`, threaded through
  // `CandidateRecord` in `lib/candidate-intake.ts`) and wins whenever the
  // candidate has stated it. The inference below is the fallback for everyone
  // who has not — most candidates, until the intake form grows a field for it —
  // and is otherwise unchanged: the resume parse already validates and
  // sanitises both URL fields, so this only says which one is GitHub.
  const github =
    profile.githubUrl ??
    [profile.websiteUrl, profile.linkedinUrl].find(
      // Anchored at the scheme and matched against the host, so that a path
      // spelling `/github.com/` on some other origin cannot claim to be one.
      // `sanitizeUrl` has already confirmed both of these are https and on the
      // host they claim; this only says which of the two is the GitHub one.
      (url) => typeof url === "string" && /^https:\/\/([a-z0-9-]+\.)*github\.(com|io)(\/|$)/i.test(url)
    );
  add("githubUrl", "Their GitHub URL", github ?? null);

  // The user's own answers from a previous `needsInput` round. Highest-quality
  // facts in the catalogue — they came from the person themselves — and keyed by
  // the form label they answered, so a differently-worded field asking the same
  // thing can still be matched to one.
  for (const [key, value] of Object.entries(additionalAnswers)) {
    add(`answer:${key}`, `The candidate's own answer to "${key}"`, value);
  }

  return facts;
}

/** The month names a form's own dropdown uses, indexed the way a date is. */
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * `profiles.citizenship_status` and `f1_status` as a sentence a form can be
 * answered from.
 *
 * The enum values are database spellings and mean nothing to a model reading a
 * form that says "A United States citizen or national". This is a lookup table,
 * not an inference: each arm restates the one value the person selected at
 * intake, and an unrecognised value is passed through rather than guessed at.
 */
function describeCitizenship(status: string | undefined, f1: string | undefined): string | null {
  if (status === undefined || status.trim() === "") return null;
  switch (status.trim()) {
    case "us_citizen":
      return "A United States citizen or national";
    case "permanent_resident":
      return "A lawful permanent resident of the United States, that is a Green Card holder";
    case "f1": {
      const kind = (f1 ?? "").trim();
      const suffix =
        kind === "opt"
          ? " currently on OPT"
          : kind === "cpt"
            ? " currently on CPT"
            : "";
      return `An international student in the United States on an F-1 student visa${suffix}`;
    }
    case "h1b":
      return "In the United States on an H-1B work visa";
    default:
      return status.trim();
  }
}

/**
 * The yes/no facts that follow directly from one `citizenship_status` value.
 *
 * A lookup table, not an inference. "Other" is deliberately absent from every
 * arm: it means the person told us their status is none of the four, which
 * settles nothing about any of these questions, and answering "No" on their
 * behalf would be the invention this whole design exists to prevent.
 *
 * `isUsPersonForExportControl` covers citizens and lawful permanent residents.
 * A refugee or asylee is also a US person under the regulation and is not one of
 * the values intake collects, which is why "other" yields nothing here rather
 * than a "No" that could be materially wrong.
 */
function citizenshipYesNo(status: string | undefined): [string, string, string][] {
  switch ((status ?? "").trim()) {
    case "us_citizen":
      return [
        ["isUsCitizen", "Is a United States citizen or national", "Yes"],
        ["isUsPermanentResident", "Is a United States lawful permanent resident", "No"],
        ["isUsPersonForExportControl", "Is a US person for export control purposes", "Yes"],
      ];
    case "permanent_resident":
      return [
        ["isUsCitizen", "Is a United States citizen or national", "No"],
        ["isUsPermanentResident", "Is a United States lawful permanent resident", "Yes"],
        ["isUsPersonForExportControl", "Is a US person for export control purposes", "Yes"],
      ];
    case "f1":
    case "h1b":
      return [
        ["isUsCitizen", "Is a United States citizen or national", "No"],
        ["isUsPermanentResident", "Is a United States lawful permanent resident", "No"],
        ["isUsPersonForExportControl", "Is a US person for export control purposes", "No"],
      ];
    default:
      return [];
  }
}

/**
 * `profiles.clearance_eligibility` as the sentence the board itself uses.
 *
 * A lookup table, not an inference, and the arms are Anduril's own option text
 * rather than a paraphrase of it. That is deliberate: `optionSupportsFact`
 * compares this value against the option a control offers, so a fact worded the
 * way the question is worded is the difference between the stored answer being
 * chosen and the stored answer being declined as not saying what the option
 * says. An unrecognised value is passed through rather than guessed at.
 */
function describeClearanceEligibility(status: string | undefined): string | null {
  switch ((status ?? "").trim()) {
    case "active_clearance":
      return "Yes, I hold an active U.S. security clearance";
    case "eligible":
      return "Yes, I am eligible for a U.S. security clearance";
    case "no":
      return "No";
    default:
      return (status ?? "").trim() || null;
  }
}

/** `profiles.clearance_level_held`, in the words the follow up question uses. */
function describeClearanceLevel(level: string | undefined): string | null {
  switch ((level ?? "").trim()) {
    case "never_held":
      return "N/A - have never held U.S. security clearance";
    case "confidential":
      return "Confidential";
    case "secret":
      return "Secret";
    case "top_secret":
      return "Top Secret";
    default:
      return (level ?? "").trim() || null;
  }
}

/**
 * The yes/no facts that follow directly from the two stored clearance answers.
 *
 * A lookup table, exactly like `citizenshipYesNo`, and bounded the same way: an
 * unrecognised value yields nothing rather than a "No" nobody said. Note that
 * `active_clearance` produces "Yes" for eligibility as well, because holding a
 * clearance is the strongest possible statement of being eligible for one, and
 * that is a restatement rather than an inference about a person.
 *
 * `hasEverHeldUsClearance` is read off the level rather than off the
 * eligibility, because they are different questions: somebody eligible for a
 * clearance today may never have held one, which is exactly the pair of answers
 * this candidate gave.
 */
function clearanceYesNo(
  eligibility: string | undefined,
  level: string | undefined
): [string, string, string][] {
  const facts: [string, string, string][] = [];
  switch ((eligibility ?? "").trim()) {
    case "active_clearance":
      facts.push(
        ["holdsActiveUsClearance", "Holds an active US security clearance", "Yes"],
        ["isEligibleForUsClearance", "Is eligible for a US security clearance", "Yes"]
      );
      break;
    case "eligible":
      facts.push(
        ["holdsActiveUsClearance", "Holds an active US security clearance", "No"],
        ["isEligibleForUsClearance", "Is eligible for a US security clearance", "Yes"]
      );
      break;
    case "no":
      facts.push(
        ["holdsActiveUsClearance", "Holds an active US security clearance", "No"],
        ["isEligibleForUsClearance", "Is eligible for a US security clearance", "No"]
      );
      break;
  }
  switch ((level ?? "").trim()) {
    case "never_held":
      facts.push(["hasEverHeldUsClearance", "Has ever held a US security clearance", "No"]);
      break;
    case "confidential":
    case "secret":
    case "top_secret":
      facts.push(["hasEverHeldUsClearance", "Has ever held a US security clearance", "Yes"]);
      break;
  }
  return facts;
}

/** An ISO date as the two pieces a form's month and year dropdowns want. */
function splitIsoDate(iso: string | undefined): { year: string; monthName: string } | null {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec((iso ?? "").trim());
  if (match === null) return null;
  const monthIndex = Number(match[2]) - 1;
  const monthName = MONTH_NAMES[monthIndex];
  if (monthName === undefined) return null;
  return { year: match[1]!, monthName };
}

/** "Jan 2024" and "Present" as the one string a resume prints. */
function joinDates(start: string | null, end: string | null): string | null {
  const from = (start ?? "").trim();
  const to = (end ?? "").trim();
  if (from === "" && to === "") return null;
  if (from === "") return to;
  if (to === "") return from;
  return `${from} to ${to}`;
}

/**
 * Years of work experience, counted rather than asked for.
 *
 * "How many years of industry experience do you have?" was a required field on
 * three separate forms in the 2026 08 20 run and stopped all three, against a
 * resume that lists the jobs it would be counted from. Counting it here rather
 * than letting a model estimate it keeps it a report of the resume.
 *
 * ── Rewritten after review on this PR ───────────────────────────────────────
 * The first version measured the SPAN: earliest start to latest end. A span
 * counts the gaps between jobs as though they were jobs. The resume this feature
 * exists for is a student's, and a student's resume is mostly gaps: two summer
 * internships, June to September 2019 and June 2025 to present, produced "7"
 * for someone with roughly nine months of work. Seven years of industry
 * experience is not a rounding error on a real application, it is a different
 * person, and it would have been typed into three forms as a stated fact.
 *
 * So this sums the intervals instead, merging any that overlap so that two
 * concurrent jobs are one stretch of time rather than two. Same two internships
 * now give "0", which is the truthful answer for a new grad and the one they
 * would write themselves.
 *
 * Still deliberately coarse: resume dates are years, months are not parsed, and
 * a job listed only as "2019" counts as that one year. It is an approximation of
 * an approximation, since every candidate answering this box is estimating too,
 * and the number only has to be defensible against the dates on their own
 * resume. Undercounting slightly is the right direction for the error to run.
 */
function totalYearsOfExperience(history: readonly { startDate: string | null; endDate: string | null }[]): string | null {
  const thisYear = new Date().getUTCFullYear();
  const yearIn = (value: string | null, whenPresent: number | null): number | null => {
    const text = (value ?? "").trim();
    if (text === "") return null;
    if (/^(present|current|now|ongoing)$/i.test(text)) return whenPresent;
    const found = /\b(19|20)\d{2}\b/.exec(text);
    return found === null ? null : Number(found[0]);
  };

  // An entry with no readable start contributes nothing. A missing end is read
  // as still going, which is what an ongoing role on a resume means.
  const spans: [number, number][] = [];
  for (const entry of history) {
    const start = yearIn(entry.startDate, null);
    if (start === null) continue;
    const end = Math.min(yearIn(entry.endDate, thisYear) ?? thisYear, thisYear);
    if (end < start) continue;
    spans.push([start, end]);
  }
  if (spans.length === 0) return null;

  // Merge overlapping and touching spans, then add up what is left. Touching
  // counts as overlapping: 2019-2021 and 2021-2023 is one four year stretch and
  // not two, because the shared year is one year of somebody's life either way.
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [from, to] = spans[0]!;
  for (const [start, end] of spans.slice(1)) {
    if (start <= to) {
      to = Math.max(to, end);
      continue;
    }
    total += to - from;
    [from, to] = [start, end];
  }
  total += to - from;
  return String(Math.max(0, total));
}

/**
 * Resolves a dotted `path` against a `FactCatalog` and returns the entry when
 * one exists. Kept as a small helper here rather than inlined into `tools.ts`
 * so the exclusion list wrapper can be tested in isolation with a mock
 * resolver. The scaffold implementation is a plain linear scan. Sub ticket B
 * may replace it with an indexed lookup once the catalog is large enough for
 * that to matter.
 */
export function resolveFactPath(
  catalog: FactCatalog,
  path: string
): FactEntry | undefined {
  return catalog.entries.find((entry) => entry.path === path);
}

/**
 * Stub. Returns a typed empty catalog shape for a given user id so that
 * subsequent tickets can widen this in place without breaking every
 * downstream import; today every call throws so no caller can accidentally
 * ship a run that thinks it read from the catalog.
 *
 * JOB-296 (sub ticket G) renamed this from `buildFactCatalog` so the ported
 * builder above could take the name. Sub ticket B reads the profile, resume,
 * and candidate answers for `userId` and populates the returned catalog.
 */
export async function buildAgentFactCatalog(userId: string): Promise<FactCatalog> {
  // Reference the argument so eslint does not flag it while the body is a
  // stub; sub ticket B reads the profile, resume, and candidate answers
  // for `userId` and populates the returned catalog.
  void userId;
  throw new AgentFillNotImplementedError("buildAgentFactCatalog");
}
