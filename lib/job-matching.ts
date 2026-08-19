/**
 * JOB-008 — choosing which listings a person should apply to, out of the
 * listings this product already has.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `discoverListings` used to call `searchJobListings` on every
 * `job-search/requested` event, read the ATS platforms live, and then reconcile
 * the results back to `jobs` rows by apply URL, dropping everything the board
 * sync had not written yet. Its own comment called that a stopgap and named
 * this ticket as the fix, for the reason the comment gave: two independent
 * discovery mechanisms is one too many. JOB-003's sync is the one that owns
 * reading the platforms, on a schedule, into `jobs`; this module reads what it
 * wrote.
 *
 * `lib/search-job-listings.ts` is untouched, and this ticket deliberately did
 * not touch it. One consequence should be said out loud rather than discovered
 * later: `searchJobListings` now has no caller anywhere in the repository. The
 * board sync does not use it — it reads `lib/ats-job-feeds.ts` directly — so
 * `discoverListings` was its last one. What is still imported from that module
 * is `requiresCoverLetterFromQuestions`, which `loadListing` asks of a stored
 * `jobs.raw` payload.
 *
 * Deleting it is not this ticket's call. It is several hundred lines of
 * evidence about how each platform's board API really behaves, gathered against
 * live boards under ACT-018, and the ticket that removes it should be the one
 * that has decided nothing wants that behaviour back.
 *
 * ── What the match is actually made of ──────────────────────────────────────
 * Only signals the schema really carries, which is a shorter list than the old
 * live search accepted:
 *
 *  · **The board allowlist.** `preferences.companies`, matched against
 *    `boards.board_token` and `boards.company`, case insensitively. Omit it and
 *    every active board is in scope, which is the useful default now that the
 *    search is a scheduled thing rather than something a person types.
 *
 *  · **Location.** `jobs.location` is free text the ATS platform published, so
 *    the test is substring containment against the places the person named, the
 *    same reading `searchJobListings` applies to its own location filter. A
 *    listing whose location mentions remote always passes, because a remote
 *    role is in every location the person could have named.
 *
 *  · **Title, only when one is supplied.** See `matchJobsForUser`.
 *
 * And what is deliberately not part of it:
 *
 *  · **A pay floor.** `payMin` is gone from the event, not accepted and
 *    ignored. Greenhouse publishes no compensation at all, so filtering on it
 *    would mean dropping Lever and Ashby listings under the number while
 *    keeping every Greenhouse listing regardless. `JobSearchPreferences` in
 *    `lib/search-job-listings.ts` reached the same conclusion and says so at
 *    length. There is no column for it on `jobs` either. A field that looks
 *    like a pay floor and is not one is worse than no field.
 *
 *  · **Seniority, or whether a role suits a new graduate.** `classifyTitle` in
 *    `lib/ats-job-feeds.ts` already applied that at ingest time: a row only
 *    exists in `jobs` if its title reads as a software engineering role AND as
 *    an internship or a new grad role. Re-testing it here would be a second
 *    copy of a filter that has already run.
 */

