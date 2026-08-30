/**
 * JOB-277 (sub ticket A of #276): scaffold for the agent model router.
 *
 * The agent loop can escalate from a cheaper primary model to a heavier
 * fallback under conditions sub ticket D pins down (repeated tool errors, a
 * verification pass failing, a cost budget breach). `pickModel` is where that
 * decision is expressed; today it reads the fallback identifier from
 * `USE_AGENT_ESCALATION_MODEL` and returns a typed config the loop consumes.
 *
 * JOB-282 (sub ticket E of #276): replace the scaffold with the real router
 * and the outer agent loop around it.
 *
 * Three new surfaces land here. First, `pickModel` takes a richer context
 * than the scaffold's single boolean: a retry counter plus an optional hint
 * naming a complex widget class. It returns the Gemini primary on the first
 * rung and the Sonnet escalation on any later rung or whenever the hint names
 * a known complex class. JOB-SPIKE v5 modal loop evidence ruled Haiku out as
 * viable at any tier, so `pickModel` guards against ever resolving to a Haiku
 * identifier, even from a future env override. Second,
 * `buildAnthropicMessagesWithCaching` emits the Anthropic message shape with
 * the system prompt and fact catalog blocks marked `cache_control:
 * { type: "ephemeral" }`, which the provider bills at a fraction of full
 * price on later turns of the same run. Third, `runAgentLoop` is the load
 * bearing outer loop. It selects a model before each iteration, calls an
 * injected model function, executes injected tool handlers, tracks retry
 * state against a closed escalation signal set, and enforces the step and
 * cost budgets named in `AGENT_MAX_STEPS` and `AGENT_MAX_COST_CENTS`.
 *
 * This module stays pure LLM plumbing. No browser code and no Stagehand; the
 * tool handlers land in sub tickets B and D and feed their snapshots into
 * this loop. `session` is accepted by `runAgentLoop` and threaded through
 * unconsumed until that wiring exists.
 */

/**
 * The two widget classes the loop treats as escalation triggers. This is the
 * small closed union the loop answers to: a tool outcome naming one of these
 * makes the next iteration select the Sonnet rung. The same value doubles as
 * the `hint` field on `ModelSelectionContext`, so the escalation decision and
 * the record of why it fired share one vocabulary. Sub tickets B and D may
 * widen the set as they pin down real tool failure modes; for now it only
 * carries the complex widget signal the spike evidence named.
 */
export type EscalationSignal = "complex-widget" | "modal-heavy";

/** The single value a router call needs about the current attempt. */
export interface ModelSelectionContext {
  /**
   * How many prior iterations already ran on the primary rung. Zero means
   * "give me the primary"; any positive value means "move to the fallback".
   */
  retry: number;
  /**
   * Optional complex widget class observed on the prior iteration. When set
   * to a known escalation trigger on retry zero, the router skips the primary
   * and selects the fallback immediately.
   */
  hint?: EscalationSignal;
}

/**
 * The provider families the loop treats separately. The value is derived from
 * the picked model at `pickModel` time so the loop routes on the config itself
 * rather than by string sniffing the model id, which used to fail on operator
 * overrides that named the model without a provider prefix or with a routing
 * host in front of it. Anthropic is the only value that unlocks the caching
 * shape today; every other family falls into `other` so a new provider name
 * lands in the legacy path by default instead of silently claiming Anthropic
 * caching semantics it does not support.
 */
export type ModelProvider = "anthropic" | "google" | "other";

export interface ModelConfig {
  /** Model identifier the caller passes into the LLM client. */
  model: string;
  /** Which rung of the ladder this call is on. */
  tier: "primary" | "escalation";
  /**
   * The provider family the loop routes on. Set by `pickModel` from the
   * resolved model id so the caller does not have to reparse strings to know
   * which shape of messages the model expects. Anthropic is the one value
   * that unlocks the cached message shape today.
   */
  provider: ModelProvider;
}

/**
 * Derives the provider family from a resolved model id. The classification is
 * substring based so the router accepts every shape an operator or a routing
 * layer might realistically supply for the same model: bare slugs
 * (`claude-sonnet-4-6`, matching Anthropic's own SDK docs), family prefixed
 * slugs (`anthropic/claude-sonnet-4-6`), and router prefixed slugs
 * (`openrouter/anthropic/claude-sonnet-4-6`). All three route to the Anthropic
 * caching path, so an operator override never bypasses the ticket's primary
 * cost lever by choosing a different string spelling of the same model.
 */
