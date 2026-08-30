/**
 * JOB-277 (sub ticket A of #276): the seven tool definitions the Stagehand
 * agent loop will be handed.
 *
 * Every tool has three parts:
 *
 *   1. A zod schema for its input. The agent loop hands the LLM a JSON schema
 *      derived from this and refuses any call whose arguments do not parse.
 *   2. An exclusion list check that runs before the handler for
 *      `setFieldValue`. Fields whose label reads as background check critical
 *      (employer, employment dates, education institution, degree field) are
 *      only writable when the call declares an `intake` source and quotes a
 *      resolvable `intakeFactPath`. This enforces HARD STOP 9 at the tool
 *      boundary rather than as a review after the fact.
 *   3. A handler that will do the actual work. At scaffold time every handler
 *      throws `AgentFillNotImplementedError`. Sub tickets B..H replace the
 *      throw with the real implementation.
 */

import { z } from "zod";

import { AgentFillNotImplementedError } from "@/lib/agent";

/**
 * Where the value on a `setFieldValue` call came from.
 *
 *  - `intake` means the value was quoted verbatim from a fact the user
 *    supplied on intake or on the resume, identified by `intakeFactPath`.
 *  - `inferred` means the value was derived from intake facts (for example a
 *    graduation year computed from a school and a degree end date). Still
 *    grounded, but not a direct quote.
 *  - `fabricated` means the value is not grounded in any intake fact. The
 *    exclusion list rejects this for background check critical fields, and
 *    the review pass in a later ticket will flag it more generally.
 */
export const SourceHintSchema = z.enum(["intake", "inferred", "fabricated"]);
export type SourceHint = z.infer<typeof SourceHintSchema>;

