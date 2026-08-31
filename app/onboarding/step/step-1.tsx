"use client";

/**
 * Step 1: Resume + identity.
 *
 * File uploads happen here and stay in component state. Their paths are
 * validated by the full intakeSchema on step 5's final submit. The one
 * field persisted to profiles on this step is githubUrl.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RESUMES_BUCKET, createClient } from "@/lib/supabase/client";

import { saveIntakeDraft } from "../actions";

type ProfileData = {
  github_url: string | null;
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

export function Step1Form({
  userId,
  profile,
  isEdit,
}: {
  userId: string;
  profile: ProfileData;
  isEdit: boolean;
}) {
  const router = useRouter();
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [linkedinFile, setLinkedinFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState(profile.github_url ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      if (!resumeFile && !isEdit) {
        setErrors({ resumePath: "Attach your resume as a PDF." });
        setBusy(false);
        return;
      }

      let resumePath: string | null = null;
      let linkedinPdfPath: string | null = null;

      if (resumeFile) {
        resumePath = await upload(resumeFile);
      }
      if (linkedinFile) {
        linkedinPdfPath = await upload(linkedinFile);
      }

      // Persist only githubUrl to the server. File paths live in
      // component state until step 5's final submit. The window object
      // is used to pass file paths between steps via a transient map;
      // this avoids adding a database column for draft state that is
      // only needed across a single navigation.
      if (typeof window !== "undefined") {
        const w = window as unknown as Record<string, unknown>;
        w.__onboardingDraft = {
          ...(typeof w.__onboardingDraft === "object" && w.__onboardingDraft !== null
            ? (w.__onboardingDraft as Record<string, unknown>)
            : {}),
          resumePath,
          linkedinPdfPath,
        };
      }

      const result = await saveIntakeDraft({ githubUrl: githubUrl || null }, 1);
      if (result.ok) {
        router.push("/onboarding/step/2");
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
            required={!isEdit}
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

        <Field
          label="GitHub, optional"
          htmlFor="github"
          error={errors.githubUrl}
          hint="A growing share of engineering applications ask for this by name."
        >
          <Input
            id="github"
            value={githubUrl}
            onChange={(event) => setGithubUrl(event.target.value)}
            placeholder="https://github.com/yourhandle"
          />
        </Field>
      </section>

      {message ? (
        <p className="text-destructive text-sm" role="alert">
          {message}
        </p>
      ) : null}

      <Button type="submit" disabled={busy}>
        {busy ? "Saving" : "Next"}
      </Button>
    </form>
  );
}
