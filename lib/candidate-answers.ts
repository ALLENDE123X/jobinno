/**
 * JOB-v1-B — the answers a candidate has given once, kept, and looked up by
 * intent rather than by fuzzy substring on the question text.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `lib/fill-application-form.ts` used to reach for a stored answer with
 * `matchAdditionalAnswer`, which walks a `{question: answer}` map and takes
 * the first key that contains or is contained by the field's own. That works
 * exactly as long as two employers word the same question the same way; on
 * the 2026-08-25 SmartRecruiters run three of four employers reworded a
 * question the candidate had already answered elsewhere, and the fuzzy
 * substring path missed all three. See `lib/canonical-topics.ts` for the
 * design of the fix; this file is the storage-and-lookup half of it.
 *
 * The rule that governs every line of code below: the intent classifier
 * decides *which* answer to reuse, not *whether* it may be reused. Every
 * safety guard in `lib/fill-application-form.ts` — the LEGAL_ATTESTATION_RE
 * ladder, `attestationFactAllowed`, `optionSupportsFact`, the read-back —
 * still runs against a stored answer that came back from this module exactly
 * as it runs against one that arrived from `additionalAnswers` a second ago.
 * All this file changes is *how* the answer is retrieved and *where* it was
 * kept in between runs.
 *
 * ── Why this file imports only `canonical-topics.ts` ────────────────────────
 * Kept a leaf on purpose. `lib/fill-application-form.ts` imports this
 * module, and if that dependency were closed the cycle its module-load
 * regexes would fail as undefined constants rather than as an import error.
 * `canonical-topics.ts` is also a leaf, so the pair is safe to import from
 * both this file and the fill layer.
 */

import {
  ALWAYS_BLOCK_TOPIC_SLUGS,
  canonicalTopicBySlug,
  classifyIntent,
  type CanonicalTopic,
  type CanonicalTopicProfileColumns,
} from "@/lib/canonical-topics";

/**
 * One answer the candidate has given, kept against their profile.
 *
 * ── Why both `topic` and `question` ─────────────────────────────────────────
 * `topic` is what makes this taxonomy work across employer rewordings: the
 * next form asking the same intent looks the answer up by slug rather than by
 * matching a truncated sentence. `question` is kept verbatim next to it for
 * two reasons and neither of them is decoration:
 *
 *   · The legacy fuzzy-substring path (`legacyMatchByQuestion` below) still
 *     runs for questions the classifier does not recognise, so an intent
 *     table gap does not silently forget the person's own answer.
 *
 *   · When a reviewer opens a `profiles.stored_answers` row and asks what
 *     the person was actually asked, the answer is right there. A slug on
 *     its own tells a reader nothing about the sentence the candidate read.
 *
 * `topic` may be `null` for a legacy write that predates the classifier
 * or for a question the classifier did not recognise; both paths are handled
 * by `resolveAnswer` below.
 */
export type StoredAnswer = {
  /** Canonical intent slug from `CANONICAL_TOPICS`, or `null` when unknown. */
  topic: string | null;
  /** The question exactly as the form asked it, lowercased. */
  question: string;
  /** The candidate's own words, verbatim. */
  answer: string;
  /** When it was answered, ISO 8601. Newest wins when a topic repeats. */
  answeredAt: string;
};

/** How many answers one person's profile keeps. */
export const STORED_ANSWER_LIMIT = 100;

/** Length caps, so one pathological label cannot dominate the stored blob. */
const MAX_QUESTION_LENGTH = 300;
const MAX_ANSWER_LENGTH = 2000;

/** Race, gender, veteran status, disability — HARD STOP #10. Never stored. */
const EEO_QUESTION_RE =
  /\b(?:gender|sex(?:ual)?\s+orientation|race|ethnicit\w*|hispanic|latin\w+|veteran|disabilit\w*|pronoun)\b/i;

