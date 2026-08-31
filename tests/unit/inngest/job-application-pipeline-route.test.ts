/**
 * JOB-296, sub ticket G phase 1.
 *
 * Proves the `USE_AGENT_FILL` / `USE_AGENT_FILL_ATS` gate on the apply to job
 * handler itself, by driving the real `applyToJob` function with a stub
 * `step`. The dispatch decision in `lib/agent/index.ts` has its own unit test
 * (JOB-277); this test mounts the real handler around it so that a mistake in
 * how the pipeline threads the flags into `dispatchApplicationFill` shows up
 * here instead of on a greenhouse job in production.
 *
 * Three cases:
 *  1. Both flags off. `submitApplication` runs exactly as it did before the
 *     gate existed, and no allowance is settled, because the mock submit
 *     reports a real application as sent.
 *  2. `USE_AGENT_FILL=true` and the allowlist names greenhouse. The handler
 *     takes the agent path, which V1 still answers with an
 *     `AgentFillNotImplementedError`, and the failure path settles the
 *     reserved allowance before the error propagates.
 *  3. `USE_AGENT_FILL=true` and the allowlist names lever while the listing
 *     is greenhouse. The allowlist is the whole gate, so this routes to the
 *     legacy path exactly like case 1.
 *
 * The two modules that reach a real browser and a real database boundary are
 * replaced by doubles (stagehand session, supabase client, application rows,
 * allowance, analytics and the legacy submit). `@/lib/agent` is deliberately
 * NOT replaced: case 2 asserts the real V1 stub answer.
 *
 * `applyToJob` is imported dynamically, not statically. The Inngest client
 * bakes `INNGEST_DEV` in at construction time (see `inngest/load-env.ts`), so
 * the modules must load once the environment is in place.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentFillNotImplementedError } from "@/lib/agent";
import { claimApplicationRow } from "@/lib/application-records";
import { releaseApplicationSlot, reserveApplicationSlot } from "@/lib/application-quota";
import { submitApplication } from "@/lib/submit-application";

const h = vi.hoisted(() => ({
  USER_ID: "00000000-0000-4000-8000-000000000001",
  JOB_ID: "00000000-0000-4000-8000-000000000002",
  APPLICATION_ID: "00000000-0000-4000-8000-000000000003",
  listingRow: {
    id: "00000000-0000-4000-8000-000000000002",
    title: "Software Engineer Intern",
    url: "https://boards.greenhouse.io/example/jobs/123",
    ats: "greenhouse",
    raw: { questions: [], fields: {} },
    boards: [{ company: "Acme Corp" }],
  },
}));

vi.mock("@/lib/stagehand-session", () => ({
  NAVIGATION_TIMEOUT_MS: 30_000,
  browserConcurrencyLimit: () => 1,
}));

vi.mock("@/lib/supabase-project-guard", () => ({
  assertSupabaseProject: () => undefined,
}));

vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return {
    ...actual,
    createClient: vi.fn(() => fakeSupabaseClient()),
  };
});

function fakeSupabaseClient() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            data: table === "jobs" ? [h.listingRow] : [],
            error: null,
          }),
        }),
      }),
    }),
  };
}

vi.mock("@/lib/application-records", () => ({
  claimApplicationRow: vi.fn(async () => ({
    applicationId: h.APPLICATION_ID,
    created: true,
  })),
  recordSkipQuietly: vi.fn(async () => undefined),
}));

vi.mock("@/lib/application-quota", () => ({
  reserveApplicationSlot: vi.fn(async () => ({ reserved: true, used: 1, cap: 20 })),
  releaseApplicationSlot: vi.fn(async () => ({ outcome: "released", used: 0 })),
}));

vi.mock("@/lib/analytics/posthog-server", () => ({
  captureServerEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/submit-application", () => ({
  SubmissionBlockedError: class SubmissionBlockedError extends Error {},
  submitApplication: vi.fn(async (input: { jobApplicationId: string }) => ({
    jobApplicationId: input.jobApplicationId,
    status: "submitted",
    submitted: true,
    submitAttempted: true,
    confirmationRef: "fake-confirmation-ref",
    confirmation: true,
    securityCode: null,
    approval: null,
    submitControlLabel: "Submit Application",
    blockedReason: null,
    unconfirmedReason: null,
    finalUrl: "https://boards.greenhouse.io/example/thanks",
    pageTitle: "Acme Corp",
    screenshotPath: null,
    rowUpdated: true,
  })),
}));

type FakeStep = { run: (name: string, fn: () => unknown) => Promise<unknown> };

const fakeStep: FakeStep = {
  run: async (_name, fn) => await fn(),
};

type ApplyToJobFunction = {
  fn: (args: { event: { data: unknown }; step: FakeStep }) => Promise<unknown>;
};

async function loadApplyToJob(): Promise<ApplyToJobFunction> {
  process.env.INNGEST_DEV = "1";
  process.env.SUPABASE_URL ??= "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  const mod = await import("@/inngest/job-application-pipeline");
  return mod.applyToJob as unknown as ApplyToJobFunction;
}

function eventData(): unknown {
  return { userId: h.USER_ID, jobId: h.JOB_ID };
}

describe("apply-to-job agent fill gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.USE_AGENT_FILL;
    delete process.env.USE_AGENT_FILL_ATS;
  });

  it("submits through the legacy leg with both flags off", async () => {
    const applyToJob = await loadApplyToJob();

    const result = (await applyToJob.fn({
      event: { data: eventData() },
      step: fakeStep,
    })) as Record<string, unknown>;

    expect(submitApplication).toHaveBeenCalledTimes(1);
    expect(submitApplication).toHaveBeenCalledWith({
      jobApplicationId: h.APPLICATION_ID,
      requiresCoverLetter: false,
    });
    expect(claimApplicationRow).toHaveBeenCalledWith(expect.anything(), {
      userId: h.USER_ID,
      jobId: h.JOB_ID,
    });
    expect(releaseApplicationSlot).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      applicationId: h.APPLICATION_ID,
      status: "submitted",
      submitted: true,
      needsHuman: false,
    });
  });

  it("rejects with AgentFillNotImplementedError and settles the allowance when the allowlist names the platform", async () => {
    process.env.USE_AGENT_FILL = "true";
    process.env.USE_AGENT_FILL_ATS = "greenhouse";
    const applyToJob = await loadApplyToJob();

    await expect(
      applyToJob.fn({ event: { data: eventData() }, step: fakeStep })
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);

    expect(submitApplication).not.toHaveBeenCalled();
    expect(reserveApplicationSlot).toHaveBeenCalledWith(h.USER_ID);
    expect(releaseApplicationSlot).toHaveBeenCalledTimes(1);
    expect(releaseApplicationSlot).toHaveBeenCalledWith({
      userId: h.USER_ID,
      applicationId: h.APPLICATION_ID,
    });
  });

  it("takes the legacy leg when the allowlist names a different platform", async () => {
    process.env.USE_AGENT_FILL = "true";
    process.env.USE_AGENT_FILL_ATS = "lever";
    const applyToJob = await loadApplyToJob();

    const result = (await applyToJob.fn({
      event: { data: eventData() },
      step: fakeStep,
    })) as Record<string, unknown>;

    expect(submitApplication).toHaveBeenCalledTimes(1);
    expect(submitApplication).toHaveBeenCalledWith({
      jobApplicationId: h.APPLICATION_ID,
      requiresCoverLetter: false,
    });
    expect(result.status).toBe("submitted");
  });
});