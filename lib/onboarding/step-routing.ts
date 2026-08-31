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
 */

/**
 * The subset of the profiles row that step routing reads. Typed narrowly
 * so the function is testable without a full Supabase client mock.
 */
export type ProfileForRouting = {
  citizenshipStatus?: string | null;
  currentCity?: string | null;
  salaryExpectation?: string | null;
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
 *   4 - compliance and comp filled (salaryExpectation is non-null)
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
  if (!profile.salaryExpectation) return 4;
  if (!profile.attestedAt) return 5;
  return 6;
}
