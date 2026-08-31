/**
 * Server component that routes to the correct step client component.
 *
 * Validates the step param, fetches the profile plus the user's latest
 * resumes row, and computes routing to prevent skipping ahead. Each step
 * component receives the profile data it needs to pre-fill its fields.
 *
 * The resumes row is the source of truth for step 1 completion, and
 * step 5's summary reads the file path from it (there is no resume_path
 * column on profiles). See JOB-308 round two BLOCKING 2.
 */

import { redirect } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { earliestIncompleteStep } from "@/lib/onboarding/step-routing";
import { createServerClient } from "@/lib/supabase/server";

import { OnboardingProgress } from "../../progress";
import { Step1Form } from "../step-1";
import { Step2Form } from "../step-2";
import { Step3Form } from "../step-3";
import { Step4Form } from "../step-4";
import { Step5Form } from "../step-5";

const TOTAL_STEPS = 5;

/**
 * Fields fetched from profiles. Kept narrow: only what the step components
 * need to pre-fill. The full row is not passed to the client.
 */
type ProfileData = {
  resume_path: string | null;
  linkedin_pdf_path: string | null;
  github_url: string | null;
  citizenship_status: string | null;
  f1_status: string | null;
  visa_status: string | null;
  work_authorized_us: boolean | null;
  requires_sponsorship: boolean | null;
  needs_sponsorship_non_us: boolean | null;
  street_address: string | null;
  current_city: string | null;
  current_country: string | null;
  postal_code: string | null;
  target_locations: string[] | null;
  willing_to_relocate: boolean | null;
  grad_date: string | null;
  earliest_start: string | null;
  salary_expectation: string | null;
  subject_to_restrictive_covenant: boolean | null;
  relatives_at_target_employers: boolean | null;
  previously_employed_at_target_employers: boolean | null;
  clearance_eligibility: string | null;
  clearance_level_held: string | null;
  high_school_name: string | null;
  high_school_grad_year: number | null;
  attested_at: string | Date | null;
};

export default async function OnboardingStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ step: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { step: stepParam } = await params;
  const { edit } = await searchParams;
  const step = Number(stepParam);

  if (!Number.isFinite(step) || step < 1 || step > TOTAL_STEPS) {
    redirect("/onboarding/step/1");
  }

  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: profile }, { data: resumeRow }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    supabase
      .from("resumes")
      .select("storage_path, linkedin_pdf_path")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!profile) redirect("/login");

  const incompleteStep = earliestIncompleteStep(
    {
      citizenshipStatus: profile.citizenship_status ?? null,
      currentCity: profile.current_city ?? null,
      clearanceEligibility: profile.clearance_eligibility ?? null,
      attestedAt: profile.attested_at ?? null,
    },
    resumeRow ? { storagePath: resumeRow.storage_path ?? null } : null,
  );

  // If attested and not in edit mode, redirect to dashboard.
  if (incompleteStep === 6 && edit !== "1") redirect("/dashboard");

  // If requested step is ahead of where they are, redirect back,
  // unless the user clicked an edit link (edit=1).
  if (step > incompleteStep && edit !== "1") {
    redirect(`/onboarding/step/${incompleteStep}`);
  }

  // resumes.storage_path is bucket qualified (see submitIntake and
  // saveIntakeDraft). The step components deal in object paths, so strip
  // the leading "resumes/" prefix when passing them down.
  const resumeObjectPath = stripBucketPrefix(resumeRow?.storage_path ?? null);
  const linkedinObjectPath = stripBucketPrefix(
    resumeRow?.linkedin_pdf_path ?? null,
  );

  const profileData: ProfileData = {
    resume_path: resumeObjectPath,
    linkedin_pdf_path: linkedinObjectPath,
    github_url: profile.github_url ?? null,
    citizenship_status: profile.citizenship_status ?? null,
    f1_status: profile.f1_status ?? null,
    visa_status: profile.visa_status ?? null,
    work_authorized_us: profile.work_authorized_us ?? null,
    requires_sponsorship: profile.requires_sponsorship ?? null,
    needs_sponsorship_non_us: profile.needs_sponsorship_non_us ?? null,
    street_address: profile.street_address ?? null,
    current_city: profile.current_city ?? null,
    current_country: profile.current_country ?? null,
    postal_code: profile.postal_code ?? null,
    target_locations: profile.target_locations ?? null,
    willing_to_relocate: profile.willing_to_relocate ?? null,
    grad_date: profile.grad_date ?? null,
    earliest_start: profile.earliest_start ?? null,
    salary_expectation: profile.salary_expectation ?? null,
    subject_to_restrictive_covenant:
      profile.subject_to_restrictive_covenant ?? null,
    relatives_at_target_employers:
      profile.relatives_at_target_employers ?? null,
    previously_employed_at_target_employers:
      profile.previously_employed_at_target_employers ?? null,
    clearance_eligibility: profile.clearance_eligibility ?? null,
    clearance_level_held: profile.clearance_level_held ?? null,
    high_school_name: profile.high_school_name ?? null,
    high_school_grad_year: profile.high_school_grad_year ?? null,
    attested_at: profile.attested_at ?? null,
  };

  return (
    <PageShell>
      <main className="relative mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6 sm:py-16">
        <header className="mb-8 space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Tell us about your search
          </h1>
          <p className="max-w-xl text-base text-pretty text-muted-foreground">
            Jobinno fills real application forms with these answers, so it is
            worth getting them right. It takes about three minutes.
          </p>
        </header>

        <OnboardingProgress currentStep={step} totalSteps={TOTAL_STEPS} />

        {step === 1 && (
          <Step1Form
            userId={user.id}
            profile={profileData}
            isEdit={edit === "1"}
          />
        )}
        {step === 2 && <Step2Form profile={profileData} />}
        {step === 3 && <Step3Form profile={profileData} />}
        {step === 4 && <Step4Form profile={profileData} />}
        {step === 5 && (
          <Step5Form userId={user.id} profile={profileData} />
        )}
      </main>
    </PageShell>
  );
}

function stripBucketPrefix(bucketQualifiedPath: string | null): string | null {
  if (!bucketQualifiedPath) return null;
  const prefix = "resumes/";
  return bucketQualifiedPath.startsWith(prefix)
    ? bucketQualifiedPath.slice(prefix.length)
    : bucketQualifiedPath;
}