function inferProvider(model: string): ModelProvider {
  const lowered = model.toLowerCase();
  if (
    lowered.includes("anthropic/") ||
    lowered.includes("claude-")
  ) {
    return "anthropic";
  }
  if (lowered.includes("google/") || lowered.includes("gemini")) {
    return "google";
  }
  return "other";
}

/**
 * Default primary model, kept as a module constant so a review can see the
 * exact string on the diff. Epic #276 acceptance criterion 7 pins Gemini 3.1
 * pro preview as the primary rung. JOB-SPIKE v5 modal loop evidence ruled
 * Haiku out as a viable primary, so the router ships the real primary rather
 * than a placeholder that a sub ticket would silently inherit. Sub ticket D
 * may promote this to its own env var, but at this ticket the primary is not
 * configurable. Flipping it would silently reshape agent behavior across
 * every ats.
 */
const DEFAULT_PRIMARY_MODEL = "google/gemini-3-1-pro-preview";

/**
 * Default escalation model, kept as a module constant for the same reason as
 * the primary. JOB-SPIKE v5 evidence showed Haiku is not viable at any tier,
 * which is why Sonnet 4.6 carries the escalation rung rather than a cheaper
 * Haiku identifier.
 */
const DEFAULT_ESCALATION_MODEL = "anthropic/claude-sonnet-4-6";

/**
 * Case insensitive substring pattern the router must never accept in a model
 * identifier. Named so the defensive guard reads clearly and so a future
 * change to a model id trips the guard rather than silently passing a Haiku
 * string. A substring match on the model family word rather than an exact id
 * check catches every dated and aliased variant Anthropic ever ships, since
 * Anthropic themselves route ids like `claude-haiku-4-5-20261001` and
 * `claude-haiku-4-5-latest` alongside the bare family id: the exact match this
 * guard used to do would let those variants pass, which is exactly the
 * scenario the guard exists to catch.
 */
const FORBIDDEN_HAIKU_PATTERN = /haiku/i;

/**
 * Boundary guard on the router: the router must never hand the loop a Haiku
 * identifier, because JOB-SPIKE v5 evidence showed Haiku is not viable at any
 * tier. The primary and escalation defaults are not Haiku by construction,
 * but `USE_AGENT_ESCALATION_MODEL` is an operator controlled env var and is
 * the one path a future misconfiguration could push a Haiku id through. Fail
 * loud at the boundary rather than let the loop silently run on a model the
 * spike proved unusable. The check is case insensitive substring, not exact
 * equality, so dated ids like `claude-haiku-4-5-20261001` and aliases like
 * `claude-haiku-4-5-latest` are refused the same way the bare id is.
 */
function assertNotHaiku(model: string): string {
  if (FORBIDDEN_HAIKU_PATTERN.test(model)) {
    throw new Error(
      `Refusing to route to ${model}: JOB-SPIKE v5 modal loop evidence ` +
        `showed Haiku is not viable at any tier.`
    );
  }
  return model;
}

/**
 * Returns the model config for the current attempt. On retry zero with no
 * complex hint the primary Gemini rung is returned. On retry zero with a
 * known complex hint, and on any positive retry count regardless of hint,
 * the escalation Sonnet rung is returned, honoring an operator provided
 * override in `USE_AGENT_ESCALATION_MODEL` when one is set.
 *
 * The env override is read the same way the scaffold read it, so behavior is
 * backward compatible: an unset override falls through to the module default.
 * Pure, so tests can pass a synthetic env and cover every retry and hint
 * combination without poking `process.env`.
 */
