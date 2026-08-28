// @vitest-environment node
/**
 * JOB-236 — `recruiteeSolver`'s own orchestration, not just its pure helpers.
 *
 * `tests/unit/recruitee-solver.test.ts` already pins the phone probe
 * predicates, the E.164 formatter and the country lookup against fixtures,
 * and pins that the registry routes `recruitee` to `recruiteeSolver`.
 * Nothing there ever calls `recruiteeSolver` itself, so the wiring between it
 * and `fillApplicationFormRetainingSession`, `typeInto`, `runSubmitPhase`,
 * `recordSkipQuietly` and `closeBrowserSession`, the #140 patch step, the
 * post submit gate, the `unconfirmedReason` merge, and the `finally` that
 * closes the browser, was unexercised. Same class of blind spot
 * `greenhouse-solver-orchestration.test.ts` and `lever-solver-orchestration.test.ts`
 * close for their own solvers, copied here with the extra mock this file
 * needs for the Supabase reads `loadCandidateCountry` makes and the
 * `typeInto` call the #140 patch makes.
 *
 * This file mocks every one of `recruiteeSolver`'s runtime dependencies —
 * nothing here opens a browser or reaches a live Supabase project. Kept in
 * its own file, separate from `recruitee-solver.test.ts`, so these module
 * wide mocks never shadow that file's real module import of the registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APPLICATION_STATUS } from "@/lib/application-status";
import type { FillApplicationFormResult } from "@/lib/fill-application-form";
import type { BrowserSession } from "@/lib/stagehand-session";
import type {
  PreflightRow,
  SubmitApplicationInput,
  SubmitApplicationResult,
} from "@/lib/submit-application";

// `recruiteeSolver` builds its own Supabase client via `getSupabaseClient()`
// — see `lib/solvers/recruitee.ts` — so these have to be set before that
// function ever runs. `localhost` always passes `assertSupabaseProject`,
// matching the same env setup the other solver orchestration tests use for
// the same reason.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

// `vi.hoisted` is required, not a plain outer `let`: `vi.mock` factories run
// before this file's own top-level code, and a factory closing over a
// normally declared variable would read it before its initializer runs.
const {
  mockFillApplicationFormRetainingSession,
  mockRunSubmitPhase,
  mockRecordSkipQuietly,
  mockCloseBrowserSession,
  mockTypeInto,
  mockCreateClient,
} = vi.hoisted(() => ({
  mockFillApplicationFormRetainingSession: vi.fn(),
  mockRunSubmitPhase: vi.fn(),
  mockRecordSkipQuietly: vi.fn(),
  mockCloseBrowserSession: vi.fn(),
  mockTypeInto: vi.fn(),
  mockCreateClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

vi.mock("@/lib/fill-application-form", () => ({
  fillApplicationFormRetainingSession: mockFillApplicationFormRetainingSession,
}));

vi.mock("@/lib/submit-application", () => ({
  runSubmitPhase: mockRunSubmitPhase,
  // Real `gateName`'s own logic (see `lib/submit-application.ts`) — pure
  // enough to reproduce rather than mock away, and `recruiteeSolver`'s
  // early-return path reads it directly.
  gateName: (input: { approveSubmission?: unknown }) =>
    input.approveSubmission === undefined ? "auto" : "custom",
}));

vi.mock("@/lib/application-records", () => ({
  recordSkipQuietly: mockRecordSkipQuietly,
}));

vi.mock("@/lib/stagehand-session", () => ({
  closeBrowserSession: mockCloseBrowserSession,
  typeInto: mockTypeInto,
}));

const { recruiteeSolver } = await import("@/lib/solvers/recruitee");

const APPLY_URL = "https://transperfect.recruitee.com/o/junior-frontend-engineer-4/c/new";

const baseInput: SubmitApplicationInput = {
  jobApplicationId: "app-1",
  requiresCoverLetter: false,
};

const baseRow: PreflightRow = {
  status: "form_filled",
  company: "TransPerfect",
  jobTitle: "Junior Frontend Engineer",
  jobId: "job-1",
  jobDescription: null,
  ats: "recruitee",
  confirmationRef: null,
  applyUrl: APPLY_URL,
};

function makeFillResult(
  overrides: Partial<FillApplicationFormResult> = {}
): FillApplicationFormResult {
  return {
    jobApplicationId: "app-1",
    status: APPLICATION_STATUS.FORM_FILLED,
    submitted: false,
    verification: { required: false, method: "none", completed: false, detail: "" },
    fields: [],
    needsInput: [],
    answerProvenance: [],
    coverLetter: { required: false, generated: false, filled: false, characters: 0, detail: "" },
    parsedProfile: {} as FillApplicationFormResult["parsedProfile"],
    profileWarnings: [],
    submitControlLabels: ["Send"],
    finalUrl: APPLY_URL,
    pageTitle: "TransPerfect - Apply",
    screenshotPath: null,
    blockedReason: null,
    browserbaseSessionId: "bb-session-1",
    ...overrides,
  };
}

/** The exact shape recovered from application row 549305dd-2c66-411d-98ee-3c4bc8a3ce58, before the click. */
const missingCodeProbe = { present: true, value: "4044446018", invalid: false, errorText: null };

