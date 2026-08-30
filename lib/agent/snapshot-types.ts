/**
 * JOB-279 (sub ticket B of #276): the type shapes the snapshot module and
 * every downstream sub ticket read from and write to.
 *
 * Kept in its own file so that sub tickets C..H (agent loop, verify pass,
 * cost telemetry, Stagehand wiring) can `import type` from here without
 * pulling in the runtime code of `readback.ts`. The Zod schemas ride along
 * on the same file rather than in a separate `snapshot-schema.ts` because
 * every schema below is the one canonical validator for its type, and
 * splitting them would just leave two files that have to move together.
 *
 * The shape ships live rather than as a placeholder: JOB-SPIKE v9 spent
 * $9.83 on one Bertelsmann run because the raw 83K node accessibility tree
 * was re-sent every turn. The whole pivot's cost model rests on the loop
 * sending a small structured snapshot on turn one and a diff on every turn
 * after, which is exactly what these types describe.
 */

import { z } from "zod";

/**
 * The kinds of controls the snapshot classifies an accessibility node as. A
 * closed set so the agent loop can switch on it, and so a diff can compare
 * two snapshots without having to reason about arbitrary role strings from
 * the raw a11y tree.
 *
 * `section` and `modal` are containers rather than fields; they show up in
 * the field list because a repeating section entry (Experience, Education)
 * appearing or disappearing is one of the two moves the agent has to notice
 * turn to turn, alongside a value change.
 *
 * `unknown` is a real member rather than a bug catcher: SR OneClick and
 * Workday emit custom roles the parser cannot map cleanly, and the agent is
 * still allowed to try to fill them from the label. Dropping them from the
 * snapshot would hide a required field.
 *
 * The set is deliberately narrow to what the parser can actually emit today.
 * `textarea`, `multiselect`, and `file` are not in it: the raw a11y node the
 * parser reads carries no `multiline`, `multiple`, or input `type` attribute
 * the walk could switch on, so a textarea collapses to `text` and a file
 * input to `unknown` at parse time. Adding those kinds without a producer to
 * emit them would lock the shape in this sub ticket and force a rework in
 * sub ticket E; sub ticket E can grow the set when it grows the parser.
 */
export const FieldKindSchema = z.enum([
  "text",
  "email",
  "url",
  "tel",
  "number",
  "select",
  "checkbox",
  "radio",
  "date",
  "button",
  "section",
  "modal",
  "unknown",
]);
export type FieldKind = z.infer<typeof FieldKindSchema>;

/**
 * Whether the form itself flagged the field as valid, invalid, or the
 * snapshot could not tell. Kept as a tagged union rather than a nullable
 * string so that the invalid case always carries the message the form
 * showed, without inviting a caller to write `if (validation)` and treat
 * "unknown" as a truthy passing state.
 */
export const FieldValidationStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("valid") }),
  z.object({ kind: z.literal("invalid"), message: z.string().min(1) }),
  z.object({ kind: z.literal("unknown") }),
]);
export type FieldValidationState = z.infer<typeof FieldValidationStateSchema>;

/**
 * One row in the snapshot's field list. `ref` is the stable identifier the
 * agent uses to address the field on a `setFieldValue` (or similar) call;
 * the readback parser copies it from the a11y tree's own ref when one is
 * present and synthesizes a stable id from the role plus label plus index
 * when one is not.
 *
 * `value` is the value the form currently holds, normalized to a string so
 * that a number field and a text field diff the same way. `null` means the
 * field has no value yet; empty string means the form holds an empty string
 * (a real distinction on Workday where clearing a field is different from
 * never having filled it).
 *
 * `optionSetHash`, when present, lets a select's option list stay out of
 * the diff on subsequent turns as long as the hash matches. That is the
 * single largest single win on cost per turn on Workday, where a "Country"
 * select emits 250 options every turn if the payload includes them.
 */
