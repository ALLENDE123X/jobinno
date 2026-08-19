/**
 * JOB-006: the shared observe() replay cache, keyed by ATS form shape.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every field this pipeline fills costs an `observe()` call, and `observe()` is
 * an LLM call. A full application is roughly 20 to 40 of them. At the Season
 * Pass price of $99 for 500 applications, paying that on every application puts
 * LLM cost somewhere around 75% of revenue, which is not a business.
 *
 * The saving is sitting in plain sight: Jobinno hits the same handful of ATS
 * platforms over and over, and Greenhouse's name box is in the same place on
 * Greenhouse's form whichever company is hiring. So the answer `observe()` gives
 * for "the First Name input on the job application form" is reusable across
 * every posting on that platform whose form has the same shape. Store it once,
 * replay it forever, and only pay a model when the replay does not hold up.
 *
 * `lib/stagehand-session.ts` already had a cache for this, and it is kept: it is
 * keyed by page origin plus path, so it makes a *re run of the same posting*
 * deterministic. What it cannot do is help the first run of a posting nobody has
 * seen before, which is every run in production. This module is the other half:
 * the key is what the form looks like, not which URL it is at, so the first run
 * against a new Greenhouse posting is already warm.
 *
 * ── What it is safe to replay, and what it is not ───────────────────────────
 * A row here is read by every user's runs, so a poisoned row is a problem for
 * everybody rather than for one machine. Two rules follow, and they are the
 * reason this is narrow rather than general:
 *
 *  1. **No `description` is ever stored.** `observe()`'s description is text a
 *     model wrote about an untrusted page, and `lib/stagehand-session.ts` goes
 *     to some length to keep it out of any action capable call. Storing it in a
 *     table every user reads would hand that string a much longer life than it
 *     has today. A replayed action carries the caller's own constant
 *     instruction as its description instead, which is what `typeInto()`
 *     overwrites it with anyway.
 *
 *     What that costs, and it is worth saying plainly because a review found it
 *     the hard way: a replayed description is a string this codebase wrote, and
 *     every one of those constants names its own field in plain words, so
 *     checking one against `FIELD_KEYWORDS` is checking it against itself.
 *     `corroborate()` therefore refuses to accept a replayed selector on the
 *     strength of its description at all. A replay has to be corroborated by
 *     the DOM or be observed again.
 *
 *  2. **Only fields are served, never clicks.** `clickControl()` decides whether
 *     a control is safe to click by testing `observe()`'s fresh description
 *     against `SUBMIT_WORD_RE`. Serve that path from a cache and the check
 *     becomes a test of our own constant against itself, which is no check at
 *     all. So the apply control, the sign in button and the verification button
 *     are always observed live, on every run. They are 1 to 3 calls out of
 *     roughly 14, and they are the calls where being wrong means clicking
 *     something that submits a real application.
 *
 * The caller passes the closed set of instructions it is willing to have served,
 * so that list lives next to the instructions themselves rather than here.
 *
 * ── Replay is checked, never trusted ────────────────────────────────────────
 * A replayed selector is not assumed to be right. `fill-application-form.ts`
 * reads the control out of the DOM and corroborates it against what the DOM
 * says, and a replayed action that fails that check, or that fails when acted
 * on, is dropped from the plan and observed live once. So the worst a wrong row
 * can do is cost the model call it was trying to save.
 *
 * It has to be a stricter check than the one a fresh observation gets, because
 * a fingerprint really can collide between two forms that are not the same
 * form. `selectorShape()` keeps only an XPath's leaf tag, so two self hosted
 * careers pages whose controls carry no ids can key the same, and then one page
 * replays the other's absolute XPaths. Nothing about that is exotic, so a
 * replay is believed only where the page itself says so.
 *
 * ── Storage ─────────────────────────────────────────────────────────────────
 * Postgres, in `cached_form_actions`, reached through `@supabase/supabase-js` on
 * the service role key like every other ported module here. A file would not
 * survive a Vercel or Inngest invocation, and a cache that starts empty on every
 * invocation saves nothing.
 *
 * Every call in this module is best effort. A cache that cannot be read, cannot
 * be written, or does not exist yet must never fail a run: the fallback is to
 * observe, which is exactly what the code did before this existed.
 */

