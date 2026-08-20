"use client";

/**
 * The intake form.
 *
 * ── Why the files go straight to Storage ────────────────────────────────────
 * The two PDFs are uploaded from the browser to the private `resumes` bucket
 * before the answers are posted, and only the resulting object paths are sent
 * to the server action. Routing multi megabyte files through a server action
 * instead would mean raising the body size limit and holding the whole file in
 * the function's memory, for no gain: the bucket's policies check the owner of
 * the folder against `auth.uid()`, so a direct upload is checked by the
 * database rather than trusted.
 *
 * Everything is written under `{userId}/{uuid}.pdf`. The prefix is the access
 * control, not a naming scheme, and the server action checks it again before
 * it records a path.
 *
 * ── What this form does not ask ─────────────────────────────────────────────
 * Race, gender, veteran status and disability status. HARD STOP 10: they are
 * answered "decline to self identify" on every form we submit, are never
 * stored, and are never put to the user as a choice. There is no field for them
 * here and no setting that adds one.
 */

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  CITIZENSHIP_OPTIONS,
  F1_STATUS_OPTIONS,
  intakeFieldErrors,
  intakeSchema,
} from "@/lib/onboarding/intake-schema";
import { RESUMES_BUCKET, createClient } from "@/lib/supabase/client";

import { submitIntake } from "./actions";

type CitizenshipValue = (typeof CITIZENSHIP_OPTIONS)[number]["value"];
type F1Value = (typeof F1_STATUS_OPTIONS)[number]["value"];

const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const;

/** A tri state so that "not answered yet" is distinguishable from "no". */
type YesNo = "yes" | "no" | "";

function toBoolean(value: YesNo): boolean | null {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

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
          {YES_NO.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function IntakeForm({ userId }: { userId: string }) {
  const [citizenshipStatus, setCitizenshipStatus] = useState<
    CitizenshipValue | ""
  >("");
  const [f1Status, setF1Status] = useState<F1Value | "">("");
  const [workAuthorizedUs, setWorkAuthorizedUs] = useState<YesNo>("");
  const [requiresSponsorship, setRequiresSponsorship] = useState<YesNo>("");
  const [currentCity, setCurrentCity] = useState("");
  const [currentCountry, setCurrentCountry] = useState("United States");
  const [willingToRelocate, setWillingToRelocate] = useState<YesNo>("");
  const [targetLocations, setTargetLocations] = useState("");
  const [gradDate, setGradDate] = useState("");
  const [earliestStart, setEarliestStart] = useState("");
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [linkedinFile, setLinkedinFile] = useState<File | null>(null);
  const [attestation, setAttestation] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const isF1 = citizenshipStatus === "f1";

  async function upload(file: File): Promise<string> {
    const supabase = createClient();
    const objectPath = `${userId}/${crypto.randomUUID()}.pdf`;

    const { error } = await supabase.storage
      .from(RESUMES_BUCKET)
      .upload(objectPath, file, { contentType: "application/pdf" });

    if (error) throw new Error(`Could not upload ${file.name}: ${error.message}`);
    return objectPath;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setErrors({});

    try {
      if (!resumeFile) {
        setErrors({ resumePath: "Attach your resume as a PDF." });
        return;
      }

      const resumePath = await upload(resumeFile);
      const linkedinPdfPath = linkedinFile ? await upload(linkedinFile) : null;

      const payload = {
        citizenshipStatus,
        f1Status: isF1 ? (f1Status === "" ? null : f1Status) : null,
        workAuthorizedUs: toBoolean(workAuthorizedUs),
        requiresSponsorship: toBoolean(requiresSponsorship),
        currentCity,
        currentCountry,
        willingToRelocate: toBoolean(willingToRelocate),
        targetLocations: targetLocations
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        gradDate,
        earliestStart,
        resumePath,
        linkedinPdfPath,
        attestation,
      };

      // The same schema the server action runs. Checking here first is about
      // putting the message under the right control; the check that counts is
      // the one on the server, which does not trust this one happened.
      const parsed = intakeSchema(userId).safeParse(payload);
      if (!parsed.success) {
        setErrors(intakeFieldErrors(parsed.error));
        return;
      }

      const result = await submitIntake(parsed.data);
      if (result.ok) {
        setDone(true);
        return;
      }

      if (result.errors) setErrors(result.errors);
      if (result.message) setMessage(result.message);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Something went wrong."
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
          We have your resume and your answers.
        </p>
        <Button asChild size="lg" className="h-10">
          <Link href="/dashboard">Go to your applications</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8" noValidate>
      <section className="space-y-4 rounded-2xl border bg-card/40 p-6 sm:p-8">
        <h2 className="text-lg font-medium">Your documents</h2>

        <Field
          label="Resume, as a PDF"
          htmlFor="resume"
          error={errors.resumePath}
          hint="This is the file we attach to every application."
        >
          <Input
            id="resume"
            type="file"
            accept="application/pdf"
            onChange={(event) => setResumeFile(event.target.files?.[0] ?? null)}
            required
          />
        </Field>

        <Field
          label="LinkedIn profile PDF, optional"
          htmlFor="linkedin"
          error={errors.linkedinPdfPath}
          hint="Save to PDF from your LinkedIn profile. It fills gaps a resume leaves out."
        >
          <Input
            id="linkedin"
            type="file"
            accept="application/pdf"
            onChange={(event) =>
              setLinkedinFile(event.target.files?.[0] ?? null)
            }
          />
        </Field>
      </section>

      <section className="space-y-4 rounded-2xl border bg-card/40 p-6 sm:p-8">
        <h2 className="text-lg font-medium">Work authorization</h2>

        <Field label="Citizenship status" error={errors.citizenshipStatus}>
          <Select
            value={citizenshipStatus}
            onValueChange={(next) => {
              setCitizenshipStatus(next as CitizenshipValue);
              if (next !== "f1") setF1Status("");
            }}
          >
            <SelectTrigger className="w-full">
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
          <Field label="Which F1 work authorization" error={errors.f1Status}>
            <Select
              value={f1Status}
              onValueChange={(next) => setF1Status(next as F1Value)}
            >
              <SelectTrigger className="w-full">
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

        <YesNoField
          label="Are you authorized to work in the US right now"
          value={workAuthorizedUs}
          onChange={setWorkAuthorizedUs}
          error={errors.workAuthorizedUs}
        />

        <YesNoField
          label="Will you need visa sponsorship, now or in the future"
          value={requiresSponsorship}
          onChange={setRequiresSponsorship}
          error={errors.requiresSponsorship}
        />
      </section>

      <section className="space-y-4 rounded-2xl border bg-card/40 p-6 sm:p-8">
        <h2 className="text-lg font-medium">Where you are and where you want to be</h2>

        <Field label="Current city" htmlFor="city" error={errors.currentCity}>
          <Input
            id="city"
            value={currentCity}
            onChange={(event) => setCurrentCity(event.target.value)}
            placeholder="Atlanta"
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

        <YesNoField
          label="Would you relocate for the right role"
          value={willingToRelocate}
          onChange={setWillingToRelocate}
          error={errors.willingToRelocate}
        />

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

      <section className="space-y-3 rounded-2xl border bg-card/40 p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <Checkbox
            id="attestation"
            checked={attestation}
            onCheckedChange={(checked) => setAttestation(checked === true)}
          />
          <Label htmlFor="attestation" className="text-sm leading-relaxed font-normal">
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

      <Button type="submit" disabled={busy}>
        {busy ? "Saving" : "Finish setup"}
      </Button>
    </form>
  );
}
