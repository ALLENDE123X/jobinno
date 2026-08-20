/**
 * JOB-009 — everything the dashboard reads, in two queries.
 *
 * ── Why the user's own client and not the service role ──────────────────────
 * Both functions take a `SupabaseClient` and the page hands them the one from
 * `createServerClient()`, which carries the caller's session and is therefore
 * subject to row level security. That is the point. `applications_select_own`,
 * `profiles_select_own` and `skip_log_select_via_own_application` already say
 * that a person sees their own rows and nobody else's, so the `user_id` filter
 * below is the second of two fences rather than the only one: a mistake in it
 * shows somebody an empty page, not somebody else's applications.
 *
 * The service role would have worked and would have been wrong. It bypasses RLS
 * entirely, so the filter would have been the whole of the access control, and
 * `lib/supabase/server.ts` is explicit that it is for the one thing a user
 * scoped client cannot do.
 *
 * ── Why the joins are embedded rather than fetched separately ───────────────
 * A list of applications with no company name against them is not a list of
 * anything, and `applications` holds neither the title nor the company: the
 * first is on `jobs`, the second is a further hop to `boards`. PostgREST
 * resolves both in one round trip through the foreign keys, and `skip_log`
 * comes back the same way through its own. Fetching them per row instead is the
 * usual N+1, on a page whose whole job is to render N rows.
 *
 * The select strings are the one thing here that no type checker can verify: a
 * column that does not exist is a run time PostgREST error and nothing more.
 * `tests/unit/dashboard-data.test.ts` records what this module asks for and
 * checks each name against the real schema, which is the same two sided
 * approach `tests/unit/application-records.test.ts` takes for the same reason.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How many applications the page renders.
 *
 * Set to the largest plan's allowance, so that nobody on a plan today can have
 * a submitted application this page silently hides from them. Paging is the
 * honest answer once somebody has more, and it is named in the PR rather than
 * half built here.
 */
export const DASHBOARD_APPLICATION_LIMIT = 500;

/** One row of the applications list, already flattened for rendering. */
export type DashboardApplication = {
  id: string;
  /** Raw `applications.status`. Translated for display by `plain-language.ts`. */
  status: string;
  company: string;
  title: string;
  /** The listing, when the board still has it up. */
  url: string | null;
  /** ISO 8601, or null when nothing has been submitted. */
  submittedAt: string | null;
  /** Whatever the board showed back after submit. */
  confirmationText: string | null;
  createdAt: string | null;
  /**
   * The newest `skip_log.reason` recorded against this application, or null.
   * A reason code, not prose: `describeSkipReason` owns turning it into a
   * sentence, and keeping the two apart is what lets each be tested on its own.
   */
  skipReason: string | null;
};

export type DashboardQuota = {
  used: number;
  cap: number;
  /** Never negative, even if a counter and a cap ever disagree. */
  remaining: number;
  /** True when nothing further may be applied for, a cap of zero included. */
  atCap: boolean;
};

export type DashboardProfile = {
  /** Null until the person has been through intake. The page gates on this. */
  attestedAt: string | null;
  quota: DashboardQuota;
};

const APPLICATION_COLUMNS = [
  "id",
  "status",
  "submitted_at",
  "confirmation_text",
  "created_at",
  "jobs(title,url,boards(company))",
  "skip_log(reason,created_at)",
].join(",");

const PROFILE_COLUMNS = "attested_at,applications_used,applications_cap";

/** The select strings above, exported so a test can check them against the schema. */
export const DASHBOARD_SELECTS = {
  applications: APPLICATION_COLUMNS,
  profiles: PROFILE_COLUMNS,
} as const;

/**
 * The person's applications, newest first.
 *
 * `userId` comes from `supabase.auth.getUser()` at the call site and never from
 * anything a request carried. A user id that arrives as a parameter from a
 * client is a user id an attacker chooses.
 */
export async function listApplications(
  supabase: SupabaseClient,
  userId: string
): Promise<DashboardApplication[]> {
  const { data, error } = await supabase
    .from("applications")
    .select(APPLICATION_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(DASHBOARD_APPLICATION_LIMIT);

  if (error) throw new Error(`Could not read your applications: ${error.message}`);

  // Cast through `unknown`: `@supabase/supabase-js` types a select string it
  // cannot parse as an error shape rather than as a row, and this project has no
  // generated database types for it to parse against.
  return ((data ?? []) as unknown[]).map((row) => flatten(row));
}

/** The attestation stamp and the allowance, in one read of `profiles`. */
export async function readDashboardProfile(
  supabase: SupabaseClient,
  userId: string
): Promise<DashboardProfile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", userId)
    .maybeSingle();

  if (error) throw new Error(`Could not read your profile: ${error.message}`);
  if (!data) return null;

  const row = first(data) ?? {};
  return {
    attestedAt: text(row.attested_at),
    quota: toQuota(count(row.applications_used), count(row.applications_cap)),
  };
}

/**
 * Used against cap, with the arithmetic done once.
 *
 * Exported because the page and its tests both want a quota built from two
 * numbers without a database in the way, and because `atCap` covering the cap
 * of zero case is a decision worth having in one place: the schema is explicit
 * that a zero cap means "not provisioned to apply", not "no limit".
 */
export function toQuota(used: number, cap: number): DashboardQuota {
  const safeUsed = Math.max(0, used);
  const safeCap = Math.max(0, cap);
  return {
    used: safeUsed,
    cap: safeCap,
    remaining: Math.max(0, safeCap - safeUsed),
    atCap: safeUsed >= safeCap,
  };
}

// ───────────────────────────────────
// Turning a PostgREST row into a flat one
// ───────────────────────────────────

/**
 * An embedded resource, whichever shape it arrives in.
 *
 * PostgREST returns a to-one embed as an object, and `@supabase/supabase-js`
 * without generated types describes it as either. Both are handled rather than
 * asserted away, because the assertion is what breaks on a schema whose foreign
 * key direction the client guessed differently than the database has it.
 */
function first(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return first(value[0]);
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The newest skip against this application.
 *
 * `recordSkip` appends rather than replaces, so a row that was attempted twice
 * carries two reasons and the older one describes a stop that has since been
 * superseded. Sorted here rather than in the query because ordering an embedded
 * resource is per parent in PostgREST and this list is already in memory.
 */
function newestSkipReason(value: unknown): string | null {
  if (!Array.isArray(value)) return text(first(value)?.reason);

  const sorted = [...value]
    .map((entry) => first(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));

  return text(sorted[0]?.reason);
}

function flatten(value: unknown): DashboardApplication {
  const row = first(value) ?? {};
  const job = first(row.jobs);
  const board = first(job?.boards);

  return {
    id: String(row.id ?? ""),
    status: String(row.status ?? ""),
    // A listing whose row went missing should still render as a line the person
    // can see, rather than crash the page it is one of five hundred rows on.
    company: text(board?.company) ?? "Unknown company",
    title: text(job?.title) ?? "Unknown role",
    url: text(job?.url),
    submittedAt: text(row.submitted_at),
    confirmationText: text(row.confirmation_text),
    createdAt: text(row.created_at),
    skipReason: newestSkipReason(row.skip_log),
  };
}
