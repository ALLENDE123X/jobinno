/**
 * JOB-134 — the answers a candidate gives once, kept.
 *
 * ── The problem this exists for ─────────────────────────────────────────────
 * `lib/fill-application-form.ts` escalates a question it cannot answer
 * truthfully, the candidate answers it, and the answer arrives back as
 * `additionalAnswers` — a `--answer` flag on the CLI, or a field on the
 * `job-application/requested` event. `buildFactCatalog` turns each entry into
 * an `answer:`-prefixed fact, which is the highest quality fact in the
 * catalogue because it came from the person themselves.
 *
 * And then the process exits and it is gone. On a real Avery Dennison run the
 * candidate typed "No, I'm not currently subject to a non compete" and that
 * string lived for exactly one invocation. The next employer asks the same
 * thing and the run stops again. Both questions that blocked that application,
 * sponsorship and a non-compete, are asked by close to every US employer.
 *
 * This module is the memory. It holds no policy about what may go on a form:
 * every guard in `fill-application-form.ts` — the attestation ladder,
 * `attestationFactAllowed`, `optionSupportsFact`, `resolveAdditionalAnswer`,
 * read-back — still runs, unchanged, against a stored answer exactly as it runs
 * against one that arrived a second ago. All that changes is how long the
 * answer lives.
 *
 * ── Why this file imports nothing from the fill layer ───────────────────────
 * `lib/fill-application-form.ts` and `lib/candidate-intake.ts` both need this,
 * and `fill-application-form.ts` already imports `candidate-intake.ts`. A
 * dependency in the other direction would close a cycle, and a cycle whose
 * members are regular expressions evaluated at module load is the shape that
 * fails as an undefined constant rather than as an import error. So this module
 * is a leaf: pure functions, no Supabase client, no page, nothing that can act.
 *
 * `lib/form-fields.ts` is the one exception, and it is a leaf too — its only
 * import is a stagehand type. What comes from it is `EEO_FIELD_RE`, and it is
 * applied inside `rememberAnswers` rather than passed in by the caller on
 * purpose. HARD STOP 10 says a demographic answer is never stored, and a rule a
 * caller has to remember to apply is not a way to keep a hard stop.
 */

import { EEO_FIELD_RE } from "@/lib/form-fields";

/** One answer the candidate gave to one question, kept against their profile. */
export type StoredAnswer = {
  /**
   * The question exactly as the form asked it, which is the `needsInput[].key`
   * a previous run reported: the form's own visible label, folded to lower
   * case.
   *
   * Kept verbatim rather than replaced by the canonical topic below, and that
   * is deliberate. It is the record of what the person was actually asked, it
   * is what `buildFactCatalog` puts in the fact's label so the decision layer
   * can see what was answered, and a canonical topic id would tell a reader of
   * a stored row nothing about the sentence the candidate read.
   */
  question: string;
  /** The candidate's own words, verbatim. */
  answer: string;
  /**
   * The canonical topic this question is about, when it names one plainly, and
   * null when it does not. See `canonicalAnswerTopic` for what this is and,
   * more importantly, for what it is not.
   */
  topic: string | null;
  /** When it was answered, ISO 8601. Newest wins when a topic repeats. */
  answeredAt: string;
};

/**
 * How many answers one person's profile keeps.
 *
 * A cap rather than unbounded growth for two reasons, and the second is the one
 * that matters: this blob is read on every fill and every entry becomes a fact
 * in the catalogue handed to the decision model, so an unbounded list is an
 * unbounded prompt. Newest first, so the cap drops the oldest answers, which
 * are also the ones most likely to have gone stale.
 */
export const STORED_ANSWER_LIMIT = 100;

/** Length caps, so one pathological label cannot dominate the stored blob. */
const MAX_QUESTION_LENGTH = 300;
const MAX_ANSWER_LENGTH = 2000;

