/**
 * JOB-280 (sub ticket C of #276). The deterministic prefill pass. Runs after
 * the page opens and before the agent loop takes a turn, and fills every
 * identity field the label map recognises straight from the fact catalog.
 *
 * Why this exists. JOB-SPIKE v9 measured a Bertelsmann run at $9.83 with an
 * 84 turn loop, and the profiler read on that run showed the first ~40% of
 * turns were the agent typing identity fields the label map already knew.
 * Doing that work deterministically before the loop starts collapses those
 * turns entirely: v9's rerun with a prefill pass in front hit 5/5 identity
 * fields cleanly and cut remaining loop work by roughly 40%. This ticket
 * ships that pass so the agent loop starts from the smallest possible
 * unresolved surface.
 *
 * What lands here at sub ticket C is the pure classifier plus the walk that
 * consumes an `AgentSnapshot` from `readback.ts` and calls `setFieldValue`
 * on a page that carries one. Sub ticket E wires the real Playwright page
 * into `PrefillPage`; sub ticket F reads the returned `PrefillReport` from
 * the trace log. This module deliberately never imports Stagehand or
 * Playwright, so the module graph does not pull them into the agent's
 * test suite.
 *
 * HARD STOP 9 keeps this narrow. Prefill only writes values that a fact
 * catalog entry named at a stable slot path holds verbatim. It composes
 * nothing, and it never widens an identity slot into a free text or an
 * education or an employment field: the `EXCLUDED_LABEL_PATTERNS` guard
 * refuses to write to a control whose label reads as one of those, even
 * when the label also happens to name an identity slot. The exclusion is
 * defensive; the include list never lists those slots to begin with.
 *
 * The inverted guard. The earlier draft of this ticket (closed PR #288)
 * tried to enumerate every legal shape for the current address while
 * rejecting every birth, citizenship, and nationality variant, and each
 * review round surfaced one more label the exclusion regex missed. That
 * enumeration is the wrong architecture, so `currentCountry`, `currentState`
 * and `postalCode` now classify differently. `currentCountry` and
 * `currentState` only classify when the label carries a positive current
 * location signal (one of current, residence, residing, live, address,
 * mailing, home, postal); a bare "Country" or "State" and every "Country of
 * birth", "Citizenship", "Native land", "Province of birth" shape return
 * `null` because none of them name a current location. This turns the risk
 * shape from "silently attest a wrong fact" into "let the agent decide
 * later", which aligns HARD STOP 9 by construction rather than by pattern
 * maintenance. `postalCode` is deliberately more permissive: any of `zip`,
 * `postal code`, `postcode`, or `postal` classifies, so a bare "Zip" still
 * fills.
 */

import { buildFullSnapshot } from "@/lib/agent/readback";
import type {
  AgentSnapshotSource,
  SnapshotOptions,
} from "@/lib/agent/readback";
import type { FactCatalog, FactEntry } from "@/lib/agent/fact-catalog";
import { resolveFactPath } from "@/lib/agent/fact-catalog";
import type { AgentSnapshot, FieldNode } from "@/lib/agent/snapshot-types";
import { FIELD_KEYWORDS, type FieldKey } from "@/lib/label-map";

/**
 * The identity slots the prefill knows how to fill, expressed as the union of
 * the slots the shared label map already carries and the address slots the
 * label map does not (and does not need to, because the DOM safety layer has
 * no `state`, `country` or `postalCode` conflict class of its own).
 *
 * Deliberately does NOT list `fullName`, `confirmEmail`, `coverLetter`, or
 * `resume`:
 *
 *  - `fullName` fights with the paired `firstName` / `lastName` fill on
 *    forms that expose both, and prefill has no way to prefer one over the
 *    other; the agent loop resolves that ambiguity by reading the current
 *    snapshot.
 *  - `confirmEmail` is a copy of `email` and the agent handles the copy
 *    specifically (some boards validate the two boxes as a pair typed in
 *    sequence rather than pasted).
 *  - `coverLetter` and `resume` are file uploads or multi paragraph text,
 *    neither of which the prefill's `setFieldValue` shape covers.
 */
export type PrefillSlot =
  | Extract<
      FieldKey,
      "firstName" | "lastName" | "email" | "phone" | "city" | "linkedin" | "website"
    >
  | "postalCode"
  | "currentState"
  | "currentCountry";

/**
 * The positive current location signals that gate `currentCountry` and
 * `currentState`. A label has to name one of these to classify as a current
 * address slot, which is what makes a bare "Country" or a "Country of birth"
 * fall through to the agent instead of being filled. See the module header
 * for why this inverted guard replaces the closed PR's exclusion regex.
 */
