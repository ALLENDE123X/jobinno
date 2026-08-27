/**
 * v1-C (#143) — the dashboard's resume path for a `pending_user_input` row.
 *
 * `PUT /api/applications/{id}/escalation-answers` with a JSON body of
 * `{ answers: [{ topicSlug: string | null, question: string, answer: string }, ...] }`:
 *
 *  1. Verifies the signed in user owns the row.
 *  2. Writes every answer back to `profiles.stored_answers` keyed by v1-B's
 *     canonical topic slug when the escalated question had one, so a future
 *     re-ask across boards is answered from stored intent lookup rather than
 *     raw question text.
 *  3. Clears `applications.escalation_questions`, stamps
 *     `escalation_resolved_at`, and flips `status` back to `discovered`.
 *
 * The cron picks the row up on the next tick; the retry uses the
 * newly-saved stored answers and typically no longer re-escalates. If it
 * does re-escalate on a different question, that is fine — the async flow
 * re-fires and the notifier rate-limits itself per row per 6h.
 *
 * The write to `stored_answers` and the update to `applications` both happen
 * through the service role client because `applications` has no user-side
 * UPDATE policy (see the header on the `applications` block in
 * `lib/db/schema.ts`). Authorization is done in this handler, against the
 * signed in user's own session client, before either write.
 *
 * ── v1-BLOCKER-2 (#152): array body, camelCase keys ───────────────────────
 * The body shape is an ordered array whose keys match v1-C's `writeEscalation`
 * output and the reader in `lib/dashboard/queue-data.ts`. Each entry is
 * self-contained: `topicSlug` (may be null when the classifier did not
 * recognise the intent) and `question` (verbatim as the form printed it) let
 * `rememberAnswers` file the answer whether or not a slug was known.
 */

import { NextResponse, type NextRequest } from "next/server";

import { clearEscalation, type EscalationQuestion } from "@/lib/application-records";
import {
  parseStoredAnswers,
  rememberAnswers,
  sameStoredAnswers,
  type IncomingAnswer,
  type StoredAnswer,
} from "@/lib/candidate-answers";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

