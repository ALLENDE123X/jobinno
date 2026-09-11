"use client";

/**
 * Step 5: Attest + submit.
 *
 * Read-only summary of all prior steps with edit links, the attestation
 * checkbox, and the final submit button. This step calls submitIntake
 * (the full-submit action), NOT saveIntakeDraft.
 *
 * File paths (resume, LinkedIn) come from the resumes-table lookup in
 * the server component that renders this step, so a browser refresh at
 * step 5 does not lose them. See JOB-308 round two BLOCKING 2.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  CITIZENSHIP_OPTIONS,
  CLEARANCE_ELIGIBILITY_OPTIONS,
  CLEARANCE_LEVEL_OPTIONS,
  F1_STATUS_OPTIONS,
  intakeFieldErrors,
  intakeSchema,
} from "@/lib/onboarding/intake-schema";

import { submitIntake } from "../actions";
import { StoredAnswersPreview } from "./stored-answers-preview";

type ProfileData = {
  email: string | null;
  github_url: string | null;
  resume_path: string | null;
  linkedin_pdf_path: string | null;
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
};

function labelFromOptions(
  options: readonly { value: string; label: string }[],
  value: string | null,
): string {
  if (!value) return "Not provided";
  return options.find((o) => o.value === value)?.label ?? value;
}

function formatYesNo(value: boolean | null): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Not provided";
}

function SummarySection({
  title,
  editStep,
  children,
}: {
  title: string;
  editStep: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-2xl border bg-card/40 p-6 sm:p-8">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{title}</h2>
        <Link
          href={`/onboarding/step/${editStep}?edit=1`}
          className="text-primary text-sm underline-offset-4 hover:underline"
        >
          Edit
        </Link>
      </div>
      <dl className="space-y-2 text-sm">{children}</dl>
    </section>
  );
}

/**
 * `muted` is JOB-361's marker for a row that names an optional field the
 * person skipped: street_address and postal_code no longer gate this step,
 * so "Not provided" here means "left for the runtime pipeline to ask about",
 * not "something is wrong". Grayed out rather than dropped entirely, so
 * editing this step still shows the person the field exists.
 */
function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd
        className={
          muted
            ? "text-muted-foreground text-right font-normal"
            : "text-right font-medium"
        }
      >
        {value}
      </dd>
    </div>
  );
}