const POSITIVE_CURRENT_LOCATION =
  /\b(?:current|residence|residing|live|address|mailing|home|postal)\b/i;

/**
 * Address slot patterns the shared `FIELD_KEYWORDS` table does not carry.
 * Not merged into that table because the DOM safety layer's conflict check
 * has no equivalent for these classes and adding them there would widen a
 * safety check silently. Kept local to prefill instead, matched with the
 * same shape (word bounded, case insensitive) so behavior stays predictable.
 *
 * `postalCode` is more permissive than the other two: it needs no positive
 * current location signal, so a bare "Zip" or "Postal code" still classifies.
 */
const EXTRA_LABEL_PATTERNS: Record<
  Exclude<PrefillSlot, FieldKey>,
  RegExp
> = {
  postalCode: /\b(?:postal|post|zip)\s*code\b|\bpostcode\b|\bzip\b/i,
  currentState: /\b(?:state|province|region)\b/i,
  currentCountry: /\bcountry\b/i,
};

/**
 * The slots the prefill will actually attempt, in the order it tries them.
 * A field whose label matches more than one slot's pattern takes the first
 * match here, so `firstName` beats `fullName` on a "First name" label the
 * way the legacy code already ordered them, and the address slots resolve
 * before the label falls through to `city` on a "City / State" combined
 * label.
 */
const PREFILL_SLOT_ORDER: readonly PrefillSlot[] = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "linkedin",
  "website",
  "postalCode",
  "currentState",
  "currentCountry",
  "city",
];

/**
 * Which fact catalog paths hold the value for each slot. Every slot lists at
 * least one path; the first one that resolves against the catalog wins. The
 * paths mirror the keys `lib/fill-application-form.ts`'s `buildFactCatalog`
 * writes, so a run whose fact catalog was built by that function fills the
 * expected slot even before sub ticket B's new catalog builder lands.
 */
const FACT_PATHS_FOR_SLOT: Record<PrefillSlot, readonly string[]> = {
  firstName: ["profile.first_name", "firstName"],
  lastName: ["profile.last_name", "lastName"],
  email: ["profile.email", "email"],
  phone: ["profile.phone", "phone"],
  linkedin: ["profile.linkedin_url", "linkedinUrl"],
  website: ["profile.website_url", "websiteUrl"],
  city: ["profile.current_city", "currentCity"],
  postalCode: ["profile.postal_code", "postalCode"],
  currentState: ["profile.current_state", "currentState"],
  currentCountry: ["profile.current_country", "currentCountry"],
};

/**
 * The field kinds prefill will write into. Text like inputs only. A select,
 * radio, checkbox, date or file kind is left for the agent loop, which reads
 * the option set and picks an entry rather than typing raw text into a box
 * that would reject it (a country combobox is the canonical example).
 */
const PREFILL_KINDS: ReadonlySet<FieldNode["kind"]> = new Set([
  "text",
  "email",
  "tel",
  "url",
  "number",
]);

/**
 * The labels prefill refuses to write to, whatever slot they classify to.
 *
 * A "First name of your previous employer" input matches `firstName`'s
 * regex, and a bare `EXCLUDED_LABEL_PATTERNS` guard is what stops the
 * prefill from typing the candidate's own first name into it. The label
 * classes below are the ones HARD STOP 9 covers directly: employer
 * identity, employment dates, education institutions, and degree fields.
 * `PREFILL_SLOT_ORDER` never lists those slots to begin with, so the guard
 * is defensive rather than the primary line.
 *
 * This list deliberately does NOT enumerate birth, citizenship, or
 * nationality labels. Those no longer classify at all under the inverted
 * guard (`currentCountry` and `currentState` require a positive current
 * location signal), so they reach the walker as `no_label_match` and fall
 * through to the agent loop rather than being written.
 */
const EXCLUDED_LABEL_PATTERNS: readonly RegExp[] = [
  /\b(?:employer|company|organi[sz]ation)\b/i,
  /\b(?:start|end|from|to)\s*date\b/i,
  /\b(?:month|year)\s*(?:started|ended|of\s+(?:start|end))\b/i,
  /\b(?:school|university|college|institution)\b/i,
  /\b(?:degree|qualification|major|field\s+of\s+study|discipline)\b/i,
];

/**
 * Why a specific field was skipped. Kept as a closed union so the trace log
 * can be filtered on `reason` without a free text scan, and so the eventual
 * agent loop can react to `no_fact_for_slot` (a chance to prompt intake for
 * the missing answer) differently from `no_label_match` (a chance to ask
 * the LLM to classify the label).
 */
