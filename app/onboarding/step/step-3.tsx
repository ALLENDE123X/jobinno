"use client";

/**
 * Step 3: Location + timing.
 *
 * needsSponsorshipNonUs is shown only when targetLocations includes a
 * non-US location or willingToRelocate is true; otherwise it is auto-derived
 * to false.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import {
  intakeFieldErrors,
  step3Schema,
} from "@/lib/onboarding/intake-schema";
import { needsSponsorshipNonUsIsRelevant } from "@/lib/onboarding/intake-derivation";

import { saveIntakeDraft } from "../actions";
import { Field, StepFooter, YesNoField, toBoolean, type YesNo } from "./_shared";

type ProfileData = {
  street_address: string | null;
  current_city: string | null;
  current_country: string | null;
  postal_code: string | null;
  target_locations: string[] | null;
  willing_to_relocate: boolean | null;
  needs_sponsorship_non_us: boolean | null;
  grad_date: string | null;
  earliest_start: string | null;
};

export function Step3Form({
  profile,
}: {
  profile: ProfileData;
}) {
  const router = useRouter();
  const [streetAddress, setStreetAddress] = useState(
    profile.street_address ?? "",
  );
  const [currentCity, setCurrentCity] = useState(profile.current_city ?? "");
  const [postalCode, setPostalCode] = useState(profile.postal_code ?? "");
  const [currentCountry, setCurrentCountry] = useState(
    profile.current_country ?? "United States",
  );
  const [willingToRelocate, setWillingToRelocate] = useState<YesNo>(
    profile.willing_to_relocate === true
      ? "yes"
      : profile.willing_to_relocate === false
        ? "no"
        : "",
  );
  const [targetLocations, setTargetLocations] = useState(
    profile.target_locations?.join(", ") ?? "",
  );
  const [needsSponsorshipNonUs, setNeedsSponsorshipNonUs] = useState<YesNo>(
    profile.needs_sponsorship_non_us === true
      ? "yes"
      : profile.needs_sponsorship_non_us === false
        ? "no"
        : "",
  );
  const [gradDate, setGradDate] = useState(profile.grad_date ?? "");
  const [earliestStart, setEarliestStart] = useState(
    profile.earliest_start ?? "",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsedTargets = targetLocations
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const showSponsorshipNonUs = needsSponsorshipNonUsIsRelevant(
    parsedTargets,
    toBoolean(willingToRelocate) === true,
  );

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setErrors({});

    try {
      const payload = {
        streetAddress,
        currentCity,
        postalCode,
        currentCountry,
        targetLocations: parsedTargets,
        willingToRelocate: toBoolean(willingToRelocate),
        needsSponsorshipNonUs: showSponsorshipNonUs
          ? toBoolean(needsSponsorshipNonUs)
          : false,
        gradDate,
        earliestStart,
      };

      const parsed = step3Schema.safeParse(payload);
      if (!parsed.success) {
        setErrors(intakeFieldErrors(parsed.error));
        setBusy(false);
        return;
      }

      const result = await saveIntakeDraft(parsed.data, 3);
      if (result.ok) {
        router.push("/onboarding/step/4");
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
        <h2 className="text-lg font-medium">
          Where you are and where you want to be
        </h2>

        <Field
          label="Street address"
          htmlFor="street"
          error={errors.streetAddress}
          hint="Application forms ask for a postal address far more often than you would expect, and a blank one stops the whole application."
        >
          <Input
            id="street"
            value={streetAddress}
            onChange={(event) => setStreetAddress(event.target.value)}
            placeholder="123 Peachtree Street NE, Apt 4"
            autoComplete="street-address"
          />
        </Field>

        <Field label="Current city" htmlFor="city" error={errors.currentCity}>
          <Input
            id="city"
            value={currentCity}
            onChange={(event) => setCurrentCity(event.target.value)}
            placeholder="Atlanta"
            autoComplete="address-level2"
          />
        </Field>

        <Field
          label="Postal code"
          htmlFor="postal"
          error={errors.postalCode}
        >
          <Input
            id="postal"
            value={postalCode}
            onChange={(event) => setPostalCode(event.target.value)}
            placeholder="30308"
            autoComplete="postal-code"
          />
        </Field>

        <Field
          label="Current country"
          htmlFor="country"
          error={errors.currentCountry}
        >
          <Input
            id="country"
            value={currentCountry}
            onChange={(event) => setCurrentCountry(event.target.value)}
          />
        </Field>

        <Field
          label="Places you want to work"
          htmlFor="targets"
          error={errors.targetLocations}
          hint="Separate them with commas. Cities, states, or Remote."
        >
          <Input
            id="targets"
            value={targetLocations}
            onChange={(event) => setTargetLocations(event.target.value)}
            placeholder="San Francisco, New York, Remote"
          />
        </Field>

        <YesNoField
          label="Would you relocate for the right role"
          htmlFor="willing-to-relocate"
          value={willingToRelocate}
          onChange={setWillingToRelocate}
          error={errors.willingToRelocate}
        />

        {showSponsorshipNonUs ? (
          <YesNoField
            label="Outside the US, would you need sponsorship to work"
            htmlFor="needs-sponsorship-non-us"
            value={needsSponsorshipNonUs}
            onChange={setNeedsSponsorshipNonUs}
            error={errors.needsSponsorshipNonUs}
            hint="Forms in the UK, Ireland and elsewhere ask their own version of the question above, and a US answer is not an answer to it."
          />
        ) : null}
      </section>

      <section className="space-y-4 rounded-2xl border bg-card/40 p-6 sm:p-8">
        <h2 className="text-lg font-medium">Dates</h2>

        <Field
          label="Graduation date"
          htmlFor="grad"
          error={errors.gradDate}
          hint="If it is not settled, use the date on your current plan."
        >
          <Input
            id="grad"
            type="date"
            value={gradDate}
            onChange={(event) => setGradDate(event.target.value)}
          />
        </Field>

        <Field
          label="Earliest date you could start"
          htmlFor="start"
          error={errors.earliestStart}
        >
          <Input
            id="start"
            type="date"
            value={earliestStart}
            onChange={(event) => setEarliestStart(event.target.value)}
          />
        </Field>
      </section>

      {message ? (
        <p className="text-destructive text-sm" role="alert">
          {message}
        </p>
      ) : null}

      <StepFooter
        step={3}
        backHref="/onboarding/step/2"
        busy={busy}
        draftPayload={{
          streetAddress,
          currentCity,
          postalCode,
          currentCountry,
          targetLocations: parsedTargets,
          willingToRelocate: toBoolean(willingToRelocate),
          needsSponsorshipNonUs: showSponsorshipNonUs
            ? toBoolean(needsSponsorshipNonUs)
            : null,
          gradDate,
          earliestStart,
        }}
      />
    </form>
  );
}
