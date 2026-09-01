/**
 * JOB-309 — the zero cost preview between signup and step 1.
 *
 * A first real cold traffic signup bounced on the pre-JOB-308 single page
 * intake before ever seeing what the product actually does. The fix here is
 * not a form change: it is showing the agent's real inventory, a few
 * listings it would queue tonight, before asking for a resume at all.
 *
 * ── Who reaches this page ───────────────────────────────────────────────────
 * Only someone who has not started step 1 yet. app/onboarding/page.tsx sends
 * a fresh signup here instead of straight to /onboarding/step/1; anyone
 * further along, attested or not, is bounced onward by the same
 * postAuthOnboardingPath decision that would have sent them here straight
 * from auth. That is what satisfies "an already attested user visiting
 * /onboarding/preview redirects to /dashboard" without a second, duplicate
 * branch in this file: a step 6 profile's postAuthOnboardingPath is always
 * /dashboard, whichever page asks.
 *
 * ── No personalization yet ──────────────────────────────────────────────────
 * Deliberately out of scope. getPreviewJobs returns the same shaped result
 * for anyone at step 1, because there is no resume to have parsed yet.
 * Personalization is the next ticket, once a resume exists to key off.
 *
 * ── JOB-319: both Supabase reads' errors are checked ────────────────────────
 * The routing decision moves through `resolveIntakeStep` so a transient read
 * failure on either query surfaces as a typed error branch instead of
 * silently falling through as a null row. A null row from `.maybeSingle()`
 * used to be indistinguishable from a genuine "no profile yet" or "no
 * resume yet", which for an already-attested visitor would render the
 * preview instead of bouncing them onward. The error branch now redirects
 * to `/login` with a soft error param, matching the pattern the
 * not-authenticated redirect above already sets.
 */

import { redirect } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import {
  postAuthOnboardingPath,
  resolveIntakeStep,
} from "@/lib/onboarding/step-routing";
import { describeSupabaseReadError } from "@/lib/onboarding/log-supabase-error";
import { getPreviewJobs } from "@/lib/onboarding/preview-query";
import { createServerClient } from "@/lib/supabase/server";

import { PreviewView } from "./preview-view";

const LOG = "[job-319-onboarding-preview]";
const READ_FAILED_REASON =
  "Could not load your account right now. Please try again in a moment.";

export default async function OnboardingPreviewPage() {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [
    { data: profile, error: profileError },
    { data: resumeRow, error: resumeError },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("citizenship_status, current_city, clearance_eligibility, attested_at")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("resumes")
      .select("storage_path")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const resolved = resolveIntakeStep(
    { data: profile, error: profileError },
    { data: resumeRow, error: resumeError },
  );

  if (resolved.kind === "error") {
    console.error(
      `${LOG} could not read ${resolved.where} for user ${user.id}: ` +
        describeSupabaseReadError(resolved.error),
    );
    redirect(`/login?error=${encodeURIComponent(READ_FAILED_REASON)}`);
  }

  // Step 1 is the only step this preview stands in front of. Anyone who has
  // already uploaded a resume gets sent wherever a fresh visit to
  // /onboarding would have sent them: their real next step, or the
  // dashboard once everything is done.
  if (resolved.step !== 1) {
    redirect(postAuthOnboardingPath(resolved.step));
  }

  const jobs = await getPreviewJobs(supabase);

  return (
    <PageShell>
      <main className="relative mx-auto w-full max-w-4xl flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <PreviewView jobs={jobs} />
      </main>
    </PageShell>
  );
}
