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
 *   3. A handler that does the actual work against the page handle on the
 *      tool context. JOB-317 implemented the six handlers the scaffold left
 *      throwing; every handler still preserves the scaffold contract of
 *      throwing `AgentFillNotImplementedError` when the capability it needs
 *      (the page handle, or a loop wiring hook) is absent from the context,
 *      which is the shape the routing tests assert against.
 */

import { z } from "zod";

import { AgentFillNotImplementedError } from "@/lib/agent";
import {
  commitFrameworkState,
  isPageLike,
  jsLiteral,
  type CommitResult,
  type PageLike,
} from "@/lib/agent/widget-adapters";

/**
 * JOB-281 re export: downstream call sites already import tool related
 * types out of this file; keeping the `CommitResult` name reachable here
 * means adding the adapter path did not fork the import surface.
 */
export type { CommitResult } from "@/lib/agent/widget-adapters";

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
 * Sentinel returned by `resolveIntakeFactValue` when the dotted path does not
 * resolve against the current run's fact catalog. A distinct symbol rather
 * than `undefined` so that a fact whose stored value is literally `undefined`
 * (or `null`) is not confused with an unresolvable path. Callers that only
 * care about existence check `value !== UNRESOLVED_INTAKE_FACT`; callers that
 * care about equality (the exclusion list wrapper) can then compare the
 * resolved value against the input value directly.
 */
export const UNRESOLVED_INTAKE_FACT: unique symbol = Symbol(
  "UNRESOLVED_INTAKE_FACT"
);

export type ResolvedIntakeFactValue =
  | string
  | number
  | boolean
  | null
  | typeof UNRESOLVED_INTAKE_FACT;

/**
 * The context passed into every tool handler. Kept as an interface so tests
 * can supply a minimal fake without importing the whole run wiring.
 */
export interface ToolContext {
  /**
   * Returns the value the given dotted path resolves to against the current
   * run's fact catalog. Returns `UNRESOLVED_INTAKE_FACT` when the path does
   * not resolve, or when the path is null. Returning the underlying value
   * rather than a plain boolean is what lets the exclusion list wrapper
   * enforce value equality, not just path existence: a call may not fill
   * `Previous Employer` with "Some Other Company" by quoting a real
   * `resume.experience[0].employer` path whose value is "Acme Corp".
   */
  resolveIntakeFactValue: (
    path: string | null | undefined
  ) => ResolvedIntakeFactValue;
  /**
   * JOB-281: the Stagehand page handle when a real browser is attached.
   * Typed as `unknown` because the scaffold does not import Stagehand at
   * this layer; sub ticket E narrows this to the real `Page` type where
   * the tool wiring lives. Optional so tests that only exercise the
   * exclusion list or the routing keep working with the minimal fake
   * context they already build.
   */
  page?: unknown;
  /**
   * JOB-317: resolves a storage path in the run's private bucket to a
   * local file path a browser file input can consume. Supplied by the run
   * wiring; `uploadFile` throws `AgentFillNotImplementedError` when it is
   * absent, because a handler that cannot reach the bucket has nothing
   * honest to upload.
   */
  materializeUpload?: (storagePath: string) => Promise<string>;
  /**
   * JOB-317: receives the record every `markFieldUnanswerable` call
   * produces. This is HARD STOP 9's safety valve: the loop wiring decides
   * whether the run escalates or skips, and a context without the hook
   * makes the handler throw rather than swallow the signal.
   */
  onFieldUnanswerable?: (record: UnanswerableFieldRecord) => void;
  /**
   * JOB-317: receives the `requestVerifyBeforeSubmit` signal. Same fail
   * closed contract as `onFieldUnanswerable`: absent hook, thrown error,
   * never a silently dropped verification request.
   */
  onVerifyRequested?: (record: VerifyRequestRecord) => void;
}

/**
 * JOB-317: the outcome shape the page acting handlers return. `readBack`
 * carries what the control reported after the action so the loop can put
 * real evidence in the trace; `ok` is the handler's own verdict on whether
 * the readback matches what was asked. A handler never throws for a value
 * that would not land; it reports `ok: false` with the reason in `detail`
 * so the agent can decide between retrying and `markFieldUnanswerable`.
 */
export interface FieldActionResult {
  ok: boolean;
  readBack: string;
  detail: string;
}

/** JOB-317: what `markFieldUnanswerable` records and hands the loop. */
export interface UnanswerableFieldRecord {
  fieldId: string;
  label: string;
  reason: string;
}

