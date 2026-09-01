"use client";

/**
 * Shared form primitives for the multi-page onboarding steps.
 *
 * Field wraps a label, an input, an optional hint, and an optional error
 * message with consistent spacing. YesNoField is a two-option Select on top
 * of it. Both were duplicated across step 2, step 3 and step 4 before the
 * JOB-308 red team round two extraction.
 *
 * StepFooter is the JOB-314 addition: the Back, Save and finish later, and
 * Next row that steps 1 through 4 now share. See its own comment below for
 * why the save-and-later action lives here rather than being copied into
 * each step.
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
import { Label } from "@/components/ui/label";

import { saveIntakeDraft } from "../actions";

export type YesNo = "yes" | "no" | "";

export function Field({
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

export function YesNoField({
  label,
  htmlFor,
  value,
  onChange,
  error,
  hint,
}: {
  label: string;
  htmlFor?: string;
  value: YesNo;
  onChange: (value: YesNo) => void;
  error?: string;
  hint?: string;
}) {
  return (
    <Field label={label} htmlFor={htmlFor} error={error} hint={hint}>
      <Select value={value} onValueChange={(next) => onChange(next as YesNo)}>
        <SelectTrigger id={htmlFor} className="w-full">
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

export function toBoolean(value: YesNo): boolean | null {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

/**
 * The Back, Save and finish later, and Next row for steps 1 through 4.
 *
 * Closing the tab already worked as a way to pause: step routing sends a
 * returning user back to the earliest step they had not finished, values
 * and all. But nothing on the page told them that, so pausing read as
 * abandoning the form rather than as a supported pause. This button is the
 * explicit version of the same thing.
 *
 * `Save and finish later` deliberately does not go through the step's own
 * `Next` validation. `Next` means "this step is complete, and the schema
 * that gate keeps has to say so"; this button means "whatever is here is
 * worth keeping", which is a different and looser contract on purpose, see
 * the JOB-314 ticket. It calls `saveIntakeDraft` with `{ partial: true }`,
 * which switches the server on to the draft schemas in
 * lib/onboarding/intake-schema.ts that treat every field as optional, so a
 * half filled step is saved rather than rejected. Step 1 has nothing
 * required in its schema either way, so `draftPayload` for that step can
 * pass the same shape through unchanged.
 *
 * `step` and `draftPayload` are supplied by the caller because only the
 * step component knows its own current field values; this component just
 * owns the request, the redirect, and the busy and error state around it.
 */
export function StepFooter({
  step,
  draftPayload,
  backHref,
  busy,
  nextLabel = "Next",
}: {
  step: number;
  draftPayload: Record<string, unknown>;
  backHref?: string;
  busy: boolean;
  nextLabel?: string;
}) {
  const router = useRouter();
  const [savingForLater, setSavingForLater] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const disabled = busy || savingForLater;

  async function handleSaveAndFinishLater() {
    setSavingForLater(true);
    setSaveError(null);

    try {
      const result = await saveIntakeDraft(draftPayload, step, {
        partial: true,
      });

      if (!result.ok) {
        // Step 1's saveIntakeDraft validates against step1Schema even in
        // partial mode (step1Schema already has nothing required, so it
        // has no draft variant), which means a malformed GitHub URL or a
        // resume path naming somebody else's folder comes back as a field
        // level error on `result.errors` rather than a top level
        // `result.message`. Surface the first field error when there is
        // one so a Save and finish later failure on step 1 says what is
        // actually wrong instead of falling through to the generic
        // fallback.
        const firstFieldError = result.errors
          ? Object.values(result.errors)[0]
          : undefined;
        setSaveError(
          firstFieldError ??
            result.message ??
            "Could not save your progress. Try again.",
        );
        setSavingForLater(false);
        return;
      }

      router.push("/");
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Something went wrong.",
      );
      setSavingForLater(false);
    }
  }

  return (
    <div className="space-y-3">
      {saveError ? (
        <p className="text-destructive text-sm" role="alert">
          {saveError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {backHref ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(backHref)}
            disabled={disabled}
          >
            Back
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          onClick={handleSaveAndFinishLater}
          disabled={disabled}
        >
          {savingForLater ? "Saving" : "Save and finish later"}
        </Button>
        <Button type="submit" disabled={disabled} className="sm:ml-auto">
          {busy ? "Saving" : nextLabel}
        </Button>
      </div>
    </div>
  );
}
