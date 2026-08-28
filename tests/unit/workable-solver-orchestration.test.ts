// @vitest-environment node
/**
 * JOB-235 — `workableSolver`'s own orchestration, not just its two pure
 * helpers.
 *
 * `tests/unit/workable-solver.test.ts` already pins `probeWorkableOopsRedirect`
 * and `describeWorkableOopsRedirect` against fixtures, and pins that the
 * registry routes `workable` to `workableSolver`. Nothing there ever calls
 * `workableSolver` itself, so the wiring between it and
 * `fillApplicationFormRetainingSession`, `runSubmitPhase`,
 * `recordSkipQuietly` and `closeBrowserSession` — the gating condition, the
 * `blockedReason` merge, and the early return — was unexercised. Same class
 * of blind spot `tests/unit/lever-solver-orchestration.test.ts` and
 * `tests/unit/greenhouse-solver-orchestration.test.ts` closed for their own
 * solvers.
 *
 * This file mocks every one of `workableSolver`'s four runtime dependencies,
 * the same way those two files do for theirs — nothing here opens a browser
 * or reaches a live Supabase project. Kept in its own file, separate from
 * `workable-solver.test.ts`, so these module wide mocks never shadow that
 * file's real module import of the registry.
 *
 * ── Why this file has no "gate fires after a live submit" case ──────────────
 * Lever's and Greenhouse's own orchestration tests each cover a probe that
 * runs on the live page *after* `runSubmitPhase` returns. Workable's one
 * confirmed failure is a pre-fill block: `probeWorkableOopsRedirect` reads
 * `fill.blockedReason`, a string, not a live page, because no session
 * survives a `form_fill_blocked` row — see `lib/solvers/workable.ts`'s own
 * header for why. So the case that matters here is the early-return branch,
 * covered below with and without the "/oops" shape present, plus the
 * ordinary happy path and unconfirmed path to prove neither one runs the
 * probe at all.
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

// `workableSolver` builds its own Supabase client via `getSupabaseClient()`
// — see `lib/solvers/workable.ts` — so these have to be set before that
// function ever runs. `localhost` always passes `assertSupabaseProject`,
// matching the same env setup the Lever and Greenhouse orchestration tests
// use for the same reason.
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
  // enough to reproduce rather than mock away, and `workableSolver`'s
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

const { workableSolver } = await import("@/lib/solvers/workable");

const PONY_AI_APPLY_URL =
  "https://apply.workable.com/pony-ai/j/d29663c0-994f-4a09-912a-0ecfc8bb4542/";

const TMEIC_APPLY_URL = "https://apply.workable.com/j/68E556E5CA/apply";

const baseInput: SubmitApplicationInput = {
  jobApplicationId: "app-1",
  requiresCoverLetter: false,
};

const baseRow: PreflightRow = {
  status: "form_filled",
  company: "Pony.ai",
  jobTitle: "Software Engineer, Behavior",
  jobId: "job-1",
  jobDescription: null,
  ats: "workable",
  confirmationRef: null,
  applyUrl: PONY_AI_APPLY_URL,
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
    finalUrl: TMEIC_APPLY_URL,
    pageTitle: "TMEIC - Apply",
    screenshotPath: null,
    blockedReason: null,
    browserbaseSessionId: "bb-session-1",
    ...overrides,
  };
}

function makeFakeSession(): BrowserSession {
  return {
    stagehand: {} as unknown as BrowserSession["stagehand"],
    browser: { sessionId: "bb-session-1" } as unknown as BrowserSession["browser"],
    page: { evaluate: vi.fn() } as unknown as BrowserSession["page"],
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
    finalUrl: TMEIC_APPLY_URL,
    pageTitle: "TMEIC - Apply",
    screenshotPath: null,
    blockedReason: null,
    unconfirmedReason: null,
    rowUpdated: true,
    ...overrides,
  };
}

/** The exact message recovered from the one real blocked row — see `workable-solver.test.ts`. */
const OOPS_BLOCKED_REASON =
  'blocked_apply_url: the browser is at "https://apply.workable.com/oops" having opened the ' +
  "listing, and that page does not belong to the board this listing came from: the url names " +
  'the workable board "oops", but the listing was read from the board "pony-ai". The listing ' +
  `pointed at "${PONY_AI_APPLY_URL}", which passed this same rule before anything was opened, ` +
  "so a redirect or a click moved the browser afterwards. Nothing was typed into this page and " +
  "no resume was uploaded to it.";

