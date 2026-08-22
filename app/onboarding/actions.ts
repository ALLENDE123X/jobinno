"use server";

/**
 * The one write that turns a signed in stranger into someone the pipeline can
 * apply on behalf of.
 *
 * ── Why this revalidates the payload the client already validated ───────────
 * Because the client is not where validation happens, it is where validation is
 * displayed. The same schema runs in the browser to put a message under the
 * right field and runs again here because a server action is a public HTTP
 * endpoint and anything can post to it. The payload arrives as `unknown` and
 * stays `unknown` until zod says otherwise.
 *
 * ── Why the user scoped client and not the service role ─────────────────────
 * The answers a person gives about themselves are theirs to write, so row level
 * security is left switched on to enforce that rather than bypassed and rebuilt
 * here by hand. The two storage paths are the exception worth naming: they are
 * strings the client chose, so `intakeSchema` is built with the session's user
 * id and rejects a path naming anyone else's folder.
 *
 * ── Why `attested_at` is the one write that is not ──────────────────────────
 * Because it is the only field here that is not an answer. It is our record
 * that the answers arrived and that the person stood behind them, and the whole
 * point of a record like that is that its subject cannot write it. Migration
 * `0003_profiles_column_privileges` takes UPDATE on that column away from
 * `authenticated` for exactly that reason, so the stamp goes through
 * `recordAttestation`, which holds the only writer left.
 *
 * That same write is also where the Free plan's ten applications get granted,
 * once, on a person's first completed intake. See
 * `lib/onboarding/attestation.ts` for why that grant has to be part of this
 * one statement rather than a second write here: this action can be reached a
 * second time for a person already attested, and the module it calls is what
 * makes that safe.
 */

import { revalidatePath } from "next/cache";

import { ANALYTICS_EVENT } from "@/lib/analytics/events";
import { captureServerEvent } from "@/lib/analytics/posthog-server";
import { requestDocumentParse } from "@/lib/candidate-document-trigger";
import { recordAttestation } from "@/lib/onboarding/attestation";
import { intakeFieldErrors, intakeSchema } from "@/lib/onboarding/intake-schema";
import { RESUMES_BUCKET, createServerClient } from "@/lib/supabase/server";

export type IntakeResult =
  | { ok: true }
  | { ok: false; message?: string; errors?: Record<string, string> };

