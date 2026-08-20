/**
 * JOB-015 — every skip in the last seven days, aggregated, for whoever operates
 * this product rather than for whoever is applying through it.
 *
 * ── Why the operator side and not the user side ─────────────────────────────
 * JOB-009 already answers the user's question. `lib/dashboard/plain-language.ts`
 * turns a `skip_log.reason` into a sentence and `app/dashboard/dashboard-view.tsx`
 * renders it under "What stopped it" on the row it belongs to, so a person
 * looking at their own dashboard can already read why each of their
 * applications stopped. A per person summary card would restate, above those
 * rows, numbers a person can get by counting the rows.
 *
 * The aggregate has no surface at all, and it is the one that answers the
 * question nobody can currently ask: is one ATS platform broken, and is one
 * company's form asking something this pipeline structurally cannot answer.
 * Those are questions about all users at once, so no user's dashboard is ever
 * where they get answered.
 *
 * There is also a set of rows that only this module will ever see.
 * `skip_log_select_via_own_application` grants a read through the owning
 * `applications` row, and `application_id` is nullable, so every skip recorded
 * before an application row existed is invisible to every end user by design.
 * The schema's own note calls that the honest answer because such a row has no
 * owner. It does still have an `ats` and a `reason`, and those are exactly the
 * two columns this rollup is built on.
 *
 * ── Why a rate and not a count ──────────────────────────────────────────────
 * "Greenhouse produced forty skips" is not a finding. Greenhouse is also most
 * of the volume, so forty skips out of four hundred attempts is the system
 * working and forty out of forty five is an outage. Every platform row
 * therefore carries the denominator: how many applications were started against
 * that platform inside the same window, and how many of them reached
 * `submitted`. `skipRate` is null rather than zero when nothing was attempted,
 * because "no attempts to measure against" and "attempted and never skipped"
 * are different statements and only one of them is good news.
 *
 * ── Why Drizzle and the service credentials ─────────────────────────────────
 * Read through `DATABASE_URL` like `lib/job-matching.ts` and JOB-003's board
 * sync, not through `@supabase/supabase-js` like the dashboard. The dashboard
 * reads as the signed in person on purpose, so that row level security is the
 * fence and the `user_id` filter is the second one. This reads across every
 * user by definition, so a user scoped client would return a rollup of one
 * person and call it site wide, which is worse than refusing.
 *
 * Nothing here writes. Every statement below is a SELECT with a GROUP BY, so
 * HARD STOP 5 has nothing to bite on: there is no destructive path to gate.
 */

import { and, eq, gte, isNotNull, lte, sql, type AnyColumn, type SQL } from "drizzle-orm";

import { APPLICATION_STATUS } from "@/lib/application-status";
import { db } from "@/lib/db/client";
import { applications, boards, jobs, skipLog, type SkipReason } from "@/lib/db/schema";

export type RollupDatabase = ReturnType<typeof db>;

/**
 * The window, in days.
 *
 * Seven, because a week is the shortest span over which a board that fails
 * occasionally and a board that fails every time look different. A day of
 * skips against a platform the daily search happened to send four listings to
 * is noise; the same shape over a week is a bug report.
 */
export const DEFAULT_ROLLUP_DAYS = 7;

/** How many rows the two "worst offenders" lists carry. */
export const ROLLUP_LIST_LIMIT = 10;

export type ReasonCount = { reason: SkipReason; skips: number };

export type PlatformRollup = {
  ats: string;
  /** `applications` rows created against this platform inside the window. */
  attempts: number;
  submitted: number;
  /** Clicked submit, outcome unknown. Never retried, so it is its own number. */
  unconfirmed: number;
  skips: number;
  /**
   * Skips logged per application attempted, or null when nothing was attempted
   * to measure against.
   *
   * Deliberately not a percentage, and it can exceed one. `recordSkip` appends,
   * so a single run that stopped on two fields writes two rows, and a skip
   * inside the window can belong to a run started before it. Both are ordinary
   * and neither is a bug, but "300%" reads like one, so this is expressed as a
   * ratio and the bounded number below is the one shown as a percentage.
   */
  skipsPerAttempt: number | null;
  /** Submitted over attempted. The bounded one, and the actual health signal. */
  submitRate: number | null;
  /** Descending, so the first entry is why this platform mostly stops. */
  byReason: ReasonCount[];
};

