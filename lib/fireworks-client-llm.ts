/**
 * JOB-175 Path B: a Stagehand `ClientLLM` adapter for Fireworks-hosted
 * DeepSeek V4 Flash ($0.22 in / $0.66 out per M tokens, per issue #175's
 * pricing note).
 *
 * Why this file exists instead of a three line model string swap: Stagehand
 * v4.0.1's `Stagehand.create({ model })` validates its `model` option with
 * `ModelConfigSchema`, a strict mode zod object whose `modelName` is a closed
 * template literal union over `openai/* | anthropic/* | google/* | groq/* |
 * cerebras/*` — Fireworks is not in it, and there is no `baseURL` field to
 * point the OpenAI provider at a different host either. Both failures are
 * enforced at `Stagehand.create()`, not just at the type level, because that
 * call runs `StagehandCreateOptionsSchema.parse()` on its input. See the
 * STOP-and-report on issue #175 for the empirical check against the shipped
 * `.d.mts`.
 *
 * `model` is a union of two shapes though: `ModelConfigSchema | ClientLLMSchema`.
 * `ClientLLM` is "an LLM callback implemented locally by the SDK consumer. It
 * never crosses the wire" (Stagehand's own doc comment on `ClientLLMSchema`) —
 * Stagehand hands it a request describing messages/tools/output format and
 * awaits a response in its own shape, once per `act`/`extract`/`observe` call.
 * This file is that callback, built on the Vercel `ai` SDK's
 * `@ai-sdk/openai-compatible` provider, which speaks the same OpenAI style
 * chat completions wire format Fireworks' inference endpoint does.
 *
 * Verified against `node_modules/@browserbasehq/stagehand/dist/index.mjs`:
 * the RPC layer that owns this callback (`onRequest`) calls
 * `handler(params)` with exactly one argument — no `AbortSignal` reaches this
 * function at runtime, whatever the zod tuple type technically allows for.
 *
 * Known simplification: `tool_result` content only carries `toolUseId`, not
 * the tool's name, but the AI SDK's `tool` role message requires `toolName`.
 * `mapMessages` below recovers it by remembering every `tool_use` block's
 * `id -> name` as it walks a request's messages in order, and refuses to
 * guess if a `tool_result` shows up with no matching `tool_use` — that would
 * mean the caller's own turn history is broken, not something this adapter
 * should paper over.
 *
 * Live-verified gap, found during the 2026-08-26 conformance check (see
 * {@link FIREWORKS_DEEPSEEK_MODEL}'s comment): `GET /inference/v1/models`
 * reports `supports_image_input: false` for this model. `mapMessages` below
 * still forwards `ImageBlock`s as ordinary user image content with no
 * validation, so a request that ever carries one (Stagehand's default
 * `act`/`observe`/`extract` path is DOM/accessibility-tree based and did not
 * exercise this in the live smoke test run here, but nothing in this file
 * rules it out for a future caller) would be silently accepted by
 * `mapMessages` and only fail, if it fails at all, deep inside the Fireworks
 * request. Not fixed here — this file's live-validation pass is scoped to
 * confirming the model slug and running one live text/JSON round trip, not to
 * building out the image path. Worth a follow-up ticket or an explicit
 * `mapMessages` throw on `ImageBlock` if this model stays the pin.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, generateText, jsonSchema, tool } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import type { ClientLLM } from "@browserbasehq/stagehand";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

/**
 * Verified live against `GET /inference/v1/models` on 2026-08-26, after
 * Pranav resolved the `pranavlende` Fireworks account's billing hold (this
 * adapter was originally built against a suspended account returning
 * `PRECONDITION_FAILED` for every request, including the models list — see
 * the PR history for that unverified state).
 *
 * The bare slug this constant used to hold,
 * `accounts/fireworks/models/deepseek-v4-flash`, does not exist on the live
 * account. Fireworks serves the Flash-class DeepSeek V4 build under a dated
 * snapshot id instead: `accounts/fireworks/models/deepseek-v4-flash-0731`.
 * The full live listing (24 models) also has `deepseek-v4-pro` and
 * `deepseek-v4-pro-0813`, but no undated `deepseek-v4-flash` — the dated
 * suffix is not optional. Confirmed the corrected slug's own model metadata
 * (`supports_chat: true`, `supports_tools: true`, `context_length: 1048576`)
 * matches what this adapter needs for tool-calling; note `supports_image_input:
 * false` (see the module header for what that means for `mapMessages`'s
 * image handling).
 */
