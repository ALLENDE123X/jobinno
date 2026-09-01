/**
 * Server-side routing bouncer for the multi-page onboarding flow.
 *
 * Given a profile row and the user's latest resumes row, this tells the
 * router which step the person should land on. The rule is linear: once a
 * step is complete, the user moves on. A user can jump forward via the URL
 * (if prior steps are filled), but the server redirects them back to the
 * earliest incomplete step if they try to skip ahead.
 *
 * Step 1 is complete iff a resumes row exists for the user. `profiles` does
 * not carry a resume_path column, so an earlier version that read it
 * always saw undefined and pinned everyone to step 1 forever, which was
 * the JOB-308 round one BLOCKING 2 finding.
 *
 * Step 4 completion used to be read off `salaryExpectation`, which JOB-310
 * made optional: a person who never states one now has no field left that
 * would ever turn non null, so that signal would pin everyone to step 4
 * forever the same way the resume_path bug once pinned everyone to step 1.
 * `clearanceEligibility` is the one field JOB-310 left required on step 4,
 * so it is the signal now.
 */

/**
 * The subset of the profiles row that step routing reads. Typed narrowly
 * so the function is testable without a full Supabase client mock.
 */
export type ProfileForRouting = {
  citizenshipStatus?: string | null;
  currentCity?: string | null;
  clearanceEligibility?: string | null;
  attestedAt?: string | Date | null;
};

/**
 * The subset of a resumes row that step routing needs. Any non-null row for
 * the user proves step 1 was completed at some point. Storage path shape is
 * validated at insert time by `intakeSchema`, so a row here is trusted.
 */
export type ResumeForRouting = {
  storagePath?: string | null;
} | null;

/**
 * Returns the earliest incomplete step (1..5).
 *
 * The progression is linear and sequential:
 *   1 - resume uploaded (a resumes row exists)
 *   2 - citizenship chosen (citizenshipStatus is non-null)
 *   3 - location filled (currentCity is non-null)
 *   4 - clearance gate answered (clearanceEligibility is non-null)
 *   5 - attestation done (attestedAt is non-null)
 *
 * If everything is complete, returns 6 (caller redirects to /dashboard).
 */
export function earliestIncompleteStep(
  profile: ProfileForRouting,
  resume: ResumeForRouting = null,
): number {
  if (!resume) return 1;
  if (!profile.citizenshipStatus) return 2;
  if (!profile.currentCity) return 3;
  if (!profile.clearanceEligibility) return 4;
  if (!profile.attestedAt) return 5;
  return 6;
}

/**
 * Where a person lands once earliestIncompleteStep has been computed for
 * them, immediately after auth and on every later visit to /onboarding or
 * /onboarding/preview (JOB-309).
 *
 * The preview page is not one of the five onboarding steps and is
 * deliberately not folded into earliestIncompleteStep above: it is a pre
 * step landing page, shown only to someone who has not started step 1 yet.
 * Once a resumes row exists, earliestIncompleteStep never returns 1 again
 * for that person, so this function naturally stops sending them back to
 * it, without a second stored flag anywhere.
 */
export function postAuthOnboardingPath(step: number): string {
  if (step === 1) return "/onboarding/preview";
  if (step === 6) return "/dashboard";
  return `/onboarding/step/${step}`;
}

/**
 * JOB-319. The Supabase read shape both `app/onboarding/page.tsx` and
 * `app/onboarding/preview/page.tsx` see from a single-row `.maybeSingle()`
 * call: either a row and no error, or a null row and an error, or a null
 * row and no error (the row genuinely does not exist yet).
 *
 * Typed as `unknown` for the error so the helper does not have to pull the
 * `PostgrestError` type in, since the two pages already pass whatever
 * supabase-js hands back.
 */
export type IntakeReadResult<T> = {
  data: T | null;
  error: unknown | null;
};

export type IntakeProfileRow = {
  citizenship_status?: string | null;
  current_city?: string | null;
  clearance_eligibility?: string | null;
  attested_at?: string | Date | null;
};

export type IntakeResumeRow = {
  storage_path?: string | null;
};

/**
 * JOB-319. Turns the pair of `.maybeSingle()` reads the onboarding router
 * needs into either an error branch or a step branch, so a Supabase read
 * that failed transiently cannot be silently treated as "no row" and
 * misroute a user.
 *
 * Before this helper, both `app/onboarding/page.tsx` and
 * `app/onboarding/preview/page.tsx` destructured `data` off the pair and
 * dropped the `error` field, so a transient PostgREST error came through as
 * `null` and `earliestIncompleteStep` interpreted that as "profile not
 * filled in yet". For an already-attested user, that silently sent them
 * back into onboarding; for a mid-flow user, it bounced them to an earlier
 * step than they had actually reached.
 *
 * The kind: "error" branch carries the underlying error so the caller can
 * log it (with whatever user identifiers belong on the log line, per
 * JOB-311's `redactEmail`), and names which of the two reads failed so the
 * log points at the right query.
 */
export type ResolveIntakeStepResult =
  | { kind: "error"; where: "profile" | "resume"; error: unknown }
  | { kind: "step"; step: number };

export function resolveIntakeStep(
  profileRead: IntakeReadResult<IntakeProfileRow>,
  resumeRead: IntakeReadResult<IntakeResumeRow>,
): ResolveIntakeStepResult {
  if (profileRead.error) {
    return { kind: "error", where: "profile", error: profileRead.error };
  }
  if (resumeRead.error) {
    return { kind: "error", where: "resume", error: resumeRead.error };
  }

  const profile = profileRead.data;
  const resume = resumeRead.data;

  const step = earliestIncompleteStep(
    {
      citizenshipStatus: profile?.citizenship_status ?? null,
      currentCity: profile?.current_city ?? null,
      clearanceEligibility: profile?.clearance_eligibility ?? null,
      attestedAt: profile?.attested_at ?? null,
    },
    resume ? { storagePath: resume.storage_path ?? null } : null,
  );

  return { kind: "step", step };
}
