/**
 * The queue view's two reads: what jobinno has sent for the signed in person,
 * and what jobinno is waiting for them to answer. Split from
 * `dashboard-data.ts` because the shapes and the queries differ enough that
 * one function per read is clearer than one function that branches internally.
 *
 * ── Why the user's own client, again ────────────────────────────────────────
 * Both queries run through the caller's cookie scoped Supabase client, which
 * means row level security is the primary fence and the `user_id` filter is
 * the second. See the header on `dashboard-data.ts` for the full argument;
 * it applies here unchanged.
 *
 * ── Why two selects and not one ─────────────────────────────────────────────
 * PostgREST can happily fetch every application for a user in one round trip.
 * The queue view splits them into "applied" and "pending" which requires the
 * same filter on both sides, and the two shapes the page renders are already
 * different: an applied row cares about `submitted_at` and `confirmation_text`,
 * a pending row cares about `escalation_questions` and their created stamp.
 * Two selects keep each shape narrow.
 *
 * ── The escalation column contract ──────────────────────────────────────────
 * `applications.escalation_questions` and `applications.escalation_created_at`
 * are v1-C's columns. They are defined here as the shape v1-C persists, not as
 * a schema this ticket owns. If v1-C's PR reshapes the payload, the reshape
 * lands here and in the escalation form; nothing else in this ticket depends
 * on the exact keys.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { APPLICATION_STATUS } from "@/lib/application-status";

/** Same cap as the main dashboard read: nothing on a real plan can outgrow it. */
export const QUEUE_APPLICATION_LIMIT = 500;

/** One row on the "applied" side of the queue. */
export type AppliedQueueRow = {
  id: string;
  company: string;
  title: string;
  location: string | null;
  url: string | null;
  status: string;
  submittedAt: string | null;
  confirmationText: string | null;
};

/**
 * One question the person still has to answer, in the shape v1-C writes to
 * `applications.escalation_questions`. Fields beyond `question_text` are all
 * optional because the pipeline may not always have a `topic_slug` (unknown
 * intent), and the options list is only meaningful when the form was a fixed
 * enum rather than a free text field.
 */
export type EscalationQuestion = {
  /** The prompt the form showed, verbatim. Always present. */
  question_text: string;
  /**
   * A stable identifier for the intent behind the question, when v1-B's
   * classifier recognised one. Passed back to the resume endpoint so the
   * answer is stored keyed by intent rather than by the truncated prose.
   */
  topic_slug?: string | null;
  /** The board's field name, kept for debugging and for the resume writeback. */
  field_key?: string | null;
  /** Fixed enum options (radio buttons) when the source form had them. */
  question_options?: string[] | null;
};

/** One row on the "pending your input" side of the queue. */
export type PendingQueueRow = {
  id: string;
  company: string;
  title: string;
  location: string | null;
  url: string | null;
  escalationCreatedAt: string | null;
  escalationQuestions: EscalationQuestion[];
};

export type ApplicationQueue = {
  applied: AppliedQueueRow[];
  pending: PendingQueueRow[];
};

/** The two statuses that count as "sent" for the queue view. */
export const APPLIED_STATUSES: readonly string[] = [
  APPLICATION_STATUS.SUBMITTED,
  APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
];

/** The one status that counts as "waiting on you". */
export const PENDING_STATUS = APPLICATION_STATUS.PENDING_USER_INPUT;

const APPLIED_COLUMNS = [
  "id",
  "status",
  "submitted_at",
  "confirmation_text",
  "jobs(title,url,location,boards(company))",
].join(",");

const PENDING_COLUMNS = [
  "id",
  "escalation_questions",
  "escalation_created_at",
  "jobs(title,url,location,boards(company))",
].join(",");

/** Exported so a test can check the select strings against the real schema. */
export const QUEUE_SELECTS = {
  applied: APPLIED_COLUMNS,
  pending: PENDING_COLUMNS,
} as const;

