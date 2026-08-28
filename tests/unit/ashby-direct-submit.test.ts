// @vitest-environment node
/**
 * JOB-214. The Ashby direct HTTP submit path is a real submit endpoint the
 * moment its submit mutation goes out, so these tests never hit a live
 * Ashby URL and never hit the harvester. Everything is a mocked fetch or a
 * mocked dep injected through `runAshbyDirectSubmit`'s deps parameter, plus
 * a fake Supabase client that records the row writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASHBY_DIRECT_HTTP_MODE_VALUE,
  ASHBY_SUBMIT_MODE_ENV,
  ashbyDirectSolver,
  candidateValueForField,
  classifyAshbySubmitResponse,
  runAshbyDirectSubmit,
  shouldRouteAshbyDirectHttp,
  type AshbyCandidateView,
  type ResolvedAshbyContext,
} from "@/lib/solvers/ashby-direct";
import type { CandidateApplicationAnswers } from "@/lib/candidate-intake";
import { APPLICATION_STATUS } from "@/lib/application-status";
import type { PreflightRow, SubmitApplicationInput } from "@/lib/submit-application";

// JOB-232. `ashbyDirectSolver` calls `getSupabaseClient()` internally rather
// than accepting an injected client the way `runAshbyDirectSubmit` does — it
// has no `deps` parameter, since `SolverFn` does not carry one. The env vars
// below satisfy that internal client build (`localhost` is always allowed by
// `assertSupabaseProject`, so no `EXPECTED_SUPABASE_PROJECT_REF` is needed),
// and `@supabase/supabase-js` is mocked below so the applications lookup
// never leaves the process. `vi.hoisted` is required here, not a plain outer
// `let`, because this file's imports of `@/lib/solvers/ashby-direct` are
// static and that module itself statically imports `@supabase/supabase-js`
// — a factory closing over a normally declared variable would run before
// that variable's initializer and throw.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const { capturedApplicationsIdFilters } = vi.hoisted(() => ({
  capturedApplicationsIdFilters: [] as unknown[],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: (column: string, value: unknown) => {
          if (column === "id") capturedApplicationsIdFilters.push(value);
          return { limit: async () => ({ data: [], error: null }) };
        },
      }),
    }),
  }),
}));

let priorEnvValue: string | undefined;

beforeEach(() => {
  priorEnvValue = process.env[ASHBY_SUBMIT_MODE_ENV];
});

afterEach(() => {
  if (priorEnvValue === undefined) delete process.env[ASHBY_SUBMIT_MODE_ENV];
  else process.env[ASHBY_SUBMIT_MODE_ENV] = priorEnvValue;
});

// ── The mode selector ────────────────────────────────────────────────────

describe("shouldRouteAshbyDirectHttp", () => {
  it("routes to direct submit only when both env and ats agree", () => {
    process.env[ASHBY_SUBMIT_MODE_ENV] = ASHBY_DIRECT_HTTP_MODE_VALUE;
    expect(shouldRouteAshbyDirectHttp("ashby")).toBe(true);
  });

  it("stays on the DOM path when the env is off, even for ashby rows", () => {
    delete process.env[ASHBY_SUBMIT_MODE_ENV];
    expect(shouldRouteAshbyDirectHttp("ashby")).toBe(false);
  });

  it("stays on the DOM path for non ashby ats, even with env on", () => {
    process.env[ASHBY_SUBMIT_MODE_ENV] = ASHBY_DIRECT_HTTP_MODE_VALUE;
    expect(shouldRouteAshbyDirectHttp("workable")).toBe(false);
    expect(shouldRouteAshbyDirectHttp("recruitee")).toBe(false);
    expect(shouldRouteAshbyDirectHttp("greenhouse")).toBe(false);
  });

  it("does not accept mode values other than direct-http", () => {
    process.env[ASHBY_SUBMIT_MODE_ENV] = "on";
    expect(shouldRouteAshbyDirectHttp("ashby")).toBe(false);
    process.env[ASHBY_SUBMIT_MODE_ENV] = "true";
    expect(shouldRouteAshbyDirectHttp("ashby")).toBe(false);
  });
});

// ── The response classifier ──────────────────────────────────────────────

describe("classifyAshbySubmitResponse", () => {
  it("reads a FormSubmitSuccess as success", () => {
    const outcome = classifyAshbySubmitResponse({
      data: {
        submitApplicationFormAction: {
          applicationFormResult: { __typename: "FormSubmitSuccess" },
        },
      },
    });
    expect(outcome.kind).toBe("success");
  });

  it("reads a top level errors array as gql_errors", () => {
    const outcome = classifyAshbySubmitResponse({
      errors: [
        {
          message: "reCAPTCHA rejected",
          extensions: { ashbyErrorType: "RECAPTCHA_SCORE_BELOW_THRESHOLD" },
        },
      ],
    });
    expect(outcome.kind).toBe("gql_errors");
    if (outcome.kind === "gql_errors") {
      expect(outcome.errors[0]?.message).toContain("reCAPTCHA");
    }
  });

  it("reads a FormRender as form_render with errorMessages captured", () => {
    const outcome = classifyAshbySubmitResponse({
      data: {
        submitApplicationFormAction: {
          applicationFormResult: {
            __typename: "FormRender",
            errorMessages: ["Missing entry for required field"],
            formErrors: [{ message: "Required", fieldEntryId: "abc" }],
          },
        },
      },
    });
    expect(outcome.kind).toBe("form_render");
    if (outcome.kind === "form_render") {
      expect(outcome.errorMessages).toEqual(["Missing entry for required field"]);
      expect(outcome.formErrors[0]?.fieldEntryId).toBe("abc");
    }
  });

  it("reads an unknown shape as unexpected_shape", () => {
    const outcome = classifyAshbySubmitResponse({ hello: "world" });
    expect(outcome.kind).toBe("unexpected_shape");
  });
});

// ── runAshbyDirectSubmit ────────────────────────────────────────────────

type SupabaseCall = {
  table: string;
  op: "update" | "insert";
  values: Record<string, unknown>;
  eq?: Record<string, unknown>;
};

function makeFakeSupabase(): {
  client: {
    from: (table: string) => unknown;
  };
  calls: SupabaseCall[];
} {
  const calls: SupabaseCall[] = [];
  const client = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          const call: SupabaseCall = { table, op: "update", values, eq: {} };
          calls.push(call);
          return {
            eq(column: string, value: unknown) {
              call.eq![column] = value;
              return Promise.resolve({ error: null });
            },
          };
        },
        insert(values: Record<string, unknown>) {
          calls.push({ table, op: "insert", values });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, calls };
}

function baseContext(): ResolvedAshbyContext {
  return {
    jobApplicationId: "00000000-0000-0000-0000-000000000001",
    ats: "ashby",
    jobId: "00000000-0000-0000-0000-000000000002",
    applyUrl: "https://jobs.ashbyhq.com/testorg/00000000-0000-0000-0000-000000000003",
    company: "Test Co",
    jobTitle: "Test Engineer",
    orgName: "testorg",
    jobPostingId: "00000000-0000-0000-0000-000000000003",
    origin: "https://jobs.ashbyhq.com",
    candidate: {
      firstName: "Pranav",
      lastName: "Lende",
      fullName: "Pranav Lende",
      email: "pranavlende123@gmail.com",
      phone: "404-444-6018",
      linkedinUrl: "https://www.linkedin.com/in/pranavlende",
      location: "Atlanta, GA",
      githubUrl: null,
      entrepreneurialBackground: null,
    },
    applicationAnswers: {},
    resume: {
      bytes: new Uint8Array([37, 80, 68, 70]),
      fileName: "resume.pdf",
      contentType: "application/pdf",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A discovery response minimal enough to walk the submit path. No file
 * entries, no value entries, so the module skips upload and field fill
 * entirely and jumps straight to mint plus submit.
 */
