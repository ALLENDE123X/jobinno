/**
 * JOB-112 — `resumes.parsed`, finally written and finally read.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `resumes.parsed` existed in the schema and in the database and nothing had
 * ever written a byte to it. `resumes.linkedin_pdf_path` was written at intake
 * and nothing had ever read it. So the resume was downloaded and re-parsed by
 * an LLM on every single application, and the candidate's LinkedIn export had
 * never been used at all.
 *
 * That is not only a cost. A parse redone per run is a parse that can come back
 * differently per run, which makes the candidate's own facts non-deterministic
 * between applications: the same form answered a sponsorship question on four
 * runs out of seven and stopped on the other three. A stored parse turns that
 * from a coin flip into one data problem that can be looked at.
 *
 * ── Why this is a separate module from `resume-parser.ts` ───────────────────
 * Because that module can only read, and it is worth keeping it that way. Its
 * header's claim is a claim about its import list: no browser, no Stagehand, no
 * `act()`, no writes. It downloads two objects, calls one completions endpoint
 * with no tools attached, and returns validated strings. This module is the one
 * that writes a row, and it holds no untrusted text of its own beyond passing
 * it straight from the loader to the parser. Nothing here can act either, but
 * "the module holding the injection surface performs no writes at all" is a
 * simpler sentence to check than "it performs one write and here is why that
 * one is fine".
 *
 * ── Async parse, read with a fallback ───────────────────────────────────────
 * Onboarding is a person waiting on a form submit, and two PDFs through an LLM
 * is far too slow to hold that open. So `inngest/parse-candidate-documents.ts`
 * does it after the fact, and the fill pipeline reads what it stored. When
 * nothing is stored the pipeline parses inline exactly as it always did and
 * stores the result on the way past, which is what makes every row written
 * before this ticket self-heal on its first use rather than needing a backfill.
 *
 * ── Invalidation ────────────────────────────────────────────────────────────
 * A stale parse is worse than no parse: it is confidently wrong rather than
 * obviously missing. Two things keep it fresh, and the second is the one that
 * actually holds.
 *
 *  · A new upload inserts a new `resumes` row rather than updating the old one
 *    (`app/onboarding/actions.ts` and `lib/candidate-intake.ts` both insert),
 *    and `parsed` starts NULL on it. `loadActiveResume` applies the newest
 *    active row, so a re-upload is already reading an unparsed row.
 *  · `readStoredParse` refuses a parse whose recorded source paths are not the
 *    row's current ones. That is the belt to the above's braces: it does not
 *    depend on nobody ever updating a path in place, and it makes "which
 *    document produced this?" answerable from the stored object itself.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  ExtractedLinkedinSchema,
  ExtractedResumeSchema,
  buildResumeProfile,
  extractLinkedinProfile,
  extractResume,
  loadLinkedinExport,
  type CandidateRecord,
  type ResumeProfile,
} from "@/lib/resume-parser";

const LOG = "[job-112]";

/**
 * Bumped when the shape below changes incompatibly.
 *
 * A stored object at an unrecognised version is discarded and re-derived rather
 * than migrated, because re-deriving is one model call and a wrong migration is
 * wrong facts on somebody's job application.
 */
const PARSED_VERSION = 1;

/**
 * What lands in `resumes.parsed`.
 *
 * ── Why the two documents stay separate in here ─────────────────────────────
 * They could have been merged once, at write time, and stored as one profile.
 * They are not, because merging is a *decision* — see `buildResumeProfile`'s
 * precedence rules — and a decision is worth re-running against the code that
 * currently makes it rather than freezing whichever version of it happened to
 * run at onboarding. Keeping the inputs also means a wrong value on a form can
 * be traced back to the document that produced it, which a merged blob cannot
 * support.
 *
 * ── And why what is stored is the model's answer, not the profile ───────────
 * Everything the *database* contributes to a `ResumeProfile` — the verified
 * email, the stated GitHub URL, the sanitisation, the injection tripwire — is
 * re-applied on every read. So this is a cache of two model calls and never a
 * cache of a person's current profile, and someone who corrects their GitHub
 * URL after onboarding does not have to re-upload a resume for the correction
 * to reach a form.
 */
const StoredParseSchema = z.object({
  version: z.literal(PARSED_VERSION),
  /** When the model calls ran. Reported in the run log so a stale one is visible. */
  parsedAt: z.string(),
  resume: z.object({
    /** `resumes.storage_path` as it was when this was derived. */
    storagePath: z.string(),
    extracted: ExtractedResumeSchema,
  }),
  /** Null when the candidate uploaded no LinkedIn export. */
  linkedin: z
    .object({
      /** `resumes.linkedin_pdf_path` as it was when this was derived. */
      storagePath: z.string(),
      extracted: ExtractedLinkedinSchema,
    })
    .nullable(),
});

export type StoredParse = z.infer<typeof StoredParseSchema>;

/** The paths a stored parse has to still match to be usable. */
export type DocumentPaths = {
  resumeId: string;
  resumePath: string;
  linkedinPdfPath: string | null;
};

/**
 * Runs both extractions and returns what should be stored.
 *
 * `resumeText` is passed in rather than loaded here because the fill pipeline
 * already has it: it downloads the resume for the bytes it uploads to the
 * employer regardless of whether a parse is stored, so re-downloading it would
 * be a second read of the same object in the same run.
 *
 * A LinkedIn export that cannot be read does not fail the derivation. The
 * resume is the document an application actually requires, and refusing to
 * store a perfectly good resume parse because a supplementary PDF was a scan
 * would turn a better-answers feature into an outage. The failure is logged and
 * the LinkedIn half comes out null.
 */
