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
 */

import { redirect } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import {
  earliestIncompleteStep,
  postAuthOnboardingPath,
} from "@/lib/onboarding/step-routing";
import { getPreviewJobs } from "@/lib/onboarding/preview-query";
import { createServerClient } from "@/lib/supabase/server";

import { PreviewView } from "./preview-view";

export default async function OnboardingPreviewPage() {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: profile }, { data: resumeRow }] = await Promise.all([
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

  const step = earliestIncompleteStep(
    {
      citizenshipStatus: profile?.citizenship_status ?? null,
      currentCity: profile?.current_city ?? null,
      clearanceEligibility: profile?.clearance_eligibility ?? null,
      attestedAt: profile?.attested_at ?? null,
    },
    resumeRow ? { storagePath: resumeRow.storage_path ?? null } : null,
  );

  // Step 1 is the only step this preview stands in front of. Anyone who has
  // already uploaded a resume gets sent wherever a fresh visit to
  // /onboarding would have sent them: their real next step, or the
  // dashboard once everything is done.
  if (step !== 1) {
    redirect(postAuthOnboardingPath(step));
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
