/**
 * JOB-277 (sub ticket A of #276): scaffold for the Stagehand hybrid agent fill.
 * JOB-316: `runAgentFill` implemented for real.
 *
 * This module is the entry point the pipeline reaches when a run has been
 * routed onto the agent path instead of the legacy widget fill. The flag
 * `USE_AGENT_FILL` defaults to false, and `USE_AGENT_FILL_ATS` is an empty
 * allowlist by default, so the routing helper answers `false` for every ats
 * until an operator turns both on. See `.env.example` for the full shape of
 * the flags and their defaults.
 *
 * ── The run, end to end (JOB-316) ───────────────────────────────────────────
 *
 *  1. Preflight: read the `applications` row and its `jobs` row. A row at
 *     `submitted` or `submission_unconfirmed` is refused outright, because
 *     both mean a submit control was already clicked once.
 *  2. Build the fact catalog for the row's user and the system prompt for
 *     the row's ats.
 *  3. Open a browser session through `lib/stagehand-session.ts` (Browserbase
 *     when the env is configured for it, local Chromium otherwise) and
 *     navigate to the listing's apply URL.
 *  4. Run `runAgentLoop` with the session threaded through as the session
 *     argument, the serialized catalog as the cached fact block, and the
 *     system prompt as the task. The default model adapter speaks the
 *     Anthropic Messages API for Anthropic rungs (which is what makes the
 *     `cache_control` markers in `buildAnthropicMessagesWithCaching` real)
 *     and an OpenAI compatible gateway for everything else.
 *  5. Verify with `preSubmitVerify`. A captcha terminates the run as
 *     `form_fill_blocked` with the `captcha` skip reason. A verify failure
 *     gets exactly one escalated retry pass with the errors fed back, then
 *     terminates as `form_fill_blocked` if still failing.
 *  6. Submit: one click, preceded by an observe that proves a submit control
 *     exists, followed by the same settled read and judgement the legacy
 *     path uses (`readSettledConfirmation` + `judgeSubmission`). The verdict
 *     writes `submitted` or `submission_unconfirmed`, and nothing after the
 *     click can throw past this function.
 *
 * Budget breaches from the loop terminate as `form_fill_blocked` with the
 * budget named in the skip row. A live browser dying mid loop writes an
 * `error` status plus a `skip_log` row and then throws
 * `AgentSessionLostError`, so the pipeline's retry machinery sees a typed,
 * retryable failure rather than a silent half result.
 *
 * Heavy modules (Stagehand, Supabase, the records writers, the tool
 * handlers) are imported dynamically inside the default dependency
 * implementations, in the same style `dispatchApplicationFill` uses for the
 * legacy path, so tests that only touch routing or wiring never pull the
 * browser stack into their module graph. `lib/agent/tools.ts` in particular
 * imports this module for `AgentFillNotImplementedError`, so a static import
 * of it from here would be a cycle.
 */

import { z } from "zod";

import { APPLICATION_STATUS } from "@/lib/application-status";
import {
  AgentBudgetExceededError,
  runAgentLoop,
  type AgentModelResponse,
  type AgentToolCall,
  type AgentToolOutcome,
  type ModelConfig,
  type AgentMessages,
  type RunAgentLoopOptions,
} from "@/lib/agent/router";
import {
  buildFactCatalog,
  resolveFactPath,
  serializeFactCatalog,
  type FactCatalog,
} from "@/lib/agent/fact-catalog";
import { buildSystemPrompt } from "@/lib/agent/system-prompt";
import {
  preSubmitVerify,
  type PreSubmitVerifyPage,
  type VerifyResult,
} from "@/lib/agent/verify";

import type {
  SubmitApplicationInput,
  SubmitApplicationResult,
  ConfirmationCapture,
} from "@/lib/submit-application";
import type { BrowserSession } from "@/lib/stagehand-session";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ToolContext,
  SetFieldValueInput,
  SelectDropdownInput,
  ToggleCheckboxInput,
  AddRepeatingSectionEntryInput,
  UploadFileInput,
  MarkFieldUnanswerableInput,
  RequestVerifyBeforeSubmitInput,
} from "@/lib/agent/tools";

/**
 * JOB-279 (sub ticket B): the snapshot type shapes and pure builders that
 * the agent loop threads through every turn. Exported again from the package
 * entry point so downstream tickets can `import { ... } from "@/lib/agent"`
 * without having to know which sibling file each name originally lives in.
 */
export type {
  AgentSnapshot,
  AgentSnapshotDiff,
  FieldKind,
  FieldNode,
  FieldValidationState,
  SectionHandle,
} from "@/lib/agent/snapshot-types";
export {
  buildDiffSnapshot,
  buildFullSnapshot,
  SNAPSHOT_MAX_BYTES,
  SnapshotBudgetExceededError,
} from "@/lib/agent/readback";
export type {
  AgentSnapshotSource,
  RawAccessibilityNode,
  SnapshotOptions,
} from "@/lib/agent/readback";

/**
 * JOB-280 (sub ticket C): the deterministic prefill pass. Exported a second
 * time so downstream tickets can `import { deterministicPrefill } from
 * "@/lib/agent"` without knowing the module layout. See
 * `lib/agent/prefill.ts` for the cost model and the HARD STOP 9 exclusion
 * guard the walker enforces.
 */
