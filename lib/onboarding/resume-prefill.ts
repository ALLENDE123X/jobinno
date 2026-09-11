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
 * Round one red team found real false positives in the phrase match: a
 * bare `indexOf` let "US Citizenship" match "US Citizen", and the negation
 * scan only looked backward, so a trailing disqualifier such as "needed"
 * or "sponsorship" slipped through. The matcher is now word boundary only
 * (a regex, never a substring test) and rejects a match with either a
 * negation word just before it or a disqualifying word anywhere in the same
 * sentence; see `hasUnnegatedPhrase` for the exact rule and
 * `tests/unit/onboarding/resume-prefill.test.ts` for the full set of
 * exploits it now rejects.
 *
 * Round two's own fix then regressed the opposite direction: it added
 * "US citizen" as a phrase but never "US citizenship" itself, so a resume
 * that plainly says "I hold US citizenship" matched nothing at all, and its
 * disqualifier list included generic English words ("apply", "help",
 * "assist", "future", "services", "cases") that fired on ordinary resume
 * prose that never mentioned a visa or an employer at all. Round three adds
 * the missing phrasings and prunes the disqualifier list to words specific
 * to a visa or immigration context, or to a company or organisation suffix;
 * see the comment above `DISQUALIFIER_WORDS` for the two immigration
 * specific words added in their place.
 *
 * current_city and grad_date go through the model, because
 * `buildResumeProfile` already extracts, sanitises and ships them to the
 * fill pipeline today; this reuses that reviewed path. A resume's home
 * address is not a stated job search preference, so nothing here ever
 * derives `target_locations` from it; that field is left for the person to
 * fill in on step 3 the same as anyone without a pre filled resume.
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
  "u.s. citizenship",
  "us citizenship",
  "united states citizenship",
  "u.s. national",
  "us national",
];

const PERMANENT_RESIDENT_PHRASES = [
  "permanent resident",
  "green card holder",
  "u.s. green card",
  "green card",
];

/** How far back from a match to look for a negating word. */
const NEGATION_WINDOW = 20;

const NEGATION_WORDS = ["not", "no", "non", "without"];

/**
 * Words that, appearing anywhere in the same sentence as an otherwise
 * matching phrase, mean the sentence is not a first person status claim at
 * all: someone else's company or program name ("US Citizen Corp", "US
 * Citizen Advocacy Network"), a visa or immigration process performed for
 * other people ("citizen naturalization cases for clients", "Citizenship &
 * Immigration Services"), or a future or conditional need rather than a
 * current status ("green card sponsorship needed", "will require
 * sponsorship ... green card ... in the future").
 *
 * Round two red team's regression: this list used to include generic
 * English words that recur in ordinary resume prose unrelated to visa
 * status ("apply", "help", "assist", "future", "services", "cases"), which
 * fired on sentences that never mentioned sponsorship or immigration at
 * all. Round three prunes it to words that are specific to a visa or
 * immigration context, or to a company or organisation suffix, and adds two
 * immigration specific terms ("immigration", "naturalization") in their
 * place so the phrases newly added to `US_CITIZEN_PHRASES` this round
 * ("US citizenship", "US national") still reject a mention of the US
 * Citizenship and Immigration Services agency rather than reading it as a
 * personal claim. The check also moved from a fixed character window
 * forward of the match to the whole sentence containing it (see
 * `isSentenceDisqualified`), since "will require sponsorship ... in the
 * future" only kept "sponsorship" ahead of the match once "future" was
 * dropped, and a fixed forward window would have missed it. See the exploit
 * list in the test file before trimming this list further.
 */
const DISQUALIFIER_WORDS = [
  "sponsorship",
  "sponsor",
  "required",
  "requires",
  "needed",
  "pending",
  "corp",
  "inc",
  "llc",
  "network",
  "advocacy",
  "immigration",
  "naturalization",
];

const NEGATION_PATTERN = new RegExp(`\\b(?:${NEGATION_WORDS.join("|")})\\b[^.]*$`, "i");
const DISQUALIFIER_PATTERN = new RegExp(`\\b(?:${DISQUALIFIER_WORDS.join("|")})\\b`, "i");

/**
 * A period at `index` counts as ending an abbreviation, not a sentence,
 * when exactly one letter or digit sits immediately before it ("e.g.",
 * "i.e.", "u.s.", "a.m."). Two or more (a real word, or a suffix like
 * "corp." or "inc.") or zero (the period stands alone) both count as a real
 * sentence end. This only has to be good enough to stop an abbreviation's
 * internal punctuation from truncating the sentence a disqualifier search
 * runs over; it is not a general purpose sentence splitter.
 */
function isAbbreviationPeriod(haystack: string, index: number): boolean {
  let i = index - 1;
  let letters = 0;
  while (i >= 0 && /[a-z0-9]/i.test(haystack[i])) {
    letters++;
    i--;
  }
  return letters === 1;
}

/**
 * True if the sentence containing the match at `[start, end)` in `haystack`
 * carries a disqualifying word anywhere in it, before or after the match.
 * A sentence boundary is the nearest real (non abbreviation) period on each
 * side, or the start or end of the string when there is none. Scoped to
 * the sentence rather than a fixed size window so a disqualifier is caught
 * regardless of which side of the match it falls on.
 */
function isSentenceDisqualified(haystack: string, start: number, end: number): boolean {
  let sentenceStart = 0;
  for (let searchEnd = start; ; ) {
    const periodIndex = haystack.lastIndexOf(".", searchEnd - 1);
    if (periodIndex === -1) break;
    if (!isAbbreviationPeriod(haystack, periodIndex)) {
      sentenceStart = periodIndex + 1;
      break;
    }
    searchEnd = periodIndex;
  }

  let sentenceEnd = haystack.length;
  for (let searchStart = end; ; ) {
    const periodIndex = haystack.indexOf(".", searchStart);
    if (periodIndex === -1) break;
    if (!isAbbreviationPeriod(haystack, periodIndex)) {
      sentenceEnd = periodIndex;
      break;
    }
    searchStart = periodIndex + 1;
  }

  return DISQUALIFIER_PATTERN.test(haystack.slice(sentenceStart, sentenceEnd));
}

