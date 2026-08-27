// @vitest-environment node
/**
 * JOB-175. `lib/fireworks-client-llm.ts` is the Stagehand `ClientLLM` adapter
 * that lets `openBrowserSession` drive Fireworks-hosted DeepSeek V4 Flash
 * instead of the default OpenAI path — see that file's header for why a
 * three line model string swap does not work against the pinned Stagehand
 * version.
 *
 * Every case below mocks `ai`'s `generateText`/`generateObject` and
 * `@ai-sdk/openai-compatible`'s `createOpenAICompatible`. No real HTTP
 * request ever leaves this process; the suite is about the adapter's own
 * mapping and fail closed behaviour, not about Fireworks' API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn();
const generateObjectMock = vi.fn();
const createOpenAICompatibleMock = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (...args: unknown[]) => createOpenAICompatibleMock(...args),
}));

import { createFireworksClientLLM, FIREWORKS_BASE_URL, FIREWORKS_DEEPSEEK_MODEL } from "@/lib/fireworks-client-llm";

const FAKE_MODEL = { modelId: FIREWORKS_DEEPSEEK_MODEL };

function textRequest(overrides: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user" as const, content: { type: "text" as const, text: "click submit" } }],
    responseFormat: { type: "text" as const },
    ...overrides,
  };
}

function jsonRequest(schema: Record<string, unknown> = { type: "object", properties: {} }) {
  return {
    messages: [{ role: "user" as const, content: { type: "text" as const, text: "extract the email field" } }],
    responseFormat: { type: "json_schema" as const, name: "extraction", schema },
  };
}

describe("createFireworksClientLLM", () => {
  let modelFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    modelFn = vi.fn().mockReturnValue(FAKE_MODEL);
    createOpenAICompatibleMock.mockReturnValue(modelFn);
    generateTextMock.mockReset();
    generateObjectMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("points the provider at Fireworks' inference endpoint with the pinned model", async () => {
    generateTextMock.mockResolvedValue({
      text: "clicked",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, inputTokenDetails: {}, outputTokenDetails: {} },
    });

    const client = createFireworksClientLLM("test-key");
    await client.generate(textRequest());

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "fireworks", baseURL: FIREWORKS_BASE_URL, apiKey: "test-key" })
    );
    expect(modelFn).toHaveBeenCalledWith(FIREWORKS_DEEPSEEK_MODEL);
  });

  it("passes an explicit modelSlug through to Fireworks instead of the default (JOB-175 review fix)", async () => {
    // The whole point of the STAGEHAND_MODEL env var override is that a
    // different Fireworks slug reaches the request path. This test would
    // have failed on the first cut of this PR, before createFireworksClientLLM
    // took a modelSlug parameter at all.
    generateTextMock.mockResolvedValue({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokenDetails: {}, outputTokenDetails: {} },
    });

    const OVERRIDE = "accounts/fireworks/models/deepseek-v4-flash-0813";
    const client = createFireworksClientLLM("test-key", OVERRIDE);
    await client.generate(textRequest());

    expect(modelFn).toHaveBeenCalledWith(OVERRIDE);
    expect(modelFn).not.toHaveBeenCalledWith(FIREWORKS_DEEPSEEK_MODEL);
  });

  it("happy path: maps a plain text completion back into Stagehand's response shape", async () => {
    generateTextMock.mockResolvedValue({
      text: "Clicked the submit button.",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 120,
        outputTokens: 8,
        totalTokens: 128,
        inputTokenDetails: { cacheReadTokens: 40 },
        outputTokenDetails: { reasoningTokens: 3 },
      },
    });

    const client = createFireworksClientLLM("test-key");
    const response = await client.generate(textRequest());

    expect(response).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Clicked the submit button." }],
      stopReason: "stop",
      usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128, reasoningTokens: 3, cachedInputTokens: 40 },
      outputFormat: "text",
    });
  });

  it("happy path: maps a tool call and a json_schema structured response", async () => {
    generateTextMock.mockResolvedValue({
      text: "",
      toolCalls: [{ toolCallId: "call_1", toolName: "click", input: { selector: "#submit" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, inputTokenDetails: {}, outputTokenDetails: {} },
    });
    const client = createFireworksClientLLM("test-key");
    const toolResponse = await client.generate({
      ...textRequest(),
      tools: [{ name: "click", description: "Click a selector", inputSchema: { type: "object", properties: {} } }],
      toolChoice: { mode: "required" },
    } as Parameters<typeof client.generate>[0]);
    expect(toolResponse).toMatchObject({
      outputFormat: "text",
      content: [{ type: "tool_use", id: "call_1", name: "click", input: { selector: "#submit" } }],
    });

    generateObjectMock.mockResolvedValue({
      object: { email: "person@example.com" },
      usage: { inputTokens: 30, outputTokens: 4, totalTokens: 34, inputTokenDetails: {}, outputTokenDetails: {} },
    });
    const structured = await client.generate(
      jsonRequest({ type: "object", properties: { email: { type: "string" } }, required: ["email"] }) as Parameters<
        typeof client.generate
      >[0]
    );
    expect(structured).toEqual({
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify({ email: "person@example.com" }) }],
      usage: { inputTokens: 30, outputTokens: 4, totalTokens: 34 },
      outputFormat: "json_schema",
      structuredContent: { email: "person@example.com" },
    });
  });

  it("fails closed when the model does not return an object matching the requested schema", async () => {
    generateObjectMock.mockRejectedValue(new Error("response did not match schema: missing required property 'email'"));
    const client = createFireworksClientLLM("test-key");

    await expect(
      client.generate(jsonRequest() as Parameters<typeof client.generate>[0])
    ).rejects.toThrow(/did not return an object matching the requested schema "extraction"/);
  });

  it("fails closed on an HTTP 5xx from Fireworks", async () => {
    generateTextMock.mockRejectedValue(new Error("Fireworks API error: 503 Service Unavailable"));
    const client = createFireworksClientLLM("test-key");

    await expect(client.generate(textRequest())).rejects.toThrow(
      /Fireworks adapter:.*request failed.*503/
    );
  });

  it("still calls through with an empty key and lets the resulting auth failure surface, rather than silently succeeding", async () => {
    generateTextMock.mockRejectedValue(new Error("Fireworks API error: 401 Unauthorized"));
    const client = createFireworksClientLLM("");

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "" }));
    await expect(client.generate(textRequest())).rejects.toThrow(/401 Unauthorized/);
  });

  it("refuses to guess a tool name for a tool_result with no matching preceding tool_use", async () => {
    const client = createFireworksClientLLM("test-key");
    const request = {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "tool_result" as const,
            toolUseId: "call_never_seen",
            content: [{ type: "text" as const, text: "ok" }],
          },
        },
      ],
      responseFormat: { type: "text" as const },
    };

    await expect(client.generate(request as Parameters<typeof client.generate>[0])).rejects.toThrow(
      /unknown toolUseId "call_never_seen"/
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
