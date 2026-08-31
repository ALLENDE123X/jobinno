/**
 * JOB-296 Phase 2. Integration tests for `runAgentFill`, the orchestrator
 * `dispatchApplicationFill` reaches when a run is on the agent path.
 *
 * The tests here mock every side effectful dependency of the orchestrator
 * (page adapter, agent loop, verify pass, submit click, skip log writer),
 * so nothing here opens a Browserbase session and nothing fires a real LLM
 * call. The composition under test is:
 *
 *   loadFactCatalog → openPage → prefill → agentLoop → verify → submit
 *
 * with a retry after a fail verdict that re runs the loop on the
 * escalation rung before writing the skip log.
 *
 * Covered:
 *
 *   - happy path: prefill runs, agent loop runs once, verify passes, submit
 *     returns submitted
 *   - verify fails once, retry with feedback escalates the loop, verify
 *     passes on round 2, submit succeeds
 *   - verify fails on both rounds, skip_log gets unanswerable_required,
 *     submit is never called and the returned status is form_fill_blocked
 *   - the agent loop throws AgentBudgetExceededError (cost cap), status is
 *     submission_blocked and submit is never called
 *   - verify reports captcha_blocked, skip_log gets `captcha`, submit is
 *     never called
 *
 * Not covered here, on purpose: the actual model provider call and the
 * actual browser side of prefill / submit. Those belong to sub ticket E,
 * which wires the Stagehand page adapter and the real LLM client into the
 * injectable seams this test drives with fakes.
 */

import { describe, expect, it, vi } from "vitest";

import {
  AgentFillPage,
  AgentFillNotImplementedError,
  RunAgentFillDeps,
  runAgentFill,
  serializeFactCatalog,
} from "@/lib/agent";
import type { FactCatalog } from "@/lib/agent/fact-catalog";
import type { VerifyResult, VerifyError } from "@/lib/agent/verify";
import type { PrefillReport } from "@/lib/agent/prefill";
import { AgentBudgetExceededError } from "@/lib/agent/router";
import type { SubmitApplicationInput } from "@/lib/submit-application";

const input: SubmitApplicationInput = {
  jobApplicationId: "app_abc",
  requiresCoverLetter: false,
};

const emptyPrefill: PrefillReport = { filled: [], skipped: [], errors: [] };

function fakeCatalog(): FactCatalog {
  return {
    userId: "user_1",
    entries: [
      {
        path: "firstName",
        label: "First name",
        value: "Pranav",
        source: "profile",
      },
      {
        path: "email",
        label: "Email address",
        value: "pranav@example.test",
        source: "profile",
      },
    ],
  };
}

function fakePage(): AgentFillPage {
  return {
    url: () => "https://apply.example.test/breezy/one",
    title: () => "Apply — Example",
    setFieldValue: async () => undefined,
    captureAccessibilityTree: () => ({ role: "form", children: [] }),
    probeValidation: () => undefined,
    waitForValidation: () => undefined,
    scanErrorMarkers: () => [],
    detectCaptcha: () => false,
  };
}

function threeUnfilledErrors(): VerifyError[] {
  return [
    {
      fieldSelector: "input#last-name",
      siblingLabel: "Last name",
      errorText: "Value is required",
    },
    {
      fieldSelector: "select#location",
      siblingLabel: "Location",
      errorText: "Value is required",
    },
    {
      fieldSelector: "textarea#why",
      siblingLabel: "Why do you want to work here?",
      errorText: "Value is required",
    },
  ];
}

/**
 * Assembles a `RunAgentFillDeps` with sensible defaults so each test can
 * override only the seams it cares about. `openPage` returns a page and a
 * close spy; `agentLoop` records how many times each rung was invoked so
 * the escalation check can look at the second call's options.
 */
function makeDeps(overrides: Partial<RunAgentFillDeps> = {}): {
  deps: RunAgentFillDeps;
  spies: {
    close: ReturnType<typeof vi.fn>;
    prefill: ReturnType<typeof vi.fn>;
    agentLoop: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    writeSkip: ReturnType<typeof vi.fn>;
    agentLoopOptions: ReturnType<typeof vi.fn>;
  };
} {
  // Spies wrap either the caller's override or the default fake below, so a
  // test that swaps `verify` still observes the swapped function through
  // `spies.verify`. Without this indirection the override lands under a
  // different function than the spy captured, and every observation reads
  // zero calls even though the override ran.
  const close = vi.fn(overrides.openPage === undefined ? async () => undefined : async () => undefined);
  const prefill = vi.fn(overrides.prefill ?? (async () => emptyPrefill));
  const agentLoop = vi.fn(
    overrides.agentLoop ?? (async () => ({ turns: 1, finalText: "done" }))
  );
  const verify = vi.fn<() => Promise<VerifyResult>>(
    overrides.verify ?? (async () => ({ status: "pass" as const }))
  );
  const submit = vi.fn(
    overrides.submit ??
      (async () => ({
        status: "submitted" as const,
        submitted: true,
        submitAttempted: true,
        confirmationRef: "APP-123",
        submitControlLabel: "Submit application",
        blockedReason: null,
        unconfirmedReason: null,
        finalUrl: "https://apply.example.test/breezy/one/done",
        pageTitle: "Application submitted",
      }))
  );
  const writeSkip = vi.fn(overrides.writeSkip ?? (async () => undefined));
  const agentLoopOptions = vi.fn(
    overrides.agentLoopOptions ??
      ((_input, tier: "primary" | "escalation") => ({
        modelCall: async () => ({
          text: `${tier} model done`,
          toolCalls: [],
          costCents: 0,
        }),
        runTool: async () => ({ ok: true }),
      }))
  );

  const openPage =
    overrides.openPage ??
    (async () => ({ page: fakePage(), close, session: { fake: true } }));

  const deps: RunAgentFillDeps = {
    loadFactCatalog: overrides.loadFactCatalog ?? (async () => fakeCatalog()),
    openPage,
    prefill,
    agentLoop,
    agentLoopOptions,
    verify,
    submit,
    writeSkip,
    env: overrides.env ?? {
      AGENT_MAX_STEPS: "30",
      AGENT_MAX_COST_CENTS: "200",
    },
  };

  return {
    deps,
    spies: { close, prefill, agentLoop, verify, submit, writeSkip, agentLoopOptions },
  };
}

