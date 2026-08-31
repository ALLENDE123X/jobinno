/**
 * Redirect-only server component. Routes to the right onboarding step.
 *
 * Authorization lives here rather than in middleware.ts, next to the thing it
 * protects and where a redirect can say why. Middleware's job is keeping the
 * session fresh; deciding who may see a page is a page's own business.
 */

import { redirect } from "next/navigation";

import { createServerClient } from "@/lib/supabase/server";

import { earliestIncompleteStep } from "@/lib/onboarding/step-routing";

export default async function OnboardingPage() {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "resume_path, citizenship_status, current_city, salary_expectation, attested_at",
    )
    .eq("id", user.id)
    .maybeSingle();

  const step = earliestIncompleteStep({
    resumePath: profile?.resume_path ?? null,
    citizenshipStatus: profile?.citizenship_status ?? null,
    currentCity: profile?.current_city ?? null,
    salaryExpectation: profile?.salary_expectation ?? null,
    attestedAt: profile?.attested_at ?? null,
  });

  if (step === 6) redirect("/dashboard");
  redirect(`/onboarding/step/${step}`);
}
