/**
 * JOB-319 — one shared formatter for a failed Supabase read, used by both
 * onboarding routing pages so the log lines look the same no matter which
 * one the person hit.
 *
 * Kept small and self-contained: the two callers already know which user
 * and which query the error is about, so all this helper adds is a stable
 * shape for the fields PostgREST fills in beyond `message`. It mirrors the
 * decision `lib/dashboard/dashboard-data.ts` made for its own failed reads
 * (`code`, `details`, `hint` alongside `message`), because `message` alone
 * often does not tell a missing column apart from a policy that refused
 * the row.
 *
 * ── What this deliberately does not do ──────────────────────────────────
 * No user identifying fields are pulled off the error. The user's own id
 * is a UUID that the caller supplies; PostgREST never writes an email into
 * an error body against these two queries, so JOB-311's `redactEmail`
 * helper is not applied here. If a future query changes that (for
 * instance, by embedding a `users` row whose email PostgREST echoes in an
 * error string), the redaction belongs at the call site that decided to
 * hand that email into the query in the first place, not here.
 */

/**
 * The subset of a supabase-js error the two onboarding pages log. Typed
 * narrowly rather than importing `PostgrestError` so this file has no
 * dependency on `@supabase/supabase-js` and stays useful for anything else
 * that hits the same failure shape.
 */
export type SupabaseReadErrorLike = {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
};

/**
 * Turns whatever supabase-js handed back into one log line's worth of
 * fields, joined so it reads on a single console line but still has each
 * name visible. A non-object error (a raw string, a plain thrown value)
 * falls through as `String(error)` on the message field so the caller
 * still gets something rather than "[object Object]" from a JSON.stringify.
 */
export function describeSupabaseReadError(error: unknown): string {
  if (error === null || error === undefined) return "no error";

  if (typeof error !== "object") {
    return `message=${String(error)}`;
  }

  const detail = error as SupabaseReadErrorLike;
  const parts: string[] = [];

  parts.push(`message=${stringOrNull(detail.message)}`);
  parts.push(`code=${stringOrNull(detail.code)}`);
  parts.push(`details=${stringOrNull(detail.details)}`);
  parts.push(`hint=${stringOrNull(detail.hint)}`);

  return parts.join(" ");
}

function stringOrNull(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  return String(value);
}