/** The same box already carrying a calling code — nothing for the patch to do. */
const alreadyPrefixedProbe = { present: true, value: "+14044446018", invalid: false, errorText: null };

/** What the board showed after the click when the missing code was never fixed. */
const stillBlockedProbe = {
  present: true,
  value: "+40 44446018",
  invalid: true,
  errorText:
    "This phone number is invalid. Please enter a valid phone number, including the country calling code.",
};

/** An unconfirmed result for an unrelated reason — the phone box reads clean. */
const cleanPostSubmitProbe = { present: true, value: "+14044446018", invalid: false, errorText: null };

function makeFakeSession(evaluateResults: unknown[]): BrowserSession {
  const evaluate = vi.fn();
  for (const result of evaluateResults) {
    evaluate.mockResolvedValueOnce(result);
  }
  return {
    stagehand: {} as unknown as BrowserSession["stagehand"],
    browser: { sessionId: "bb-session-1" } as unknown as BrowserSession["browser"],
    page: {
      evaluate,
      url: vi.fn().mockResolvedValue(APPLY_URL),
    } as unknown as BrowserSession["page"],
    logTag: "[test]",
  };
}

/** One recorded `eq(column, value)` call, tagged with the table it ran against. */
type RecordedFilter = { table: string; column: string; value: unknown };

// A wrong column bug in `loadCandidateCountry` (querying `profiles` by
// something other than `application.user_id`, say) would still pass every
// test in this file if the fake `eq()` accepted and ignored its arguments —
// CodeRabbit's own review flagged this same gap. Recording what each call
// actually asked for, and asserting it in the tests below that exercise the
// country lookup, closes it.
function makeFakeSupabase(
  country: string | null | "throws",
  recordedFilters: RecordedFilter[] = []
): unknown {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (column: string, value: unknown) => {
          recordedFilters.push({ table, column, value });
          return {
            maybeSingle: async () => {
              if (table === "applications") {
                return { data: { user_id: "user-1" }, error: null };
              }
              if (table === "profiles") {
                if (country === "throws") throw new Error("connection reset");
                return { data: country === null ? null : { current_country: country }, error: null };
              }
              return { data: null, error: null };
            },
          };
        },
      }),
    }),
  };
}