export async function deriveStoredParse(
  supabase: SupabaseClient,
  paths: DocumentPaths,
  resumeText: string
): Promise<StoredParse> {
  const extractedResume = await extractResume(resumeText);

  let linkedin: StoredParse["linkedin"] = null;
  const linkedinPath = (paths.linkedinPdfPath ?? "").trim();
  if (linkedinPath !== "") {
    try {
      const loaded = await loadLinkedinExport(supabase, linkedinPath);
      console.log(
        `${LOG} LinkedIn export: ${loaded.pageCount} page(s), ${loaded.text.length} characters`
      );
      linkedin = {
        storagePath: linkedinPath,
        extracted: await extractLinkedinProfile(loaded.text),
      };
    } catch (err) {
      console.warn(
        `${LOG} could not parse the LinkedIn export at ${JSON.stringify(linkedinPath)}: ` +
          `${err instanceof Error ? err.message : String(err)}. Continuing with the resume ` +
          `alone — the application only ever needed that one.`
      );
    }
  }

  return {
    version: PARSED_VERSION,
    parsedAt: new Date().toISOString(),
    resume: { storagePath: paths.resumePath, extracted: extractedResume },
    linkedin,
  };
}

/**
 * Reads `resumes.parsed`, or null when there is nothing usable there.
 *
 * Null covers four cases and deliberately does not distinguish them to the
 * caller, because the answer to all four is the same: parse it now. The column
 * is NULL; it holds something written by an older version of this file; it does
 * not match the schema; or it names documents this row no longer points at.
 */
export async function readStoredParse(
  supabase: SupabaseClient,
  paths: DocumentPaths
): Promise<StoredParse | null> {
  const { data, error } = await supabase
    .from("resumes")
    .select("parsed")
    .eq("id", paths.resumeId)
    .limit(1);
  if (error) {
    // Not fatal. A read failure here costs one extra model call, and failing the
    // whole application over a cache miss would be a worse trade than paying it.
    console.warn(`${LOG} could not read resumes.parsed: ${error.message}. Parsing instead.`);
    return null;
  }

  const raw = data?.[0]?.parsed;
  if (raw === null || raw === undefined) return null;

  const result = StoredParseSchema.safeParse(raw);
  if (!result.success) {
    console.warn(
      `${LOG} resumes.parsed on ${paths.resumeId} is not a shape this version understands ` +
        `— re-deriving it.`
    );
    return null;
  }

  const stored = result.data;
  const linkedinPath = (paths.linkedinPdfPath ?? "").trim();
  const storedLinkedinPath = stored.linkedin?.storagePath ?? "";
  if (stored.resume.storagePath !== paths.resumePath || storedLinkedinPath !== linkedinPath) {
    console.warn(
      `${LOG} resumes.parsed on ${paths.resumeId} was derived from different documents than ` +
        `the row now points at — discarding it and re-parsing. A stale parse is worse than ` +
        `none, because it is confidently wrong rather than obviously missing.`
    );
    return null;
  }

  return stored;
}

/**
 * Writes the parse back.
 *
 * Service role only, and that is enforced by the database rather than by this
 * comment: `drizzle/0016_resumes_column_privileges.sql` takes the table-wide
 * INSERT and UPDATE grants on `resumes` away from `authenticated` and grants
 * back only the three columns a person supplies about themselves. `parsed`
 * holds their employment and education history, and there is exactly one writer
 * for it.
 *
 * A write failure is logged and swallowed. The profile has already been derived
 * by the time this runs, so failing here would throw away a good parse and a
 * good application over a cache write.
 */
export async function writeStoredParse(
  supabase: SupabaseClient,
  resumeId: string,
  parse: StoredParse
): Promise<void> {
  const { error } = await supabase.from("resumes").update({ parsed: parse }).eq("id", resumeId);
  if (error) {
    console.warn(`${LOG} could not write resumes.parsed on ${resumeId}: ${error.message}`);
    return;
  }
  console.log(
    `${LOG} stored the parse on resumes ${resumeId} ` +
      `(resume${parse.linkedin === null ? "" : " + LinkedIn export"})`
  );
}

/**
 * The fill pipeline's entry point: the candidate's profile, from storage when
 * it is there and from the documents when it is not.
 *
 * The log line is part of the contract rather than decoration. "This run did not
 * re-parse" is the whole observable difference this ticket makes, and it has to
 * be visible in a run log next to the `[act-007] parsing N characters` line it
 * replaces.
 */
export async function resolveCandidateProfile(
  supabase: SupabaseClient,
  paths: DocumentPaths,
  resumeText: string,
  candidate: CandidateRecord
): Promise<ResumeProfile> {
  const stored = await readStoredParse(supabase, paths);
  if (stored !== null) {
    console.log(
      `${LOG} read the stored parse from resumes.parsed on ${paths.resumeId} ` +
        `(derived ${stored.parsedAt} from the resume` +
        `${stored.linkedin === null ? "" : " and the LinkedIn export"}) — not re-parsing`
    );
    return toProfile(stored, candidate);
  }

  console.log(
    `${LOG} nothing usable in resumes.parsed on ${paths.resumeId} — parsing now and storing ` +
      `the result, so the next run reads it instead`
  );
  const derived = await deriveStoredParse(supabase, paths, resumeText);
  await writeStoredParse(supabase, paths.resumeId, derived);
  return toProfile(derived, candidate);
}

/**
 * Stored extraction plus the database's own facts, through the same merge the
 * inline path uses — the same function, not a second copy of the precedence
 * rules. A stored parse and a fresh one produce identical profiles, which is
 * the property that makes the fallback safe to rely on.
 */
function toProfile(stored: StoredParse, candidate: CandidateRecord): ResumeProfile {
  return buildResumeProfile(
    stored.resume.extracted,
    candidate,
    stored.linkedin?.extracted ?? null
  );
}
