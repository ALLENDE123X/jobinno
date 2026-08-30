/**
 * JOB-279 (sub ticket B of #276): the snapshot module. Builds the small
 * structured readback the agent loop hands the LLM instead of the raw a11y
 * tree.
 *
 * Why this exists. JOB-SPIKE v9 spent $9.83 on one Bertelsmann run because
 * the raw SR OneClick accessibility tree (~83K nodes) was serialized and
 * re-sent on every turn: ~92K input tokens per turn multiplied by 84 turns.
 * Snapshot dieting is the single load bearing cost fix on the whole pivot;
 * without it the pivot's cost model does not work. This file is the
 * concrete pass that turns a raw a11y tree into a compact structured
 * snapshot on the first call, and into a diff of only the changed fields
 * on every call after.
 *
 * What lands here at sub ticket B is the pure functions plus the byte
 * budget. Sub ticket E (Stagehand wiring) plugs the real Playwright page
 * into `AgentSnapshotSource`; sub ticket F (verify pass) consumes the diff.
 * This module deliberately never imports Stagehand or Playwright at all,
 * so the module graph does not pull them into the agent's test suite.
 */

import { createHash } from "node:crypto";

import type {
  AgentSnapshot,
  AgentSnapshotDiff,
  FieldKind,
  FieldNode,
  FieldValidationState,
  SectionHandle,
} from "@/lib/agent/snapshot-types";

/**
 * Byte budget for a single full snapshot payload. Set at ~60 000 bytes,
 * which sits around 15 000 tokens on the tokenizer families the agent will
 * use, and is intentionally an order of magnitude under the raw
 * accessibility trees the spike measured (~330K bytes for SR OneClick).
 *
 * The budget is enforced, not advisory: `buildFullSnapshot` throws
 * `SnapshotBudgetExceededError` when a serialized snapshot goes over, so an
 * agent cannot silently ship an over budget payload the way the spike did.
 * Sub ticket E is expected to react to the throw by requesting a smaller
 * region rather than by raising the budget.
 */
export const SNAPSHOT_MAX_BYTES = 60_000;

/**
 * Thrown by `buildFullSnapshot` when the serialized snapshot exceeds
 * `SNAPSHOT_MAX_BYTES`. A distinct class so the agent loop can tell an over
 * budget snapshot apart from an unrelated parse or runtime failure, and
 * choose to fall back to a smaller region rather than aborting the run.
 */
export class SnapshotBudgetExceededError extends Error {
  readonly byteLength: number;
  readonly limit: number;
  constructor(byteLength: number, limit: number) {
    super(
      `Agent snapshot exceeded ${limit} byte budget (was ${byteLength} bytes). ` +
        `Fall back to a smaller region or a diff pass rather than raising the ` +
        `limit; the raw a11y tree cost problem this budget solves does not go ` +
        `away by moving the number.`
    );
    this.name = "SnapshotBudgetExceededError";
    this.byteLength = byteLength;
    this.limit = limit;
  }
}

/**
 * One node in the raw accessibility tree the snapshot parser reads. Kept
 * intentionally close to the shape Playwright/Stagehand's own accessibility
 * snapshot returns, so sub ticket E can hand the shape straight through
 * with minimal adaptation. The parser tolerates missing fields on every
 * node because real a11y trees are inconsistent about which attributes
 * appear on which roles.
 */
export interface RawAccessibilityNode {
  role: string;
  name?: string;
  value?: string | number | boolean | null;
  required?: boolean;
  /** Truthy means the form flagged this field invalid; a string carries the message. */
  invalid?: boolean | string;
  /** Stable ref from the a11y layer, when present. */
  ref?: string;
  /** For select and multiselect nodes: the option labels. */
  options?: string[];
  children?: RawAccessibilityNode[];
}

