/**
 * JOB-112 — parsing the candidate's two documents once, when they onboard,
 * instead of once per application.
 *
 * ── Why this is a durable function and not part of the server action ────────
 * Because `app/onboarding/actions.ts` is a person waiting on a form submit, and
 * two PDFs through an LLM is tens of seconds of that wait for something they do
 * not need to see the result of. So intake writes the row, fires this event and
 * returns; the parse lands a moment later. Nothing downstream depends on the
 * ordering, because the fill pipeline falls back to parsing inline when
 * `resumes.parsed` is empty — see `lib/candidate-documents.ts`. This function
 * makes the common case fast; it is not what makes it correct.
 *
 * That same fallback is why this needs no backfill and no migration of existing
 * rows. Every row written before this ticket has `parsed` NULL, takes the inline
 * path on its next application, and is stored from then on.
 *
 * ── Why it takes a resume id and not a user id ──────────────────────────────
 * A person can have several `resumes` rows — re-uploading is the ordinary way
 * to replace a resume, and both writers insert rather than update. An event
 * carrying only a user id would have to re-derive "which resume?" here, and a
 * race between two uploads would then have both runs parse whichever row won
 * that lookup at the moment they happened to run. The id of the row the intake
 * write actually created is unambiguous.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 * It never opens a browser and it never touches an application. Its whole
 * effect is one `resumes.parsed` column on one row. The untrusted text it
 * handles is read and parsed inside `lib/resume-parser.ts`, which has no
 * browser, no Stagehand and no tools, and asserts that at runtime before each
 * model call. A second untrusted document does not weaken that requirement, it
 * is a second reason for it.
 */

// The pipeline's first import is `./load-env`, so importing the client from it
// keeps the ordering that file's header depends on.
import { inngest } from "./job-application-pipeline";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { deriveStoredParse, writeStoredParse } from "@/lib/candidate-documents";
import { loadResume } from "@/lib/resume-parser";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";

const LOG = "[job-112]";

export const INTAKE_COMPLETED = "intake/completed";

/**
 * What onboarding sends.
 *
 * `userId` rides along even though the lookup below is by `resumeId`, because a
 * failing run in the Inngest dashboard is a great deal easier to act on when it
 * names the person as well as the row.
 */
export type IntakeCompletedData = {
  userId: string;
  resumeId: string;
};

/** Service-role client, matching every other module that reaches Supabase here. */
function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required (see .env.example)"
    );
  }
  assertSupabaseProject(url);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const parseCandidateDocuments = inngest.createFunction(
  {
    id: "parse-candidate-documents",
    triggers: [{ event: INTAKE_COMPLETED }],
    // One parse per resume row at a time. Two events for the same row — a retry
    // racing the original, a double submit — would otherwise pay for the same
    // two model calls twice and race each other's writes to the same column.
    concurrency: { limit: 4, key: "event.data.resumeId" },
    // A retry here costs two model calls and no browser, so the default is
    // fine. It is bounded rather than unlimited for the ordinary reason: a
    // resume that is a scan will fail on every attempt and there is nothing to
    // gain from finding that out four times.
    retries: 2,
  },
  async ({ event, step }) => {
    const userId = String(event.data?.userId ?? "").trim();
    const resumeId = String(event.data?.resumeId ?? "").trim();
    if (resumeId === "") throw new Error("intake/completed needs a resumes.id.");

    // One step. The two model calls and the write belong together: splitting
    // them would mean a retry of the write re-running against an extraction
    // that had to cross a step boundary, and a step's return value is durable
    // state — there is no reason for a person's employment history to be stored
    // twice, once in `resumes.parsed` and once in an Inngest run's memoized
    // step output.
    return await step.run("parse-and-store", async () => {
      const supabase = getSupabaseClient();

      const { data, error } = await supabase
        .from("resumes")
        .select("id,user_id,storage_path,linkedin_pdf_path")
        .eq("id", resumeId)
        .limit(1);
      if (error) throw new Error(`resumes lookup failed: ${error.message}`);

      const row = data?.[0];
      if (!row) {
        // Not an error worth retrying. The row is gone, which for a cascade off
        // a deleted profile is a perfectly ordinary thing to have happened
        // between the event being sent and this running.
        console.warn(`${LOG} no resumes row ${resumeId} — nothing to parse.`);
        return { resumeId, parsed: false };
      }

      const storagePath = String(row.storage_path ?? "").trim();
      const linkedinRaw = String(row.linkedin_pdf_path ?? "").trim();
      const linkedinPdfPath = linkedinRaw === "" ? null : linkedinRaw;

      console.log(
        `${LOG} parsing the documents on resumes ${resumeId} for ${userId || row.user_id} ` +
          `(resume${linkedinPdfPath === null ? ", no LinkedIn export" : " + LinkedIn export"})`
      );

      const resume = await loadResume(supabase, storagePath);
      const parse = await deriveStoredParse(
        supabase,
        { resumeId, resumePath: storagePath, linkedinPdfPath },
        resume.text
      );
      await writeStoredParse(supabase, resumeId, parse);

      return { resumeId, parsed: true, linkedin: parse.linkedin !== null };
    });
  }
);