const LOG = "[v1-c-escalation-resume]";

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params;
  const applicationId = id.trim();
  if (applicationId === "") {
    return NextResponse.json({ error: "application id required" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const answers = parseAnswers(body);
  if (answers === null) {
    return NextResponse.json(
      {
        error:
          "body must be { answers: [{ topicSlug: string | null, question: string, answer: string }, ...] }",
      },
      { status: 400 }
    );
  }
  if (answers.length === 0) {
    return NextResponse.json(
      { error: "answers must contain at least one entry" },
      { status: 400 }
    );
  }

  // Authorization goes through the signed in user's client so RLS decides
  // whether they own the row; the pipeline mutations below go through the
  // service role client because `applications` has no user-side UPDATE
  // policy.
  const sessionClient = await createServerClient();
  const { data: session } = await sessionClient.auth.getUser();
  if (session.user === null) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const { data: ownershipRow, error: ownershipError } = await sessionClient
    .from("applications")
    .select("id,user_id,status,escalation_questions")
    .eq("id", applicationId)
    .maybeSingle();
  if (ownershipError) {
    return NextResponse.json(
      { error: `lookup failed: ${ownershipError.message}` },
      { status: 500 }
    );
  }
  if (ownershipRow === null || ownershipRow.user_id !== session.user.id) {
    // Same 404 either way, so a probe cannot distinguish a row that does
    // not exist from one the caller does not own.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (ownershipRow.status !== "pending_user_input") {
    return NextResponse.json(
      {
        error:
          `application is not pending_user_input (currently "${ownershipRow.status}"); ` +
          `nothing to resume.`,
      },
      { status: 409 }
    );
  }

  const questions = parseEscalationQuestions(ownershipRow.escalation_questions);
  if (questions.length === 0) {
    return NextResponse.json(
      { error: "no escalation questions on this row" },
      { status: 409 }
    );
  }

  // JOB-200: unwrapped, a missing `SUPABASE_URL` or
  // `SUPABASE_SERVICE_ROLE_KEY` throws a framework 500 with a stack trace
  // instead of the JSON error shape the rest of this handler uses. The
  // detail names which variable is empty and stays in the log; the body is
  // generic.
  let service: ReturnType<typeof createServiceRoleClient>;
  try {
    service = createServiceRoleClient();
  } catch (thrown) {
    const detail =
      thrown instanceof Error ? thrown.message : "service role client unavailable";
    console.error(`${LOG} service role client unavailable: ${detail}`);
    return NextResponse.json(
      { error: "server misconfigured" },
      { status: 500 }
    );
  }
  const now = new Date();

  // ── Persist the answers to profiles.stored_answers ────────────────────────
  //
  // Each incoming entry brings its own `question` text (same key the fill loop
  // reports in `needsInput[].key` and looks up on the next run) and, when the
  // pipeline classified it at escalation time, its own `topicSlug`. Passing
  // both to `rememberAnswers` lets it file the answer by slug when there is
  // one and by normalised question when there is not, without a second trip
  // through the classifier.
  const merged = await mergeStoredAnswers(service, session.user.id, answers, now);

  await clearEscalation(service, applicationId, { now });
  console.log(
    `${LOG} applications ${applicationId} → discovered (${merged} answer(s) merged)`
  );

  return NextResponse.json({ ok: true, answersMerged: merged });
}

/**
 * The submit body shape, validated. Returns `null` when the body is not an
 * object with an `answers` array, or when any entry is malformed. Empty-string
 * answers are rejected here so the caller need not check them.
 *
 * A malformed entry (missing `question`, missing `answer`, wrong types) is a
 * bug in the form, not user input to silently drop — the whole request 400s so
 * it shows up loudly. Extra keys on an entry are ignored: only `topicSlug`,
 * `question`, and `answer` are read.
 */
type ParsedAnswer = { topicSlug: string | null; question: string; answer: string };

function parseAnswers(body: unknown): ParsedAnswer[] | null {
  if (body === null || typeof body !== "object") return null;
  const raw = (body as { answers?: unknown }).answers;
  if (!Array.isArray(raw)) return null;
  const out: ParsedAnswer[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const question = typeof e.question === "string" ? e.question.trim() : "";
    const answer = typeof e.answer === "string" ? e.answer.trim() : "";
    if (question === "" || answer === "") return null;
    const topicSlug =
      typeof e.topicSlug === "string" && e.topicSlug.trim() !== ""
        ? e.topicSlug.trim()
        : null;
    out.push({ topicSlug, question, answer });
  }
  return out;
}

function parseEscalationQuestions(value: unknown): EscalationQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: EscalationQuestion[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const fieldKey = typeof entry.fieldKey === "string" ? entry.fieldKey : "";
    const question = typeof entry.question === "string" ? entry.question : "";
    if (fieldKey === "" || question === "") continue;
    out.push({
      fieldKey,
      fieldLabel: typeof entry.fieldLabel === "string" ? entry.fieldLabel : fieldKey,
      question,
      options: Array.isArray(entry.options)
        ? entry.options.filter((v): v is string => typeof v === "string")
        : null,
      required: entry.required === true,
      topicSlug: typeof entry.topicSlug === "string" ? entry.topicSlug : null,
    });
  }
  return out;
}

/**
 * Fold the parsed answers into `profiles.stored_answers`, returning the count
 * of entries actually offered to `rememberAnswers` (before de-duplication).
 * The write is skipped when the merged list is byte-for-byte identical to what
 * was already stored, so a re-submit of the same answers is a no-op.
 */
async function mergeStoredAnswers(
  supabase: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  answers: readonly ParsedAnswer[],
  now: Date
): Promise<number> {
  const { data: profileRow, error } = await supabase
    .from("profiles")
    .select("stored_answers")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`profiles lookup failed: ${error.message}`);
  }

  const existing: StoredAnswer[] = parseStoredAnswers(profileRow?.stored_answers);

  // Each incoming entry carries its own `question` and `topicSlug`, straight
  // from the row's escalation questions via the form. `rememberAnswers`
  // accepts `topic?` optionally, so passing null through skips the classifier
  // round-trip only when v1-C already labelled the intent.
  const supplied: IncomingAnswer[] = answers.map((a) => ({
    question: a.question,
    answer: a.answer,
    topic: a.topicSlug,
  }));
  if (supplied.length === 0) return 0;

  const merged = rememberAnswers(existing, supplied, { now });
  if (sameStoredAnswers(existing, merged)) return supplied.length;

  const { error: writeError } = await supabase
    .from("profiles")
    .update({ stored_answers: merged, updated_at: now.toISOString() })
    .eq("id", userId);
  if (writeError) {
    throw new Error(`profiles.stored_answers write failed: ${writeError.message}`);
  }
  return supplied.length;
}