/**
 * ── Canonical topics, and the narrow thing they are for ─────────────────────
 *
 * Issue #134 item 2 asks that two employers wording the same question
 * differently should not be two separate questions to the candidate, and warns
 * in the same breath that merging two questions which only look alike is how a
 * wrong answer reaches a form. Both halves are right, and they pull in opposite
 * directions, so the split below is the whole design:
 *
 *   · **Reuse across wordings does not happen here.** It happens where it
 *     already happened: a stored answer becomes an `answer:`-keyed fact in
 *     `buildFactCatalog`, whose label quotes the original question verbatim,
 *     and whether that fact answers some *other* employer's differently worded
 *     field is decided field by field by the existing ladder — the decision
 *     call, then `attestationFactAllowed`, then `optionSupportsFact`, then a
 *     read-back of what the control actually holds. Nothing here shortcuts any
 *     of that, and in particular nothing here writes a stored answer onto a
 *     field whose label it never matched. `matchAdditionalAnswer`'s existing
 *     rule, exact key or substring containment, is untouched.
 *
 *   · **A topic is only ever used to decide which stored answers are the same
 *     answer**, so that a person who has answered "are you subject to a non
 *     compete?" on four boards in four wordings carries one entry rather than
 *     four. Getting a topic wrong costs a forgotten answer, which is a run that
 *     escalates a question it could have answered. It cannot put a value on a
 *     form, because putting a value on a form is not something this file does.
 *
 * That asymmetry is why every rule below is a POSITIVE requirement and never a
 * disqualifier. A topic fires only when the question plainly names its subject
 * and, where the subject alone is ambiguous, its qualifiers as well. A question
 * this table does not recognise gets no topic and is kept under its own
 * wording, forever distinct from every other question — which is the safe
 * outcome, and the outcome a gap in the table produces automatically.
 *
 * Two consequences worth naming out loud:
 *
 *  1. `visa_sponsorship_us` requires the question to name the United States in
 *     a form that cannot be the pronoun "us". Issue #108 is why: a sponsorship
 *     question about the UK and a sponsorship question about the US are not the
 *     same question, and a topic table that merged them would hand the second
 *     answer to the first question. "Do you require sponsorship?" with no
 *     jurisdiction at all deliberately gets no topic.
 *
 *  2. A question matching more than one topic gets no topic. A compound
 *     question is not evidence that two topics are one; it is evidence that the
 *     question is about two things, and neither stored answer should be
 *     replaced by it.
 */
const CANONICAL_ANSWER_TOPICS: readonly {
  id: string;
  /** The word the question has to use before it counts as being about this. */
  subject: RegExp;
  /** Everything else that has to be present. All of them, not any of them. */
  qualifiers?: readonly RegExp[];
}[] = [
  {
    // "Are you subject to a non-compete?", "Do you have any non-solicitation
    // obligations to a former employer?", "restrictive covenants". One
    // distinctive noun, no ambiguity, and the exact question that stopped the
    // Avery Dennison run this ticket was written from.
    id: "restrictive_covenant",
    subject:
      /\b(?:non[-\s]?compet\w*|noncompet\w*|non[-\s]?solicit\w*|nonsolicit\w*|restrictive\s+covenant\w*)\b/i,
  },
  {
    // "What are your salary expectations?", "Desired compensation", "Expected
    // pay range". The subject alone is far too broad — a job description is
    // full of the word "compensation" — so the wanting half has to be there
    // too.
    id: "salary_expectation",
    subject: /\b(?:salary|compensation|pay|wage)\b/i,
    qualifiers: [/\b(?:expect\w*|desired|desire|requir\w*|target|range|ask)\b/i],
  },
  {
    // Issue #108's rule, applied to keying rather than to answering. "u.s.",
    // "usa", "united states" and "american" all name the country; a bare "us"
    // does not, because it is also the pronoun every board uses for itself
    // ("sponsorship to work for us"), and reading that as the country is the
    // whole of issue #108 with an extra step. Hence the required dot on the
    // abbreviation, and hence no trailing `\b` on that arm: a question ending
    // "in the U.S.?" has no word boundary after the final dot, and the first
    // draft of this rule missed exactly that question.
    id: "visa_sponsorship_us",
    subject: /\bsponsor\w*\b/i,
    qualifiers: [/\bu\.\s?s\.?(?:\s?a\.?)?|\busa\b|\bunited\s+states\b|\bamerica\w*/i],
  },
  {
    // "Do you have any relatives employed by this company?" Both halves
    // required: "relative" alone appears in questions about relative
    // experience, and "employed" alone is most of a form.
    id: "relatives_at_employer",
    subject:
      /\b(?:relative|relatives|family\s+member\w*|immediate\s+family|spouse|next\s+of\s+kin)\b/i,
    qualifiers: [/\b(?:employ\w*|work\w*)\b/i],
  },
  {
    // "Have you ever been employed by our company?" Three requirements,
    // because the first two on their own describe half of every application
    // form ever written. The third is what makes it about THIS employer, and
    // it is also what keeps a question naming the employer by name — "Have you
    // previously worked at Avery Dennison?" — out of the topic entirely: that
    // one is kept under its own wording, which is correct, since the answer is
    // about one named company and not about employers in general.
    id: "prior_employment_at_employer",
    subject: /\b(?:employ\w*|work\w*|intern\w*)\b/i,
    qualifiers: [
      /\b(?:ever|previously|formerly|in\s+the\s+past|before)\b/i,
      /\b(?:by|for|at|with)\s+(?:us|our\s+(?:compan\w*|organi[sz]ation|firm|team|group)|this\s+(?:compan\w*|organi[sz]ation|firm))\b/i,
    ],
  },
];

