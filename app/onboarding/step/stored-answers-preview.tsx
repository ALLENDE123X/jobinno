"use client";

/**
 * JOB-315: the "here is what we will say on your behalf" preview on step 5.
 *
 * Step 5 asks the user to attest that the agent may submit real applications
 * using their stored answers. The summary above already lists the intake
 * fields, but not the shape of what an actual form question gets answered
 * with, and that shape is the part of the trust ask that matters: the user
 * is authorizing an agent to speak for them without seeing what it will say.
 *
 * The ten question shapes below are the ten most common ones a real
 * application form asks, taken from the fact keys `buildFactCatalog` in
 * lib/fill-application-form.ts actually writes at fill time (fullName,
 * email, phone, linkedinUrl, githubUrl, workAuthorizedUs,
 * requiresSponsorship, currentCity, visaStatus, salaryExpectation), so this
 * reflects real fields the pipeline answers rather than invented ones.
 *
 * HARD STOP 9: every answer below is either the real stored value or the
 * fixed placeholder. Nothing is invented. Full name, phone number and a
 * LinkedIn URL as text have no home on `profiles` yet: a name and phone
 * only exist inside a parsed resume the agent reads at fill time (see
 * `resumes.parsed` in lib/db/schema.ts, empty at onboarding time), and
 * LinkedIn is stored here only as an uploaded file, not as a URL string.
 * All three always show the placeholder until a future ticket gives them a
 * stored column, which is a deliberate and named gap, not an oversight.
 *
 * HARD STOP 10: EEO and demographic questions are excluded outright. None
 * of the ten shapes below touches race, gender, veteran status or
 * disability status, and none should ever be added here.
 *
 * Read only. There is no input anywhere in this component.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

export const MISSING_FIELD_PLACEHOLDER =
  "We will ask you when a form gets to this";

export type StoredAnswersProfile = {
  email: string | null;
  github_url: string | null;
  current_city: string | null;
  visa_status: string | null;
  salary_expectation: string | null;
  work_authorized_us: boolean | null;
  requires_sponsorship: boolean | null;
};

type ExampleAnswer = {
  question: string;
  answer: string;
};

function formatText(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : MISSING_FIELD_PLACEHOLDER;
}

function formatYesNo(value: boolean | null | undefined): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return MISSING_FIELD_PLACEHOLDER;
}

/**
 * Builds the ten example answers straight from the stored profile row. No
 * argument here is ever synthesized: a field with nowhere to come from
 * passes `null` in and gets the placeholder out.
 */
export function buildExampleAnswers(
  profile: StoredAnswersProfile,
): ExampleAnswer[] {
  return [
    { question: "Full name", answer: MISSING_FIELD_PLACEHOLDER },
    { question: "Email address", answer: formatText(profile.email) },
    { question: "Phone number", answer: MISSING_FIELD_PLACEHOLDER },
    { question: "LinkedIn profile URL", answer: MISSING_FIELD_PLACEHOLDER },
    { question: "GitHub URL", answer: formatText(profile.github_url) },
    {
      question: "Are you legally authorized to work in the United States",
      answer: formatYesNo(profile.work_authorized_us),
    },
    {
      question:
        "Will you now or in the future require visa sponsorship to work in the United States",
      answer: formatYesNo(profile.requires_sponsorship),
    },
    { question: "Current city", answer: formatText(profile.current_city) },
    { question: "Visa status", answer: formatText(profile.visa_status) },
    {
      question: "Expected salary",
      answer: formatText(profile.salary_expectation),
    },
  ];
}

export function StoredAnswersPreview({
  profile,
}: {
  profile: StoredAnswersProfile;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const answers = buildExampleAnswers(profile);

  return (
    <section className="rounded-2xl border bg-card/40 p-6 sm:p-8">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-4 text-left text-sm font-medium"
      >
        <span>See what we will say on your behalf (10 example answers)</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={`text-muted-foreground size-4 shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open ? (
        <div id={panelId} className="mt-4 space-y-3">
          <p className="text-muted-foreground text-xs">
            These are the ten questions almost every application form asks,
            and the answer we would give from what you told us. A missing
            answer means we stop and ask you instead of guessing.
          </p>
          <dl className="divide-border divide-y text-sm">
            {answers.map((item) => (
              <div
                key={item.question}
                className="flex flex-col gap-1 py-2 first:pt-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
              >
                <dt className="text-muted-foreground">{item.question}</dt>
                <dd className="font-medium sm:text-right">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}