export {
  classifyPrefillSlot,
  deterministicPrefill,
  isExcludedLabel,
} from "@/lib/agent/prefill";
export type {
  FilledField,
  PrefillError,
  PrefillOptions,
  PrefillPage,
  PrefillReport,
  PrefillSkipReason,
  PrefillSlot,
  SkippedField,
} from "@/lib/agent/prefill";

/**
 * Return type of `runAgentFill`. Kept as an alias of `SubmitApplicationResult`
 * so the pipeline can treat the agent path and the legacy path
 * interchangeably. The alias exists as its own name so later tickets can
 * widen or narrow the shape without churning every call site.
 */
export type AgentFillResult = SubmitApplicationResult;

/**
 * Thrown by the remaining stubs in `lib/agent/`. A distinct class so callers
 * can tell "the agent path was reached before it was ready" apart from a real
 * runtime error inside the implementation. `runAgentFill` itself no longer
 * throws this (JOB-316); the tool handlers in `tools.ts` still do until
 * their own ticket lands, and this entry point surfaces those as an `error`
 * status plus a skip row before rethrowing.
 */
export class AgentFillNotImplementedError extends Error {
  constructor(surface: string) {
    super(
      `${surface} is not implemented yet. This is a JOB-277 scaffold; the ` +
        `agent fill lands across sub tickets B through H of epic #276.`
    );
    this.name = "AgentFillNotImplementedError";
  }
}

/**
 * JOB-316: the typed failure for a live browser dying mid loop. Its own
 * class, as the ticket requires, so the pipeline and the tests can tell "the
 * session under the run went away" apart from a model error, a tool error
 * and a budget breach without matching on message text. The row is moved to
 * `error` and a `skip_log` row is written before this is thrown, so the
 * stop is recorded even though the exception propagates.
 */
export class AgentSessionLostError extends Error {
  constructor(stage: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `The live browser session died during ${stage}: ${reason}. The run ` +
        `cannot continue without its page; the row was moved to "error" so ` +
        `a retry opens a fresh session.`
    );
    this.name = "AgentSessionLostError";
  }
}

/**
 * The message shapes Playwright and Stagehand produce when the browser or
 * its transport has gone away underneath a call. Substring based on purpose:
 * these strings come from two different layers (CDP and the Stagehand SDK)
 * and neither exposes a typed error for "your session is dead".
 */
const SESSION_LOST_RE =
  /target (?:closed|crashed)|browser has been closed|session (?:closed|expired|terminated|disconnected)|websocket|page crashed|net::ERR|protocol error|browser.*disconnected/i;

/** Whether an error reads as the live browser session dying. */
export function looksLikeSessionLoss(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return SESSION_LOST_RE.test(message);
}

/**
 * Reads the two feature flags and answers whether a run for `ats` should take
 * the agent path. Pure, so tests can pass a synthetic env and cover every
 * matrix cell without having to poke `process.env`.
 *
 * The allowlist splits on comma, trims whitespace, and drops empty entries, so
 * that `USE_AGENT_FILL_ATS=greenhouse, lever` and `USE_AGENT_FILL_ATS=,,`
 * both behave the way an operator expects rather than admitting an empty
 * string as a matching ats.
 */