export type BoardRollup = { ats: string; company: string; skips: number };

/**
 * One question, on one company's form, that the intake data could not answer.
 *
 * This is the actionable end of `unanswerable_required`: a label that shows up
 * repeatedly is either a field the intake should start collecting or a question
 * this product has decided it will never answer, and the count is what tells
 * those two apart.
 */
export type UnansweredQuestion = {
  ats: string;
  company: string;
  fieldLabel: string;
  fieldKind: string | null;
  asked: number;
};

export type SkipRollup = {
  window: { days: number; since: string; until: string };
  totalSkips: number;
  totalAttempts: number;
  totalSubmitted: number;
  byReason: ReasonCount[];
  byPlatform: PlatformRollup[];
  topBoards: BoardRollup[];
  unansweredQuestions: UnansweredQuestion[];
};

/**
 * `count(*)` as a number.
 *
 * Postgres counts are bigint, and `postgres` hands a bigint back as a string
 * rather than losing precision on it. Without the map every total below would
 * concatenate instead of adding.
 */
const total = () => sql<number>`count(*)`.mapWith(Number);

/** `count(*)` over the subset matching one predicate, in the same pass. */
const totalWhere = (predicate: SQL) => sql<number>`count(*) filter (where ${predicate})`.mapWith(Number);

/** Most first, then alphabetically, so two runs over unchanged data agree. */
const byCountThen = (column: AnyColumn) => sql`count(*) desc, ${column} asc`;

function windowStart(days: number, now: Date): Date {
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - days);
  return since;
}

/**
 * The whole rollup, in four grouped reads.
 *
 * Four rather than one, because the four ask different questions of different
 * grains and a single statement grouped by every column at once would return a
 * row per distinct combination for the caller to re aggregate in memory. The
 * grouping belongs in Postgres, which is the thing holding the rows.
 *
 * `now` is a parameter so a test can pin the window rather than race it.
 */
export async function loadSkipRollup(
  options: { days?: number; limit?: number; now?: Date; database?: RollupDatabase } = {}
): Promise<SkipRollup> {
  const days = options.days ?? DEFAULT_ROLLUP_DAYS;
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`A rollup window has to be a positive whole number of days, got ${days}.`);
  }

  const limit = options.limit ?? ROLLUP_LIST_LIMIT;
  const now = options.now ?? new Date();
  // Resolved after the check above, so a bad window is a complaint about the
  // window rather than about an unset `DATABASE_URL`.
  const database = options.database ?? db();

  const since = windowStart(days, now);
  // `gte`/`lte` and not a raw `sql` comparison: these columns are `timestamp
  // with time zone`, and only the typed helpers run the `Date` through the
  // column's own encoder. A raw template hands the driver a `Date` for a
  // parameter it has been told is timestamptz, which it refuses outright.
  const withinWindow = and(gte(skipLog.createdAt, since), lte(skipLog.createdAt, now));

  // Every skip in the window, split by platform and reason. The denominator
  // arrives from the next query; this one deliberately touches only `skip_log`,
  // because a skip with no `application_id` has nothing to join through.
  const skipRows = await database
    .select({ ats: skipLog.ats, reason: skipLog.reason, skips: total() })
    .from(skipLog)
    .where(withinWindow)
    .groupBy(skipLog.ats, skipLog.reason);

  // The denominator. Counted off `applications` rather than off `jobs`, because
  // the question is how much work was attempted, not how many listings exist.
  const attemptRows = await database
    .select({
      ats: jobs.ats,
      attempts: total(),
      submitted: totalWhere(eq(applications.status, APPLICATION_STATUS.SUBMITTED)),
      unconfirmed: totalWhere(eq(applications.status, APPLICATION_STATUS.SUBMISSION_UNCONFIRMED)),
    })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(and(gte(applications.createdAt, since), lte(applications.createdAt, now)))
    .groupBy(jobs.ats);

  // Which companies' boards stop the most runs. Joined through `jobs` rather
  // than read off a column, because `skip_log` denormalizes the platform and
  // not the company.
  const boardRows = await database
    .select({ ats: skipLog.ats, company: boards.company, skips: total() })
    .from(skipLog)
    .innerJoin(jobs, eq(skipLog.jobId, jobs.id))
    .innerJoin(boards, eq(jobs.boardId, boards.id))
    .where(withinWindow)
    .groupBy(skipLog.ats, boards.company)
    .orderBy(byCountThen(boards.company))
    .limit(limit);

  const questionRows = await database
    .select({
      ats: skipLog.ats,
      company: boards.company,
      fieldLabel: skipLog.fieldLabel,
      fieldKind: skipLog.fieldKind,
      asked: total(),
    })
    .from(skipLog)
    .innerJoin(jobs, eq(skipLog.jobId, jobs.id))
    .innerJoin(boards, eq(jobs.boardId, boards.id))
    .where(
      and(withinWindow, eq(skipLog.reason, "unanswerable_required"), isNotNull(skipLog.fieldLabel))
    )
    .groupBy(skipLog.ats, boards.company, skipLog.fieldLabel, skipLog.fieldKind)
    .orderBy(byCountThen(skipLog.fieldLabel))
    .limit(limit);

  return assemble({ days, since, now, skipRows, attemptRows, boardRows, questionRows });
}

