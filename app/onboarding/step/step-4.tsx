"use client";

/**
 * Step 4: Security clearance.
 *
 * JOB-310. This step used to ask seven questions: clearance eligibility,
 * non compete, relatives at a target employer, previous employment at a
 * target employer, salary expectation, and high school name and year. A one
 * person diagnosis found the whole of step two through four behind a 100%
 * pre attestation drop off, and of the seven only clearance eligibility
 * genuinely has to be known before a search can start, because a required
 * clearance question with no way to decline is one of the few things that
 * stops a run outright. The other six now go unasked here and are answered
 * once, the first time a real employer's form actually asks, through the
 * `needs_attestation` path in `lib/fill-application-form.ts`. See
 * `lib/onboarding/intake-schema.ts` for why loosening the requirement there
 * needed no change on that side.
 *
 * clearanceLevelHeld is shown only when clearanceEligibility is not "no";
 * otherwise it is auto-derived to "never_held".
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
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
import { Field } from "./_shared";

type ClearanceValue = (typeof CLEARANCE_ELIGIBILITY_OPTIONS)[number]["value"];
type ClearanceLevelValue = (typeof CLEARANCE_LEVEL_OPTIONS)[number]["value"];

type ProfileData = {
  clearance_eligibility: string | null;
  clearance_level_held: string | null;
};

export function Step4Form({
  profile,
}: {
  profile: ProfileData;
}) {
  const router = useRouter();
  const [clearanceEligibility, setClearanceEligibility] = useState<
    ClearanceValue | ""
  >((profile.clearance_eligibility as ClearanceValue) ?? "");
  const [clearanceLevelHeld, setClearanceLevelHeld] = useState<
    ClearanceLevelValue | ""
  >((profile.clearance_level_held as ClearanceLevelValue) ?? "");
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
      const payload = {
        clearanceEligibility,
        clearanceLevelHeld: showClearanceLevel
          ? clearanceLevelHeld
          : "never_held",
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
          them will not let an application through without an answer. Everything
          else a form might ask, we will ask you the first time a real listing
          needs it, so this is the only question here.
        </p>

        <Field
          label="Do you hold a clearance, or could you get one"
          htmlFor="clearance-eligibility"
          error={errors.clearanceEligibility}
        >
          <Select
            value={clearanceEligibility}
            onValueChange={(next) =>
              setClearanceEligibility(next as ClearanceValue)
            }
          >
            <SelectTrigger id="clearance-eligibility" className="w-full">
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
            htmlFor="clearance-level"
            error={errors.clearanceLevelHeld}
          >
            <Select
              value={clearanceLevelHeld}
              onValueChange={(next) =>
                setClearanceLevelHeld(next as ClearanceLevelValue)
              }
            >
              <SelectTrigger id="clearance-level" className="w-full">
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