export function shouldUseAgentFillForAts(
  ats: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (env.USE_AGENT_FILL !== "true") return false;
  const allowlist = (env.USE_AGENT_FILL_ATS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return allowlist.includes(ats);
}

// ───────────────────────────────────
// The injectable seams
// ───────────────────────────────────

/** What the submit leg reports back to `runAgentFill`. */
export interface SubmitLegOutcome {
  /** True from the instant before the click was issued. */
  clicked: boolean;
  /** True only when the click landed AND the page afterwards corroborated it. */
  submitted: boolean;
  confirmationRef: string | null;
  confirmation: ConfirmationCapture | null;
  submitControlLabel: string | null;
  finalUrl: string;
  pageTitle: string;
  /** The sentence a human reads about how the leg ended. */
  detail: string;
}

/**
 * Every wet dependency of `runAgentFill`, injectable in the same dependency
 * injection style `dispatchApplicationFill` established. Production passes
 * nothing and gets the real implementations; a test scripts any subset and
 * asserts the wiring without a browser, a database or a model in the room.
 */
export interface AgentFillDeps {
  getSupabase?: () => Promise<SupabaseClient>;
  loadFactCatalog?: (userId: string) => Promise<FactCatalog>;
  openSession?: (input: {
    applyUrl: string;
    headless: boolean;
    logTag: string;
  }) => Promise<BrowserSession>;
  closeSession?: (session: BrowserSession) => Promise<void>;
  loop?: typeof runAgentLoop;
  modelCall?: RunAgentLoopOptions["modelCall"];
  runTool?: RunAgentLoopOptions["runTool"];
  verify?: (session: BrowserSession) => Promise<VerifyResult>;
  submitLeg?: (session: BrowserSession) => Promise<SubmitLegOutcome>;
  env?: Record<string, string | undefined>;
}

const LOG = "[job-316]";

/**
 * The one submit instruction, a compile time constant with no page text in
 * it, for the same reason `submit-application.ts` insists on one: an
 * instruction assembled from page content would hand a hostile page the
 * steering wheel on the irreversible click.
 */
const AGENT_SUBMIT_INSTRUCTION =
  "press the control that submits this job application (the final submit or " +
  "apply button), not a save button, not a draft button and not a navigation " +
  "link";

/**
 * Selector sweep for the captcha families every target board actually
 * deploys. Evaluated as a string, matching how the ported modules drive
 * `page.evaluate`, so no function serialization is involved.
 */
const CAPTCHA_PRESENT_SCRIPT =
  `(() => {` +
  ` const selector = 'iframe[src*="hcaptcha"],iframe[src*="recaptcha"],` +
  `iframe[src*="turnstile"],.g-recaptcha,.h-captcha,.cf-turnstile';` +
  ` return document.querySelector(selector) !== null;` +
  ` })()`;

/** Milliseconds one model call may take before the fetch is aborted. */
const AGENT_MODEL_CALL_TIMEOUT_MS = 120_000;

/** Output token ceiling per model call. */
const AGENT_MODEL_MAX_TOKENS = 4_096;

/**
 * Cents per million tokens, for the loop's cost cap accounting. The
 * Anthropic numbers are Sonnet 4.6 list prices; the gateway numbers are a
 * conservative estimate for the Gemini primary, pending real usage
 * accounting from the gateway. Every call is charged at least one cent so a
 * provider that omits usage cannot make the cost cap a no op.
 */
const ANTHROPIC_INPUT_CENTS_PER_MTOK = 300;
const ANTHROPIC_OUTPUT_CENTS_PER_MTOK = 1_500;
const ANTHROPIC_CACHE_READ_CENTS_PER_MTOK = 30;
const GATEWAY_INPUT_CENTS_PER_MTOK = 125;
const GATEWAY_OUTPUT_CENTS_PER_MTOK = 1_000;

/** A positive integer out of an env var, or the fallback. */
function positiveIntFrom(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * The guarded service role client. Duplicated in shape from the ported
 * modules' own private builders rather than imported from one of them,
 * because none of them exports it and importing the whole module for a
 * client builder would drag its world in with it.
 */
async function defaultSupabaseClient(): Promise<SupabaseClient> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required " +
        "(see .env.example)"
    );
  }
  const { assertSupabaseProject } = await import("@/lib/supabase-project-guard");
  assertSupabaseProject(url);
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Opens the real session and lands it on the apply URL. */
async function defaultOpenSession(input: {
  applyUrl: string;
  headless: boolean;
  logTag: string;
}): Promise<BrowserSession> {
  const ss = await import("@/lib/stagehand-session");
  const session = await ss.openBrowserSession({
    headless: input.headless,
    logTag: input.logTag,
  });
  try {
    await session.page.goto(input.applyUrl, {
      timeout: ss.NAVIGATION_TIMEOUT_MS,
    });
  } catch (err) {
    await ss.closeBrowserSession(session);
    throw err;
  }
  return session;
}

async function defaultCloseSession(session: BrowserSession): Promise<void> {
  const ss = await import("@/lib/stagehand-session");
  await ss.closeBrowserSession(session);
}

// ───────────────────────────────────
// The default model adapter
// ───────────────────────────────────

/**
 * The seven tool definitions, in the wire shapes both providers accept. The
 * schemas are the same zod objects `tools.ts` validates its inputs with, so
 * the schema the model is shown and the schema the handler enforces cannot
 * drift apart.
 */
async function agentToolDefinitions(): Promise<
  Array<{ name: string; description: string; inputSchema: unknown }>
> {
  const tools = await import("@/lib/agent/tools");
  const defs = [
    {
      name: "setFieldValue",
      description:
        "Type a value into one form field. Quote intake facts by their " +
        "catalog path via intakeFactPath.",
      schema: tools.SetFieldValueInputSchema,
    },
    {
      name: "selectDropdown",
      description:
        "Choose one option in a dropdown or listbox by its value or visible " +
        "text.",
      schema: tools.SelectDropdownInputSchema,
    },
    {
      name: "toggleCheckbox",
      description: "Set one checkbox to checked or unchecked.",
      schema: tools.ToggleCheckboxInputSchema,
    },
    {
      name: "addRepeatingSectionEntry",
      description:
        "Add one entry to a repeating section such as work history or " +
        "education.",
      schema: tools.AddRepeatingSectionEntryInputSchema,
    },
    {
      name: "uploadFile",
      description:
        "Attach the stored document at storagePath to one upload field.",
      schema: tools.UploadFileInputSchema,
    },
    {
      name: "markFieldUnanswerable",
      description:
        "Declare that one field cannot be answered from the fact catalog. " +
        "The HARD STOP 9 exit; use it instead of ever composing a value.",
      schema: tools.MarkFieldUnanswerableInputSchema,
    },
    {
      name: "requestVerifyBeforeSubmit",
      description:
        "Signal that every answerable field is filled and the form is ready " +
        "for verification. Call once, then stop calling tools.",
      schema: tools.RequestVerifyBeforeSubmitInputSchema,
    },
  ];
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: z.toJSONSchema(def.schema),
  }));
}

const AnthropicResponseSchema = z.looseObject({
  content: z.array(
    z.union([
      z.looseObject({ type: z.literal("text"), text: z.string() }),
      z.looseObject({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.unknown(),
      }),
      // Any other block kind (thinking, server tool results) is tolerated
      // and ignored rather than failing the parse.
      z.looseObject({ type: z.string() }),
    ])
  ),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
});

const OpenAiCompatibleResponseSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.looseObject({
                id: z.string(),
                function: z.looseObject({
                  name: z.string(),
                  arguments: z.string(),
                }),
              })
            )
            .optional(),
        }),
      })
    )
    .min(1),
  usage: z
    .looseObject({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

/** Strip a routing prefix (`anthropic/`, `openrouter/anthropic/`) off a model id. */
function bareModelId(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
}

/**
 * The default `modelCall` for `runAgentLoop`.
 *
 * Anthropic rungs go to the Anthropic Messages API directly, because that is
 * the one wire format where the `cache_control: { type: "ephemeral" }`
 * markers `buildAnthropicMessagesWithCaching` writes actually buy the cached
 * price. Everything else (the Gemini primary) goes to an OpenAI compatible
 * gateway named by `AGENT_GATEWAY_BASE_URL` and `AGENT_GATEWAY_API_KEY`.
 * Both responses are validated with zod before anything trusts them, per
 * the house rule.
 */
function defaultModelCall(
  env: Record<string, string | undefined>
): RunAgentLoopOptions["modelCall"] {
  return async (
    config: ModelConfig,
    messages: AgentMessages
  ): Promise<AgentModelResponse> => {
    const tools = await agentToolDefinitions();
    if (messages.kind === "anthropic") {
      return callAnthropic(config, messages, tools, env);
    }
    return callGateway(config, messages, tools, env);
  };
}

async function callAnthropic(
  config: ModelConfig,
  messages: Extract<AgentMessages, { kind: "anthropic" }>,
  tools: Array<{ name: string; description: string; inputSchema: unknown }>,
  env: Record<string, string | undefined>
): Promise<AgentModelResponse> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY env var is required for the agent loop's " +
        "escalation rung (see .env.example)."
    );
  }
  const baseUrl = (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(
    /\/+$/,
    ""
  );
  const body = {
    model: bareModelId(config.model),
    max_tokens: AGENT_MODEL_MAX_TOKENS,
    system: messages.system,
    messages:
      messages.messages.length > 0
        ? messages.messages
        : [{ role: "user", content: "Begin filling the form." }],
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  };
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AGENT_MODEL_CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `Anthropic model call failed with HTTP ${response.status}: ${detail}`
    );
  }
  const parsed = AnthropicResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      `Anthropic model call returned a shape this loop does not trust: ` +
        `${parsed.error.message.slice(0, 500)}`
    );
  }
  const textParts: string[] = [];
  const toolCalls: AgentToolCall[] = [];
  for (const block of parsed.data.content) {
    if (block.type === "text" && "text" in block) {
      textParts.push(String(block.text));
    } else if (block.type === "tool_use" && "id" in block && "name" in block) {
      toolCalls.push({
        id: String(block.id),
        name: String(block.name),
        input: JSON.stringify(block.input ?? {}),
      });
    }
  }
  const usage = parsed.data.usage ?? {};
  const costCents = Math.max(
    1,
    Math.ceil(
      ((usage.input_tokens ?? 0) * ANTHROPIC_INPUT_CENTS_PER_MTOK +
        (usage.output_tokens ?? 0) * ANTHROPIC_OUTPUT_CENTS_PER_MTOK +
        (usage.cache_read_input_tokens ?? 0) *
          ANTHROPIC_CACHE_READ_CENTS_PER_MTOK) /
        1_000_000
    )
  );
  return {
    ...(textParts.length > 0 ? { text: textParts.join("\n") } : {}),
    toolCalls,
    costCents,
  };
}

async function callGateway(
  config: ModelConfig,
  messages: Extract<AgentMessages, { kind: "legacy" }>,
  tools: Array<{ name: string; description: string; inputSchema: unknown }>,
  env: Record<string, string | undefined>
): Promise<AgentModelResponse> {
  const baseUrl = env.AGENT_GATEWAY_BASE_URL;
  const apiKey = env.AGENT_GATEWAY_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "AGENT_GATEWAY_BASE_URL and AGENT_GATEWAY_API_KEY env vars are " +
        "required for the agent loop's primary rung (see .env.example). " +
        "They name an OpenAI compatible endpoint that serves " +
        `${config.model}.`
    );
  }
  const body = {
    model: config.model,
    max_tokens: AGENT_MODEL_MAX_TOKENS,
    messages: [
      { role: "system", content: messages.system },
      ...(messages.messages.length > 0
        ? messages.messages.map((content) => ({ role: "user", content }))
        : [{ role: "user", content: "Begin filling the form." }]),
    ],
    tools: tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
  };
  const response = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT_MODEL_CALL_TIMEOUT_MS),
    }
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `Gateway model call failed with HTTP ${response.status}: ${detail}`
    );
  }
  const parsed = OpenAiCompatibleResponseSchema.safeParse(
    await response.json()
  );
  if (!parsed.success) {
    throw new Error(
      `Gateway model call returned a shape this loop does not trust: ` +
        `${parsed.error.message.slice(0, 500)}`
    );
  }
  const message = parsed.data.choices[0].message;
  const toolCalls: AgentToolCall[] = (message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    input: call.function.arguments,
  }));
  const usage = parsed.data.usage ?? {};
  const costCents = Math.max(
    1,
    Math.ceil(
      ((usage.prompt_tokens ?? 0) * GATEWAY_INPUT_CENTS_PER_MTOK +
        (usage.completion_tokens ?? 0) * GATEWAY_OUTPUT_CENTS_PER_MTOK) /
        1_000_000
    )
  );
  return {
    ...(typeof message.content === "string" && message.content !== ""
      ? { text: message.content }
      : {}),
    toolCalls,
    costCents,
  };
}

// ───────────────────────────────────
// The default tool runner
// ───────────────────────────────────

