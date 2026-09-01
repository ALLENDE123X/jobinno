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
 *
 * JOB-319: both Supabase reads' `error` fields are checked before the
 * routing decision runs. A transient read failure used to fall through
 * `.maybeSingle()` as a null row, which `earliestIncompleteStep` read as
 * "profile not filled in yet" and silently bounced an attested user back
 * into onboarding. The routing decision now moves through
 * `resolveIntakeStep`, which surfaces a Supabase error as a typed branch,
 * and this page logs it and redirects to `/login` with a soft error param
 * rather than misrouting.
 */

import { redirect } from "next/navigation";

import { createServerClient } from "@/lib/supabase/server";

import {
  postAuthOnboardingPath,
  resolveIntakeStep,
} from "@/lib/onboarding/step-routing";
import { describeSupabaseReadError } from "@/lib/onboarding/log-supabase-error";

const LOG = "[job-319-onboarding-page]";
const READ_FAILED_REASON =
  "Could not load your account right now. Please try again in a moment.";

export default async function OnboardingPage() {
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

  redirect(postAuthOnboardingPath(resolved.step));
}
