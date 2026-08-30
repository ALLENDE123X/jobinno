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
 * enumeration is the wrong architecture; the classifier now works from the
 * opposite direction. A label classifies to an identity slot only when it
 * carries a positive signal that the slot names AND carries no negative
 * qualifier that would name someone or something other than the applicant
 * themselves. The two halves are independent conditions and both have to
 * hold. Missing either one sends the label back to the walker as
 * `no_label_match` so the agent decides later.
 *
 * The positive signal per slot: `firstName`, `lastName`, `email`, `phone`,
 * `city`, `linkedin`, `website` all reuse the shared `FIELD_KEYWORDS` table
 * that the DOM safety layer reads too, so both sides of the codebase agree
 * on what a label means. `postalCode` reuses its own local regex that
 * covers the postal, postcode, and zip vocabulary. `currentCountry` and
 * `currentState` reuse their bare country / state regex AND additionally
 * require a positive current location signal (one of current, residence,
 * residing, live, address, mailing, home, postal) because a bare "Country"
 * does not identify a current country the way "Country of residence" does.
 *
 * The negative qualifier: a single shared regex catches every phrase that
 * turns an identity label into someone else's information. Birth / born /
 * citizenship / nationality / origin / native / previous / former / prior /
 * past all name a legally distinct answer (a country of birth is not the
 * current country of residence, and HARD STOP 9 forbids attesting one as
 * the other). Reference / emergency / spouse / partner / parent / guardian
 * / mother / father / contact / manager / supervisor / boss all name a
 * different person. When the negative qualifier fires, the label classifies
 * to `null` regardless of the positive match: "Emergency contact first
 * name" is not the applicant's first name, "Country of birth" is not their
 * country, "Manager LinkedIn" is not their LinkedIn. This turns the risk
 * shape from "silently attest a wrong fact" into "let the agent decide
 * later", which aligns HARD STOP 9 by construction rather than by pattern
 * maintenance.
 *
 * The confirmEmail up front check catches both the prefix form
 * (`FIELD_KEYWORDS.confirmEmail` matches "Confirm email", "Verify email")
 * and the suffix form ("Email confirmation", "Email verification") that
 * carry the confirmation word after the email token rather than before it.
 * Both prevent a "Confirm email" or "Email confirmation" box from being
 * silently filled as the primary email.
 *
 * The `already_filled` skip is deliberately non destructive: any pre
 * existing non blank value on a control stays untouched, even when it
 * differs from the fact catalog's value. Prefill runs at the top of a
 * session before the agent loop; a value that arrived from browser
 * autofill, a prior turn, or the person themselves belongs to the page
 * already and is never overwritten by a deterministic pass.
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
 * address slot, which is what makes a bare "Country" fall through to the
 * agent instead of being filled. See the module header for why this
 * inverted guard replaces the closed PR's exclusion regex.
 */
const POSITIVE_CURRENT_LOCATION =
  /\b(?:current|residence|residency|residing|live|address|mailing|home|postal)\b/i;

/**
 * The negative qualifier that rejects a label whatever slot its positive
 * signal matched. Every word in this set names either a legally distinct
 * answer (birth country versus current country, previous residence versus
 * current residence) or a different person (reference, emergency contact,
 * spouse, parent). See the module header for the full architectural
 * argument. The list is shared across every slot so a new hole cannot open
 * up on one slot without opening on the others.
 */
const NEGATIVE_QUALIFIER =
  /\b(?:birth|born|citizen(?:ship)?|nationality|origin|native|previous|former|prior|past|reference|emergency|spouse|partner|parent|guardian|mother|father|contact|manager|supervisor|boss)\b/i;

/**
 * The suffix form of an email confirmation label. The shared
 * `FIELD_KEYWORDS.confirmEmail` regex catches the prefix form ("Confirm
 * email", "Verify email", "Re-enter email") because the confirmation word
 * comes before "email" there. This regex covers the suffix form ("Email
 * confirmation", "Email verification", "Email confirmation address") where
 * the confirmation word follows the email token. Both prevent the primary
 * email address from being typed into a control the board expects to
 * validate against a manual retype.
 */
const EMAIL_CONFIRMATION_SUFFIX =
  /\be-?mail\b[\s\S]*\b(?:confirm(?:ation)?|verify|verification|repeat|again)\b/i;

