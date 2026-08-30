/**
 * JOB-277 (sub ticket A of #276): scaffold for the pre submit verification
 * pass.
 *
 * Before the agent loop is allowed to click a submit control, it runs a
 * second, cheaper LLM pass that reads back every field it filled and confirms
 * each value against the fact catalog. Sub ticket F fills this in. Until
 * then the stub throws so a run that reaches this point without the
 * implementation fails loudly rather than clicking submit on unverified
 * state.
 */

import { AgentFillNotImplementedError } from "@/lib/agent";

/**
 * The shape `preSubmitVerify` returns. Kept narrow at scaffold time; sub
 * ticket F widens the discriminated union with per field diagnostics.
 *
 *  - `ok` means every field the agent filled was confirmed against the fact
 *    catalog and the run is cleared to click submit.
 *  - `blocked` means at least one field failed the reread. The `reason` is a
 *    short human string the pipeline logs to `skip_log` and the run stops
 *    without clicking anything.
 */
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Placeholder for the Stagehand page handle. The scaffold does not depend on
 * Stagehand at all so `unknown` is enough here; sub ticket F narrows this to
 * the real `Page` type at the point it is imported.
 */
export type PreSubmitVerifyPage = unknown;

export async function preSubmitVerify(
  page: PreSubmitVerifyPage
): Promise<VerifyResult> {
  // Reference the argument so eslint does not flag it while the body is a
  // stub; sub ticket F uses `page` for the actual reread pass.
  void page;
  throw new AgentFillNotImplementedError("preSubmitVerify");
}