export const FIREWORKS_DEEPSEEK_MODEL =
  "accounts/fireworks/models/deepseek-v4-flash-0731" as const;

type GenerateRequest = Parameters<ClientLLM["generate"]>[0];
type GenerateResponse = Awaited<ReturnType<ClientLLM["generate"]>>;

interface TextBlock {
  type: "text";
  text: string;
}
interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: Array<TextBlock | ImageBlock>;
  structuredContent?: Record<string, unknown>;
}
type InboundBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

interface FireworksToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  reasoningTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
});
const outboundBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }),
]);
const textResponseSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(outboundBlockSchema).min(1),
  stopReason: z.string().optional(),
  usage: usageSchema.optional(),
  outputFormat: z.literal("text"),
});
const jsonResponseSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(outboundBlockSchema).min(1),
  stopReason: z.string().optional(),
  usage: usageSchema.optional(),
  outputFormat: z.literal("json_schema"),
  structuredContent: z.record(z.string(), z.unknown()),
});

function asBlocks(content: InboundBlock | InboundBlock[]): InboundBlock[] {
  return Array.isArray(content) ? content : [content];
}

/**
 * Stagehand's own request messages carry only `role: "user" | "assistant"`;
 * a tool result is just another content block inside one of those. The AI
 * SDK's chat bridge instead wants tool results on their own `role: "tool"`
 * message, so this regroups blocks into runs of the same AI SDK message kind
 * as it walks each message's content in order, flushing a new output message
 * whenever the kind changes.
 */
function mapMessages(messages: GenerateRequest["messages"]): ModelMessage[] {
  const toolNameById = new Map<string, string>();
  const out: ModelMessage[] = [];
  let user: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> = [];
  let assistant: Array<
    { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];
  let toolMsgs: Array<{
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: { type: "text"; value: string };
  }> = [];

  const flush = () => {
    if (user.length > 0) {
      out.push({ role: "user", content: user });
      user = [];
    }
    if (assistant.length > 0) {
      out.push({ role: "assistant", content: assistant });
      assistant = [];
    }
    if (toolMsgs.length > 0) {
      out.push({ role: "tool", content: toolMsgs });
      toolMsgs = [];
    }
  };

  for (const message of messages) {
    for (const block of asBlocks(message.content as InboundBlock | InboundBlock[])) {
      if (block.type === "tool_use") {
        toolNameById.set(block.id, block.name);
        if (user.length > 0 || toolMsgs.length > 0) flush();
        assistant.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.input });
      } else if (block.type === "tool_result") {
        const toolName = toolNameById.get(block.toolUseId);
        if (!toolName) {
          throw new Error(
            `Fireworks adapter: tool_result for unknown toolUseId "${block.toolUseId}" — no ` +
              `preceding tool_use block in this request named it. Refusing to guess a tool name.`
          );
        }
        if (user.length > 0 || assistant.length > 0) flush();
        const text = block.structuredContent
          ? JSON.stringify(block.structuredContent)
          : block.content
              .filter((c): c is TextBlock => c.type === "text")
              .map((c) => c.text)
              .join("\n");
        toolMsgs.push({
          type: "tool-result",
          toolCallId: block.toolUseId,
          toolName,
          output: { type: "text", value: text },
        });
      } else if (block.type === "text") {
        if (message.role === "assistant") {
          if (user.length > 0 || toolMsgs.length > 0) flush();
          assistant.push({ type: "text", text: block.text });
        } else {
          if (assistant.length > 0 || toolMsgs.length > 0) flush();
          user.push({ type: "text", text: block.text });
        }
      } else {
        if (assistant.length > 0 || toolMsgs.length > 0) flush();
        user.push({ type: "image", image: block.data, mediaType: block.mimeType });
      }
    }
  }
  flush();
  return out;
}

