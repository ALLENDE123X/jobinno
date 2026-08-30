/**
 * JOB-277 (sub ticket A of #276): scaffold for the agent's fact catalog.
 *
 * The fact catalog is the read only view of a user's intake data the agent
 * loop sees. Every free text answer the agent produces has to trace back to a
 * path in this catalog, or it must decline the field. That is what enforces
 * HARD STOP 9 (no fabricated facts) at the tool boundary in `tools.ts` rather
 * than as a review after the fact.
 *
 * This file is a typed stub only. Sub ticket B fills in `buildFactCatalog`
 * from `profiles`, `resumes`, and `candidate-answers`. Until then every call
 * throws `AgentFillNotImplementedError`.
 */

import { AgentFillNotImplementedError } from "@/lib/agent";

/**
 * The shape the agent loop reads. Kept intentionally narrow at scaffold time;
 * sub ticket B widens it in the same file.
 *
 * `entries` is the flat list of facts. A single `FactEntry` binds a dotted
 * `path` (the identifier the agent quotes on `setFieldValue` calls via
 * `intakeFactPath`) to the underlying `value`, plus a short human `label` for
 * prompt inclusion and the `source` the fact came from (which is what makes it
 * possible to audit later whether the agent quoted a real answer or something
 * it inferred).
 */
export interface FactEntry {
  path: string;
  label: string;
  value: string | number | boolean | null;
  source: "profile" | "resume" | "candidate_answer";
}

export interface FactCatalog {
  userId: string;
  entries: FactEntry[];
}

/**
 * Stub. Returns a typed empty catalog shape for a given user id so that
 * subsequent tickets can widen this in place without breaking every
 * downstream import; today every call throws so no caller can accidentally
 * ship a run that thinks it read from the catalog.
 */
export async function buildFactCatalog(userId: string): Promise<FactCatalog> {
  // Reference the argument so eslint does not flag it while the body is a
  // stub; sub ticket B reads the profile, resume, and candidate answers
  // for `userId` and populates the returned catalog.
  void userId;
  throw new AgentFillNotImplementedError("buildFactCatalog");
}

/**
 * Resolves a dotted `path` against a `FactCatalog` and returns the entry when
 * one exists. Kept as a small helper here rather than inlined into `tools.ts`
 * so the exclusion list wrapper can be tested in isolation with a mock
 * resolver. The scaffold implementation is a plain linear scan — sub ticket B
 * may replace it with an indexed lookup once the catalog is large enough for
 * that to matter.
 */
export function resolveFactPath(
  catalog: FactCatalog,
  path: string
): FactEntry | undefined {
  return catalog.entries.find((entry) => entry.path === path);
}
