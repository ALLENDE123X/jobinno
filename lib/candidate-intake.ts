/**
 * ACT-003 — candidate intake: resume upload plus the rows that make a person
 * applyable. Repointed at Jobinno's real schema by JOB-004.
 *
 * ── What JOB-004 changed, and why the shape moved with the names ────────────
 * actinno kept one `candidates` row per person, minted here with a fresh UUID
 * and holding the resume path, the email, the search preferences and the
 * reusable form answers all together. Jobinno has no such table and cannot
 * have one: a person is an `auth.users` row, `profiles` is keyed by that same
 * id, and a resume is a separate `resumes` row pointing back at it. So this is
 * not a rename of `candidates` to `profiles`; it is one row becoming two, and
 * the id stopping being ours to mint.
 *
 * The consequence worth stating plainly: nothing here creates a person any
 * more. `app/auth/callback/route.ts` creates the `profiles` row at signup, and
 * every function below attaches to a profile that already exists. Passing an
 * id that is not a real signed up user is an error rather than an insert.
 *
 * Two columns actinno had did not survive the move, and neither is papered
 * over here. See `CandidateRecord` for `targetTitle` and `payMin`, and
 * `linkedinUrl` for the third.
 *
 * Targets the Supabase project named by `EXPECTED_SUPABASE_PROJECT_REF`, see
 * `.env.example`. JOB-002 moved that from a literal in this file into the
 * environment, and `assertSupabaseProject()` in `lib/supabase-project-guard.ts`
 * still makes pointing this code at any other project a hard failure rather
 * than a silent write. That matters because more than one live product shares
 * the Supabase account. The README's "meminno project" line is stale.
 *
 * Storage layout: bucket `resumes` (private), object key
 * `{userId}/{uuid}.pdf`. The owner scoped first segment is JOB-007's
 * convention, not a preference: the storage policies on `storage.objects` key
 * off it, so an object stored anywhere else is readable by its owner through
 * the service role and by nobody else at all.
 *
 * `resumes.storage_path` stores the bucket-qualified path
 * `resumes/{userId}/{uuid}.pdf` — NOT a fetchable URL. The bucket is private,
 * so downstream consumers must mint a signed URL from `bucket` + `objectPath`
 * (both returned here) rather than using the stored path directly.
 *
 * ACT-014 adds a second prefix to the same bucket, `resumes/staging/`, holding
 * presigned uploads that have not yet become anybody's resume. See the ACT-014
 * section at the bottom of this file for why it is a prefix and not a bucket,
 * and for how those objects are reclaimed.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";

export const RESUMES_BUCKET = "resumes";

/** Storage's own default cap is 50MB; fail early with a readable message. */
const MAX_RESUME_BYTES = 25 * 1024 * 1024;

const PDF_MAGIC = "%PDF-";

export type CandidateIntakeInput = {
  /**
   * The person this resume belongs to: `profiles.id`, which is `auth.users.id`.
   *
   * Supplied rather than minted, and that is the whole of what JOB-004 changed
   * about this function. actinno generated a `candidates.id` here and handed it
   * back; Jobinno's id belongs to Supabase Auth, so the row has to exist before
   * a resume can be hung off it.
   */
  userId: string;
  /**
   * Path to a PDF resume on the local filesystem. Exactly one of this and
   * `assetHandle` must be given — see `resolveResumeSource`.
   */
  resumeFilePath?: string;
  /**
   * ACT-014. An `actinno-upload-{uuid}` handle from `createResumeUploadSlot()`,
   * naming an object already PUT into `resumes/staging/` over a presigned URL.
   * The alternative to `resumeFilePath` for callers that have the bytes but no
   * filesystem this process can read.
   */
  assetHandle?: string;
  /**
   * Where the person wants to work, written to `profiles.target_locations`.
   *
   * The one search preference of actinno's three that Jobinno has a column for.
   * `targetTitle` and `payMin` used to sit beside it and no longer do — see
   * `CandidateRecord` for what that costs and who owns closing it.
   */
  locations?: string[];
  /**
   * ACT-015. The facts an ATS application form asks for on almost every listing.
   *
   * All optional, and all meaning "we were never told" when absent — which is
   * exactly what the fill layer needs them to mean, because its rule is to ask
   * the candidate rather than guess. Collected once here so they are not asked
   * again per application. See `CandidateApplicationAnswers`.
   */
  applicationAnswers?: CandidateApplicationAnswers;
};

/**
 * ACT-015 — the reusable, factual answers a job application form wants.
 *
 * Every one of these is a statement a real person makes to a real employer, so
 * the type is deliberately tri-state: `true`, `false`, and absent. There is no
 * default. A missing value never becomes a "no" and never becomes a "yes"; it
 * becomes a question put to the candidate.
 *
 * Note what is **not** here and never will be: gender, race, ethnicity, veteran
 * status, disability status. Those questions are always answered "decline to
 * self-identify", so there is nothing to collect and nothing to store.
 */
export type CandidateApplicationAnswers = {
  /** "Are you legally authorized to work in the United States?" */
  workAuthorizedUs?: boolean;
  /** "Will you now or in the future require sponsorship for an employment visa?" */
  requiresSponsorship?: boolean;
  /** Where they actually live, e.g. "United States". Not a search preference. */
  currentCountry?: string;
  /** City/metro they actually live in, e.g. "San Francisco". */
  currentCity?: string;
  /** "Are you willing to relocate for this role?" */
  willingToRelocate?: boolean;
};

/** `CandidateApplicationAnswers` → the row shape, dropping anything unstated. */
function applicationAnswerColumns(
  answers: CandidateApplicationAnswers | undefined
): Record<string, string | boolean | null> {
  if (answers === undefined) return {};
  const row: Record<string, string | boolean | null> = {};
  // `undefined` is left out entirely rather than written as NULL, so that a
  // caller who says nothing about sponsorship cannot overwrite a column that
  // already holds an answer. On an INSERT the two are the same; the distinction
  // is what makes this shape safe to reuse for an update later.
  if (typeof answers.workAuthorizedUs === "boolean") row.work_authorized_us = answers.workAuthorizedUs;
  if (typeof answers.requiresSponsorship === "boolean") {
    row.requires_sponsorship = answers.requiresSponsorship;
  }
  if (typeof answers.willingToRelocate === "boolean") {
    row.willing_to_relocate = answers.willingToRelocate;
  }
  const country = normalizeOptionalText(answers.currentCountry);
  if (country !== null) row.current_country = country;
  const city = normalizeOptionalText(answers.currentCity);
  if (city !== null) row.current_city = city;
  return row;
}

export type CandidateIntakeResult = {
  /** `profiles.id`, echoed back. The caller supplied it; nothing minted it. */
  userId: string;
  /** The new `resumes.id`. */
  resumeId: string;
  /** Value written to `resumes.storage_path`: `resumes/{userId}/{uuid}.pdf`. */
  resumeUrl: string;
  /** Storage bucket name — use with `objectPath` to sign a URL. */
  bucket: string;
  /** Object key within the bucket: `{userId}/{uuid}.pdf`. */
  objectPath: string;
  /** Which of the two `CandidateIntakeInput` resume sources was used. */
  resumeSource: "file" | "staged-upload";
  /**
   * ACT-014, and only present for `resumeSource: "staged-upload"`. The bytes now
   * live at `{userId}/{uuid}.pdf`, so the staging copy is a duplicate and is
   * deleted; `removed: false` means that delete failed and one object is left
   * behind, which the 24h sweep in `createResumeUploadSlot()` will reclaim.
   */
  stagedUpload?: {
    assetHandle: string;
    /** `staging/{uuid}.pdf`, within the same `resumes` bucket. */
    objectPath: string;
    removed: boolean;
    removalError?: string;
  };
};

