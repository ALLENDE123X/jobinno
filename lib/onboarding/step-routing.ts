/**
 * Server-side routing bouncer for the multi-page onboarding flow.
 *
 * Given a profile row, this tells the router which step the person should
 * land on. The rule is linear: once a step is complete, the user moves on.
 * A user can jump forward via the URL (if prior steps are filled), but the
 * server redirects them back to the earliest incomplete step if they try
 * to skip ahead.
 */

/**
 * The subset of the profiles row that step routing reads. Typed narrowly
 * so the function is testable without a full Supabase client mock.
 */
export type ProfileForRouting = {
  resumePath?: string | null;
  citizenshipStatus?: string | null;
  currentCity?: string | null;
  salaryExpectation?: string | null;
  attestedAt?: string | Date | null;
};

/**
 * Returns the earliest incomplete step (1..5).
 *
 * The progression is linear and sequential:
 *   1 - resume uploaded (resumePath is non-null)
 *   2 - citizenship chosen (citizenshipStatus is non-null)
 *   3 - location filled (currentCity is non-null)
 *   4 - compliance + comp filled (salaryExpectation is non-null)
 *   5 - attestation done (attestedAt is non-null)
 *
 * If everything is complete, returns 6 (caller redirects to /dashboard).
 */
export function earliestIncompleteStep(profile: ProfileForRouting): number {
  if (!profile.resumePath) return 1;
  if (!profile.citizenshipStatus) return 2;
  if (!profile.currentCity) return 3;
  if (!profile.salaryExpectation) return 4;
  if (!profile.attestedAt) return 5;
  return 6;
}
