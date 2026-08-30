/**
 * JOB-277 (sub ticket A of #276): scaffold for the agent's system prompt
 * builder.
 *
 * The system prompt is composed at the top of every agent run from the fact
 * catalog (the read only view of the user's intake data) and the task
 * config (per ats hints, submit gates, retry budgets). Sub ticket E fills
 * this in. Until then the builder returns an empty string so the loop cannot
 * silently ship a prompt that never included the guardrails.
 */

import type { FactCatalog } from "@/lib/agent/fact-catalog";

/**
 * Per run knobs that shape the prompt. Kept narrow at scaffold time; sub
 * ticket E widens it with the ats specific hints (Ashby's dropdown quirks,
 * Greenhouse's cover letter policy, and so on).
 */
export interface AgentTaskConfig {
  ats: string;
  /**
   * Maximum tool calls the loop is allowed on this run. Mirrors the value in
   * `AGENT_MAX_STEPS` at the call site; passed in so the prompt can quote it
   * to the LLM rather than having the model guess a budget.
   */
  maxSteps: number;
  /**
   * Whether this run has already been escalated to the fallback model.
   * Included in the prompt so the escalated pass is aware it is the last
   * chance before the run is skipped.
   */
  escalated: boolean;
}

/**
 * Stub. Returns an empty string so a caller that reaches this before sub
 * ticket E lands sends the LLM no instructions at all, which the loop is
 * expected to treat as a fatal misconfiguration.
 */
export function buildSystemPrompt(
  factCatalog: FactCatalog,
  taskConfig: AgentTaskConfig
): string {
  // Reference the arguments so eslint does not flag them while the body is a
  // stub; sub ticket E composes the real prompt from both.
  void factCatalog;
  void taskConfig;
  return "";
}