import { createHash } from "node:crypto";
import { type SupabaseClient } from "@supabase/supabase-js";

/** Bump when the fingerprint recipe changes, so old rows miss instead of lying. */
export const FORM_SHAPE_VERSION = 1;

const TABLE = "cached_form_actions";

/** Set to `true` to turn the shared cache off without a deploy of new code. */
export const CACHE_DISABLED_ENV_VAR = "FORM_ACTION_CACHE_DISABLED";

/**
 * The boilerplate fields an ATS puts on every one of its forms.
 *
 * This closed list is the whole reason a fingerprint can be stable across
 * postings. A Greenhouse form for one company and a Greenhouse form for another
 * differ almost entirely in their custom questions, which are numerous,
 * specific to one posting, and not what this cache serves. Restrict attention to
 * the slots below and what is left is the platform's own form, which is the same
 * everywhere.
 */
export const CORE_SLOTS = [
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "linkedin",
  "website",
  "resume",
  "coverLetter",
] as const;
export type CoreSlot = (typeof CORE_SLOTS)[number];

/**
 * Which slot a visible label names, or nothing.
 *
 * Deliberately a separate table from `FIELD_KEYWORDS` in
 * `lib/fill-application-form.ts`, because the two answer different questions:
 * that one is a safety gate deciding whether a control may receive a value, and
 * this one is a key deriving function deciding which bucket a control counts
 * towards. Fusing them would mean widening a cache key silently widened a
 * safety check.
 *
 * They still have to agree about what a label means, and
 * `tests/unit/form-action-cache.test.ts` pins that: both tables are run over the
 * same corpus of real labels and have to reach the same answer. Order matters
 * here, because the first match wins and "First Name" also contains "Name".
 */
const SLOT_PATTERNS: readonly (readonly [CoreSlot, RegExp])[] = [
  ["firstName", /first[\s_-]*name|given[\s_-]*name|\bfname\b/i],
  ["lastName", /last[\s_-]*name|\bsurname\b|family[\s_-]*name|\blname\b/i],
  ["email", /e-?mail/i],
  ["phone", /phone|mobile|telephone|\btel\b/i],
  ["linkedin", /linked-?in/i],
  ["coverLetter", /cover[\s_-]*letter/i],
  ["resume", /resum|\bcv\b|curriculum/i],
  ["website", /website|portfolio|personal[\s_-]*(site|url|page)|\bgithub\b/i],
  ["fullName", /(full|your|applicant)[\s_-]*name|^\s*name\b/i],
];

export function classifyCoreSlot(label: string): CoreSlot | null {
  const text = String(label ?? "").trim();
  if (text === "") return null;
  for (const [slot, pattern] of SLOT_PATTERNS) {
    if (pattern.test(text)) return slot;
  }
  return null;
}

// ───────────────────────────────────
// Which ATS a page belongs to
// ───────────────────────────────────

/**
 * Hostnames that identify a platform. The same table
 * `lib/search-job-listings.ts` keys its board detection off, extended past the
 * three it can read APIs for, because a form fill lands on boards the search
 * never produced.
 */
const ATS_HOSTS: readonly { pattern: RegExp; ats: string }[] = [
  { pattern: /(^|\.)greenhouse\.io$/i, ats: "greenhouse" },
  { pattern: /(^|\.)lever\.co$/i, ats: "lever" },
  { pattern: /(^|\.)ashbyhq\.com$/i, ats: "ashby" },
  { pattern: /(^|\.)workable\.com$/i, ats: "workable" },
  { pattern: /(^|\.)bamboohr\.com$/i, ats: "bamboohr" },
  { pattern: /(^|\.)breezy\.hr$/i, ats: "breezy" },
  { pattern: /(^|\.)applytojob\.com$/i, ats: "jazzhr" },
  { pattern: /(^|\.)recruitee\.com$/i, ats: "recruitee" },
  { pattern: /(^|\.)teamtailor\.com$/i, ats: "teamtailor" },
  { pattern: /(^|\.)smartrecruiters\.com$/i, ats: "smartrecruiters" },
];

/**
 * The platform a form is hosted on, or `"unknown"`.
 *
 * `"unknown"` is a real key rather than a refusal to cache: a company hosting
 * its own careers page is still one shape seen many times, and the fingerprint
 * carries the shape either way. What it loses is the guarantee that two forms
 * under the same key came from the same vendor, which is why the host is part of
 * the key at all.
 */