export type PrefillSkipReason =
  | "no_label_match"
  | "no_fact_for_slot"
  | "empty_fact_value"
  | "excluded_label"
  | "field_kind_not_prefillable"
  | "already_filled";

export interface FilledField {
  ref: string;
  label: string;
  slot: PrefillSlot;
  factPath: string;
  /** The value the prefill wrote. Stored so the trace can cross reference the fill against the fact catalog without running the resolver a second time. */
  value: string;
}

export interface SkippedField {
  ref: string;
  label: string;
  reason: PrefillSkipReason;
  /** Populated when `reason` is `no_fact_for_slot` or `excluded_label` so the trace names which slot the classifier reached before the guard refused. */
  slot: PrefillSlot | null;
}

export interface PrefillError {
  ref: string;
  label: string;
  slot: PrefillSlot;
  factPath: string;
  message: string;
}

export interface PrefillReport {
  filled: FilledField[];
  skipped: SkippedField[];
  errors: PrefillError[];
}

/**
 * The read/write surface the prefill needs from the page. Extends
 * `AgentSnapshotSource` with a single `setFieldValue` write so the walker
 * can address a field by the same `ref` the snapshot returned. Sub ticket E
 * plugs the real Stagehand page into this interface; tests pass a lightweight
 * fake that records calls.
 */
export interface PrefillPage extends AgentSnapshotSource {
  setFieldValue(ref: string, value: string): Promise<void>;
}

/**
 * Options accepted by `deterministicPrefill`. Kept minimal: `snapshotOptions`
 * is forwarded verbatim to `buildFullSnapshot` so a caller can pin the
 * clock or the byte budget for a test, and `snapshot` lets a caller hand in
 * an already built snapshot (the eventual agent loop builds a snapshot on
 * turn one regardless and there is no point walking the a11y tree twice).
 */
export interface PrefillOptions {
  snapshot?: AgentSnapshot;
  snapshotOptions?: SnapshotOptions;
}

/**
 * Classify one label to a prefill slot, or return `null` when nothing in the
 * shared label map matches. Exported so the label map test suite can cover
 * the classifier directly without having to build a full snapshot fixture.
 *
 * Order of tries matches `PREFILL_SLOT_ORDER`. `firstName` and `lastName`
 * precede `fullName` (which is not a prefill slot; kept out of the loop
 * entirely) so a "First name" label never routes to the fullName pattern
 * by accident. City resolves last of the address slots so a "City, State"
 * combined label prefers `currentState` over the plain city fallback.
 *
 * The inverted guard lives here: `currentCountry` and `currentState` only
 * classify when the label carries a positive current location signal (see
 * `POSITIVE_CURRENT_LOCATION`). A bare "Country", a "State / Province", and
 * every birth, citizenship, or nationality shape return `null` so the walker
 * records them as `no_label_match` and the agent loop decides later. This is
 * what aligns HARD STOP 9 by construction rather than by enumerating every
 * shape a form might use.
 */
export function classifyPrefillSlot(label: string): PrefillSlot | null {
  const text = String(label ?? "").trim();
  if (text === "") return null;
  // "Confirm email" reads to a human as an email box, and the plain
  // `\be-?mail\b` regex for the `email` slot happily matches the "email"
  // substring inside it. Prefill deliberately excludes `confirmEmail` from
  // `PREFILL_SLOT_ORDER` because the agent loop handles the copy explicitly
  // (some boards validate the pair by typing sequence rather than pasting),
  // so the classifier has to reject the label up front. Without this
  // check that runs before the slot scan, the walker would classify a
  // "Confirm email" control to `email` and paste the address a second
  // time, nullifying the whole reason `confirmEmail` was left off the
  // include list.
  if (FIELD_KEYWORDS.confirmEmail.test(text)) return null;
  for (const slot of PREFILL_SLOT_ORDER) {
    if (isFieldKey(slot)) {
      if (FIELD_KEYWORDS[slot].test(text)) return slot;
    } else {
      if (EXTRA_LABEL_PATTERNS[slot].test(text)) {
        if (
          (slot === "currentCountry" || slot === "currentState") &&
          !POSITIVE_CURRENT_LOCATION.test(text)
        ) {
          return null;
        }
        return slot;
      }
    }
  }
  return null;
}

function isFieldKey(slot: PrefillSlot): slot is Extract<PrefillSlot, FieldKey> {
  return slot in FIELD_KEYWORDS;
}

/**
 * True when the label matches any of the exclusion patterns. Exported so a
 * caller (and the test suite) can assert the guard fires without having to
 * observe it through a full prefill walk.
 *
 * Only the employment, education, and degree classes fire here. Birth,
 * citizenship, and nationality labels are not listed because they no longer
 * classify at all; see `classifyPrefillSlot` and the module header.
 */