function makeSubmitResult(
  overrides: Partial<SubmitApplicationResult> = {}
): SubmitApplicationResult {
  return {
    jobApplicationId: "app-1",
    status: APPLICATION_STATUS.SUBMITTED,
    submitted: true,
    submitAttempted: true,
    confirmationRef: "confirmed",
    confirmation: null,
    securityCode: null,
    approval: { approved: true, gate: "auto", detail: "" },
    submitControlLabel: "Send",
    fill: null,
    finalUrl: APPLY_URL,
    pageTitle: "TransPerfect - Apply",
    screenshotPath: null,
    blockedReason: null,
    unconfirmedReason: null,
    rowUpdated: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockFillApplicationFormRetainingSession.mockReset();
  mockRunSubmitPhase.mockReset();
  mockRecordSkipQuietly.mockReset();
  mockCloseBrowserSession.mockReset();
  mockTypeInto.mockReset();
  mockTypeInto.mockResolvedValue({ selector: "#phone", description: "phone" });
  mockCreateClient.mockReset();
  mockCreateClient.mockReturnValue(makeFakeSupabase("United States"));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("recruiteeSolver — the #140 patch fires and the submission succeeds", () => {
  it("rewrites the phone field to E.164 shape before submitting, then returns the submitted result", async () => {
    const session = makeFakeSession([missingCodeProbe]);
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    const submitResult = makeSubmitResult({ submitted: true, status: APPLICATION_STATUS.SUBMITTED });
    mockRunSubmitPhase.mockResolvedValue(submitResult);

    const outcome = await recruiteeSolver(baseInput, baseRow);

    expect(mockTypeInto).toHaveBeenCalledTimes(1);
    const [, , , correctedValue] = mockTypeInto.mock.calls[0]!;
    expect(correctedValue).toBe("+14044446018");
    expect(outcome).toEqual(submitResult);
    // Submitted cleanly, so the post submit probe never has reason to run — a
    // genuine submitted result has nothing for it to add to.
    expect(session.page.evaluate).toHaveBeenCalledTimes(1);
    expect(mockRecordSkipQuietly).not.toHaveBeenCalled();
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockCloseBrowserSession).toHaveBeenCalledWith(session);
  });

  it("looks up the candidate's country by the application's own user id, not any other column", async () => {
    const recordedFilters: RecordedFilter[] = [];
    mockCreateClient.mockReturnValue(makeFakeSupabase("United States", recordedFilters));
    const session = makeFakeSession([missingCodeProbe]);
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    mockRunSubmitPhase.mockResolvedValue(
      makeSubmitResult({ submitted: true, status: APPLICATION_STATUS.SUBMITTED })
    );

    await recruiteeSolver(baseInput, baseRow);

    // `loadCandidateCountry` (see `lib/solvers/recruitee.ts`) reads
    // `applications` by the application's own id, then `profiles` by that
    // row's `user_id` — a wrong column on either read would silently default
    // the dial code rather than fail loudly, so the exact filter each query
    // used is worth pinning here rather than trusting the fake to be right
    // regardless of what was asked.
    expect(recordedFilters).toContainEqual({
      table: "applications",
      column: "id",
      value: baseInput.jobApplicationId,
    });
    expect(recordedFilters).toContainEqual({
      table: "profiles",
      column: "id",
      value: "user-1",
    });
  });
});

describe("recruiteeSolver — the #140 patch is not needed", () => {
  it("does not call typeInto when the phone value already carries a calling code", async () => {
    const session = makeFakeSession([alreadyPrefixedProbe]);
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    mockRunSubmitPhase.mockResolvedValue(
      makeSubmitResult({ submitted: true, status: APPLICATION_STATUS.SUBMITTED })
    );

    await recruiteeSolver(baseInput, baseRow);

    expect(mockTypeInto).not.toHaveBeenCalled();
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
  });
});

describe("recruiteeSolver — the #140 patch fires but Recruitee still rejects the value", () => {
  it("writes an internal_error skip_log row naming that the patch already ran, and appends to unconfirmedReason", async () => {
    const session = makeFakeSession([missingCodeProbe, stillBlockedProbe]);
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    const submitResult = makeSubmitResult({
      submitted: false,
      status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
      unconfirmedReason: null,
    });
    mockRunSubmitPhase.mockResolvedValue(submitResult);

    const outcome = await recruiteeSolver(baseInput, baseRow);

    expect(mockTypeInto).toHaveBeenCalledTimes(1);
    expect(session.page.evaluate).toHaveBeenCalledTimes(2);
    expect(mockRecordSkipQuietly).toHaveBeenCalledTimes(1);
    const [, skipInput] = mockRecordSkipQuietly.mock.calls[0]!;
    expect(skipInput).toMatchObject({
      applicationId: "app-1",
      jobId: baseRow.jobId,
      ats: baseRow.ats,
      reason: "internal_error",
      browserbaseSessionId: "bb-session-1",
    });
    expect(skipInput.message).toContain("already rewritten");
    expect(skipInput.message).toContain("#140");

    expect(outcome.unconfirmedReason).not.toBeNull();
    expect(outcome.unconfirmedReason).toContain("already rewritten");
    expect(outcome.status).toBe(APPLICATION_STATUS.SUBMISSION_UNCONFIRMED);
    expect(outcome.submitted).toBe(false);
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("appends to an existing unconfirmedReason rather than overwriting it", async () => {
    const session = makeFakeSession([missingCodeProbe, stillBlockedProbe]);
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    const genericHedge =
      '"Send" was clicked, but the application form is still on screen, with no confirmation of any kind.';
    mockRunSubmitPhase.mockResolvedValue(
      makeSubmitResult({
        submitted: false,
        status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
        unconfirmedReason: genericHedge,
      })
    );

    const outcome = await recruiteeSolver(baseInput, baseRow);

    expect(outcome.unconfirmedReason).toContain(genericHedge);
    expect(outcome.unconfirmedReason).toContain("country calling code");
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
  });
});

describe("recruiteeSolver — an unconfirmed result that is not this gate", () => {
  it("does not log a skip and leaves unconfirmedReason exactly as runSubmitPhase wrote it", async () => {
    const session = makeFakeSession([missingCodeProbe, cleanPostSubmitProbe]);
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    const genericHedge = "most likely rejected as automated, but this could also be validation.";
    const submitResult = makeSubmitResult({
      submitted: false,
      status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
      unconfirmedReason: genericHedge,
    });
    mockRunSubmitPhase.mockResolvedValue(submitResult);

    const outcome = await recruiteeSolver(baseInput, baseRow);

    expect(session.page.evaluate).toHaveBeenCalledTimes(2);
    expect(mockRecordSkipQuietly).not.toHaveBeenCalled();
    expect(outcome).toEqual(submitResult);
    expect(outcome.unconfirmedReason).toBe(genericHedge);
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
  });
});

describe("recruiteeSolver — the patch attempt itself fails", () => {
  it("still proceeds to submit, and the post submit row names that a rewrite was attempted and did not complete", async () => {
    const session = makeFakeSession([missingCodeProbe, stillBlockedProbe]);
    mockTypeInto.mockRejectedValueOnce(new Error("selector no longer resolves"));
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    mockRunSubmitPhase.mockResolvedValue(
      makeSubmitResult({
        submitted: false,
        status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
        unconfirmedReason: null,
      })
    );

    const outcome = await recruiteeSolver(baseInput, baseRow);

    expect(mockRunSubmitPhase).toHaveBeenCalledTimes(1);
    // The BLOCKING fix this test pins: a failed rewrite attempt must not be
    // reported with the same sentence a skipped patch uses. Before this fix
    // both paths returned `{ attempted: false, correctedValue: null }`, so a
    // typeInto failure was rendered as "found nothing to rewrite", which was
    // false — a rewrite plainly was attempted, it just did not finish. See
    // `RecruiteePhonePatchOutcome` in `lib/solvers/recruitee.ts`.
    expect(outcome.unconfirmedReason).toContain("rewrite itself failed");
    expect(outcome.unconfirmedReason).toContain("selector no longer resolves");
    expect(outcome.unconfirmedReason).toContain("did not complete");
    expect(outcome.unconfirmedReason).not.toContain("found nothing to rewrite");
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
  });
});

describe("recruiteeSolver — the candidate country lookup itself fails", () => {
  it("still patches the phone field, defaulting to the United States dial code", async () => {
    mockCreateClient.mockReturnValue(makeFakeSupabase("throws"));
    const session = makeFakeSession([missingCodeProbe]);
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    mockRunSubmitPhase.mockResolvedValue(
      makeSubmitResult({ submitted: true, status: APPLICATION_STATUS.SUBMITTED })
    );

    await recruiteeSolver(baseInput, baseRow);

    expect(mockTypeInto).toHaveBeenCalledTimes(1);
    const [, , , correctedValue] = mockTypeInto.mock.calls[0]!;
    expect(correctedValue).toBe("+14044446018");
  });
});

describe("recruiteeSolver — the fill never produced a live session", () => {
  it("returns before the patch step and the submit phase, never probes, never logs a skip, and has nothing to close", async () => {
    const blockedResult = makeFillResult({
      status: APPLICATION_STATUS.FORM_FILL_BLOCKED,
      blockedReason: "needs_candidate_input: a required question had no stored answer",
    });
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: blockedResult,
      // `RetainedFillSession`'s own contract: session is null on every
      // blocked path — see `lib/fill-application-form.ts`.
      session: null,
    });

    const outcome = await recruiteeSolver(baseInput, baseRow);

    expect(mockTypeInto).not.toHaveBeenCalled();
    expect(mockRunSubmitPhase).not.toHaveBeenCalled();
    expect(mockRecordSkipQuietly).not.toHaveBeenCalled();
    expect(mockCloseBrowserSession).not.toHaveBeenCalled();
    expect(outcome.blockedReason).toBe(blockedResult.blockedReason);
    expect(outcome.submitted).toBe(false);
    expect(outcome.submitAttempted).toBe(false);
    expect(outcome.status).toBe(APPLICATION_STATUS.FORM_FILL_BLOCKED);
  });
});