export function detectAts(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "unknown";
  }
  return ATS_HOSTS.find(({ pattern }) => pattern.test(host))?.ats ?? "unknown";
}

// ───────────────────────────────────
// Fingerprinting one form's shape
// ───────────────────────────────────

/** The part of an enumerated control a fingerprint reads. `EnumeratedField` fits. */
export type ShapeField = {
  label: string;
  kind: string;
  selector: string;
};

export type FormShape = {
  ats: string;
  /** Hex digest of the canonical shape. The cache key, with `ats`. */
  fingerprint: string;
  /** The tokens that went into the digest, kept so a changed key can be read. */
  tokens: string[];
  /** Which boilerplate slots this form actually has. */
  slots: Set<CoreSlot>;
};

/**
 * Collapses the parts of a selector that vary between postings.
 *
 * `lib/form-fields.ts` emits `[id="first_name"]` when an id is unique and an
 * absolute XPath otherwise, so there are two shapes to handle:
 *
 *  · An id is the platform's own naming and is the strongest structural signal
 *    there is. Greenhouse calls its box `first_name` on every board it hosts, so
 *    keeping the id keeps the promise that the key changes when Greenhouse
 *    changes its form. Digits and long hex runs are collapsed, because a
 *    generated id such as `question_29104773` names one posting's custom
 *    question and nothing else.
 *
 *  · An XPath keeps only its leaf tag. The full ladder shifts the moment a
 *    company adds a paragraph above the form, which is not a layout change worth
 *    a new cache key, while a platform replacing an `input` with a scripted
 *    `div` control is exactly one.
 */
export function selectorShape(selector: string): string {
  const raw = String(selector ?? "").trim();
  if (raw === "") return "none";

  // `[\s\S]` rather than `.` with the `s` flag, which this project's TypeScript
  // target predates. An id carrying a newline should still be recognised here
  // rather than falling through to the XPath branch.
  const idMatch = /^\[id="([\s\S]*)"\]$/.exec(raw);
  if (idMatch !== null) {
    const id = idMatch[1]
      .toLowerCase()
      .replace(/[0-9a-f]{8,}/g, "#")
      .replace(/\d+/g, "#");
    return `id:${id}`;
  }

  if (raw.startsWith("xpath=")) {
    const steps = raw.slice("xpath=".length).split("/").filter(Boolean);
    const leaf = steps[steps.length - 1] ?? "";
    return `xpath:${leaf.replace(/\[\d+\]$/, "").toLowerCase()}`;
  }

  return `sel:${raw.toLowerCase().replace(/\d+/g, "#")}`;
}

/**
 * A stable key for "this is that platform's form".
 *
 * Three deliberate omissions, each of which would otherwise split one real shape
 * into many:
 *
 *  · Fields with no core slot are ignored entirely. They are the custom
 *    questions, they differ on every posting, and nothing here caches them.
 *  · A control's required flag is left out. Boards let each company decide
 *    whether LinkedIn is mandatory, and that decision moves no selector.
 *  · Order is dropped and duplicates are folded, so a form that repeats a label
 *    keys the same as one that does not.
 */
export function fingerprintFormShape(ats: string, fields: readonly ShapeField[]): FormShape {
  const slots = new Set<CoreSlot>();
  const tokens = new Set<string>();

  for (const field of fields) {
    const slot = classifyCoreSlot(field.label);
    if (slot === null) continue;
    slots.add(slot);
    tokens.add(`${slot}:${String(field.kind ?? "other")}:${selectorShape(field.selector)}`);
  }

  const sorted = [...tokens].sort();
  const canonical = JSON.stringify({ v: FORM_SHAPE_VERSION, ats, tokens: sorted });
  const fingerprint = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return { ats, fingerprint, tokens: sorted, slots };
}

// ───────────────────────────────────
// The plan a run carries
// ───────────────────────────────────

/**
 * Where to act, and how. No `description` and no `arguments`, for the reasons in
 * this file's header and in `CachedAction`'s comment in
 * `lib/stagehand-session.ts` respectively.
 */
export type PlannedAction = { selector: string; method?: string };

