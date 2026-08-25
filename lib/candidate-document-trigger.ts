/**
 * JOB-112 — the one way to ask for a candidate's documents to be parsed.
 *
 * ── Why a module rather than an `inngest.send()` in the server action ───────
 * Two reasons, and the second is the load-bearing one.
 *
 * The shape of the event has one definition, the same argument
 * `lib/job-search-trigger.ts` makes for `job-search/requested`.
 *
 * And the import stays out of `app/onboarding/actions.ts`. Importing the
 * Inngest client there would pull `inngest/job-application-pipeline.ts` into
 * the onboarding server action's module graph, and that module reaches
 * Stagehand, a browser and the whole submit path. None of it would run, but it
 * would all be loaded, and "the page that handles a person's resume upload does
 * not import the thing that drives browsers" is a property worth keeping
 * literally true. The dynamic import below is what keeps it that way.
 *
 * ── Why a failure here is swallowed ─────────────────────────────────────────
 * Because the parse is an optimisation and the submit is not. The person's
 * profile, resume row and attestation are all already written by the time this
 * is called; the only thing a thrown error could do is turn a completed
 * onboarding into an error message about something the user cannot act on. The
 * fill pipeline falls back to parsing inline whenever `resumes.parsed` is empty
 * — see `lib/candidate-documents.ts` — so the cost of this never running is one
 * slower first application.
 */

const LOG = "[job-112]";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fire `intake/completed` for one freshly written `resumes` row.
 *
 * Resolves once Inngest has accepted the event, which is not the same as the
 * documents having been parsed and is not meant to be.
 */
export async function requestDocumentParse(userId: string, resumeId: string): Promise<void> {
  if (!UUID_RE.test(resumeId) || !UUID_RE.test(userId)) {
    console.warn(
      `${LOG} not requesting a parse: userId ${JSON.stringify(userId)} and resumeId ` +
        `${JSON.stringify(resumeId)} must both be UUIDs. The first application will parse ` +
        `inline instead.`
    );
    return;
  }

  try {
    const { INTAKE_COMPLETED } = await import("@/inngest/parse-candidate-documents");
    const { inngest } = await import("@/inngest/job-application-pipeline");
    await inngest.send({ name: INTAKE_COMPLETED, data: { userId, resumeId } });
    console.log(`${LOG} requested a document parse for resumes ${resumeId}`);
  } catch (error) {
    console.warn(
      `${LOG} could not request a document parse for resumes ${resumeId}: ` +
        `${error instanceof Error ? error.message : String(error)}. Onboarding is unaffected ` +
        `— the first application will parse inline and store the result.`
    );
  }
}
