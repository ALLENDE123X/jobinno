#!/usr/bin/env -S npx tsx
/**
 * Test script: Ashby direct GraphQL API submission running inside a Browserbase session.
 *
 * Opens a real Browserbase session, navigates to any Ashby job board, discovers form
 * fields via the non-user GraphQL API, fills them, and submits — without clicking
 * through the React UI.
 *
 * API notes (from reverse-engineering jobs.ashbyhq.com):
 *  - FRID = applicationForm.id from ApiJobPosting (minted fresh per query call)
 *  - actionIdentifier = formControls[title=Submit].identifier from same query
 *  - File upload: createFileUploadHandle(fileUploadContext: NonUserFormEngine, ...)
 *    returns { handle url fields }; pass handle to setFormValueToFile
 *  - Standard paths: _systemfield_name, _systemfield_email, _systemfield_resume
 *  - setFormValue / setFormValueToFile arg name is "path", not "fieldPath"
 *  - Submit operation: ApiSubmitSingleApplicationFormAction
 *
 * Usage:
 *   npm run test:ashby -- \
 *     --url https://jobs.ashbyhq.com/<org>/<job-id> \
 *     [--dry-run]              (fill all fields but do NOT hit submit)
 *     [--resume /path/to.pdf]  (default: ~/Downloads/Profile.pdf)
 *
 * Exit codes:
 *   0  submitted (or dry-run completed)
 *   2  required field missing / form validation blocked — nothing sent
 *   3  submit was clicked, outcome unknown — do not re-run
 *   1  unexpected error before anything was clicked
 */

import { config } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

import {
  openBrowserSession,
  closeBrowserSession,
} from "@/lib/stagehand-session";

// ── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const arg = (f: string) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : undefined; };

const jobUrl = arg("--url");
const dryRun = flag("--dry-run");
const noContext = flag("--no-context");
const useProxies = flag("--proxies");
const resumePath = arg("--resume") ??
  resolve(process.env.HOME ?? "/Users/pranavlende", "Downloads/Profile.pdf");

if (!jobUrl) {
  console.error("Usage: npm run test:ashby -- --url <jobs.ashbyhq.com/org/id> [--dry-run]");
  process.exit(1);
}

// ── Candidate ────────────────────────────────────────────────────────────────

const CANDIDATE = {
  name: "Pranav Lende",
  firstName: "Pranav",
  lastName: "Lende",
  email: "pranavlende123@gmail.com",
  phone: "404-444-6018",
  linkedin: "https://www.linkedin.com/in/pranavlende",
  location: "Atlanta, GA",
  entrepreneurial:
    "I co-founded two ventures while studying at Georgia Tech — a B2B SaaS tool for restaurant inventory management and an AI-powered recruiting platform. Both gave me hands-on experience shipping product under resource constraints and iterating quickly on user feedback.",
};

const ASHBY_RECAPTCHA_SITE_KEY = "6LeFb_YUAAAAALUD5h-BiQEp8JaFChe0e0A6r49Y";
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY ?? "";

type SubmitGqlResponse = {
  data?: {
    submitApplicationFormAction?: {
      applicationFormResult?: {
        __typename: string;
        errorMessages?: string[];
        formErrors?: { message: string; fieldEntryId: string }[];
      };
    };
  };
  errors?: { message: string; extensions?: { ashbyErrorType?: string } }[];
};

// ── 2captcha reCAPTCHA v3 solver ──────────────────────────────────────────────

async function solve2captchaRecaptchaV3(pageUrl: string): Promise<string> {
  if (!TWOCAPTCHA_API_KEY) throw new Error("TWOCAPTCHA_API_KEY not set");

  // Submit task
  const inUrl = new URL("https://2captcha.com/in.php");
  inUrl.searchParams.set("key", TWOCAPTCHA_API_KEY);
  inUrl.searchParams.set("method", "userrecaptcha");
  inUrl.searchParams.set("googlekey", ASHBY_RECAPTCHA_SITE_KEY);
  inUrl.searchParams.set("pageurl", pageUrl);
  inUrl.searchParams.set("version", "v3");
  inUrl.searchParams.set("action", "submit");
  inUrl.searchParams.set("min_score", "0.9");
  inUrl.searchParams.set("json", "1");

  const inRes = await fetch(inUrl.toString());
  const inData = await inRes.json() as { status: number; request: string };
  if (inData.status !== 1) throw new Error(`2captcha submit failed: ${inData.request}`);
  const taskId = inData.request;
  console.log(`  2captcha task ${taskId} submitted, polling...`);

  // Poll for result (2captcha says wait ~20s before first poll)
  await new Promise(r => setTimeout(r, 20_000));
  for (let attempt = 0; attempt < 20; attempt++) {
    const resUrl = `https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=get&id=${taskId}&json=1`;
    const resRes = await fetch(resUrl);
    const resData = await resRes.json() as { status: number; request: string };
    if (resData.status === 1) return resData.request;
    if (resData.request !== "CAPCHA_NOT_READY") {
      throw new Error(`2captcha error: ${resData.request}`);
    }
    await new Promise(r => setTimeout(r, 5_000));
  }
  throw new Error("2captcha timed out after 120s");
}