export type ActionPlanStats = {
  /** Controls found without a model call. */
  replayed: number;
  /** Controls known to be absent without a model call. */
  replayedAbsent: number;
  /** Model calls made anyway, whether by miss or by fallback. */
  observed: number;
  /** Replays that did not survive validation and were observed live instead. */
  invalidated: number;
};

export type ActionPlan = {
  ats: string;
  fingerprint: string;
  tokens: string[];
  /** Instruction to action, or to `null` meaning "this form does not have it". */
  entries: Map<string, PlannedAction | null>;
  /** The only instructions this plan may answer. See the header. */
  cacheable: ReadonlyMap<string, CoreSlot>;
  /** Slots the live form has, from the same read the fingerprint came from. */
  slots: ReadonlySet<CoreSlot>;
  stats: ActionPlanStats;
  /** True once something was learned that is not in the stored row yet. */
  dirty: boolean;
  /** True when a stored row was found. False means this run is populating it. */
  warm: boolean;
  /** Replays the stored row had already served before this run. Telemetry only. */
  priorHits: number;
  /** Invalidations the stored row had already recorded. Telemetry only. */
  priorInvalidations: number;
};

export function emptyActionPlan(
  shape: FormShape,
  cacheable: ReadonlyMap<string, CoreSlot>
): ActionPlan {
  return {
    ats: shape.ats,
    fingerprint: shape.fingerprint,
    tokens: shape.tokens,
    entries: new Map(),
    cacheable,
    slots: shape.slots,
    stats: { replayed: 0, replayedAbsent: 0, observed: 0, invalidated: 0 },
    dirty: false,
    warm: false,
    priorHits: 0,
    priorInvalidations: 0,
  };
}

/** What a plan lookup can say. A miss and a cached absence are not the same. */
export type PlanLookup =
  | { hit: false }
  | { hit: true; action: PlannedAction }
  | { hit: true; action: null };

/**
 * The stored answer for one instruction, if this plan is allowed to give one.
 *
 * The guard on a cached absence is worth spelling out. Answering "this form has
 * no phone box" without looking is the one reply here that can quietly leave a
 * required field blank on a real application, so it is only given when the live
 * form agrees: the slot has to be missing from the shape this very run read out
 * of the DOM. A fingerprint match should already guarantee that, since the slot
 * set is what the fingerprint is built from. This is the belt to that braces,
 * and it costs one set lookup.
 */
export function planLookup(plan: ActionPlan | null | undefined, instruction: string): PlanLookup {
  if (!plan) return { hit: false };
  const slot = plan.cacheable.get(instruction);
  if (slot === undefined) return { hit: false };
  if (!plan.entries.has(instruction)) return { hit: false };

  const stored = plan.entries.get(instruction) ?? null;
  if (stored === null) {
    if (plan.slots.has(slot)) return { hit: false };
    plan.stats.replayedAbsent++;
    return { hit: true, action: null };
  }
  plan.stats.replayed++;
  return { hit: true, action: stored };
}

/** Files what a live observation found, so the next run does not repeat it. */
export function planRecord(
  plan: ActionPlan | null | undefined,
  instruction: string,
  action: PlannedAction | null
): void {
  if (!plan) return;
  if (!plan.cacheable.has(instruction)) return;
  plan.stats.observed++;

  const existing = plan.entries.get(instruction);
  const unchanged =
    plan.entries.has(instruction) &&
    ((existing ?? null) === null
      ? action === null
      : action !== null &&
        existing?.selector === action.selector &&
        existing?.method === action.method);
  if (unchanged) return;

  plan.entries.set(instruction, action);
  plan.dirty = true;
}

/** Drops a replayed answer that did not hold up, and remembers that it happened. */
export function planInvalidate(plan: ActionPlan | null | undefined, instruction: string): void {
  if (!plan) return;
  if (!plan.entries.has(instruction)) return;
  plan.entries.delete(instruction);
  plan.stats.invalidated++;
  plan.dirty = true;
}

// ───────────────────────────────────
// Postgres
// ───────────────────────────────────

function cacheDisabled(): boolean {
  return String(process.env[CACHE_DISABLED_ENV_VAR] ?? "").toLowerCase() === "true";
}

