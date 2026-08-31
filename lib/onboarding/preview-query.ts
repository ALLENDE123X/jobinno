/**
 * JOB-309 — the query behind the zero cost preview page.
 *
 * Up to `limit` real, already screened listings and nothing else: no
 * personalization (that is explicitly out of scope until a resume has been
 * parsed) and nothing invented for a card that has not matched anything.
 * Every field a preview card renders comes straight off a `jobs` or `boards`
 * row, per HARD STOP 9.
 *
 * ── What "CS intern shaped" means here ──────────────────────────────────────
 * `jobs` only ever holds postings that already cleared `classifyTitle`'s
 * combined discipline-and-career-stage gate at ingest time (see the long
 * comment on that function in lib/ats-job-feeds.ts): a row would not exist in
 * this table at all unless its title named a software role AND an internship
 * or a new grad stage. So `is_intern = true` alone is the whole filter; there
 * is no separate discipline check left to reapply.
 *
 * ── Primary query, then a fallback, then nothing ────────────────────────────
 * The primary query asks for intern rows only, off an active board, newest
 * first. `boards.active` is the same manual curation gate
 * lib/job-matching.ts filters on — a board that has not proven a real
 * submission works never appears here.
 *
 * If that returns nothing, board coverage might simply be thin on interns
 * specifically right now, so the fallback drops the intern only filter and
 * asks the same question of any active board's listings, still newest first.
 * If that is also empty, `getPreviewJobs` returns an empty array and
 * preview-view.tsx's own zero match handling takes over with a generic
 * teaser card rather than a fabricated one.
 *
 * ── Why the client is a parameter, not a call ───────────────────────────────
 * Same reasoning `matchJobsForUserInMode` gives in lib/job-matching.ts: a
 * function that takes its client as an argument makes the query shape
 * assertable from a fake object in a fast unit test, rather than requiring a
 * live Postgres for a query this simple. app/onboarding/preview/page.tsx
 * passes the same server client it already built for the profile and resume
 * lookups, so this adds no extra session round trip.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** One card's worth of real data. Nothing on this type is ever generated. */
export type PreviewJob = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  /** The ATS platform this listing's apply flow runs through, e.g. "greenhouse". */
  ats: string;
};

// One literal, not a concatenation: supabase-js infers the row shape by
// parsing the string it is handed. Same rule CANDIDATE_COLUMNS in
// lib/candidate-intake.ts follows for its own select.
const PREVIEW_COLUMNS = "id,title,location,ats,boards!inner(company,active)";

/** How many recent listings to look at before giving up on this pass. */
const DEFAULT_LIMIT = 10;

export async function getPreviewJobs(
  supabase: SupabaseClient,
  limit: number = DEFAULT_LIMIT,
): Promise<PreviewJob[]> {
  const internOnly = await queryJobs(supabase, { internOnly: true, limit });
  if (internOnly.length > 0) return internOnly;
  return queryJobs(supabase, { internOnly: false, limit });
}

async function queryJobs(
  supabase: SupabaseClient,
  opts: { internOnly: boolean; limit: number },
): Promise<PreviewJob[]> {
  let query = supabase
    .from("jobs")
    .select(PREVIEW_COLUMNS)
    // `!inner` above is what makes this filter actually drop the job row
    // rather than just leaving its embed empty. Same reasoning as the
    // boards!inner reads in lib/fill-application-form.ts and
    // lib/submit-application.ts.
    .eq("boards.active", true);

  if (opts.internOnly) {
    query = query.eq("is_intern", true);
  }

  const { data: rows, error } = await query
    .order("posted_at", { ascending: false, nullsFirst: false })
    .limit(opts.limit);

  // A query failure reads as a zero match rather than throwing. The whole
  // point of this page is showing value before asking for anything, and a
  // page that 500s on a flaky read is a worse outcome than falling through
  // to the generic teaser card preview-view.tsx already has for the true
  // zero match case.
  if (error) {
    console.error(`[preview-query] jobs lookup failed: ${error.message}`);
    return [];
  }

  return (rows ?? []).map(toPreviewJob);
}

/**
 * PostgREST returns a to-one embed as an object, but supabase-js's inferred
 * type is not always sure of that. Same guard lib/fill-application-form.ts
 * and lib/submit-application.ts use for the identical boards embed.
 */
function one(value: unknown): Record<string, unknown> {
  const picked = Array.isArray(value) ? value[0] : value;
  return picked !== null && typeof picked === "object"
    ? (picked as Record<string, unknown>)
    : {};
}

function toPreviewJob(row: Record<string, unknown>): PreviewJob {
  const board = one(row.boards);

  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    company: String(board.company ?? ""),
    location: typeof row.location === "string" ? row.location : null,
    ats: String(row.ats ?? ""),
  };
}