/** Escapes a plain phrase (spaces and periods only, no other regex metacharacters) for use inside a `RegExp`. */
function escapePhraseForRegExp(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `phrase` appears in `haystack` as a whole phrase, matched on word
 * boundaries rather than as a bare substring, so "US Citizenship" can never
 * match "US Citizen" alone (though "US citizenship" is now its own listed
 * phrase; see `US_CITIZEN_PHRASES`). A match is rejected if a negation word
 * ("not", "no", "non", "without") sits in the `NEGATION_WINDOW` characters
 * before it, never crossing a sentence boundary, or if a disqualifying word
 * sits anywhere in the same sentence (see `isSentenceDisqualified`). A
 * resume that says "not a US citizen" must never be read as one, and
 * neither must one that names a company, describes work done for other
 * people, or states a future or conditional need rather than a current
 * status.
 */
function hasUnnegatedPhrase(haystack: string, phrase: string): boolean {
  const pattern = new RegExp(`\\b${escapePhraseForRegExp(phrase)}\\b`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(haystack)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const before = haystack.slice(Math.max(0, start - NEGATION_WINDOW), start);
    if (!NEGATION_PATTERN.test(before) && !isSentenceDisqualified(haystack, start, end)) {
      return true;
    }
  }
  return false;
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
  gradDate: string | null;
};

/** Validates a `ResumePrefillDefaults` shape, client sent or DB read. */
export const ResumePrefillDefaultsSchema = z.object({
  citizenshipStatus: z.enum(["us_citizen", "permanent_resident"]).nullable(),
  workAuthorizedUs: z.boolean().nullable(),
  currentCity: z.string().max(120).nullable(),
  gradDate: z.iso.date().nullable(),
});

/**
 * Pure. `resumeText` powers the citizenship scan; `profile` is the already
 * sanitised `ResumeProfile` from `buildResumeProfile`, which is where
 * `location` and `education` come from. There is deliberately no
 * `targetLocations` output: a resume's home address is a place someone
 * lives, not a stated job search preference, and reusing it as one would be
 * a fabricated attestation the same way a guessed citizenship status would.
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
  const gradDate = parseGradDateToIso(profile.education[0]?.endDate ?? null);

  return { citizenshipStatus, workAuthorizedUs, currentCity, gradDate };
}

// ───────────────────────────────────
// The synchronous parse step 1 awaits
// ───────────────────────────────────

export type ResumePrefillParseResult =
  | { ok: true; extracted: ExtractedResume; defaults: ResumePrefillDefaults }
  | { ok: false; reason: string };

/**
 * Matches `PREFILL_PARSE_TIMEOUT_MS` in `app/onboarding/step/step-1.tsx`.
 * Next.js server actions have no way to accept an `AbortSignal` from the
 * client, so this is a same duration timer owned entirely by this module
 * rather than the client's own timer reaching across the request boundary.
 * Round one red team's MAJOR 2: without this, a client that gave up at 30
 * seconds left the server still awaiting the model for the full
 * `LLM_TIMEOUT_MS` in `lib/resume-parser.ts`, burning a full call nobody
 * was waiting on any more. `lib/resume-parser.ts` stays untouched per this
 * ticket's scope, so the parse work below is raced against this timer
 * rather than the timeout being threaded into `extractResume` itself. This
 * bounds how long the caller waits, which fixes the hang, but it does not
 * cancel the in flight model call itself; that half of MAJOR 2 (the burned
 * credit on an abandoned parse) is tracked as JOB-364, see the comment on
 * the `Promise.race` call below.
 */
const SERVER_PARSE_TIMEOUT_MS = 30_000;

class PrefillParseTimeoutError extends Error {}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new PrefillParseTimeoutError(`timed out after ${ms / 1000} seconds`)),
      ms,
    );
  });
}

/**
 * Downloads the just uploaded resume with the caller's own user scoped
 * client (storage RLS already restricts a person to their own folder, so
 * no service role is needed here), runs the same extraction
 * `lib/resume-parser.ts` always has, and derives the onboarding defaults.
 * A download failure, an extraction failure, an `assertNoInjectionMarkers`
 * trip inside `buildResumeProfile`, or the `SERVER_PARSE_TIMEOUT_MS` budget
 * running out all land here as `{ ok: false }` rather than throwing, so
 * the caller can fall through the same way it does on a client side
 * timeout.
 */
export async function runResumeParseForPrefill(
  supabase: SupabaseClient,
  params: { userId: string; userEmail: string; resumeObjectPath: string },
): Promise<ResumePrefillParseResult> {
  const work = (async () => {
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
    return { extracted, defaults };
  })();
  // A rejection that arrives after the timeout has already won the race
  // below must not surface as an unhandled rejection.
  work.catch(() => {});

  try {
    // JOB-364: this race bounds the caller wait but does NOT cancel the
    // underlying LLM fetch. The in flight model call still runs to
    // completion server side after this returns via timeout, burning a
    // full call nobody is waiting on any more. Full cancellation needs an
    // AbortSignal threaded through `extractResume` and `callTextOnlyModel`
    // in `lib/resume-parser.ts`, out of scope for this ticket; see the
    // follow up issue.
    const { extracted, defaults } = await Promise.race([
      work,
      rejectAfter(SERVER_PARSE_TIMEOUT_MS),
    ]);
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
