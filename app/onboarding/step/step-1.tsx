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
 * JOB-330 adds a second lane below the resume upload for cold mobile
 * signups that cannot produce a PDF from their phone right now. The
 * person pastes a LinkedIn profile URL, the server writes it to
 * `profiles.linkedin_url_pending`, fires a Resend follow-up email with a
 * deep link back to `/onboarding/step/1?resumeUpload=1`, and routes them
 * to step 2 immediately. Attestation still succeeds on step 5 without a
 * resume when the pending column is set; the pipeline gate in
 * `inngest/job-application-pipeline.ts` refuses to open a browser until
 * a real PDF lands (HARD STOP 9 — nothing fabricates a resume).
 *
 * The deep link mode (`resumeUpload` in query params, or the profile
 * already carries a `linkedin_url_pending` value the person is coming
 * back to satisfy) shows only the upload UI, no LinkedIn lane visible
 * again, so the person who returns from a laptop is not offered a
 * choice they have already made.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RESUMES_BUCKET, createClient } from "@/lib/supabase/client";

import { saveIntakeDraft, submitLinkedInDeferred } from "../actions";
import { Field, StepFooter } from "./_shared";

type ProfileData = {
  github_url: string | null;
  resume_path: string | null;
  linkedin_pdf_path: string | null;
  /**
   * JOB-330. Non null when the person took the LinkedIn URL deferred lane
   * and has not yet uploaded a resume from their laptop. Used to hide
   * the deferred lane on their return visit so they are not offered a
   * choice they have already made.
   */
  linkedin_url_pending: string | null;
};

export function Step1Form({
  userId,
  profile,
  isEdit,
  resumeUploadOnly,
}: {
  userId: string;
  profile: ProfileData;
  isEdit: boolean;
  /**
   * JOB-330. True when the page was reached via the follow-up email's
   * `?resumeUpload=1` deep link, or when the profile already carries a
   * LinkedIn URL from an earlier session. Hides the deferred lane so the
   * person sees only the upload UI.
   */
  resumeUploadOnly?: boolean;
}) {
  const router = useRouter();
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [linkedinFile, setLinkedinFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState(profile.github_url ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Deferred lane state, kept separate from the upload form's state so a
  // typo in one does not clear the other.
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [deferredErrors, setDeferredErrors] = useState<Record<string, string>>(
    {},
  );
  const [deferredMessage, setDeferredMessage] = useState<string | null>(null);
  const [deferredBusy, setDeferredBusy] = useState(false);

  const hasExistingResume = Boolean(profile.resume_path);

  // Show only the upload UI when the deep link is followed, or when the
  // profile already carries a pending LinkedIn URL (the person's next
  // visit after taking the deferred lane).
  const showDeferredLane =
    !resumeUploadOnly && !profile.linkedin_url_pending && !hasExistingResume;

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
        // JOB-330: a person who took the deferred lane and is now uploading
        // via the deep link should land wherever their onboarding actually
        // left off, not always on step 2. The server component reads the
        // profile on the next request and routes them via
        // `earliestIncompleteStep`, so a plain redirect to `/onboarding`
        // works for both fresh signups and deep-link returners.
        if (resumeUploadOnly || profile.linkedin_url_pending) {
          router.push("/onboarding");
          return;
        }
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

  async function onDeferredSubmit() {
    setDeferredBusy(true);
    setDeferredMessage(null);
    setDeferredErrors({});

    try {
      const result = await submitLinkedInDeferred(linkedinUrl.trim());
      if (result.ok) {
        router.push("/onboarding/step/2");
        return;
      }
      if (result.errors) setDeferredErrors(result.errors);
      if (result.message) setDeferredMessage(result.message);
    } catch (error) {
      setDeferredMessage(
        error instanceof Error ? error.message : "Something went wrong.",
      );
    } finally {
      setDeferredBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-8" noValidate>
      <section className="space-y-4 rounded-2xl border bg-card/40 p-6 sm:p-8">
        <h2 className="text-lg font-medium">Your documents</h2>

        {resumeUploadOnly || profile.linkedin_url_pending ? (
          <p className="text-muted-foreground text-sm">
            Upload the PDF now and the queue picks up right after.
          </p>
        ) : null}

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

      {showDeferredLane ? (
        <section
          className="space-y-4 rounded-2xl border bg-card/40 p-6 sm:p-8"
          aria-labelledby="linkedin-deferred-heading"
        >
          <div className="flex items-center gap-3">
            <div className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-xs uppercase tracking-wide">
              or
            </span>
            <div className="bg-border h-px flex-1" />
          </div>

          <h2 id="linkedin-deferred-heading" className="text-lg font-medium">
            On your phone right now?
          </h2>
          <p className="text-muted-foreground text-sm">
            Paste your LinkedIn URL and we will email you a link to finish
            uploading your resume from your laptop later. You can go through
            the rest of the signup on your phone in the meantime.
          </p>

          <Field
            label="LinkedIn profile URL"
            htmlFor="linkedin-url"
            error={deferredErrors.linkedinUrl}
            hint="Copy the address from your profile page, for example https://linkedin.com/in/yourhandle."
          >
            <Input
              id="linkedin-url"
              type="url"
              inputMode="url"
              autoComplete="url"
              value={linkedinUrl}
              onChange={(event) => setLinkedinUrl(event.target.value)}
              placeholder="https://linkedin.com/in/yourhandle"
            />
          </Field>

          {deferredMessage ? (
            <p className="text-destructive text-sm" role="alert">
              {deferredMessage}
            </p>
          ) : null}

          <Button
            type="button"
            variant="secondary"
            onClick={onDeferredSubmit}
            disabled={deferredBusy || linkedinUrl.trim() === ""}
          >
            {deferredBusy ? "Saving" : "Finish this from your laptop later"}
          </Button>
        </section>
      ) : null}
    </form>
  );
}