export function isExcludedLabel(label: string): boolean {
  const text = String(label ?? "").trim();
  if (text === "") return false;
  return EXCLUDED_LABEL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Resolve the first fact path for a slot that names an entry with a non
 * empty string value. Falls through the ordered list in
 * `FACT_PATHS_FOR_SLOT` so a fact catalog written in either the legacy
 * shape or sub ticket B's shape resolves the same slot to the same value.
 *
 * Returns a discriminated union so the walker can distinguish three cases
 * that the trace log wants to keep separate: `found` writes the value,
 * `empty` records that the catalog knew about the slot but held only a
 * blank answer (a chance to prompt intake for the missing text), and
 * `missing` records that no path resolved to any entry at all (a chance to
 * revisit whether the slot's fact paths cover the shapes the fact catalog
 * builder is actually producing).
 */
type SlotResolution =
  | { status: "found"; path: string; value: string }
  | { status: "empty"; path: string }
  | { status: "missing" };

function resolveSlotValue(slot: PrefillSlot, catalog: FactCatalog): SlotResolution {
  let firstEmptyPath: string | null = null;
  for (const path of FACT_PATHS_FOR_SLOT[slot]) {
    const entry = resolveFactPath(catalog, path);
    if (entry === undefined) continue;
    const stringValue = coerceFactValue(entry);
    if (stringValue !== null) return { status: "found", path, value: stringValue };
    if (firstEmptyPath === null) firstEmptyPath = path;
  }
  if (firstEmptyPath !== null) return { status: "empty", path: firstEmptyPath };
  return { status: "missing" };
}

function coerceFactValue(entry: FactEntry | undefined): string | null {
  if (entry === undefined || entry.value === null) return null;
  const stringValue =
    typeof entry.value === "string" ? entry.value : String(entry.value);
  const trimmed = stringValue.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Walk the page and prefill every identity field the label map covers. Never
 * throws on a per field failure: a `setFieldValue` rejection is captured on
 * `errors` and the walk continues, because a page that mounted 12 identity
 * fields and rejected one write should still ship 11 filled fields to the
 * agent loop rather than none.
 *
 * The order of work is deterministic: fields are visited in snapshot order,
 * writes complete sequentially. Sequential rather than parallel because a
 * board that normalises the value on blur (SmartRecruiters phone) sees
 * every write on the same event loop tick without racing the normaliser.
 */
export async function deterministicPrefill(
  page: PrefillPage,
  catalog: FactCatalog,
  options: PrefillOptions = {}
): Promise<PrefillReport> {
  const snapshot =
    options.snapshot ?? (await buildFullSnapshot(page, options.snapshotOptions));

  const filled: FilledField[] = [];
  const skipped: SkippedField[] = [];
  const errors: PrefillError[] = [];

  for (const field of snapshot.fields) {
    const label = field.label.trim();
    if (label === "") continue;

    if (isExcludedLabel(label)) {
      // Report the slot the classifier would have reached, so a reviewer of
      // the trace can see whether the guard refused an ambiguous field or a
      // clearly out of scope one.
      skipped.push({
        ref: field.ref,
        label,
        reason: "excluded_label",
        slot: classifyPrefillSlot(label),
      });
      continue;
    }

    const slot = classifyPrefillSlot(label);
    if (slot === null) {
      skipped.push({ ref: field.ref, label, reason: "no_label_match", slot: null });
      continue;
    }

    if (!PREFILL_KINDS.has(field.kind)) {
      skipped.push({
        ref: field.ref,
        label,
        reason: "field_kind_not_prefillable",
        slot,
      });
      continue;
    }

    const resolved = resolveSlotValue(slot, catalog);
    if (resolved.status === "missing") {
      skipped.push({ ref: field.ref, label, reason: "no_fact_for_slot", slot });
      continue;
    }
    if (resolved.status === "empty") {
      skipped.push({ ref: field.ref, label, reason: "empty_fact_value", slot });
      continue;
    }

    if (field.value !== null && field.value.trim() === resolved.value.trim()) {
      skipped.push({ ref: field.ref, label, reason: "already_filled", slot });
      continue;
    }

    try {
      await page.setFieldValue(field.ref, resolved.value);
      filled.push({
        ref: field.ref,
        label,
        slot,
        factPath: resolved.path,
        value: resolved.value,
      });
    } catch (cause) {
      errors.push({
        ref: field.ref,
        label,
        slot,
        factPath: resolved.path,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { filled, skipped, errors };
}
