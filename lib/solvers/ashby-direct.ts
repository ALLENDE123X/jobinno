/**
 * JOB-214 — the browserless Ashby submit path.
 *
 * ── What this actually is, told honestly ────────────────────────────────────
 * This module extracts the Ashby non user GraphQL SHAPES that were reverse
 * engineered in `scripts/test-ashby-api.ts` — the queries and mutations
 * `ApiJobPosting`, `ApiCreateFileUploadHandle`, `ApiSetFormValue`,
 * `ApiSetFormValueToFile` and `ApiSubmitSingleApplicationFormAction`, and
 * the S3 pre signed POST that carries the resume. What it does with them
 * is different from what that script does.
 *
 * The script's `main()` opens a real Browserbase session, drives Stagehand
 * through Ashby's own React UI to fill and click Submit, and lets Ashby's
 * own client bundle mint the reCAPTCHA token in that browser. The GraphQL
 * helper functions it defines (`createUploadHandle`, `setFieldValue`,
 * `setFileField`, `submitForm`) are dead code inside that main — they are
 * defined and never called on the path that has proved to submit a real
 * application.
 *
 * This module runs those helpers over raw HTTP with no browser at all,
 * a Fly harvester minted reCAPTCHA token in place of one Ashby's own JS
 * would mint, and no cookies or fingerprint from a warmed session.
 * That path has NEVER been exercised against a live Ashby endpoint —
 * not by this module, not by the script, not anywhere. Live validation
 * against a real Ashby posting is a required next step and has not
 * happened yet. The mode selector in `lib/submit-application.ts` is off
 * by default in prod so a live run only happens when someone deliberately
 * flips the env.
 *
 * ── What lives here ─────────────────────────────────────────────────────────
 * `runAshbyDirectSubmit(ctx, deps)` is the seam a unit test drives. Every
 * network dependency (`fetch`, the reCAPTCHA harvester, the Supabase
 * client that stamps the row status) is behind `deps`, so the tests never
 * touch a live Ashby endpoint and never touch a live harvester.
 *
 * `submitAshbyApplicationDirectly({ jobApplicationId, ... })` is the
 * caller facing entry, and it does the reads a live run needs — the
 * applications row's user id, the candidate profile, the resume bytes —
 * before calling `runAshbyDirectSubmit` with the resolved context. The
 * mode selector in `lib/submit-application.ts` calls this one and only
 * when the env flag is on and the row's ats is ashby.
 *
 * ── What this deliberately does NOT do ─────────────────────────────────────
 *   1. It never opens a browser. That is the entire point of the direct
 *      path. If a future edit reintroduces Browserbase or Stagehand here
 *      the ticket is wrong.
 *   2. It never invents an answer that is not in the candidate's own
 *      intake. HARD STOP 9. `candidateValueForField` reads work
 *      authorization off `applicationAnswers.workAuthorizedUs`,
 *      sponsorship off `applicationAnswers.requiresSponsorship`, "based in
 *      US or Canada" style questions off `applicationAnswers.currentCountry`,
 *      and returns `null` — routing the field to `missingRequired` when it
 *      is required — the moment intake does not carry an answer. A boolean
 *      question with no known source is `null`, not `true`. A required
 *      text field with no honest source is `null`, not a fabricated
 *      paragraph.
 *   3. It never widens what `submitted` or `submission_unconfirmed` mean.
 *      Both are terminal, from the moment the submit mutation is issued.
 *      The classifier below is deliberately narrow: a `FormSubmitSuccess`
 *      is required for `submitted`, a network throw or a GraphQL `errors`
 *      response after the submit request went out records
 *      `submission_unconfirmed`, and anything the module refused to send
 *      at all lands as `submission_blocked` for a later retry.
 *
 * ── JOB-227 ──────────────────────────────────────────────────────────────────
 * The first live test against a real posting (Zip, Software Engineer
 * Backend, 2026-08-27) got past the reCAPTCHA composite cleanly but came
 * back with every field, including the system fields, reported as missing
 * at submit. Two bugs in `setFieldValue` and `setFileFieldValue` accounted
 * for it, both fixed here and explained where each function now lives:
 *   1. Neither function ever read `data.setFormValue.errorMessages` (or
 *      `setFormValueToFile`'s equivalent). A rejected field write and an
 *      accepted one were indistinguishable — no transport level `errors`
 *      either way — so the module logged nothing and moved on as if the
 *      value had landed.
 *   2. Both functions reused the single `formRenderIdentifier` discovery
 *      returned for every later call, including the final submit. If Ashby
 *      versions the render per write the way the naming (`FormRender`,
 *      `applicationForm.id` aliased `formRenderIdentifier`) suggests it
 *      might, every call after the first, and the submit call itself, would
 *      have been referencing a snapshot that predates its own edit.
 * Neither is confirmed against a live endpoint — see `runAshbyDirectSubmit`
 * and the fixed functions below for the reasoning trail, and the PR
 * description for what still needs a real Ashby posting to prove out.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { APPLICATION_STATUS, type ApplicationStatus } from "@/lib/application-status";
import { mintAshbyRecaptchaToken } from "@/lib/ashby-recaptcha";
import { loadCandidate, type CandidateRecord } from "@/lib/candidate-intake";
import type { CandidateApplicationAnswers } from "@/lib/candidate-intake";
import { resolveCandidateProfile } from "@/lib/candidate-documents";
import { loadResume, type ResumeProfile } from "@/lib/resume-parser";
import {
  recordSkipQuietly,
  updateApplication,
} from "@/lib/application-records";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";
import type { SubmitApplicationResult } from "@/lib/submit-application";
import type { SolverFn } from "@/lib/solvers/types";

const LOG = "[job-214]";

/** The env flag callers gate the mode selector on. */
export const ASHBY_DIRECT_HTTP_MODE_VALUE = "direct-http";
export const ASHBY_SUBMIT_MODE_ENV = "JOBINNO_ASHBY_SUBMIT_MODE";

/**
 * True when both env flag and ats say "route through the direct HTTP path".
 * Extracted as a pure predicate so a unit test pins it against every case
 * that could otherwise stray silently — env off, wrong ats, both off.
 */
export function shouldRouteAshbyDirectHttp(ats: string): boolean {
  return (
    process.env[ASHBY_SUBMIT_MODE_ENV] === ASHBY_DIRECT_HTTP_MODE_VALUE &&
    ats === "ashby"
  );
}

// ── Ashby URL parsing ────────────────────────────────────────────────────

export type ParsedAshbyUrl = { orgName: string; jobPostingId: string; origin: string };