function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required " +
        "(see .env.example)"
    );
  }
  assertSupabaseProject(url);

  // Service-role, server-side only: no session to persist and nothing to
  // refresh. Leaving the defaults on keeps a refresh timer alive and prevents
  // short-lived processes (the CLI) from exiting cleanly.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validateInput(input: CandidateIntakeInput): void {
  // The resume source is checked by `resolveResumeSource()`, which the caller
  // runs first so that "which resume?" is answered before anything else is —
  // including before a malformed id is reported, because the answer decides
  // whether Supabase is touched at all.

  // The email check actinno did here is gone, and not because it stopped
  // mattering. `profiles.email` is written from the verified address Supabase
  // Auth hands back at signup, so by the time anything reaches this function
  // the address has already been proved to belong to the person. Revalidating
  // a value this function no longer accepts would only be theatre.
  //
  // What is checked instead is the id, for the reason `loadCandidate` gives at
  // length: it is the one identity in this system, and a malformed one fails
  // deep inside a query rather than here unless something says so first.
  const userId = String(input.userId ?? "").trim();
  if (!UUID_RE.test(userId)) {
    throw new Error(
      `userId must be a profiles.id UUID (the same id as auth.users.id), got ` +
        `${JSON.stringify(input.userId)}.`
    );
  }
}

/**
 * Reads the resume off disk and checks it is a PDF this pipeline can use.
 *
 * ACT-013 split the read failure into named cases. Until then the only caller
 * was `intake-cli.ts`, where a raw `EACCES: permission denied, open '…'` is
 * perfectly legible to the human who typed the path. The MCP actor's caller is
 * a language model relaying to someone who never saw a terminal, and the two
 * failures it will actually hit want opposite advice: `ENOENT` means "check the
 * path", while `EACCES`/`EPERM` on a path that plainly exists is the signature
 * of Claude Desktop's Seatbelt sandbox refusing `~/Desktop`, `~/Documents` and
 * `~/Downloads` — where "fix the path" is exactly the wrong instruction.
 *
 * The original fs error is preserved as `cause` so a caller that reaches this
 * can branch on `.code` rather than parse the sentence. The MCP actor mostly
 * does not reach it — it probes the path with `access()` first, precisely so it
 * can *choose between* paths — but the two classifications agree, and this one
 * is what the CLI and any future caller get for free.
 */
async function readResumePdf(path: string): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    const reason =
      code === "ENOENT"
        ? "no such file"
        : code === "EACCES" || code === "EPERM"
          ? "permission denied — this process is not allowed to read that path " +
            "(on macOS that is usually a sandbox or a TCC-protected folder, not a " +
            "file-permission bit)"
          : code === "EISDIR"
            ? "that is a directory, not a file"
            : err instanceof Error
              ? err.message
              : String(err);
    throw new Error(`Could not read resume file at "${path}": ${reason}`, { cause: err });
  }

  assertUsableResumeBytes(bytes, path);
  return bytes;
}

/**
 * The three checks that decide whether a blob of bytes is allowed to become
 * somebody's resume: non-empty, within the size cap, and a real PDF.
 *
 * Split out of `readResumePdf` by ACT-014 so there is exactly one copy of them.
 * A presigned upload URL means an arbitrary caller can put arbitrary bytes at a
 * staging path, so bytes arriving that way are *more* suspect than a file the
 * user pointed at, not less — and the way to guarantee they are treated at
 * least as strictly is for both paths to call this function rather than for the
 * new one to grow a lookalike. `source` is only ever used to name the thing in
 * the error, never to decide anything.
 */
function assertUsableResumeBytes(bytes: Buffer, source: string): void {
  if (bytes.byteLength === 0) {
    throw new Error(`Resume file is empty: ${source}`);
  }
  if (bytes.byteLength > MAX_RESUME_BYTES) {
    throw new Error(
      `Resume file is ${bytes.byteLength} bytes, over the ${MAX_RESUME_BYTES}-byte limit: ${source}`
    );
  }
  // The object key and content-type are hardcoded to PDF, so a non-PDF would be
  // stored mislabelled and silently break downstream form-fill.
  if (bytes.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) {
    throw new Error(
      `Resume file does not look like a PDF (missing "${PDF_MAGIC}" header): ${source}`
    );
  }
}

/**
 * Uploads a resume to the private `resumes` bucket and attaches it to an
 * existing profile: one `resumes` row for the file, one `profiles` update for
 * whatever preferences and reusable answers came with it. On failure the
 * uploaded object is removed so a failed intake does not leave an orphan
 * behind.
 *
 * ── Why two writes and not one, and why the resume goes first ───────────────
 * `app/onboarding/actions.ts` writes the same two rows in the opposite order,
 * and its own comment explains why it does: on the web the profile answers are
 * the thing being attested to, so a resume pointing at an unanswered profile is
 * the state worth avoiding. Here the answers are optional and the resume is the
 * point, so the resume is what gets the cleanup path wrapped around it. Both
 * orders are safe because neither row is ever read without the other.
 *
 * The resume comes from **either** a local file (`resumeFilePath`) **or** a
 * staged presigned upload (`assetHandle`, ACT-014). Both routes converge on the
 * same bytes before anything else happens: the source only decides where the
 * `Buffer` is read from, and `assertUsableResumeBytes` is applied to it either
 * way. Everything after that line — the upload to `{candidateId}.pdf`, the
 * insert, the orphan cleanup — is identical and does not know which route ran.
 *
 * Throws on any failure. Error messages are safe to log — they never include
 * credentials.
 */
