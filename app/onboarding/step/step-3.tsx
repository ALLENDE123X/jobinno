"use client";

/**
 * Step 3: Location + timing.
 *
 * needsSponsorshipNonUs is shown only when targetLocations includes a
 * non-US location or willingToRelocate is true; otherwise it is auto-derived
 * to false.
 *
 * ── JOB-361: defaults already filled in for four of the five fields that
 * used to gate this step outright ──────────────────────────────────────────
 *
 * streetAddress and postalCode are now optional (see the two Field hints
 * below). currentCountry, willingToRelocate and earliestStart stay required
 * in shape, the same as before, but this component fills each of them in
 * with a real value ahead of time so most people never have to type one:
 *
 *   currentCountry starts as "United States" once citizenship is known to be
 *   us_citizen, via defaultCurrentCountry. Anyone else sees a blank field and
 *   still has to answer it.
 *
 *   willingToRelocate flips to "yes" the moment a target location is picked,
 *   via handleTargetLocationsChange, unless the person already gave an
 *   explicit yes or no (willingToRelocateTouched), in which case that answer
 *   is never overwritten.
 *
 *   earliestStart recomputes to gradDate plus 30 days on every grad date
 *   change, via handleGradDateChange, unless the person already typed their
 *   own earliest start (earliestStartTouched).
 *
 * step3Schema in lib/onboarding/intake-schema.ts derives the same three
 * defaults again, server side, so a payload that reaches saveIntakeDraft
 * with one of them still blank is not rejected for it.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { LocationPicker } from "@/components/onboarding/location-picker";
import {
  defaultCurrentCountry,
  defaultEarliestStart,
  defaultWillingToRelocate,
  intakeFieldErrors,
  step3Schema,
} from "@/lib/onboarding/intake-schema";
import { needsSponsorshipNonUsIsRelevant } from "@/lib/onboarding/intake-derivation";

import { saveIntakeDraft } from "../actions";
import { Field, StepFooter, YesNoField, toBoolean, type YesNo } from "./_shared";

type ProfileData = {
  citizenship_status: string | null;
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
    profile.current_country ??
      defaultCurrentCountry(profile.citizenship_status) ??
      "",
  );
  const initialTargetLocations = profile.target_locations ?? [];
  const [willingToRelocate, setWillingToRelocate] = useState<YesNo>(
    profile.willing_to_relocate === true
      ? "yes"
      : profile.willing_to_relocate === false
        ? "no"
        : defaultWillingToRelocate(initialTargetLocations) === true
          ? "yes"
          : "",
  );
  // Tracks whether the person has given their own yes or no, as opposed to
  // seeing the default handleTargetLocationsChange filled in below. Starts
  // true whenever the profile already carries an explicit answer, so a
  // returning user's own "no" is never quietly flipped back to "yes" by
  // picking one more target location.
  const [willingToRelocateTouched, setWillingToRelocateTouched] = useState(
    profile.willing_to_relocate !== null,
  );
  const [targetLocations, setTargetLocations] = useState<string[]>(
    initialTargetLocations,
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
    profile.earliest_start ??
      (profile.grad_date ? defaultEarliestStart(profile.grad_date) : ""),
  );
  // Same idea as willingToRelocateTouched: once the person has typed their
  // own earliest start, handleGradDateChange below stops recomputing it.
  const [earliestStartTouched, setEarliestStartTouched] = useState(
    profile.earliest_start !== null,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const showSponsorshipNonUs = needsSponsorshipNonUsIsRelevant(
    targetLocations,
    toBoolean(willingToRelocate) === true,
  );

  function handleTargetLocationsChange(next: string[]) {
    setTargetLocations(next);
    if (!willingToRelocateTouched) {
      setWillingToRelocate(
        defaultWillingToRelocate(next) === true ? "yes" : "",
      );
    }
  }

  function handleWillingToRelocateChange(next: YesNo) {
    setWillingToRelocate(next);
    setWillingToRelocateTouched(true);
  }

  function handleGradDateChange(next: string) {
    setGradDate(next);
    if (!earliestStartTouched) {
      setEarliestStart(next ? defaultEarliestStart(next) : "");
    }
  }

  function handleEarliestStartChange(next: string) {
    setEarliestStart(next);
    setEarliestStartTouched(true);
  }

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
        // Rides along so step3Schema's currentCountry default has
        // something to check; step 2 already owns this column and this
        // step never writes it. See the intake-schema.ts header comment.
        citizenshipStatus: profile.citizenship_status,
        targetLocations,
        willingToRelocate: toBoolean(willingToRelocate),
        // false, not null, on this path: onSubmit only runs from the
        // strict Next button, which means step3Schema is about to require
        // every field including this one. The question was either shown
        // (showSponsorshipNonUs true, so the user's own yes or no goes on
        // the payload) or genuinely not relevant to what they already
        // answered (targetLocations and willingToRelocate are both real
        // answers at this point, not drafts), so false here is a value
        // the user's other answers already imply, not a fabrication. Do
        // not change this to null to match draftPayload below; that would
        // make a complete step fail step3Schema's required boolean check.
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
          label="Street address, optional"
          htmlFor="street"
          error={errors.streetAddress}
          hint="Some boards ask for this and some do not. We will ask when an application needs it, so it is fine to leave this blank for now."
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
          label="Postal code, optional"
          htmlFor="postal"
          error={errors.postalCode}
          hint="Some boards ask for this and some do not. We will ask when an application needs it, so it is fine to leave this blank for now."
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
          hint="Search a city or pick Remote, or type your own and press enter."
        >
          <LocationPicker
            id="targets"
            value={targetLocations}
            onChange={handleTargetLocationsChange}
          />
        </Field>

        <YesNoField
          label="Would you relocate for the right role"
          htmlFor="willing-to-relocate"
          value={willingToRelocate}
          onChange={handleWillingToRelocateChange}
          error={errors.willingToRelocate}
          hint="Defaults to yes once you have picked a target location. Change it if that is not right."
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
            onChange={(event) => handleGradDateChange(event.target.value)}
          />
        </Field>

        <Field
          label="Earliest date you could start"
          htmlFor="start"
          error={errors.earliestStart}
          hint="Defaults to 30 days after graduation. Change it if that is not right."
        >
          <Input
            id="start"
            type="date"
            value={earliestStart}
            onChange={(event) => handleEarliestStartChange(event.target.value)}
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
          targetLocations,
          willingToRelocate: toBoolean(willingToRelocate),
          // null, not false, on this path, and deliberately different
          // from the onSubmit payload above. step3DraftSchema accepts
          // null for every field, which is the honest value here: Save
          // and finish later can fire before the user has named a target
          // location or answered willingToRelocate, and showSponsorshipNonUs
          // being false in that state means "not shown yet", not "shown
          // and answered no". saveIntakeDraft's partial branch
          // (app/onboarding/actions.ts) does not actually trust this
          // field when the question is not relevant; it recomputes
          // relevance itself from the saved targetLocations and
          // willingToRelocate and stores null in that case regardless of
          // what is sent here. This field still matters, and null is
          // still the right value, for the case that recompute does not
          // cover: the question was relevant and shown, but the person
          // had not picked yes or no yet when they clicked Save and
          // finish later. onSubmit cannot send null here at all, because
          // step3Schema requires a real boolean; a step is only allowed
          // to reach onSubmit once every field on it, including this one,
          // has an actual answer.
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
