/**
 * JOB-360: pre filling onboarding steps 2 through 4 from the resume the
 * user just uploaded on step 1.
 *
 * Runs a second, narrower parse right after step 1's upload: resume only,
 * no LinkedIn, awaited with a hard time limit. `lib/candidate-document-trigger.ts`
 * still fires the fuller resume plus LinkedIn parse at the end of
 * onboarding unchanged; that one overwrites what this one stores, which is
 * fine, since both write the same shape.
 *
 * Citizenship and work authorization never touch the model. HARD STOP 9
 * and this ticket both require pre fill only when the resume directly
 * names the field, never inferred. `detectCitizenshipFromResumeText` is a
 * deterministic phrase match against the resume's raw text, limited to the
 * two phrasings that are essentially never ambiguous on a resume ("US
 * citizen", "green card"), skipped when a negation sits nearby ("not a US
 * citizen"). F1 and H1B are left out: those phrasings read as a rejection
 * notice as often as a status claim ("H1B sponsorship required"), so
 * guessing at them risks a false attestation. workAuthorizedUs is derived
 * from that same detected citizenship, mirroring `deriveWorkAuthorizedUs`
 * in `lib/onboarding/intake-derivation.ts`: only ever set to `true`, never
 * to `false`, since silence on a resume is not a claim of no authorization.
 *
 * current_city, target_locations and grad_date do go through the model,
 * because `buildResumeProfile` already extracts, sanitises and ships them
 * to the fill pipeline today; this reuses that reviewed path. That schema
 * has no per job location field and no separate "stated preference", and
 * adding either is a `lib/resume-parser.ts` change out of scope per HARD
 * STOP 6, so `targetLocations` defaults to the same single location
 * `currentCity` does. Called out again as a scope decision in the PR body.
 *
 * Persistence reuses `resumes.parsed`, already service role only to write
 * (`drizzle/0016_resumes_column_privileges.sql`; see
 * `lib/candidate-documents.ts` for the full contract). What lands there is
 * shaped like the `StoredParse` that module already produces, plus one
 * extra sibling key, `onboardingDefaults`, that only this module reads.
 * `StoredParse`'s zod schema parses in zod's default "strip" mode rather
 * than `.strict()`, so the extra key is silently dropped by every existing
 * reader rather than rejected. `linkedin` is always written null here,
 * since this module never parses the LinkedIn export.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  buildResumeProfile,
  extractResume,
  loadResume,
  type CandidateRecord,
  type ExtractedResume,
  type ResumeProfile,
} from "@/lib/resume-parser";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";

const LOG = "[job-360]";

/** Bumped if the shape of `onboardingDefaults` changes incompatibly. */
const PREFILL_VERSION = 1;

// ───────────────────────────────────
// Citizenship, from the resume's own words only
// ───────────────────────────────────

const US_CITIZEN_PHRASES = [
  "u.s. citizen",
  "us citizen",
  "united states citizen",
  "american citizen",
  "citizen of the united states",
];

const PERMANENT_RESIDENT_PHRASES = [
  "permanent resident",
  "green card holder",
  "u.s. green card",
  "green card",
];

/** How far back from a match to look for a negating word. */
const NEGATION_WINDOW = 20;

/**
 * True if `phrase` appears in `haystack` with no negation word ("not", "no",
 * "non", "without") in the `NEGATION_WINDOW` characters before it. A resume
 * that says "not a US citizen" must never be read as one.
 */
function hasUnnegatedPhrase(haystack: string, phrase: string): boolean {
  let searchFrom = 0;
  for (;;) {
    const index = haystack.indexOf(phrase, searchFrom);
    if (index === -1) return false;
    const windowStart = Math.max(0, index - NEGATION_WINDOW);
    const before = haystack.slice(windowStart, index);
    if (!/\b(not|no|non|without)\b[^.]*$/i.test(before)) return true;
    searchFrom = index + phrase.length;
  }
}