export async function submitIntake(payload: unknown): Promise<IntakeResult> {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      ok: false,
      message: "Your session has expired. Sign in again and your files are still there.",
    };
  }

  const parsed = intakeSchema(user.id).safeParse(payload);
  if (!parsed.success) {
    return { ok: false, errors: intakeFieldErrors(parsed.error) };
  }

  const intake = parsed.data;

  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      citizenship_status: intake.citizenshipStatus,
      f1_status: intake.f1Status,
      work_authorized_us: intake.workAuthorizedUs,
      requires_sponsorship: intake.requiresSponsorship,
      current_city: intake.currentCity,
      current_country: intake.currentCountry,
      willing_to_relocate: intake.willingToRelocate,
      target_locations: intake.targetLocations,
      grad_date: intake.gradDate,
      earliest_start: intake.earliestStart,
      // JOB-101. Every one of these is read back by `CANDIDATE_COLUMNS` in
      // `lib/candidate-intake.ts` and has a fact in `buildFactCatalog`, which is
      // the whole point of the ticket: the four columns JOB-022 found were
      // written here and read nowhere had cost 18 stopped applications in a
      // single day, and adding a ninth column to this list without doing the
      // other two steps would rebuild that exact failure.
      clearance_eligibility: intake.clearanceEligibility,
      clearance_level_held: intake.clearanceLevelHeld,
      needs_sponsorship_non_us: intake.needsSponsorshipNonUs,
      visa_status: intake.visaStatus,
      high_school_name: intake.highSchoolName,
      high_school_grad_year: intake.highSchoolGradYear,
      street_address: intake.streetAddress,
      postal_code: intake.postalCode,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (profileError) {
    return { ok: false, message: `Could not save your details: ${profileError.message}` };
  }

  // Written after the profile, deliberately. The other order leaves a resume
  // pointing at a profile that never got its answers, which nothing downstream
  // can tell apart from a half filled form.
  // JOB-112 added the `select`. The new row's id is what `intake/completed`
  // carries, so the parse runs against the row this submit created rather than
  // against whichever row a second lookup would have found — which for someone
  // re-uploading is a race with their own previous resume.
  const { data: resumeRow, error: resumeError } = await supabase
    .from("resumes")
    .insert({
      user_id: user.id,
      // Bucket qualified, matching the convention `lib/candidate-intake.ts` uses
      // for every stored resume path: a path to sign a URL from, never a URL.
      storage_path: `${RESUMES_BUCKET}/${intake.resumePath}`,
      linkedin_pdf_path: intake.linkedinPdfPath
        ? `${RESUMES_BUCKET}/${intake.linkedinPdfPath}`
        : null,
    })
    .select("id")
    .single();

  if (resumeError) {
    return { ok: false, message: `Could not save your resume: ${resumeError.message}` };
  }

  // Last, and only once everything it attests to is actually in the database.
  // `/onboarding` reads a non null `attested_at` as "this person is set up", so
  // stamping it before the resume insert would mean a failed insert left behind
  // a profile that claims to be finished and has no resume under it.
  //
  // The timestamp comes off the server clock and never off the payload. The
  // value of this column is that it records when we were told, and a client
  // supplied timestamp records only what a client said.
  //
  // Scoped by the id from `getUser()`, which is checked against the Auth server
  // rather than read out of a cookie. That matters more here than anywhere else
  // in this file: `recordAttestation` writes through the direct Postgres
  // connection `lib/application-quota.ts` and `lib/search-cooldown.ts` already
  // use, which bypasses row level security the same way the service role did,
  // so this id is the whole of what keeps the write on the right row. It is
  // also, in the same statement, the one and only grant of the Free plan's ten
  // applications: see `lib/onboarding/attestation.ts` for why that has to be
  // conditional on `attested_at` still being null rather than something this
  // action decides.
  try {
    await recordAttestation(user.id);
  } catch (error) {
    return {
      ok: false,
      message: `Could not record your confirmation: ${
        error instanceof Error ? error.message : "an unknown error"
      }`,
    };
  }

  // JOB-014. The end of onboarding, and fired only now: every earlier return
  // above is somebody who did not finish, and counting them here would put a
  // step in the funnel that nothing actually completed.
  //
  // `intake` is in scope and holds this person's citizenship status, F1 status,
  // work authorization, sponsorship need, city, country, graduation date and
  // the path to their resume, and since JOB-101 their security clearance
  // eligibility, the clearance level they have held, their visa status, their
  // high school and their home address as well. None of it is sent, and the new
  // ones least of all: a clearance status and a street address are exactly the
  // kind of thing that must not leave for an analytics pipeline. Two facts
  // about the shape of the answers go out, neither of which describes the
  // person: whether a
  // LinkedIn export was attached, and how many locations they named.
  // `lib/analytics/events.ts` records why the work authorization fields in
  // particular are excluded rather than merely omitted.
  await captureServerEvent({
    event: ANALYTICS_EVENT.INTAKE_COMPLETED,
    distinctId: user.id,
    properties: {
      has_linkedin_pdf: Boolean(intake.linkedinPdfPath),
      target_location_count: Array.isArray(intake.targetLocations)
        ? intake.targetLocations.length
        : 0,
    },
  });

  // JOB-112. The resume and the LinkedIn export get parsed once, now, rather
  // than on every application forever. Deliberately last and deliberately not
  // awaited for its result: this person is waiting on a form submit, and two
  // PDFs through an LLM is far too slow to hold that open. Nothing they see
  // next depends on it, and the fill pipeline parses inline anyway when the
  // column is empty, so a failure here costs one slower first application and
  // nothing else. That is why it cannot fail the submit.
  await requestDocumentParse(user.id, String(resumeRow?.id ?? ""));

  revalidatePath("/onboarding");
  return { ok: true };
}