function emptyDiscoveryResponse(): Response {
  return jsonResponse({
    data: {
      jobPosting: {
        id: "job-1",
        title: "Test Engineer",
        applicationForm: {
          id: "frid-1",
          sourceFormDefinitionId: "formdef-1",
          formControls: [
            { identifier: "submit-1", title: "Submit" },
            { identifier: "reset-1", title: "Reset" },
          ],
          sections: [],
        },
      },
    },
  });
}

/**
 * A discovery response carrying two mapped system fields (name, email),
 * both required. Used by the JOB-227 tests below to walk the
 * `setFieldValue` call path — `emptyDiscoveryResponse` above has no value
 * entries at all, so it never reaches that code.
 */
function discoveryWithTwoMappedFields(): Response {
  return jsonResponse({
    data: {
      jobPosting: {
        id: "job-1",
        title: "Test Engineer",
        applicationForm: {
          id: "frid-1",
          sourceFormDefinitionId: "formdef-1",
          formControls: [{ identifier: "submit-1", title: "Submit" }],
          sections: [
            {
              title: "Application",
              fieldEntries: [
                {
                  id: "entry-name",
                  isRequired: true,
                  isHidden: false,
                  field: { path: "_systemfield_name", title: "Name", type: "String" },
                },
                {
                  id: "entry-email",
                  isRequired: true,
                  isHidden: false,
                  field: { path: "_systemfield_email", title: "Email", type: "String" },
                },
              ],
            },
          ],
        },
      },
    },
  });
}