type SkipRow = { ats: string; reason: string; skips: number };
type AttemptRow = { ats: string; attempts: number; submitted: number; unconfirmed: number };
type QuestionRow = {
  ats: string;
  company: string;
  fieldLabel: string | null;
  fieldKind: string | null;
  asked: number;
};

/**
 * The four result sets, joined on the platform name.
 *
 * A full outer join and not an inner one, and that is the whole reason this is
 * a function rather than a fifth query. A platform can have skips and no
 * attempts, because a run started the day before the window and stopped inside
 * it. It can have attempts and no skips, which is the case worth seeing most.
 * Dropping either side would quietly hide the two most interesting rows.
 */
function assemble(input: {
  days: number;
  since: Date;
  now: Date;
  skipRows: SkipRow[];
  attemptRows: AttemptRow[];
  boardRows: BoardRollup[];
  questionRows: QuestionRow[];
}): SkipRollup {
  const platforms = new Map<string, PlatformRollup>();
  const blank = (ats: string): PlatformRollup => ({
    ats,
    attempts: 0,
    submitted: 0,
    unconfirmed: 0,
    skips: 0,
    skipsPerAttempt: null,
    submitRate: null,
    byReason: [],
  });
  const at = (ats: string): PlatformRollup => {
    const existing = platforms.get(ats) ?? blank(ats);
    platforms.set(ats, existing);
    return existing;
  };

  const siteWide = new Map<string, number>();

  for (const row of input.skipRows) {
    const platform = at(row.ats);
    platform.skips += row.skips;
    platform.byReason.push({ reason: row.reason as SkipReason, skips: row.skips });
    siteWide.set(row.reason, (siteWide.get(row.reason) ?? 0) + row.skips);
  }

  for (const row of input.attemptRows) {
    const platform = at(row.ats);
    platform.attempts = row.attempts;
    platform.submitted = row.submitted;
    platform.unconfirmed = row.unconfirmed;
  }

  for (const platform of platforms.values()) {
    platform.byReason.sort(compareCounts((entry) => entry.skips, (entry) => entry.reason));
    if (platform.attempts === 0) continue;
    // Rounded here rather than at each place that renders one, so that no
    // caller has to think about a float artifact. Three places is enough for a
    // ratio read directly and for a rate read as a percentage to one place.
    platform.skipsPerAttempt = round(platform.skips / platform.attempts);
    platform.submitRate = round(platform.submitted / platform.attempts);
  }

  const byPlatform = [...platforms.values()].sort(
    compareCounts((entry) => entry.skips, (entry) => entry.ats)
  );

  return {
    window: {
      days: input.days,
      since: input.since.toISOString(),
      until: input.now.toISOString(),
    },
    totalSkips: byPlatform.reduce((sum, entry) => sum + entry.skips, 0),
    totalAttempts: byPlatform.reduce((sum, entry) => sum + entry.attempts, 0),
    totalSubmitted: byPlatform.reduce((sum, entry) => sum + entry.submitted, 0),
    byReason: [...siteWide.entries()]
      .map(([reason, skips]) => ({ reason: reason as SkipReason, skips }))
      .sort(compareCounts((entry) => entry.skips, (entry) => entry.reason)),
    byPlatform,
    topBoards: input.boardRows,
    unansweredQuestions: input.questionRows.flatMap((row) =>
      // `field_label` is filtered to not null in SQL; this narrows the type
      // rather than trusting the filter to have done it.
      row.fieldLabel === null ? [] : [{ ...row, fieldLabel: row.fieldLabel }]
    ),
  };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Most first, ties broken alphabetically. The same order the SQL uses. */
function compareCounts<T>(count: (entry: T) => number, name: (entry: T) => string) {
  return (a: T, b: T) => count(b) - count(a) || name(a).localeCompare(name(b));
}

/**
 * The rollup as the report somebody reads.
 *
 * Here rather than in the CLI so that the report has one definition, and so
 * that whatever surfaces it next (a scheduled digest, once there is anywhere to
 * send one) does not reinvent the wording.
 */
export function formatSkipRollup(rollup: SkipRollup): string {
  const lines: string[] = [];

  lines.push(
    `Skips over the last ${rollup.window.days} day(s), ${rollup.window.since} to ${rollup.window.until}`,
    `${rollup.totalSkips} skip(s) against ${rollup.totalAttempts} application(s) started, ` +
      `${rollup.totalSubmitted} submitted`
  );

  lines.push("", "Why runs stopped, site wide:");
  if (rollup.byReason.length === 0) lines.push("  nothing was skipped in this window");
  for (const entry of rollup.byReason) lines.push(`  ${entry.reason}: ${entry.skips}`);

  lines.push("", "By ATS platform:");
  if (rollup.byPlatform.length === 0) lines.push("  no activity in this window");
  for (const platform of rollup.byPlatform) {
    const through =
      platform.submitRate === null
        ? "nothing attempted in this window"
        : `${(platform.submitRate * 100).toFixed(1)}% went through`;
    const perAttempt =
      platform.skipsPerAttempt === null ? "" : ` (${platform.skipsPerAttempt.toFixed(2)} per attempt)`;

    lines.push(
      `  ${platform.ats}: ${platform.attempts} attempt(s), ${platform.submitted} submitted, ` +
        `${through}` +
        (platform.unconfirmed > 0 ? `, ${platform.unconfirmed} unconfirmed` : "") +
        `; ${platform.skips} skip(s)${perAttempt}`
    );
    for (const entry of platform.byReason) lines.push(`      ${entry.reason}: ${entry.skips}`);
  }

  lines.push("", "Boards with the most skips:");
  if (rollup.topBoards.length === 0) lines.push("  none");
  for (const board of rollup.topBoards) {
    lines.push(`  ${board.company} on ${board.ats}: ${board.skips}`);
  }

  lines.push("", "Questions the intake data could not answer:");
  if (rollup.unansweredQuestions.length === 0) lines.push("  none");
  for (const question of rollup.unansweredQuestions) {
    lines.push(
      `  ${question.asked}x "${question.fieldLabel}"` +
        (question.fieldKind ? ` (${question.fieldKind})` : "") +
        ` on ${question.company}, ${question.ats}`
    );
  }

  return lines.join("\n");
}