/**
 * Deterministic, not an LLM call. Returns null far more often than it
 * returns a value on purpose: most resumes never state citizenship at all,
 * and this is the "leave it blank rather than guess" side of HARD STOP 9.
 */
export function detectCitizenshipFromResumeText(
  resumeText: string,
): "us_citizen" | "permanent_resident" | null {
  const normalized = ` ${resumeText.toLowerCase().replace(/\s+/g, " ")} `;
  if (PERMANENT_RESIDENT_PHRASES.some((phrase) => hasUnnegatedPhrase(normalized, phrase))) {
    return "permanent_resident";
  }
  if (US_CITIZEN_PHRASES.some((phrase) => hasUnnegatedPhrase(normalized, phrase))) {
    return "us_citizen";
  }
  return null;
}

// ───────────────────────────────────
// Graduation date, normalised to the <input type="date"> shape
// ───────────────────────────────────

const MONTH_NUMBERS: Record<string, string> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

/**
 * Education `endDate` as the model returns it ("May 2024", "Expected Dec.
 * 2025", "05/2024") into `YYYY-MM-DD`, or null when it does not
 * unambiguously resolve. A bare year or a season ("Spring 2025") stays
 * null rather than guessed at; the day is assumed to be the first of the
 * month when a month is known, a correctable placeholder rather than a
 * claimed fact.
 */
export function parseGradDateToIso(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const monthYear = trimmed
    .replace(/^expected\s+/i, "")
    .match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (monthYear) {
    const month = MONTH_NUMBERS[monthYear[1].toLowerCase()];
    if (month) return `${monthYear[2]}-${month}-01`;
  }

  const numeric = trimmed.match(/^(\d{1,2})\/(\d{4})$/);
  if (numeric) {
    const month = Number(numeric[1]);
    if (month >= 1 && month <= 12) {
      return `${numeric[2]}-${String(month).padStart(2, "0")}-01`;
    }
  }

  return null;
}

// ───────────────────────────────────
// The defaults themselves
// ───────────────────────────────────

export type ResumePrefillDefaults = {
  citizenshipStatus: "us_citizen" | "permanent_resident" | null;
  workAuthorizedUs: boolean | null;
  currentCity: string | null;
  targetLocations: string[] | null;
  gradDate: string | null;
};

/** Validates a `ResumePrefillDefaults` shape, client sent or DB read. */
export const ResumePrefillDefaultsSchema = z.object({
  citizenshipStatus: z.enum(["us_citizen", "permanent_resident"]).nullable(),
  workAuthorizedUs: z.boolean().nullable(),
  currentCity: z.string().max(120).nullable(),
  targetLocations: z.array(z.string().max(120)).max(20).nullable(),
  gradDate: z.iso.date().nullable(),
});

/**
 * Pure. `resumeText` powers the citizenship scan; `profile` is the already
 * sanitised `ResumeProfile` from `buildResumeProfile`, which is where
 * `location` and `education` come from. See the file header for why
 * `targetLocations` reuses `location` rather than a per job field that does
 * not exist in `lib/resume-parser.ts`'s extraction schema.
 */
export function deriveResumePrefillDefaults(
  resumeText: string,
  profile: ResumeProfile,
): ResumePrefillDefaults {
  const citizenshipStatus = detectCitizenshipFromResumeText(resumeText);
  const workAuthorizedUs =
    citizenshipStatus === "us_citizen" || citizenshipStatus === "permanent_resident"
      ? true
      : null;
  const currentCity = profile.location;
  const targetLocations = profile.location ? [profile.location] : null;
  const gradDate = parseGradDateToIso(profile.education[0]?.endDate ?? null);

  return { citizenshipStatus, workAuthorizedUs, currentCity, targetLocations, gradDate };
}

// ───────────────────────────────────
// The synchronous parse step 1 awaits
// ───────────────────────────────────

export type ResumePrefillParseResult =
  | { ok: true; extracted: ExtractedResume; defaults: ResumePrefillDefaults }
  | { ok: false; reason: string };