/** JOB-317: what `requestVerifyBeforeSubmit` records and hands the loop. */
export interface VerifyRequestRecord {
  note: string;
}

/**
 * JOB-317: the structural surface `uploadFile` needs beyond `PageLike`.
 * Playwright exposes both shapes depending on how the caller holds the
 * page; the handler feature detects per call rather than importing either
 * library, in keeping with this module's no Stagehand import rule.
 */
interface PageWithFileInput extends PageLike {
  setInputFiles?: (selector: string, files: string) => Promise<unknown>;
  locator?: (selector: string) => {
    setInputFiles: (files: string) => Promise<unknown>;
  };
}

/**
 * Normalizes a value for equality comparison against the intake catalog.
 * Strings are trimmed. Numbers and booleans are coerced to their canonical
 * string form. Null becomes the empty string. Kept small and deliberate so
 * the equality check is auditable on the diff and does not accidentally
 * coerce an unrelated value class into matching.
 */
function normalizeForEquality(
  value: string | number | boolean | null
): string {
  if (value === null) return "";
  if (typeof value === "string") return value.trim();
  return String(value);
}

/**
 * The exclusion list wrapper. Runs on every `setFieldValue` call before the
 * handler. Enforces:
 *
 *   - `intakeFactPath` is a resolvable path in the fact catalog whenever
 *     `sourceHint === "intake"`, regardless of label. A hint that claims a
 *     source without pointing at one is a bug, not a value.
 *   - The value on the call matches the value the path resolves to (after a
 *     small normalization step). This is what closes the gap CodeRabbit
 *     flagged at r3888875177: a call may not launder a fabricated value by
 *     quoting any valid catalog path, since the path check alone proves only
 *     that the path exists, not that the value the agent is writing came
 *     from it. HARD STOP 9 fails if the wrapper accepts a mismatched value.
 *   - For labels that read as background check critical, only
 *     `sourceHint === "intake"` with a resolvable, value matching
 *     `intakeFactPath` is accepted. Everything else throws.
 */
