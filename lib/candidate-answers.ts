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
 * ── Why this file imports only `canonical-topics.ts` and zod ────────────────
 * Kept a leaf on purpose. `lib/fill-application-form.ts` imports this
 * module, and if that dependency were closed the cycle its module-load
 * regexes would fail as undefined constants rather than as an import error.
 * `canonical-topics.ts` is also a leaf, so the pair is safe to import from
 * both this file and the fill layer. Zod is an external package and brings no
 * cycle; JOB-170's fabrication rung needs it to validate model responses, and
 * it is deliberately the only new import. Nothing here imports Supabase or
 * any browser-facing module.
 */

import {
  ALWAYS_BLOCK_TOPIC_SLUGS,
  canonicalTopicBySlug,
  classifyIntent,
  type CanonicalTopic,
  type CanonicalTopicProfileColumns,
} from "@/lib/canonical-topics";
import { z } from "zod";

/**
 * ── JOB-170: the LLM fabrication rung ───────────────────────────────────────
 *
 * The product decision of 2026-08-26 (Option A, recorded in
 * `feedback_pipeline_may_fabricate_form_answers` in cross session memory)
 * authorizes this pipeline to answer a form field the rest of the ladder
 * cannot, by asking a text model grounded in the candidate's own intake data.
 * `resolveAnswer` below grew rungs 4 and 5 for it. Escalation stays wired in
 * `lib/fill-application-form.ts` behind that file's ESCALATION_ENABLED gate
 * for the residual cases: EEO questions with no decline option, which are
 * never fabricated and never defaulted (HARD STOP #10), and repeating section
 * entries, where an invented employer or school would be worse than a question.
 *
 * Model and key follow the one proven text generation path in this codebase,
 * `lib/resume-parser.ts`: plain fetch against the OpenAI compatible chat
 * completions endpoint, model `gpt-5.6-luna`, paid by RESUME_LLM_API_KEY with
 * the same fallback to STAGEHAND_LLM_API_KEY that file uses at its line 668.
 * No Anthropic SDK, model string or key exists anywhere in this stack and none
 * was added. Every response is zod validated before use, per the house rule.
 *
 * Spending caveat, kept here so the next reader sees it: RESUME_LLM_API_KEY
 * was budgeted for resume parsing, one call per new user. Fabrication fires
 * once per unanswerable form field per submission per user, which is one to
 * two orders of magnitude more calls. Watch this key's usage after launch and
 * provision a dedicated form fill key if spend outgrows the resume budget.
 */

const FABRICATION_LLM_MODEL = "gpt-5.6-luna";
const FABRICATION_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

/** Bounded like every other model call; a hung request must not hold a browser. */
const FABRICATION_TIMEOUT_MS = 60_000;

/** The resume digest handed to the model, capped for the same reason as above. */
const MAX_FABRICATION_RESUME_CHARS = 20_000;

/**
 * The candidate context `llmFabricate` answers from. Both fields are facts the
 * candidate actually supplied: `intake` is the profile's own answers keyed by
 * field name, and `resume` is a digest derived from their uploaded document.
 * Neither is ever invented here.
 */
export type FabricationContext = {
  intake: Record<string, string>;
  resume: string;
};

/** What one successful fabrication call returned, validated. */
export type FabricatedAnswer = {
  answer: string;
  confidence: number;
  reasoning: string;
};

const FABRICATION_RESPONSE_SCHEMA = z.object({
  answer: z.string().max(2_000),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(2_000),
});

function fabricationApiKey(): string {
  // Same key and same fallback rationale as lib/resume-parser.ts: identical
  // provider and account today, separate variables so the surfaces can be
  // billed and rotated apart when that becomes worth doing.
  const key =
    process.env.RESUME_LLM_API_KEY?.trim() || process.env.STAGEHAND_LLM_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "RESUME_LLM_API_KEY (or STAGEHAND_LLM_API_KEY as a fallback) is required for the " +
        `form answer fabrication rung. See .env.example.`
    );
  }
  return key;
}

