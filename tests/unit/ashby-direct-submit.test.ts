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
  classifyAshbySubmitResponse,
  runAshbyDirectSubmit,
  shouldRouteAshbyDirectHttp,
  type ResolvedAshbyContext,
} from "@/lib/ashby-direct-submit";
import { APPLICATION_STATUS } from "@/lib/application-status";

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
});