/**
 * A discovery response carrying one file field (the resume slot) followed
 * by one mapped system field (name), both required. Used by the JOB-227
 * file attach tests below to walk the `setFileFieldValue` call path and
 * confirm the FRID it returns threads into the value fill that follows.
 */
function discoveryWithFileAndNameField(): Response {
  return jsonResponse({
    data: {
      jobPosting: {
        id: "job-1",
        title: "Test Engineer",
        applicationForm: {
          id: "frid-1",
          sourceFormDefinitionId: "formdef-1",
          formControls: [{ identifier: "submit-1", title: "Submit" }],
          sections: [
            {
              title: "Application",
              fieldEntries: [
                {
                  id: "entry-resume",
                  isRequired: true,
                  isHidden: false,
                  field: { path: "_systemfield_resume", title: "Resume", type: "File" },
                },
                {
                  id: "entry-name",
                  isRequired: true,
                  isHidden: false,
                  field: { path: "_systemfield_name", title: "Name", type: "String" },
                },
              ],
            },
          ],
        },
      },
    },
  });
}

/**
 * A discovery response carrying only the resume file field. Used by the
 * JOB-227 rejected file attach test below, which stops the run before any
 * value field would be reached.
 */
function discoveryWithFileEntryOnly(): Response {
  return jsonResponse({
    data: {
      jobPosting: {
        id: "job-1",
        title: "Test Engineer",
        applicationForm: {
          id: "frid-1",
          sourceFormDefinitionId: "formdef-1",
          formControls: [{ identifier: "submit-1", title: "Submit" }],
          sections: [
            {
              title: "Application",
              fieldEntries: [
                {
                  id: "entry-resume",
                  isRequired: true,
                  isHidden: false,
                  field: { path: "_systemfield_resume", title: "Resume", type: "File" },
                },
              ],
            },
          ],
        },
      },
    },
  });
}

/**
 * A minimal successful `ApiCreateFileUploadHandle` response, shared by both
 * JOB-227 file attach tests below.
 */
function uploadHandleResponse(): Response {
  return jsonResponse({
    data: {
      fileUploadHandle: {
        handle: "upload-handle-1",
        url: "https://s3.example.com/upload",
        fields: { key: "uploads/resume.pdf" },
      },
    },
  });
}

/** Extracts the GraphQL variables body a mocked fetch call was sent. */
function variablesFromFetchCall(fetchImpl: ReturnType<typeof vi.fn>, callIndex: number): Record<string, unknown> {
  const call = fetchImpl.mock.calls[callIndex] as [string, { body?: string }];
  const body = JSON.parse(call[1]?.body ?? "{}") as { variables?: Record<string, unknown> };
  return body.variables ?? {};
}

/**
 * A discovery response carrying one required text field with no keyword
 * `candidateValueForField` will match. Used to prove that a required
 * unmapped field routes to submission_blocked without a submit call.
 */
function discoveryWithUnmappedRequiredField(): Response {
  return jsonResponse({
    data: {
      jobPosting: {
        id: "job-1",
        title: "Test Engineer",
        applicationForm: {
          id: "frid-1",
          sourceFormDefinitionId: "formdef-1",
          formControls: [{ identifier: "submit-1", title: "Submit" }],
          sections: [
            {
              title: "Application",
              fieldEntries: [
                {
                  id: "entry-1",
                  isRequired: true,
                  isHidden: false,
                  field: {
                    path: "custom_favourite_number",
                    title: "What is your favourite prime number?",
                    type: "String",
                  },
                },
              ],
            },
          ],
        },
      },
    },
  });
}

function emptyAnswers(): CandidateApplicationAnswers {
  return {};
}

function baseView(): AshbyCandidateView {
  return {
    firstName: "Pranav",
    lastName: "Lende",
    fullName: "Pranav Lende",
    email: "pranavlende123@gmail.com",
    phone: "404-444-6018",
    linkedinUrl: "https://www.linkedin.com/in/pranavlende",
    location: "Atlanta, GA",
    // JOB-230. null here on purpose: most of the tests below are about
    // fields other than GitHub, and a candidate who has not stated one is
    // the ordinary case, per HARD STOP 9. The GitHub specific tests build
    // their own view with a value set.
    githubUrl: null,
    entrepreneurialBackground: null,
  };
}