/**
 * Builds the `runTool` the loop calls, closing over the run's catalog and
 * page. Dispatches by tool name to the handlers in `tools.ts` (imported
 * dynamically; see the module header for the cycle this avoids) with a
 * `ToolContext` whose fact resolver reads this run's catalog, which is what
 * makes the HARD STOP 9 equality check in `assertSetFieldValueAllowed` bite
 * against real data.
 *
 * Error policy, narrowest to widest:
 *  - A session loss is rethrown as `AgentSessionLostError`; the loop dies
 *    and `runAgentFill` records the stop.
 *  - `AgentFillNotImplementedError` is rethrown untouched: a stub handler is
 *    a deficiency of this codebase, not of the model's plan, and looping on
 *    it would burn the whole budget discovering that.
 *  - Everything else (zod rejections, the exclusion list, a selector that
 *    went stale) becomes `{ ok: false }`, which the loop reports back to the
 *    model in the next turn's transcript.
 */
function buildDefaultRunTool(
  catalog: FactCatalog,
  page: unknown
): RunAgentLoopOptions["runTool"] {
  return async (toolCall: AgentToolCall): Promise<AgentToolOutcome> => {
    const tools = await import("@/lib/agent/tools");
    const ctx: ToolContext = {
      resolveIntakeFactValue: (path) => {
        if (path === null || path === undefined) {
          return tools.UNRESOLVED_INTAKE_FACT;
        }
        const entry = resolveFactPath(catalog, path);
        return entry === undefined ? tools.UNRESOLVED_INTAKE_FACT : entry.value;
      },
      page,
    };

    let input: unknown;
    try {
      input = JSON.parse(toolCall.input);
    } catch {
      return { ok: false };
    }

    try {
      switch (toolCall.name) {
        case "setFieldValue":
          await tools.setFieldValue(input as SetFieldValueInput, ctx);
          return { ok: true };
        case "selectDropdown":
          await tools.selectDropdown(input as SelectDropdownInput, ctx);
          return { ok: true };
        case "toggleCheckbox":
          await tools.toggleCheckbox(input as ToggleCheckboxInput);
          return { ok: true };
        case "addRepeatingSectionEntry":
          await tools.addRepeatingSectionEntry(
            input as AddRepeatingSectionEntryInput
          );
          return { ok: true };
        case "uploadFile":
          await tools.uploadFile(input as UploadFileInput);
          return { ok: true };
        case "markFieldUnanswerable":
          await tools.markFieldUnanswerable(
            input as MarkFieldUnanswerableInput
          );
          return { ok: true };
        case "requestVerifyBeforeSubmit":
          await tools.requestVerifyBeforeSubmit(
            input as RequestVerifyBeforeSubmitInput
          );
          return { ok: true };
        default:
          return { ok: false };
      }
    } catch (err) {
      if (err instanceof AgentFillNotImplementedError) throw err;
      if (looksLikeSessionLoss(err)) {
        throw new AgentSessionLostError(`the "${toolCall.name}" tool`, err);
      }
      return { ok: false };
    }
  };
}

// ───────────────────────────────────
// The default verify adapter
// ───────────────────────────────────

/**
 * `preSubmitVerify` over the live page.
 *
 * What is real here today is the captcha check, which is the half of verify
 * this ticket's termination contract depends on. The validation probe and
 * the error marker scan are deliberately inert: the concrete markers are ats
 * specific selector work the verify module's own header assigns to the page
 * adapter ticket, and a guessed selector list would produce false blocks on
 * real employer forms. An inert scan means verify can pass a form the board
 * will reject, and the submit judgement afterwards is the layer that
 * catches that, exactly as it does on the legacy path.
 */
function buildDefaultVerifyPage(session: BrowserSession): PreSubmitVerifyPage {
  return {
    url: () => session.page.url(),
    probeValidation: async () => {},
    waitForValidation: (ms) =>
      new Promise<void>((resolveWait) => setTimeout(resolveWait, ms)),
    scanErrorMarkers: async () => [],
    detectCaptcha: async () => {
      const found = await session.page.evaluate(CAPTCHA_PRESENT_SCRIPT);
      return Boolean(found);
    },
  };
}

async function defaultVerify(session: BrowserSession): Promise<VerifyResult> {
  return preSubmitVerify(buildDefaultVerifyPage(session));
}

// ───────────────────────────────────
// The default submit leg
// ───────────────────────────────────

/**
 * One observe, one click, one settled read, one judgement.
 *
 * The observe (`tryResolveAction`) is the corroboration step: no click
 * happens unless a control matching the compile time instruction exists.
 * After the click nothing here throws, per the same rule the legacy path
 * enforces: every failure past the click resolves as an unconfirmed
 * outcome, because a thrown error is a thing something upstream can decide
 * to retry, and a retry after a real click is the one forbidden action.
 * The settled read and the verdict are the legacy path's own exported
 * functions, not copies, so the two paths cannot drift on what counts as a
 * confirmation.
 */
