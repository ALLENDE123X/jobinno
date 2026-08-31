/**
 * JOB-316. `runAgentFill` wiring: the session threads into the loop, the
 * serialized catalog and the guardrail prompt reach the model, and every
 * terminal arm writes the status vocabulary `lib/application-status.ts`
 * already defines, never a new one.
 *
 * Everything wet is injected through `AgentFillDeps`; no browser, database or
 * model is anywhere near these tests.
 */

import { describe, expect, it, vi } from "vitest";

import {
  AgentFillNotImplementedError,
  AgentSessionLostError,
  looksLikeSessionLoss,
  runAgentFill,
  type AgentFillDeps,
  type SubmitLegOutcome,
} from "@/lib/agent";
import { AgentBudgetExceededError } from "@/lib/agent/router";
import { serializeFactCatalog, type FactCatalog } from "@/lib/agent/fact-catalog";
import type { BrowserSession } from "@/lib/stagehand-session";
import type { SubmitApplicationInput } from "@/lib/submit-application";
import type { SupabaseClient } from "@supabase/supabase-js";

const input: SubmitApplicationInput = {
  jobApplicationId: "app-1",
  requiresCoverLetter: false,
};

const catalog: FactCatalog = {
  userId: "u1",
  entries: [
    { path: "email", label: "Email address", value: "a@b.example", source: "profile" },
  ],
};

type RecordedWrite = { table: string; values: Record<string, unknown> };

function fakeSupabase(rows: {
  applications?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
}) {
  const updates: RecordedWrite[] = [];
  const inserts: RecordedWrite[] = [];
  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                limit() {
                  const data =
                    table === "applications"
                      ? (rows.applications ?? [])
                      : (rows.jobs ?? []);
                  return Promise.resolve({ data, error: null });
                },
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          return {
            eq() {
              updates.push({ table, values });
              return Promise.resolve({ error: null });
            },
          };
        },
        insert(values: Record<string, unknown>) {
          inserts.push({ table, values });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, updates, inserts };
}

function fakeSession(): BrowserSession {
  return {
    page: {
      url: () => "https://board.example/apply",
      goto: async () => undefined,
      evaluate: async () => false,
    },
    browser: { provider: "local", close: async () => undefined },
    stagehand: { act: async () => undefined },
    logTag: "[test]",
  } as unknown as BrowserSession;
}

const submittedLeg: SubmitLegOutcome = {
  clicked: true,
  submitted: true,
  confirmationRef: "ref 123",
  confirmation: null,
  submitControlLabel: "Submit application",
  finalUrl: "https://board.example/thanks",
  pageTitle: "Thanks",
  detail: "confirmation page: true",
};

function baseDeps(overrides: Partial<AgentFillDeps> = {}) {
  const db = fakeSupabase({
    applications: [
      { id: "app-1", user_id: "u1", job_id: "job-1", status: "discovered" },
    ],
    jobs: [{ apply_url: "https://board.example/apply", ats: "greenhouse" }],
  });
  const session = fakeSession();
  const loop = vi.fn(async () => ({ turns: 1 }));
  const openSession = vi.fn(async () => session);
  const closeSession = vi.fn(async () => undefined);
  const verify = vi.fn(async () => ({ status: "pass" as const }));
  const submitLeg = vi.fn(async () => submittedLeg);
  const deps: AgentFillDeps = {
    getSupabase: async () => db.client,
    loadFactCatalog: async () => catalog,
    openSession,
    closeSession,
    loop,
    verify,
    submitLeg,
    env: {},
    ...overrides,
  };
  return { db, session, loop, openSession, closeSession, verify, submitLeg, deps };
}

