/**
 * JOB-277 (sub ticket A of #276): scaffold for the agent's fact catalog.
 * JOB-316: `buildFactCatalog` implemented for real.
 *
 * The fact catalog is the read only view of a user's intake data the agent
 * loop sees. Every free text answer the agent produces has to trace back to a
 * path in this catalog, or it must decline the field. That is what enforces
 * HARD STOP 9 (no fabricated facts) at the tool boundary in `tools.ts` rather
 * than as a review after the fact.
 *
 * ── Where the keys come from (JOB-316) ──────────────────────────────────────
 * The path spellings below are ported from the widget path's own
 * `buildFactCatalog` in `lib/fill-application-form.ts`, which is the source of
 * truth for the key vocabulary (`fullName`, `email`, `phone`, `linkedinUrl`,
 * `githubUrl`, `workAuthorizedUs`, `requiresSponsorship`, `currentCity`,
 * `visaStatus`, `salaryExpectation`, the `work{N}.*` and `education{N}.*`
 * families, and the `answer:` prefix for the person's own stored answers).
 * Ported rather than imported, deliberately: `lib/fill-application-form.ts` is
 * the widget patching module this path exists to route around, and importing
 * it from here is exactly the module cycle PR #297 demonstrated. Keeping the
 * spellings identical is what lets a human diff the two catalogs when they
 * disagree.
 *
 * What is deliberately NOT ported: the widget path's derived projections
 * (`citizenshipYesNo`, `clearanceYesNo`, `minimumAge`, `locatedInUs`, the
 * split month and year facts). Those exist to satisfy the widget decision
 * layer's exact match ladder. The agent loop reads raw facts and may restate
 * them itself under the `inferred` source hint, so the catalog here carries
 * the person's stored values verbatim and nothing computed on their behalf.
 * A fact that never enters the catalog can never be quoted, which fails
 * closed under HARD STOP 9.
 */

import { assertSupabaseProject } from "@/lib/supabase-project-guard";

import type { CandidateRecord } from "@/lib/candidate-intake";
import type { ResumeProfile } from "@/lib/resume-parser";

/**
 * The shape the agent loop reads.
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

/**
 * What the wet loader hands the pure mapper: the person's `profiles` row (as
 * `loadCandidate` shapes it, stored answers included) and the parsed resume
 * profile when one could be resolved. `profile` is null when nothing usable
 * exists, and the catalog that results is the correct partial shape: profile
 * column facts and stored answers present, resume derived facts absent.
 */
export interface IntakeSnapshot {
  candidate: CandidateRecord;
  profile: ResumeProfile | null;
}

/**
 * The seam that makes `buildFactCatalog` testable without a database. The
 * default loader is the real wet path below; a test injects a synthetic
 * snapshot and exercises the mapping alone.
 */
export interface BuildFactCatalogDeps {
  loadIntake?: (userId: string) => Promise<IntakeSnapshot>;
}

/**
 * Anchored at the scheme and matched against the host, same as the widget
 * path's inference: a path spelling `/github.com/` on some other origin cannot
 * claim to be a GitHub URL.
 */
const GITHUB_HOST_RE = /^https:\/\/([a-z0-9-]+\.)*github\.(com|io)(\/|$)/i;

/**
 * The pure half: intake snapshot in, fact entries out. Exported so the unit
 * tests pin the key vocabulary and the partial shapes without any wet
 * machinery in the way.
 *
 * The `add` helper drops null, undefined and empty string values rather than
 * writing placeholders, for the same reason `toApplicationAnswers` does: "we
 * do not know" and "the answer is no" are different statements on a real job
 * application, and a fact that is absent from the catalog becomes a
 * `markFieldUnanswerable` call instead of a guess.
 */