describe("runAshbyDirectSubmit", () => {
  it("routes a GraphQL error response on submit to submission_unconfirmed", async () => {
    const { client, calls } = makeFakeSupabase();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(emptyDiscoveryResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          errors: [
            {
              message: "reCAPTCHA score below threshold",
              extensions: { ashbyErrorType: "RECAPTCHA_SCORE_BELOW_THRESHOLD" },
            },
          ],
        })
      );

    const result = await runAshbyDirectSubmit(baseContext(), {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      mintRecaptchaToken: async () => "harvester-token-123",
      supabase: client as never,
      now: () => new Date("2026-08-27T12:00:00Z"),
    });

    expect(result.status).toBe(APPLICATION_STATUS.SUBMISSION_UNCONFIRMED);
    expect(result.submitted).toBe(false);
    expect(result.submitAttempted).toBe(true);
    expect(result.unconfirmedReason).toContain("reCAPTCHA score below threshold");
    // The row was written to submission_unconfirmed exactly once, and a
    // skip_log row was appended alongside it.
    const statusWrite = calls.find(
      (c) =>
        c.table === "applications" &&
        c.op === "update" &&
        c.values.status === APPLICATION_STATUS.SUBMISSION_UNCONFIRMED
    );
    expect(statusWrite).toBeDefined();
    expect(calls.some((c) => c.table === "skip_log" && c.op === "insert")).toBe(true);
    // Two fetch calls: discovery, then submit. No third call after the
    // errors response.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("routes a successful ApiSubmitSingleApplicationFormAction response to submitted", async () => {
    const { client, calls } = makeFakeSupabase();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(emptyDiscoveryResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            submitApplicationFormAction: {
              applicationFormResult: { __typename: "FormSubmitSuccess" },
            },
          },
        })
      );

    const result = await runAshbyDirectSubmit(baseContext(), {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      mintRecaptchaToken: async () => "harvester-token-abc",
      supabase: client as never,
      now: () => new Date("2026-08-27T12:00:00Z"),
    });

    expect(result.status).toBe(APPLICATION_STATUS.SUBMITTED);
    expect(result.submitted).toBe(true);
    expect(result.submitAttempted).toBe(true);
    expect(result.confirmationRef).toContain("FormSubmitSuccess");
    const statusWrite = calls.find(
      (c) =>
        c.table === "applications" &&
        c.op === "update" &&
        c.values.status === APPLICATION_STATUS.SUBMITTED
    );
    expect(statusWrite).toBeDefined();
    expect(statusWrite?.values.confirmation_text).toContain("FormSubmitSuccess");
    expect(statusWrite?.values.submitted_at).toBe("2026-08-27T12:00:00.000Z");
    // Submitted is terminal and no skip_log write follows a success.
    expect(calls.some((c) => c.table === "skip_log")).toBe(false);
  });

  it("returns submission_blocked without any submit attempt when the harvester fails", async () => {
    const { client, calls } = makeFakeSupabase();
    const fetchImpl = vi.fn().mockResolvedValueOnce(emptyDiscoveryResponse());
    const mint = vi.fn().mockRejectedValue(new Error("harvester unreachable"));

    const result = await runAshbyDirectSubmit(baseContext(), {
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      mintRecaptchaToken: mint,
      supabase: client as never,
      now: () => new Date("2026-08-27T12:00:00Z"),
    });

    expect(result.status).toBe(APPLICATION_STATUS.SUBMISSION_BLOCKED);
    expect(result.submitted).toBe(false);
    // Blocked, so submitAttempted stays false. That is the whole reason
    // `submission_blocked` is a distinct status from `submission_unconfirmed`.
    expect(result.submitAttempted).toBe(false);
    expect(result.blockedReason).toContain("harvester unreachable");
    // Exactly one fetch call, the discovery. No submit mutation was ever
    // issued.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledTimes(1);
    const statusWrite = calls.find(
      (c) =>
        c.table === "applications" &&
        c.op === "update" &&
        c.values.status === APPLICATION_STATUS.SUBMISSION_BLOCKED
    );
    expect(statusWrite).toBeDefined();
    // No submitted_at stamp on a row nothing was sent for.
    expect(statusWrite?.values.submitted_at).toBeUndefined();
  });

  // ── MAJOR #3: missingRequired coverage — the HARD STOP 9 gate ──────────

  it(
    "blocks with a named field and issues no submit call when a required field has no grounded answer",
    async () => {
      const { client, calls } = makeFakeSupabase();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(discoveryWithUnmappedRequiredField());
      const mint = vi.fn().mockResolvedValue("harvester-token-should-not-be-called");

      const result = await runAshbyDirectSubmit(baseContext(), {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
        mintRecaptchaToken: mint,
        supabase: client as never,
        now: () => new Date("2026-08-27T12:00:00Z"),
      });

      expect(result.status).toBe(APPLICATION_STATUS.SUBMISSION_BLOCKED);
      expect(result.submitted).toBe(false);
      expect(result.submitAttempted).toBe(false);
      // The blocked reason names the field that was missing, so the
      // operator reading the skip log knows what to add to intake.
      expect(result.blockedReason).toContain("What is your favourite prime number?");
      expect(result.blockedReason).toContain("HARD STOP 9");
      // Discovery ran; submit mutation did not; harvester was never
      // invoked because the missing required check gates before mint.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mint).not.toHaveBeenCalled();
      // The skip_log message carries the same field name, so the row
      // written to the database is the durable record of what stopped
      // this run.
      const skipInsert = calls.find((c) => c.table === "skip_log" && c.op === "insert");
      expect(skipInsert).toBeDefined();
      const skipContext = skipInsert?.values.raw_context as {
        message?: string;
      } | undefined;
      expect(skipContext?.message).toContain("What is your favourite prime number?");
    }
  );

  // ── JOB-227 ─────────────────────────────────────────────────────────

  it(
    "threads the render identifier each setFormValue response returns into the next call and into submit",
    async () => {
      const { client } = makeFakeSupabase();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(discoveryWithTwoMappedFields())
        // setFormValue for the name field returns a fresher id.
        .mockResolvedValueOnce(
          jsonResponse({ data: { setFormValue: { id: "frid-after-name", errorMessages: [] } } })
        )
        // setFormValue for the email field returns a fresher id again.
        .mockResolvedValueOnce(
          jsonResponse({ data: { setFormValue: { id: "frid-after-email", errorMessages: [] } } })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              submitApplicationFormAction: {
                applicationFormResult: { __typename: "FormSubmitSuccess" },
              },
            },
          })
        );

      const result = await runAshbyDirectSubmit(baseContext(), {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
        mintRecaptchaToken: async () => "harvester-token-frid",
        supabase: client as never,
        now: () => new Date("2026-08-27T12:00:00Z"),
      });

      expect(result.status).toBe(APPLICATION_STATUS.SUBMITTED);
      // Call 0 is discovery, 1 is the name field's setFormValue (still
      // carrying the FRID discovery returned), 2 is the email field's
      // setFormValue (must carry the id call 1 returned, not discovery's),
      // 3 is submit (must carry the id call 2 returned).
      expect(variablesFromFetchCall(fetchImpl, 1).formRenderIdentifier).toBe("frid-1");
      expect(variablesFromFetchCall(fetchImpl, 2).formRenderIdentifier).toBe("frid-after-name");
      expect(variablesFromFetchCall(fetchImpl, 3).formRenderIdentifier).toBe("frid-after-email");
    }
  );

  it(
    "routes a setFormValue response carrying errorMessages to submission_blocked instead of treating the write as landed",
    async () => {
      const { client, calls } = makeFakeSupabase();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(discoveryWithTwoMappedFields())
        // Transport level `errors` stays empty — the request itself was
        // fine — but the field level `errorMessages` says the write was
        // rejected. Before JOB-227 this looked identical to a success.
        .mockResolvedValueOnce(
          jsonResponse({
            data: { setFormValue: { id: "frid-2", errorMessages: ["Value exceeds max length"] } },
          })
        );
      const mint = vi.fn().mockResolvedValue("harvester-token-should-not-be-called");

      const result = await runAshbyDirectSubmit(baseContext(), {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
        mintRecaptchaToken: mint,
        supabase: client as never,
        now: () => new Date("2026-08-27T12:00:00Z"),
      });

      expect(result.status).toBe(APPLICATION_STATUS.SUBMISSION_BLOCKED);
      expect(result.submitted).toBe(false);
      expect(result.submitAttempted).toBe(false);
      expect(result.blockedReason).toContain("Value exceeds max length");
      expect(result.blockedReason).toContain("Name");
      // Discovery plus the one rejected setFormValue call. No further
      // field set, no mint, no submit — the module stops the moment a
      // write comes back rejected rather than continuing as if it landed.
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(mint).not.toHaveBeenCalled();
      const skipInsert = calls.find((c) => c.table === "skip_log" && c.op === "insert");
      expect(skipInsert).toBeDefined();
    }
  );

  // JOB-227 gap closed: `setFileFieldValue` (the resume upload path) had
  // no direct test coverage at all — `_systemfield_resume` is the exact
  // field named in the 2026-08-27 live incident this ticket traces to.
  // The fix in `setFileFieldValue` is a byte for byte mirror of
  // `setFieldValue`'s fix above; these two tests mirror the pair above it.

  it(
    "threads the render identifier each setFormValueToFile response returns into the next call",
    async () => {
      const { client } = makeFakeSupabase();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(discoveryWithFileAndNameField())
        .mockResolvedValueOnce(uploadHandleResponse())
        // The S3 pre signed POST — not a GraphQL call, no variables body.
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        // setFormValueToFile for the resume field returns a fresher id.
        .mockResolvedValueOnce(
          jsonResponse({
            data: { setFormValueToFile: { id: "frid-after-resume", errorMessages: [] } },
          })
        )
        // setFormValue for the name field must carry the id the file
        // attach call returned, not discovery's.
        .mockResolvedValueOnce(
          jsonResponse({ data: { setFormValue: { id: "frid-after-name", errorMessages: [] } } })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              submitApplicationFormAction: {
                applicationFormResult: { __typename: "FormSubmitSuccess" },
              },
            },
          })
        );

      const result = await runAshbyDirectSubmit(baseContext(), {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
        mintRecaptchaToken: async () => "harvester-token-file-frid",
        supabase: client as never,
        now: () => new Date("2026-08-27T12:00:00Z"),
      });

      expect(result.status).toBe(APPLICATION_STATUS.SUBMITTED);
      // Call 0 is discovery, 1 is createFileUploadHandle, 2 is the S3
      // POST (no GraphQL variables), 3 is setFormValueToFile for the
      // resume field (still carrying the FRID discovery returned), 4 is
      // the name field's setFormValue (must carry the id call 3
      // returned, not discovery's), 5 is submit (must carry the id call
      // 4 returned).
      expect(variablesFromFetchCall(fetchImpl, 3).formRenderIdentifier).toBe("frid-1");
      expect(variablesFromFetchCall(fetchImpl, 4).formRenderIdentifier).toBe("frid-after-resume");
      expect(variablesFromFetchCall(fetchImpl, 5).formRenderIdentifier).toBe("frid-after-name");
    }
  );

  it(
    "routes a setFormValueToFile response carrying errorMessages to submission_blocked instead of treating the write as landed",
    async () => {
      const { client, calls } = makeFakeSupabase();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(discoveryWithFileEntryOnly())
        .mockResolvedValueOnce(uploadHandleResponse())
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        // Transport level `errors` stays empty — the request itself was
        // fine — but the field level `errorMessages` says the file
        // attach was rejected. Before JOB-227 this looked identical to a
        // success.
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              setFormValueToFile: { id: "frid-2", errorMessages: ["File type not accepted"] },
            },
          })
        );
      const mint = vi.fn().mockResolvedValue("harvester-token-should-not-be-called");

      const result = await runAshbyDirectSubmit(baseContext(), {
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
        mintRecaptchaToken: mint,
        supabase: client as never,
        now: () => new Date("2026-08-27T12:00:00Z"),
      });

      expect(result.status).toBe(APPLICATION_STATUS.SUBMISSION_BLOCKED);
      expect(result.submitted).toBe(false);
      expect(result.submitAttempted).toBe(false);
      expect(result.blockedReason).toContain("File type not accepted");
      expect(result.blockedReason).toContain("_systemfield_resume");
      // Discovery, the upload handle mint, the S3 upload, and the one
      // rejected setFormValueToFile call. No value field fill, no mint,
      // no submit — the module stops the moment the file attach comes
      // back rejected rather than continuing as if the resume landed.
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(mint).not.toHaveBeenCalled();
      const skipInsert = calls.find((c) => c.table === "skip_log" && c.op === "insert");
      expect(skipInsert).toBeDefined();
    }
  );
});

