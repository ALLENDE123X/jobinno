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
 * exact string on the diff. Sub ticket D may promote this to its own env var,
 * but at scaffold time the primary is not configurable — flipping it would
 * silently reshape agent behavior across every ats.
 */
const DEFAULT_PRIMARY_MODEL = "anthropic/claude-haiku-4-5";
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