export function factEntriesFrom(
  candidate: CandidateRecord,
  profile: ResumeProfile | null
): FactEntry[] {
  const entries: FactEntry[] = [];
  const add = (
    path: string,
    label: string,
    value: string | number | boolean | null | undefined,
    source: FactEntry["source"]
  ): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" && value.trim() === "") return;
    entries.push({
      path,
      label,
      value: typeof value === "string" ? value.trim() : value,
      source,
    });
  };
  const yesNo = (value: boolean | undefined): string | undefined =>
    value === undefined ? undefined : value ? "Yes" : "No";

  // ── Identity, from the parsed resume profile ─────────────────────────────
  if (profile !== null) {
    add("firstName", "First name", profile.firstName, "resume");
    add("lastName", "Last name", profile.lastName, "resume");
    add(
      "fullName",
      "Full name",
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
        undefined,
      "resume"
    );
    add("phone", "Phone number", profile.phone, "resume");
    add("linkedinUrl", "LinkedIn profile URL", profile.linkedinUrl, "resume");
    add(
      "websiteUrl",
      "Personal website or portfolio URL",
      profile.websiteUrl,
      "resume"
    );
    add(
      "resumeLocation",
      "Location printed on their resume",
      profile.location,
      "resume"
    );
  }

  // The verified address the account was created with. Read off the profiles
  // row rather than the parse, because the database wins on email; see
  // `parseResume` in `lib/resume-parser.ts` for why that is not a style
  // choice.
  add("email", "Email address", candidate.applicationEmail, "profile");

  // Stated at intake wins; a GitHub URL spotted among the parse's own URL
  // fields is the fallback, host anchored, same rule as the widget path.
  if (candidate.githubUrl !== null && candidate.githubUrl.trim() !== "") {
    add("githubUrl", "Their GitHub URL", candidate.githubUrl, "profile");
  } else if (profile !== null) {
    const inferred = [
      profile.githubUrl,
      profile.websiteUrl,
      profile.linkedinUrl,
    ].find((url) => typeof url === "string" && GITHUB_HOST_RE.test(url));
    add("githubUrl", "Their GitHub URL", inferred ?? undefined, "resume");
  }

  // ── The intake columns, verbatim ─────────────────────────────────────────
  const answers = candidate.applicationAnswers;
  add(
    "currentCountry",
    "Country they currently live in",
    answers.currentCountry,
    "profile"
  );
  add(
    "currentCity",
    "City they currently live in",
    answers.currentCity,
    "profile"
  );
  add(
    "workAuthorizedUs",
    "Legally authorized to work in the United States",
    yesNo(answers.workAuthorizedUs),
    "profile"
  );
  add(
    "requiresSponsorship",
    "Will now or in future require visa sponsorship to work in the United States",
    yesNo(answers.requiresSponsorship),
    "profile"
  );
  add(
    "needsSponsorshipNonUs",
    "Will need visa sponsorship to work anywhere outside the United States",
    yesNo(answers.needsSponsorshipNonUs),
    "profile"
  );
  add(
    "willingToRelocate",
    "Willing to relocate for a role",
    yesNo(answers.willingToRelocate),
    "profile"
  );
  add(
    "citizenshipStatus",
    "Citizenship or immigration status they stated at intake",
    answers.citizenshipStatus,
    "profile"
  );
  add(
    "visaStatus",
    "Their current visa status, in their own words, as stated at intake",
    answers.visaStatus,
    "profile"
  );
  add(
    "graduationDate",
    "Graduation date (ISO)",
    answers.gradDate,
    "profile"
  );
  add(
    "earliestStartDate",
    "Earliest date they can start work (ISO)",
    answers.earliestStart,
    "profile"
  );
  // HARD STOP 9 names salary expectations outright as something no model may
  // compose, which is why this is the candidate's own words and never a
  // number derived from a title, a location or a market rate. When the person
  // stated nothing, no entry exists and the salary question is unanswerable.
  add(
    "salaryExpectation",
    "Salary or compensation they expect, in their own words, as stated at intake",
    answers.salaryExpectation,
    "profile"
  );
  add(
    "restrictiveCovenant",
    "Subject to a restrictive covenant from a previous employer",
    yesNo(answers.subjectToRestrictiveCovenant),
    "profile"
  );
  add("streetAddress", "Their street address", answers.streetAddress, "profile");
  add(
    "postalCode",
    "Their postal or ZIP code",
    answers.postalCode,
    "profile"
  );
  add(
    "highSchoolName",
    "The high school they attended",
    answers.highSchoolName,
    "profile"
  );
  add(
    "highSchoolGradYear",
    "Year they graduated high school",
    answers.highSchoolGradYear === undefined
      ? undefined
      : String(answers.highSchoolGradYear),
    "profile"
  );
  if (
    answers.targetLocations !== undefined &&
    answers.targetLocations.length > 0
  ) {
    add(
      "targetLocations",
      "Places they said they want to work, most preferred first",
      answers.targetLocations.join(", "),
      "profile"
    );
    add(
      "topLocationPreference",
      "Their most preferred work location",
      answers.targetLocations[0],
      "profile"
    );
  }

  // ── The whole resume, not its first row ──────────────────────────────────
  // Every work and education entry, under the same indexed keys the widget
  // path writes, because these are the paths the background check critical
  // exclusion list in `tools.ts` requires a `setFieldValue` call to quote.
  // Dates are the resume's own strings, verbatim, not normalized: what the
  // person wrote is what the equality check in the exclusion wrapper compares
  // against.
  if (profile !== null) {
    profile.workHistory.forEach((entry, index) => {
      const where = index === 0 ? "Most recent" : `Job ${index + 1} (older)`;
      add(`work${index}.employer`, `${where}: employer`, entry.company, "resume");
      add(`work${index}.title`, `${where}: job title`, entry.title, "resume");
      add(
        `work${index}.startDate`,
        `${where}: start date, as the resume states it`,
        entry.startDate,
        "resume"
      );
      add(
        `work${index}.endDate`,
        `${where}: end date, as the resume states it`,
        entry.endDate,
        "resume"
      );
      add(`work${index}.summary`, `${where}: what they did`, entry.summary, "resume");
    });
    profile.education.forEach((entry, index) => {
      const where =
        index === 0 ? "Most recent" : `Education ${index + 1} (older)`;
      add(`education${index}.school`, `${where}: school`, entry.school, "resume");
      add(`education${index}.degree`, `${where}: degree`, entry.degree, "resume");
      add(
        `education${index}.discipline`,
        `${where}: field of study`,
        entry.discipline,
        "resume"
      );
      add(`education${index}.endDate`, `${where}: end date`, entry.endDate, "resume");
    });
    // Kept under their historical keys as well as the indexed ones above,
    // matching the widget path: renaming a fact key is a silent behavior
    // change, and these five are the spellings existing prompts and caches
    // name.
    const school = profile.education[0];
    if (school !== undefined) {
      add("school", "Most recent school", school.school, "resume");
      add("degree", "Most recent degree", school.degree, "resume");
      add("discipline", "Field of study", school.discipline, "resume");
    }
    const job = profile.workHistory[0];
    if (job !== undefined) {
      add("mostRecentEmployer", "Most recent employer", job.company, "resume");
      add("mostRecentTitle", "Most recent job title", job.title, "resume");
    }
    if (profile.skills.length > 0) {
      add(
        "skills",
        "Skills and technologies listed on their resume",
        profile.skills.join(", "),
        "resume"
      );
    }
  }

  // ── The person's own answers from previous runs ──────────────────────────
  // Highest quality facts in the catalog: they came from the person
  // themselves. Keyed by the question they answered, so a differently worded
  // field asking the same thing can still be matched to one. `storedAnswers`
  // is newest first, and `resolveFactPath` returns the first match, so a
  // repeated question resolves to the newest answer.
  for (const stored of candidate.storedAnswers) {
    add(
      `answer:${stored.question}`,
      `The candidate's own answer to "${stored.question}"`,
      stored.answer,
      "candidate_answer"
    );
  }

  return entries;
}