/** Rejects anything in a stored row that is not the shape this code expects. */
function readStoredActions(raw: unknown): Map<string, PlannedAction | null> {
  const entries = new Map<string, PlannedAction | null>();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return entries;

  for (const [instruction, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) {
      entries.set(instruction, null);
      continue;
    }
    if (typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as { selector?: unknown; method?: unknown };
    if (typeof record.selector !== "string" || record.selector === "") continue;
    entries.set(instruction, {
      selector: record.selector,
      ...(typeof record.method === "string" ? { method: record.method } : {}),
    });
  }
  return entries;
}

/**
 * The stored plan for this form shape, or an empty one.
 *
 * Never throws. A missing table, a failed query and a shape nobody has seen all
 * produce the same thing, because the caller does the same thing about all
 * three: observe.
 */
export async function loadActionPlan(
  supabase: SupabaseClient,
  shape: FormShape,
  cacheable: ReadonlyMap<string, CoreSlot>,
  logTag: string
): Promise<ActionPlan> {
  const plan = emptyActionPlan(shape, cacheable);
  if (cacheDisabled()) {
    console.log(`${logTag} form action cache disabled by ${CACHE_DISABLED_ENV_VAR}`);
    return plan;
  }

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select("actions, replay_hits, replay_invalidations")
      .eq("ats", shape.ats)
      .eq("form_fingerprint", shape.fingerprint)
      .maybeSingle();

    if (error) {
      console.warn(
        `${logTag} could not read the form action cache (observing instead): ${error.message}`
      );
      return plan;
    }
    if (!data) {
      console.log(
        `${logTag} form action cache MISS for ${shape.ats}/${shape.fingerprint} ` +
          `(${shape.tokens.length} shape token(s)); this run will populate it`
      );
      return plan;
    }

    const row = data as {
      actions?: unknown;
      replay_hits?: number | null;
      replay_invalidations?: number | null;
    };
    plan.entries = readStoredActions(row.actions);
    plan.warm = plan.entries.size > 0;
    plan.priorHits = row.replay_hits ?? 0;
    plan.priorInvalidations = row.replay_invalidations ?? 0;
    console.log(
      `${logTag} form action cache HIT for ${shape.ats}/${shape.fingerprint} ` +
        `with ${plan.entries.size} stored action(s), reused ${plan.priorHits} time(s) before`
    );
    return plan;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${logTag} form action cache read failed (observing instead): ${reason}`);
    return plan;
  }
}

/**
 * Writes back what this run learned. Never throws, for the same reason the read
 * does not: this is an optimisation, and a failed optimisation is not a failed
 * application.
 *
 * Last write wins on a concurrent update, which costs at most one extra observe
 * on some later run. Treating that as an error would make a lost update more
 * expensive than the thing it is protecting.
 */
export async function saveActionPlan(
  supabase: SupabaseClient,
  plan: ActionPlan | null | undefined,
  logTag: string
): Promise<void> {
  if (!plan) return;
  if (cacheDisabled()) return;
  const served = plan.stats.replayed + plan.stats.replayedAbsent;
  if (!plan.dirty && served === 0) return;

  const actions: Record<string, PlannedAction | null> = {};
  for (const [instruction, action] of plan.entries) actions[instruction] = action;

  try {
    const { error } = await supabase.from(TABLE).upsert(
      {
        ats: plan.ats,
        form_fingerprint: plan.fingerprint,
        shape_version: FORM_SHAPE_VERSION,
        shape_tokens: plan.tokens,
        actions,
        // Read modified and written back rather than incremented in place,
        // because PostgREST has no `set x = x + 1`. A concurrent run can lose an
        // increment here; an undercounted telemetry column is not worth a
        // transaction on the hot path of a form fill.
        replay_hits: plan.priorHits + served,
        replay_invalidations: plan.priorInvalidations + plan.stats.invalidated,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "ats,form_fingerprint" }
    );
    if (error) {
      console.warn(`${logTag} could not write the form action cache (ignored): ${error.message}`);
      return;
    }
    console.log(
      `${logTag} form action cache saved for ${plan.ats}/${plan.fingerprint} ` +
        `holding ${plan.entries.size} action(s); this run replayed ${served} and observed ` +
        `${plan.stats.observed}`
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${logTag} form action cache write failed (ignored): ${reason}`);
  }
}