describe("runAgentFill", () => {
  it("threads the session, catalog and guardrail prompt into the loop, then submits", async () => {
    const { db, session, loop, closeSession, deps } = baseDeps();

    const result = await runAgentFill(input, deps);

    expect(loop).toHaveBeenCalledTimes(1);
    const [loopSession, loopCatalog, loopTask] = loop.mock.calls[0] as unknown[];
    expect(loopSession).toBe(session);
    expect(loopCatalog).toBe(serializeFactCatalog(catalog));
    expect(String(loopTask)).toMatch(/HARD STOP 9/);
    expect(String(loopTask)).toMatch(/HARD STOP 10/);

    expect(result.status).toBe("submitted");
    expect(result.submitted).toBe(true);
    expect(result.submitAttempted).toBe(true);
    expect(result.confirmationRef).toBe("ref 123");
    expect(result.rowUpdated).toBe(true);

    const statuses = db.updates.map((write) => write.values.status);
    expect(statuses[0]).toBe("filling_form");
    expect(statuses[statuses.length - 1]).toBe("submitted");
    const last = db.updates[db.updates.length - 1].values;
    expect(last.confirmation_text).toBe("ref 123");
    expect(typeof last.submitted_at).toBe("string");
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  it("refuses a row whose submit control was already clicked", async () => {
    const { deps, openSession } = baseDeps();
    const db = fakeSupabase({
      applications: [
        { id: "app-1", user_id: "u1", job_id: "job-1", status: "submitted" },
      ],
      jobs: [{ apply_url: "https://board.example/apply", ats: "greenhouse" }],
    });
    deps.getSupabase = async () => db.client;

    await expect(runAgentFill(input, deps)).rejects.toThrow(/already at/);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("terminates a captcha as form_fill_blocked with the captcha skip reason", async () => {
    const { db, submitLeg, deps } = baseDeps({
      verify: vi.fn(async () => ({ status: "captcha_blocked" as const })),
    });

    const result = await runAgentFill(input, deps);

    expect(result.status).toBe("form_fill_blocked");
    expect(result.submitted).toBe(false);
    expect(result.submitAttempted).toBe(false);
    expect(result.blockedReason).toMatch(/captcha/);
    expect(submitLeg).not.toHaveBeenCalled();

    const skip = db.inserts.find((write) => write.table === "skip_log");
    expect(skip?.values.reason).toBe("captcha");
  });

  it("terminates a budget breach as form_fill_blocked with the budget named", async () => {
    const { db, submitLeg, deps } = baseDeps({
      loop: vi.fn(async () => {
        throw new AgentBudgetExceededError({
          reason: "max-cost",
          steps: 3,
          costCents: 250,
        });
      }),
    });

    const result = await runAgentFill(input, deps);

    expect(result.status).toBe("form_fill_blocked");
    expect(result.blockedReason).toMatch(/budget exceeded/);
    expect(result.blockedReason).toMatch(/250/);
    expect(submitLeg).not.toHaveBeenCalled();
    const skip = db.inserts.find((write) => write.table === "skip_log");
    expect(skip?.values.reason).toBe("internal_error");
  });

  it("records a dead browser and throws the typed AgentSessionLostError", async () => {
    const { db, closeSession, deps } = baseDeps({
      loop: vi.fn(async () => {
        throw new Error("Target closed");
      }),
    });

    await expect(runAgentFill(input, deps)).rejects.toBeInstanceOf(
      AgentSessionLostError
    );

    const statuses = db.updates.map((write) => write.values.status);
    expect(statuses).toContain("error");
    const skip = db.inserts.find((write) => write.table === "skip_log");
    expect(skip).toBeDefined();
    expect(String(skip?.values.reason)).toBe("internal_error");
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  it("retries once with the escalated prompt when verify fails, then submits", async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce({
        status: "fail",
        errors: [
          {
            fieldSelector: "#salary",
            siblingLabel: "Expected salary",
            errorText: "Value is required",
          },
        ],
      })
      .mockResolvedValueOnce({ status: "pass" });
    const { loop, deps } = baseDeps({ verify });

    const result = await runAgentFill(input, deps);

    expect(loop).toHaveBeenCalledTimes(2);
    const secondTask = String((loop.mock.calls[1] as unknown[])[2]);
    expect(secondTask).toMatch(/Escalated pass/);
    expect(secondTask).toMatch(/Value is required/);
    expect(result.status).toBe("submitted");
  });

  it("blocks as unanswerable when verify still fails after the escalated pass", async () => {
    const failVerdict = {
      status: "fail" as const,
      errors: [
        {
          fieldSelector: "#salary",
          siblingLabel: "Expected salary",
          errorText: "Value is required",
        },
      ],
    };
    const { db, submitLeg, deps } = baseDeps({
      verify: vi.fn(async () => failVerdict),
    });

    const result = await runAgentFill(input, deps);

    expect(result.status).toBe("form_fill_blocked");
    expect(submitLeg).not.toHaveBeenCalled();
    const skip = db.inserts.find((write) => write.table === "skip_log");
    expect(skip?.values.reason).toBe("unanswerable_required");
  });

  it("blocks without clicking when no submit control could be identified", async () => {
    const { db, deps } = baseDeps({
      submitLeg: vi.fn(async () => ({
        ...submittedLeg,
        clicked: false,
        submitted: false,
        confirmationRef: null,
        detail:
          "submission_blocked: no control could be identified as the " +
          "application submit, so nothing was clicked.",
      })),
    });

    const result = await runAgentFill(input, deps);

    expect(result.status).toBe("submission_blocked");
    expect(result.submitAttempted).toBe(false);
    const skip = db.inserts.find((write) => write.table === "skip_log");
    expect(skip?.values.reason).toBe("submit_failed");
  });

  it("writes submission_unconfirmed when the click landed and nothing corroborated it", async () => {
    const { db, deps } = baseDeps({
      submitLeg: vi.fn(async () => ({
        ...submittedLeg,
        submitted: false,
        confirmationRef: null,
        detail:
          "submit_clicked_outcome_unknown: the page afterwards did not " +
          "corroborate a submission. Not retrying.",
      })),
    });

    const result = await runAgentFill(input, deps);

    expect(result.status).toBe("submission_unconfirmed");
    expect(result.submitted).toBe(false);
    expect(result.submitAttempted).toBe(true);
    expect(result.unconfirmedReason).toMatch(/Not retrying/);
    const statuses = db.updates.map((write) => write.values.status);
    expect(statuses[statuses.length - 1]).toBe("submission_unconfirmed");
    const skip = db.inserts.find((write) => write.table === "skip_log");
    expect(skip?.values.reason).toBe("submit_failed");
  });

  it("surfaces a stub tool handler as error plus a skip row, then rethrows", async () => {
    const { db, deps } = baseDeps({
      loop: vi.fn(async () => {
        throw new AgentFillNotImplementedError("setFieldValue");
      }),
    });

    await expect(runAgentFill(input, deps)).rejects.toBeInstanceOf(
      AgentFillNotImplementedError
    );
    const statuses = db.updates.map((write) => write.values.status);
    expect(statuses).toContain("error");
    const skip = db.inserts.find((write) => write.table === "skip_log");
    expect(skip?.values.reason).toBe("internal_error");
  });
});

describe("looksLikeSessionLoss", () => {
  it("recognizes the message shapes a dead browser produces", () => {
    for (const message of [
      "Target closed",
      "browser has been closed",
      "Protocol error (Page.navigate): Session closed.",
      "WebSocket is not open",
      "page crashed",
    ]) {
      expect(looksLikeSessionLoss(new Error(message))).toBe(true);
    }
  });

  it("does not classify ordinary errors as session loss", () => {
    expect(looksLikeSessionLoss(new Error("Value is required"))).toBe(false);
    expect(looksLikeSessionLoss(new Error("zod validation failed"))).toBe(false);
  });
});