const FABRICATION_SYSTEM_PROMPT =
  "You are answering a job application form field on behalf of a candidate. Given their " +
  "intake data and resume, answer the field concisely. If the field is a yes/no about a " +
  "restrictive status (non compete, sponsorship required, prior employment there, relatives " +
  "there), default to No unless intake indicates otherwise. If it is an authorization yes/no " +
  "(work authorized in the US, citizenship, lawful permanent residence), mirror intake. If it " +
  "is a dropdown or radio group, pick the option that matches intake best, else the most " +
  "sensible option offered, and return an option string exactly as offered. NEVER return an " +
  "answer that contradicts explicit intake data, and never invent an atom (a number, date, " +
  "employer, credential or status) the intake and resume do not contain: if nothing grounds " +
  "an honest answer, such as a salary figure the candidate never stated, return an empty " +
  "answer rather than inventing one. If the field is an EEO, demographic or " +
  "self identification question (race, gender, disability, veteran status, sexual " +
  "orientation, ancestry, ethnicity), and the option set includes any variant of decline to " +
  "self identify, prefer not to say, or I don't wish to answer, ALWAYS choose that option.";

/**
 * One text in, one JSON answer out. Mirrors the request shape of
 * `lib/resume-parser.ts`'s structured calls: strict json_schema response
 * format, no tools, no streaming, no retries inside this function.
 *
 * Returns `null` on every failure path (missing key, network error, provider
 * rejection, malformed or empty answer). Rung 4's contract with rung 5 is that
 * a failed call costs the candidate the sane default, never an exception: the
 * ticket is explicit that the ladder falls back without throwing.
 */