export function assertSetFieldValueAllowed(
  input: SetFieldValueInput,
  ctx: ToolContext
): void {
  if (input.sourceHint === "intake") {
    if (input.intakeFactPath == null) {
      throw new ExcludedFieldError(
        `setFieldValue for "${input.label}" declared sourceHint=intake but ` +
          `its intakeFactPath was not supplied.`
      );
    }
    const resolved = ctx.resolveIntakeFactValue(input.intakeFactPath);
    if (resolved === UNRESOLVED_INTAKE_FACT) {
      throw new ExcludedFieldError(
        `setFieldValue for "${input.label}" declared sourceHint=intake but ` +
          `its intakeFactPath "${input.intakeFactPath}" does not resolve ` +
          `against the fact catalog.`
      );
    }
    if (
      normalizeForEquality(resolved) !== normalizeForEquality(input.value)
    ) {
      throw new ExcludedFieldError(
        `setFieldValue for "${input.label}" declared sourceHint=intake and ` +
          `intakeFactPath "${input.intakeFactPath}", but the value on the ` +
          `call did not match the value the path resolves to. The path check ` +
          `alone proves only that the path exists, not that the value the ` +
          `agent is writing came from it, so a mismatch is treated as a ` +
          `fabricated fact under HARD STOP 9.`
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
  // At this point the intake branch above has already verified the path
  // resolves and the value matches, so no further check is required for
  // background check critical labels beyond the sourceHint gate.
}

// ── Handlers ────────────────────────────────────────────────────────────────
// Every handler parses its input through the zod schema (throws on invalid
// shape), runs the exclusion list check where applicable, then does the
// actual work against the context's page handle or wiring hook. The shape
// every page acting handler follows is the one `selectDropdown` (JOB-281)
// established: a context with no page throws `AgentFillNotImplementedError`
// so the scaffold contract the routing tests assert against is preserved,
// and a present page is narrowed structurally rather than through a
// Stagehand import.

/**
 * Shared in page result coercion. Scripts return `{ ok, readBack, detail }`
 * plain objects; anything else (a script that got mangled, an evaluate stub
 * that answers with the wrong shape) collapses to a failed result rather
 * than an exception, because a handler's failure mode is a reported
 * `ok: false`, not a thrown surprise.
 */
function coerceFieldActionResult(value: unknown): FieldActionResult {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return {
      ok: record.ok === true,
      readBack: typeof record.readBack === "string" ? record.readBack : "",
      detail:
        typeof record.detail === "string"
          ? record.detail
          : "script returned no detail",
    };
  }
  return {
    ok: false,
    readBack: "",
    detail: "script returned an unexpected shape",
  };
}

async function runFieldActionScript(
  page: PageLike,
  script: string
): Promise<FieldActionResult> {
  try {
    return coerceFieldActionResult(await page.evaluate(script));
  } catch (error) {
    return {
      ok: false,
      readBack: "",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The in page IIFE `setFieldValue` runs. Sets the value through the native
 * prototype descriptor setter rather than plain assignment because React
 * controlled inputs replace the instance `value` property and cache the
 * last value they saw in `_valueTracker`; a plain assignment updates the
 * cache too, so the `input` event that follows reads as no change and
 * `onChange` never fires. Writing through the prototype setter leaves the
 * cache stale, which is exactly what makes the dispatched `input` event
 * register. For everything that is not React, the same setter is just the
 * ordinary value write. Both `input` and `change` bubble and are composed
 * so listeners above a shadow boundary see them.
 */
function setFieldValueScript(fieldSelector: string, value: string): string {
  return `(() => {
    const sel = ${jsLiteral(fieldSelector)};
    const value = ${jsLiteral(value)};
    const el = document.querySelector(sel);
    if (!el) return { ok: false, readBack: "", detail: "selector did not resolve" };
    const setNative = (node, v) => {
      const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
        : node.tagName === "SELECT" ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(node, v); else node.value = v;
    };
    const fire = (node) => {
      node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      node.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    };
    if (el.tagName === "SELECT") {
      const t = String(value).trim();
      let matched = null;
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        if ((opt.text || "").trim() === t || (opt.value || "").trim() === t) { matched = opt; break; }
      }
      if (!matched) {
        return { ok: false, readBack: (el.value || ""), detail: "no option matched the value by text or value attribute" };
      }
      setNative(el, matched.value);
      fire(el);
      const selText = (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : el.value) || "";
      return { ok: el.value === matched.value, readBack: selText.trim(), detail: "matched select option" };
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const prev = el.value;
      setNative(el, value);
      if (el._valueTracker && typeof el._valueTracker.setValue === "function") {
        try { el._valueTracker.setValue(prev === value ? "" : prev); } catch (e) {}
      }
      fire(el);
      return { ok: el.value === value, readBack: el.value, detail: "native setter plus input and change" };
    }
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      const readBack = (el.textContent || "").trim();
      return { ok: readBack === String(value).trim(), readBack: readBack, detail: "contenteditable text write" };
    }
    return { ok: false, readBack: "", detail: "element is not a fillable control: " + (el.tagName || "").toLowerCase() };
  })()`;
}

export async function setFieldValue(
  input: SetFieldValueInput,
  ctx: ToolContext
): Promise<FieldActionResult> {
  const parsed = SetFieldValueInputSchema.parse(input);
  assertSetFieldValueAllowed(parsed, ctx);
  if (ctx.page === undefined || ctx.page === null) {
    throw new AgentFillNotImplementedError("setFieldValue");
  }
  if (!isPageLike(ctx.page)) {
    return {
      ok: false,
      readBack: "",
      detail: "page handle did not expose an evaluate method",
    };
  }
  return runFieldActionScript(
    ctx.page,
    setFieldValueScript(parsed.fieldId, parsed.value)
  );
}

/**
 * JOB-281: `selectDropdown` now consults the widget adapter registry when a
 * page handle is present on the tool context, so the framework state
 * commit for SR screening dropdowns ships ahead of sub ticket E's visible
 * click implementation. Order once E lands:
 *
 *   1. Sub ticket E performs the existing visible `[role=option]` click
 *      and reads back the widget's textContent to prove the picker
 *      accepted the choice.
 *   2. This handler then invokes `commitFrameworkState`, which dispatches
 *      the framework state events on any adapter that matches the widget.
 *   3. The returned `CommitResult` names the adapter that fired (or that
 *      none matched) so the run trace can prove which path did the work.
 *
 * Until sub ticket E lands, step 1 is absent and this handler exercises
 * only the adapter path when a page is supplied. When no page is on the
 * context, the handler preserves the pre E scaffold behavior and throws
 * `AgentFillNotImplementedError`, which is the shape the routing tests
 * already assert against.
 */
export async function selectDropdown(
  input: SelectDropdownInput,
  ctx: ToolContext
): Promise<CommitResult> {
  const parsed = SelectDropdownInputSchema.parse(input);
  if (ctx.page === undefined || ctx.page === null) {
    throw new AgentFillNotImplementedError("selectDropdown");
  }
  return commitFrameworkState(ctx.page, parsed.fieldId, parsed.optionValue);
}

/**
 * The in page IIFE `toggleCheckbox` runs. Prefers a real `click()` because
 * that is the one activation every framework observes natively (it fires
 * `click`, `input`, and `change` and runs the default toggle). Only when
 * the click provably did not move a native checkbox (a canceled default,
 * an overlay eating the activation) does the script fall back to writing
 * `checked` through the prototype descriptor and dispatching the events a
 * real toggle produces. ARIA checkboxes get the click and are then judged
 * by their own `aria-checked`; there is no property to force on those, so
 * a widget that ignores the click reports `ok: false` honestly.
 */
function toggleCheckboxScript(fieldSelector: string, checked: boolean): string {
  return `(() => {
    const sel = ${jsLiteral(fieldSelector)};
    const desired = ${checked ? "true" : "false"};
    const el = document.querySelector(sel);
    if (!el) return { ok: false, readBack: "", detail: "selector did not resolve" };
    const isNativeCheckbox = (n) => n.tagName === "INPUT" && ((n.getAttribute("type") || "").toLowerCase() === "checkbox");
    const isAriaCheckbox = (n) => n.getAttribute && n.getAttribute("role") === "checkbox";
    let box = null;
    if (isNativeCheckbox(el) || isAriaCheckbox(el)) box = el;
    else if (el.querySelector) box = el.querySelector('input[type="checkbox"], [role="checkbox"]');
    if (!box) return { ok: false, readBack: "", detail: "no checkbox found at or under the selector" };
    const read = () => isNativeCheckbox(box) ? box.checked === true : box.getAttribute("aria-checked") === "true";
    const asWord = (v) => (v ? "checked" : "unchecked");
    if (read() === desired) {
      return { ok: true, readBack: asWord(desired), detail: "already in the requested state" };
    }
    try { box.click(); } catch (e) {}
    if (read() !== desired && isNativeCheckbox(box)) {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
      if (desc && desc.set) desc.set.call(box, desired); else box.checked = desired;
      box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      box.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }
    const after = read();
    return {
      ok: after === desired,
      readBack: asWord(after),
      detail: after === desired ? "toggled" : "click and property write both left the control unmoved",
    };
  })()`;
}

export async function toggleCheckbox(
  input: ToggleCheckboxInput,
  ctx: ToolContext
): Promise<FieldActionResult> {
  const parsed = ToggleCheckboxInputSchema.parse(input);
  if (ctx.page === undefined || ctx.page === null) {
    throw new AgentFillNotImplementedError("toggleCheckbox");
  }
  if (!isPageLike(ctx.page)) {
    return {
      ok: false,
      readBack: "",
      detail: "page handle did not expose an evaluate method",
    };
  }
  return runFieldActionScript(
    ctx.page,
    toggleCheckboxScript(parsed.fieldId, parsed.checked)
  );
}

/**
 * The in page IIFE `addRepeatingSectionEntry` runs. Finds the pressable
 * inside the section whose accessible text reads as an add control and
 * clicks it. The vocabulary is deliberately narrow (add, another, a bare
 * plus sign) because the section also contains edit, delete, and expand
 * controls whose labels must never qualify, and a wrong click here mounts
 * or destroys real form state. When nothing qualifies the script reports
 * the labels it saw so the trace shows what the section actually offered.
 */
function addRepeatingSectionEntryScript(sectionSelector: string): string {
  return `(() => {
    const sel = ${jsLiteral(sectionSelector)};
    const root = document.querySelector(sel);
    if (!root) return { ok: false, readBack: "", detail: "selector did not resolve" };
    const addRe = /(\\badd\\b|\\banother\\b|^\\s*\\+\\s*$)/i;
    const labelOf = (n) => (((n.getAttribute && n.getAttribute("aria-label")) || n.textContent || "").replace(/\\s+/g, " ").trim());
    const pressables = root.querySelectorAll('button, [role="button"], a');
    const candidates = [];
    let target = null;
    for (const p of pressables) {
      const label = labelOf(p);
      if (!label) continue;
      candidates.push(label);
      if (!target && addRe.test(label)) target = { node: p, label: label };
    }
    if (!target) {
      return {
        ok: false,
        readBack: "",
        detail: "no add control found among: " + (candidates.slice(0, 8).join(" | ") || "no labeled pressables"),
      };
    }
    try {
      target.node.click();
    } catch (e) {
      return { ok: false, readBack: target.label, detail: "click threw: " + String(e && e.message ? e.message : e) };
    }
    return { ok: true, readBack: target.label, detail: 'clicked "' + target.label + '"' };
  })()`;
}

export async function addRepeatingSectionEntry(
  input: AddRepeatingSectionEntryInput,
  ctx: ToolContext
): Promise<FieldActionResult> {
  const parsed = AddRepeatingSectionEntryInputSchema.parse(input);
  if (ctx.page === undefined || ctx.page === null) {
    throw new AgentFillNotImplementedError("addRepeatingSectionEntry");
  }
  if (!isPageLike(ctx.page)) {
    return {
      ok: false,
      readBack: "",
      detail: "page handle did not expose an evaluate method",
    };
  }
  return runFieldActionScript(
    ctx.page,
    addRepeatingSectionEntryScript(parsed.sectionId)
  );
}

/**
 * `uploadFile` needs two capabilities beyond the evaluate handle: the run
 * wiring's `materializeUpload` (bucket path to local file) and a file input
 * API on the page handle (Playwright's `setInputFiles`, direct or through
 * `locator`). Either one absent means the wiring this handler belongs to
 * has not been attached, and the scaffold contract (throw
 * `AgentFillNotImplementedError`) is the honest report of that. A page
 * that is present but exposes neither file API is a real runtime failure
 * and reports `ok: false` instead.
 */
export async function uploadFile(
  input: UploadFileInput,
  ctx: ToolContext
): Promise<FieldActionResult> {
  const parsed = UploadFileInputSchema.parse(input);
  if (ctx.page === undefined || ctx.page === null) {
    throw new AgentFillNotImplementedError("uploadFile");
  }
  if (typeof ctx.materializeUpload !== "function") {
    throw new AgentFillNotImplementedError("uploadFile");
  }
  const localPath = await ctx.materializeUpload(parsed.storagePath);
  const page = ctx.page as PageWithFileInput;
  try {
    if (typeof page.setInputFiles === "function") {
      await page.setInputFiles(parsed.fieldId, localPath);
    } else if (typeof page.locator === "function") {
      await page.locator(parsed.fieldId).setInputFiles(localPath);
    } else {
      return {
        ok: false,
        readBack: "",
        detail: "page handle exposes no file input API",
      };
    }
  } catch (error) {
    return {
      ok: false,
      readBack: "",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ok: true,
    readBack: localPath,
    detail: `set files on ${parsed.fieldId} from ${parsed.storagePath}`,
  };
}

/**
 * HARD STOP 9's safety valve. Records that a field cannot be answered from
 * the fact catalog and hands the record to the loop wiring, which decides
 * whether the run escalates or skips. Never touches the page: the field
 * stays exactly as it was, because writing anything at all here is the
 * fabrication this tool exists to prevent.
 */
export async function markFieldUnanswerable(
  input: MarkFieldUnanswerableInput,
  ctx: ToolContext
): Promise<UnanswerableFieldRecord> {
  const parsed = MarkFieldUnanswerableInputSchema.parse(input);
  if (typeof ctx.onFieldUnanswerable !== "function") {
    throw new AgentFillNotImplementedError("markFieldUnanswerable");
  }
  const record: UnanswerableFieldRecord = {
    fieldId: parsed.fieldId,
    label: parsed.label,
    reason: parsed.reason,
  };
  ctx.onFieldUnanswerable(record);
  return record;
}

/**
 * Signals the loop that the agent wants the deterministic verify pass to
 * run before any submit control is touched. Like `markFieldUnanswerable`
 * this is a loop signal, not a page action, and it fails closed when the
 * wiring hook is absent.
 */
export async function requestVerifyBeforeSubmit(
  input: RequestVerifyBeforeSubmitInput,
  ctx: ToolContext
): Promise<VerifyRequestRecord> {
  const parsed = RequestVerifyBeforeSubmitInputSchema.parse(input);
  if (typeof ctx.onVerifyRequested !== "function") {
    throw new AgentFillNotImplementedError("requestVerifyBeforeSubmit");
  }
  const record: VerifyRequestRecord = { note: parsed.note };
  ctx.onVerifyRequested(record);
  return record;
}