beforeEach(() => {
  mockFillApplicationFormRetainingSession.mockReset();
  mockRunSubmitPhase.mockReset();
  mockRecordSkipQuietly.mockReset();
  mockCloseBrowserSession.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("workableSolver — happy path", () => {
  it("never touches the redirect probe, never logs a skip, and closes the session once when submitted", async () => {
    const session = makeFakeSession();
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    const submitResult = makeSubmitResult({ submitted: true, status: APPLICATION_STATUS.SUBMITTED });
    mockRunSubmitPhase.mockResolvedValue(submitResult);

    const outcome = await workableSolver(baseInput, baseRow);

    expect(outcome).toEqual(submitResult);
    expect(mockRecordSkipQuietly).not.toHaveBeenCalled();
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockCloseBrowserSession).toHaveBeenCalledWith(session);
  });
});

describe("workableSolver — an ordinary submission_unconfirmed result", () => {
  it("passes the result through untouched — no Workable-specific gate applies after a live submit", async () => {
    const session = makeFakeSession();
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult(),
      session,
    });
    const genericHedge =
      "SUBMIT was clicked, but the application form is still on screen, with no confirmation of any kind.";
    const submitResult = makeSubmitResult({
      submitted: false,
      status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
      unconfirmedReason: genericHedge,
    });
    mockRunSubmitPhase.mockResolvedValue(submitResult);

    const outcome = await workableSolver(baseInput, baseRow);

    expect(outcome).toEqual(submitResult);
    expect(outcome.unconfirmedReason).toBe(genericHedge);
    expect(mockRecordSkipQuietly).not.toHaveBeenCalled();
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockCloseBrowserSession).toHaveBeenCalledWith(session);
  });
});

describe("workableSolver — the /oops redirect gate fires", () => {
  it("writes a supplementary blocked_redirect skip_log row and appends to blockedReason", async () => {
    const blockedResult = makeFillResult({
      status: APPLICATION_STATUS.FORM_FILL_BLOCKED,
      blockedReason: OOPS_BLOCKED_REASON,
      browserbaseSessionId: "bb-session-1",
    });
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: blockedResult,
      // `RetainedFillSession`'s own contract: session is null on every
      // blocked path — see `lib/fill-application-form.ts`. No live browser
      // survives this branch, which is exactly why the probe reads
      // `fill.blockedReason` rather than the DOM.
      session: null,
    });

    const outcome = await workableSolver(baseInput, baseRow);

    expect(mockRunSubmitPhase).not.toHaveBeenCalled();
    expect(mockRecordSkipQuietly).toHaveBeenCalledTimes(1);
    const [, skipInput] = mockRecordSkipQuietly.mock.calls[0]!;
    expect(skipInput).toMatchObject({
      applicationId: "app-1",
      jobId: baseRow.jobId,
      ats: baseRow.ats,
      reason: "blocked_redirect",
      browserbaseSessionId: "bb-session-1",
    });
    expect(skipInput.message).toContain("apply.workable.com/oops");

    // `blockedReason` started as the generic message, so the merge is an
    // append, not an overwrite — the original evidence stays readable.
    expect(outcome.blockedReason).toContain(OOPS_BLOCKED_REASON);
    expect(outcome.blockedReason).toContain("Workable's own redirect handling also confirmed");
    expect(outcome.status).toBe(APPLICATION_STATUS.FORM_FILL_BLOCKED);
    expect(outcome.submitted).toBe(false);
    expect(outcome.submitAttempted).toBe(false);
    // Nothing was ever opened for this row (session was null), so there is
    // nothing to close.
    expect(mockCloseBrowserSession).not.toHaveBeenCalled();
  });
});

describe("workableSolver — the /oops redirect gate does not fire", () => {
  it("does not log a skip and leaves blockedReason exactly as the fill wrote it, on an unrelated block", async () => {
    const blockedResult = makeFillResult({
      status: APPLICATION_STATUS.FORM_FILL_BLOCKED,
      blockedReason: "needs_candidate_input: a required question had no stored answer",
    });
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: blockedResult,
      session: null,
    });

    const outcome = await workableSolver(baseInput, baseRow);

    expect(mockRunSubmitPhase).not.toHaveBeenCalled();
    expect(mockRecordSkipQuietly).not.toHaveBeenCalled();
    expect(outcome.blockedReason).toBe(blockedResult.blockedReason);
    expect(outcome.submitted).toBe(false);
    expect(outcome.status).toBe(APPLICATION_STATUS.FORM_FILL_BLOCKED);
    expect(mockCloseBrowserSession).not.toHaveBeenCalled();
  });

  it("still closes a session that came back live even when blockedReason is set", async () => {
    // Defensive branch: `fillApplicationFormRetainingSession`'s own contract
    // says this combination should not happen, but `workableSolver`'s guard
    // checks `session !== null` independently of `blockedReason`, so a
    // session handed back alongside a blocked result is still closed rather
    // than leaked.
    const session = makeFakeSession();
    const blockedResult = makeFillResult({
      status: APPLICATION_STATUS.FORM_FILL_BLOCKED,
      blockedReason: "needs_candidate_input: a required question had no stored answer",
    });
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: blockedResult,
      session,
    });

    await workableSolver(baseInput, baseRow);

    expect(mockRunSubmitPhase).not.toHaveBeenCalled();
    expect(mockCloseBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockCloseBrowserSession).toHaveBeenCalledWith(session);
  });
});

describe("workableSolver — no live session at all and no blockedReason", () => {
  it("falls back to the generic 'no live browser session' message", async () => {
    mockFillApplicationFormRetainingSession.mockResolvedValue({
      result: makeFillResult({ blockedReason: null }),
      session: null,
    });

    const outcome = await workableSolver(baseInput, baseRow);

    expect(mockRunSubmitPhase).not.toHaveBeenCalled();
    expect(mockRecordSkipQuietly).not.toHaveBeenCalled();
    expect(outcome.blockedReason).toBe(
      "the form fill returned no live browser session, so there was nothing to submit"
    );
  });
});