describe("runAgentFill happy path", () => {
  it("runs prefill, one agent loop, verify pass, then submit", async () => {
    const { deps, spies } = makeDeps();

    const result = await runAgentFill(input, deps);

    expect(spies.prefill).toHaveBeenCalledOnce();
    expect(spies.agentLoop).toHaveBeenCalledOnce();
    expect(spies.verify).toHaveBeenCalledOnce();
    expect(spies.submit).toHaveBeenCalledOnce();
    expect(spies.writeSkip).not.toHaveBeenCalled();
    expect(spies.close).toHaveBeenCalledOnce();

    expect(result.status).toBe("submitted");
    expect(result.submitted).toBe(true);
    expect(result.submitAttempted).toBe(true);
    expect(result.confirmationRef).toBe("APP-123");
    expect(result.blockedReason).toBeNull();
  });

  it("the agent loop is given the serialized fact catalog and the primary tier options", async () => {
    const { deps, spies } = makeDeps();
    await runAgentFill(input, deps);

    const [session, catalogText, task, opts] = spies.agentLoop.mock.calls[0]!;
    expect(session).toEqual({ fake: true });
    expect(catalogText).toContain("firstName");
    expect(catalogText).toContain("email");
    expect(task).toContain("primary agent");
    expect(opts).toBeDefined();

    expect(spies.agentLoopOptions).toHaveBeenCalledWith(input, "primary");
  });
});

describe("runAgentFill retry contract", () => {
  it("re runs the loop on the escalation tier after one verify fail, then submits on round 2 pass", async () => {
    let verifyCalls = 0;
    const { deps, spies } = makeDeps({
      verify: vi.fn<() => Promise<VerifyResult>>(async () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { status: "fail", errors: threeUnfilledErrors() }
          : { status: "pass" };
      }),
    });

    const result = await runAgentFill(input, deps);

    expect(spies.agentLoop).toHaveBeenCalledTimes(2);
    expect(spies.verify).toHaveBeenCalledTimes(2);
    expect(spies.submit).toHaveBeenCalledOnce();
    expect(spies.writeSkip).not.toHaveBeenCalled();

    const secondCallTier = spies.agentLoopOptions.mock.calls[1]![1];
    expect(secondCallTier).toBe("escalation");

    const secondTask = spies.agentLoop.mock.calls[1]![2] as string;
    expect(secondTask).toContain("escalation pass");
    expect(secondTask).toContain("Value is required");
    expect(secondTask).toContain("Last name");

    expect(result.status).toBe("submitted");
    expect(result.submitted).toBe(true);
  });

  it("writes unanswerable_required and returns form_fill_blocked when verify fails on both rounds", async () => {
    const { deps, spies } = makeDeps({
      verify: vi.fn<() => Promise<VerifyResult>>(async () => ({
        status: "fail",
        errors: threeUnfilledErrors(),
      })),
    });

    const result = await runAgentFill(input, deps);

    expect(spies.agentLoop).toHaveBeenCalledTimes(2);
    expect(spies.verify).toHaveBeenCalledTimes(2);
    expect(spies.submit).not.toHaveBeenCalled();

    expect(spies.writeSkip).toHaveBeenCalledOnce();
    const skipCall = spies.writeSkip.mock.calls[0]![0];
    expect(skipCall.reason).toBe("unanswerable_required");
    expect(skipCall.message).toContain("could not clear pre submit verify after retry");
    expect(skipCall.fieldLabel).toBe("Last name");

    expect(result.status).toBe("form_fill_blocked");
    expect(result.submitted).toBe(false);
    expect(result.submitAttempted).toBe(false);
    expect(result.blockedReason).toBe(
      "pre submit verify failed after retry, nothing submitted"
    );
  });
});