export function Step5Form({
  userId,
  profile,
}: {
  userId: string;
  profile: ProfileData;
}) {
  const router = useRouter();
  const [attestation, setAttestation] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setErrors({});

    try {
      // resume_path and linkedin_pdf_path come from the server component
      // that renders this step; it reads the user's latest resumes row
      // and strips the bucket prefix. See app/onboarding/step/[step]/page.tsx.
      const resumePath = profile.resume_path;
      const linkedinPdfPath = profile.linkedin_pdf_path;

      const payload = {
        citizenshipStatus: profile.citizenship_status,
        f1Status: profile.f1_status,
        workAuthorizedUs: profile.work_authorized_us,
        requiresSponsorship: profile.requires_sponsorship,
        needsSponsorshipNonUs: profile.needs_sponsorship_non_us,
        visaStatus: profile.visa_status,
        clearanceEligibility: profile.clearance_eligibility,
        clearanceLevelHeld: profile.clearance_level_held,
        streetAddress: profile.street_address,
        currentCity: profile.current_city,
        postalCode: profile.postal_code,
        currentCountry: profile.current_country,
        willingToRelocate: profile.willing_to_relocate,
        targetLocations: profile.target_locations ?? [],
        gradDate: profile.grad_date,
        earliestStart: profile.earliest_start,
        highSchoolName: profile.high_school_name,
        highSchoolGradYear: profile.high_school_grad_year,
        subjectToRestrictiveCovenant: profile.subject_to_restrictive_covenant,
        relativesAtTargetEmployers: profile.relatives_at_target_employers,
        previouslyEmployedAtTargetEmployers:
          profile.previously_employed_at_target_employers,
        salaryExpectation: profile.salary_expectation,
        githubUrl: profile.github_url,
        resumePath,
        linkedinPdfPath,
        attestation,
      };

      const parsed = intakeSchema(userId).safeParse(payload);
      if (!parsed.success) {
        setErrors(intakeFieldErrors(parsed.error));
        setBusy(false);
        return;
      }

      const result = await submitIntake(parsed.data);
      if (result.ok) {
        setDone(true);
        router.push("/dashboard");
        return;
      }

      if (result.errors) setErrors(result.errors);
      if (result.message) setMessage(result.message);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div
        className="space-y-3 rounded-2xl border bg-card/40 p-6 text-center sm:p-8"
        role="status"
      >
        <p className="text-lg font-medium">Thanks, that is everything.</p>
        <p className="text-muted-foreground text-sm">
          Your first applications are queued. They will appear on your
          dashboard as they go out, usually within a few minutes.
        </p>
        <Button asChild size="lg" className="h-10">
          <Link href="/dashboard">Go to your applications</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8" noValidate>
      <SummarySection title="Your documents" editStep={1}>
        <Row
          label="Resume"
          value={profile.resume_path ? "Uploaded" : "Not uploaded"}
        />
        <Row
          label="LinkedIn"
          value={profile.linkedin_pdf_path ? "Uploaded" : "Not provided"}
        />
        <Row label="GitHub" value={profile.github_url ?? "Not provided"} />
      </SummarySection>

      <SummarySection title="Work authorization" editStep={2}>
        <Row
          label="Citizenship"
          value={labelFromOptions(CITIZENSHIP_OPTIONS, profile.citizenship_status)}
        />
        {profile.citizenship_status === "f1" ? (
          <Row
            label="F1 status"
            value={labelFromOptions(F1_STATUS_OPTIONS, profile.f1_status)}
          />
        ) : null}
        <Row
          label="Visa status"
          value={profile.visa_status ?? "Not provided"}
        />
      </SummarySection>

      <SummarySection title="Location and timing" editStep={3}>
        <Row
          label="Address"
          value={
            [profile.street_address, profile.postal_code]
              .filter(Boolean)
              .join(", ") || "Not provided"
          }
          muted={!profile.street_address && !profile.postal_code}
        />
        <Row
          label="City"
          value={
            [profile.current_city, profile.current_country]
              .filter(Boolean)
              .join(", ") || "Not provided"
          }
        />
        <Row
          label="Target locations"
          value={profile.target_locations?.join(", ") ?? "Not provided"}
        />
        <Row
          label="Willing to relocate"
          value={formatYesNo(profile.willing_to_relocate)}
        />
        <Row label="Graduation date" value={profile.grad_date ?? "Not provided"} />
        <Row
          label="Earliest start"
          value={profile.earliest_start ?? "Not provided"}
        />
      </SummarySection>

      <SummarySection title="Compliance and compensation" editStep={4}>
        <Row
          label="Clearance"
          value={labelFromOptions(
            CLEARANCE_ELIGIBILITY_OPTIONS,
            profile.clearance_eligibility,
          )}
        />
        {profile.clearance_eligibility !== "no" ? (
          <Row
            label="Clearance level"
            value={labelFromOptions(
              CLEARANCE_LEVEL_OPTIONS,
              profile.clearance_level_held,
            )}
          />
        ) : null}
        <Row
          label="Non compete"
          value={formatYesNo(profile.subject_to_restrictive_covenant)}
        />
        <Row
          label="Relatives at target employers"
          value={formatYesNo(profile.relatives_at_target_employers)}
        />
        <Row
          label="Previously employed at target employers"
          value={formatYesNo(profile.previously_employed_at_target_employers)}
        />
        <Row
          label="Salary expectation"
          value={profile.salary_expectation ?? "Not provided"}
        />
        <Row
          label="High school"
          value={
            [profile.high_school_name, profile.high_school_grad_year]
              .filter(Boolean)
              .join(", ") || "Not provided"
          }
        />
      </SummarySection>

      <StoredAnswersPreview
        profile={{
          email: profile.email,
          github_url: profile.github_url,
          current_city: profile.current_city,
          visa_status: profile.visa_status,
          salary_expectation: profile.salary_expectation,
          work_authorized_us: profile.work_authorized_us,
          requires_sponsorship: profile.requires_sponsorship,
        }}
      />

      <section className="space-y-3 rounded-2xl border bg-card/40 p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <Checkbox
            id="attestation"
            checked={attestation}
            onCheckedChange={(checked) => setAttestation(checked === true)}
          />
          <Label
            htmlFor="attestation"
            className="text-sm leading-relaxed font-normal"
          >
            Everything above is accurate, and I authorize Jobinno to submit job
            applications on my behalf using it.
          </Label>
        </div>
        {errors.attestation ? (
          <p className="text-destructive text-sm" role="alert">
            {errors.attestation}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          Every answer we write on a form comes from what you entered here.
          Nothing gets invented to fill a blank, so if a question cannot be
          answered from your details we stop and ask you rather than guess.
        </p>
      </section>

      {message ? (
        <p className="text-destructive text-sm" role="alert">
          {message}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push("/onboarding/step/4")}
        >
          Back
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving" : "Start applying"}
        </Button>
      </div>
    </form>
  );
}
