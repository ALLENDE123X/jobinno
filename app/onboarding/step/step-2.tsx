"use client";

/**
 * Step 2: Work authorization.
 *
 * For US citizens and permanent residents, workAuthorizedUs and
 * requiresSponsorship are auto-derived server-side (true and false
 * respectively) and the explicit Yes/No inputs are not rendered. The
 * client omits those two fields from the payload in that case, so the
 * server's `deriveWorkAuthorizedUs` / `deriveRequiresSponsorship` are
 * the sole authors of the stored values.
 *
 * For every other citizenship the Yes/No inputs ARE rendered and are
 * required. An F1 not yet on OPT can then honestly answer
 * workAuthorizedUs=false rather than have true silently fabricated on
 * their behalf. This is the JOB-308 round two BLOCKING 1 fix, and
 * directly serves HARD STOP 9: no answer we submit on a person's behalf
 * is one they did not enter themselves.
 *
 * The visa status field follows the same rule as of JOB-312: for US
 * citizens and permanent residents it is not rendered at all and the
 * client omits it from the payload, since the server derives the exact
 * same value via `prefillVisaStatus`. For every other citizenship the
 * field is rendered and required, since visa status is a fact only the
 * person themselves can state.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CITIZENSHIP_OPTIONS,
  F1_STATUS_OPTIONS,
  intakeFieldErrors,
  step2Schema,
} from "@/lib/onboarding/intake-schema";
import { prefillVisaStatus } from "@/lib/onboarding/intake-derivation";

import { saveIntakeDraft } from "../actions";
import { Field, YesNoField, toBoolean, type YesNo } from "./_shared";

type CitizenshipValue = (typeof CITIZENSHIP_OPTIONS)[number]["value"];
type F1Value = (typeof F1_STATUS_OPTIONS)[number]["value"];

type ProfileData = {
  citizenship_status: string | null;
  f1_status: string | null;
  visa_status: string | null;
  work_authorized_us: boolean | null;
  requires_sponsorship: boolean | null;
};

export function Step2Form({
  profile,
}: {
  profile: ProfileData;
}) {
  const router = useRouter();
  const [citizenshipStatus, setCitizenshipStatus] = useState<
    CitizenshipValue | ""
  >(profile.citizenship_status as CitizenshipValue | "");
  const [f1Status, setF1Status] = useState<F1Value | "">(
    (profile.f1_status as F1Value) ?? "",
  );
  const [visaStatus, setVisaStatus] = useState(profile.visa_status ?? "");
  const [workAuthorizedUs, setWorkAuthorizedUs] = useState<YesNo>(
    profile.work_authorized_us === true
      ? "yes"
      : profile.work_authorized_us === false
        ? "no"
        : "",
  );
  const [requiresSponsorship, setRequiresSponsorship] = useState<YesNo>(
    profile.requires_sponsorship === true
      ? "yes"
      : profile.requires_sponsorship === false
        ? "no"
        : "",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isF1 = citizenshipStatus === "f1";
  const isUsOrPr =
    citizenshipStatus === "us_citizen" ||
    citizenshipStatus === "permanent_resident";

  // Auto-fill visa status when citizenship changes.
  function handleCitizenshipChange(next: CitizenshipValue) {
    setCitizenshipStatus(next);
    if (next !== "f1") setF1Status("");
    setVisaStatus(prefillVisaStatus(next, next === "f1" ? f1Status : null));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setErrors({});

    try {
      // For US citizens and permanent residents, visaStatus,
      // workAuthorizedUs and requiresSponsorship are all auto-derived
      // server-side; the payload omits them so the server is the sole
      // author. For every other citizenship the explicit answer is
      // required.
      const payload: Record<string, unknown> = {
        citizenshipStatus,
        f1Status: isF1 ? (f1Status === "" ? null : f1Status) : null,
      };
      if (!isUsOrPr) {
        payload.visaStatus = visaStatus;
        payload.workAuthorizedUs = toBoolean(workAuthorizedUs);
        payload.requiresSponsorship = toBoolean(requiresSponsorship);
      }

      const parsed = step2Schema.safeParse(payload);
      if (!parsed.success) {
        setErrors(intakeFieldErrors(parsed.error));
        setBusy(false);
        return;
      }

      const result = await saveIntakeDraft(parsed.data, 2);
      if (result.ok) {
        router.push("/onboarding/step/3");
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
        <h2 className="text-lg font-medium">Work authorization</h2>

        <Field
          label="Citizenship status"
          htmlFor="citizenship"
          error={errors.citizenshipStatus}
        >
          <Select
            value={citizenshipStatus}
            onValueChange={(next) =>
              handleCitizenshipChange(next as CitizenshipValue)
            }
          >
            <SelectTrigger id="citizenship" className="w-full">
              <SelectValue placeholder="Choose one" />
            </SelectTrigger>
            <SelectContent>
              {CITIZENSHIP_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {isF1 ? (
          <Field
            label="Which F1 work authorization"
            htmlFor="f1-status"
            error={errors.f1Status}
          >
            <Select
              value={f1Status}
              onValueChange={(next) => setF1Status(next as F1Value)}
            >
              <SelectTrigger id="f1-status" className="w-full">
                <SelectValue placeholder="Choose one" />
              </SelectTrigger>
              <SelectContent>
                {F1_STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {isUsOrPr ? null : (
          <Field
            label="Your current visa status"
            htmlFor="visa"
            error={errors.visaStatus}
            hint="In your own words. If you are not on a visa, say so, for example: not applicable, US citizen."
          >
            <Input
              id="visa"
              value={visaStatus}
              onChange={(event) => setVisaStatus(event.target.value)}
              placeholder="Not applicable, US citizen"
            />
          </Field>
        )}

        {isUsOrPr ? (
          <p className="text-muted-foreground text-xs">
            As a {citizenshipStatus === "us_citizen" ? "US citizen" : "permanent resident"}, you are
            authorized to work in the US and do not need sponsorship.
          </p>
        ) : citizenshipStatus === "" ? null : (
          <>
            <YesNoField
              label="Are you authorized to work in the US"
              htmlFor="work-authorized"
              value={workAuthorizedUs}
              onChange={setWorkAuthorizedUs}
              error={errors.workAuthorizedUs}
              hint="Answer yes only if you can work in the US today without new sponsorship. An F1 on OPT can answer yes; an F1 not yet on OPT should answer no."
            />
            <YesNoField
              label="Will you need visa sponsorship, now or in the future"
              htmlFor="requires-sponsorship"
              value={requiresSponsorship}
              onChange={setRequiresSponsorship}
              error={errors.requiresSponsorship}
              hint="Answer yes if any US employer would need to sponsor you now or when your current authorization ends."
            />
          </>
        )}
      </section>

      {message ? (
        <p className="text-destructive text-sm" role="alert">
          {message}
        </p>
      ) : null}

      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={() => router.push("/onboarding/step/1")}>
          Back
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving" : "Next"}
        </Button>
      </div>
    </form>
  );
}