const nonEmptyString = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`);

export const SetFieldValueInputSchema = z.object({
  fieldId: nonEmptyString("fieldId"),
  label: nonEmptyString("label"),
  value: z.string(),
  sourceHint: SourceHintSchema,
  /**
   * The dotted path into the fact catalog the value was quoted from. Required
   * when `sourceHint` is `intake`; must resolve against the current run's
   * catalog. Left null when `sourceHint` is not `intake`; the exclusion list
   * check below rejects the call anyway when the label reads as background
   * check critical, regardless of hint.
   */
  intakeFactPath: z.string().min(1).nullable().optional(),
});
export type SetFieldValueInput = z.infer<typeof SetFieldValueInputSchema>;

export const SelectDropdownInputSchema = z.object({
  fieldId: nonEmptyString("fieldId"),
  label: nonEmptyString("label"),
  optionValue: nonEmptyString("optionValue"),
});
export type SelectDropdownInput = z.infer<typeof SelectDropdownInputSchema>;

export const ToggleCheckboxInputSchema = z.object({
  fieldId: nonEmptyString("fieldId"),
  label: nonEmptyString("label"),
  checked: z.boolean(),
});
export type ToggleCheckboxInput = z.infer<typeof ToggleCheckboxInputSchema>;

export const AddRepeatingSectionEntryInputSchema = z.object({
  sectionId: nonEmptyString("sectionId"),
  label: nonEmptyString("label"),
});
export type AddRepeatingSectionEntryInput = z.infer<
  typeof AddRepeatingSectionEntryInputSchema
>;

export const UploadFileInputSchema = z.object({
  fieldId: nonEmptyString("fieldId"),
  label: nonEmptyString("label"),
  /** Path in the run's private bucket. Not a raw file path. */
  storagePath: nonEmptyString("storagePath"),
});
export type UploadFileInput = z.infer<typeof UploadFileInputSchema>;

export const MarkFieldUnanswerableInputSchema = z.object({
  fieldId: nonEmptyString("fieldId"),
  label: nonEmptyString("label"),
  reason: nonEmptyString("reason"),
});
export type MarkFieldUnanswerableInput = z.infer<
  typeof MarkFieldUnanswerableInputSchema
>;

export const RequestVerifyBeforeSubmitInputSchema = z.object({
  note: z.string().trim().min(1),
});
export type RequestVerifyBeforeSubmitInput = z.infer<
  typeof RequestVerifyBeforeSubmitInputSchema
>;

/**
 * Label patterns that carry background check consequences. A field matching
 * any of these can only be filled when the value is quoted verbatim from
 * intake, because it is exactly this set of fields an employer's background
 * check verifies against a third party record. A wrong answer here is not a
 * form error; it is grounds to rescind an offer.
 *
 * Kept literal rather than pulled from a config file so the review agent sees
 * the exact set on a diff. Extending the set is a deliberate PR, not a data
 * change.
 */
const BACKGROUND_CHECK_CRITICAL_LABEL_PATTERNS: RegExp[] = [
  // Employer / company name
  /\bemployer\b/i,
  /\bcompany\s*name\b/i,
  /\bprevious\s+employer\b/i,
  // Employment dates
  /\bemployment\s+dates?\b/i,
  /\bstart\s+date\b/i,
  /\bend\s+date\b/i,
  /\bdate\s+of\s+employment\b/i,
  // Education institution
  /\bschool\b/i,
  /\buniversity\b/i,
  /\bcollege\b/i,
  /\binstitution\b/i,
  // Degree field
  /\bdegree\b/i,
  /\bmajor\b/i,
  /\bfield\s+of\s+study\b/i,
];

export function isBackgroundCheckCriticalLabel(label: string): boolean {
  return BACKGROUND_CHECK_CRITICAL_LABEL_PATTERNS.some((pattern) =>
    pattern.test(label)
  );
}

/**
 * Thrown when the exclusion list wrapper rejects a `setFieldValue` call. A
 * distinct class so the agent loop can log this differently from a plain zod
 * validation error and from `AgentFillNotImplementedError`.
 */
export class ExcludedFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExcludedFieldError";
  }
}

/**
 * The context passed into every tool handler. Kept as an interface so tests
 * can supply a minimal fake without importing the whole run wiring.
 */
export interface ToolContext {
  /**
   * Returns true when the given dotted path resolves against the current
   * run's fact catalog. False when it does not, or when the path is null.
   */
  resolveIntakeFactPath: (path: string | null | undefined) => boolean;
}

/**
 * The exclusion list wrapper. Runs on every `setFieldValue` call before the
 * handler. Enforces:
 *
 *   - `intakeFactPath` is a resolvable path in the fact catalog whenever
 *     `sourceHint === "intake"`, regardless of label. A hint that claims a
 *     source without pointing at one is a bug, not a value.
 *   - For labels that read as background check critical, only
 *     `sourceHint === "intake"` with a resolvable `intakeFactPath` is
 *     accepted. Everything else throws.
 */
export function assertSetFieldValueAllowed(
  input: SetFieldValueInput,
  ctx: ToolContext
): void {
  if (input.sourceHint === "intake") {
    if (
      input.intakeFactPath == null ||
      !ctx.resolveIntakeFactPath(input.intakeFactPath)
    ) {
      throw new ExcludedFieldError(
        `setFieldValue for "${input.label}" declared sourceHint=intake but ` +
          `its intakeFactPath ${
            input.intakeFactPath == null
              ? "was not supplied"
              : `"${input.intakeFactPath}" does not resolve against the fact catalog`
          }.`
      );
    }
  }

  if (!isBackgroundCheckCriticalLabel(input.label)) return;

  if (input.sourceHint !== "intake") {
    throw new ExcludedFieldError(
      `setFieldValue for "${input.label}" is background check critical and ` +
        `may only be filled from intake. Received sourceHint=${input.sourceHint}.`
    );
  }
  if (
    input.intakeFactPath == null ||
    !ctx.resolveIntakeFactPath(input.intakeFactPath)
  ) {
    throw new ExcludedFieldError(
      `setFieldValue for "${input.label}" is background check critical and ` +
        `requires a resolvable intakeFactPath. Received ${
          input.intakeFactPath == null ? "null" : `"${input.intakeFactPath}"`
        }, which does not resolve against the fact catalog.`
    );
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────
// Every handler parses its input through the zod schema (throws on invalid
// shape), runs the exclusion list check where applicable, then throws
// `AgentFillNotImplementedError` for the actual work. Sub tickets B..H
// replace the throw with the real implementation.

export async function setFieldValue(
  input: SetFieldValueInput,
  ctx: ToolContext
): Promise<void> {
  const parsed = SetFieldValueInputSchema.parse(input);
  assertSetFieldValueAllowed(parsed, ctx);
  throw new AgentFillNotImplementedError("setFieldValue");
}

export async function selectDropdown(
  input: SelectDropdownInput
): Promise<void> {
  SelectDropdownInputSchema.parse(input);
  throw new AgentFillNotImplementedError("selectDropdown");
}

export async function toggleCheckbox(
  input: ToggleCheckboxInput
): Promise<void> {
  ToggleCheckboxInputSchema.parse(input);
  throw new AgentFillNotImplementedError("toggleCheckbox");
}

export async function addRepeatingSectionEntry(
  input: AddRepeatingSectionEntryInput
): Promise<void> {
  AddRepeatingSectionEntryInputSchema.parse(input);
  throw new AgentFillNotImplementedError("addRepeatingSectionEntry");
}

export async function uploadFile(input: UploadFileInput): Promise<void> {
  UploadFileInputSchema.parse(input);
  throw new AgentFillNotImplementedError("uploadFile");
}

export async function markFieldUnanswerable(
  input: MarkFieldUnanswerableInput
): Promise<void> {
  MarkFieldUnanswerableInputSchema.parse(input);
  throw new AgentFillNotImplementedError("markFieldUnanswerable");
}

export async function requestVerifyBeforeSubmit(
  input: RequestVerifyBeforeSubmitInput
): Promise<void> {
  RequestVerifyBeforeSubmitInputSchema.parse(input);
  throw new AgentFillNotImplementedError("requestVerifyBeforeSubmit");
}