/**
 * The canonical topic a question is about, or null when it names none of them
 * plainly or names more than one.
 *
 * Read the note on `CANONICAL_ANSWER_TOPICS` before changing this. A null here
 * is not a failure: it means the answer is kept under the question's own
 * wording and is never merged with any other, which is the conservative
 * outcome.
 */
export function canonicalAnswerTopic(question: string): string | null {
  const text = question.trim();
  if (text === "") return null;

  const matched = CANONICAL_ANSWER_TOPICS.filter(
    (topic) =>
      topic.subject.test(text) &&
      (topic.qualifiers ?? []).every((qualifier) => qualifier.test(text))
  );
  // Exactly one, never "the first of several". See consequence 2 above.
  return matched.length === 1 ? matched[0]!.id : null;
}

/**
 * The question, folded the way `matchAdditionalAnswer` folds a field key, so
 * that "Are you subject to a non-compete?" and "are you subject to a non
 * compete" are one question rather than two.
 *
 * Deliberately conservative about what it removes: case, surrounding
 * whitespace, runs of whitespace, a required marker a form printed in front of
 * the label, and trailing punctuation. Nothing else. Two questions that differ
 * by a word are still two questions.
 */
function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[*✱]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s:?.!,;]+$/, "");
}

/** Whether two answers are answers to the same question. */
function identityOf(entry: StoredAnswer): string {
  return entry.topic !== null ? `topic:${entry.topic}` : `question:${normalizeQuestion(entry.question)}`;
}

/**
 * `profiles.stored_answers` as it comes back from PostgREST, validated.
 *
 * Hand written rather than a zod schema for the reason the rest of this module
 * is a leaf: it is read on the fill path, where the alternative to a rejected
 * entry is not an error message but a silently dropped answer, and every field
 * has exactly one acceptable shape. Anything malformed is dropped rather than
 * repaired — a half readable stored answer is a sentence nobody wrote, and the
 * cost of dropping it is one escalated question.
 */
export function parseStoredAnswers(value: unknown): StoredAnswer[] {
  if (!Array.isArray(value)) return [];

  const answers: StoredAnswer[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const question = typeof entry.question === "string" ? entry.question.trim() : "";
    const answer = typeof entry.answer === "string" ? entry.answer.trim() : "";
    if (question === "" || answer === "") continue;
    // Applied on the way out as well as on the way in. `rememberAnswers` is the
    // only writer this build has, but the column is JSON in a database that
    // outlives any one build, and a demographic answer that somehow reached it
    // must not reach a form because the write side was the only thing checking.
    if (neverStored(question)) continue;

    const stored: StoredAnswer = {
      question: question.slice(0, MAX_QUESTION_LENGTH),
      answer: answer.slice(0, MAX_ANSWER_LENGTH),
      // Recomputed rather than trusted, so that a topic table which has since
      // been narrowed cannot leave a row claiming a topic this build no longer
      // recognises. The stored value is a cache of a pure function.
      topic: canonicalAnswerTopic(question),
      answeredAt:
        typeof entry.answeredAt === "string" && entry.answeredAt.trim() !== ""
          ? entry.answeredAt.trim()
          : "",
    };
    const identity = identityOf(stored);
    if (seen.has(identity)) continue;
    seen.add(identity);
    answers.push(stored);
    if (answers.length >= STORED_ANSWER_LIMIT) break;
  }
  return answers;
}