/**
 * `profiles.stored_answers` as it comes back from the database, validated.
 *
 * Malformed entries are dropped rather than repaired. A half-readable stored
 * answer is a sentence nobody wrote, and the cost of dropping it is one
 * escalated question. Applies HARD STOP #10 on the way out as well as on the
 * way in, because a demographic answer that somehow reached the column must
 * not reach a form.
 */
export function parseStoredAnswers(value: unknown): StoredAnswer[] {
  if (!Array.isArray(value)) return [];

  const answers: StoredAnswer[] = [];
  const seenIdentities = new Set<string>();
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;

    const question = typeof entry.question === "string" ? entry.question.trim() : "";
    const answer = typeof entry.answer === "string" ? entry.answer.trim() : "";
    if (question === "" || answer === "") continue;
    if (EEO_QUESTION_RE.test(question)) continue;

    // Topic is recomputed from the (possibly newer) taxonomy rather than
    // trusted from the stored value: an intent whose matchers have since
    // changed must not carry an out-of-date classification back onto a form.
    // The stored `topic` field is used only when the classifier declines to
    // classify a legacy question and something already keyed it explicitly.
    const classified = classifyIntent(question);
    const storedTopic =
      typeof entry.topic === "string" && entry.topic.trim() !== ""
        ? entry.topic.trim()
        : null;
    const topic =
      classified !== null
        ? classified.slug
        : storedTopic !== null && canonicalTopicBySlug(storedTopic) !== null
          ? storedTopic
          : null;

    const stored: StoredAnswer = {
      topic,
      question: question.toLowerCase().slice(0, MAX_QUESTION_LENGTH),
      answer: answer.slice(0, MAX_ANSWER_LENGTH),
      answeredAt:
        typeof entry.answeredAt === "string" && entry.answeredAt.trim() !== ""
          ? entry.answeredAt.trim()
          : "",
    };

    // Newest wins per intent, and per question when no intent is known.
    const identity = stored.topic !== null ? `topic:${stored.topic}` : `question:${stored.question}`;
    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);

    answers.push(stored);
    if (answers.length >= STORED_ANSWER_LIMIT) break;
  }
  return answers;
}

/**
 * A resolved answer, tagged with where it came from. The fill layer logs the
 * source so a reviewer can tell a column-backed answer from an intent-keyed
 * stored answer from a canonical boilerplate default — three very different
 * signals about how much this answer should be trusted.
 */
export type ResolvedAnswer = {
  /** The string the fill layer should type into (or select on) the field. */
  answer: string;
  /**
   * Where the answer came from, in order of the ladder in `resolveAnswer`:
   *
   *  · `profile_column`   — a typed column already held it. Highest trust.
   *  · `stored_by_intent` — the candidate answered this intent before,
   *                          possibly on a different employer's form.
   *  · `stored_by_question` — a fuzzy-substring hit on the raw question text,
   *                            used only when the classifier did not recognise
   *                            the intent (legacy compatibility).
   *  · `canonical_default` — the intent has a boilerplate default and the
   *                            question is a boilerplate one. See
   *                            `CANONICAL_TOPICS` for why each default is safe.
   */
  source:
    | "profile_column"
    | "stored_by_intent"
    | "stored_by_question"
    | "canonical_default";
  /** The intent this resolved through, when one was classified. Never invented. */
  topic: string | null;
};

/**
 * The answer for this question, from the ladder the header on
 * `canonical-topics.ts` describes.
 *
 * The ladder, in order:
 *
 *  1. If the classifier names an intent AND that intent has a `columnLookup`
 *     AND the column is set, return the column-derived answer.
 *  2. If the classifier names an intent AND `storedAnswers` has an entry
 *     keyed by that intent's slug, return the stored answer.
 *  3. If the classifier names an intent AND that intent has a `defaultAnswer`,
 *     return the default. This step is deliberately after (2): a candidate
 *     who has answered a boilerplate question explicitly overrides the
 *     built-in default, forever.
 *  4. If the classifier did NOT name an intent, fall through to the legacy
 *     fuzzy-substring match on the raw question text. `stored_answers` rows
 *     that predate this module keep working, and a question the taxonomy has
 *     not yet learned to recognise still finds a previously-typed answer.
 *  5. Return `null` — escalate to the candidate.
 *
 * `null` means "escalate". A returned `ResolvedAnswer` means "this answer is
 * good enough to type onto the form, subject to the same TypeScript guards
 * every other answer passes through in `lib/fill-application-form.ts`".
 */