/**
 * Splits an Ashby job URL into the two identifiers the GraphQL API keys off,
 * plus the origin used to compose the non user GraphQL endpoint.
 *
 * Only `jobs.ashbyhq.com/<org>/<job-id>` is recognised. Ashby also hosts
 * self branded boards on customer domains but this module ships as an opt
 * in path for the standard host first; those variants are a follow up.
 */
export function parseAshbyUrl(url: string): ParsedAshbyUrl {
  const parsed = new URL(url);
  if (parsed.hostname !== "jobs.ashbyhq.com") {
    throw new Error(
      `Ashby direct HTTP path only supports jobs.ashbyhq.com URLs today, got ${JSON.stringify(url)}`
    );
  }
  const [orgName, jobPostingId] = parsed.pathname.split("/").filter(Boolean);
  if (!orgName || !jobPostingId) {
    throw new Error(
      `Cannot parse org and job posting id from Ashby URL ${JSON.stringify(url)}`
    );
  }
  return { orgName, jobPostingId, origin: parsed.origin };
}

// ── GraphQL client ───────────────────────────────────────────────────────

type FetchImpl = typeof globalThis.fetch;

export type AshbyGqlErrors = ReadonlyArray<{
  message: string;
  extensions?: { ashbyErrorType?: string };
}>;

function apolloHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "apollographql-client-name": "frontend_non_user",
    "apollographql-client-version": "0.1.0",
    "x-ashby-client-request-timestamp": new Date().toISOString(),
  };
}

/**
 * One GraphQL call against the board's own non user GraphQL endpoint.
 *
 * Throws `AshbyGqlError` on a transport failure or a bad JSON response, and
 * on a response whose `errors` array is non empty. The caller catches
 * these directly rather than trying to interpret them here, because two
 * different callers (discovery vs submit) treat the same `errors` response
 * as different verdicts: a discovery failure is safe to retry, a submit
 * failure crosses the point of no return.
 */
export class AshbyGqlError extends Error {
  readonly op: string;
  readonly errors?: AshbyGqlErrors;
  readonly httpStatus?: number;

  constructor(
    op: string,
    message: string,
    options: { errors?: AshbyGqlErrors; httpStatus?: number } = {}
  ) {
    super(message);
    this.name = "AshbyGqlError";
    this.op = op;
    if (options.errors) this.errors = options.errors;
    if (typeof options.httpStatus === "number") this.httpStatus = options.httpStatus;
  }
}