export async function intakeCandidate(
  input: CandidateIntakeInput
): Promise<CandidateIntakeResult> {
  const source = resolveResumeSource(input);
  validateInput(input);

  const supabase = getSupabaseClient();
  const userId = input.userId.trim();
  // Owner scoped first segment, then a fresh uuid rather than a fixed name.
  // Both halves are JOB-007's convention: the segment is what the storage
  // policies match on, and the uuid is what lets a second upload be a new
  // resume rather than a silent overwrite of the one already applied with.
  const objectPath = `${userId}/${randomUUID()}.pdf`;
  const resumeUrl = `${RESUMES_BUCKET}/${objectPath}`;
  const resumeBytes =
    source.kind === "file"
      ? await readResumePdf(source.path)
      : await readStagedResume(supabase, source);

  const { error: uploadError } = await supabase.storage
    .from(RESUMES_BUCKET)
    .upload(objectPath, resumeBytes, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadError) {
    throw noteStagedUploadRetained(
      new Error(`Resume upload to "${resumeUrl}" failed: ${uploadError.message}`),
      source
    );
  }

  const locations = input.locations
    ?.map((l) => l.trim())
    .filter((l) => l.length > 0);

  let resumeId: string;
  try {
    // The profile has to already exist. `resumes.user_id` is a foreign key onto
    // it, so an unknown id would be caught by Postgres either way — but as a
    // constraint violation naming a constraint, three frames deep, rather than
    // as the one sentence that says what to do about it.
    const { data: profileRows, error: profileLookupError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", userId)
      .limit(1);
    if (profileLookupError) {
      throw new Error(`profiles lookup failed: ${profileLookupError.message}`);
    }
    if (!profileRows?.[0]) {
      throw new Error(
        `No profiles row with id ${userId}. A profile is created by signing in, ` +
          `not by this function — see app/auth/callback/route.ts.`
      );
    }

    const { data, error: insertError } = await supabase
      .from("resumes")
      .insert({
        user_id: userId,
        storage_path: resumeUrl,
      })
      // Round-trips the id so a silently-filtered insert (e.g. RLS) surfaces
      // as an error instead of a false success.
      .select("id")
      .single();

    if (insertError) {
      throw new Error(`Resume row insert failed: ${insertError.message}`);
    }
    if (typeof data?.id !== "string") {
      throw new Error(
        `Resume row insert did not return an id (got: ${JSON.stringify(data?.id)})`
      );
    }
    resumeId = data.id;

    // Preferences and reusable answers, and only the ones actually given.
    // `applicationAnswerColumns` already drops anything unstated, and
    // `locations` is added on the same rule: saying nothing must never blank a
    // column that already holds an answer.
    const profilePatch: Record<string, unknown> = {
      ...applicationAnswerColumns(input.applicationAnswers),
      ...(locations && locations.length > 0 ? { target_locations: locations } : {}),
    };
    if (Object.keys(profilePatch).length > 0) {
      const { error: profileError } = await supabase
        .from("profiles")
        .update({ ...profilePatch, updated_at: new Date().toISOString() })
        .eq("id", userId);
      if (profileError) {
        throw new Error(`Profile update failed: ${profileError.message}`);
      }
    }
  } catch (err) {
    await cleanupOrphanedResume(supabase, objectPath, err);
    // The staged object is deliberately NOT removed here. Everything that can
    // fail between this line and the read above is retryable — an id typo, a
    // Postgres blip, a failed upload — and the expensive, fragile part
    // of an ACT-014 intake is the upload leg, not the insert. Leaving the
    // staging object in place means the retry is one more actor call with the
    // same handle rather than another round trip through the model's execution
    // environment. Bytes that can *never* work (empty, oversized, not a PDF)
    // are the opposite case and are deleted by `readStagedResume` on the spot.
    throw noteStagedUploadRetained(err, source);
  }

  if (source.kind === "staged-upload") {
    // Success: the bytes now exist at `{userId}/{uuid}.pdf`, so the staging copy
    // is a duplicate of a resume that has an owner. Best-effort, and reported
    // rather than thrown — an intake that completed is not going to be failed
    // over a leftover object the sweep will collect within the day.
    const removal = await deleteStagedUpload(supabase, source.objectPath);
    return {
      userId,
      resumeId,
      resumeUrl,
      bucket: RESUMES_BUCKET,
      objectPath,
      resumeSource: "staged-upload",
      stagedUpload: {
        assetHandle: source.assetHandle,
        objectPath: source.objectPath,
        removed: removal === undefined,
        ...(removal === undefined ? {} : { removalError: removal }),
      },
    };
  }

  return {
    userId,
    resumeId,
    resumeUrl,
    bucket: RESUMES_BUCKET,
    objectPath,
    resumeSource: "file",
  };
}

/**
 * Everything the pipeline needs to know about a candidate, read back out of the
 * row this module wrote.
 *
 * Added for ACT-009. Its two events carry a `userId` and nothing else about
 * the person — see that file's header for why — so something has to turn that
 * id into an email and a resume, and this module owns the conventions involved
 * (the project guard, the private-bucket caveat on the stored path). Putting
 * the read anywhere else would mean a second guarded Supabase client to keep in
 * step with this one.
 *
 * `resumeUrl` is repeated here with the same caveat it carries on the way in:
 * it is the bucket-qualified path `resumes/{userId}/{uuid}.pdf`, not something
 * that can be fetched. Nothing in the pipeline uses it — ACT-007's
 * `loadResume` reads the object itself with the service-role client — and it is
 * returned only so a caller cannot mistake its absence for the file not
 * existing.
 */
export type CandidateRecord = {
  /** `profiles.id`, which is `auth.users.id`. See `loadCandidate`. */
  userId: string;
  applicationEmail: string;
  /**
   * ── A genuine gap, left visible on purpose (JOB-004) ──────────────────────
   *
   * Always null today. actinno stored `candidates.linkedin_url`, the profile
   * URL a form asks for by name on almost every listing. Jobinno's schema has
   * no column for it: `resumes.linkedin_pdf_path` is JOB-007's *PDF export*, a
   * file in a private bucket, and handing a storage path to a box that wants
   * `linkedin.com/in/...` would be worse than handing it nothing.
   *
   * The reason this is a gap rather than a hole is `lib/resume-parser.ts`,
   * whose `linkedinUrl` falls back to a linkedin.com URL found in the resume
   * text when this is null — which for a real resume is most of the time. So
   * forms still get filled; they get filled from the resume instead of from a
   * stated answer. Closing it properly is a `profiles.linkedin_url` column plus
   * a field on the intake form, which is a JOB-007 follow up and not this
   * ticket's to add.
   */
  linkedinUrl: string | null;
  /** Bucket-qualified path, NOT a fetchable URL. */
  resumeUrl: string;
  /**
   * `profiles.target_locations`. The only one of actinno's three search
   * preferences that has a column here.
   *
   * ── The other two, and why they are absent rather than null ───────────────
   *
   * `candidates.target_title` and `candidates.pay_min` have no Jobinno
   * equivalent. JOB-007's intake asks about work authorization, location and
   * dates; it never asks what job the person wants or what it has to pay.
   *
   * They are dropped from this type rather than kept and hard wired to null,
   * because a field that is structurally always null reads as data a caller can
   * wait for, and callers write `?? fallback` against it and move on. Removing
   * them makes `discoverListings` say out loud that a title filter has to come
   * from its event, which is true, and turns the day a column is added into a
   * compile error at every site that should start using it.
   */
  locations: string[] | null;
  /**
   * ACT-015. Only the answers that were actually given — an absent key means
   * "never asked", which the fill layer turns into a question for the candidate
   * rather than a guess on a real application.
   */
  applicationAnswers: CandidateApplicationAnswers;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every column a `CandidateRecord` is built from. One list, two readers.
 *
 * Written out as a single literal, not assembled from constants, and that is
 * load-bearing rather than untidy: supabase-js infers the row's type by parsing
 * the *literal* handed to `select()`, and the parser gives up on anything it
 * cannot see through — a `+` concatenation, or a nested `as const` template —
 * leaving every column read off the result a type error. The trailing five are
 * ACT-015's; keep them in step with `toApplicationAnswers` below.
 *
 * JOB-004 repointed this at `profiles`. Five of the eight names are unchanged,
 * because JOB-007 spelled its columns the way actinno already had; `id` is now
 * `auth.users.id`, `application_email` is now plain `email`, and `locations` is
 * now `target_locations`. The resume is not in this list at all any more — it
 * is a row in another table, read by `loadActiveResume`.
 */
const CANDIDATE_COLUMNS =
  "id,email,target_locations,work_authorized_us,requires_sponsorship,current_country,current_city,willing_to_relocate";

/**
 * Row → the answers that were actually recorded.
 *
 * A NULL column is omitted rather than mapped to `false` or `""`. That is the
 * whole contract: "we do not know" and "the answer is no" are different
 * statements to make on someone's job application, and collapsing them is the
 * exact mistake this ticket exists to prevent.
 */
export function toApplicationAnswers(row: Record<string, unknown>): CandidateApplicationAnswers {
  const answers: CandidateApplicationAnswers = {};
  if (typeof row.work_authorized_us === "boolean") answers.workAuthorizedUs = row.work_authorized_us;
  if (typeof row.requires_sponsorship === "boolean") {
    answers.requiresSponsorship = row.requires_sponsorship;
  }
  if (typeof row.willing_to_relocate === "boolean") {
    answers.willingToRelocate = row.willing_to_relocate;
  }
  const country = typeof row.current_country === "string" ? row.current_country.trim() : "";
  if (country !== "") answers.currentCountry = country;
  const city = typeof row.current_city === "string" ? row.current_city.trim() : "";
  if (city !== "") answers.currentCity = city;
  return answers;
}

/**
 * Row → record. Shared by `loadCandidate` and `findCandidateByEmail`.
 *
 * `resumeUrl` is passed in rather than read off the row, because it lives on a
 * different table now. Exported so the mapping can be tested against a row
 * shape without a database in the way.
 */
export function toCandidateRecord(
  row: Record<string, unknown>,
  resumeUrl: string
): CandidateRecord {
  const userId = String(row.id ?? "").trim();
  const applicationEmail = String(row.email ?? "").trim();
  if (applicationEmail === "") {
    // `profiles.email` is NOT NULL and is written from the address Supabase
    // Auth verified at signup, so an empty one means something wrote this row
    // that was not the auth callback.
    throw new Error(`profiles ${userId} has no email.`);
  }

  return {
    userId,
    applicationEmail,
    // See the type. There is no column to read this from yet.
    linkedinUrl: null,
    resumeUrl,
    locations: Array.isArray(row.target_locations) ? row.target_locations.map(String) : null,
    applicationAnswers: toApplicationAnswers(row),
  };
}

/**
 * The resume the pipeline should apply with: the newest active one.
 *
 * A person can have more than one `resumes` row — re uploading is the ordinary
 * way to replace a resume, and JOB-007's onboarding inserts rather than
 * updates — so "the resume" needs a rule. Newest active row wins, which is the
 * same rule `findCandidateByEmail` applies to duplicate profiles and for the
 * same reason: the most recent thing the person did is the thing they meant.
 *
 * Throws rather than returning an empty path. A run that reaches a real
 * employer's form with no resume to attach has already wasted a browser and an
 * application slot, and the failure is far more legible here.
 */
async function loadActiveResume(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("resumes")
    .select("storage_path,created_at")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`resumes lookup failed: ${error.message}`);

  const storagePath = String(data?.[0]?.storage_path ?? "").trim();
  if (storagePath === "") {
    throw new Error(
      `No active resumes row for profile ${userId}. Finish onboarding at /onboarding, ` +
        `or attach one from the command line with \`npm run intake\`.`
    );
  }
  return storagePath;
}

/**
 * Reads one profile, with its resume, by the person's own id.
 *
 * ── The identity, settled (JOB-004) ─────────────────────────────────────────
 * actinno minted a `candidates.id` of its own and carried it everywhere. This
 * id is not that. It is `auth.users.id`: `profiles.id` is declared as a foreign
 * key onto it in `lib/db/schema.ts`, `app/auth/callback/route.ts` upserts the
 * row as `{ id: user.id }` straight off the verified session, and
 * `applications.user_id` is a foreign key onto `profiles.id`. One id, from
 * Supabase Auth, all the way through. The old code's own comment already said
 * as much — it called this "the same identity as ... the userId" — so JOB-004
 * renamed the parameter to match what was already true rather than leaving two
 * names for one thing.
 *
 * The UUID check is not defensive clutter. Anything else passed in here — an
 * email address, an Inngest run id — would be *accepted by Postgres as a
 * malformed-uuid error* deep inside a query, or worse, silently match nothing;
 * failing on the shape first is what turns that into one legible sentence.
 */
export async function loadCandidate(userId: string): Promise<CandidateRecord> {
  const id = String(userId ?? "").trim();
  if (!UUID_RE.test(id)) {
    throw new Error(
      `userId must be a profiles.id UUID, got ${JSON.stringify(userId)}. This is the ` +
        `same identity as auth.users.id and as applications.user_id — an email address ` +
        `or an auth provider's subject claim here will match nothing at all.`
    );
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("profiles")
    .select(CANDIDATE_COLUMNS)
    .eq("id", id)
    .limit(1);
  if (error) throw new Error(`profiles lookup failed: ${error.message}`);

  const row = data?.[0];
  if (!row) {
    throw new Error(
      `No profiles row with id ${id}. A profile is created by signing in — see ` +
        `app/auth/callback/route.ts — so this id has never signed in to Jobinno.`
    );
  }

  return toCandidateRecord(row, await loadActiveResume(supabase, id));
}

/**
 * ACT-013 — reads one profile by the address applications are filed under, so
 * a person can be identified by something they know.
 *
 * `loadCandidate` above is the pipeline's lookup and takes the row's UUID,
 * which is right for a machine and useless for a human: before this, onboarding
 * through Claude Desktop ended with the user holding a bare UUID they had to
 * paste back for every apply. This is the same read keyed on
 * `profiles.email` instead, and it lives here rather than in the MCP server
 * for the reason given above `loadCandidate` — this module owns the schema's
 * conventions and the `assertSupabaseProject` guard, and a second Supabase
 * client elsewhere would be a copy of both.
 *
 * ── Why the duplicate handling stays (JOB-004) ──────────────────────────────
 * `profiles.email` has no unique constraint of its own. In practice a duplicate
 * is now much harder to produce than it was on `candidates`: the column is
 * written once, at signup, from the address Supabase Auth verified, and
 * `auth.users.email` is unique. But "harder" is not "cannot" — two auth
 * identities for one address, one emailed and one from an OAuth provider, land
 * as two profiles — so the newest wins rule below is kept rather than deleted
 * on the strength of a constraint that lives on a different table.
 *
 * ── Why the query is `ilike` and the comparison is not ──────────────────────
 * Users type `Jane@Example.com` for a row stored as `jane@example.com`, so the
 * match has to be case-insensitive, and PostgREST's only case-insensitive
 * operator is `ilike`. But `ilike` takes a *pattern*: `%`, `_` and `*` in the
 * value are wildcards, and `_` is common in real addresses (verified against
 * this project: `pranavlende12_@gmail.com` matches `pranavlende123@gmail.com`,
 * and backslash-escaping suppresses it). Escaping alone would make correctness
 * rest on PostgREST's escaping surviving a version bump — with a wrong
 * *candidate* as the failure — so the pattern is treated as nothing more than
 * a prefilter and every returned row is re-checked here by case-folded string
 * equality. Wildcards can then only ever cost an extra row, never resolve to
 * the wrong person.
 */
export async function findCandidateByEmail(applicationEmail: string): Promise<CandidateRecord> {
  const wanted = String(applicationEmail ?? "").trim();
  if (wanted === "" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wanted)) {
    throw new Error(
      `applicationEmail must be a valid email address, got ${JSON.stringify(applicationEmail)}.`
    );
  }

  const supabase = getSupabaseClient();
  const columns = `${CANDIDATE_COLUMNS},created_at`;

  // Exact first: wildcard-free, and the case that hits on nearly every call.
  const exact = await supabase.from("profiles").select(columns).eq("email", wanted);
  if (exact.error) throw new Error(`profiles lookup failed: ${exact.error.message}`);

  let rows = exact.data ?? [];
  if (rows.length === 0) {
    // Case-insensitive retry. `LIMIT` is generous rather than tight because the
    // authoritative filter is the fold-compare below, not the pattern: a
    // truncated over-match could otherwise drop the one true row and report
    // "no such candidate" for a candidate that exists.
    const folded = await supabase
      .from("profiles")
      .select(columns)
      .ilike("email", escapeLikePattern(wanted))
      .limit(200);
    if (folded.error) throw new Error(`profiles lookup failed: ${folded.error.message}`);
    const target = wanted.toLowerCase();
    rows = (folded.data ?? []).filter(
      (row) => String(row.email ?? "").trim().toLowerCase() === target
    );
  }

  if (rows.length === 0) {
    throw new Error(
      `Nobody has signed up for ${wanted}. A profile is created by signing in at /login ` +
        `and finishing intake at /onboarding; nothing else creates one. Until that row ` +
        `exists there is no email, no resume and nothing to apply with.`
    );
  }

  if (rows.length > 1) {
    // Newest wins, loudly.
    //
    // This used to refuse outright, on the reasoning that each row carries its
    // own uploaded resume so picking one risks applying with the wrong
    // document. The risk is real but the refusal was the wrong answer to it:
    // one address is one person, re-running intake is the ordinary way to
    // replace a resume, and their newest row is by definition their current
    // one. Choosing it is a rule, not a guess.
    //
    // It also failed in the worst available way. The refusal surfaced through
    // MCP as a bare "Tool execution failed" with no body, so the caller could
    // not see why, assumed the email path was broken, and switched to a
    // candidateId — which is exactly the identifier ACT-013 exists to stop
    // people needing. Three rows for one address is not an exotic state either;
    // it is what testing onboarding three times produces.
    const older = rows.length - 1;
    console.warn(
      `[act-003] ${rows.length} profiles rows share ${wanted}; using the most recently ` +
        `created one and ignoring ${older} older row(s). If that is wrong, pass the userId ` +
        `explicitly — each profile has its own resumes.`
    );
  }

  // Newest first. `created_at` is set by the column default on insert, so it is
  // present on every row; a row missing it sorts last rather than crashing.
  const newest = [...rows].sort((a, b) => {
    const left = Date.parse(String(a.created_at ?? ""));
    const right = Date.parse(String(b.created_at ?? ""));
    return (Number.isNaN(right) ? -Infinity : right) - (Number.isNaN(left) ? -Infinity : left);
  })[0]!;

  return toCandidateRecord(newest, await loadActiveResume(supabase, String(newest.id)));
}

/**
 * Escapes the characters PostgREST hands to SQL `LIKE` as wildcards, so an
 * address containing `_` or `%` is matched literally. `*` is deliberately left
 * alone: PostgREST rewrites it to `%`, so escaping it would search for a
 * literal `%` and *miss* a real `*` — an over-match the fold-compare discards
 * is harmless, a miss is a false "no such candidate".
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Best-effort removal of an uploaded object after a failed insert. Never
 * throws: a cleanup failure must not mask the original error, so it is
 * annotated onto that error's message instead.
 */
async function cleanupOrphanedResume(
  supabase: SupabaseClient,
  objectPath: string,
  originalError: unknown
): Promise<void> {
  let cleanupFailure: string | undefined;
  try {
    const { error } = await supabase.storage.from(RESUMES_BUCKET).remove([objectPath]);
    if (error) cleanupFailure = error.message;
  } catch (err) {
    cleanupFailure = err instanceof Error ? err.message : String(err);
  }

  if (cleanupFailure && originalError instanceof Error) {
    originalError.message +=
      ` (WARNING: also failed to clean up the uploaded object ` +
      `"${RESUMES_BUCKET}/${objectPath}" — it is now orphaned: ${cleanupFailure})`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACT-014 — resumes that arrive over HTTP instead of off the filesystem
// ═══════════════════════════════════════════════════════════════════════════
//
// ACT-013 could only take a path, and the path had to be one Claude Desktop's
// Seatbelt sandbox would let the MCP server read — which in practice meant the
// user copying their PDF into `~/.actinno-mcp/resumes/` from a terminal before
// they could onboard at all. That is a terminal step in a product whose whole
// claim is that there isn't one.
//
// The bytes cannot come through the model either. ACT-013's header explains why
// at length and none of it has changed: base64 through a context window is tens
// of thousands of tokens the model has to reproduce byte-perfectly, and a PDF
// attached to a conversation reaches the model as extracted *text*, so it does
// not have the bytes to reproduce in the first place.
//
// So the bytes go around the model. `createResumeUploadSlot()` mints a Supabase
// **presigned upload URL** — a token scoped to one object path, valid two hours,
// carrying no credential of ours — and the model's own execution environment
// (analysis tool, VM, whatever it has) PUTs the attached file straight to
// Supabase over HTTPS. Nothing but a URL crosses the context window, and the
// service-role key stays in this process, where it belongs.
//
// ── The security consequence, stated plainly ───────────────────────────────
// A presigned URL is a write capability handed to something outside our trust
// boundary. Whatever ends up at that path is *untrusted input* — exactly as
// untrusted as a file path a user types, and arguably more so. It is therefore
// run through `assertUsableResumeBytes()`, the same function and the same three
// checks (non-empty, ≤25MB, `%PDF-` magic) that a local file gets, before it can
// become anyone's resume. There is no separate, laxer path for uploads.
//
// ── Why a prefix in `resumes` and not its own bucket ───────────────────────
// `resumes` already exists, is private, and is reachable only by service_role;
// a second bucket would be a second thing to provision, a second policy to keep
// in step, and a second name for `assertSupabaseProject` to have no opinion
// about. `staging/` inside it cannot collide with the real objects, which are
// `{uuid}.pdf` at the bucket root with no slash in the key, and it means the
// existing `cleanupOrphanedResume` shape works unchanged.

/** Where presigned uploads land inside the `resumes` bucket. */
export const RESUME_STAGING_PREFIX = "staging";

/**
 * Supabase fixes the signed-upload token lifetime at two hours and exposes no
 * option to change it (`createSignedUploadUrl` takes only `{ upsert }`).
 * Verified against this project: the token's own `exp - iat` is 7200.
 */
const SIGNED_UPLOAD_TTL_SECONDS = 2 * 60 * 60;

/**
 * How long a staged object survives before the sweep reclaims it.
 *
 * Comfortably longer than the two hours its upload URL is good for, so the
 * sweep can never race a legitimate upload-then-intake, and short enough that
 * an abandoned onboarding does not leave a PDF sitting in the bucket for weeks.
 */
const STAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Objects removed per sweep. A ceiling, not a target — the sweep is a courtesy. */
const STAGED_UPLOAD_SWEEP_LIMIT = 100;

const ASSET_HANDLE_PREFIX = "actinno-upload-";

const ASSET_HANDLE_RE =
  /^actinno-upload-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** What `createResumeUploadSlot()` hands back, minus anything secret of ours. */
export type ResumeUploadSlot = {
  /** Opaque id to pass to `intakeCandidate({ assetHandle })` afterwards. */
  assetHandle: string;
  /**
   * The presigned URL. **PUT** the raw bytes here; the `?token=` is already on
   * it and is the entire authorization. Short-lived and write-only, but it is
   * still a capability — treat it like one.
   */
  uploadUrl: string;
  /** The same token, split out for resumable/TUS clients that want `x-signature`. */
  token: string;
  bucket: string;
  /** `staging/{uuid}.pdf`. */
  objectPath: string;
  expiresInSeconds: number;
  /** ISO 8601, derived from `expiresInSeconds` at mint time. */
  expiresAt: string;
  /** The cap `assertUsableResumeBytes` will apply when the object is read. */
  maxBytes: number;
  contentType: string;
  /** How many stale staged objects this call reclaimed on the way through. */
  sweptStaleUploads: number;
};

/** What `describeResumeUpload()` can say without downloading anything. */
export type ResumeUploadStatus = {
  assetHandle: string;
  bucket: string;
  objectPath: string;
  /** True once an object exists at the path — i.e. the PUT reached Supabase. */
  arrived: boolean;
  bytes: number | null;
  /** Whatever content-type the uploader sent. Advisory only; never trusted. */
  contentType: string | null;
  /** ISO 8601, or null when nothing has arrived. */
  uploadedAt: string | null;
};

/** Which of the two resume sources a `CandidateIntakeInput` names, resolved. */
type ResumeSource =
  | { kind: "file"; path: string }
  | { kind: "staged-upload"; assetHandle: string; objectPath: string };

/**
 * `assetHandle` → the one object path it is allowed to name.
 *
 * The handle is the only caller-supplied value that reaches a storage key, so
 * it is parsed rather than sanitised: the regex admits a UUID and nothing else,
 * and the path is *rebuilt* from the captured UUID rather than derived from the
 * input string. `../`, a bucket-qualified path, a key with a query string —
 * none of them can survive that, because none of them are ever concatenated.
 */
function assetHandleToObjectPath(rawHandle: string): string {
  const handle = String(rawHandle ?? "").trim();
  const match = ASSET_HANDLE_RE.exec(handle);
  if (match) return `${RESUME_STAGING_PREFIX}/${match[1]!.toLowerCase()}.pdf`;

  // A bare UUID is the mistake worth naming, because the UUID most likely to be
  // lying around is a `candidateId` — and silently accepting it would turn a
  // wrong-argument bug into a "your upload never arrived" report about an
  // upload that was never meant to exist.
  const looksLikeBareUuid = UUID_RE.test(handle);
  throw new Error(
    `assetHandle must be the "${ASSET_HANDLE_PREFIX}…" string returned by ` +
      `createResumeUploadSlot() (actinno/create-resume-upload), got ` +
      `${JSON.stringify(rawHandle)}.` +
      (looksLikeBareUuid
        ? ` That is a bare UUID — if it is a candidateId, this is the wrong argument ` +
          `entirely: intake mints the candidateId, it does not take one.`
        : "")
  );
}

/**
 * Exactly one resume source, or a refusal.
 *
 * Both-at-once is an error rather than a precedence rule, on the same reasoning
 * as `applicationEmail` vs `candidateId` in the MCP layer: the two can name
 * different documents, the disagreement is silent, and the cost of guessing
 * wrong is a real application filed at a real employer with the wrong resume
 * attached. A caller holding both loses nothing by dropping one.
 */
function resolveResumeSource(input: CandidateIntakeInput): ResumeSource {
  const path = input.resumeFilePath?.trim() ?? "";
  const handle = input.assetHandle?.trim() ?? "";

  if (path !== "" && handle !== "") {
    throw new Error(
      `intake takes EITHER resumeFilePath OR assetHandle, not both (got ` +
        `${JSON.stringify(input.resumeFilePath)} and ${JSON.stringify(input.assetHandle)}). ` +
        `They can name two different PDFs and this will not guess which one is the resume.`
    );
  }
  if (path === "" && handle === "") {
    throw new Error(
      `intake needs a resume: either resumeFilePath (a PDF on a filesystem this process can ` +
        `read) or assetHandle (an ${ASSET_HANDLE_PREFIX}… id for a PDF already uploaded to a ` +
        `presigned URL). Neither was given.`
    );
  }

  if (handle !== "") {
    return {
      kind: "staged-upload",
      assetHandle: handle,
      objectPath: assetHandleToObjectPath(handle),
    };
  }
  return { kind: "file", path };
}

/**
 * Mints a presigned upload slot, and sweeps stale ones on the way through.
 *
 * `upsert: true` is deliberate. Without it the slot is write-once, and the
 * failure that produces is nasty in exactly this setting: the uploader's PUT
 * lands, the response is lost to a flaky connection, the retry gets
 * `400 Asset Already Exists`, and the model concludes the upload failed when it
 * in fact succeeded. With upsert the PUT is idempotent and "retry it" is honest
 * advice. Nothing is weakened by it — the slot is a fresh unguessable path that
 * no one else has been told about, and its bytes are validated on the way out
 * regardless of how many times they were written.
 */
export async function createResumeUploadSlot(): Promise<ResumeUploadSlot> {
  const supabase = getSupabaseClient();
  const uploadId = randomUUID();
  const objectPath = `${RESUME_STAGING_PREFIX}/${uploadId}.pdf`;

  // Before minting, not after: this is the only moment the system is reliably
  // about to add to `staging/`, which makes it the natural place to pay for
  // what previous attempts left. Failures are swallowed — a full-up staging
  // prefix is a tidiness problem, an intake that cannot start is not.
  const sweptStaleUploads = await sweepStaleStagedUploads(supabase);

  const { data, error } = await supabase.storage
    .from(RESUMES_BUCKET)
    .createSignedUploadUrl(objectPath, { upsert: true });

  if (error || !data) {
    throw new Error(
      `Could not create a presigned upload URL for "${RESUMES_BUCKET}/${objectPath}": ` +
        `${error?.message ?? "no data returned"}`
    );
  }

  return {
    assetHandle: `${ASSET_HANDLE_PREFIX}${uploadId}`,
    uploadUrl: data.signedUrl,
    token: data.token,
    bucket: RESUMES_BUCKET,
    objectPath,
    expiresInSeconds: SIGNED_UPLOAD_TTL_SECONDS,
    expiresAt: new Date(Date.now() + SIGNED_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    maxBytes: MAX_RESUME_BYTES,
    contentType: "application/pdf",
    sweptStaleUploads,
  };
}

/**
 * Did the upload leg land? Answered without downloading a byte.
 *
 * `list()` with a `search` returns the object's size and creation time from
 * Postgres, so this costs one indexed row read whatever the size of the PDF.
 * That is the whole point: the upload leg is the part of ACT-014 most likely to
 * fail (the model's execution environment may have no egress at all), and
 * finding out should not require committing to an intake or moving 25MB.
 *
 * It deliberately does **not** report whether the bytes are a valid PDF. That
 * judgment belongs to `assertUsableResumeBytes` at intake, and duplicating a
 * weaker version of it here would invite treating this function's "looks fine"
 * as permission to skip it.
 */
export async function describeResumeUpload(assetHandle: string): Promise<ResumeUploadStatus> {
  const objectPath = assetHandleToObjectPath(assetHandle);
  const fileName = objectPath.slice(RESUME_STAGING_PREFIX.length + 1);
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.storage
    .from(RESUMES_BUCKET)
    .list(RESUME_STAGING_PREFIX, { limit: 1, search: fileName });
  if (error) {
    throw new Error(`Could not check "${RESUMES_BUCKET}/${objectPath}": ${error.message}`);
  }

  // `search` is a substring match, not an equality one, so the name is checked.
  const found = (data ?? []).find((entry) => entry.name === fileName);
  const base = {
    assetHandle: String(assetHandle).trim(),
    bucket: RESUMES_BUCKET,
    objectPath,
  };
  if (!found) {
    return { ...base, arrived: false, bytes: null, contentType: null, uploadedAt: null };
  }

  const metadata = (found.metadata ?? {}) as { size?: unknown; mimetype?: unknown };
  return {
    ...base,
    arrived: true,
    bytes: typeof metadata.size === "number" ? metadata.size : null,
    contentType: typeof metadata.mimetype === "string" ? metadata.mimetype : null,
    uploadedAt: found.created_at ?? null,
  };
}

/**
 * Reads a staged object and returns it only if it is a usable resume.
 *
 * The two failures this has to tell apart are "the upload never happened" and
 * "the upload happened and produced rubbish", because the remedies differ. The
 * first is the known feasibility risk of the whole design — the model's
 * execution environment may simply have no route to Supabase — and its answer
 * is the `resumeFilePath` fallback, so the message says so at length rather
 * than reporting a missing object and leaving the reader to work it out.
 *
 * A zero-byte object is grouped with "never happened" on purpose: an empty PUT
 * is the shape a half-working upload leg takes, and it is indistinguishable
 * from a missing one in terms of what the user has to do next.
 */
async function readStagedResume(
  supabase: SupabaseClient,
  source: Extract<ResumeSource, { kind: "staged-upload" }>
): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(RESUMES_BUCKET).download(source.objectPath);

  if (error || !data) {
    if (isObjectNotFound(error)) throw uploadDidNotLandError(source, "no object exists at");
    throw new Error(
      `Could not read the staged upload "${RESUMES_BUCKET}/${source.objectPath}": ` +
        `${error?.message ?? "no data returned"}`
    );
  }

  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.byteLength === 0) {
    // Delete first: a 0-byte object would otherwise make every later
    // `describeResumeUpload` report `arrived: true`, which is precisely the
    // confusing half-state this ticket exists to avoid.
    await deleteStagedUpload(supabase, source.objectPath);
    throw uploadDidNotLandError(source, "a zero-byte object is sitting at");
  }

  try {
    assertUsableResumeBytes(bytes, `${RESUMES_BUCKET}/${source.objectPath}`);
  } catch (err) {
    // Unlike the retryable failures handled in `intakeCandidate`'s catch, no
    // number of retries makes these bytes into a resume. Leaving them would be
    // the "garbage accumulating" case, so the slot is emptied here and the
    // caller is told to upload a real PDF rather than to try again.
    const removal = await deleteStagedUpload(supabase, source.objectPath);
    if (err instanceof Error) {
      err.message +=
        ` — those are the bytes that were uploaded for ${source.assetHandle}, and they cannot ` +
        `become a resume, so the staged object has been ${
          removal === undefined ? "deleted" : `left in place (delete failed: ${removal})`
        }. Upload the real PDF to a fresh slot from actinno/create-resume-upload.`;
    }
    throw err;
  }

  return bytes;
}

/** The one message the "upload leg did not work" case must always produce. */
function uploadDidNotLandError(
  source: Extract<ResumeSource, { kind: "staged-upload" }>,
  what: string
): Error {
  return new Error(
    `The resume upload for ${source.assetHandle} did not land: ${what} ` +
      `"${RESUMES_BUCKET}/${source.objectPath}". The presigned URL was issued, but the PUT ` +
      `carrying the PDF's bytes never completed — so there is nothing to make a candidate ` +
      `out of and no candidate has been created.\n\n` +
      `Two things cause this. Either the upload was never attempted, in which case do it now ` +
      `(PUT the raw bytes to the uploadUrl with content-type: application/pdf) and re-run ` +
      `intake with this same assetHandle. Or the environment holding the PDF cannot reach ` +
      `Supabase over the network at all, which no retry will fix — in that case fall back to ` +
      `the file route:\n\n` +
      `    mkdir -p ~/.actinno-mcp/resumes && cp <the resume PDF> ~/.actinno-mcp/resumes/\n\n` +
      `then run intake again with resumeFilePath ~/.actinno-mcp/resumes/<filename>.pdf ` +
      `instead of assetHandle.`
  );
}

/**
 * Storage's "there is nothing there" reply, which is not shaped like one.
 *
 * Observed against this project: a missing object comes back as
 * `{ status: 400, statusCode: "404", message: "Object not found" }` — an HTTP
 * 400 wrapping a 404 in a *string*. Matching on `status` would classify every
 * bad request as a missing object; matching on the message alone would break
 * on a wording change. Both are checked.
 */
function isObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { statusCode, message } = error as { statusCode?: unknown; message?: unknown };
  if (statusCode === "404" || statusCode === 404) return true;
  return typeof message === "string" && /not found|NoSuchKey/i.test(message);
}

/**
 * Adds "your upload is still there, retry with the same handle" to an error
 * thrown after the staged bytes were read but before they became a candidate.
 *
 * Passed through untouched for the file route and for non-`Error` throws, so
 * callers can wrap unconditionally.
 */
function noteStagedUploadRetained(err: unknown, source: ResumeSource): unknown {
  if (source.kind === "staged-upload" && err instanceof Error) {
    err.message +=
      ` (The staged upload ${source.assetHandle} was not consumed and is still there — ` +
      `once whatever caused this is fixed, re-run intake with the same assetHandle rather ` +
      `than uploading the PDF again.)`;
  }
  return err;
}

/**
 * Best-effort delete of one staged object. Returns the failure instead of
 * throwing it, for the same reason `cleanupOrphanedResume` never throws: none
 * of this module's callers should lose a completed intake, or have a real error
 * replaced, because a tidy-up call failed.
 */
async function deleteStagedUpload(
  supabase: SupabaseClient,
  objectPath: string
): Promise<string | undefined> {
  try {
    const { error } = await supabase.storage.from(RESUMES_BUCKET).remove([objectPath]);
    return error ? error.message : undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Deletes staged objects older than `STAGED_UPLOAD_TTL_MS`.
 *
 * The accumulation this prevents is not the failed-intake case — that one is
 * handled precisely, above — but the abandoned one: a slot is minted, the user
 * changes their mind or the conversation ends, and a PDF nobody will ever claim
 * stays in the bucket. Sweeping on mint keeps that bounded with no cron, no
 * edge function and no extra table, at the cost of one `list` on a prefix that
 * is empty almost all of the time.
 *
 * Never throws.
 */
async function sweepStaleStagedUploads(supabase: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await supabase.storage
      .from(RESUMES_BUCKET)
      .list(RESUME_STAGING_PREFIX, {
        limit: STAGED_UPLOAD_SWEEP_LIMIT,
        sortBy: { column: "created_at", order: "asc" },
      });
    if (error || !data) return 0;

    const cutoff = Date.now() - STAGED_UPLOAD_TTL_MS;
    const stale = data
      .filter((entry) => {
        // Only ever objects this module named. `list()` also surfaces Storage's
        // own `.emptyFolderPlaceholder` rows, and a prefix-wide delete of
        // anything that merely looks old is not a thing to write into a bucket
        // that also holds every candidate's resume.
        const stem = entry.name.endsWith(".pdf") ? entry.name.slice(0, -4) : "";
        if (!UUID_RE.test(stem)) return false;
        const created = Date.parse(entry.created_at ?? "");
        return Number.isFinite(created) && created < cutoff;
      })
      .map((entry) => `${RESUME_STAGING_PREFIX}/${entry.name}`);

    if (stale.length === 0) return 0;

    const { data: removed, error: removeError } = await supabase.storage
      .from(RESUMES_BUCKET)
      .remove(stale);
    return removeError ? 0 : (removed?.length ?? 0);
  } catch {
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACT-015 — reading back how an application went
// ═══════════════════════════════════════════════════════════════════════════
//
// Applying is fire-and-forget: something posts an Inngest event and returns in
// about a second while a browser chain runs for minutes. That was fine while
// the only two outcomes were "submitted" and "a human has to look at it",
// because the candidate learns the first from the employer's own confirmation
// email.
//
// ACT-015 added a third: the run filled everything it could, refused to invent
// an answer to a required question, and stopped with the question written down.
// That outcome is *addressed to the user* — it is a question for them — and it
// has to be able to reach them.
//
// ── Where the reason lives now (JOB-004) ────────────────────────────────────
// actinno kept it in `job_applications.error_message`, a free text column that
// held stack traces, blocked reasons and unanswered questions alike. Jobinno
// has no such column and deliberately so: `skip_log` records the same thing as
// a row, with a `reason` drawn from a closed set and the detail in
// `raw_context`. So this read joins the two rather than selecting one column,
// and what it reports is the newest skip against the application.
//
// It still introduces no new state. Everything below is written by the same
// code that writes every other outcome.

export type ApplicationStatusRecord = {
  applicationId: string;
  /** `jobs.id`. The listing, which is a row here rather than three columns. */
  jobId: string;
  company: string;
  jobTitle: string;
  applyUrl: string;
  status: string;
  /**
   * The newest `skip_log` row against this application, or null if nothing has
   * been skipped. `detail` is the message the run recorded, including any
   * questions it needs the candidate to answer.
   */
  skip: { reason: string; detail: string | null; at: string | null } | null;
  /** The employer's own reference, once the submit step has one. */
  confirmationText: string | null;
  submittedAt: string | null;
  redirectUrl: string | null;
  createdAt: string | null;
};

/** Applications per read. A candidate applying to more than this wants a dashboard. */
const MAX_APPLICATIONS_LISTED = 50;

/**
 * Every application filed for one person, most recently created first.
 *
 * Read-only, and the columns are named rather than starred so a schema change
 * cannot quietly widen what this returns.
 */
export async function listCandidateApplications(
  userId: string,
  options: { applyUrl?: string; limit?: number } = {}
): Promise<ApplicationStatusRecord[]> {
  const id = String(userId ?? "").trim();
  if (!UUID_RE.test(id)) {
    throw new Error(`userId must be a profiles.id UUID, got ${JSON.stringify(userId)}.`);
  }

  const supabase = getSupabaseClient();
  let query = supabase
    .from("applications")
    // ── Why this literal is inlined and not a named constant ─────────────────
    // supabase-js infers the row's type by parsing the *literal* handed to
    // `select()`, and gives up on anything it cannot see through, including a
    // constant. Same reason `CANDIDATE_COLUMNS` above is written out in full.
    //
    // `jobs!inner` rather than `jobs` so that the optional `applyUrl` filter
    // below narrows *applications* and not just the embedded listing. Without
    // the inner join a non matching filter returns every application with a
    // null job on it, which reads as "no listing" rather than "no match" and is
    // the worse of the two lies.
    .select("id,job_id,status,submitted_at,confirmation_text,redirect_url,created_at,jobs!inner(title,url,boards(company)),skip_log(reason,raw_context,created_at)")
    .eq("user_id", id)
    // `applications` has no `updated_at`, so creation order is the only order
    // this table can be read in. It is also the honest one: a row's status
    // changes, but the run it belongs to does not move in the queue.
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(options.limit ?? MAX_APPLICATIONS_LISTED, 1), MAX_APPLICATIONS_LISTED));

  const applyUrl = options.applyUrl?.trim();
  if (applyUrl !== undefined && applyUrl !== "") query = query.eq("jobs.url", applyUrl);

  const { data, error } = await query;
  if (error) throw new Error(`applications lookup failed: ${error.message}`);

  // Through `unknown` deliberately. supabase-js infers an error-shaped union for
  // an embedded select it cannot fully resolve, and a direct assertion from that
  // union is a type error rather than a lie about the data: PostgREST returned
  // rows or it returned an error, and the error branch was already thrown above.
  return (data ?? []).map((row) =>
    toApplicationStatusRecord(row as unknown as Record<string, unknown>)
  );
}

/**
 * One joined row → one record. Exported so the join's shape can be tested
 * without a database, which is the part of this read most likely to drift.
 *
 * PostgREST returns an embedded to-one relationship as an object and a to-many
 * as an array, and supabase-js's inferred types do not always agree with which
 * of the two a given foreign key produces. Both shapes are accepted here rather
 * than asserted, because a wrong guess costs a null company on a real
 * dashboard and the check is two lines.
 */
export function toApplicationStatusRecord(row: Record<string, unknown>): ApplicationStatusRecord {
  const one = (value: unknown): Record<string, unknown> | null => {
    const candidate = Array.isArray(value) ? value[0] : value;
    return candidate !== null && typeof candidate === "object"
      ? (candidate as Record<string, unknown>)
      : null;
  };

  const job = one(row.jobs);
  const board = one(job?.boards);

  const skips = Array.isArray(row.skip_log)
    ? (row.skip_log as Record<string, unknown>[])
    : one(row.skip_log)
      ? [one(row.skip_log) as Record<string, unknown>]
      : [];
  // Newest skip wins. An application can be attempted more than once, and the
  // reason the person needs to see is the one from the attempt that just ran.
  const newestSkip = [...skips].sort((a, b) => {
    const left = Date.parse(String(a.created_at ?? ""));
    const right = Date.parse(String(b.created_at ?? ""));
    return (Number.isNaN(right) ? -Infinity : right) - (Number.isNaN(left) ? -Infinity : left);
  })[0];

  return {
    applicationId: String(row.id ?? ""),
    jobId: String(row.job_id ?? ""),
    company: String(board?.company ?? ""),
    jobTitle: String(job?.title ?? ""),
    applyUrl: String(job?.url ?? ""),
    status: String(row.status ?? ""),
    skip:
      newestSkip === undefined
        ? null
        : {
            reason: String(newestSkip.reason ?? ""),
            detail: skipDetail(newestSkip.raw_context),
            at: typeof newestSkip.created_at === "string" ? newestSkip.created_at : null,
          },
    confirmationText:
      typeof row.confirmation_text === "string" ? row.confirmation_text : null,
    submittedAt: typeof row.submitted_at === "string" ? row.submitted_at : null,
    redirectUrl: typeof row.redirect_url === "string" ? row.redirect_url : null,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  };
}

/** `skip_log.raw_context.message`, when there is one. See `recordSkip`. */
function skipDetail(rawContext: unknown): string | null {
  if (rawContext === null || typeof rawContext !== "object" || Array.isArray(rawContext)) {
    return null;
  }
  const message = (rawContext as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() !== "" ? message : null;
}