export function pickModel(
  context: ModelSelectionContext,
  env: Record<string, string | undefined> = process.env
): ModelConfig {
  // `hint !== undefined` rather than an explicit member enumeration so a
  // future EscalationSignal added to the union is honored automatically. The
  // set is a closed union at the type level so any value that reaches here is
  // already a known signal.
  const shouldEscalate = context.retry > 0 || context.hint !== undefined;

  if (!shouldEscalate) {
    const model = assertNotHaiku(DEFAULT_PRIMARY_MODEL);
    return { model, tier: "primary", provider: inferProvider(model) };
  }

  const override = (env.USE_AGENT_ESCALATION_MODEL ?? "").trim();
  const resolved = override.length > 0 ? override : DEFAULT_ESCALATION_MODEL;
  const model = assertNotHaiku(resolved);
  return { model, tier: "escalation", provider: inferProvider(model) };
}

/** One text block in the Anthropic system prompt array. */
export interface AnthropicMessageTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * One per turn message in the Anthropic messages array. Kept wide enough to
 * hold both roles the API accepts, so a later ticket that starts feeding the
 * model its own prior text back on multi turn runs does not have to widen the
 * type first. Only `user` turns are emitted today; the `assistant` value sits
 * here waiting for sub ticket B or D to start using it.
 */
export interface AnthropicTurnMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * The Anthropic message shape `buildAnthropicMessagesWithCaching` emits. The
 * cached prefix lives in the top level `system` array; the per turn chatter
 * lives in `messages` and is deliberately left uncached.
 */
export interface AnthropicCachedMessages {
  /** Discriminator so the loop and the injected model function agree on shape. */
  kind: "anthropic";
  system: AnthropicMessageTextBlock[];
  messages: AnthropicTurnMessage[];
}

/**
 * The plain message shape used when the picked model is not Anthropic (the
 * Gemini primary path). No cache markers, because Gemini context caching is
 * not exposed by the installed SDK.
 */
export interface LegacyMessages {
  /** Discriminator so the loop and the injected model function agree on shape. */
  kind: "legacy";
  system: string;
  messages: string[];
}

/** Union of the two message shapes `runAgentLoop` can hand the model call. */
export type AgentMessages = AnthropicCachedMessages | LegacyMessages;

/**
 * Builds the Anthropic messages array with prompt caching enabled. This is a
 * pure data transform: it emits a plain object of the shape the Anthropic API
 * accepts and never touches an SDK, because `@ai-sdk/anthropic` is not
 * installed in this package. The installed provider surface is
 * `@ai-sdk/openai-compatible` only, and this helper stays independent of it.
 *
 * Why the shape is what it is. Anthropic puts the long lived prefix in a
 * top level `system` field, and caching is expressed by marking a content
 * block with `cache_control: { type: "ephemeral" }`. The system prompt and
 * the fact catalog are the two stable blocks every turn reuses, so both get
 * the marker. Per turn user messages change every iteration and would evict
 * the prefix if cached, so they carry no marker. The result is the behavior
 * the ticket names: around 90 percent off cached tokens on multi turn runs.
 *
 * TODO: Gemini context caching is not exposed by @ai-sdk/google 4.0.57; file
 * a follow up ticket to revisit when the SDK gains support. The Gemini path
 * therefore uses `LegacyMessages` and does not go through this helper.
 */
export function buildAnthropicMessagesWithCaching(
  systemPrompt: string,
  factCatalog: string,
  priorMessages: string[]
): AnthropicCachedMessages {
  return {
    kind: "anthropic",
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: factCatalog,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: priorMessages.map((content) => ({ role: "user", content })),
  };
}

/**
 * One tool invocation the model asked the loop to run. The handlers that act
 * on these live in sub tickets B and D; this ticket only defines the shape
 * the loop threads between the model response and the injected handler.
 */
export interface AgentToolCall {
  id: string;
  name: string;
  /** Serialized arguments for the tool, passed through opaquely. */
  input: string;
}

/**
 * The outcome of running one tool. `signal` is present only when the run did
 * not succeed and the failure names an escalation trigger.
 */
export interface AgentToolOutcome {
  ok: boolean;
  signal?: EscalationSignal;
}

/** The result of one model call, whatever the provider behind it. */
export interface AgentModelResponse {
  /** Assistant text for the turn, when the model produced any. */
  text?: string;
  /** Tools the model wants run before the next turn. Empty means "done". */
  toolCalls: AgentToolCall[];
  /** Cost in whole cents of this call, accumulated toward the cost budget. */
  costCents: number;
}