async function gql(
  fetchImpl: FetchImpl,
  origin: string,
  op: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ data: Record<string, unknown> | null; errors?: AshbyGqlErrors }> {
  const endpoint = `${origin}/api/non-user-graphql?op=${op}`;
  const resp = await fetchImpl(endpoint, {
    method: "POST",
    headers: apolloHeaders(),
    body: JSON.stringify({ operationName: op, query, variables }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new AshbyGqlError(op, `HTTP ${resp.status}${text ? `: ${text.slice(0, 500)}` : ""}`, {
      httpStatus: resp.status,
    });
  }
  const body = (await resp.json()) as {
    data?: Record<string, unknown> | null;
    errors?: AshbyGqlErrors;
  };
  return { data: body.data ?? null, errors: body.errors };
}

// ── Form discovery ──────────────────────────────────────────────────────

export interface AshbyField {
  path: string;
  title: string;
  type: string;
}

export interface AshbyFieldEntry {
  id: string;
  isRequired: boolean;
  isHidden: boolean;
  field: AshbyField;
}

export interface AshbyDiscoveredForm {
  jobTitle: string;
  formRenderIdentifier: string;
  formDefinitionIdentifier: string;
  actionIdentifier: string;
  sections: Array<{ title: string; fieldEntries: AshbyFieldEntry[] }>;
}

async function discoverForm(
  fetchImpl: FetchImpl,
  origin: string,
  orgName: string,
  jobPostingId: string
): Promise<AshbyDiscoveredForm> {
  const { data, errors } = await gql(
    fetchImpl,
    origin,
    "ApiJobPosting",
    `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
      jobPosting(
        organizationHostedJobsPageName: $organizationHostedJobsPageName
        jobPostingId: $jobPostingId
      ) {
        id title
        applicationForm {
          id
          sourceFormDefinitionId
          formControls { identifier title }
          sections {
            title
            fieldEntries { id isRequired isHidden field }
          }
        }
      }
    }`,
    { organizationHostedJobsPageName: orgName, jobPostingId }
  );
  if (errors && errors.length > 0) {
    throw new AshbyGqlError("ApiJobPosting", describeErrors(errors), { errors });
  }
  const jobPosting = (data?.jobPosting ?? null) as {
    title?: string;
    applicationForm?: {
      id?: string;
      sourceFormDefinitionId?: string;
      formControls?: Array<{ identifier: string; title: string }>;
      sections?: Array<{ title: string; fieldEntries: AshbyFieldEntry[] }>;
    } | null;
  } | null;
  if (!jobPosting || !jobPosting.applicationForm) {
    throw new AshbyGqlError(
      "ApiJobPosting",
      `Job posting not found: org=${JSON.stringify(orgName)} id=${JSON.stringify(jobPostingId)}`
    );
  }
  const form = jobPosting.applicationForm;
  const actionIdentifier = (form.formControls ?? []).find((c) => c.title === "Submit")?.identifier;
  if (!actionIdentifier) {
    throw new AshbyGqlError(
      "ApiJobPosting",
      `No Submit formControl in the discovered form. Ashby may have changed the shape.`
    );
  }
  return {
    jobTitle: String(jobPosting.title ?? ""),
    formRenderIdentifier: String(form.id ?? ""),
    formDefinitionIdentifier: String(form.sourceFormDefinitionId ?? ""),
    actionIdentifier,
    sections: (form.sections ?? []) as AshbyDiscoveredForm["sections"],
  };
}

// ── File upload ─────────────────────────────────────────────────────────

async function createUploadHandle(
  fetchImpl: FetchImpl,
  origin: string,
  orgName: string,
  fileName: string,
  contentType: string,
  contentLength: number
): Promise<{ handle: string; url: string; fields: Record<string, string> }> {
  const { data, errors } = await gql(
    fetchImpl,
    origin,
    "ApiCreateFileUploadHandle",
    `mutation ApiCreateFileUploadHandle(
      $organizationHostedJobsPageName: String!
      $fileUploadContext: FileUploadContext!
      $filename: String!
      $contentType: String!
      $contentLength: Int!
    ) {
      fileUploadHandle: createFileUploadHandle(
        organizationHostedJobsPageName: $organizationHostedJobsPageName
        fileUploadContext: $fileUploadContext
        filename: $filename
        contentType: $contentType
        contentLength: $contentLength
      ) { handle url fields }
    }`,
    {
      organizationHostedJobsPageName: orgName,
      fileUploadContext: "NonUserFormEngine",
      filename: fileName,
      contentType,
      contentLength,
    }
  );
  if (errors && errors.length > 0) {
    throw new AshbyGqlError("ApiCreateFileUploadHandle", describeErrors(errors), { errors });
  }
  const handle = data?.fileUploadHandle as
    | { handle: string; url: string; fields: Record<string, string> }
    | undefined;
  if (!handle || !handle.handle || !handle.url) {
    throw new AshbyGqlError(
      "ApiCreateFileUploadHandle",
      "createFileUploadHandle returned no handle"
    );
  }
  return handle;
}

async function uploadResumeToS3(
  fetchImpl: FetchImpl,
  target: { url: string; fields: Record<string, string> },
  fileBytes: Uint8Array,
  fileName: string,
  contentType: string
): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  // These two look like a duplicate at a glance and they are not. S3 pre
  // signed POST needs `Content-Type` as a FIELD in the multipart body —
  // that is the object's stored content type, matched against the
  // policy the pre signed POST was signed with. The Blob's `type` on
  // the `file` part sets the Content-Type HEADER of that specific
  // multipart part, which S3 also inspects. Same rule as
  // `scripts/test-ashby-api.ts:264-266`; do not remove either.
  form.append("Content-Type", contentType);
  const buffer = fileBytes.buffer.slice(
    fileBytes.byteOffset,
    fileBytes.byteOffset + fileBytes.byteLength
  ) as ArrayBuffer;
  form.append("file", new Blob([buffer], { type: contentType }), fileName);
  const resp = await fetchImpl(target.url, { method: "POST", body: form });
  if (!resp.ok && resp.status !== 204) {
    const text = await resp.text().catch(() => "");
    throw new Error(`S3 upload failed HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
}

// ── Field set ────────────────────────────────────────────────────────────

/**
 * The render identifier a caller should use for whatever mutation comes
 * next — the freshest one this write returned, or the one it was called
 * with when the response carried nothing usable. See the JOB-227 note in
 * the module header for why this exists.
 */
type SetFormValueResult = { nextFrid: string };

async function setFieldValue(
  fetchImpl: FetchImpl,
  origin: string,
  orgName: string,
  frid: string,
  formDefId: string,
  path: string,
  value: unknown
): Promise<SetFormValueResult> {
  const { data, errors } = await gql(
    fetchImpl,
    origin,
    "ApiSetFormValue",
    `mutation ApiSetFormValue(
      $organizationHostedJobsPageName: String!
      $formRenderIdentifier: String!
      $formDefinitionIdentifier: String
      $path: String!
      $value: JSON
    ) {
      setFormValue(
        organizationHostedJobsPageName: $organizationHostedJobsPageName
        formRenderIdentifier: $formRenderIdentifier
        formDefinitionIdentifier: $formDefinitionIdentifier
        path: $path
        value: $value
      ) { id errorMessages }
    }`,
    {
      organizationHostedJobsPageName: orgName,
      formRenderIdentifier: frid,
      formDefinitionIdentifier: formDefId,
      path,
      value,
    }
  );
  if (errors && errors.length > 0) {
    throw new AshbyGqlError("ApiSetFormValue", describeErrors(errors), { errors });
  }
  const result = data?.setFormValue as { id?: string; errorMessages?: string[] } | undefined;
  const fieldErrors = result?.errorMessages ?? [];
  if (fieldErrors.length > 0) {
    // JOB-227 bug 1. A non empty `errorMessages` here means Ashby's own
    // form engine rejected this write — wrong type for the field, a
    // validation rule, whatever it decided — while the transport level
    // `errors` array stayed empty because the REQUEST was fine, only the
    // WRITE was not. The version of this function that shipped in JOB-214
    // never read this field at all, so a rejected write and an accepted
    // one were indistinguishable from here. Throwing routes the caller to
    // `blocked()` with the real reason instead of silently treating a
    // dropped value as a set one.
    throw new AshbyGqlError(
      "ApiSetFormValue",
      `Ashby rejected the value for field ${JSON.stringify(path)}: ${fieldErrors.join("; ")}`
    );
  }
  // JOB-227 bug 2. `id` is presumed to be the form's freshest render
  // identifier after this write landed — see the module header. Threading
  // it forward is free when Ashby does not actually version the FRID (the
  // value simply repeats call to call) and closes the gap if it does.
  return { nextFrid: typeof result?.id === "string" && result.id.length > 0 ? result.id : frid };
}

async function setFileFieldValue(
  fetchImpl: FetchImpl,
  origin: string,
  orgName: string,
  frid: string,
  formDefId: string,
  path: string,
  fileHandle: string
): Promise<SetFormValueResult> {
  const { data, errors } = await gql(
    fetchImpl,
    origin,
    "ApiSetFormValueToFile",
    `mutation ApiSetFormValueToFile(
      $organizationHostedJobsPageName: String!
      $formRenderIdentifier: String!
      $formDefinitionIdentifier: String
      $path: String!
      $fileHandle: String
    ) {
      setFormValueToFile(
        organizationHostedJobsPageName: $organizationHostedJobsPageName
        formRenderIdentifier: $formRenderIdentifier
        formDefinitionIdentifier: $formDefinitionIdentifier
        path: $path
        fileHandle: $fileHandle
      ) { id errorMessages }
    }`,
    {
      organizationHostedJobsPageName: orgName,
      formRenderIdentifier: frid,
      formDefinitionIdentifier: formDefId,
      path,
      fileHandle,
    }
  );
  if (errors && errors.length > 0) {
    throw new AshbyGqlError("ApiSetFormValueToFile", describeErrors(errors), { errors });
  }
  // Same JOB-227 pair of fixes as `setFieldValue` above: read the field
  // level `errorMessages` instead of trusting an empty transport `errors`
  // array, and thread the returned `id` forward as the next FRID.
  const result = data?.setFormValueToFile as { id?: string; errorMessages?: string[] } | undefined;
  const fieldErrors = result?.errorMessages ?? [];
  if (fieldErrors.length > 0) {
    throw new AshbyGqlError(
      "ApiSetFormValueToFile",
      `Ashby rejected the file attach for field ${JSON.stringify(path)}: ${fieldErrors.join("; ")}`
    );
  }
  return { nextFrid: typeof result?.id === "string" && result.id.length > 0 ? result.id : frid };
}

// ── Submit ───────────────────────────────────────────────────────────────

export type AshbySubmitOutcome =
  | {
      kind: "success";
    }
  | {
      kind: "form_render";
      errorMessages: string[];
      formErrors: Array<{ message: string; fieldEntryId: string }>;
    }
  | {
      kind: "gql_errors";
      errors: AshbyGqlErrors;
    }
  | {
      kind: "unexpected_shape";
      raw: unknown;
    };

/**
 * Reads Ashby's submit response into one of the four discrete outcomes the
 * caller acts on. Pure, so unit tests pin every branch by shape.
 */
export function classifyAshbySubmitResponse(body: unknown): AshbySubmitOutcome {
  if (!body || typeof body !== "object") return { kind: "unexpected_shape", raw: body };
  const errors = (body as { errors?: AshbyGqlErrors }).errors;
  if (errors && errors.length > 0) return { kind: "gql_errors", errors };
  const applicationFormResult = (
    body as {
      data?: { submitApplicationFormAction?: { applicationFormResult?: unknown } };
    }
  ).data?.submitApplicationFormAction?.applicationFormResult as
    | {
        __typename?: string;
        errorMessages?: string[];
        formErrors?: Array<{ message: string; fieldEntryId: string }>;
      }
    | undefined;
  if (!applicationFormResult || typeof applicationFormResult.__typename !== "string") {
    return { kind: "unexpected_shape", raw: body };
  }
  if (applicationFormResult.__typename === "FormSubmitSuccess") {
    return { kind: "success" };
  }
  return {
    kind: "form_render",
    errorMessages: applicationFormResult.errorMessages ?? [],
    formErrors: applicationFormResult.formErrors ?? [],
  };
}

async function submitForm(
  fetchImpl: FetchImpl,
  origin: string,
  args: {
    orgName: string;
    jobPostingId: string;
    frid: string;
    formDefId: string;
    actionIdentifier: string;
    recaptchaToken: string;
  }
): Promise<AshbySubmitOutcome> {
  const endpoint = `${origin}/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction`;
  const resp = await fetchImpl(endpoint, {
    method: "POST",
    headers: apolloHeaders(),
    body: JSON.stringify({
      operationName: "ApiSubmitSingleApplicationFormAction",
      query: `mutation ApiSubmitSingleApplicationFormAction(
        $organizationHostedJobsPageName: String!
        $jobPostingId: String!
        $formRenderIdentifier: String!
        $formDefinitionIdentifier: String
        $actionIdentifier: String!
        $recaptchaToken: String!
      ) {
        submitApplicationFormAction: submitSingleApplicationFormAction(
          organizationHostedJobsPageName: $organizationHostedJobsPageName
          jobPostingId: $jobPostingId
          formRenderIdentifier: $formRenderIdentifier
          formDefinitionIdentifier: $formDefinitionIdentifier
          actionIdentifier: $actionIdentifier
          recaptchaToken: $recaptchaToken
        ) {
          applicationFormResult {
            __typename
            ... on FormSubmitSuccess { _ }
            ... on FormRender {
              id
              errorMessages
              formErrors { message fieldEntryId }
            }
          }
        }
      }`,
      variables: {
        organizationHostedJobsPageName: args.orgName,
        jobPostingId: args.jobPostingId,
        formRenderIdentifier: args.frid,
        formDefinitionIdentifier: args.formDefId,
        actionIdentifier: args.actionIdentifier,
        recaptchaToken: args.recaptchaToken,
      },
    }),
  });
  if (!resp.ok) {
    // A non 2xx HTTP status from Ashby's own endpoint means the request
    // reached it and it answered with something we cannot classify as a
    // success. Treat as unconfirmed at the caller: the submit crossed the
    // network boundary.
    const text = await resp.text().catch(() => "");
    throw new AshbyGqlError(
      "ApiSubmitSingleApplicationFormAction",
      `HTTP ${resp.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
      { httpStatus: resp.status }
    );
  }
  const body = await resp.json().catch(() => null);
  return classifyAshbySubmitResponse(body);
}

// ── Candidate value mapping ─────────────────────────────────────────────

/**
 * The candidate view the field mapper reads from. Small on purpose: every
 * key here is a fact the profile actually stated, or a value derived from
 * one plus the resume. Nothing invented. HARD STOP 9.
 */
export type AshbyCandidateView = {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string;
  phone: string | null;
  linkedinUrl: string | null;
  location: string | null;
  /**
   * JOB-230. Sourced from `profiles.github_url` (JOB-044), which is read
   * onto `CandidateRecord.githubUrl` by `lib/candidate-intake.ts`, and since
   * JOB-230 is also collected on the onboarding intake form. Null when the
   * profile has not stated one, exactly like every other field here, per
   * HARD STOP 9. The 2026 08 27 live proof of JOB-227 on PostHog's SRE
   * posting is why this exists: a required "GitHub Handle" field had no
   * honest answer to give and the row landed submission_blocked.
   */
  githubUrl: string | null;
  /**
   * A short background paragraph used to answer optional open ended
   * questions about startup or entrepreneurial experience. When null, the
   * fallback path leaves the question blank rather than inventing one.
   */
  entrepreneurialBackground: string | null;
};

/**
 * The one function that decides what value goes on the form for a given
 * Ashby field, grounded in real intake. HARD STOP 9 lives here.
 *
 * Every branch either returns a value that traces to an actual stated
 * intake field (`applicationAnswers`), a fact off the person's own resume
 * or profile record (`view`), the standing V1 policy for EEO questions
 * ("Decline to Self Identify" — HARD STOP 10), or `null`. `null` skips
 * the field on the fill call, and if the field is required the caller
 * routes the row to `submission_blocked` naming the field rather than
 * inventing an answer. A boolean question whose truth is not in intake
 * returns `null`, not `true`; a work authorization question whose answer
 * is not in intake returns `null`, not "Yes"; a sponsorship question the
 * same. This is the difference between the first draft of this module,
 * which reproduced JOB-022's original bug, and the version that ships.
 *
 * Keyword matching for field title routing (name, email, phone, location,
 * sponsorship, work auth, EEO) is inherited from
 * `scripts/test-ashby-api.ts`; what changed is the value each branch
 * returns. If a keyword above matches but intake has no answer, the
 * result is `null`.
 */
export function candidateValueForField(
  field: AshbyField,
  view: AshbyCandidateView,
  applicationAnswers: CandidateApplicationAnswers,
  isRequired = false
): unknown | null {
  const t = (field.title ?? "").toLowerCase();

  if (field.path === "_systemfield_name") return view.fullName;
  if (field.path === "_systemfield_email") return view.email;
  if (field.path === "_systemfield_phone") return view.phone;
  if (field.path === "_systemfield_resume") return null;

  const isEeoTitle =
    t.includes("gender") ||
    t.includes("race") ||
    t.includes("ethnicity") ||
    t.includes("veteran") ||
    t.includes("disability") ||
    t.includes("pronouns");

  // EEO — HARD STOP 10. V1 policy: always decline, never store, never
  // infer. This is not an invention. It is the product decision the whole
  // pipeline works to.
  if (field.type === "Boolean") {
    if (isEeoTitle) return null;
    // Sponsorship / visa — only if intake carries a real answer.
    // `applicationAnswers.requiresSponsorship` is the stated fact
    // ("Will you now or in the future require sponsorship for an
    // employment visa?"). Anything else stays null → missingRequired.
    if (t.includes("sponsor") || t.includes("visa")) {
      if (typeof applicationAnswers.requiresSponsorship === "boolean") {
        return applicationAnswers.requiresSponsorship;
      }
      return null;
    }
    // Work authorization — same rule, off the stated answer.
    if (
      t.includes("authorized") ||
      t.includes("work auth") ||
      t.includes("eligible to work")
    ) {
      if (typeof applicationAnswers.workAuthorizedUs === "boolean") {
        return applicationAnswers.workAuthorizedUs;
      }
      return null;
    }
    // Relocation — same rule.
    if (t.includes("relocate") || t.includes("relocation")) {
      if (typeof applicationAnswers.willingToRelocate === "boolean") {
        return applicationAnswers.willingToRelocate;
      }
      return null;
    }
    // Every other boolean stays null. A yes/no question we cannot answer
    // from real intake becomes missingRequired when required, not a
    // guessed `true` on someone else's employer form.
    return null;
  }

  if (isEeoTitle) return "Decline to Self Identify";

  // Sponsorship / visa (string flavour). Only from real intake.
  if (t.includes("sponsor") || t.includes("visa")) {
    if (typeof applicationAnswers.requiresSponsorship === "boolean") {
      return applicationAnswers.requiresSponsorship ? "Yes" : "No";
    }
    return null;
  }

  // Work authorization (string flavour). Only from real intake.
  if (
    t.includes("authorized") ||
    t.includes("work auth") ||
    t.includes("eligible to work")
  ) {
    if (typeof applicationAnswers.workAuthorizedUs === "boolean") {
      return applicationAnswers.workAuthorizedUs ? "Yes" : "No";
    }
    return null;
  }

  // "Are you based in the US or Canada?" style. Only from stated country.
  // `US`/`USA`/`United States` count as US; Canada is not in intake and
  // is treated conservatively — a "US or Canada" question with only a
  // stated US country still answers Yes truthfully, a stated non US
  // country answers No. Anything else falls through to null.
  if (
    t.includes("us or canada") ||
    t.includes("based in us") ||
    t.includes("based in the us")
  ) {
    const country = normalizeCountry(applicationAnswers.currentCountry);
    if (country === "united states") return "Yes";
    if (country && country !== "") return "No";
    return null;
  }

  if (t.includes("first name")) return view.firstName;
  if (t.includes("last name")) return view.lastName;
  if (t.includes("full name") || t.includes("legal name")) return view.fullName;
  if (t.includes("email")) return view.email;
  if (t.includes("phone")) return view.phone;
  if (t.includes("linkedin")) return view.linkedinUrl;

  const isShortLocationField =
    t.length < 30 &&
    (t.includes("location") || t.includes("city") || t.includes("where are you"));
  const isExplicitLocationPhrase =
    t.includes("where are you located") ||
    t.includes("what is your location") ||
    t.includes("what city");
  if (isShortLocationField || isExplicitLocationPhrase) return view.location;

  // "What country do you live in?" — only from the stated country.
  if (t.includes("country") || t.includes("where are you located")) {
    return normalizedCountryDisplay(applicationAnswers.currentCountry);
  }

  // Open ended "tell us about your entrepreneurial background" — only if
  // a grounded background paragraph exists. `view.entrepreneurialBackground`
  // is deliberately null in v1 (no grounded intake column carries this
  // yet), so this branch also returns null and the field routes to
  // missingRequired when required. That is the correct v1 outcome per
  // HARD STOP 9.
  if (
    t.includes("entrepreneur") ||
    t.includes("startup") ||
    t.includes("built") ||
    t.includes("side project") ||
    t.includes("founded") ||
    t.includes("tell us more") ||
    t.includes("tell us about")
  ) {
    return view.entrepreneurialBackground;
  }

  if (t.includes("cover letter") || field.path === "cover_letter") return null;

  // GitHub (JOB-230, see the AshbyCandidateView comment above). Only from
  // the stated profile column, same as linkedin above. Not a hardcoded
  // refusal any more: null when the profile has none, the real URL when it
  // does.
  if (t.includes("github")) return view.githubUrl;

  if (
    t.includes("twitter") ||
    t.includes("portfolio") ||
    t.includes("website") ||
    t.includes("referred") ||
    t.includes("referral")
  ) {
    return null;
  }

  if (
    t.includes("salary") ||
    t.includes("compensation") ||
    t.includes("years of") ||
    t.includes("how many years") ||
    t.includes("employer") ||
    t.includes("current company") ||
    t.includes("most recent company") ||
    t.includes("mailing address") ||
    t.includes("home address") ||
    t.includes("job title")
  ) {
    return null;
  }

  // A required open ended text with no grounded source is left null so
  // the caller routes it to missingRequired. There is no fabricated
  // "background paragraph" fallback here any more. `isRequired` is
  // read for the signature contract only — the DOM path's LLM driven
  // fill layer decides what to do about a required unmapped text field;
  // this direct HTTP path stops.
  void isRequired;
  return null;
}

/** Lowercased, trimmed country string, or null when intake carried none. */
function normalizeCountry(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;
  if (trimmed === "us" || trimmed === "usa" || trimmed === "u.s." || trimmed === "u.s.a.") {
    return "united states";
  }
  return trimmed;
}

/** Human display of the stated country, or null when intake carried none. */
function normalizedCountryDisplay(input: string | undefined): string | null {
  const norm = normalizeCountry(input);
  if (norm === null) return null;
  if (norm === "united states") return "United States";
  // Title case the first letter of each word. The intake column is a
  // free text field so no assumption about capitalisation is safe.
  return norm
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// ── Context assembly ────────────────────────────────────────────────────

export type ResolvedAshbyContext = {
  jobApplicationId: string;
  ats: string;
  jobId: string;
  applyUrl: string;
  company: string;
  jobTitle: string;
  orgName: string;
  jobPostingId: string;
  origin: string;
  candidate: AshbyCandidateView;
  applicationAnswers: CandidateApplicationAnswers;
  resume: {
    bytes: Uint8Array;
    fileName: string;
    contentType: string;
  };
};

export type AshbyDirectSubmitDeps = {
  fetch?: FetchImpl;
  mintRecaptchaToken?: (url: string) => Promise<string>;
  supabase?: SupabaseClient;
  now?: () => Date;
  browserbaseSessionId?: string | null;
};

export type SubmitAshbyDirectlyInput = {
  jobApplicationId: string;
  ats: string;
  applyUrl: string;
  jobId: string;
  company: string;
  jobTitle: string;
};

function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required (see .env.example)"
    );
  }
  assertSupabaseProject(url);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function describeErrors(errors: AshbyGqlErrors): string {
  return errors
    .map((e) => `${e.message}${e.extensions?.ashbyErrorType ? ` (${e.extensions.ashbyErrorType})` : ""}`)
    .join("; ");
}

/**
 * Derives the small `AshbyCandidateView` from the fuller candidate record
 * plus the parsed resume profile. Ordering here matches what the DOM path
 * already does: the resume is the source of truth for name and phone, the
 * profile's stated email wins, and the LinkedIn URL falls back through the
 * candidate row to whatever the resume parser found. Location comes from
 * the stated current city and country when they exist.
 */
function buildCandidateView(
  candidate: CandidateRecord,
  profile: ResumeProfile
): AshbyCandidateView {
  const firstName = profile.firstName?.trim() || null;
  const lastName = profile.lastName?.trim() || null;
  const fullName =
    firstName && lastName ? `${firstName} ${lastName}` : firstName ?? lastName ?? null;
  const linkedinUrl =
    (candidate.linkedinUrl && candidate.linkedinUrl.trim()) ||
    (profile.linkedinUrl && profile.linkedinUrl.trim()) ||
    null;
  const currentCity = candidate.applicationAnswers.currentCity?.trim() ?? "";
  const currentCountry = candidate.applicationAnswers.currentCountry?.trim() ?? "";
  let location: string | null = null;
  if (currentCity && currentCountry) location = `${currentCity}, ${currentCountry}`;
  else if (currentCity) location = currentCity;
  else if (profile.location && profile.location.trim() !== "") location = profile.location.trim();
  const githubUrl = (candidate.githubUrl && candidate.githubUrl.trim()) || null;
  return {
    firstName,
    lastName,
    fullName,
    email: candidate.applicationEmail,
    phone: profile.phone?.trim() || null,
    linkedinUrl,
    location,
    githubUrl,
    // Deliberately left null in v1. The DOM path builds an entrepreneurial
    // paragraph from the resume + LLM, and reproducing that here without a
    // grounded intake field would be an invention. HARD STOP 9. A follow up
    // ticket can promote a stored answer or a profile column into this slot.
    entrepreneurialBackground: null,
  };
}

// ── The core: pure in arguments, testable ──────────────────────────────

export async function runAshbyDirectSubmit(
  ctx: ResolvedAshbyContext,
  deps: AshbyDirectSubmitDeps = {}
): Promise<SubmitApplicationResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const mint = deps.mintRecaptchaToken ?? mintAshbyRecaptchaToken;
  const supabase = deps.supabase ?? getSupabaseClient();
  const nowIso = () => (deps.now ? deps.now() : new Date()).toISOString();
  const browserbaseSessionId = deps.browserbaseSessionId ?? null;
  const { jobApplicationId } = ctx;

  /**
   * Same variable, same rule, same name as the DOM path's own
   * `submit-application.ts`: set to true on the line BEFORE the submit
   * mutation is issued, never after. Read by `blocked()` above as a
   * floor: a branch that reaches the pre submit exit after this flag has
   * flipped is routed to `unconfirmed()` instead.
   */
  let submitAttempted = false;

  console.log(
    `${LOG} Ashby direct HTTP submit — application ${jobApplicationId} at ${ctx.applyUrl} ` +
      `(org ${ctx.orgName}, job posting ${ctx.jobPostingId})`
  );

  const finish = (
    terminal: {
      status: ApplicationStatus;
      submitted: boolean;
      confirmationRef: string | null;
      blockedReason: string | null;
      unconfirmedReason: string | null;
      rowUpdated: boolean;
      submitAttempted: boolean;
    }
  ): SubmitApplicationResult => ({
    jobApplicationId,
    status: terminal.status,
    submitted: terminal.submitted,
    submitAttempted: terminal.submitAttempted,
    confirmationRef: terminal.confirmationRef,
    confirmation: null,
    securityCode: null,
    approval: {
      approved: true,
      gate: "auto",
      detail:
        "Ashby direct HTTP path (JOB-214): no browser was opened, so the review gate that runs " +
        "before the DOM click did not apply here",
    },
    submitControlLabel: "Submit (Ashby direct HTTP)",
    fill: null,
    finalUrl: ctx.applyUrl,
    pageTitle: ctx.jobTitle,
    screenshotPath: null,
    blockedReason: terminal.blockedReason,
    unconfirmedReason: terminal.unconfirmedReason,
    rowUpdated: terminal.rowUpdated,
  });

  /**
   * The pre submit exit. Same defensive guard the DOM path's `blocked()`
   * carries in `lib/submit-application.ts`: if `submitAttempted` is ever
   * true, the branch was reached after the submit mutation went out, and
   * the outcome is not safely retryable. Route to `unconfirmed()`
   * instead. Every call site today is before the submit mutation, so this
   * check is a floor against a future edit routing a post submit failure
   * into the pre submit exit and mislabelling it as safe.
   */
  const blocked = async (why: string): Promise<SubmitApplicationResult> => {
    if (submitAttempted) return await unconfirmed(why);
    const message = `submission_blocked (ashby direct http): ${why}`;
    let rowUpdated = false;
    try {
      await updateApplication(supabase, jobApplicationId, {
        status: APPLICATION_STATUS.SUBMISSION_BLOCKED,
        browserbaseSessionId,
      });
      rowUpdated = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `${LOG} could not record submission_blocked on ${jobApplicationId}: ${reason}`
      );
    }
    await recordSkipQuietly(supabase, {
      applicationId: jobApplicationId,
      jobId: ctx.jobId,
      ats: ctx.ats,
      reason: "submit_failed",
      message,
      browserbaseSessionId,
    });
    console.warn(`${LOG} ${message}`);
    return finish({
      status: APPLICATION_STATUS.SUBMISSION_BLOCKED,
      submitted: false,
      confirmationRef: null,
      blockedReason: why,
      unconfirmedReason: null,
      rowUpdated,
      submitAttempted: false,
    });
  };

  const unconfirmed = async (why: string): Promise<SubmitApplicationResult> => {
    const message = `submit_clicked_outcome_unknown (ashby direct http): ${why}`;
    let rowUpdated = false;
    try {
      await updateApplication(supabase, jobApplicationId, {
        status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
        submittedAt: nowIso(),
        browserbaseSessionId,
      });
      rowUpdated = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `${LOG} could not record submission_unconfirmed on ${jobApplicationId}: ${reason}`
      );
    }
    await recordSkipQuietly(supabase, {
      applicationId: jobApplicationId,
      jobId: ctx.jobId,
      ats: ctx.ats,
      reason: "submit_failed",
      message,
      browserbaseSessionId,
    });
    console.error(
      `${LOG} ══ SUBMIT ISSUED, OUTCOME UNKNOWN (ashby direct http) ══════════\n` +
        `${LOG} ${why}\n` +
        `${LOG} Do NOT re run this listing until a human has checked the employer's side.\n` +
        `${LOG} ═══════════════════════════════════════════════════════════════════`
    );
    return finish({
      status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
      submitted: false,
      confirmationRef: null,
      blockedReason: null,
      unconfirmedReason: why,
      rowUpdated,
      submitAttempted: true,
    });
  };

  const succeed = async (): Promise<SubmitApplicationResult> => {
    const confirmationRef = "ashby: FormSubmitSuccess (direct http)";
    let rowUpdated = false;
    try {
      await updateApplication(supabase, jobApplicationId, {
        status: APPLICATION_STATUS.SUBMITTED,
        confirmationText: confirmationRef,
        submittedAt: nowIso(),
        browserbaseSessionId,
      });
      rowUpdated = true;
      console.log(`${LOG} applications ${jobApplicationId} → submitted (Ashby direct HTTP)`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `${LOG} the application WAS submitted but recording submitted on ${jobApplicationId} ` +
          `failed: ${reason}. Not retrying anything.`
      );
    }
    return finish({
      status: APPLICATION_STATUS.SUBMITTED,
      submitted: true,
      confirmationRef,
      blockedReason: null,
      unconfirmedReason: null,
      rowUpdated,
      submitAttempted: true,
    });
  };

  // ── 1. Discover the form ────────────────────────────────────────────
  let form: AshbyDiscoveredForm;
  try {
    form = await discoverForm(fetchImpl, ctx.origin, ctx.orgName, ctx.jobPostingId);
  } catch (err) {
    return await blocked(
      `could not discover the Ashby application form for ${ctx.applyUrl}: ` +
        `${err instanceof Error ? err.message : String(err)}. Nothing was sent.`
    );
  }

  const allEntries = form.sections.flatMap((s) => s.fieldEntries ?? []).filter((e) => !e.isHidden);
  const fileEntries = allEntries.filter(
    (e) =>
      e.field?.type === "File" ||
      e.field?.type === "FileList" ||
      e.field?.path === "_systemfield_resume"
  );
  const valueEntries = allEntries.filter(
    (e) =>
      e.field?.path !== "_systemfield_resume" &&
      e.field?.type !== "File" &&
      e.field?.type !== "FileList"
  );

  // JOB-227. The render identifier every mutation from here on uses.
  // Starts as what discovery returned and advances after every
  // `setFieldValue` / `setFileFieldValue` call that comes back with a
  // fresher one — see the module header and `setFieldValue`'s own comment
  // for why this exists. `submitForm` below reads whatever this holds by
  // the time it runs, not `form.formRenderIdentifier` directly.
  let frid = form.formRenderIdentifier;

  // ── 2. Upload the resume, when the form has a resume slot ──────────
  if (fileEntries.length === 0) {
    console.log(`${LOG} discovered form has no file field — skipping resume upload`);
  } else {
    let handleInfo: { handle: string; url: string; fields: Record<string, string> };
    try {
      handleInfo = await createUploadHandle(
        fetchImpl,
        ctx.origin,
        ctx.orgName,
        ctx.resume.fileName,
        ctx.resume.contentType,
        ctx.resume.bytes.byteLength
      );
    } catch (err) {
      return await blocked(
        `Ashby refused to mint a file upload handle: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      await uploadResumeToS3(
        fetchImpl,
        { url: handleInfo.url, fields: handleInfo.fields },
        ctx.resume.bytes,
        ctx.resume.fileName,
        ctx.resume.contentType
      );
    } catch (err) {
      return await blocked(
        `resume upload to S3 failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    for (const entry of fileEntries) {
      try {
        const result = await setFileFieldValue(
          fetchImpl,
          ctx.origin,
          ctx.orgName,
          frid,
          form.formDefinitionIdentifier,
          entry.field.path,
          handleInfo.handle
        );
        frid = result.nextFrid;
      } catch (err) {
        return await blocked(
          `could not attach the uploaded resume to Ashby field ${JSON.stringify(entry.field.path)}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // ── 3. Fill value fields ────────────────────────────────────────────
  const missingRequired: string[] = [];
  for (const entry of valueEntries) {
    const value = candidateValueForField(
      entry.field,
      ctx.candidate,
      ctx.applicationAnswers,
      entry.isRequired
    );
    if (value === null || value === undefined) {
      if (entry.isRequired) missingRequired.push(entry.field.title);
      continue;
    }
    try {
      const result = await setFieldValue(
        fetchImpl,
        ctx.origin,
        ctx.orgName,
        frid,
        form.formDefinitionIdentifier,
        entry.field.path,
        value
      );
      frid = result.nextFrid;
    } catch (err) {
      return await blocked(
        `could not set Ashby field ${JSON.stringify(entry.field.title)}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (missingRequired.length > 0) {
    // HARD STOP 9. A required field with no grounded intake answer is
    // filed here rather than filled with a guess, and the field names
    // travel into the skip_log message so the operator sees what to
    // add to intake before this row is re run.
    return await blocked(
      `required Ashby field(s) had no grounded intake answer and this module refuses to ` +
        `invent one on a real employer submission (HARD STOP 9): ` +
        JSON.stringify(missingRequired) +
        `. Nothing was submitted. Fill the missing intake column(s) and re run.`
    );
  }

  // ── 4. Mint the reCAPTCHA token ─────────────────────────────────────
  let recaptchaToken: string;
  try {
    recaptchaToken = await mint(ctx.applyUrl);
  } catch (err) {
    return await blocked(
      `could not mint an Ashby reCAPTCHA token before submit: ` +
        `${err instanceof Error ? err.message : String(err)}. Nothing was sent.`
    );
  }
  if (!recaptchaToken || typeof recaptchaToken !== "string") {
    return await blocked(
      `reCAPTCHA harvester returned a non string token, refusing to submit. Nothing was sent.`
    );
  }

  // ── 5. Submit — the point of no return ───────────────────────────────
  // Everything below crosses the boundary Ashby's own server may already
  // have logged as an application. If the submit call throws, or comes
  // back with a `gql_errors` shape whose body cannot be interpreted as
  // "no application was created", this row lands as submission_unconfirmed
  // and never automatically retries.
  console.log(`${LOG} calling ApiSubmitSingleApplicationFormAction — point of no return`);
  submitAttempted = true;
  let outcome: AshbySubmitOutcome;
  try {
    outcome = await submitForm(fetchImpl, ctx.origin, {
      orgName: ctx.orgName,
      jobPostingId: ctx.jobPostingId,
      // JOB-227: whatever `frid` holds by now, not the value discovery
      // returned. See the comment where `frid` is declared above.
      frid,
      formDefId: form.formDefinitionIdentifier,
      actionIdentifier: form.actionIdentifier,
      recaptchaToken,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await unconfirmed(
      `Ashby submit mutation threw part way through: ${reason}. Whether an application now ` +
        `exists at the employer is unknown.`
    );
  }

  switch (outcome.kind) {
    case "success":
      return await succeed();
    case "gql_errors":
      return await unconfirmed(
        `Ashby submit answered with GraphQL errors: ${describeErrors(outcome.errors)}. The ` +
          `application may or may not have been recorded at the employer's side.`
      );
    case "form_render":
      return await unconfirmed(
        `Ashby returned FormRender after submit rather than FormSubmitSuccess ` +
          `(errorMessages: ${JSON.stringify(outcome.errorMessages)}; ` +
          `formErrors: ${JSON.stringify(outcome.formErrors)}). The submit mutation was issued ` +
          `and its side effect at the employer is not known.`
      );
    case "unexpected_shape":
      return await unconfirmed(
        `Ashby submit returned a shape this module does not recognise. Not retrying.`
      );
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unreachable: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ── Public entry: reads Supabase, resolves context, runs submit ─────────

export async function submitAshbyApplicationDirectly(
  input: SubmitAshbyDirectlyInput,
  deps: AshbyDirectSubmitDeps = {}
): Promise<SubmitApplicationResult> {
  const supabase = deps.supabase ?? getSupabaseClient();
  const parsedUrl = parseAshbyUrl(input.applyUrl);

  // Read the row's user id and its current status. Preflight in
  // `submit-application.ts` already refuses `submitted` and
  // `submission_unconfirmed` before this function is ever called from
  // the mode selector, but this direct path also has to be safe when
  // invoked from a CLI or a test that has not run that preflight. So
  // the guard is repeated here — defence in depth, matching the same
  // rule ACT-007's `READY_STATUSES` enforces from the other direction.
  const { data: rows, error } = await supabase
    .from("applications")
    .select("user_id,status")
    .eq("id", input.jobApplicationId)
    .limit(1);
  if (error) throw new Error(`applications lookup failed: ${error.message}`);
  const row = rows?.[0];
  if (!row) {
    throw new Error(
      `applications ${input.jobApplicationId} not found; cannot run Ashby direct HTTP submit against a missing row.`
    );
  }
  const status = String(row.status ?? "");
  if (status === APPLICATION_STATUS.SUBMITTED) {
    throw new Error(
      `applications ${input.jobApplicationId} is already at "${APPLICATION_STATUS.SUBMITTED}". ` +
        `The Ashby direct HTTP path refuses to submit a second application against a row that ` +
        `has already been sent to the employer. There is no version of this that is worth ` +
        `risking a duplicate under a real candidate's name.`
    );
  }
  if (status === APPLICATION_STATUS.SUBMISSION_UNCONFIRMED) {
    throw new Error(
      `applications ${input.jobApplicationId} is at ` +
        `"${APPLICATION_STATUS.SUBMISSION_UNCONFIRMED}". An earlier run issued a submit against ` +
        `this row and could not confirm the outcome. A human has to check the employer's side ` +
        `before anything submits here again. Nothing was sent.`
    );
  }
  const userId = row.user_id;
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error(
      `applications ${input.jobApplicationId} has no user_id; cannot load candidate for Ashby direct HTTP submit.`
    );
  }

  const candidate = await loadCandidate(userId);
  const resume = await loadResume(supabase, candidate.resumeUrl);
  const profile = await resolveCandidateProfile(
    supabase,
    {
      resumeId: candidate.resumeId,
      resumePath: candidate.resumeUrl,
      linkedinPdfPath: candidate.linkedinPdfPath,
    },
    resume.text,
    // `resolveCandidateProfile` reads the resume parser's smaller shape of
    // CandidateRecord (id, applicationEmail, linkedinUrl, githubUrl) rather
    // than the full intake record. Same mapping the fill layer does at its
    // own resolveCandidateProfile call site in `lib/fill-application-form.ts`.
    {
      id: userId,
      applicationEmail: candidate.applicationEmail,
      linkedinUrl: candidate.linkedinUrl,
      githubUrl: candidate.githubUrl,
    }
  );

  const view = buildCandidateView(candidate, profile);

  const resumeFileName = deriveResumeFileName(candidate.resumeUrl, view.fullName);
  const ctx: ResolvedAshbyContext = {
    jobApplicationId: input.jobApplicationId,
    ats: input.ats,
    jobId: input.jobId,
    applyUrl: input.applyUrl,
    company: input.company,
    jobTitle: input.jobTitle,
    orgName: parsedUrl.orgName,
    jobPostingId: parsedUrl.jobPostingId,
    origin: parsedUrl.origin,
    candidate: view,
    applicationAnswers: candidate.applicationAnswers,
    resume: {
      bytes: resume.bytes,
      fileName: resumeFileName,
      contentType: "application/pdf",
    },
  };

  return await runAshbyDirectSubmit(ctx, { ...deps, supabase });
}

function deriveResumeFileName(resumeUrl: string, fullName: string | null): string {
  // A conservative default that reads as a real filename on an S3 upload.
  // The exact name Ashby stores is not observable back to us; a human name
  // is only useful in the recruiter's inbox, so keep it plain when the
  // profile does not have a name yet.
  const base = fullName ? fullName.replace(/[^a-z0-9]+/gi, "_") : "resume";
  // If the storage path carried an extension use it, otherwise assume .pdf
  // because the resume loader already validates the PDF magic bytes.
  const extMatch = /\.(pdf|docx?)$/i.exec(resumeUrl);
  const ext = extMatch ? extMatch[1].toLowerCase() : "pdf";
  return `${base}.${ext}`;
}

// ── JOB-232: SolverFn shim ──────────────────────────────────────────────────

/**
 * Presents `submitAshbyApplicationDirectly` as a `SolverFn` so the registry
 * in `lib/solvers/index.ts` can hold it next to every future dedicated
 * solver. Purely a shape adapter: it reads the six fields
 * `SubmitAshbyDirectlyInput` needs off `input` and the row `submitApplication`
 * already preflighted, and calls straight through. Nothing above this line
 * changed to make this possible.
 */
export const ashbyDirectSolver: SolverFn = async (input, row) =>
  submitAshbyApplicationDirectly({
    jobApplicationId: input.jobApplicationId,
    ats: row.ats,
    applyUrl: row.applyUrl,
    jobId: row.jobId,
    company: row.company,
    jobTitle: row.jobTitle,
  });