/**
 * Whether a question is one whose answer is never kept.
 *
 * Exactly one rule, and it is HARD STOP 10: race, gender, veteran status and
 * disability status are answered "decline to self identify" on every form, are
 * never stored and are never transmitted. That a caller managed to supply one —
 * `resolveAdditionalAnswer` refuses to put a supplied answer on a demographic
 * control that offers a decline option — does not make it storable. This is the
 * last place one could be written down, so this is where it is dropped.
 *
 * ── Why there is no second rule, and the bug that says so ───────────────────
 * This function had a `CONSENT_FIELD_RE` arm for one draft, on the reasoning
 * that `resolveAdditionalAnswer` will not fill an agreement checkbox from a
 * supplied answer anyway so storing one is dead weight. The first test written
 * against it failed, and it failed on the exact question this whole ticket was
 * written from: "are you subject to a non-compete AGREEMENT?" contains the word
 * "agreement", so the candidate's own answer to it was silently dropped and
 * never stored.
 *
 * That is JOB-132 rebuilt one layer down. JOB-132 is the fix for a guard that
 * refused a candidate's own answer because the question contained a noun naming
 * a document the question asks ABOUT, and its lesson is that a wording rule
 * only ever catches the phrasings somebody anticipated while a real agreement
 * is recognised by the shape of the control that gives it. There is no control
 * here — `additionalAnswers` is a flat map of strings — so there is no shape to
 * test, and a wording rule with nothing behind it is worse than no rule. The
 * safety it was supposed to add is where it always was: `resolveAdditionalAnswer`
 * still refuses to tick a checkbox or a radio from a supplied answer, stored or
 * not, and `resolveDecision`'s own deterministic consent branch still owns
 * every real agreement box.
 */
function neverStored(question: string): boolean {
  return EEO_FIELD_RE.test(question);
}

/**
 * The stored list with this run's supplied answers folded into it.
 *
 * Newest first, and an incoming answer replaces the stored one it shares an
 * identity with rather than sitting alongside it — that replacement is the only
 * thing a canonical topic is ever used for.
 */
export function rememberAnswers(
  stored: readonly StoredAnswer[],
  supplied: Record<string, string>,
  options: { now: Date }
): StoredAnswer[] {
  const incoming: StoredAnswer[] = [];
  const answeredAt = options.now.toISOString();

  for (const [rawQuestion, rawAnswer] of Object.entries(supplied)) {
    const question = rawQuestion.trim();
    const answer = rawAnswer.trim();
    if (question === "" || answer === "") continue;
    if (neverStored(question)) continue;
    incoming.push({
      question: question.slice(0, MAX_QUESTION_LENGTH),
      answer: answer.slice(0, MAX_ANSWER_LENGTH),
      topic: canonicalAnswerTopic(question),
      answeredAt,
    });
  }

  const merged: StoredAnswer[] = [];
  const seen = new Set<string>();
  // Incoming first, so that the newest answer to a question is the one that
  // survives the deduplication below and the one a `slice` at the cap keeps.
  for (const entry of [...incoming, ...stored]) {
    const identity = identityOf(entry);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(entry);
  }
  return merged.slice(0, STORED_ANSWER_LIMIT);
}

/**
 * Stored answers in the shape `additionalAnswers` has always had, merged under
 * whatever this run was given.
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

/** Whether two lists hold the same answers, so an unchanged list is not written. */
export function sameStoredAnswers(
  a: readonly StoredAnswer[],
  b: readonly StoredAnswer[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index]!;
    return entry.question === other.question && entry.answer === other.answer;
  });
}