/**
 * Address slot patterns the shared `FIELD_KEYWORDS` table does not carry.
 * Not merged into that table because the DOM safety layer's conflict check
 * has no equivalent for these classes and adding them there would widen a
 * safety check silently. Kept local to prefill instead, matched with the
 * same shape (word bounded, case insensitive) so behavior stays predictable.
 *
 * `postalCode` covers the postal, postcode, and zip vocabulary. A bare
 * "Postal" alone does not classify; the shape reads as a mailing address
 * fragment there rather than a code. `currentCountry` and `currentState`
 * additionally require a positive current location signal (see
 * `POSITIVE_CURRENT_LOCATION`) and every slot including `postalCode` is
 * subject to the shared `NEGATIVE_QUALIFIER` reject inside
 * `classifyPrefillSlot`.
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
 * The classes below are the ones the shared `NEGATIVE_QUALIFIER` does not
 * catch: employer identity, employment dates, education institutions, and
 * degree fields. `PREFILL_SLOT_ORDER` never lists those slots to begin
 * with, so the guard is defensive rather than the primary line. The
 * classifier already returns `null` for a "First name of your previous
 * employer" label because "previous" is a negative qualifier, but the
 * `employer` / `company` / `organization` half stays here so a "Company
 * name" label still records `excluded_label` rather than the less specific
 * `no_label_match` on the trace.
 *
 * This list deliberately does NOT enumerate birth, citizenship,
 * nationality, reference, emergency, spouse, parent, guardian, mother,
 * father, contact, manager, supervisor, or boss labels. All of those are
 * caught earlier by the shared `NEGATIVE_QUALIFIER` in
 * `classifyPrefillSlot`, so they never reach a slot in the first place and
 * the walker records them as `no_label_match`.
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
 * The inverted guard lives here and applies to every identity slot without
 * exception. A label classifies to a slot only when both halves hold: the
 * slot's own positive signal matches, AND `NEGATIVE_QUALIFIER` does not.
 * The negative qualifier catches every phrase that names a legally distinct
 * fact ("Country of birth" is not the current country) or a different
 * person ("Emergency contact first name" is not the applicant's first
 * name). `currentCountry` and `currentState` layer an additional positive
 * requirement on top: the label also has to carry a current location
 * signal, since a bare "Country" does not point at a current country the
 * way "Country of residence" does. See the module header for why this
 * shape replaces the closed PR's enumerated exclusion regex.
 *
 * The confirmEmail up front check covers both the prefix form (the shared
 * `FIELD_KEYWORDS.confirmEmail` regex catches "Confirm email", "Verify
 * email", "Re-enter email") and the suffix form
 * (`EMAIL_CONFIRMATION_SUFFIX` catches "Email confirmation", "Email
 * verification"). Prefill deliberately excludes `confirmEmail` from
 * `PREFILL_SLOT_ORDER` because the agent loop handles the copy explicitly
 * (some boards validate the pair by typing sequence rather than pasting).
 */
export function classifyPrefillSlot(label: string): PrefillSlot | null {
  const text = String(label ?? "").trim();
  if (text === "") return null;
  // Both forms of the email confirmation label reject before any positive
  // pattern runs. Without this check the walker would classify a "Confirm
  // email" or "Email confirmation" control to `email` and paste the address
  // a second time, nullifying the reason `confirmEmail` was left off the
  // include list.
  if (
    FIELD_KEYWORDS.confirmEmail.test(text) ||
    EMAIL_CONFIRMATION_SUFFIX.test(text)
  ) {
    return null;
  }
  // The shared negative qualifier fires once, up front, so every slot
  // inherits the same reject list. A hole cannot open on one slot without
  // opening on every other slot, which is what makes the guard architectural
  // rather than per pattern.
  if (NEGATIVE_QUALIFIER.test(text)) return null;
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
 * Only the employment, education, and degree classes fire here. Every
 * other class the earlier draft enumerated (birth, citizenship,
 * nationality, reference, emergency, spouse, parent, and so on) is caught
 * earlier by the shared `NEGATIVE_QUALIFIER` in `classifyPrefillSlot`, so
 * those labels no longer classify to a slot and the walker records them as
 * `no_label_match` rather than `excluded_label`.
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

    // Prefill is non destructive on every existing non blank value, not
    // only on values that already match the fact catalog. A different
    // string on the control means someone or something (browser autofill,
    // an earlier turn, the applicant themselves) put it there and it
    // belongs to the page already. Preserving it prevents the prefill pass
    // from silently overwriting an answer the applicant would attest to.
    if (field.value !== null && field.value.trim() !== "") {
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
