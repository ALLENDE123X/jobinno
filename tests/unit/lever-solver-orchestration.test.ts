// @vitest-environment node
/**
 * JOB-233 review follow up — `leverSolver`'s own orchestration, not just its
 * two pure helpers.
 *
 * `tests/unit/lever-solver.test.ts` already pins `leverHcaptchaGateBlocked`
 * and `describeLeverHcaptchaGate` against fixtures, and pins that the
 * registry routes `lever` to `leverSolver`. Nothing there ever calls
 * `leverSolver` itself, so the wiring between it and
 * `fillApplicationFormRetainingSession`, `runSubmitPhase`,
 * `recordSkipQuietly` and `closeBrowserSession` — the gating condition, the
 * `unconfirmedReason` merge, and the `finally` that closes the browser — was
 * unexercised. Same class of blind spot as the JOB-227 `ashbyDirectSolver`
 * regression: solver-wrapper glue can diverge from intent while the pure
 * helper tests stay green.
 *
 * This file mocks every one of `leverSolver`'s four runtime dependencies, the
 * same way `tests/unit/ashby-direct-submit.test.ts` mocks
 * `@supabase/supabase-js` for `ashbyDirectSolver` — nothing here opens a
 * browser or reaches a live Supabase project. Kept in its own file, separate
 * from `lever-solver.test.ts`, so these module-wide mocks never shadow that
 * file's real-module import of the registry.
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

// `leverSolver` builds its own Supabase client via `getSupabaseClient()` —
// see `lib/solvers/lever.ts` — so these have to be set before that function
// ever runs. `localhost` always passes `assertSupabaseProject`, matching the
// same env setup `ashby-direct-submit.test.ts` uses for the same reason.
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
} = vi.hoisted(() => ({
  mockFillApplicationFormRetainingSession: vi.fn(),
  mockRunSubmitPhase: vi.fn(),
  mockRecordSkipQuietly: vi.fn(),
  mockCloseBrowserSession: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({}),
}));

vi.mock("@/lib/fill-application-form", () => ({
  fillApplicationFormRetainingSession: mockFillApplicationFormRetainingSession,
}));

vi.mock("@/lib/submit-application", () => ({
  runSubmitPhase: mockRunSubmitPhase,
  // Real `gateName`'s own logic (see `lib/submit-application.ts`) — pure
  // enough to reproduce rather than mock away, and `leverSolver`'s
  // early-return path reads it directly.
  gateName: (input: { approveSubmission?: unknown }) =>
    input.approveSubmission === undefined ? "auto" : "custom",
}));

vi.mock("@/lib/application-records", () => ({
  recordSkipQuietly: mockRecordSkipQuietly,
}));

vi.mock("@/lib/stagehand-session", () => ({
  closeBrowserSession: mockCloseBrowserSession,
}));

const { leverSolver } = await import("@/lib/solvers/lever");

const APPLY_URL = "https://jobs.lever.co/acme/4abf26b4-795c-420a-bf22-1ab98db268b4/apply";

const baseInput: SubmitApplicationInput = {
  jobApplicationId: "app-1",
  requiresCoverLetter: false,
};

const baseRow: PreflightRow = {
  status: "form_filled",
  company: "Acme",
  jobTitle: "Software Engineer Intern",
  jobId: "job-1",
  jobDescription: null,
  ats: "lever",
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
    submitControlLabels: ["Submit"],
    finalUrl: APPLY_URL,
    pageTitle: "Acme - Apply",
    screenshotPath: null,
    blockedReason: null,
    browserbaseSessionId: "bb-session-1",
    ...overrides,
  };
}

/** The exact probe shape recovered from the real unconfirmed rows — see `lever-solver.test.ts`. */
const withheldTokenProbe = {
  hiddenSubmitPresent: true,
  hiddenSubmitType: "submit",
  hiddenSubmitIsHidden: true,
  responseTokenPresent: true,
  responseTokenValue: "",
  sitekey: "e33f87f8-88ec-4e1a-9a13-df9bbb1d8120",
  visibleSubmitType: "button",
};

/** The shape an ordinary, non-Lever-gated board reads as — the probe finds nothing. */
const noGateProbe = {
  hiddenSubmitPresent: false,
  hiddenSubmitType: null,
  hiddenSubmitIsHidden: false,
  responseTokenPresent: false,
  responseTokenValue: null,
  sitekey: null,
  visibleSubmitType: "submit",
};