async function defaultSubmitLeg(
  session: BrowserSession
): Promise<SubmitLegOutcome> {
  const ss = await import("@/lib/stagehand-session");
  const sa = await import("@/lib/submit-application");
  const wasAt = await Promise.resolve(session.page.url());

  const resolved = await ss.tryResolveAction(
    session,
    wasAt,
    AGENT_SUBMIT_INSTRUCTION
  );
  if (resolved === null) {
    return {
      clicked: false,
      submitted: false,
      confirmationRef: null,
      confirmation: null,
      submitControlLabel: null,
      finalUrl: wasAt,
      pageTitle: "",
      detail:
        `submission_blocked: no control on ${wasAt} could be identified as ` +
        `the application submit, so nothing was clicked.`,
    };
  }
  const controlLabel = resolved.action.description;

  console.log(
    `${LOG} submitting via "${controlLabel}" at ${wasAt}. This is the ` +
      `irreversible step.`
  );
  try {
    await session.stagehand.act(AGENT_SUBMIT_INSTRUCTION, {
      page: session.page,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      clicked: true,
      submitted: false,
      confirmationRef: null,
      confirmation: null,
      submitControlLabel: controlLabel,
      finalUrl: wasAt,
      pageTitle: "",
      detail:
        `submit_clicked_outcome_unknown: the click on "${controlLabel}" at ` +
        `${wasAt} failed part way through: ${reason}. Whether the board ` +
        `received the application is unknown. Not retrying.`,
    };
  }

  try {
    const capture = await sa.readSettledConfirmation(
      session,
      wasAt,
      "the agent submit click"
    );
    const verdict = sa.judgeSubmission(capture, wasAt);
    if (verdict.submitted) {
      return {
        clicked: true,
        submitted: true,
        confirmationRef: sa.buildConfirmationRef(capture),
        confirmation: capture,
        submitControlLabel: controlLabel,
        finalUrl: capture.url,
        pageTitle: capture.title,
        detail: verdict.evidence,
      };
    }
    const rejection =
      capture.automationRejection === null
        ? ""
        : ` submission_flagged_as_automated: the board said ` +
          `${JSON.stringify(capture.automationRejection)}.`;
    return {
      clicked: true,
      submitted: false,
      confirmationRef: null,
      confirmation: capture,
      submitControlLabel: controlLabel,
      finalUrl: capture.url,
      pageTitle: capture.title,
      detail:
        `submit_clicked_outcome_unknown: "${controlLabel}" was clicked at ` +
        `${wasAt} and the page afterwards did not corroborate a ` +
        `submission (${verdict.evidence}).${rejection} Not retrying.`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      clicked: true,
      submitted: false,
      confirmationRef: null,
      confirmation: null,
      submitControlLabel: controlLabel,
      finalUrl: wasAt,
      pageTitle: "",
      detail:
        `submit_clicked_outcome_unknown: "${controlLabel}" was clicked at ` +
        `${wasAt}, but the page could not be read afterwards: ${reason}. ` +
        `The application may well have gone through. Not retrying.`,
    };
  }
}

// ───────────────────────────────────
// runAgentFill
// ───────────────────────────────────

/**
 * JOB-316: the wet entry point. See the module header for the run shape.
 * Accepts `deps` so every wet edge is injectable; `dispatchApplicationFill`
 * calls this with the one argument form and gets the real defaults.
 */
export async function runAgentFill(
  input: SubmitApplicationInput,
  deps: AgentFillDeps = {}
): Promise<AgentFillResult> {
  const env = deps.env ?? process.env;
  const supabase = await (deps.getSupabase ?? defaultSupabaseClient)();
  const records = await import("@/lib/application-records");

  // ── Preflight ─────────────────────────────────────────────────────────────
  const { data: appRows, error: appError } = await supabase
    .from("applications")
    .select("id,user_id,job_id,status")
    .eq("id", input.jobApplicationId)
    .limit(1);
  if (appError) {
    throw new Error(`applications lookup failed: ${appError.message}`);
  }
  const app = appRows?.[0];
  if (!app) {
    throw new Error(
      `No applications row with id ${input.jobApplicationId}; nothing to fill.`
    );
  }
  const rowStatus = String(app.status ?? "");
  if (
    rowStatus === APPLICATION_STATUS.SUBMITTED ||
    rowStatus === APPLICATION_STATUS.SUBMISSION_UNCONFIRMED
  ) {
    throw new Error(
      `applications ${input.jobApplicationId} is already at "${rowStatus}". ` +
        `A submit control has been clicked against this listing once ` +
        `already, and nothing may open a browser at it again without a ` +
        `human checking the employer's side first.`
    );
  }
  const userId = String(app.user_id ?? "");
  const jobId = String(app.job_id ?? "");

  const { data: jobRows, error: jobError } = await supabase
    .from("jobs")
    .select("apply_url,ats")
    .eq("id", jobId)
    .limit(1);
  if (jobError) throw new Error(`jobs lookup failed: ${jobError.message}`);
  const job = jobRows?.[0];
  const applyUrl = String(job?.apply_url ?? "").trim();
  const ats = String(job?.ats ?? "").trim();
  if (applyUrl === "") {
    throw new Error(
      `jobs ${jobId} has no apply_url; there is nowhere to send a browser.`
    );
  }

  // ── Catalog and prompt ────────────────────────────────────────────────────
  const catalog = await (deps.loadFactCatalog ?? buildFactCatalog)(userId);
  const serializedCatalog = serializeFactCatalog(catalog);
  const maxSteps = positiveIntFrom(env.AGENT_MAX_STEPS, 60);
  const systemPrompt = buildSystemPrompt(catalog, {
    ats,
    maxSteps,
    escalated: false,
  });

  // ── Session ───────────────────────────────────────────────────────────────
  const session = await (deps.openSession ?? defaultOpenSession)({
    applyUrl,
    headless: input.headless ?? true,
    logTag: LOG,
  });
  const closeSession = deps.closeSession ?? defaultCloseSession;
  const browserbaseSessionId =
    session.browser.provider === "browserbase"
      ? (session.browser.sessionId ?? null)
      : null;

  /** Best effort status write; reports whether the row now matches. */
  const patchRow = async (
    patch: Parameters<typeof records.updateApplication>[2]
  ): Promise<boolean> => {
    try {
      await records.updateApplication(supabase, input.jobApplicationId, {
        ...patch,
        ...(browserbaseSessionId === null ? {} : { browserbaseSessionId }),
      });
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `${LOG} could not update applications ${input.jobApplicationId}: ${reason}`
      );
      return false;
    }
  };

  const finish = (partial: {
    status: SubmitApplicationResult["status"];
    submitted: boolean;
    submitAttempted: boolean;
    confirmationRef?: string | null;
    confirmation?: ConfirmationCapture | null;
    submitControlLabel?: string | null;
    finalUrl: string;
    pageTitle?: string;
    blockedReason?: string | null;
    unconfirmedReason?: string | null;
    rowUpdated: boolean;
  }): AgentFillResult => ({
    jobApplicationId: input.jobApplicationId,
    status: partial.status,
    submitted: partial.submitted,
    submitAttempted: partial.submitAttempted,
    confirmationRef: partial.confirmationRef ?? null,
    confirmation: partial.confirmation ?? null,
    securityCode: null,
    approval: {
      approved: true,
      gate: "auto",
      detail:
        "agent fill path (JOB-316): no review gate is installed on this path",
    },
    submitControlLabel: partial.submitControlLabel ?? null,
    fill: null,
    finalUrl: partial.finalUrl,
    pageTitle: partial.pageTitle ?? "",
    screenshotPath: null,
    blockedReason: partial.blockedReason ?? null,
    unconfirmedReason: partial.unconfirmedReason ?? null,
    rowUpdated: partial.rowUpdated,
  });

  const pageUrlNow = async (): Promise<string> => {
    try {
      return await Promise.resolve(session.page.url());
    } catch {
      return applyUrl;
    }
  };

  /** A stop before anything was clicked: status on the row, reason in the log. */
  const terminalBlocked = async (
    status: SubmitApplicationResult["status"],
    message: string,
    reasonOverride?: Parameters<typeof records.recordSkip>[1]["reason"]
  ): Promise<AgentFillResult> => {
    const rowUpdated = await patchRow({ status });
    await records.recordSkipQuietly(
      supabase,
      {
        applicationId: input.jobApplicationId,
        jobId,
        ats,
        reason: reasonOverride ?? records.skipReasonFor(status, message),
        message,
        browserbaseSessionId,
      },
      LOG
    );
    return finish({
      status,
      submitted: false,
      submitAttempted: false,
      finalUrl: await pageUrlNow(),
      blockedReason: message,
      rowUpdated,
    });
  };

  /** A dead browser: record the stop, then throw the typed error. */
  const sessionLost = async (
    stage: string,
    cause: unknown
  ): Promise<never> => {
    const error = new AgentSessionLostError(stage, cause);
    await patchRow({ status: APPLICATION_STATUS.ERROR });
    await records.recordSkipQuietly(
      supabase,
      {
        applicationId: input.jobApplicationId,
        jobId,
        ats,
        reason: records.skipReasonFor(APPLICATION_STATUS.ERROR, error.message),
        message: error.message,
        browserbaseSessionId,
      },
      LOG
    );
    throw error;
  };

  try {
    await patchRow({ status: APPLICATION_STATUS.FILLING_FORM });

    const loopFn = deps.loop ?? runAgentLoop;
    const loopOpts: RunAgentLoopOptions = {
      modelCall: deps.modelCall ?? defaultModelCall(env),
      runTool: deps.runTool ?? buildDefaultRunTool(catalog, session.page),
      env,
    };
    const verify = deps.verify ?? defaultVerify;

    // ── The loop, then verify, with one escalated retry ─────────────────────
    const runLoopOnce = async (task: string): Promise<void> => {
      try {
        await loopFn(session, serializedCatalog, task, loopOpts);
      } catch (err) {
        if (err instanceof AgentSessionLostError) {
          return await sessionLost("the agent loop", err);
        }
        if (looksLikeSessionLoss(err)) {
          return await sessionLost("the agent loop", err);
        }
        throw err;
      }
    };

    let verdict: VerifyResult;
    try {
      await runLoopOnce(systemPrompt);
      verdict = await verify(session);
      if (verdict.status === "fail") {
        // The retry contract, one rung of it: feed the form's own error
        // markers back and run the loop once more with the escalated prompt.
        const feedback = verdict.errors
          .map(
            (error) =>
              `- ${error.siblingLabel || error.fieldSelector}: ${error.errorText}`
          )
          .join("\n");
        const escalatedPrompt =
          buildSystemPrompt(catalog, { ats, maxSteps, escalated: true }) +
          `\n\nThe form reported these problems after the first pass:\n` +
          feedback;
        await runLoopOnce(escalatedPrompt);
        verdict = await verify(session);
      }
    } catch (err) {
      if (err instanceof AgentBudgetExceededError) {
        return await terminalBlocked(
          APPLICATION_STATUS.FORM_FILL_BLOCKED,
          `agent budget exceeded (${err.reason}) after ${err.steps} step(s) ` +
            `and ${err.costCents} cent(s): ${err.message}`,
          "internal_error"
        );
      }
      if (err instanceof AgentFillNotImplementedError) {
        // A stub tool handler was reached. Record the stop as this system's
        // own deficiency, then rethrow so the pipeline retries once the
        // handlers ship.
        await patchRow({ status: APPLICATION_STATUS.ERROR });
        await records.recordSkipQuietly(
          supabase,
          {
            applicationId: input.jobApplicationId,
            jobId,
            ats,
            reason: "internal_error",
            message: err.message,
            browserbaseSessionId,
          },
          LOG
        );
        throw err;
      }
      // A browser dying under the verify pass (its captcha probe reads the
      // live page) is the same stop as one dying under the loop.
      if (
        !(err instanceof AgentSessionLostError) &&
        looksLikeSessionLoss(err)
      ) {
        return await sessionLost("the verify pass", err);
      }
      throw err;
    }

    if (verdict.status === "captcha_blocked") {
      return await terminalBlocked(
        APPLICATION_STATUS.FORM_FILL_BLOCKED,
        `captcha_present: a captcha widget is on the page at ` +
          `${await pageUrlNow()}. Nothing was clicked.`,
        "captcha"
      );
    }
    if (verdict.status === "fail") {
      const remaining = verdict.errors
        .map(
          (error) =>
            `${error.siblingLabel || error.fieldSelector}: ${error.errorText}`
        )
        .join("; ");
      return await terminalBlocked(
        APPLICATION_STATUS.FORM_FILL_BLOCKED,
        `needs_candidate_input: the form still reports required problems ` +
          `after the escalated pass (${remaining}). Nothing was clicked.`
      );
    }

    // ── Submit ──────────────────────────────────────────────────────────────
    // The default leg resolves rather than throws for everything after the
    // click, so a session loss escaping it can only have happened before
    // anything was clicked, which makes the retryable `error` status safe. An
    // injected leg owes the same guarantee.
    let leg: SubmitLegOutcome;
    try {
      leg = await (deps.submitLeg ?? defaultSubmitLeg)(session);
    } catch (err) {
      if (looksLikeSessionLoss(err)) {
        return await sessionLost("the submit leg, before any click", err);
      }
      throw err;
    }
    if (!leg.clicked) {
      const blocked = await terminalBlocked(
        APPLICATION_STATUS.SUBMISSION_BLOCKED,
        leg.detail
      );
      return { ...blocked, submitControlLabel: leg.submitControlLabel };
    }
    if (leg.submitted) {
      const rowUpdated = await patchRow({
        status: APPLICATION_STATUS.SUBMITTED,
        confirmationText: leg.confirmationRef,
        submittedAt: new Date().toISOString(),
      });
      console.log(
        `${LOG} applications ${input.jobApplicationId} submitted ` +
          `(${leg.detail})`
      );
      return finish({
        status: APPLICATION_STATUS.SUBMITTED,
        submitted: true,
        submitAttempted: true,
        confirmationRef: leg.confirmationRef,
        confirmation: leg.confirmation,
        submitControlLabel: leg.submitControlLabel,
        finalUrl: leg.finalUrl,
        pageTitle: leg.pageTitle,
        rowUpdated,
      });
    }
    const rowUpdated = await patchRow({
      status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
    });
    await records.recordSkipQuietly(
      supabase,
      {
        applicationId: input.jobApplicationId,
        jobId,
        ats,
        reason: records.skipReasonFor(
          APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
          leg.detail
        ),
        message: leg.detail,
        browserbaseSessionId,
      },
      LOG
    );
    return finish({
      status: APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
      submitted: false,
      submitAttempted: true,
      confirmation: leg.confirmation,
      submitControlLabel: leg.submitControlLabel,
      finalUrl: leg.finalUrl,
      pageTitle: leg.pageTitle,
      unconfirmedReason: leg.detail,
      rowUpdated,
    });
  } finally {
    await closeSession(session).catch(() => undefined);
  }
}