export function resolveAnswer(
  question: string,
  profile: CanonicalTopicProfileColumns,
  storedAnswers: readonly StoredAnswer[]
): ResolvedAnswer | null {
  const intent = classifyIntent(question);

  if (intent !== null) {
    // 1. Profile column
    if (typeof intent.columnLookup === "function") {
      const columnValue = intent.columnLookup(profile);
      if (columnValue !== null && columnValue.trim() !== "") {
        return {
          answer: columnValue,
          source: "profile_column",
          topic: intent.slug,
        };
      }
    }

    // 2. Stored answer, keyed by intent slug
    const byIntent = storedAnswers.find((entry) => entry.topic === intent.slug);
    if (byIntent !== undefined && byIntent.answer.trim() !== "") {
      return {
        answer: byIntent.answer,
        source: "stored_by_intent",
        topic: intent.slug,
      };
    }

    // 3. Canonical default (boilerplate only)
    if (typeof intent.defaultAnswer === "string" && intent.defaultAnswer.trim() !== "") {
      return {
        answer: intent.defaultAnswer,
        source: "canonical_default",
        topic: intent.slug,
      };
    }

    // Intent-known but nothing answered it. Escalate rather than fall through
    // to the fuzzy match: a classified intent explicitly declined to answer
    // means every step of the ladder said "not me", and matching by question
    // text at that point would only re-introduce the fuzzy-substring bug
    // this file exists to fix.
    return null;
  }

  // 4. Legacy fuzzy substring on the raw question text. Only reached when
  // the classifier does not recognise the intent, so the taxonomy is the
  // primary path and this is the escape hatch for pre-classifier data or a
  // question the table has not yet learned about.
  const legacy = legacyMatchByQuestion(question, storedAnswers);
  if (legacy !== null) {
    return {
      answer: legacy.answer,
      source: "stored_by_question",
      topic: legacy.topic,
    };
  }

  return null;
}

/**
 * The old fuzzy path, preserved verbatim for questions the classifier does
 * not recognise. Substring containment either direction; ties go to the
 * first stored entry, which by convention is the newest one.
 */