/**
 * The catalog as the one string the model actually reads.
 *
 * This is the exact text `runAgentFill` hands to `runAgentLoop`, which hands
 * it to `buildAnthropicMessagesWithCaching` as the second `system` block with
 * `cache_control: { type: "ephemeral" }` on it. The serialization is a pure
 * map over the ordered entry list, so the same catalog always produces the
 * same bytes, which is the property the prompt cache hit depends on: a
 * serialization that drifted between turns of one run would evict the cached
 * prefix and silently pay full price on every call.
 */
export function serializeFactCatalog(catalog: FactCatalog): string {
  const lines = catalog.entries.map(
    (entry) => `- ${entry.path} [${entry.source}] ${entry.label}: ${String(entry.value)}`
  );
  return [
    `Fact catalog for user ${catalog.userId} (${catalog.entries.length} facts). ` +
      `Every value is the person's own intake data, verbatim. Quote a path ` +
      `exactly as written here when a tool call asks for intakeFactPath.`,
    ...lines,
  ].join("\n");
}

/**
 * The wet default for `BuildFactCatalogDeps.loadIntake`.
 *
 * Every Supabase read is guarded: `loadCandidate` runs its own
 * `assertSupabaseProject()` before creating its client, and the client built
 * here for the `resumes` reads calls the same guard first. The service role
 * key bypasses row level security, so the guard is the only thing standing
 * between a stale `SUPABASE_URL` and reads against the wrong project.
 *
 * The resume profile is resolved the cheap way first: `resumes.parsed` when
 * the stored parse still matches the documents the row points at, and only on
 * a miss the full download and model parse through
 * `resolveCandidateProfile`, which also stores the result so the next run
 * reads it.
 */
