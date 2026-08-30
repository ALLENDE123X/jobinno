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
    const config = pickModel({ retry: 0 }, {});
    expect(config.tier).toBe("primary");
    expect(config.model).toBe(GEMINI);
  });

  it("retry zero with the complex widget hint returns the Sonnet escalation", () => {
    const config = pickModel({ retry: 0, hint: "complex-widget" }, {});
    expect(config.tier).toBe("escalation");
    expect(config.model).toBe(SONNET);
  });

  it("retry zero with the modal heavy hint also escalates", () => {
    const config = pickModel({ retry: 0, hint: "modal-heavy" }, {});
    expect(config.tier).toBe("escalation");
    expect(config.model).toBe(SONNET);
  });

  it("retry one returns the Sonnet escalation regardless of hint", () => {
    expect(pickModel({ retry: 1 }, {}).model).toBe(SONNET);
    expect(pickModel({ retry: 1, hint: "complex-widget" }, {}).model).toBe(
      SONNET
    );
    expect(pickModel({ retry: 2, hint: undefined }, {}).model).toBe(SONNET);
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
    const primary = pickModel({ retry: 0 }, {}).model;
    const escalation = pickModel({ retry: 1 }, {}).model;
    expect([primary, escalation]).not.toContain(HAIKU);
  });

  it("refuses dated and aliased Haiku identifiers, not just the bare id", () => {
    // Regression for the earlier exact equality check on the bare id. Any
    // dated variant (Anthropic ships ids like `claude-haiku-4-5-20261001`)
    // or alias (`claude-haiku-4-5-latest`) has to trip the same guard, or
    // the boundary check loses the entire scenario it exists to catch. The
    // check is also case insensitive so a shouty override does not slip.
    const forbidden = [
      "anthropic/claude-haiku-4-5-20261001",
      "anthropic/claude-haiku-4-5-latest",
      "anthropic/CLAUDE-HAIKU-4-5",
      "openrouter/anthropic/claude-haiku-4-5",
      "claude-haiku-4-5",
    ];
    for (const model of forbidden) {
      expect(() =>
        pickModel({ retry: 1 }, { USE_AGENT_ESCALATION_MODEL: model })
      ).toThrow(/not viable/);
    }
  });

  it("passes a Sonnet id through the same guard cleanly", () => {
    // Sanity companion to the Haiku regression: the substring check must
    // not be so wide that it also catches other Anthropic family names.
    expect(
      pickModel(
        { retry: 1 },
        { USE_AGENT_ESCALATION_MODEL: "anthropic/claude-sonnet-4-6" }
      ).model
    ).toBe("anthropic/claude-sonnet-4-6");
  });

  it("attaches the provider family to the config for every id spelling", () => {
    // The loop routes on `config.provider` rather than string sniffing the
    // model id, so `pickModel` has to classify the resolved id for every
    // realistic spelling an operator override might supply. All three of
    // these are Anthropic and must route to the caching path.
    for (const model of [
      "claude-sonnet-4-6",
      "anthropic/claude-sonnet-4-6",
      "openrouter/anthropic/claude-sonnet-4-6",
    ]) {
      expect(
        pickModel({ retry: 1 }, { USE_AGENT_ESCALATION_MODEL: model }).provider
      ).toBe("anthropic");
    }
    // Google prefixed and bare Gemini ids both classify as `google`.
    expect(pickModel({ retry: 0 }, {}).provider).toBe("google");
    // Any unrecognized family lands in `other` so a new provider name
    // routes to the legacy path by default rather than silently claiming
    // Anthropic caching semantics.
    expect(
      pickModel({ retry: 1 }, { USE_AGENT_ESCALATION_MODEL: "mistral/large-2" })
        .provider
    ).toBe("other");
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
        env: {},
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

  it("aborts cleanly with a max-cost error at the cost cap on a non terminal turn", async () => {
    // The first call reports a cost that already clears the cap AND asks for
    // another tool, so the loop cannot terminate on that turn. The cost
    // check must fire on the next iteration boundary and throw the cost
    // budget error with the actual counter.
    const model = scriptedModel([
      { costCents: 10, toolCalls: [{ id: "t1", name: "inspect", input: "{}" }] },
    ]);
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

  it("returns the finished answer even when the terminal turn crosses the cost cap", async () => {
    // Regression for the earlier `>=` cap check that fired before the
    // terminal return and discarded a run's own finished text. A call that
    // reports the cap exactly and produces no further tool calls is a
    // clean terminal turn: the loop must hand back the answer instead of
    // aborting a run the model already finished.
    const model = scriptedModel([
      { text: "Final answer.", costCents: 200, toolCalls: [] },
    ]);
    const runTool = async () => ({ ok: true });

    const result = await runAgentLoop(undefined, "Facts", "Fill", {
      modelCall: model.handler,
      runTool,
      env: { AGENT_MAX_COST_CENTS: "200" },
    });
    expect(result.finalText).toBe("Final answer.");
    expect(result.turns).toBe(1);
  });

  it("tags every tool summary with the tool name and id so they are distinguishable", async () => {
    // Regression for the earlier `buildUserTurn` that lost each tool call's
    // identity and emitted a run of identical "Tool completed." lines. Two
    // tools running on the same turn have to produce two distinguishable
    // summaries on the next user turn, or the next model call cannot tell
    // which tool did what.
    const model = scriptedModel([
      {
        text: "Inspecting.",
        toolCalls: [
          { id: "t1", name: "readSnapshot", input: "{}" },
          { id: "t2", name: "fillField", input: "{}" },
        ],
      },
      { text: "Done.", toolCalls: [] },
    ]);
    const runTool = async () => ({ ok: true });

    await runAgentLoop(undefined, "Facts", "Fill", {
      modelCall: model.handler,
      runTool,
      env: {},
    });

    // The second turn (Sonnet or Gemini, whichever the router picked) sees
    // the user turn text built from the first turn's outcomes. Capture the
    // messages the second call received and look for both tool tags.
    const second = model.seen[1]?.messages;
    const serialized = JSON.stringify(second);
    expect(serialized).toContain("readSnapshot (t1)");
    expect(serialized).toContain("fillField (t2)");
    // The two summaries must not both collapse to the same string, which is
    // the exact failure mode the earlier "Tool completed." lines produced.
    expect(serialized.match(/Tool [^ ]+ \(t1\) completed\./)?.length).toBe(1);
    expect(serialized.match(/Tool [^ ]+ \(t2\) completed\./)?.length).toBe(1);
  });

  it("aborts on the boundary above the cap on a non terminal turn", async () => {
    // The strict `>` boundary check must let `spent === cap` pass through
    // for a non terminal turn (the loop keeps going until the next
    // iteration) but reject the moment the spent value crosses the cap.
    const model = scriptedModel([
      { costCents: 6, toolCalls: [{ id: "t1", name: "inspect", input: "{}" }] },
    ]);
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
      expect(error.costCents).toBe(6);
    }
  });

  it("does not run any tool handler when a non terminal turn already crossed the cost cap", async () => {
    // Regression for the earlier order that ran the tool loop first and only
    // then checked the cost cap. Once sub tickets B and D land real
    // Stagehand handlers, a run that has already blown its budget must not
    // trigger any further browser side effects (form fills, form submits)
    // before aborting. The invariant that `submitted` is terminal and can
    // never be undone means an over budget submit tool call would be
    // unrecoverable, so the loop has to fail closed at the budget boundary
    // before dispatching the model's tool calls.
    let toolInvocations = 0;
    const runTool = async () => {
      toolInvocations += 1;
      return { ok: true };
    };
    const model = scriptedModel([
      {
        text: "Still working.",
        costCents: 10,
        toolCalls: [
          { id: "t1", name: "readSnapshot", input: "{}" },
          { id: "t2", name: "fillField", input: "{}" },
        ],
      },
    ]);

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
    // The load bearing assertion: not a single tool call fired even though
    // the model returned two of them on the over budget turn.
    expect(toolInvocations).toBe(0);
  });
});