// ── GraphQL helpers ───────────────────────────────────────────────────────────

// Non-user GQL lives on the board's own origin, not a central API host.
const GQL_ENDPOINT = `${new URL(jobUrl!).origin}/api/non-user-graphql`;

function apolloHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "apollographql-client-name": "frontend_non_user",
    "apollographql-client-version": "0.1.0",
    "x-ashby-client-request-timestamp": new Date().toISOString(),
  };
}

async function gql(op: string, query: string, variables: Record<string, unknown>) {
  const resp = await fetch(`${GQL_ENDPOINT}?op=${op}`, {
    method: "POST",
    headers: apolloHeaders(),
    body: JSON.stringify({ operationName: op, query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`[ashby] ${op} HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
  }
  const body = await resp.json();
  if (body.errors?.length) {
    throw new Error(`[ashby] ${op} GQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}

// ── Form discovery ────────────────────────────────────────────────────────────

interface AshbyField {
  path: string;
  title: string;
  type: string;
}

interface AshbyFieldEntry {
  id: string;
  isRequired: boolean;
  isHidden: boolean;
  field: AshbyField;
}

interface AshbyFormData {
  id: string;                           // → formRenderIdentifier
  sourceFormDefinitionId: string;       // → formDefinitionIdentifier in mutations
  formControls: Array<{ identifier: string; title: string }>;
  sections: Array<{
    title: string;
    fieldEntries: AshbyFieldEntry[];
  }>;
}

async function discoverForm(orgName: string, jobPostingId: string) {
  const data = await gql(
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
    { organizationHostedJobsPageName: orgName, jobPostingId },
  );
  if (!data.jobPosting) {
    throw new Error(
      `Job posting not found: org="${orgName}" id="${jobPostingId}". ` +
      `The listing may be closed or the URL may be wrong.`,
    );
  }
  return data.jobPosting as {
    id: string;
    title: string;
    applicationForm: AshbyFormData;
  };
}

// ── File upload ───────────────────────────────────────────────────────────────

async function createUploadHandle(
  orgName: string,
  fileName: string,
  contentType: string,
  contentLength: number,
) {
  const data = await gql(
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
    },
  );
  return data.fileUploadHandle as { handle: string; url: string; fields: Record<string, string> };
}

async function uploadToS3(
  url: string,
  fields: Record<string, string>,
  fileBuffer: Buffer,
  fileName: string,
  contentType: string,
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("Content-Type", contentType);
  form.append("file", new Blob([fileBuffer], { type: contentType }), fileName);
  const resp = await fetch(url, { method: "POST", body: form });
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`[ashby] S3 upload failed: ${resp.status} ${await resp.text().catch(() => "")}`);
  }
}

// ── Field filling ─────────────────────────────────────────────────────────────

async function setFieldValue(
  orgName: string,
  frid: string,
  formDefinitionIdentifier: string,
  path: string,
  value: unknown,
) {
  const data = await gql(
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
      formDefinitionIdentifier,
      path,
      value,
    },
  );
  const errors: string[] = data.setFormValue?.errorMessages ?? [];
  if (errors.length) console.warn(`  ⚠ setFormValue(${path}):`, errors.join(", "));
  return data.setFormValue;
}