function buildToolSet(tools: FireworksToolDef[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const toolSet: ToolSet = {};
  for (const t of tools) {
    toolSet[t.name] = tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema) });
  }
  return toolSet;
}

function mapUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}) {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
  const cachedInputTokens = usage.inputTokenDetails?.cacheReadTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

/**
 * Builds the `ClientLLM` Stagehand plugs into `Stagehand.create({ model })`.
 * `apiKey` is read by the caller (see `lib/stagehand-session.ts`,
 * `FIREWORKS_API_KEY` falling back to `STAGEHAND_LLM_API_KEY`) so this file
 * stays free of `process.env` and is trivial to unit test.
 */
export function createFireworksClientLLM(apiKey: string): ClientLLM {
  const provider = createOpenAICompatible({ name: "fireworks", baseURL: FIREWORKS_BASE_URL, apiKey });
  const model = provider(FIREWORKS_DEEPSEEK_MODEL);

  return {
    generate: async (request: GenerateRequest): Promise<GenerateResponse> => {
      const messages = mapMessages(request.messages);
      const isStructured = request.responseFormat?.type === "json_schema";

      if (isStructured) {
        const format = request.responseFormat as { name: string; schema: Record<string, unknown> };
        let object: unknown;
        let usage;
        try {
          const result = await generateObject({
            model,
            system: request.systemPrompt,
            messages,
            temperature: request.temperature,
            schema: jsonSchema(format.schema),
          });
          object = result.object;
          usage = result.usage;
        } catch (err) {
          throw new Error(
            `Fireworks adapter: ${FIREWORKS_DEEPSEEK_MODEL} did not return an object matching ` +
              `the requested schema "${format.name}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
        const response = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: JSON.stringify(object) }],
          usage: mapUsage(usage),
          outputFormat: "json_schema" as const,
          structuredContent: object as Record<string, unknown>,
        };
        jsonResponseSchema.parse(response);
        return response as GenerateResponse;
      }

      // The union's other branch optionally carries `tools`/`toolChoice`.
      // Stagehand's own schema already validated `request` before this
      // handler ran, so trusting this shape does not skip any validation —
      // it only works around TypeScript not narrowing a two branch union on
      // an optional `responseFormat.type` check.
      const toolRequest = request as GenerateRequest & {
        tools?: FireworksToolDef[];
        toolChoice?: { mode?: "auto" | "required" | "none" };
      };
      let text: string;
      let toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
      let finishReason: string;
      let usage;
      try {
        const result = await generateText({
          model,
          system: request.systemPrompt,
          messages,
          temperature: request.temperature,
          stopSequences: request.stopSequences,
          tools: buildToolSet(toolRequest.tools),
          toolChoice: toolRequest.toolChoice?.mode,
        });
        text = result.text;
        toolCalls = result.toolCalls;
        finishReason = result.finishReason;
        usage = result.usage;
      } catch (err) {
        throw new Error(
          `Fireworks adapter: ${FIREWORKS_DEEPSEEK_MODEL} request failed: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }

      const content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];
      if (text.length > 0) content.push({ type: "text", text });
      for (const call of toolCalls) {
        content.push({
          type: "tool_use",
          id: call.toolCallId,
          name: call.toolName,
          input: (call.input ?? {}) as Record<string, unknown>,
        });
      }
      if (content.length === 0) content.push({ type: "text", text: "" });

      const response = {
        role: "assistant" as const,
        content,
        stopReason: finishReason,
        usage: mapUsage(usage),
        outputFormat: "text" as const,
      };
      textResponseSchema.parse(response);
      return response as GenerateResponse;
    },
  };
}
