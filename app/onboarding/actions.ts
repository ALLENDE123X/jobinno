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
 * That same write is also where the Free plan's three applications get granted,
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
import {
  clearanceLevelIsRelevant,
  deriveNeedsSponsorshipNonUs,
  deriveRequiresSponsorship,
  deriveWorkAuthorizedUs,
  needsSponsorshipNonUsIsRelevant,
} from "@/lib/onboarding/intake-derivation";
import {
  intakeFieldErrors,
  intakeSchema,
  step1Schema,
  step2DraftSchema,
  step2Schema,
  step3DraftSchema,
  step3Schema,
  step4DraftSchema,
  step4Schema,
  step5Schema,
} from "@/lib/onboarding/intake-schema";
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
      // JOB-134. Four more, and the same rule the JOB-101 comment above states:
      // every one of these is read back by `CANDIDATE_COLUMNS` in
      // `lib/candidate-intake.ts` and has a fact in `buildFactCatalog`. They are
      // here because the pipeline had to stop and ask a real person each of
      // them on a real board, and a question answered once here is a question
      // the next user never reaches.
      //
      // `stored_answers` is deliberately not written here. It is the pipeline's
      // record of questions this form did not ask, written with the service
      // role, and `authenticated` holds no grant on it. See
      // `drizzle/0018_profiles_answer_memory_privileges.sql`.
      subject_to_restrictive_covenant: intake.subjectToRestrictiveCovenant,
      relatives_at_target_employers: intake.relativesAtTargetEmployers,
      previously_employed_at_target_employers:
        intake.previouslyEmployedAtTargetEmployers,
      salary_expectation: intake.salaryExpectation,
      // JOB-230. Optional: null when nobody has stated one, exactly like
      // every other column here that a person may leave unanswered.
      // `lib/ashby-direct-submit.ts`'s `candidateValueForField` reads this
      // straight off `CandidateRecord.githubUrl` for any "GitHub Handle"
      // style field instead of skipping it outright.
      github_url: intake.githubUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (profileError) {
    return { ok: false, message: `Could not save your details: ${profileError.message}` };
  }

  // Written after the profile, deliberately. The other order leaves a resume
  // pointing at a profile that never got its answers, which nothing downstream
  // can tell apart from a half filled form.
  //
  // JOB-308 round two: step 1 now inserts the resumes row via saveIntakeDraft
  // so the multi page flow has a real row to key its routing off. When we
  // reach this final submit, that row is already in place, so we look it up
  // by storage_path rather than inserting a duplicate. If nothing matches
  // (a user who somehow reached step 5 without a step 1 insert), we fall
  // back to the original insert. Either way, the id we hand
  // `requestDocumentParse` is a real row this user owns.
  const bucketQualifiedResumePath = `${RESUMES_BUCKET}/${intake.resumePath}`;
  const bucketQualifiedLinkedinPath = intake.linkedinPdfPath
    ? `${RESUMES_BUCKET}/${intake.linkedinPdfPath}`
    : null;

  const { data: existingResume } = await supabase
    .from("resumes")
    .select("id, linkedin_pdf_path")
    .eq("user_id", user.id)
    .eq("storage_path", bucketQualifiedResumePath)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let resumeRow: { id: string } | null = existingResume
    ? { id: existingResume.id }
    : null;

  if (
    existingResume &&
    existingResume.linkedin_pdf_path !== bucketQualifiedLinkedinPath
  ) {
    // The LinkedIn PDF was added or replaced between step 1 and step 5.
    await supabase
      .from("resumes")
      .update({ linkedin_pdf_path: bucketQualifiedLinkedinPath })
      .eq("id", existingResume.id);
  }

  if (!existingResume) {
    const { data: inserted, error: resumeError } = await supabase
      .from("resumes")
      .insert({
        user_id: user.id,
        storage_path: bucketQualifiedResumePath,
        linkedin_pdf_path: bucketQualifiedLinkedinPath,
      })
      .select("id")
      .single();

    if (resumeError) {
      return {
        ok: false,
        message: `Could not save your resume: ${resumeError.message}`,
      };
    }
    resumeRow = inserted;
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
  // also, in the same statement, the one and only grant of the Free plan's three
  // applications: see `lib/onboarding/attestation.ts` for why that has to be
  // conditional on `attested_at` still being null rather than something this
  // action decides.
  try {
    await recordAttestation(user.id);
  } catch (error) {
    // The raw error carries Drizzle's parameterized SQL dump and this person's
    // user id. None of that belongs in a browser (#166), so it goes to the
    // server log and the form gets one plain sentence, the same split
    // `app/dashboard/actions.ts` makes for search failures.
    console.error("[onboarding] recordAttestation failed:", error);
    return {
      ok: false,
      message: "Could not save your details. Please try again in a moment.",
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
  // ones least of all: a clearance status, a street address and, since JOB-134,
  // a salary expectation and whether a non-compete binds them are exactly the
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

// ── Save as you go ────────────────────────────────────────────────────────
// Each step of the multi-page onboarding saves a draft. The final submit
// still goes through submitIntake above, which runs the full schema and
// the attestation stamp. saveIntakeDraft validates only the step's own
// fields, applies any derivations, and upserts into profiles.
//
// Step 1 writes resumes.storage_path directly rather than staging it in
// component or window state, so browser refresh mid-flow does not orphan
// the upload and users can resume where they left off. This also means
// step-routing has a real row to key off (the resumes row is what marks
// step 1 complete). A user who bounces mid-flow leaves a resumes row
// linked to their user_id with no attested profile; this is the same
// state as any pre-intake user, and the existing cleanup pattern handles
// it. See JOB-308 round two BLOCKING 2 for why this had to change.
//
// ── `options.partial`, for Save and finish later (JOB-314) ──────────────────
// The `Next` button calls this with the strict per-step schema, because
// leaving that step means the step's answers are supposed to be complete.
// `Save and finish later` calls it with `partial: true`, which switches to
// the draft schemas in intake-schema.ts (stepNDraftSchema) that treat every
// field as optional and never reject a payload for being incomplete. Step 1
// needs no such switch: step1Schema already has nothing required.
//
// Steps 2 and 3 both need a partial specific branch, and for the same
// reason: their derive functions collapse "not answered yet" into a
// definite value the user never actually gave. deriveWorkAuthorizedUs and
// deriveRequiresSponsorship turn an unanswered question into a hard false
// unconditionally; deriveNeedsSponsorshipNonUs does the same thing whenever
// it is called with a null explicit answer, whether or not the question
// was ever relevant. An earlier version of this comment claimed steps 3
// and 4 "already resolve safely on missing input" and needed no partial
// branch. That was wrong for step 3: `deriveNeedsSponsorshipNonUs([],
// null, null)` returns `false`, and that false was being written to
// `needs_sponsorship_non_us` under the user's name before the user ever
// saw the question, in violation of HARD STOP 9. Fixed below the same way
// step 2 is fixed: the partial branch never calls the derive function.
// It forces null when the question is not relevant yet, and otherwise
// passes the explicit answer straight through, including null for
// "relevant, shown, but not chosen yet".
//
// Step 4's clearanceLevelIsRelevant is the one derivation that genuinely
// is safe on missing input: clearanceLevelIsRelevant(null) evaluates
// `null !== "no"` which is true, so the ternary in the step 4 branch below
// passes clearanceLevelHeld through as null rather than forcing
// "never_held". That is existing, verified behavior and is left
// unchanged.

export async function saveIntakeDraft(
  payload: unknown,
  step: number,
  options: { partial?: boolean } = {},
): Promise<IntakeResult> {
  const partial = options.partial ?? false;
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

  // Validate the step's fields with the appropriate schema.
  let validated: Record<string, unknown>;
  switch (step) {
    case 1: {
      const parsed = step1Schema(user.id).safeParse(payload);
      if (!parsed.success)
        return { ok: false, errors: intakeFieldErrors(parsed.error) };
      validated = parsed.data;
      break;
    }
    case 2: {
      const parsed = (partial ? step2DraftSchema : step2Schema).safeParse(
        payload,
      );
      if (!parsed.success)
        return { ok: false, errors: intakeFieldErrors(parsed.error) };
      validated = parsed.data;
      break;
    }
    case 3: {
      const parsed = (partial ? step3DraftSchema : step3Schema).safeParse(
        payload,
      );
      if (!parsed.success)
        return { ok: false, errors: intakeFieldErrors(parsed.error) };
      validated = parsed.data;
      break;
    }
    case 4: {
      const parsed = (partial ? step4DraftSchema : step4Schema).safeParse(
        payload,
      );
      if (!parsed.success)
        return { ok: false, errors: intakeFieldErrors(parsed.error) };
      validated = parsed.data;
      break;
    }
    case 5: {
      const parsed = step5Schema.safeParse(payload);
      if (!parsed.success)
        return { ok: false, errors: intakeFieldErrors(parsed.error) };
      validated = parsed.data;
      break;
    }
    default:
      return { ok: false, message: "Invalid step." };
  }

  // Build the profile update object from the validated step data,
  // applying derivations where appropriate.
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  switch (step) {
    case 1:
      // Step 1 collects GitHub URL and file paths. githubUrl goes on
      // profiles; resume + LinkedIn PDF paths go into the resumes table
      // below, after the profiles update lands. See file header for why
      // this writes to resumes rather than staging in the browser.
      if ("githubUrl" in validated) {
        update.github_url = validated.githubUrl;
      }
      break;

    case 2:
      update.citizenship_status = validated.citizenshipStatus;
      update.f1_status = validated.f1Status;
      update.visa_status = validated.visaStatus;
      if (partial) {
        // See the "options.partial" header above: a half filled draft may
        // not have a citizenship yet, and deriveWorkAuthorizedUs /
        // deriveRequiresSponsorship both collapse "not answered" to false,
        // which would store a "no" nobody gave. Force true / false only
        // once citizenship is actually known to be US citizen or permanent
        // resident; otherwise pass the explicit answer through as is,
        // including null for "not answered yet".
        // lib/onboarding/intake-derivation.ts's INHERENTLY_AUTHORIZED list
        // is not exported (it is a private module constant), so it cannot
        // be imported directly here without changing that file, which is
        // out of scope for this ticket. deriveWorkAuthorizedUs already
        // encodes the same list: for an inherently authorized citizenship
        // it always returns true no matter what explicit answer is
        // passed in, so calling it here with an explicit answer of null
        // is exactly an "is this citizenship inherently authorized" check,
        // with no second list to keep in sync.
        const citizenship = validated.citizenshipStatus as string | null;
        const inherentlyAuthorized = citizenship
          ? deriveWorkAuthorizedUs(citizenship, null)
          : false;
        update.work_authorized_us = inherentlyAuthorized
          ? true
          : (validated.workAuthorizedUs as boolean | null);
        update.requires_sponsorship = inherentlyAuthorized
          ? false
          : (validated.requiresSponsorship as boolean | null);
      } else {
        // Derive workAuthorizedUs and requiresSponsorship: for US citizens
        // and permanent residents these are forced; for others the explicit
        // answer is used.
        update.work_authorized_us = deriveWorkAuthorizedUs(
          validated.citizenshipStatus as string,
          validated.workAuthorizedUs as boolean | null,
        );
        update.requires_sponsorship = deriveRequiresSponsorship(
          validated.citizenshipStatus as string,
          validated.requiresSponsorship as boolean | null,
        );
      }
      break;

    case 3:
      update.street_address = validated.streetAddress;
      update.current_city = validated.currentCity;
      update.current_country = validated.currentCountry;
      update.postal_code = validated.postalCode;
      update.target_locations = validated.targetLocations;
      update.willing_to_relocate = validated.willingToRelocate;
      update.grad_date = validated.gradDate;
      update.earliest_start = validated.earliestStart;
      if (partial) {
        // See the "options.partial" header above: a half filled draft may
        // have an empty targetLocations and a null willingToRelocate,
        // which means the needsSponsorshipNonUs question was never shown
        // to this user at all. deriveNeedsSponsorshipNonUs would collapse
        // that into a hard false and this save would write "does not need
        // sponsorship outside the US" under the user's name for a
        // question they never answered, which submitIntake later attests
        // and step 5 never displays for correction (HARD STOP 9).
        //
        // Note this cannot simply call deriveNeedsSponsorshipNonUs once
        // the question is known to be relevant either, the way an earlier
        // draft of this fix did: that function itself collapses a null
        // explicit answer to false (`explicitAnswer === true`), which
        // would fabricate a "no" for someone who saved and finished later
        // partway through step 3, after naming a non-US target location
        // but before picking yes or no on this question. So this mirrors
        // step 2's partial branch above exactly: never call the derive
        // function here. Force null when the question is not relevant,
        // and otherwise pass the explicit answer straight through,
        // including null for "not answered yet".
        const targetLocations = (validated.targetLocations as string[]) ?? [];
        const willingToRelocate = validated.willingToRelocate === true;
        const questionShown = needsSponsorshipNonUsIsRelevant(
          targetLocations,
          willingToRelocate,
        );
        update.needs_sponsorship_non_us = questionShown
          ? (validated.needsSponsorshipNonUs as boolean | null)
          : null;
      } else {
        // Derive needsSponsorshipNonUs: forced false when the question is
        // not relevant (no non-US targets and not willing to relocate).
        // Safe here, unlike the partial branch above: the strict Next
        // path requires targetLocations and willingToRelocate to already
        // be real answers to reach this branch at all, so "not relevant"
        // here reflects an answer the user gave, not one they skipped.
        update.needs_sponsorship_non_us = deriveNeedsSponsorshipNonUs(
          validated.targetLocations as string[],
          validated.willingToRelocate as boolean,
          validated.needsSponsorshipNonUs as boolean | null,
        );
      }
      break;

    case 4:
      // JOB-310: step 4's form no longer collects these six, so `validated`
      // now defaults every one of them to null on this path regardless of
      // whether a person answered one already, either here before this
      // change or later through the needs_attestation resolution flow.
      // Writing that null straight through would erase a real answer every
      // time the one remaining field (clearance) gets resaved. A null here
      // means "this draft says nothing about it", not "clear it", so each
      // one is only written when the draft actually carries a value.
      if (validated.salaryExpectation !== null) {
        update.salary_expectation = validated.salaryExpectation;
      }
      if (validated.subjectToRestrictiveCovenant !== null) {
        update.subject_to_restrictive_covenant =
          validated.subjectToRestrictiveCovenant;
      }
      if (validated.relativesAtTargetEmployers !== null) {
        update.relatives_at_target_employers =
          validated.relativesAtTargetEmployers;
      }
      if (validated.previouslyEmployedAtTargetEmployers !== null) {
        update.previously_employed_at_target_employers =
          validated.previouslyEmployedAtTargetEmployers;
      }
      if (validated.highSchoolName !== null) {
        update.high_school_name = validated.highSchoolName;
      }
      if (validated.highSchoolGradYear !== null) {
        update.high_school_grad_year = validated.highSchoolGradYear;
      }
      update.clearance_eligibility = validated.clearanceEligibility;
      // Derive clearanceLevelHeld: forced to "never_held" when clearance
      // eligibility is "no".
      //
      // This is one derivation call shared by both the strict Next path
      // and the partial Save and finish later path, and unlike step 3's
      // needsSponsorshipNonUs above it does not need a separate partial
      // branch. clearanceLevelIsRelevant(clearanceEligibility) is
      // `clearanceEligibility !== "no"`, so on a partial draft where
      // clearanceEligibility has not been answered yet (null),
      // `null !== "no"` evaluates true, the ternary takes the first
      // branch, and clearanceLevelHeld passes through unchanged, which is
      // also null on an unanswered draft. Nothing here forces
      // "never_held" onto a question the user has not reached. CodeRabbit
      // flagged this call as the same pattern as the step 3 bug fixed
      // above; a red team review checked the actual truth table and
      // confirmed this one does not fabricate on partial input, so it is
      // deliberately left unchanged rather than given a partial branch it
      // does not need.
      update.clearance_level_held = clearanceLevelIsRelevant(
        validated.clearanceEligibility as string,
      )
        ? validated.clearanceLevelHeld
        : "never_held";
      break;

    case 5:
      // Step 5 only has attestation, which is not persisted as a draft.
      // Attestation is exclusive to the submitIntake path via
      // recordAttestation. Nothing to write on this step.
      break;
  }

  // Never set attested_at from saveIntakeDraft; that is exclusive to
  // submitIntake via recordAttestation.
  const { error } = await supabase
    .from("profiles")
    .update(update)
    .eq("id", user.id);

  if (error) {
    return {
      ok: false,
      message: `Could not save your details: ${error.message}`,
    };
  }

  // Step 1 also writes the resume + LinkedIn PDF paths into the resumes
  // table. Written after the profiles update, deliberately: the other
  // order leaves a resume pointing at a profile the caller could not
  // update. When a user re-uploads on an edit, the latest row (ordered
  // by created_at desc) becomes their canonical resume; earlier rows
  // stay behind as history.
  if (step === 1) {
    const resumePath = validated.resumePath as string | null;
    const linkedinPdfPath = validated.linkedinPdfPath as string | null;
    if (resumePath) {
      // Bucket qualified, matching the convention `submitIntake` and
      // `lib/candidate-intake.ts` write it under.
      const { error: resumeError } = await supabase.from("resumes").insert({
        user_id: user.id,
        storage_path: `${RESUMES_BUCKET}/${resumePath}`,
        linkedin_pdf_path: linkedinPdfPath
          ? `${RESUMES_BUCKET}/${linkedinPdfPath}`
          : null,
      });
      if (resumeError) {
        return {
          ok: false,
          message: `Could not save your resume: ${resumeError.message}`,
        };
      }
    }
  }

  revalidatePath("/onboarding");
  return { ok: true };
}