// ── HARD STOP 9 — every hardcoded value now traces to intake ──────────────

describe("candidateValueForField grounding", () => {
  const workAuthField = {
    path: "custom_work_auth",
    title: "Are you legally authorized to work in the United States?",
    type: "String" as const,
  };
  const workAuthBooleanField = {
    ...workAuthField,
    type: "Boolean" as const,
  };
  const sponsorshipField = {
    path: "custom_sponsorship",
    title: "Will you now or in the future require sponsorship for an employment visa?",
    type: "String" as const,
  };
  const sponsorshipBooleanField = {
    ...sponsorshipField,
    type: "Boolean" as const,
  };
  const usOrCanadaField = {
    path: "custom_geo",
    title: "Are you based in the US or Canada?",
    type: "String" as const,
  };
  const relocationBoolean = {
    path: "custom_relo",
    title: "Are you willing to relocate?",
    type: "Boolean" as const,
  };
  const arbitraryBoolean = {
    path: "custom_random_bool",
    title: "Have you ever worked at a startup?",
    type: "Boolean" as const,
  };

  it("returns null for work authorization when intake did not state it", () => {
    expect(candidateValueForField(workAuthField, baseView(), emptyAnswers(), true)).toBeNull();
    expect(
      candidateValueForField(workAuthBooleanField, baseView(), emptyAnswers(), true)
    ).toBeNull();
  });

  it("routes stated work authorization straight through, both string and boolean flavours", () => {
    const yes: CandidateApplicationAnswers = { workAuthorizedUs: true };
    expect(candidateValueForField(workAuthField, baseView(), yes, true)).toBe("Yes");
    expect(candidateValueForField(workAuthBooleanField, baseView(), yes, true)).toBe(true);
    const no: CandidateApplicationAnswers = { workAuthorizedUs: false };
    expect(candidateValueForField(workAuthField, baseView(), no, true)).toBe("No");
    expect(candidateValueForField(workAuthBooleanField, baseView(), no, true)).toBe(false);
  });

  it("returns null for sponsorship when intake did not state it", () => {
    expect(
      candidateValueForField(sponsorshipField, baseView(), emptyAnswers(), true)
    ).toBeNull();
    expect(
      candidateValueForField(sponsorshipBooleanField, baseView(), emptyAnswers(), true)
    ).toBeNull();
  });

  it("routes stated sponsorship straight through — this is the JOB-022 style bug the MAJOR called out", () => {
    // A candidate who genuinely needs sponsorship must not have a false
    // "No" sent under their real name. This is the regression that
    // review MAJOR #1 caught in the first draft of this module.
    const needsSponsor: CandidateApplicationAnswers = { requiresSponsorship: true };
    expect(candidateValueForField(sponsorshipField, baseView(), needsSponsor, true)).toBe("Yes");
    expect(
      candidateValueForField(sponsorshipBooleanField, baseView(), needsSponsor, true)
    ).toBe(true);
    const noSponsor: CandidateApplicationAnswers = { requiresSponsorship: false };
    expect(candidateValueForField(sponsorshipField, baseView(), noSponsor, true)).toBe("No");
    expect(
      candidateValueForField(sponsorshipBooleanField, baseView(), noSponsor, true)
    ).toBe(false);
  });

  it("only answers US-or-Canada questions from a stated country", () => {
    expect(
      candidateValueForField(usOrCanadaField, baseView(), emptyAnswers(), true)
    ).toBeNull();
    expect(
      candidateValueForField(
        usOrCanadaField,
        baseView(),
        { currentCountry: "United States" },
        true
      )
    ).toBe("Yes");
    expect(
      candidateValueForField(usOrCanadaField, baseView(), { currentCountry: "US" }, true)
    ).toBe("Yes");
    expect(
      candidateValueForField(usOrCanadaField, baseView(), { currentCountry: "India" }, true)
    ).toBe("No");
  });

  it("returns null on a Boolean question with no matching intake even when required", () => {
    expect(
      candidateValueForField(arbitraryBoolean, baseView(), emptyAnswers(), true)
    ).toBeNull();
    expect(candidateValueForField(arbitraryBoolean, baseView(), emptyAnswers(), false)).toBeNull();
  });

  it("routes stated willingness to relocate", () => {
    expect(
      candidateValueForField(relocationBoolean, baseView(), { willingToRelocate: true }, true)
    ).toBe(true);
    expect(
      candidateValueForField(
        relocationBoolean,
        baseView(),
        { willingToRelocate: false },
        true
      )
    ).toBe(false);
    expect(
      candidateValueForField(relocationBoolean, baseView(), emptyAnswers(), true)
    ).toBeNull();
  });

  it("still returns Decline to Self Identify for EEO questions (HARD STOP 10 policy)", () => {
    const eeoField = {
      path: "eeo_gender",
      title: "What is your gender?",
      type: "String" as const,
    };
    expect(
      candidateValueForField(eeoField, baseView(), emptyAnswers(), true)
    ).toBe("Decline to Self Identify");
    const eeoBoolean = { ...eeoField, type: "Boolean" as const };
    // A boolean EEO question has no truthy "decline" answer, so this is
    // deliberately null rather than a hallucinated true/false.
    expect(
      candidateValueForField(eeoBoolean, baseView(), emptyAnswers(), true)
    ).toBeNull();
  });

  it("returns null for a required open-ended text with no grounded background paragraph", () => {
    // v1 does not carry an entrepreneurial background column in intake,
    // so `entrepreneurialBackground` is null on the view; the fallback
    // for a required generic text field is therefore null, which the
    // caller routes into missingRequired. No fabricated paragraph is
    // ever sent to an employer.
    const openText = {
      path: "custom_open",
      title: "Tell us about a project you're proud of",
      type: "LongText" as const,
    };
    expect(candidateValueForField(openText, baseView(), emptyAnswers(), true)).toBeNull();
  });

  // JOB-230. A required "GitHub Handle" field with no honest answer is what
  // landed the 2026 08 27 live proof of JOB-227 on PostHog's SRE posting as
  // submission_blocked. These two prove the fix: the value now traces to
  // `profiles.github_url` through `AshbyCandidateView.githubUrl`, and a
  // candidate who has not stated one still gets null, not a fabrication.
  it("returns the candidate's stated GitHub URL for a GitHub titled field", () => {
    const githubField = {
      path: "custom_github",
      title: "GitHub Handle",
      type: "String" as const,
    };
    const view: AshbyCandidateView = {
      ...baseView(),
      githubUrl: "https://github.com/pranavlende",
    };
    expect(candidateValueForField(githubField, view, emptyAnswers(), true)).toBe(
      "https://github.com/pranavlende"
    );

    // A handful of the titles Ashby forms actually use, per the ticket.
    for (const title of [
      "GitHub Profile",
      "Link to GitHub",
      "GitHub URL",
      "github handle",
    ]) {
      expect(
        candidateValueForField({ ...githubField, title }, view, emptyAnswers(), true)
      ).toBe("https://github.com/pranavlende");
    }
  });

  it("returns null for a GitHub titled field when the profile has not stated one, per HARD STOP 9", () => {
    const githubField = {
      path: "custom_github",
      title: "GitHub Handle",
      type: "String" as const,
    };
    expect(
      candidateValueForField(githubField, baseView(), emptyAnswers(), true)
    ).toBeNull();
  });
});

