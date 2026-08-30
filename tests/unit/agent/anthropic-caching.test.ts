/**
 * JOB-282 (sub ticket E of #276). Cases for the Anthropic prompt caching
 * helper and the non Anthropic (Gemini) message path.
 *
 * The helper is a pure data transform: it emits the Anthropic message shape
 * with the system prompt and fact catalog blocks marked
 * `cache_control: { type: "ephemeral" }`, and it leaves per turn user
 * messages uncached. The tests assert the emitted shape directly, and then
 * assert through `runAgentLoop` that the caching path is only taken when the
 * picked model is Anthropic.
 */

import { describe, expect, it } from "vitest";

import {
  buildAnthropicMessagesWithCaching,
  runAgentLoop,
  type AgentMessages,
  type AgentModelResponse,
  type ModelConfig,
} from "@/lib/agent/router";

const GEMINI = "google/gemini-3-1-pro-preview";
const SONNET = "anthropic/claude-sonnet-4-6";

describe("buildAnthropicMessagesWithCaching", () => {
  it("marks the system prompt and fact catalog blocks as ephemeral cache", () => {
    const built = buildAnthropicMessagesWithCaching(
      "System instructions",
      "Facts about the candidate",
      ["Turn one", "Turn two"]
    );

    expect(built.kind).toBe("anthropic");
    expect(built.system).toHaveLength(2);
    expect(built.system[0]?.text).toBe("System instructions");
    expect(built.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(built.system[1]?.text).toBe("Facts about the candidate");
    expect(built.system[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("keeps per turn user messages out of the cached prefix", () => {
    const built = buildAnthropicMessagesWithCaching("S", "F", ["Turn one"]);

    expect(built.messages).toHaveLength(1);
    expect(built.messages[0]).toEqual({ role: "user", content: "Turn one" });
    // The user turn must not carry a cache marker: caching it would evict
    // the stable prefix on every change.
    expect(built.messages[0]?.content).toBe("Turn one");
    expect(
      built.messages.some(
        (message) =>
          message.role === "user" && "cache_control" in message
      )
    ).toBe(false);
  });
});

describe("runAgentLoop message routing", () => {
  function captureModel(): {
    handler: (config: ModelConfig, messages: AgentMessages) => Promise<AgentModelResponse>;
    seen: Array<{ model: string; messages: AgentMessages }>;
  } {
    const seen: Array<{ model: string; messages: AgentMessages }> = [];
    return {
      seen,
      handler: async (config, messages) => {
        seen.push({ model: config.model, messages });
        return { toolCalls: [], costCents: 0 };
      },
    };
  }

  it("does not emit Anthropic cache markers when the picked model is Gemini", async () => {
    const model = captureModel();
    const runTool = async () => ({ ok: true });

    await runAgentLoop(undefined, "Facts", "Fill", {
      modelCall: model.handler,
      runTool,
      env: {},
    });

    expect(model.seen[0]?.model).toBe(GEMINI);
    const received = model.seen[0]?.messages;
    expect(received?.kind).toBe("legacy");
    // The Gemini path must never route through the Anthropic caching helper,
    // so no cache_control marker may appear anywhere in the payload.
    expect(JSON.stringify(received)).not.toContain("cache_control");
    expect(JSON.stringify(received)).not.toContain("ephemeral");
  });

  it("emits the Anthropic cached shape once the loop escalates to Sonnet", async () => {
    // Iteration one runs on Gemini and requests a tool that fails with the
    // complex widget signal. Iteration two therefore escalates to Sonnet,
    // and its messages must carry the Anthropic cached prefix.
    const model = captureModel();
    model.handler = async (config, messages) => {
      model.seen.push({ model: config.model, messages });
      // First call (Gemini) asks for a tool; later calls finish.
      return model.seen.length === 1
        ? { toolCalls: [{ id: "t1", name: "inspect", input: "{}" }], costCents: 0 }
        : { toolCalls: [], costCents: 0 };
    };
    const runTool = async () => ({ ok: false, signal: "complex-widget" as const });

    await runAgentLoop(undefined, "Facts", "Fill", {
      modelCall: model.handler,
      runTool,
      env: {},
    });

    expect(model.seen[0]?.model).toBe(GEMINI);
    expect(model.seen[1]?.model).toBe(SONNET);
    const escalated = model.seen[1]?.messages;
    expect(escalated?.kind).toBe("anthropic");
    if (escalated?.kind === "anthropic") {
      expect(escalated.system.length).toBeGreaterThan(0);
      expect(
        escalated.system.some(
          (block) => block.cache_control?.type === "ephemeral"
        )
      ).toBe(true);
    }
  });
});