function legacyMatchByQuestion(
  question: string,
  storedAnswers: readonly StoredAnswer[]
): StoredAnswer | null {
  const wanted = normalizeText(question);
  if (wanted === "") return null;

  for (const entry of storedAnswers) {
    if (normalizeText(entry.question) === wanted) return entry;
  }
  if (wanted.length < 10) return null;
  for (const entry of storedAnswers) {
    const candidate = normalizeText(entry.question);
    if (candidate.length < 10) continue;
    if (wanted.includes(candidate) || candidate.includes(wanted)) return entry;
  }
  return null;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A newly-supplied answer, from `additionalAnswers` at the end of a run.
 * The classifier assigns an intent slug if the taxonomy recognises the
 * question, so the write is intent-keyed from the start rather than only
 * from the first read.
 */
export type IncomingAnswer = {
  question: string;
  answer: string;
  /**
   * When the answer arrived from v1-C's escalation flow with an explicit
   * intent slug already attached (v1-C classifies at escalation time and
   * routes the user's answer back by slug), skip the classifier and trust
   * the caller. Optional so a CLI `--answer` flow — which arrives without a
   * slug — still works.
   */
  topic?: string | null;
};

/**
 * Fold newly-supplied answers into the stored list.
 *
 * Newest first. An incoming answer replaces any stored one with the same
 * intent slug or (when no slug is known on either side) the same normalised
 * question. That replacement is the whole point of a canonical intent:
 * "sponsorship" reworded on the twentieth employer's form must not become the
 * twentieth stored row.
 *
 * `neverStored` still governs writes: a demographic question that leaked
 * through the fill layer is dropped here, so the column can never hold one.
 */
export function rememberAnswers(
  stored: readonly StoredAnswer[],
  incoming: readonly IncomingAnswer[],
  options: { now: Date }
): StoredAnswer[] {
  const answeredAt = options.now.toISOString();
  const newEntries: StoredAnswer[] = [];

  for (const raw of incoming) {
    const question = raw.question?.trim() ?? "";
    const answer = raw.answer?.trim() ?? "";
    if (question === "" || answer === "") continue;
    if (EEO_QUESTION_RE.test(question)) continue;

    const explicitTopic =
      typeof raw.topic === "string" && raw.topic.trim() !== "" && canonicalTopicBySlug(raw.topic) !== null
        ? raw.topic.trim()
        : null;
    const topic = explicitTopic ?? classifyIntent(question)?.slug ?? null;

    newEntries.push({
      topic,
      question: question.toLowerCase().slice(0, MAX_QUESTION_LENGTH),
      answer: answer.slice(0, MAX_ANSWER_LENGTH),
      answeredAt,
    });
  }

  const merged: StoredAnswer[] = [];
  const seen = new Set<string>();
  // Incoming first, so a fresh answer wins deduplication and survives the cap.
  for (const entry of [...newEntries, ...stored]) {
    const identity =
      entry.topic !== null
        ? `topic:${entry.topic}`
        : `question:${normalizeText(entry.question)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(entry);
  }
  return merged.slice(0, STORED_ANSWER_LIMIT);
}

/** Whether two lists hold the same answers, so an unchanged list is not written. */
export function sameStoredAnswers(
  a: readonly StoredAnswer[],
  b: readonly StoredAnswer[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index]!;
    return (
      entry.question === other.question &&
      entry.answer === other.answer &&
      entry.topic === other.topic
    );
  });
}

/**
 * The set of intent slugs that carry a post-hire consequence when wrong.
 * Re-exported from `canonical-topics.ts` so callers on the fill path have one
 * import for everything answer-related.
 */
export { ALWAYS_BLOCK_TOPIC_SLUGS } from "@/lib/canonical-topics";

/**
 * Convenience for the fill loop: whether a question, once classified, must
 * escalate rather than accept any softer fallback. Returns `true` for the
 * classifier's `alwaysBlock` intents, `false` for everything else, INCLUDING
 * questions the classifier did not recognise — the fill loop already has its
 * own LEGAL_ATTESTATION_RE ladder for the un-classified case, and this
 * predicate is only ever consulted to *narrow* it.
 */
export function classifiedIntentMustBlock(question: string): {
  intent: CanonicalTopic | null;
  mustBlock: boolean;
} {
  const intent = classifyIntent(question);
  return {
    intent,
    mustBlock: intent !== null && ALWAYS_BLOCK_TOPIC_SLUGS.has(intent.slug),
  };
}

/**
 * The question, folded the way `matchAdditionalAnswer` folds a field key.
 * Case, surrounding whitespace, runs of whitespace, a required marker a form
 * printed in front of the label, and trailing punctuation — nothing else.
 */
function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[*✱]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s:?.!,;]+$/, "");
}

/**
 * Stored answers in the shape `additionalAnswers` has always had, merged under
 * whatever this run was given (JOB-134).
 *
 * The supplied entries come first and win outright, in value and in iteration
 * order, and both halves of that matter. A person answering a question again
 * right now is correcting the record, and `matchAdditionalAnswer` walks this
 * object in insertion order and takes the first key that contains or is
 * contained by the field's own — so a stale stored answer listed first could
 * win a fuzzy match against a fresh one listed second.
 */
export function withStoredAnswers(
  stored: readonly StoredAnswer[],
  supplied: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = { ...supplied };
  const already = new Set(Object.keys(supplied).map(normalizeQuestion));
  for (const entry of stored) {
    if (already.has(normalizeQuestion(entry.question))) continue;
    merged[entry.question] = entry.answer;
  }
  return merged;
}