/**
 * The one function the pipeline calls. Encapsulates the routing decision so
 * that the pipeline itself does not have to read env vars, and so that tests
 * can inject fakes for both the agent and the legacy path and assert exactly
 * which one was reached.
 *
 * Both `legacy` and `agent` default to the real implementations. The `env`
 * override is there for the same reason `shouldUseAgentFillForAts` accepts
 * one: it lets a test assert every routing branch without mutating global
 * state.
 */
export interface DispatchApplicationFillOptions {
  legacy?: (input: SubmitApplicationInput) => Promise<SubmitApplicationResult>;
  agent?: (input: SubmitApplicationInput) => Promise<SubmitApplicationResult>;
  env?: Record<string, string | undefined>;
}

export async function dispatchApplicationFill(
  input: SubmitApplicationInput,
  ats: string,
  options: DispatchApplicationFillOptions = {}
): Promise<SubmitApplicationResult> {
  const legacy = options.legacy ?? defaultLegacy;
  const agent = options.agent ?? runAgentFill;
  const env = options.env ?? process.env;
  return shouldUseAgentFillForAts(ats, env)
    ? await agent(input)
    : await legacy(input);
}

/**
 * Indirection through a function rather than an eager `import { submitApplication }`
 * so that the module graph does not pull `lib/submit-application.ts` (and its
 * Browserbase/Stagehand imports) into every test that only touches routing.
 * The real production path still resolves through this and calls the same
 * `submitApplication` it always has.
 */
async function defaultLegacy(
  input: SubmitApplicationInput
): Promise<SubmitApplicationResult> {
  const { submitApplication } = await import("@/lib/submit-application");
  return submitApplication(input);
}
