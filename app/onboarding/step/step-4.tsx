"use client";

/**
 * Step 4: Compliance + compensation.
 *
 * clearanceLevelHeld is shown only when clearanceEligibility is not "no";
 * otherwise it is auto-derived to "never_held".
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CLEARANCE_ELIGIBILITY_OPTIONS,
  CLEARANCE_LEVEL_OPTIONS,
  intakeFieldErrors,
  step4Schema,
} from "@/lib/onboarding/intake-schema";
import { clearanceLevelIsRelevant } from "@/lib/onboarding/intake-derivation";

import { saveIntakeDraft } from "../actions";

type ClearanceValue = (typeof CLEARANCE_ELIGIBILITY_OPTIONS)[number]["value"];
type ClearanceLevelValue = (typeof CLEARANCE_LEVEL_OPTIONS)[number]["value"];
type YesNo = "yes" | "no" | "";

type ProfileData = {
  salary_expectation: string | null;
  subject_to_restrictive_covenant: boolean | null;
  relatives_at_target_employers: boolean | null;
  previously_employed_at_target_employers: boolean | null;
  clearance_eligibility: string | null;
  clearance_level_held: string | null;
  high_school_name: string | null;
  high_school_grad_year: number | null;
};

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function YesNoField({
  label,
  value,
  onChange,
  error,
  hint,
}: {
  label: string;
  value: YesNo;
  onChange: (value: YesNo) => void;
  error?: string;
  hint?: string;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      <Select value={value} onValueChange={(next) => onChange(next as YesNo)}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Choose one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="yes">Yes</SelectItem>
          <SelectItem value="no">No</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}

function toBoolean(value: YesNo): boolean | null {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

export function Step4Form({
  profile,
}: {
  profile: ProfileData;
}) {
  const router = useRouter();
  const [salaryExpectation, setSalaryExpectation] = useState(
    profile.salary_expectation ?? "",
  );
  const [subjectToRestrictiveCovenant, setSubjectToRestrictiveCovenant] =
    useState<YesNo>(
      profile.subject_to_restrictive_covenant === true
        ? "yes"
        : profile.subject_to_restrictive_covenant === false
          ? "no"
          : "",
    );
  const [relativesAtTargetEmployers, setRelativesAtTargetEmployers] =
    useState<YesNo>(
      profile.relatives_at_target_employers === true
        ? "yes"
        : profile.relatives_at_target_employers === false
          ? "no"
          : "",
    );
  const [
    previouslyEmployedAtTargetEmployers,
    setPreviouslyEmployedAtTargetEmployers,
  ] = useState<YesNo>(
    profile.previously_employed_at_target_employers === true
      ? "yes"
      : profile.previously_employed_at_target_employers === false
        ? "no"
        : "",
  );
  const [clearanceEligibility, setClearanceEligibility] = useState<
    ClearanceValue | ""
  >((profile.clearance_eligibility as ClearanceValue) ?? "");
  const [clearanceLevelHeld, setClearanceLevelHeld] = useState<
    ClearanceLevelValue | ""
  >((profile.clearance_level_held as ClearanceLevelValue) ?? "");
  const [highSchoolName, setHighSchoolName] = useState(
    profile.high_school_name ?? "",
  );
  const [highSchoolGradYear, setHighSchoolGradYear] = useState(
    profile.high_school_grad_year?.toString() ?? "",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const showClearanceLevel = clearanceLevelIsRelevant(clearanceEligibility);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setErrors({});

    try {
      const parsedYear = /^\d+$/.test(highSchoolGradYear.trim())
        ? Number(highSchoolGradYear.trim())
        : highSchoolGradYear;

      const payload = {
        salaryExpectation,
        subjectToRestrictiveCovenant: toBoolean(subjectToRestrictiveCovenant),
        relativesAtTargetEmployers: toBoolean(relativesAtTargetEmployers),
        previouslyEmployedAtTargetEmployers: toBoolean(
          previouslyEmployedAtTargetEmployers,
        ),
        clearanceEligibility,
        clearanceLevelHeld: showClearanceLevel
          ? clearanceLevelHeld
          : "never_held",
        highSchoolName,
        highSchoolGradYear: parsedYear,
      };

      const parsed = step4Schema.safeParse(payload);
      if (!parsed.success) {
        setErrors(intakeFieldErrors(parsed.error));
        setBusy(false);
        return;
      }

      const result = await saveIntakeDraft(parsed.data, 4);
      if (result.ok) {
        router.push("/onboarding/step/5");
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

  return (
    <form onSubmit={onSubmit} className="space-y-8" noValidate>
      <section className="space-y-4 rounded-2xl border bg-card/40 p-6 sm:p-8">
        <h2 className="text-lg font-medium">Security clearance</h2>
        <p className="text-muted-foreground text-sm">
          Defence and aerospace employers ask this on every listing, and most of
          them will not let an application through without an answer.
        </p>

        <Field
          label="Do you hold a clearance, or could you get one"
          error={errors.clearanceEligibility}
        >
          <Select
            value={clearanceEligibility}
            onValueChange={(next) =>
              setClearanceEligibility(next as ClearanceValue)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose one" />
            </SelectTrigger>
            <SelectContent>
              {CLEARANCE_ELIGIBILITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {showClearanceLevel ? (
          <Field
            label="The highest clearance you have ever held"
            error={errors.clearanceLevelHeld}
          >
            <Select
              value={clearanceLevelHeld}
              onValueChange={(next) =>
                setClearanceLevelHeld(next as ClearanceLevelValue)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose one" />
              </SelectTrigger>
              <SelectContent>
                {CLEARANCE_LEVEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </section>

      <section className="space-y-4 rounded-2xl border bg-card/40 p-6 sm:p-8">
        <h2 className="text-lg font-medium">Screening questions</h2>
        <p className="text-muted-foreground text-sm">
          Almost every employer asks these somewhere in the application. Answer
          them once here and we will not stop to ask you again.
        </p>

        <YesNoField
          label="Are you under a non compete or non solicitation agreement"
          value={subjectToRestrictiveCovenant}
          onChange={setSubjectToRestrictiveCovenant}
          error={errors.subjectToRestrictiveCovenant}
          hint="This is about an agreement with a previous employer. If you are under one, say yes. We will still come back to you if a form asks for the details."
        />

        <YesNoField
          label="Do you have relatives working at any company you might apply to"
          value={relativesAtTargetEmployers}
          onChange={setRelativesAtTargetEmployers}
          error={errors.relativesAtTargetEmployers}
          hint="Forms ask this about themselves, one company at a time. A no here answers all of them. A yes means we ask you about the specific company when it comes up."
        />

        <YesNoField
          label="Have you ever worked at any company you might apply to"
          value={previouslyEmployedAtTargetEmployers}
          onChange={setPreviouslyEmployedAtTargetEmployers}
          error={errors.previouslyEmployedAtTargetEmployers}
          hint="Same as above. A no answers every version of this question, and a yes means we ask you which company when a form wants to know."
        />

        <Field
          label="What you expect to be paid"
          htmlFor="salary"
          error={errors.salaryExpectation}
          hint="In your own words. A number, a range, or something like negotiable. We never make one up for you."
        >
          <Input
            id="salary"
            value={salaryExpectation}
            onChange={(event) => setSalaryExpectation(event.target.value)}
            placeholder="$120,000, or negotiable"
          />
        </Field>
      </section>

      <section className="space-y-4 rounded-2xl border bg-card/40 p-6 sm:p-8">
        <h2 className="text-lg font-medium">High school</h2>
        <p className="text-muted-foreground text-sm">
          A surprising number of forms ask for this by name, and a resume almost
          never carries it.
        </p>

        <Field
          label="High school name"
          htmlFor="highschool"
          error={errors.highSchoolName}
        >
          <Input
            id="highschool"
            value={highSchoolName}
            onChange={(event) => setHighSchoolName(event.target.value)}
            placeholder="Lincoln High School"
          />
        </Field>

        <Field
          label="Year you graduated high school"
          htmlFor="highschoolyear"
          error={errors.highSchoolGradYear}
        >
          <Input
            id="highschoolyear"
            inputMode="numeric"
            value={highSchoolGradYear}
            onChange={(event) => setHighSchoolGradYear(event.target.value)}
            placeholder="2022"
          />
        </Field>
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
          onClick={() => router.push("/onboarding/step/3")}
        >
          Back
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving" : "Next"}
        </Button>
      </div>
    </form>
  );
}
