"use client";

/**
 * Step 1: Resume + identity.
 *
 * File uploads go straight to Storage, then straight into the resumes
 * table via saveIntakeDraft on this step. That way step-routing has a
 * real row to key off (step 1 is complete iff a resumes row exists) and
 * a browser refresh mid-flow does not orphan the upload. See JOB-308
 * round two BLOCKING 2.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { RESUMES_BUCKET, createClient } from "@/lib/supabase/client";

import { saveIntakeDraft } from "../actions";
import { Field, StepFooter } from "./_shared";

type ProfileData = {
  github_url: string | null;
  resume_path: string | null;
  linkedin_pdf_path: string | null;
};

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

  const hasExistingResume = Boolean(profile.resume_path);

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
      if (!resumeFile && !hasExistingResume) {
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

      const result = await saveIntakeDraft(
        {
          githubUrl: githubUrl || null,
          resumePath,
          linkedinPdfPath,
        },
        1,
      );

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
          hint={
            hasExistingResume
              ? "Upload a new file to replace the one on record, or leave blank to keep it."
              : "This is the file we attach to every application."
          }
        >
          <Input
            id="resume"
            type="file"
            accept="application/pdf"
            onChange={(event) => setResumeFile(event.target.files?.[0] ?? null)}
            required={!hasExistingResume && !isEdit}
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

      {/*
        Save and finish later on step 1 saves the GitHub URL field only.
        The resume and LinkedIn PDF are local File objects at this point,
        not yet uploaded, and uploading them is an async storage write this
        button is not meant to trigger silently. A person who pauses here
        without clicking Next keeps their typed GitHub URL and re-selects
        the file when they come back, the same as they would if they had
        simply closed the tab before choosing a file at all.
      */}
      <StepFooter
        step={1}
        draftPayload={{ githubUrl: githubUrl || null }}
        busy={busy}
      />
    </form>
  );
}