async function defaultLoadIntake(userId: string): Promise<IntakeSnapshot> {
  const { loadCandidate } = await import("@/lib/candidate-intake");
  const candidate = await loadCandidate(userId);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required " +
        "(see .env.example)"
    );
  }
  assertSupabaseProject(url);
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const paths = {
    resumeId: candidate.resumeId,
    resumePath: candidate.resumeUrl,
    linkedinPdfPath: candidate.linkedinPdfPath,
  };
  const parserRecord = {
    id: candidate.userId,
    applicationEmail: candidate.applicationEmail,
    linkedinUrl: candidate.linkedinUrl,
    githubUrl: candidate.githubUrl,
  };

  const { readStoredParse, resolveCandidateProfile } = await import(
    "@/lib/candidate-documents"
  );
  const stored = await readStoredParse(supabase, paths);
  if (stored !== null) {
    const { buildResumeProfile } = await import("@/lib/resume-parser");
    return {
      candidate,
      profile: buildResumeProfile(
        stored.resume.extracted,
        parserRecord,
        stored.linkedin?.extracted ?? null
      ),
    };
  }

  const { loadResume } = await import("@/lib/resume-parser");
  const loaded = await loadResume(supabase, candidate.resumeUrl);
  const profile = await resolveCandidateProfile(
    supabase,
    paths,
    loaded.text,
    parserRecord
  );
  return { candidate, profile };
}

/**
 * JOB-316: the real thing. Reads the person's profile, resume parse and
 * stored answers, and returns the catalog the agent loop is allowed to quote
 * from. The `userId` on the returned catalog is the one `loadCandidate`
 * verified, not the caller's raw string.
 */
export async function buildFactCatalog(
  userId: string,
  deps: BuildFactCatalogDeps = {}
): Promise<FactCatalog> {
  const loadIntake = deps.loadIntake ?? defaultLoadIntake;
  const { candidate, profile } = await loadIntake(userId);
  return {
    userId: candidate.userId,
    entries: factEntriesFrom(candidate, profile),
  };
}

/**
 * Resolves a dotted `path` against a `FactCatalog` and returns the entry when
 * one exists. Kept as a small helper here rather than inlined into `tools.ts`
 * so the exclusion list wrapper can be tested in isolation with a mock
 * resolver. A plain linear scan; the catalog tops out at a few hundred
 * entries, so an index would buy nothing.
 */
export function resolveFactPath(
  catalog: FactCatalog,
  path: string
): FactEntry | undefined {
  return catalog.entries.find((entry) => entry.path === path);
}