/**
 * The options that make `runAgentLoop` testable. `modelCall` and `runTool`
 * are injected functions rather than imported providers, in the same
 * dependency injection style `dispatchApplicationFill` uses for its legacy
 * and agent overrides. A test can script both to drive the loop without any
 * live provider, and the production path in sub ticket B or D supplies the
 * real adapter.
 */
export interface RunAgentLoopOptions {
  modelCall: (
    config: ModelConfig,
    messages: AgentMessages
  ) => Promise<AgentModelResponse>;
  runTool: (toolCall: AgentToolCall) => Promise<AgentToolOutcome>;
  env?: Record<string, string | undefined>;
}

/** The result of a loop that stopped because the model produced its answer. */
export interface AgentLoopResult {
  /** Model calls the loop made before the model stopped requesting tools. */
  turns: number;
  /** Final assistant text, when the model produced one on the last turn. */
  finalText?: string;
}

/**
 * Thrown when the loop hits a budget cap before the model finishes. A
 * distinct class so callers can tell a clean budget abort apart from an
 * unrelated runtime failure inside a turn. Carries the reason and the actual
 * counters that tripped it.
 */
export class AgentBudgetExceededError extends Error {
  readonly reason: "max-steps" | "max-cost";
  readonly steps: number;
  readonly costCents: number;

  constructor(detail: {
    reason: "max-steps" | "max-cost";
    steps: number;
    costCents: number;
  }) {
    super(
      detail.reason === "max-steps"
        ? `Agent loop exceeded the step budget at ${detail.steps} steps. ` +
          `The run aborted cleanly; raise AGENT_MAX_STEPS or let the model ` +
          `finish in fewer turns.`
        : `Agent loop exceeded the cost budget at ${detail.costCents} cents. ` +
          `The run aborted cleanly; raise AGENT_MAX_COST_CENTS or shorten the loop.`
    );
    this.name = "AgentBudgetExceededError";
    this.reason = detail.reason;
    this.steps = detail.steps;
    this.costCents = detail.costCents;
  }
}

/**
 * Reads a positive integer budget from env with a fallback. Invalid or
 * missing values fall through to the default rather than crashing the loop,
 * so a misconfigured env degrades to the documented default instead of
 * turning into a confusing runtime error.
 */