function makeFakeSession(probeResult: unknown): BrowserSession {
  return {
    stagehand: {} as unknown as BrowserSession["stagehand"],
    browser: { sessionId: "bb-session-1" } as unknown as BrowserSession["browser"],
    page: { evaluate: vi.fn().mockResolvedValue(probeResult) } as unknown as BrowserSession["page"],
    logTag: "[test]",
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
    submitControlLabel: "Submit",
    fill: null,
    finalUrl: APPLY_URL,
    pageTitle: "Acme - Apply",
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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("leverSolver — happy path", () => {
  it("never runs the hCaptcha probe, never logs a skip, and closes the session once when submitted", async () => {
    const session = makeFakeSession(withheldTokenProbe);
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    const submitResult = makeSubmitResult({ submitted: true, status: APPLICATION_STATUS.SUBMITTED });
    mockRunSubmitPhase.mockResolvedValue(submitResult);

    const outcome = await leverSolver(baseInput, baseRow);

    expect(outcome).toEqual(submitResult);
    // The gate is only worth a look when `runSubmitPhase` could not confirm
    // anything — a genuine `submitted` result has nothing for it to add to.
    expect(session.page.evaluate).not.toHaveBeenCalled();
    expect(mockRecordSkipQuietly).not.toHaveBeenCalled();
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockCloseBrowserSession).toHaveBeenCalledWith(session);
  });
});

describe("leverSolver — the hCaptcha gate fires", () => {
  it("writes a verification_required skip_log row and appends to unconfirmedReason", async () => {
    const session = makeFakeSession(withheldTokenProbe);
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    const submitResult = makeSubmitResult({
      submitted: false,
      status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
      submitControlLabel: "SUBMIT APPLICATION",
      unconfirmedReason: null,
    });
    mockRunSubmitPhase.mockResolvedValue(submitResult);

    const outcome = await leverSolver(baseInput, baseRow);

    expect(session.page.evaluate).toHaveBeenCalledTimes(1);
    expect(mockRecordSkipQuietly).toHaveBeenCalledTimes(1);
    const [, skipInput] = mockRecordSkipQuietly.mock.calls[0]!;
    expect(skipInput).toMatchObject({
      applicationId: "app-1",
      jobId: baseRow.jobId,
      ats: baseRow.ats,
      reason: "verification_required",
      browserbaseSessionId: "bb-session-1",
    });
    expect(skipInput.message).toContain("hCaptcha");

    // `unconfirmedReason` started null on this result, so the merge is a
    // fresh assignment, not an append.
    expect(outcome.unconfirmedReason).not.toBeNull();
    expect(outcome.unconfirmedReason).toContain("hCaptcha");
    expect(outcome.status).toBe(APPLICATION_STATUS.SUBMISSION_UNCONFIRMED);
    expect(outcome.submitted).toBe(false);
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockCloseBrowserSession).toHaveBeenCalledWith(session);
  });

  it("appends to an existing unconfirmedReason rather than overwriting it", async () => {
    const session = makeFakeSession(withheldTokenProbe);
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    const genericHedge =
      "SUBMIT APPLICATION was clicked, but the application form is still on screen, with no " +
      "confirmation of any kind.";
    mockRunSubmitPhase.mockResolvedValue(
      makeSubmitResult({
        submitted: false,
        status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
        unconfirmedReason: genericHedge,
      })
    );

    const outcome = await leverSolver(baseInput, baseRow);

    expect(outcome.unconfirmedReason).toContain(genericHedge);
    expect(outcome.unconfirmedReason).toContain("hCaptcha");
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
  });
});

describe("leverSolver — the hCaptcha gate does not fire", () => {
  it("does not log a skip and leaves unconfirmedReason exactly as runSubmitPhase wrote it, on an unconfirmed result that is not Lever's gate", async () => {
    const session = makeFakeSession(noGateProbe);
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

    const outcome = await leverSolver(baseInput, baseRow);

    expect(session.page.evaluate).toHaveBeenCalledTimes(1);
    expect(mockRecordSkipQuietly).not.toHaveBeenCalled();
    expect(outcome).toEqual(submitResult);
    expect(outcome.unconfirmedReason).toBe(genericHedge);
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockCloseBrowserSession).toHaveBeenCalledWith(session);
  });
});

describe("leverSolver — the fill never produced a live session", () => {
  it("returns before the submit phase, never probes, never logs a skip, and has nothing to close", async () => {
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

    const outcome = await leverSolver(baseInput, baseRow);

    expect(mockRunSubmitPhase).not.toHaveBeenCalled();
    expect(mockRecordSkipQuietly).not.toHaveBeenCalled();
    // Nothing was ever opened for this row, so there is nothing to close —
    // matches the module's own `if (session !== null) await closeBrowserSession(session)`.
    expect(mockCloseBrowserSession).not.toHaveBeenCalled();
    expect(outcome.blockedReason).toBe(blockedResult.blockedReason);
    expect(outcome.submitted).toBe(false);
    expect(outcome.submitAttempted).toBe(false);
    expect(outcome.status).toBe(APPLICATION_STATUS.FORM_FILL_BLOCKED);
  });

  it("still closes a session that came back live even when blockedReason is set", async () => {
    // Defensive branch: `fillApplicationFormRetainingSession`'s own contract
    // says this combination should not happen, but `leverSolver`'s guard
    // checks `session !== null` independently of `blockedReason`, so a
    // session handed back alongside a blocked result is still closed rather
    // than leaked.
    const session = makeFakeSession(noGateProbe);
    const blockedResult = makeFillResult({
      status: APPLICATION_STATUS.FORM_FILL_BLOCKED,
      blockedReason: "needs_candidate_input: a required question had no stored answer",
    });
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: blockedResult,
      session,
    });

    await leverSolver(baseInput, baseRow);

    expect(mockRunSubmitPhase).not.toHaveBeenCalled();
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockCloseBrowserSession).toHaveBeenCalledWith(session);
  });
});
