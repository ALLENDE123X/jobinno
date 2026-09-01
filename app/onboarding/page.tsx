/**
 * Redirect-only server component. Routes to the right onboarding step.
 *
 * This is the actual post-auth landing decision for a signed in user:
 * app/auth/callback/route.ts sends everyone here by default once a session
 * exists, and this page is what decides where they go from there.
 *
 * Authorization lives here rather than in middleware.ts, next to the thing it
 * protects and where a redirect can say why. Middleware's job is keeping the
 * session fresh; deciding who may see a page is a page's own business.
 *
 * Step 1 completion is keyed off a resumes row rather than a profiles
 * column, because there is no resume_path on profiles. See JOB-308 round
 * two BLOCKING 2 for why this had to change.
 *
 * JOB-309: a person who has not started step 1 is sent to
 * /onboarding/preview instead of straight to /onboarding/step/1, so they see
 * the agent's real inventory before it asks for a resume. See
 * postAuthOnboardingPath in lib/onboarding/step-routing.ts for the rest of
 * that routing decision.
 */

import { redirect } from "next/navigation";

import { createServerClient } from "@/lib/supabase/server";

import {
  earliestIncompleteStep,
  postAuthOnboardingPath,
} from "@/lib/onboarding/step-routing";

export default async function OnboardingPage() {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: profile }, { data: resumeRow }] = await Promise.all([
    supabase
      .from("profiles")
      .select("citizenship_status, current_city, salary_expectation, attested_at")
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
      salaryExpectation: profile?.salary_expectation ?? null,
      attestedAt: profile?.attested_at ?? null,
    },
    resumeRow ? { storagePath: resumeRow.storage_path ?? null } : null,
  );

  redirect(postAuthOnboardingPath(step));
}
