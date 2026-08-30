/**
 * JOB-282 (sub ticket E of #276). Cases for the model router and the outer
 * agent loop.
 *
 * The router decides which rung the loop runs on. The spike evidence pinned
 * the policy: Gemini primary on the first attempt, Sonnet escalation on any
 * later attempt or when a known complex widget class is reported, and Haiku
 * never at any tier. The loop tests drive `runAgentLoop` with an injected
 * model function and tool handler so the budget caps and the escalation
 * handoff are observable without any live provider.
 */

import { describe, expect, it } from "vitest";

import {
  AgentBudgetExceededError,
  pickModel,
  runAgentLoop,
  type AgentMessages,
  type AgentModelResponse,
  type AgentToolCall,
  type ModelConfig,
} from "@/lib/agent/router";

const GEMINI = "google/gemini-3-1-pro-preview";
const SONNET = "anthropic/claude-sonnet-4-6";
const HAIKU = "anthropic/claude-haiku-4-5";

describe("pickModel", () => {
  it("retry zero with no hint returns the Gemini primary", () => {
    const config = pickModel({ retry: 0 });
    expect(config.tier).toBe("primary");
    expect(config.model).toBe(GEMINI);
  });

  it("retry zero with the complex widget hint returns the Sonnet escalation", () => {
    const config = pickModel({ retry: 0, hint: "complex-widget" });
    expect(config.tier).toBe("escalation");
    expect(config.model).toBe(SONNET);
  });

  it("retry zero with the modal heavy hint also escalates", () => {
    const config = pickModel({ retry: 0, hint: "modal-heavy" });
    expect(config.tier).toBe("escalation");
    expect(config.model).toBe(SONNET);
  });

  it("retry one returns the Sonnet escalation regardless of hint", () => {
    expect(pickModel({ retry: 1 }).model).toBe(SONNET);
    expect(pickModel({ retry: 1, hint: "complex-widget" }).model).toBe(SONNET);
    expect(pickModel({ retry: 2, hint: undefined }).model).toBe(SONNET);
  });

  it("honors an operator escalation override through env", () => {
    const config = pickModel(
      { retry: 1 },
      { USE_AGENT_ESCALATION_MODEL: "anthropic/claude-sonnet-4-6-custom" }
    );
    expect(config.model).toBe("anthropic/claude-sonnet-4-6-custom");
  });

  it("never resolves to a Haiku identifier, even from an env override", () => {
    // Defensive against a future config change pushing a Haiku id through
    // the operator override. The boundary guard must fail loud rather than
    // silently route onto a model the spike evidence proved unusable.
    expect(() =>
      pickModel({ retry: 1 }, { USE_AGENT_ESCALATION_MODEL: HAIKU })
    ).toThrow(/not viable/);
    // The plain primary and escalation paths also resolve away from Haiku.
    const primary = pickModel({ retry: 0 }).model;
    const escalation = pickModel({ retry: 1 }).model;
    expect([primary, escalation]).not.toContain(HAIKU);
  });
});

describe("runAgentLoop", () => {
  /**
   * Records every model call the loop makes. `responses` is consumed in
   * order so a test can script a multi turn arc (first turn asks for a tool,
   * second turn finishes), and `seen` captures the model id and message
   * shape handed to the function for later assertions.
   */
  function scriptedModel(
    responses: Array<Partial<AgentModelResponse>>
  ): {
    handler: (config: ModelConfig, messages: AgentMessages) => Promise<AgentModelResponse>;
    seen: Array<{ model: string; messages: AgentMessages }>;
  } {
    const seen: Array<{ model: string; messages: AgentMessages }> = [];
    let index = 0;
    return {
      seen,
      handler: async (config, messages) => {
        seen.push({ model: config.model, messages });
        const scripted = responses[index] ?? {};
        index += 1;
        return {
          text: scripted.text,
          toolCalls: scripted.toolCalls ?? [],
          costCents: scripted.costCents ?? 0,
        };
      },
    };
  }

  function alwaysFailComplex(
    toolCall: AgentToolCall
  ): Promise<{ ok: boolean; signal: "complex-widget" }> {
    void toolCall;
    return Promise.resolve({ ok: false, signal: "complex-widget" });
  }

  it("escalates to the Sonnet rung when a tool reports a complex widget", async () => {
    const model = scriptedModel([
      // First turn asks for one tool, which will fail with the complex
      // widget signal.
      {
        text: "Inspecting the modal.",
        toolCalls: [{ id: "t1", name: "inspect", input: "{}" }],
      },
      // Second turn finds no further tools and finishes.
      { text: "Done.", toolCalls: [] },
    ]);

    const result = await runAgentLoop(
      undefined,
      "Facts",
      "Fill the form",
      {
        modelCall: model.handler,
        runTool: alwaysFailComplex,
      }
    );

    expect(model.seen[0]?.model).toBe(GEMINI);
    expect(model.seen[1]?.model).toBe(SONNET);
    expect(result.turns).toBe(2);
    expect(result.finalText).toBe("Done.");
  });

  it("aborts cleanly with a max-steps error at the step cap", async () => {
    // The model never finishes; every turn asks for another tool. With a
    // step cap of two the loop must make exactly two model calls and then
    // throw the typed budget error carrying the actual step counter.
    const model = scriptedModel([
      { toolCalls: [{ id: "t1", name: "inspect", input: "{}" }] },
      { toolCalls: [{ id: "t2", name: "inspect", input: "{}" }] },
    ]);
    const runTool = async () => ({ ok: true });

    const error = await runAgentLoop(undefined, "Facts", "Fill", {
      modelCall: model.handler,
      runTool,
      env: { AGENT_MAX_STEPS: "2" },
    }).then(
      () => new Error("expected the loop to reject"),
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(AgentBudgetExceededError);
    if (error instanceof AgentBudgetExceededError) {
      expect(error.reason).toBe("max-steps");
      expect(error.steps).toBe(2);
    }
  });

  it("aborts cleanly with a max-cost error at the cost cap", async () => {
    // A single call whose reported cost already clears the cap must make
    // the loop throw the cost budget error after one turn.
    const model = scriptedModel([{ costCents: 10, toolCalls: [] }]);
    const runTool = async () => ({ ok: true });

    const error = await runAgentLoop(undefined, "Facts", "Fill", {
      modelCall: model.handler,
      runTool,
      env: { AGENT_MAX_COST_CENTS: "5" },
    }).then(
      () => new Error("expected the loop to reject"),
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(AgentBudgetExceededError);
    if (error instanceof AgentBudgetExceededError) {
      expect(error.reason).toBe("max-cost");
      expect(error.costCents).toBe(10);
    }
  });
});
