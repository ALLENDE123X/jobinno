/**
 * JOB-277 (sub ticket A of #276): scaffold for the Stagehand hybrid agent fill.
 *
 * This module is the entry point the pipeline reaches when a run has been
 * routed onto the agent path instead of the legacy widget fill. It is
 * deliberately empty of implementation. Every call throws
 * `AgentFillNotImplementedError` until the sub tickets B..H land.
 *
 * The flag `USE_AGENT_FILL` defaults to false, and `USE_AGENT_FILL_ATS` is an
 * empty allowlist by default, so the routing helper answers `false` for every
 * ats until an operator turns both on. This is what keeps the scaffold zero
 * behavior change on the running pipeline. See `.env.example` for the full
 * shape of the flags and their defaults.
 */

import type {
  SubmitApplicationInput,
  SubmitApplicationResult,
} from "@/lib/submit-application";

/**
 * JOB-279 (sub ticket B): the snapshot type shapes and pure builders that
 * the eventual agent loop threads through every turn. Re-exported from the
 * package entry point so sub tickets C..H can `import { ... } from
 * "@/lib/agent"` without having to know which sibling file each name
 * originally lives in. The runtime behavior is still stubbed here (see
 * `runAgentFill` below); this only wires the shape.
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
 * JOB-280 (sub ticket C): the deterministic prefill pass. Exported a second time so
 * sub tickets D..H can `import { deterministicPrefill } from "@/lib/agent"`
 * without knowing the module layout. See `lib/agent/prefill.ts` for the
 * cost model and the HARD STOP 9 exclusion guard the walker enforces.
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
 * interchangeably. The alias exists as its own name so sub tickets can widen
 * or narrow the shape without churning every call site.
 */
export type AgentFillResult = SubmitApplicationResult;

/**
 * Thrown by every stub in `lib/agent/`. A distinct class so callers can tell
 * "the agent path was reached before it was ready" apart from a real runtime
 * error inside the eventual implementation.
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

/**
 * Stub. The eventual implementation opens a Browserbase session, hands it to
 * the Stagehand agent loop, and returns the same shape `submitApplication`
 * returns. For now it throws so the pipeline fails loudly the first time an
 * operator flips the flag on for an ats before the implementation ships.
 *
 * JOB-280 (sub ticket C) shape note. Once sub ticket E lands the Browserbase
 * session and sub ticket B lands the fact catalog builder, this function
 * runs `deterministicPrefill(page, catalog)` on the opened page as its
 * first step (before the agent loop takes a turn) and threads the returned
 * `PrefillReport` into the trace log sub ticket F wires. The wiring is
 * intentionally staged rather than done here today: prefill needs both a
 * real `PrefillPage` and a non stub catalog to actually run, and both are
 * strict blockers on tickets that have not merged yet.
 */
export async function runAgentFill(
  input: SubmitApplicationInput
): Promise<AgentFillResult> {
  // Reference the argument so eslint does not flag it while the body is a
  // stub; sub tickets B..H open a Browserbase session on `input`, build a
  // fact catalog for `input.userId`, hand both to `deterministicPrefill`,
  // and then hand the same page to the agent loop.
  void input;
  throw new AgentFillNotImplementedError("runAgentFill");
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
