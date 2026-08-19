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
 * Everything below is something the person is allowed to do to their own rows,
 * so row level security is left switched on to enforce that rather than
 * bypassed and rebuilt here by hand. The two storage paths are the exception
 * worth naming: they are strings the client chose, so `intakeSchema` is built
 * with the session's user id and rejects a path naming anyone else's folder.
 */

import { revalidatePath } from "next/cache";

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
      // Stamped from the server clock, not from anything the client sent. The
      // whole value of this column is that it records when we were actually
      // told, and a client supplied timestamp records only what a client said.
      attested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (profileError) {
    return { ok: false, message: `Could not save your details: ${profileError.message}` };
  }

  // Written after the profile, deliberately. If this fails the person has a
  // profile and no resume row, which the onboarding page can see and ask them
  // to fix. The other order leaves a resume pointing at a profile that never
  // got its answers, which nothing downstream can tell apart from a half filled
  // form.
  const { error: resumeError } = await supabase.from("resumes").insert({
    user_id: user.id,
    // Bucket qualified, matching the convention `lib/candidate-intake.ts` uses
    // for `candidates.resume_url`: a path to sign a URL from, never a URL.
    storage_path: `${RESUMES_BUCKET}/${intake.resumePath}`,
    linkedin_pdf_path: intake.linkedinPdfPath
      ? `${RESUMES_BUCKET}/${intake.linkedinPdfPath}`
      : null,
  });

  if (resumeError) {
    return { ok: false, message: `Could not save your resume: ${resumeError.message}` };
  }

  revalidatePath("/onboarding");
  return { ok: true };
}