export const FieldNodeSchema = z.object({
  ref: z.string().min(1),
  kind: FieldKindSchema,
  label: z.string(),
  value: z.string().nullable(),
  required: z.boolean(),
  validation: FieldValidationStateSchema,
  sectionRef: z.string().min(1).nullable(),
  optionSetHash: z.string().min(1).nullable(),
});
export type FieldNode = z.infer<typeof FieldNodeSchema>;

/**
 * A hashed handle on a stable region of the page. The agent does not need
 * the text of the "About this role" section on every turn; the hash lets a
 * diff prove the region did not change without re-sending it. A change of
 * hash between snapshots surfaces the section back into the diff's
 * `sections.changed` list, and the loop can then request the region in
 * full on the next turn if it needs to read it.
 */
export const SectionHandleSchema = z.object({
  ref: z.string().min(1),
  label: z.string(),
  hash: z.string().min(1),
});
export type SectionHandle = z.infer<typeof SectionHandleSchema>;

/**
 * A full snapshot. Sent to the LLM on the first turn of a run, and never
 * again for the same page unless the loop asks for one explicitly (for
 * example after a hard navigation the diff cannot reconcile against).
 */
export const AgentSnapshotSchema = z
  .object({
    url: z.string().min(1),
    title: z.string(),
    fields: z.array(FieldNodeSchema),
    sections: z.array(SectionHandleSchema),
    capturedAt: z.number().int().nonnegative(),
  })
  // Cross check every `sectionRef` against the sections list, so a
  // snapshot whose fields point at a section that is not in `sections[]`
  // fails at the parse boundary rather than deep in the agent loop.
  .refine(
    (snap) => {
      const sectionRefs = new Set(snap.sections.map((s) => s.ref));
      for (const field of snap.fields) {
        if (field.sectionRef !== null && !sectionRefs.has(field.sectionRef)) {
          return false;
        }
      }
      return true;
    },
    { message: "every field.sectionRef must reference a section in sections[]" }
  );
export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;

/**
 * A diff snapshot. Sent to the LLM on every turn after the first. The three
 * field level lists describe changed field state, not the entire page:
 *
 *  - `added` is the full `FieldNode` for every field that was absent from
 *    the previous snapshot. New modal fields land here.
 *  - `removed` is the list of refs that were present in the previous
 *    snapshot and are now gone. A closed picker or dismissed modal lands
 *    here.
 *  - `updated` is one entry per field whose `value`, `required`, or
 *    `validation` changed. `before` and `after` are both full `FieldNode`
 *    rows so the LLM can read the whole change without having to
 *    reconstruct the previous state from history.
 *
 * `sections` mirrors the same three moves at the section container level,
 * so a repeating section entry appearing or disappearing shows up once at
 * the section level and once as the fields under it, and the loop can
 * choose which layer to read.
 */
export const AgentSnapshotDiffSchema = z.object({
  url: z.string().min(1),
  title: z.string(),
  added: z.array(FieldNodeSchema),
  removed: z.array(z.string().min(1)),
  updated: z.array(
    z
      .object({
        ref: z.string().min(1),
        before: FieldNodeSchema,
        after: FieldNodeSchema,
      })
      // A no op update (`before` structurally equal to `after`) has no
      // meaning to the agent and is filtered out by the builder. Enforce
      // the same rule at the schema boundary so a hand rolled diff cannot
      // slip a stale entry past it either.
      .refine((u) => JSON.stringify(u.before) !== JSON.stringify(u.after), {
        message: "updated entries must have a structurally different before and after",
      })
  ),
  sections: z.object({
    added: z.array(SectionHandleSchema),
    removed: z.array(z.string().min(1)),
    changed: z.array(SectionHandleSchema),
  }),
  capturedAt: z.number().int().nonnegative(),
});
export type AgentSnapshotDiff = z.infer<typeof AgentSnapshotDiffSchema>;
