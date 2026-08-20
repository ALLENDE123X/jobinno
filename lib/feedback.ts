/**
 * Feedback submission, kept out of the widget so the payload shape is testable
 * without rendering anything (JOB-016).
 *
 * ── Why the categories are declared here and not imported ───────────────────
 * The canonical list lives in `lib/db/schema.ts` as `FEEDBACK_CATEGORIES`, and
 * a CHECK constraint on the table enforces it. Importing that module here would
 * drag Drizzle's `pg-core` into the browser bundle for the sake of three string
 * literals, so the list is restated instead. The restatement is not left to
 * trust: `tests/unit/feedback.test.ts` asserts the two lists agree, and that
 * test runs in Node where importing the schema is free.
 *
 * ── Why `submitFeedback` takes its client as an argument ────────────────────
 * The widget is anonymous friendly. RLS on `feedback` allows an insert from
 * both the anon and the authenticated role, so long as `user_id` is either null
 * or the caller's own id, which means the browser client with the publishable
 * anon key is the right client and no server route is needed. Passing it in
 * rather than reaching for a module level singleton keeps the insert callable
 * from a test with a stub that records what it was handed.
 *
 * ── Where the client comes from now, and why it moved (JOB-011) ─────────────
 * This module used to build its own with `createClient` from
 * `@supabase/supabase-js`, back when nothing else in the app owned a browser
 * client. That client kept its session in `localStorage`, and Jobinno's never
 * goes there: sign in finishes in `app/auth/callback/route.ts` on the server
 * and the session is written to cookies, which is the whole reason
 * `lib/supabase/client.ts` uses `createBrowserClient` from `@supabase/ssr`.
 *
 * So the private client could never see a signed in person. Every report it
 * sent was stamped `user_id: null`, including the ones from people we could
 * have written back to, and the column plus its index sat there collecting
 * nulls. The widget now uses the app's own client and the private one is gone.
 * `tests/unit/feedback-session.test.ts` holds that line.
 */

/** The three things a person can be telling us, in submission order. */
export const FEEDBACK_CATEGORY_OPTIONS = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature" },
  { value: "other", label: "Other" },
] as const;

export type FeedbackCategory =
  (typeof FEEDBACK_CATEGORY_OPTIONS)[number]["value"];

/**
 * What goes in the `context` jsonb column. Deliberately three fields and no
 * more: enough to reproduce a report, and nothing that a form was filled with.
 * The schema's own comment on the column says the same.
 */
export interface FeedbackContext {
  page_url: string;
  user_agent: string;
  submitted_at: string;
}

/** One row of `feedback`, in the column names Postgres knows it by. */
export interface FeedbackRow {
  user_id: string | null;
  category: FeedbackCategory;
  body: string;
  context: FeedbackContext;
}

export interface FeedbackInput {
  category: FeedbackCategory;
  body: string;
  /** Null for an anonymous submitter, which is the common case on the landing page. */
  userId?: string | null;
  context: FeedbackContext;
}

/**
 * Reads the three context values off the browser. Split out from the widget so
 * that the capture is a pure function of a `Window` and a clock rather than of
 * whatever globals happen to exist at call time.
 */
export function captureFeedbackContext(
  win: Pick<Window, "location" | "navigator">,
  now: Date = new Date()
): FeedbackContext {
  return {
    page_url: win.location.href,
    user_agent: win.navigator.userAgent,
    submitted_at: now.toISOString(),
  };
}

/**
 * Turns what the widget collected into the row Postgres expects. The body is
 * trimmed here rather than in the widget so that whitespace never reaches the
 * table by way of some other caller.
 */
export function buildFeedbackRow(input: FeedbackInput): FeedbackRow {
  return {
    user_id: input.userId ?? null,
    category: input.category,
    body: input.body.trim(),
    context: input.context,
  };
}

/**
 * The narrow slice of a Supabase client this module uses. Structural, so a test
 * can pass a recorder and a real `SupabaseClient` still satisfies it.
 */
export interface FeedbackInsertClient {
  from(table: string): {
    insert(row: FeedbackRow): PromiseLike<{ error: { message: string } | null }>;
  };
}

export type SubmitFeedbackResult =
  | { ok: true }
  | { ok: false; message: string };

/** The table name, in one place, so the test and the widget cannot drift apart. */
export const FEEDBACK_TABLE = "feedback";

/**
 * Inserts one row. Never throws: the widget turns the result into copy, and a
 * feedback box that explodes while reporting that something exploded is worse
 * than useless.
 */
export async function submitFeedback(
  client: FeedbackInsertClient,
  input: FeedbackInput
): Promise<SubmitFeedbackResult> {
  const row = buildFeedbackRow(input);

  if (row.body.length === 0) {
    return { ok: false, message: "Write something first." };
  }

  try {
    const { error } = await client.from(FEEDBACK_TABLE).insert(row);
    if (error) {
      return { ok: false, message: error.message };
    }
    return { ok: true };
  } catch (thrown) {
    return {
      ok: false,
      message: thrown instanceof Error ? thrown.message : "Unknown failure.",
    };
  }
}