/**
 * The read only surface the snapshot module needs from the page. A minimal
 * interface rather than a Playwright import so tests can pass fixtures
 * directly, and so sub ticket E can decide whether Stagehand's page adapts
 * to this shape or is wrapped by a thin function that does.
 */
export interface AgentSnapshotSource {
  url: () => string | Promise<string>;
  title: () => string | Promise<string>;
  captureAccessibilityTree: () =>
    | RawAccessibilityNode
    | Promise<RawAccessibilityNode>;
}

/**
 * Clock override so tests can pin `capturedAt` without patching global
 * `Date.now`. Kept as a plain optional parameter rather than a module level
 * setter so a rogue test cannot leak state into a sibling test.
 */
export interface SnapshotOptions {
  now?: () => number;
  /** Override the byte budget for a specific call; defaults to `SNAPSHOT_MAX_BYTES`. */
  maxBytes?: number;
}

/**
 * The set of a11y roles that map to structured field kinds. Deliberately a
 * `Map` rather than a switch so the mapping is inspectable and testable,
 * and so adding a new role is a one line data change rather than a code
 * path change. Roles not in the map fall through to `unknown` and still
 * appear in the snapshot (see `FieldKindSchema` docs for why).
 */
const ROLE_TO_FIELD_KIND: ReadonlyMap<string, FieldKind> = new Map<
  string,
  FieldKind
>([
  ["textbox", "text"],
  ["searchbox", "text"],
  ["combobox", "select"],
  ["listbox", "select"],
  ["spinbutton", "number"],
  ["slider", "number"],
  ["checkbox", "checkbox"],
  ["radio", "radio"],
  ["radiogroup", "radio"],
  ["button", "button"],
  ["link", "button"],
  ["group", "section"],
  ["region", "section"],
  ["form", "section"],
  ["dialog", "modal"],
  ["alertdialog", "modal"],
]);

/**
 * Refine a `textbox` node to a more specific text kind when the label hints
 * at one. Deliberately conservative and word bounded: unanchored substring
 * matches misclassified real labels ("Candidate name" landed as `date` via
 * `/date/`, "Automobile insurance" as `tel` via `/mobile/`, "Hyperlink" as
 * `url` via `/link/`), which one layer up would let the agent write a
 * fabricated ISO date into a name field. Every phrase below is anchored
 * with `\b` so only whole words match, and each matched vocabulary is
 * narrow enough to stay honest about what the label actually is.
 */
function refineTextKind(label: string, defaultKind: FieldKind): FieldKind {
  const lower = label.toLowerCase();
  if (/\b(e[- ]?mail|email)\b/.test(lower)) return "email";
  if (/\b(phone|mobile|telephone|cell)\b/.test(lower)) return "tel";
  if (/\b(url|website|homepage)\b/.test(lower)) return "url";
  if (/\b(date|birthday|birthdate|dob)\b/.test(lower)) return "date";
  return defaultKind;
}

/**
 * Coerces the raw a11y `value` field to the string representation the
 * snapshot stores. `null` and `undefined` collapse to `null` so an empty
 * field and an unfilled field diff distinctly.
 */
function normalizeValue(
  value: string | number | boolean | null | undefined
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return String(value);
}

function normalizeValidation(
  invalid: boolean | string | undefined
): FieldValidationState {
  if (invalid === undefined) return { kind: "unknown" };
  if (invalid === false) return { kind: "valid" };
  if (invalid === true) return { kind: "invalid", message: "invalid" };
  const trimmed = invalid.trim();
  if (trimmed.length === 0) return { kind: "invalid", message: "invalid" };
  return { kind: "invalid", message: trimmed };
}

/**
 * Compact SHA-256 hash used to fingerprint stable regions and option lists.
 * Truncated to 16 hex chars: a 64 bit prefix is more than enough to detect
 * change on a form page without paying the payload cost of a full digest.
 * Never used as a security primitive; if the truncation ever becomes one,
 * revisit here.
 */