async function setFileField(
  orgName: string,
  frid: string,
  formDefinitionIdentifier: string,
  path: string,
  fileHandle: string,
) {
  const data = await gql(
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
      formDefinitionIdentifier,
      path,
      fileHandle,
    },
  );
  const errors: string[] = data.setFormValueToFile?.errorMessages ?? [];
  if (errors.length) console.warn(`  ⚠ setFormValueToFile(${path}):`, errors.join(", "));
  return data.setFormValueToFile;
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function submitForm(
  orgName: string,
  jobPostingId: string,
  frid: string,
  formDefinitionIdentifier: string,
  actionIdentifier: string,
  recaptchaToken: string,
) {
  const data = await gql(
    "ApiSubmitSingleApplicationFormAction",
    `mutation ApiSubmitSingleApplicationFormAction(
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
    {
      organizationHostedJobsPageName: orgName,
      jobPostingId,
      formRenderIdentifier: frid,
      formDefinitionIdentifier,
      actionIdentifier,
      recaptchaToken,
    },
  );
  return data.submitApplicationFormAction?.applicationFormResult as {
    __typename: string;
    id?: string;
    errorMessages?: string[];
    formErrors?: Array<{ message: string; fieldEntryId: string }>;
  };
}

// ── Field value mapping ───────────────────────────────────────────────────────

function candidateValueForField(field: AshbyField, isRequired = false): unknown | null {
  const t = (field.title ?? "").toLowerCase();

  // Standard system fields (matched by path prefix)
  if (field.path === "_systemfield_name") return CANDIDATE.name;
  if (field.path === "_systemfield_email") return CANDIDATE.email;
  if (field.path === "_systemfield_phone") return CANDIDATE.phone;
  if (field.path === "_systemfield_resume") return null; // handled via file upload

  // Boolean-typed questions are resolved here, before any keyword branch
  // below gets a chance to match on incidental substrings in a yes/no
  // question's title — e.g. "...work in one of these locations?" tripping
  // the location branch, or "...you'll receive an email..." tripping the
  // email branch. Every Boolean field returns from this block; nothing
  // later in the function ever sees one.
  if (field.type === "Boolean") {
    if (
      t.includes("gender") || t.includes("race") || t.includes("ethnicity") ||
      t.includes("veteran") || t.includes("disability") || t.includes("pronouns")
    ) {
      // No true/false equivalent of "decline to self identify" — leave
      // unset rather than invent a yes/no on a demographic question.
      return null;
    }
    if (t.includes("sponsor") || t.includes("visa")) {
      return false;
    }
    return true;
  }

  // EEO — HARD STOP: always decline. Checked before the generic keyword
  // branches below so a question like "...gender identity..." can't be
  // caught by some unrelated substring first.
  if (
    t.includes("gender") || t.includes("race") || t.includes("ethnicity") ||
    t.includes("veteran") || t.includes("disability") || t.includes("pronouns")
  ) {
    return "Decline to Self Identify";
  }

  // Work auth / visa / sponsorship — checked before the generic "location"
  // branch below, because a sponsorship or work-auth question routinely
  // contains the word "location" itself (e.g. "...work in your desired
  // location?"), which would otherwise match the location branch first and
  // answer a yes/no sponsorship question with a city name.
  if (t.includes("sponsor") || t.includes("visa")) {
    return "No";
  }
  if (t.includes("authorized") || t.includes("work auth") || t.includes("eligible to work")) {
    return "Yes";
  }
  if (t.includes("us or canada") || t.includes("based in us") || t.includes("based in the us")) {
    return "Yes";
  }

  // Name variants by title
  if (t.includes("first name")) return CANDIDATE.firstName;
  if (t.includes("last name")) return CANDIDATE.lastName;
  if (t.includes("full name") || t.includes("legal name")) return CANDIDATE.name;
  if (t.includes("email")) return CANDIDATE.email;
  if (t.includes("phone")) return CANDIDATE.phone;
  if (t.includes("linkedin")) return CANDIDATE.linkedin;
  // Matched narrowly to avoid hijacking longer compound questions that merely
  // mention "location" in passing — seen live: a hybrid-work-model question
  // ("...able to work in person 3 days per week?") and a sponsorship question
  // both contain "location" and got wrongly answered with a city name instead
  // of their real answer. A short field title bare-matching is safe (that's
  // the whole question); a longer one needs a specific, unambiguous phrase.
  const isShortLocationField = t.length < 30 &&
    (t.includes("location") || t.includes("city") || t.includes("where are you"));
  const isExplicitLocationPhrase =
    t.includes("where are you located") || t.includes("what is your location") || t.includes("what city");
  if (isShortLocationField || isExplicitLocationPhrase) {
    return CANDIDATE.location;
  }

  // Country / location
  if (t.includes("country") || t.includes("where are you located")) return "United States";

  // Background / open-ended questions
  if (
    t.includes("entrepreneur") || t.includes("startup") || t.includes("built") ||
    t.includes("side project") || t.includes("founded") || t.includes("tell us more") ||
    t.includes("tell us about")
  ) {
    return CANDIDATE.entrepreneurial;
  }

  // Cover letter — skip
  if (t.includes("cover letter") || field.path === "cover_letter") return null;

  // Twitter / social handles, referrals — skip
  if (t.includes("twitter") || t.includes("github") || t.includes("portfolio") ||
      t.includes("website") || t.includes("referred") || t.includes("referral")) {
    return null;
  }

  // Structured factual questions — a specific number or figure is expected, and
  // the generic background paragraph below would be nonsensical here (seen live:
  // "What is your desired salary range?" got answered with an engineering-bio
  // paragraph). No real intake data for these, so flag as missing rather than
  // invent a number, salary figure, employer name, or address.
  if (
    t.includes("salary") || t.includes("compensation") || t.includes("years of") ||
    t.includes("how many years") || t.includes("employer") || t.includes("current company") ||
    t.includes("most recent company") || t.includes("mailing address") || t.includes("home address") ||
    t.includes("job title")
  ) {
    return null;
  }

  // Fallback for required open-ended text questions: provide a relevant generic answer.
  // Optional fields that don't match are left blank (null → skipped by caller).
  if (isRequired && (field.type === "String" || field.type === "LongText" || field.type === "Text")) {
    return (
      "I have a strong background in software engineering and data systems, with experience " +
      "building scalable products and working cross-functionally to drive business outcomes " +
      "through data-informed decisions."
    );
  }

  return null;
}

// ── Browserbase context (persists fingerprint/cookies across runs) ─────────────

const BB_CONTEXT_CACHE = resolve(process.env.HOME ?? "/tmp", ".ashby-test-bb-context");

async function getOrCreateContextId(): Promise<string | undefined> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) return undefined;
  if (process.env.BROWSERBASE_CONTEXTS_ENABLED !== "1") return undefined;

  try {
    const stored = (await readFile(BB_CONTEXT_CACHE, "utf8")).trim();
    if (stored) {
      console.log(`Using cached Browserbase context: ${stored.slice(0, 8)}…`);
      return stored;
    }
  } catch { /* no cache yet */ }

  console.log("Creating new Browserbase context…");
  const res = await fetch("https://api.browserbase.com/v1/contexts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BB-API-Key": apiKey },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) throw new Error(`Context creation HTTP ${res.status}: ${await res.text()}`);
  const { id } = await res.json() as { id: string };
  await writeFile(BB_CONTEXT_CACHE, id, "utf8");
  console.log(`Created Browserbase context: ${id.slice(0, 8)}…`);
  return id;
}

// ── URL parsing ───────────────────────────────────────────────────────────────

function parseAshbyUrl(url: string): { orgName: string; jobPostingId: string } {
  const u = new URL(url);
  if (u.hostname === "jobs.ashbyhq.com") {
    const [orgName, jobPostingId] = u.pathname.split("/").filter(Boolean);
    if (orgName && jobPostingId) return { orgName, jobPostingId };
  }
  throw new Error(
    `Cannot parse org/job-id from "${url}". Supported: https://jobs.ashbyhq.com/<org>/<job-id>`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════════");
  console.log("  Ashby API test — Jobinno / Browserbase");
  console.log("══════════════════════════════════════════");
  console.log(`URL:      ${jobUrl}`);
  console.log(`Dry run:  ${dryRun}`);
  console.log(`Resume:   ${resumePath}`);

  const { orgName, jobPostingId } = parseAshbyUrl(jobUrl!);
  console.log(`Org: ${orgName}  |  Job ID: ${jobPostingId}\n`);

  const contextId = noContext ? undefined : await getOrCreateContextId();

  const session = await openBrowserSession({
    logTag: "[ashby-test]",
    disableProxies: !useProxies,
    headless: true,
    contextId,
  });

  try {
    const { page, stagehand } = session;

    // Warm up: visit Google first so the context accumulates some legitimate
    // browse history before hitting Ashby's reCAPTCHA v3 scorer.
    if (contextId) {
      console.log("Warming up context with Google visit…");
      await page.goto("https://www.google.com", { waitUntil: "networkidle", timeout: 30_000 });
      await new Promise(r => setTimeout(r, 3_000));
    }

    console.log(`Navigating to ${jobUrl} ...`);
    await page.goto(jobUrl!, { waitUntil: "networkidle", timeout: 45_000 });
    await new Promise(r => setTimeout(r, 5_000));

    // ── Form discovery ──────────────────────────────────────────────────────
    console.log("Discovering form via ApiJobPosting...");
    const { title: jobTitle, applicationForm } = await discoverForm(orgName, jobPostingId);

    // FRID and actionIdentifier come from the ApiJobPosting response — both are
    // minted fresh by the server on each call; never generate a random UUID for FRID.
    const frid = applicationForm.id;
    const formDefinitionIdentifier = applicationForm.sourceFormDefinitionId;
    const actionIdentifier = applicationForm.formControls
      .find(c => c.title === "Submit")?.identifier ?? "";

    console.log(`Job:              ${jobTitle}`);
    console.log(`FRID:             ${frid}`);
    console.log(`formDefId:        ${typeof formDefinitionIdentifier === "string" ? formDefinitionIdentifier.slice(0, 60) : JSON.stringify(formDefinitionIdentifier).slice(0, 60)}`);
    console.log(`actionIdentifier: ${actionIdentifier}\n`);

    if (!actionIdentifier) {
      throw new Error("Could not find Submit formControl — cannot submit without actionIdentifier");
    }

    const allEntries = applicationForm.sections.flatMap(s => s.fieldEntries ?? [])
      .filter(e => !e.isHidden);
    const fileEntries = allEntries.filter(
      e => e.field?.type === "File" || e.field?.type === "FileList" ||
           e.field?.path === "_systemfield_resume",
    );
    const valueEntries = allEntries.filter(
      e => e.field?.path !== "_systemfield_resume" &&
           e.field?.type !== "File" && e.field?.type !== "FileList",
    );
    console.log(`Fields: ${allEntries.length} total (${fileEntries.length} file, ${valueEntries.length} value)`);
    console.log("Sections:", applicationForm.sections.map(s => s.title).join(", "), "\n");

    // ── Open application form in browser ────────────────────────────────────
    // Let Stagehand drive the full form fill + submit so Ashby's own JS handles
    // reCAPTCHA natively, with real interaction signals over the filling period.
    console.log("\nClicking Apply in browser...");
    await stagehand.act("click the Apply button to open the application form", { page });
    await new Promise(r => setTimeout(r, 3_000));

    // Resume — set via the file input directly (stagehand can't upload files).
    // The form can take a few seconds to mount after Apply is clicked, so poll
    // rather than checking once — a required resume silently left unattached
    // would otherwise submit a real application with no resume on it.
    console.log("Attaching resume via file input...");
    const fileInput = page.locator('input[type="file"]').first();
    let fileInputReady = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (await fileInput.count() > 0) { fileInputReady = true; break; }
      await new Promise(r => setTimeout(r, 1_500));
    }
    if (fileInputReady) {
      await fileInput.setInputFiles(resumePath);
      await new Promise(r => setTimeout(r, 2_000));
      console.log("  ✓ Resume attached\n");
    } else if (fileEntries.length > 0) {
      throw new Error(
        "No file input appeared for the resume field after 12s — refusing to submit an " +
          "application with no resume attached.",
      );
    } else {
      console.log("  · no resume field on this form\n");
    }

    // ── Text / boolean fields ────────────────────────────────────────────────
    console.log("Filling form fields via Stagehand:");
    const missingRequired: string[] = [];

    for (const entry of valueEntries) {
      const { title: ft, type } = entry.field;

      const value = candidateValueForField(entry.field, entry.isRequired);
      if (value === null) {
        if (entry.isRequired) {
          console.warn(`  ✗ REQUIRED, no value: "${ft}"`);
          missingRequired.push(ft);
        } else {
          console.log(`  · skip optional: "${ft}"`);
        }
        continue;
      }

      if (type === "Boolean") {
        const label = value ? "Yes" : "No";
        await stagehand.act(
          `For the question "${ft}", click the option for "${label}"`,
          { page },
        );
      } else {
        await stagehand.act(
          `Fill the field labeled "${ft}" with: ${String(value)}`,
          { page },
        );
      }
      console.log(`  ✓ ${ft} (${type}): ${JSON.stringify(value).slice(0, 60)}`);
    }

    if (missingRequired.length > 0) {
      console.error(`\n✗ ${missingRequired.length} required field(s) have no mapped value:`);
      missingRequired.forEach(f => console.error(`  - ${f}`));
      console.error("\nAdd them to candidateValueForField() and re-run.\n");
      process.exitCode = 2;
      return;
    }

    // ── Submit ──────────────────────────────────────────────────────────────
    if (dryRun) {
      console.log("\n✓ Dry run complete — all fields filled via browser, submit skipped.\n");
      return;
    }

    console.log("\nClicking Submit via Stagehand (Ashby JS handles reCAPTCHA natively)...");
    process.exitCode = 3;

    // Screen-scraping the post-click page text to guess success/failure proved
    // unreliable — it misread at least one genuinely successful Ramp submission
    // as a reCAPTCHA rejection. Stagehand's remote Page type exposes no network
    // interception (only a "console" event), so instead we patch window.fetch
    // from inside the page to capture Ashby's own submit response — the same
    // authoritative JSON our earlier direct-GQL calls used.
    await page.evaluate(`
      window.__ashbySubmitResult = null;
      var origFetch = window.fetch;
      window.fetch = function() {
        var args = arguments;
        return origFetch.apply(this, args).then(function(res) {
          var url = (args[0] && args[0].url) ? args[0].url : String(args[0]);
          if (url.indexOf("op=ApiSubmitSingleApplicationFormAction") !== -1) {
            res.clone().json().then(function(data) {
              window.__ashbySubmitResult = data;
            }).catch(function() {});
          }
          return res;
        });
      };
      // Some Ashby board bundle versions use XMLHttpRequest instead of fetch —
      // observed directly: the fetch patch above caught nothing on at least two
      // live boards even though a real submit attempt happened. Patch both so
      // detection doesn't depend on which transport a given board's bundle uses.
      var OrigXHR = window.XMLHttpRequest;
      var origOpen = OrigXHR.prototype.open;
      var origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function(method, url) {
        this.__ashbyUrl = url;
        return origOpen.apply(this, arguments);
      };
      OrigXHR.prototype.send = function() {
        var xhr = this;
        if (xhr.__ashbyUrl && String(xhr.__ashbyUrl).indexOf("op=ApiSubmitSingleApplicationFormAction") !== -1) {
          xhr.addEventListener("load", function() {
            try { window.__ashbySubmitResult = JSON.parse(xhr.responseText); } catch (e) {}
          });
        }
        return origSend.apply(this, arguments);
      };
    `);

    await stagehand.act("click the Submit application button", { page });

    const submitJson = await (async (): Promise<SubmitGqlResponse | null> => {
      for (let attempt = 0; attempt < 15; attempt++) {
        const result = await page.evaluate(`window.__ashbySubmitResult`) as SubmitGqlResponse | null;
        if (result) return result;
        await new Promise(r => setTimeout(r, 1_000));
      }
      return null;
    })();

    if (!submitJson) {
      console.log("? Submit clicked — no matching fetch response observed within 15s.");
      console.log("  Check Gmail/Supabase directly to confirm the outcome; do not re-run.");
      return;
    }

    const appResult = submitJson.data?.submitApplicationFormAction?.applicationFormResult;
    const gqlErrors = submitJson.errors;

    if (gqlErrors?.length) {
      const reasons = gqlErrors.map((e: { message: string; extensions?: { ashbyErrorType?: string } }) => `${e.message}${e.extensions?.ashbyErrorType ? ` (${e.extensions.ashbyErrorType})` : ""}`).join("; ");
      console.error(`✗ Submit blocked: ${reasons}`);
      process.exitCode = 2;
    } else if (appResult?.__typename === "FormSubmitSuccess") {
      console.log("✓ Application submitted!\n");
      process.exitCode = 0;
    } else {
      const errs = [
        ...(appResult?.errorMessages ?? []),
        ...(appResult?.formErrors?.map(e => `${e.message} (field: ${e.fieldEntryId})`) ?? []),
      ].join("; ") || "unknown — no error but no FormSubmitSuccess either";
      console.error(`✗ Submit blocked: ${errs}`);
      console.error("Full result:", JSON.stringify(appResult, null, 2));
      process.exitCode = 2;
    }
  } finally {
    await closeBrowserSession(session);
  }
}

main().catch(err => {
  console.error("[ashby-test] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