function readPositiveInt(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Builds the text a completed turn contributes to the running transcript the
 * next model call sees. Kept small and boring: the assistant reply plus a
 * one line summary per tool outcome, tagged with the tool name and id so a
 * turn that ran more than one tool produces distinguishable summaries rather
 * than a run of identical "Tool completed." lines the next model call cannot
 * tell apart. Sub tickets B and D may replace this with a richer
 * serialization once the real tool handlers exist.
 */
function buildUserTurn(
  response: AgentModelResponse,
  outcomes: Array<{ call: AgentToolCall; outcome: AgentToolOutcome }>
): string {
  const parts: string[] = [];
  if (response.text) parts.push(response.text);
  for (const entry of outcomes) {
    const label = `${entry.call.name} (${entry.call.id})`;
    const summary = entry.outcome.ok
      ? `Tool ${label} completed.`
      : `Tool ${label} reported ${entry.outcome.signal ?? "an error"}.`;
    parts.push(summary);
  }
  return parts.join(" ");
}

/**
 * The outer agent loop. It drives the model to a terminal answer by selecting
 * a model rung before every iteration, calling the injected `modelCall` with
 * the appropriate message shape, running whatever tools the model asked for,
 * and observing the escalation signal set. When a tool names a complex
 * widget class, the next iteration selects the Sonnet rung automatically.
 *
 * Budget enforcement. Both caps are read from the injected env record with
 * documented defaults: `AGENT_MAX_STEPS` (60) bounds the number of model
 * calls, `AGENT_MAX_COST_CENTS` (200) bounds the accumulated cost. On either
 * breach the loop throws `AgentBudgetExceededError` with the reason and the
 * counters that tripped it, instead of stalling or silently going long.
 *
 * #287 (AgentSnapshot duplicate ref uniqueness) is left open on purpose.
 * This ticket does not introduce any producer of snapshots: the tool handlers
 * that build them land in sub tickets B and D, and `runAgentLoop` only
 * consumes snapshots those downstream producers hand back through `runTool`.
 * So this diff does not trigger the duplicate ref guarantee at all. Sub
 * tickets B and D, as the actual producer sites, inherit that follow up and
 * must enforce ref uniqueness or defer explicitly when they land.
 *
 * TODO: Gemini context caching is not exposed by @ai-sdk/google 4.0.57; file
 * a follow up ticket to revisit when the SDK gains support. Until then the
 * Gemini path emits `LegacyMessages` with no cache markers.
 */
export async function runAgentLoop(
  session: unknown,
  factCatalog: string,
  task: string,
  opts: RunAgentLoopOptions
): Promise<AgentLoopResult> {
  // The Stagehand session is accepted for the sub ticket B or D wiring and
  // is not consumed here; keep the binding referenced so this stub stays
  // honest about the shape the future loop will take.
  void session;

  const env = opts.env ?? process.env;
  const maxSteps = readPositiveInt(env.AGENT_MAX_STEPS, 60);
  const maxCostCents = readPositiveInt(env.AGENT_MAX_COST_CENTS, 200);

  const systemPrompt = task;

  let retry = 0;
  let hint: EscalationSignal | undefined;
  const priorMessages: string[] = [];
  let totalCostCents = 0;
  let step = 0;

  for (;;) {
    if (step >= maxSteps) {
      throw new AgentBudgetExceededError({
        reason: "max-steps",
        steps: step,
        costCents: totalCostCents,
      });
    }

    const config = pickModel({ retry, hint }, env);
    // Route on the resolved provider rather than a `startsWith("anthropic/")`
    // sniff on the model id. The sniff used to miss operator overrides that
    // named the model without the provider prefix (matching Anthropic's own
    // SDK docs, which use bare slugs like `claude-sonnet-4-6`) or with a
    // routing host in front of it (like `openrouter/anthropic/...`), and both
    // shapes would silently fall through to the Legacy path and skip the
    // ephemeral cache markers. `config.provider` is set by `pickModel` from
    // the resolved id, so every spelling of the same Anthropic model routes
    // to the caching helper.
    const messages: AgentMessages =
      config.provider === "anthropic"
        ? buildAnthropicMessagesWithCaching(
            systemPrompt,
            factCatalog,
            priorMessages
          )
        : {
            kind: "legacy",
            system: `${systemPrompt}\n\nFact catalog:\n${factCatalog}`,
            // Copy rather than share the live buffer: the injected model
            // function is opaque to the loop, and letting it mutate the
            // loop's own transcript would corrupt every later turn.
            messages: [...priorMessages],
          };

    const response = await opts.modelCall(config, messages);
    step += 1;
    totalCostCents += response.costCents;

    // Terminal return runs first so a turn that produces the final answer on
    // the same call that crosses the cap returns the answer instead of
    // throwing it away. Cost cap runs next, BEFORE any tool handlers execute,
    // because a tool loop that fires after the cap has already been crossed
    // can leak real side effects (form fills, form submits) past the budget
    // the loop is meant to enforce. Once sub tickets B and D wire real
    // Stagehand handlers in place of the stubs, an over budget submit tool
    // call is unrecoverable under the invariant that `submitted` is terminal
    // and can never be undone. The strict `>` boundary means the exact spent
    // value hitting the cap ends the run cleanly rather than aborting the
    // next iteration a run that already finished never would have made.
    // Reversed from the earlier `>=` check that fired before the terminal
    // return and discarded a run's finished text.
    if (response.toolCalls.length === 0) {
      return { turns: step, finalText: response.text };
    }

    if (totalCostCents > maxCostCents) {
      throw new AgentBudgetExceededError({
        reason: "max-cost",
        steps: step,
        costCents: totalCostCents,
      });
    }

    const outcomes: Array<{ call: AgentToolCall; outcome: AgentToolOutcome }> =
      [];
    for (const toolCall of response.toolCalls) {
      const outcome = await opts.runTool(toolCall);
      outcomes.push({ call: toolCall, outcome });
      if (!outcome.ok && outcome.signal) {
        retry = 1;
        hint = outcome.signal;
      }
    }

    priorMessages.push(buildUserTurn(response, outcomes));
  }
}
