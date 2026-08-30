/**
 * JOB-277 (sub ticket A of #276): scaffold for the agent model router.
 *
 * The agent loop can escalate from a cheaper primary model to a heavier
 * fallback under conditions sub ticket D pins down (repeated tool errors, a
 * verification pass failing, a cost budget breach). `pickModel` is where that
 * decision is expressed; today it reads the fallback identifier from
 * `USE_AGENT_ESCALATION_MODEL` and returns a typed config the loop consumes.
 *
 * The scaffold ships a plain default primary and reads the escalation model
 * from env. Real routing logic (when to escalate, how many attempts to allow
 * on each rung, how to record the switch) lands in sub ticket D.
 */

/** The single value a router call needs about the current step. */
export interface AgentRouterContext {
  /** `true` when the loop is asking for the fallback model. */
  wantsEscalation: boolean;
}

export interface ModelConfig {
  /** Model identifier the caller passes into the LLM client. */
  model: string;
  /** Which rung of the ladder this call is on. */
  tier: "primary" | "escalation";
}

/**
 * Default primary model, kept as a module constant so a review can see the
 * exact string on the diff. Epic #276 acceptance criterion 7 pins Gemini 3.1
 * pro preview as the primary rung. JOB-SPIKE v5 modal-loop evidence ruled
 * Haiku out as a viable primary, so the scaffold ships the real primary
 * rather than a placeholder that a sub ticket would silently inherit. Sub
 * ticket D may promote this to its own env var, but at scaffold time the
 * primary is not configurable. Flipping it would silently reshape agent
 * behavior across every ats.
 *
 * The `model` field on `ModelConfig` is typed as a plain `string` so that a
 * non Anthropic identifier fits the union without a type widening pass. Sub
 * ticket D formalizes the union of supported model ids as it wires the real
 * LLM client.
 */
const DEFAULT_PRIMARY_MODEL = "google/gemini-3-1-pro-preview";
const DEFAULT_ESCALATION_MODEL = "anthropic/claude-sonnet-4-6";

export function pickModel(
  context: AgentRouterContext,
  env: Record<string, string | undefined> = process.env
): ModelConfig {
  if (!context.wantsEscalation) {
    return { model: DEFAULT_PRIMARY_MODEL, tier: "primary" };
  }
  const escalation = (env.USE_AGENT_ESCALATION_MODEL ?? "").trim();
  return {
    model: escalation.length > 0 ? escalation : DEFAULT_ESCALATION_MODEL,
    tier: "escalation",
  };
}
