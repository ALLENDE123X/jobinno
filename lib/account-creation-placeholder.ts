/**
 * A compile time stand in for actinno's `createBoardAccount()`.
 *
 * Why this file exists (JOB-001)
 *
 * `inngest/job-application-pipeline.ts` was ported verbatim, and it still has a
 * `create-account` step. JOB-001 is a copy and make it compile ticket, so that
 * step was left exactly as actinno wrote it rather than being cut out here. A
 * later ticket owns removing it and rewiring the chain, and doing that surgery
 * mid port would mean reviewing a rewrite instead of a copy.
 *
 * But `lib/create-board-account.ts` itself is explicitly NOT ported: it is
 * ~1,500 lines of browser automation that signs a real person up for an account
 * on a real employer's site, and whether Jobinno should ever do that is an open
 * product question. So the call site needs a target, and this is it.
 *
 * What it does
 *
 * Nothing. It throws. It exists to satisfy the type checker and to make the
 * failure mode loud and unambiguous if the pipeline is ever run before the
 * rewiring ticket lands, rather than silently returning a plausible looking
 * result that the rest of the chain would then act on.
 *
 * The types
 *
 * `CreateBoardAccountInput` matches actinno's field for field. The result type
 * is narrowed to the six fields the pipeline's step actually reads (it already
 * trims the rest before returning, see its "Trimmed deliberately" comment),
 * because reproducing the full shape would mean dragging `PageSignals` and its
 * zod schema across too, for fields nobody here reads.
 *
 * TODO(JOB-rewire): delete this file in the same change that removes the
 * `create-account` step from `inngest/job-application-pipeline.ts`. It has no
 * other importer and no reason to outlive that step.
 */

import type { ApplicationStatus } from "@/lib/application-status";

export type CreateBoardAccountInput = {
  candidateId: string;
  company: string;
  jobTitle: string;
  applyUrl: string;
  applicationEmail: string;
  atsProvider?: string;
  headless?: boolean;
};

/**
 * The subset of actinno's `CreateBoardAccountResult` that the Inngest step
 * keeps. See this file's header for why it is a subset.
 */
export type CreateBoardAccountResult = {
  jobApplicationId: string;
  status: ApplicationStatus;
  /** Whether the board actually gates applications behind an account. */
  accountGate: boolean;
  /** Human readable justification for the gate verdict. Logged and reviewable. */
  reasons: string[];
  finalUrl: string;
  /** True only when a signup form was actually filled and submitted. */
  accountCreated: boolean;
};

export async function createBoardAccount(
  input: CreateBoardAccountInput
): Promise<CreateBoardAccountResult> {
  throw new Error(
    "createBoardAccount() is not implemented in Jobinno. The account creation " +
      "step was carried over from actinno's pipeline unchanged (JOB-001), but its " +
      "implementation was deliberately not ported. Remove the create-account step " +
      "from inngest/job-application-pipeline.ts before running the pipeline. " +
      `Attempted for: ${input.company}, ${input.jobTitle}`
  );
}