export async function llmFabricate(
  question: string,
  options: readonly string[],
  context: FabricationContext
): Promise<FabricatedAnswer | null> {
  const trimmedQuestion = question.trim();
  if (trimmedQuestion === "") return null;

  const intakeLines = Object.entries(context.intake)
    .filter(([key, value]) => key.trim() !== "" && value.trim() !== "")
    .slice(0, 60)
    .map(([key, value]) => `${key}: ${value.slice(0, 200)}`)
    .join("\n");
  const optionLines = options.length > 0
    ? options.map((option, index) => `${index + 1}. ${option.slice(0, 200)}`).join("\n")
    : "(free text field)";
  const user = [
    "Candidate intake data:",
    intakeLines === "" ? "(none recorded)" : intakeLines,
    "",
    "Resume digest:",
    context.resume.trim() === ""
      ? "(none)"
      : context.resume.slice(0, MAX_FABRICATION_RESUME_CHARS),
    "",
    `Form field question: ${trimmedQuestion}`,
    `Options offered by the form:\n${optionLines}`,
    "",
    "Return the answer as JSON with keys answer (string), confidence (number between 0 and 1) and reasoning (string).",
  ].join("\n");

  try {
    const response = await fetch(FABRICATION_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fabricationApiKey()}`,
      },
      body: JSON.stringify({
        model: FABRICATION_LLM_MODEL,
        messages: [
          { role: "system", content: FABRICATION_SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        max_completion_tokens: 300,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "fabricated_answer",
            strict: true,
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
                confidence: { type: "number" },
                reasoning: { type: "string" },
              },
              required: ["answer", "confidence", "reasoning"],
              additionalProperties: false,
            },
          },
        },
      }),
      signal: AbortSignal.timeout(FABRICATION_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(
        `[job-170] fabrication call rejected: HTTP ${response.status} ${response.statusText}`
      );
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      console.warn("[job-170] fabrication call returned no content");
      return null;
    }
    const parsed = FABRICATION_RESPONSE_SCHEMA.safeParse(JSON.parse(content));
    if (!parsed.success) {
      console.warn("[job-170] fabrication response failed validation");
      return null;
    }
    const answer = parsed.data.answer.trim().slice(0, 2_000);
    if (answer === "") {
      // The model correctly declined to invent an atom. That is rung 4 saying
      // "not me", which hands the decision to rung 5 rather than failing.
      return null;
    }
    return {
      answer,
      confidence: parsed.data.confidence,
      reasoning: parsed.data.reasoning.slice(0, 2_000),
    };
  } catch (err) {
    console.warn(
      `[job-170] fabrication call failed, falling back to sane default: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

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
   *  · `llm_fabrication`  — JOB-170. A text model composed it from the
   *                            candidate's own intake data and resume, under
   *                            the Option A product decision of 2026-08-26.
   *                            Audited through `applications.answer_provenance`.
   *  · `sane_default`     — JOB-170. The deterministic last resort, reached
   *                            only when the fabrication call errored.
   */
  source:
    | "profile_column"
    | "stored_by_intent"
    | "stored_by_question"
    | "canonical_default"
    | "llm_fabrication"
    | "sane_default";
  /** The intent this resolved through, when one was classified. Never invented. */
  topic: string | null;
  /** Rung 4 only. The model's own confidence, validated to [0, 1]. */
  confidence?: number;
  /** Rung 4 only. The model's one line account of why it chose this. */
  reasoning?: string;
};

/**
 * One row of `applications.answer_provenance`, the audit trail JOB-170's
 * Change 3 adds. Written once per field that reaches rungs 4 or 5 of the
 * ladder, so a post hoc audit can tell which categories got fabricated across
 * many submissions and what the model actually chose. Column names are
 * snake_case because they are stored as jsonb keys and read back by SQL.
 *
 * `"fabricated_eeo_decline"` is JOB-262's addition. It is written only for
 * the SmartRecruiters and Breezy carve out on `resolveDecision`'s EEO branch
 * in `lib/fill-application-form.ts`, when a required self identification
 * question offered no option `DECLINE_OPTION_RE` recognised but did offer one
 * the wider `EEO_DECLINE_ANALOG_RE` does (an "N/A" or "Not applicable"
 * choice). It is kept apart from `"llm_fabrication"` and `"sane_default"`
 * on purpose: no model ever sees this field and no free text is ever
 * written, only an option the form itself offered, so a later audit should
 * be able to tell the two mechanisms apart at a glance.
 *
 * `"fabricated_eeo_no_decline"` is JOB-298's addition. It is written for
 * the same branch on every board, when a required self identification
 * question offered no option `DECLINE_OPTION_RE` or `EEO_DECLINE_ANALOG_RE`
 * recognises at all and `resolveDecision` picks the permissive neutral
 * default from the options the form itself offered: "No" (or a "no" shaped
 * option) on a veteran status question, otherwise a "prefer not" shaped
 * choice or the first non empty option. It is kept apart from the sources
 * above on the same argument, because the exact same invariants hold: no
 * model ever sees this field, no free text is ever written, only an option
 * the form itself offered, so a later audit should be able to tell the
 * mechanisms apart at a glance.
 */
export type AnswerProvenanceEntry = {
  field_key: string;
  field_label: string;
  question_text: string;
  answered_value: string;
  source:
    | "llm_fabrication"
    | "sane_default"
    | "fabricated_eeo_decline"
    | "fabricated_eeo_no_decline";
  model_confidence?: number;
};

/**
 * Builds one provenance entry from a field and the ladder's resolution for it.
 * Kept next to `ResolvedAnswer` so the stored shape and the resolved shape are
 * changed together or not at all.
 */
export function answerProvenanceEntry(input: {
  fieldKey: string;
  fieldLabel: string;
  questionText: string;
  resolution: ResolvedAnswer;
}): AnswerProvenanceEntry {
  const source = input.resolution.source === "llm_fabrication" ? "llm_fabrication" : "sane_default";
  return {
    field_key: input.fieldKey.slice(0, 300),
    field_label: input.fieldLabel.slice(0, 300),
    question_text: input.questionText.slice(0, 500),
    answered_value: input.resolution.answer.slice(0, 2_000),
    source,
    ...(source === "llm_fabrication" && typeof input.resolution.confidence === "number"
      ? { model_confidence: input.resolution.confidence }
      : {}),
  };
}

/**
 * JOB-262. Builds one `"fabricated_eeo_decline"` provenance entry directly
 * from the field and the option chosen for it, rather than from a
 * `ResolvedAnswer`. There is no `ResolvedAnswer` to build one from here: this
 * path never calls the fabrication rung, never sees a model, and never has a
 * confidence score. It only ever picks an option the form itself already
 * offered, so the entry records that option and nothing else.
 */
export function fabricatedEeoDeclineProvenanceEntry(input: {
  fieldKey: string;
  fieldLabel: string;
  questionText: string;
  chosenOption: string;
}): AnswerProvenanceEntry {
  return {
    field_key: input.fieldKey.slice(0, 300),
    field_label: input.fieldLabel.slice(0, 300),
    question_text: input.questionText.slice(0, 500),
    answered_value: input.chosenOption.slice(0, 2_000),
    source: "fabricated_eeo_decline",
  };
}

/**
 * JOB-298. Builds one `"fabricated_eeo_no_decline"` provenance entry
 * directly from the field and the option chosen for it, mirroring
 * `fabricatedEeoDeclineProvenanceEntry` above for the wider rung that
 * follows the JOB-262 carve out. There is no `ResolvedAnswer` to build one
 * from here either: this path never calls the fabrication rung, never sees a
 * model, and never has a confidence score. It only ever picks an option the
 * form itself already offered, so the entry records that option and nothing
 * else.
 */
export function fabricatedEeoNoDeclineProvenanceEntry(input: {
  fieldKey: string;
  fieldLabel: string;
  questionText: string;
  chosenOption: string;
}): AnswerProvenanceEntry {
  return {
    field_key: input.fieldKey.slice(0, 300),
    field_label: input.fieldLabel.slice(0, 300),
    question_text: input.questionText.slice(0, 500),
    answered_value: input.chosenOption.slice(0, 2_000),
    source: "fabricated_eeo_no_decline",
  };
}

/**
 * The answer for this question, from the ladder the header on
 * `canonical-topics.ts` describes.
 *
 * The ladder, in order (JOB-170 pinned this ordering; it is asserted rung by
 * rung in `tests/unit/llm-fabricate.test.ts`):
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
 *  5. JOB-170: if a fabrication context was supplied, ask `llmFabricate`.
 *     Returns `null` from here only when no context was supplied, when the
 *     question is an EEO one (never fabricated, HARD STOP #10), or when the
 *     call declined or failed.
 *  6. JOB-170: the sane default, reached only when the LLM rung errored or
 *     declined: "No" for a yes/no option pair, else the first option offered.
 *     Never reached for an EEO question.
 *  7. Return `null`, meaning escalate to the candidate.
 *
 * Async since JOB-170 because rung 5 is a network call. Callers that pass no
 * fabrication context get the exact pre-JOB-170 behaviour, one promise later.
 *
 * A returned `ResolvedAnswer` means "this answer is good enough to type onto
 * the form, subject to the same TypeScript guards every other answer passes
 * through in `lib/fill-application-form.ts`".
 */
export async function resolveAnswer(
  question: string,
  profile: CanonicalTopicProfileColumns,
  storedAnswers: readonly StoredAnswer[],
  fabrication?: {
    options?: readonly string[];
    context?: FabricationContext;
  }
): Promise<ResolvedAnswer | null> {
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

    // Intent-known but nothing answered it. Before JOB-170 this escalated;
    // now it falls through to the fabrication rungs below, per Option A.
    // Always-block intents included: the product decision explicitly covers
    // legal attestations, and the fill layer's own guards still read back
    // whatever gets typed. EEO questions are the boundary and are handled
    // under the ladder rather than inside an intent, so they take the same
    // path as any other demographic question.
    return await fabricateOrDefault(question, fabrication);
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

  return await fabricateOrDefault(question, fabrication);
}

/**
 * Rungs 5 and 6 of the ladder in `resolveAnswer`, shared by both of its
 * terminal paths so the ordering cannot drift between them.
 *
 * EEO questions stop here before either rung: a demographic identity is never
 * fabricated and never defaulted (HARD STOP #10), whatever options the field
 * offers. Those escalate, which is the residual case the companion ticket
 * keeps working.
 */
async function fabricateOrDefault(
  question: string,
  fabrication:
    | {
        options?: readonly string[];
        context?: FabricationContext;
      }
    | undefined
): Promise<ResolvedAnswer | null> {
  const topic = classifyIntent(question)?.slug ?? null;

  // HARD STOP #10. Checked on the raw question text, which is what every
  // caller hands this function: the fill layer passes the field label.
  if (EEO_QUESTION_RE.test(question)) return null;

  // 5. LLM fabrication. Only with a supplied context; without one this
  // function keeps its exact pre-JOB-170 contract and returns null.
  if (fabrication?.context !== undefined) {
    const fabricated = await llmFabricate(
      question,
      fabrication.options ?? [],
      fabrication.context
    );
    if (fabricated !== null) {
      return {
        answer: fabricated.answer,
        source: "llm_fabrication",
        topic,
        confidence: fabricated.confidence,
        reasoning: fabricated.reasoning,
      };
    }
  }

  // 6. Sane default, reached only when the LLM rung errored, was not
  // configured, or declined to invent an atom. Deterministic by design: a
  // yes/no pair answers "No", any other option set takes its first entry,
  // and a free text field with nothing behind it escalates rather than
  // typing filler onto a real employer's form.
  const options = (fabrication?.options ?? []).filter((option) => option.trim() !== "");
  if (options.length >= 2) {
    const yesNo = options.filter((option) => /^(yes|no)\b/i.test(option.trim()));
    if (yesNo.length === 2) {
      const no = options.find((option) => /^no\b/i.test(option.trim()));
      if (no !== undefined) {
        return { answer: no.trim(), source: "sane_default", topic };
      }
    }
    const first = options[0]!.trim();
    if (first !== "") return { answer: first, source: "sane_default", topic };
  }

  // 7. Escalate.
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
