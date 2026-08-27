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
  candidateValueForField,
  classifyAshbySubmitResponse,
  runAshbyDirectSubmit,
  shouldRouteAshbyDirectHttp,
  type AshbyCandidateView,
  type ResolvedAshbyContext,
} from "@/lib/ashby-direct-submit";
import type { CandidateApplicationAnswers } from "@/lib/candidate-intake";
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
});