/**
 * Everything a failed queue read is allowed to say out loud. Same rationale as
 * `DASHBOARD_READ_FAILED` on `dashboard-data.ts`: a real PostgREST message
 * teaches a stranger the shape of the schema, and this file's callers are all
 * on the path that ends in a person's browser.
 */
export const QUEUE_READ_FAILED = {
  applied: "Could not load your applied list right now. Try again in a moment.",
  pending: "Could not load your pending list right now. Try again in a moment.",
} as const;

function failRead(where: string, userId: string, error: unknown, shown: string): never {
  const detail = error as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
  console.error(`[v1-d-queue] ${where} failed for user ${userId}:`, {
    message: String(detail?.message ?? error),
    code: detail?.code ?? null,
    details: detail?.details ?? null,
    hint: detail?.hint ?? null,
  });
  throw new Error(shown);
}

function firstOrSelf<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  if (Array.isArray(value)) return (value[0] as T) ?? null;
  return value;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function flattenJob(row: {
  jobs?: unknown;
}): { title: string; url: string | null; location: string | null; company: string } {
  const job = firstOrSelf(
    row.jobs as
      | { title?: string; url?: string | null; location?: string | null; boards?: unknown }
      | { title?: string; url?: string | null; location?: string | null; boards?: unknown }[]
      | null
  );
  const board = firstOrSelf(
    (job?.boards ?? null) as { company?: string } | { company?: string }[] | null
  );
  return {
    title: textOrNull(job?.title) ?? "Untitled role",
    url: textOrNull(job?.url),
    location: textOrNull(job?.location),
    company: textOrNull(board?.company) ?? "Unknown company",
  };
}

function normaliseQuestions(raw: unknown): EscalationQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: EscalationQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const text = typeof q.question_text === "string" ? q.question_text : null;
    if (!text) continue;
    const options = Array.isArray(q.question_options)
      ? q.question_options.filter((v): v is string => typeof v === "string")
      : null;
    out.push({
      question_text: text,
      topic_slug: typeof q.topic_slug === "string" ? q.topic_slug : null,
      field_key: typeof q.field_key === "string" ? q.field_key : null,
      question_options: options && options.length > 0 ? options : null,
    });
  }
  return out;
}

/** The two lists, in one call, for the current user. */
export async function readApplicationQueue(
  supabase: SupabaseClient,
  userId: string
): Promise<ApplicationQueue> {
  const [appliedResult, pendingResult] = await Promise.all([
    supabase
      .from("applications")
      .select(APPLIED_COLUMNS)
      .eq("user_id", userId)
      .in("status", APPLIED_STATUSES as string[])
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(QUEUE_APPLICATION_LIMIT),
    supabase
      .from("applications")
      .select(PENDING_COLUMNS)
      .eq("user_id", userId)
      .eq("status", PENDING_STATUS)
      .order("escalation_created_at", { ascending: false, nullsFirst: false })
      .limit(QUEUE_APPLICATION_LIMIT),
  ]);

  if (appliedResult.error) failRead("readApplicationQueue.applied", userId, appliedResult.error, QUEUE_READ_FAILED.applied);
  if (pendingResult.error) failRead("readApplicationQueue.pending", userId, pendingResult.error, QUEUE_READ_FAILED.pending);

  const applied = ((appliedResult.data ?? []) as unknown[]).map((row): AppliedQueueRow => {
    const r = row as {
      id: string;
      status: string;
      submitted_at: string | null;
      confirmation_text: string | null;
    };
    const job = flattenJob(row as { jobs?: unknown });
    return {
      id: r.id,
      status: r.status,
      submittedAt: r.submitted_at,
      confirmationText: r.confirmation_text,
      ...job,
    };
  });

  const pending = ((pendingResult.data ?? []) as unknown[]).map((row): PendingQueueRow => {
    const r = row as {
      id: string;
      escalation_created_at: string | null;
      escalation_questions: unknown;
    };
    const job = flattenJob(row as { jobs?: unknown });
    return {
      id: r.id,
      escalationCreatedAt: r.escalation_created_at,
      escalationQuestions: normaliseQuestions(r.escalation_questions),
      ...job,
    };
  });

  return { applied, pending };
}