import {
  and,
  asc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNotNull,
  notExists,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import { APPLICATION_STATUS } from "@/lib/application-status";
import { db } from "@/lib/db/client";
import { applications, boards, jobs, profiles, resumes } from "@/lib/db/schema";

/** The Drizzle client the statements run on. Injectable so a test can supply its own pool. */
export type MatchDatabase = ReturnType<typeof db>;

/**
 * What a caller may narrow a search with.
 *
 * Every field is optional and an omitted one means "do not narrow on this",
 * never "narrow on nothing and return nothing". A search sent with no
 * preferences at all is the scheduled case and is meant to work: it reads the
 * person's stored `target_locations` and takes every board.
 */
export type MatchPreferences = {
  /**
   * Board identifiers, matched against `boards.board_token` and
   * `boards.company`. A pasted board URL is not resolved here, unlike the live
   * search's `resolveBoard`: this reads a registry that already knows every
   * board by token, so there is nothing to resolve against a URL that a token
   * would not answer better.
   */
  companies?: string[];
  /** A substring of the listing's title. See `matchJobsForUser`. */
  title?: string;
  /** Overrides `profiles.target_locations` for this one search. */
  locations?: string[];
};

/** One matched listing. Small on purpose: this crosses an Inngest step boundary. */
export type JobMatch = {
  jobId: string;
  company: string;
  title: string;
  location: string | null;
};

/**
 * The columns of `profiles` a match is made against, read fresh.
 *
 * `applicationsUsed` and `applicationsCap` are read here rather than cached
 * anywhere because the allowance is the fan out ceiling and it moves underneath
 * this: JOB-010's Stripe webhook resets the counter when somebody pays, and
 * every run of `applyToJob` moves it in both directions.
 */
export type MatchProfile = {
  targetLocations: string[] | null;
  willingToRelocate: boolean | null;
  currentCity: string | null;
  applicationsUsed: number;
  applicationsCap: number;
  /**
   * Null until the person has confirmed at intake that their answers are true.
   * HARD STOP 9: every free text answer a run generates stands on that, and
   * `claimApplicationRow` refuses a profile without it.
   */
  attestedAt: Date | null;
  /**
   * Whether there is a `resumes` row to apply with.
   *
   * Read here rather than discovered later because of what "later" costs. The
   * live search this replaced called `loadCandidate`, which threw when there
   * was no active resume, so a fan out never started for somebody who had not
   * uploaded one. Nothing else in the fan out path checks: `claimApplicationRow`
   * does not, and the resume is not read until `submitApplication` has already
   * opened a browser at a real employer's form. Losing that guard would have
   * turned one legible refusal into N wasted browser sessions.
   */
  hasActiveResume: boolean;
};

/** Why a profile cannot be searched for at all, or null when it can. */
export function searchBlockedReason(profile: MatchProfile): string | null {
  if (profile.attestedAt === null) {
    return (
      "this profile has never attested to its intake. Nothing may be submitted on this " +
      "person's behalf until they have confirmed their answers at /onboarding."
    );
  }
  if (!profile.hasActiveResume) {
    return "this profile has no active resume, so there is nothing for a run to attach.";
  }
  return null;
}

export async function loadMatchProfile(
  userId: string,
  database: MatchDatabase = db()
): Promise<MatchProfile | null> {
  const [row] = await database
    .select({
      targetLocations: profiles.targetLocations,
      willingToRelocate: profiles.willingToRelocate,
      currentCity: profiles.currentCity,
      applicationsUsed: profiles.applicationsUsed,
      applicationsCap: profiles.applicationsCap,
      attestedAt: profiles.attestedAt,
      // `exists` is typed `SQL<unknown>` because Drizzle cannot know what a
      // subquery yields. Postgres yields a boolean here, and saying so is what
      // keeps `MatchProfile.hasActiveResume` a real boolean rather than an
      // `unknown` every caller has to re-narrow.
      hasActiveResume: activeResumeExists(database).mapWith(Boolean),
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  return row ?? null;
}

/**
 * `exists (select 1 from resumes where user_id = profiles.id and is_active)`.
 *
 * Correlated against `profiles` so it can be used both as a selected boolean
 * and as a filter, which is what keeps the readiness rule in one place: the
 * schedule below and a single profile read must agree on what "ready to apply"
 * means, and two copies of a subquery is how they stop agreeing.
 */
function activeResumeExists(database: MatchDatabase) {
  return exists(
    database
      .select({ present: sql`1` })
      .from(resumes)
      .where(and(eq(resumes.userId, profiles.id), eq(resumes.isActive, true)))
  );
}

// ───────────────────────────────────
// The fan out ceiling
// ───────────────────────────────────

/**
 * How many listings to dispatch per remaining application slot.
 *
 * Not 1, because a dispatched listing does not reliably spend a slot.
 * `settleApplicationSlot` in the pipeline hands the reservation back whenever
 * nothing was submitted, which is the whole point of it: a captcha, a dead
 * board and a form nobody could fill honestly are all free. So a fan out sized
 * exactly to the allowance leaves the allowance partly unspent by however much
 * attrition the day's boards produce.
 *
 * Not unbounded either, which is what the old reconcile-against-live-search
 * path effectively was. Every dispatched event is a durable Inngest run, and
 * the ones past the cap cost a `jobs` read and a `profiles` read each before
 * `claimApplicationRow` refuses them.
 *
 * Three is the compromise, and the number is a judgement rather than a
 * measurement: there is no attrition data yet, and the cost of being wrong in
 * this direction is some wasted runs, while the cost of being wrong in the
 * other is a person's paid allowance sitting unused. Worth revisiting against
 * the first real skip rate.
 */
export const FANOUT_MULTIPLIER = 3;

/** `applications_cap - applications_used`, floored at zero. */
export function remainingAllowance(profile: MatchProfile): number {
  return Math.max(0, profile.applicationsCap - profile.applicationsUsed);
}

/** How many listings one search may dispatch, given what is left of the allowance. */
export function fanOutLimit(remaining: number): number {
  return Math.max(0, remaining) * FANOUT_MULTIPLIER;
}

// ───────────────────────────────────
// Predicates
// ───────────────────────────────────

/**
 * A value wrapped for `ilike` containment, with LIKE's own metacharacters
 * escaped.
 *
 * The value is parameterized either way, so this is not about injection. It is
 * about a person who typed "Washington D.C." or a board token with an
 * underscore in it: `_` matches any character in LIKE and `%` matches any run
 * of them, so an unescaped underscore quietly widens the filter. Backslash is
 * Postgres' default LIKE escape character.
 */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Trimmed, lowercased, de-duplicated, empties dropped. */
function normalizeList(values: readonly string[] | null | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = String(value ?? "").trim().toLowerCase();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Where the person is prepared to work, as this search should read it.
 *
 * Three cases, and the difference between them is what `profiles` actually
 * records rather than an inference:
 *
 *  · They named target locations. Those are the answer, whatever
 *    `willing_to_relocate` says, because a stated destination list is a
 *    stated destination list. The schema's own note on the column makes the
 *    same point: "yes, anywhere in the US" and "yes, but only to New York" are
 *    different instructions.
 *  · They named none and said they will not relocate. Then the place they
 *    already are is the only place, so `current_city` is the filter.
 *  · They named none and either will relocate or have not said. Nothing is
 *    known that would exclude a listing, so nothing is filtered.
 */
export function acceptableLocations(
  profile: MatchProfile,
  override?: readonly string[]
): string[] {
  const requested = normalizeList(override);
  if (requested.length > 0) return requested;

  const stored = normalizeList(profile.targetLocations);
  if (stored.length > 0) return stored;

  if (profile.willingToRelocate === false) return normalizeList([profile.currentCity ?? ""]);
  return [];
}

/**
 * Any one named place matching is enough, and a remote listing matches
 * regardless.
 *
 * A listing with no location at all is excluded once this predicate applies,
 * and that is the deliberate half of it. "Overlaps the places you named" is a
 * claim that cannot be made about a null, and the cost of being wrong here is
 * asymmetric: a slot is a scarce, paid thing, and spending one on a listing
 * that turns out to be in another country is worse than not spending it. A
 * person who wants everything says so by naming no locations, which skips this
 * predicate entirely.
 */
function locationPredicate(wanted: readonly string[]): SQL | undefined {
  if (wanted.length === 0) return undefined;

  const clauses = wanted.map((place) => ilike(jobs.location, likeContains(place)));
  // Remote is not one of the named places and does not need to be: a role that
  // can be done from anywhere is in scope wherever the person is.
  clauses.push(ilike(jobs.location, "%remote%"));
  return or(...clauses);
}

/** `lower(column)`, for a case insensitive equality against a normalized list. */
function lower(column: SQLWrapper): SQL {
  return sql`lower(${column})`;
}

function boardPredicate(companies: readonly string[]): SQL | undefined {
  if (companies.length === 0) return undefined;
  return or(
    inArray(lower(boards.boardToken), [...companies]),
    inArray(lower(boards.company), [...companies])
  );
}

// ───────────────────────────────────
// The match
// ───────────────────────────────────

export type MatchInput = {
  userId: string;
  profile: MatchProfile;
  preferences?: MatchPreferences;
  /** Hard ceiling on rows returned. Callers pass `fanOutLimit(remaining)`. */
  limit: number;
};

/**
 * The listings this person should be offered next.
 *
 * ── The title heuristic, stated plainly ─────────────────────────────────────
 * When `preferences.title` is supplied it becomes one case insensitive
 * substring test against `jobs.title` and nothing more. It is not the live
 * search's every-word-must-appear match over title plus department plus team,
 * because `jobs` stores none of the latter two, and pretending otherwise would
 * be a filter that reads stricter than it is.
 *
 * When it is absent, matching is title blind, and the safety of that rests
 * entirely on `classifyTitle`, which is the only thing standing between this
 * query and a listing in a discipline nobody here asked for. It earns that
 * trust only since the ingest filter was corrected to require a software title
 * AND an internship or new grad role: under the "or" it replaced, "Marketing
 * Intern" and "Investment Banking Summer Analyst Internship" were rows in this
 * table, and a title blind match would have fanned real applications out to
 * them. Nothing here re-checks the discipline, so a widening of that filter is
 * a widening of what a scheduled search will apply to, with no second gate.
 *
 * ── The anti join ───────────────────────────────────────────────────────────
 * Any `applications` row for this person and this listing excludes it, whatever
 * status the row holds. Not only the submitted ones, and the statuses that are
 * not submitted are the interesting half:
 *
 *  · A row at `discovered` or `filling_form` is a run in flight. Dispatching a
 *    second one races it, and `(user_id, job_id)` has no unique index — see
 *    `claimApplicationRow` — so both would insert and the person would see one
 *    listing twice.
 *  · A row at `form_fill_blocked`, `submission_blocked` or `captcha` is a
 *    listing this version could not get through. Re-dispatching it on tomorrow's
 *    cron would spend a browser to be stopped in the same place, daily, forever.
 *    A retry is a thing a person asks for; it is not a thing a schedule does.
 *  · A row at `submitted` or `submission_unconfirmed` must never be reopened at
 *    all. `claimApplicationRow` already refuses those, but by then a run has
 *    started and an employer nearly got a second application.
 *
 * The join is expressed as `not exists` rather than `job_id not in (...)`
 * because `applications_job_id_idx` makes the former a cheap per-row lookup and
 * the latter a materialized list of every listing the person has ever touched.
 */
export async function matchJobsForUser(
  input: MatchInput,
  database: MatchDatabase = db()
): Promise<JobMatch[]> {
  const { userId, profile, preferences, limit } = input;
  if (limit <= 0) return [];

  const title = preferences?.title?.trim() ?? "";

  const conditions: (SQL | undefined)[] = [
    eq(boards.active, true),
    boardPredicate(normalizeList(preferences?.companies)),
    locationPredicate(acceptableLocations(profile, preferences?.locations)),
    title === "" ? undefined : ilike(jobs.title, likeContains(title)),
    notExists(
      database
        .select({ present: sql`1` })
        .from(applications)
        .where(and(eq(applications.jobId, jobs.id), eq(applications.userId, userId)))
    ),
  ];

  const rows = await database
    .select({
      jobId: jobs.id,
      company: boards.company,
      title: jobs.title,
      location: jobs.location,
    })
    .from(jobs)
    .innerJoin(boards, eq(jobs.boardId, boards.id))
    .where(and(...conditions.filter((clause): clause is SQL => clause !== undefined)))
    // Newest first. A posting's age is the best proxy for whether it is still
    // open that this table carries, and JOB-003's own header says internships
    // at these firms can fill within a day of opening. `jobs.id` breaks ties so
    // that two runs over an unchanged table agree on which listings the limit
    // cut off.
    .orderBy(sql`${jobs.postedAt} desc nulls last`, asc(jobs.id))
    .limit(limit);

  return rows;
}

// ───────────────────────────────────
// Who is due for a search
// ───────────────────────────────────

/**
 * The statuses that mean a run is still going.
 *
 * Everything absent from this list is somewhere a run stops: `submitted` and
 * `submission_unconfirmed` are terminal, and the four blocked and errored
 * values are a run that ended needing a human. A person whose only recent rows
 * are those is not mid search; they are done, and due for another.
 */
export const IN_FLIGHT_STATUSES: readonly string[] = [
  APPLICATION_STATUS.DISCOVERED,
  APPLICATION_STATUS.CREATING_ACCOUNT,
  APPLICATION_STATUS.NO_ACCOUNT_REQUIRED,
  APPLICATION_STATUS.AWAITING_VERIFICATION,
  APPLICATION_STATUS.EMAIL_VERIFIED,
  APPLICATION_STATUS.FILLING_FORM,
  APPLICATION_STATUS.FORM_FILLED,
];

/**
 * How recently one of those has to have been created to count as in flight.
 *
 * There is no "search started at" column to read, so the in flight signal is
 * the fan out's own output: a search that is still running has `applications`
 * rows it has not finished with. The window is what stops a row that got stuck
 * from suppressing that person's searches forever — six hours is far longer
 * than a fan out takes, since `applyToJob` runs a handful of browsers at a time
 * and each is minutes rather than hours, and far shorter than the daily cadence
 * below, so a genuinely abandoned row costs at most one skipped day.
 */
export const IN_FLIGHT_WINDOW_HOURS = 6;

/**
 * Everyone a scheduled search should fire for right now.
 *
 * Three conditions, and each excludes a person for a different reason:
 *
 *  · `attested_at` is null, or there is no active resume. They are not ready to
 *    apply, so every run dispatched for them would fail: `claimApplicationRow`
 *    refuses an unattested profile outright, and a run with no resume gets as
 *    far as a real employer's form before discovering it.
 *  · `applications_used >= applications_cap`. Nothing left to spend, and a cap
 *    of zero is the default, so this is also what keeps a signed up account
 *    that has never been provisioned out of the schedule.
 *  · A recent in flight `applications` row. Their last search has not finished.
 */
export async function listUsersDueForSearch(
  database: MatchDatabase = db(),
  now: Date = new Date()
): Promise<string[]> {
  const since = new Date(now.getTime() - IN_FLIGHT_WINDOW_HOURS * 60 * 60 * 1000);

  const rows = await database
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        isNotNull(profiles.attestedAt),
        activeResumeExists(database),
        sql`${profiles.applicationsUsed} < ${profiles.applicationsCap}`,
        notExists(
          database
            .select({ present: sql`1` })
            .from(applications)
            .where(
              and(
                eq(applications.userId, profiles.id),
                inArray(applications.status, [...IN_FLIGHT_STATUSES]),
                gte(applications.createdAt, since)
              )
            )
        )
      )
    )
    .orderBy(asc(profiles.createdAt));

  return rows.map((row) => row.id);
}