// ── ashbyDirectSolver: the SolverFn shim ────────────────────────────────
//
// Regression coverage for the finding that `ashbyDirectSolver` passed
// `input.jobApplicationId` straight through to `submitAshbyApplicationDirectly`
// without the `.trim()` the old inline `submitApplication()` used to apply
// before this became a registry entry. An untrimmed id passes `preflight()`
// (which is called with the trimmed value already) and then misses the row
// lookup `submitAshbyApplicationDirectly` does itself, because a
// whitespace padded id is never equal to the stored uuid. The row lookup is
// mocked to answer "no row found" for every id, so this only has to observe
// which id value reached the `.eq("id", ...)` filter, not carry a submission
// all the way through.

function baseSolverInput(jobApplicationId: string): SubmitApplicationInput {
  return { jobApplicationId, requiresCoverLetter: false };
}

function baseSolverRow(): PreflightRow {
  return {
    status: "ready",
    company: "Test Co",
    jobTitle: "Test Engineer",
    jobId: "00000000-0000-0000-0000-000000000002",
    jobDescription: null,
    ats: "ashby",
    confirmationRef: null,
    applyUrl: "https://jobs.ashbyhq.com/testorg/00000000-0000-0000-0000-000000000003",
  };
}

describe("ashbyDirectSolver", () => {
  beforeEach(() => {
    capturedApplicationsIdFilters.length = 0;
  });

  it("trims a whitespace padded jobApplicationId before the applications lookup", async () => {
    const paddedId = "  00000000-0000-0000-0000-000000000001  ";
    await expect(
      ashbyDirectSolver(baseSolverInput(paddedId), baseSolverRow())
    ).rejects.toThrow(/not found/);

    expect(capturedApplicationsIdFilters).toEqual([
      "00000000-0000-0000-0000-000000000001",
    ]);
  });

  it("passes an already trimmed jobApplicationId through unchanged", async () => {
    const cleanId = "00000000-0000-0000-0000-000000000001";
    await expect(
      ashbyDirectSolver(baseSolverInput(cleanId), baseSolverRow())
    ).rejects.toThrow(/not found/);

    expect(capturedApplicationsIdFilters).toEqual([cleanId]);
  });
});