describe("runAgentFill captcha handling", () => {
  it("skips with captcha reason and never submits when verify reports captcha_blocked", async () => {
    const { deps, spies } = makeDeps({
      verify: vi.fn<() => Promise<VerifyResult>>(async () => ({
        status: "captcha_blocked",
      })),
    });

    const result = await runAgentFill(input, deps);

    expect(spies.submit).not.toHaveBeenCalled();
    expect(spies.writeSkip).toHaveBeenCalledOnce();
    expect(spies.writeSkip.mock.calls[0]![0].reason).toBe("captcha");

    expect(result.status).toBe("form_fill_blocked");
    expect(result.submitted).toBe(false);
    expect(result.blockedReason).toBe("captcha on the form, nothing submitted");
  });
});

describe("runAgentFill budget breach", () => {
  it("catches AgentBudgetExceededError from the agent loop and returns submission_blocked", async () => {
    const { deps, spies } = makeDeps({
      agentLoop: vi.fn(async () => {
        throw new AgentBudgetExceededError({
          reason: "max-cost",
          steps: 12,
          costCents: 250,
        });
      }),
    });

    const result = await runAgentFill(input, deps);

    expect(spies.verify).not.toHaveBeenCalled();
    expect(spies.submit).not.toHaveBeenCalled();
    expect(spies.writeSkip).toHaveBeenCalledOnce();
    const skipCall = spies.writeSkip.mock.calls[0]![0];
    expect(skipCall.reason).toBe("internal_error");
    expect(skipCall.message).toContain("cost budget");

    expect(result.status).toBe("submission_blocked");
    expect(result.submitted).toBe(false);
    expect(result.blockedReason).toContain("cost budget");
  });

  it("catches a step cap breach and writes it as a timeout skip", async () => {
    const { deps, spies } = makeDeps({
      agentLoop: vi.fn(async () => {
        throw new AgentBudgetExceededError({
          reason: "max-steps",
          steps: 60,
          costCents: 50,
        });
      }),
    });

    await runAgentFill(input, deps);
    expect(spies.writeSkip).toHaveBeenCalledOnce();
    expect(spies.writeSkip.mock.calls[0]![0].reason).toBe("timeout");
  });
});

describe("runAgentFill teardown", () => {
  it("closes the page even when submit throws", async () => {
    const { deps, spies } = makeDeps({
      submit: vi.fn(async () => {
        throw new Error("simulated submit failure");
      }),
    });

    await expect(runAgentFill(input, deps)).rejects.toThrow(
      "simulated submit failure"
    );
    expect(spies.close).toHaveBeenCalledOnce();
  });

  it("swallows a close throw so the real result reaches the caller", async () => {
    const { deps, spies } = makeDeps({
      openPage: async () => ({
        page: fakePage(),
        session: { fake: true },
        close: vi.fn(async () => {
          throw new Error("teardown failure");
        }),
      }),
    });

    const result = await runAgentFill(input, deps);
    expect(result.status).toBe("submitted");
    expect(spies.submit).toHaveBeenCalledOnce();
  });
});

describe("runAgentFill default deps", () => {
  it("throws AgentFillNotImplementedError from the default loadFactCatalog", async () => {
    await expect(runAgentFill(input)).rejects.toBeInstanceOf(
      AgentFillNotImplementedError
    );
  });

  it("passes deps.env through to agentLoop when the injected options do not override it", async () => {
    const { deps, spies } = makeDeps({
      agentLoopOptions: vi.fn(() => ({
        modelCall: async () => ({ text: "ok", toolCalls: [], costCents: 0 }),
        runTool: async () => ({ ok: true }),
      })),
      env: { AGENT_MAX_STEPS: "7", AGENT_MAX_COST_CENTS: "13" },
    });

    await runAgentFill(input, deps);
    const opts = spies.agentLoop.mock.calls[0]![3] as { env?: Record<string, string> };
    expect(opts.env).toEqual({ AGENT_MAX_STEPS: "7", AGENT_MAX_COST_CENTS: "13" });
  });
});

describe("serializeFactCatalog", () => {
  it("returns a header plus one line per entry", () => {
    const text = serializeFactCatalog(fakeCatalog());
    expect(text).toContain("# fact catalog for user_1");
    expect(text).toContain("firstName\tFirst name\tPranav\tprofile");
    expect(text).toContain("email\tEmail address\tpranav@example.test\tprofile");
  });

  it("collapses an empty catalog to a stable placeholder", () => {
    const text = serializeFactCatalog({ userId: "u", entries: [] });
    expect(text).toBe("# fact catalog for u\n(no entries)");
  });

  it("prints (null) for a null value and coerces non string values", () => {
    const text = serializeFactCatalog({
      userId: "u",
      entries: [
        { path: "a", label: "A", value: null, source: "profile" },
        { path: "b", label: "B", value: 42, source: "profile" },
        { path: "c", label: "C", value: true, source: "profile" },
      ],
    });
    expect(text).toContain("a\tA\t(null)\tprofile");
    expect(text).toContain("b\tB\t42\tprofile");
    expect(text).toContain("c\tC\ttrue\tprofile");
  });
});
