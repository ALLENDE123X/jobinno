/**
 * v1-C (#143) — the dashboard's resume path for a `pending_user_input` row.
 *
 * `PUT /api/applications/{id}/escalation-answers` with a JSON body of
 * `{ answers: { [fieldKey]: string } }`:
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
 */

import { NextResponse, type NextRequest } from "next/server";

import { clearEscalation, type EscalationQuestion } from "@/lib/application-records";
import {
  parseStoredAnswers,
  rememberAnswers,
  sameStoredAnswers,
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
      { error: "body must be { answers: { [fieldKey]: string } }" },
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

  const service = createServiceRoleClient();
  const now = new Date();

  // ── Persist the answers to profiles.stored_answers ────────────────────────
  //
  // Keyed by the question text — which is the same `needsInput[].key` the
  // pipeline reports and `additionalAnswers` is keyed on, so a stored answer
  // re-enters the fill loop as an ordinary supplied one and every guard runs
  // unchanged. `topicSlug` from v1-B is folded in by `canonicalAnswerTopic`,
  // which `rememberAnswers` recomputes on write so a stale slug from a
  // narrower topic table cannot survive.
  await mergeStoredAnswers(service, session.user.id, questions, answers, now);

  await clearEscalation(service, applicationId, { now });
  console.log(
    `${LOG} applications ${applicationId} → discovered (${questions.length} answer(s) merged)`
  );

  return NextResponse.json({ ok: true, answersMerged: Object.keys(answers).length });
}

function parseAnswers(body: unknown): Record<string, string> | null {
  if (body === null || typeof body !== "object") return null;
  const raw = (body as { answers?: unknown }).answers;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    out[key] = trimmed;
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

async function mergeStoredAnswers(
  supabase: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  questions: readonly EscalationQuestion[],
  answers: Record<string, string>,
  now: Date
): Promise<void> {
  const { data: profileRow, error } = await supabase
    .from("profiles")
    .select("stored_answers")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`profiles lookup failed: ${error.message}`);
  }

  const existing: StoredAnswer[] = parseStoredAnswers(profileRow?.stored_answers);

  // Build the supplied list keyed off the row's own escalation questions, so a
  // body with an extra key is silently ignored. v1-B's `rememberAnswers`
  // accepts an array of `{question, answer, topic?}`; passing the escalation's
  // own `topicSlug` here lets it skip the classifier round-trip since the
  // pipeline already classified at escalation time.
  const questionByKey = new Map(questions.map((q) => [q.fieldKey, q] as const));
  const supplied: { question: string; answer: string; topic?: string | null }[] = [];
  for (const [key, value] of Object.entries(answers)) {
    const q = questionByKey.get(key);
    if (q === undefined) continue;
    supplied.push({ question: q.question, answer: value, topic: q.topicSlug });
  }
  if (supplied.length === 0) return;

  const merged = rememberAnswers(existing, supplied, { now });
  if (sameStoredAnswers(existing, merged)) return;

  const { error: writeError } = await supabase
    .from("profiles")
    .update({ stored_answers: merged, updated_at: now.toISOString() })
    .eq("id", userId);
  if (writeError) {
    throw new Error(`profiles.stored_answers write failed: ${writeError.message}`);
  }
}