function hashRegion(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Static a11y roles the snapshot walk drops as noise. These carry no field
 * state the agent needs turn to turn, and were the largest single share of
 * the raw payload on JOB-SPIKE v9 (~40% of Bertelsmann's 92K token pass).
 * Kept explicit rather than derived so the diff on this list is auditable.
 */
const STATIC_ROLES_TO_DROP: ReadonlySet<string> = new Set([
  "paragraph",
  "text",
  "heading",
  "img",
  "image",
  "presentation",
  "none",
  "separator",
]);

interface WalkOutput {
  fields: FieldNode[];
  sections: SectionHandle[];
}

/**
 * Strip the mutable state (`value`, `invalid`, `required`) off a raw a11y
 * subtree so that a section's hash captures only its static shape. The
 * previous version hashed the raw subtree, which folded every descendant's
 * typed value into the section fingerprint, so typing one character into
 * any field flipped every ancestor section's hash and pushed the region
 * back into `sections.changed`. That defeats the whole point of hashing:
 * the loop's read of `sections.changed` was supposed to prove a region did
 * not change without re-sending it, and it was proving the opposite. This
 * helper keeps the structural shape the loop reasons about (roles, labels,
 * options list, ref, and child layout) and drops the fields that a fill or
 * a validation flip would move.
 */
function staticSubtreeForHash(node: RawAccessibilityNode): unknown {
  return {
    role: node.role,
    name: node.name,
    ref: node.ref,
    options: node.options,
    children: (node.children ?? []).map(staticSubtreeForHash),
  };
}

/**
 * Compute the ref a child should carry, using the child's own `ref` if the
 * a11y layer gave it one and otherwise synthesizing a per-parent, per
 * (role, label) index. The synthesized shape is `synth_<parentRef>_<role>
 * _<labelHash>_<index>`, which keeps two properties the previous
 * monotonic counter did not:
 *
 *  - A refless node mounting or unmounting elsewhere in the tree does not
 *    renumber unrelated nodes. Only the (parent, role, label) sibling
 *    group that gains or loses a node sees an index shift, and even then
 *    only for that exact group.
 *  - Two refless children of different parents cannot collide, because
 *    `parentRef` is baked into the id.
 *
 * The label goes through a 8 char hash so a very long or noisy label does
 * not blow up the ref length, and so a label containing special chars does
 * not need escaping. The parent's ref is used verbatim (already
 * constrained by whatever bounded the parent's own ref).
 */
function resolveRef(
  node: RawAccessibilityNode,
  parentRef: string,
  counts: Map<string, number>
): string {
  if (node.ref && node.ref.length > 0) return node.ref;
  const label = (node.name ?? "").trim();
  const key = `${node.role}::${label}`;
  const idx = counts.get(key) ?? 0;
  counts.set(key, idx + 1);
  const labelHash = label.length > 0 ? hashRegion(label).slice(0, 8) : "unlabeled";
  return `synth_${parentRef}_${node.role}_${labelHash}_${idx}`;
}

/**
 * Walk one node (given its parent computed ref) and recurse into children
 * using a fresh per parent counts map, so refless siblings only compete
 * for indices among their own (role, label) group in their own parent.
 */
function walkNode(
  node: RawAccessibilityNode,
  ref: string,
  parentSectionRef: string | null,
  out: WalkOutput
): void {
  const role = node.role;
  if (STATIC_ROLES_TO_DROP.has(role)) {
    // Walk children even for a dropped node: a heading can wrap a form
    // section on some boards and the interesting bits sit under it. The
    // dropped node's ref is still used as their parent context so that a
    // shift elsewhere in the tree stays local.
    walkChildren(node.children ?? [], ref, parentSectionRef, out);
    return;
  }

  const label = (node.name ?? "").trim();
  const mappedKind = ROLE_TO_FIELD_KIND.get(role) ?? "unknown";
  const kind: FieldKind =
    mappedKind === "text" ? refineTextKind(label, mappedKind) : mappedKind;

  if (kind === "section" || kind === "modal") {
    // A section is represented once by a `FieldNode` (so the loop can address
    // it by ref) and once as a `SectionHandle` in the hashed region list
    // (so a diff can prove the region did not change without re-sending it).
    // The hash covers only the static subtree shape: see
    // `staticSubtreeForHash` for why descendant `value` and `invalid` are
    // stripped before hashing.
    const sectionHash = hashRegion(
      JSON.stringify({
        role,
        label,
        children: (node.children ?? []).map(staticSubtreeForHash),
      })
    );
    out.fields.push({
      ref,
      kind,
      label,
      value: null,
      required: node.required ?? false,
      validation: { kind: "unknown" },
      sectionRef: parentSectionRef,
      optionSetHash: null,
    });
    out.sections.push({ ref, label, hash: sectionHash });
    walkChildren(node.children ?? [], ref, ref, out);
    return;
  }

  const value = normalizeValue(node.value);
  const validation = normalizeValidation(node.invalid);
  const optionSetHash =
    node.options && node.options.length > 0
      ? hashRegion(JSON.stringify(node.options))
      : null;

  out.fields.push({
    ref,
    kind,
    label,
    value,
    required: node.required ?? false,
    validation,
    sectionRef: parentSectionRef,
    optionSetHash,
  });

  walkChildren(node.children ?? [], ref, parentSectionRef, out);
}

function walkChildren(
  children: RawAccessibilityNode[],
  parentRef: string,
  parentSectionRef: string | null,
  out: WalkOutput
): void {
  const counts = new Map<string, number>();
  for (const child of children) {
    const childRef = resolveRef(child, parentRef, counts);
    walkNode(child, childRef, parentSectionRef, out);
  }
}

/**
 * Build a full snapshot from the page. Parses the raw a11y tree into the
 * structured shape, hashes stable regions, and enforces the byte budget.
 *
 * The byte budget is enforced against the JSON serialization of the
 * snapshot itself, not against the raw a11y tree, because it is the
 * serialization that ships to the LLM. A snapshot the parser could have
 * produced but that would not fit on the wire is not a snapshot the loop
 * can use.
 */
export async function buildFullSnapshot(
  page: AgentSnapshotSource,
  options: SnapshotOptions = {}
): Promise<AgentSnapshot> {
  const snapshot = await captureSnapshot(page, options);
  const limit = options.maxBytes ?? SNAPSHOT_MAX_BYTES;
  enforceByteBudget(JSON.stringify(snapshot), limit);
  return snapshot;
}

/**
 * Capture a snapshot without checking the byte budget. Used by
 * `buildDiffSnapshot`, where the intermediate full snapshot is a compute
 * step that never ships, so applying the full snapshot budget to it would
 * throw on the exact pages the diff exists to shrink (SR OneClick,
 * Workday, JOB-SPIKE v9's Bertelsmann run). The diff itself is measured
 * against the budget one layer up.
 */
async function captureSnapshot(
  page: AgentSnapshotSource,
  options: SnapshotOptions
): Promise<AgentSnapshot> {
  const now = options.now ?? Date.now;

  const [url, title, tree] = await Promise.all([
    Promise.resolve(page.url()),
    Promise.resolve(page.title()),
    Promise.resolve(page.captureAccessibilityTree()),
  ]);

  const out: WalkOutput = { fields: [], sections: [] };
  const rootRef = resolveRef(tree, "root", new Map());
  walkNode(tree, rootRef, null, out);

  return {
    url,
    title,
    fields: out.fields,
    sections: out.sections,
    // `capturedAt` is `z.number().int().nonnegative()` on the canonical
    // schema. A caller wiring `performance.now()` in as `options.now`
    // would otherwise produce a fractional value the schema rejects at
    // any downstream boundary; truncate at the assignment site so the
    // guarantee is local to this file rather than a caller convention.
    capturedAt: Math.trunc(now()),
  };
}

function enforceByteBudget(serialized: string, limit: number): void {
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > limit) {
    throw new SnapshotBudgetExceededError(byteLength, limit);
  }
}

/**
 * Deep equality on the fields that matter to the diff. Compares the shape
 * a caller would actually look at, not the whole object, so a change in
 * `optionSetHash` alone (options list rewritten but no value change) does
 * not flap the diff every turn. `optionSetHash` still lives on the field
 * so the LLM can decide whether to request the option list; the diff just
 * does not treat it as a value change.
 */
function fieldValueEqual(a: FieldNode, b: FieldNode): boolean {
  if (a.value !== b.value) return false;
  if (a.required !== b.required) return false;
  if (a.validation.kind !== b.validation.kind) return false;
  if (
    a.validation.kind === "invalid" &&
    b.validation.kind === "invalid" &&
    a.validation.message !== b.validation.message
  ) {
    return false;
  }
  if (a.label !== b.label) return false;
  if (a.kind !== b.kind) return false;
  if (a.sectionRef !== b.sectionRef) return false;
  return true;
}

/**
 * Build a diff snapshot from the previous full snapshot and the current
 * page. The diff is what the loop sends the LLM on every turn after the
 * first; it typically weighs in at a few hundred bytes even on Workday.
 *
 * Implementation: capture a fresh full snapshot without applying the byte
 * budget to it (that intermediate never ships and applying the full
 * snapshot budget to it would throw on the exact pages the diff exists to
 * shrink), diff both field lists by ref, then enforce the budget against
 * the serialized diff payload itself. This deliberately does not try to
 * be clever about detecting reflow: a ref moving between sections shows
 * up as an updated field with a new `sectionRef`, which is exactly what
 * the agent needs to know.
 */
export async function buildDiffSnapshot(
  prev: AgentSnapshot,
  page: AgentSnapshotSource,
  options: SnapshotOptions = {}
): Promise<AgentSnapshotDiff> {
  const current = await captureSnapshot(page, options);

  const prevByRef = new Map(prev.fields.map((f) => [f.ref, f]));
  const currByRef = new Map(current.fields.map((f) => [f.ref, f]));

  const added: FieldNode[] = [];
  const removed: string[] = [];
  const updated: AgentSnapshotDiff["updated"] = [];

  for (const [ref, field] of currByRef) {
    const before = prevByRef.get(ref);
    if (!before) {
      added.push(field);
      continue;
    }
    if (!fieldValueEqual(before, field)) {
      updated.push({ ref, before, after: field });
    }
  }
  for (const ref of prevByRef.keys()) {
    if (!currByRef.has(ref)) removed.push(ref);
  }

  const prevSectionByRef = new Map(prev.sections.map((s) => [s.ref, s]));
  const currSectionByRef = new Map(current.sections.map((s) => [s.ref, s]));
  const sectionsAdded: SectionHandle[] = [];
  const sectionsRemoved: string[] = [];
  const sectionsChanged: SectionHandle[] = [];
  for (const [ref, section] of currSectionByRef) {
    const before = prevSectionByRef.get(ref);
    if (!before) {
      sectionsAdded.push(section);
      continue;
    }
    if (before.hash !== section.hash) {
      sectionsChanged.push(section);
    }
  }
  for (const ref of prevSectionByRef.keys()) {
    if (!currSectionByRef.has(ref)) sectionsRemoved.push(ref);
  }

  const diff: AgentSnapshotDiff = {
    url: current.url,
    title: current.title,
    added,
    removed,
    updated,
    sections: {
      added: sectionsAdded,
      removed: sectionsRemoved,
      changed: sectionsChanged,
    },
    capturedAt: current.capturedAt,
  };

  const limit = options.maxBytes ?? SNAPSHOT_MAX_BYTES;
  enforceByteBudget(JSON.stringify(diff), limit);
  return diff;
}