/**
 * Downloads the just uploaded resume with the caller's own user scoped
 * client (storage RLS already restricts a person to their own folder, so
 * no service role is needed here), runs the same extraction
 * `lib/resume-parser.ts` always has, and derives the onboarding defaults.
 * A download failure, an extraction failure, or an `assertNoInjectionMarkers`
 * trip inside `buildResumeProfile` all land here as `{ ok: false }` rather
 * than throwing, so the caller can fall through the same way it does on a
 * client side timeout.
 */
export async function runResumeParseForPrefill(
  supabase: SupabaseClient,
  params: { userId: string; userEmail: string; resumeObjectPath: string },
): Promise<ResumePrefillParseResult> {
  try {
    const loaded = await loadResume(supabase, params.resumeObjectPath);
    const extracted = await extractResume(loaded.text);
    const candidate: CandidateRecord = {
      id: params.userId,
      applicationEmail: params.userEmail,
      linkedinUrl: null,
      githubUrl: null,
    };
    const profile = buildResumeProfile(extracted, candidate, null);
    const defaults = deriveResumePrefillDefaults(loaded.text, profile);
    return { ok: true, extracted, defaults };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`${LOG} could not parse the resume for onboarding prefill: ${reason}`);
    return { ok: false, reason };
  }
}

// ───────────────────────────────────
// Persisting and reading it back
// ───────────────────────────────────

/** Service role client, matching `inngest/parse-candidate-documents.ts`. */
function getServiceRoleClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required (see .env.example)",
    );
  }
  assertSupabaseProject(url);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Writes the parse and the derived defaults onto the resumes row just
 * inserted for it. Best effort and never throws: the row is already saved
 * by the time this runs, so losing the cache costs one slower step 2
 * render, not a failed onboarding step.
 */
export async function persistResumePrefillParse(
  resumeId: string,
  bucketQualifiedResumePath: string,
  extracted: ExtractedResume,
  defaults: ResumePrefillDefaults,
): Promise<void> {
  try {
    const supabase = getServiceRoleClient();
    const parsed = {
      version: 1,
      parsedAt: new Date().toISOString(),
      resume: { storagePath: bucketQualifiedResumePath, extracted },
      linkedin: null,
      onboardingDefaults: { version: PREFILL_VERSION, ...defaults },
    };
    const { error } = await supabase.from("resumes").update({ parsed }).eq("id", resumeId);
    if (error) {
      console.warn(
        `${LOG} could not persist the onboarding prefill parse on ${resumeId}: ${error.message}`,
      );
      return;
    }
    console.log(`${LOG} persisted the onboarding prefill parse on resumes ${resumeId}`);
  } catch (error) {
    console.warn(
      `${LOG} could not persist the onboarding prefill parse on ${resumeId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Reads `resumes.parsed.onboardingDefaults` back for the step 2 and step 3
 * loaders, on the caller's user scoped client (`resumes_select_own` already
 * grants the read). Null covers every reason nothing usable is there: an
 * empty column, a parse from before this ticket, a version mismatch, or a
 * shape that fails validation. All mean the same thing to a caller: no
 * pre fill this time, which is fine, since this whole feature is a
 * convenience.
 */
export async function readResumePrefillDefaults(
  supabase: SupabaseClient,
  resumeId: string,
): Promise<ResumePrefillDefaults | null> {
  const { data, error } = await supabase
    .from("resumes")
    .select("parsed")
    .eq("id", resumeId)
    .limit(1)
    .maybeSingle();
  if (error || !data?.parsed || typeof data.parsed !== "object") return null;

  const raw = (data.parsed as { onboardingDefaults?: unknown }).onboardingDefaults;
  if (!raw || typeof raw !== "object") return null;

  const versionCheck = z.object({ version: z.literal(PREFILL_VERSION) }).safeParse(raw);
  if (!versionCheck.success) return null;

  const result = ResumePrefillDefaultsSchema.safeParse(raw);
  return result.success ? result.data : null;
}
