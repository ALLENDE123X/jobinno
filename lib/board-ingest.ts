/**
 * JOB-003, part three: the two writes.
 *
 *   1. `seedBoardRegistry()` reads the listing repos, classifies every
 *      application link they publish, and inserts the boards that are not
 *      already known.
 *   2. `ingestBoard()` reads one board off its ATS platform's own API, keeps
 *      the listings a CS intern or new grad could apply to, and upserts them.
 *
 * Both are safe to run again. Neither deletes anything: `boards` inserts skip
 * on conflict and `jobs` inserts update on conflict, so re running the sync is
 * how it is meant to be operated rather than something it survives. There is no
 * delete, no truncate and no reset path in this module, per HARD STOP 5.
 *
 * ── What is not done here, and on purpose ───────────────────────────────────
 * A listing that has closed is left in `jobs` rather than removed. Deciding
 * that a posting is gone means trusting one API read, and a board that answers
 * with an empty array during an outage would erase a candidate's whole shortlist
 * on a schedule. Marking rather than deleting is the right fix and it needs a
 * column, so it is a ticket rather than a line.
 *
 * ── Company names ───────────────────────────────────────────────────────────
 * `boards.company` is seeded from the token, because the listing repos put the
 * employer's name in a table cell rather than in the link (see
 * `lib/ats-boards.ts`). The first successful sync overwrites it with whatever
 * the ATS platform itself reports, which is the employer's own spelling. Lever,
 * Ashby and BambooHR name no employer anywhere in their board responses, so
 * boards on those three keep the placeholder.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import { checkApplyUrl, forLog } from "@/lib/apply-url-guard";
import {
  harvestBoardsFromListingRepos,
  placeholderCompanyName,
  type HarvestedBoard,
} from "@/lib/ats-boards";
import { classifyTitle, readBoardFeed, type FeedJob } from "@/lib/ats-job-feeds";
import { db } from "@/lib/db/client";
import { boards, jobs, type AtsPlatform } from "@/lib/db/schema";

/** A registry row, as the ingest needs it. */
export type BoardRow = {
  id: string;
  ats: AtsPlatform;
  boardToken: string;
  company: string;
};

/**
 * Rows per insert statement. Eleven columns a row, so 200 rows is 2200 bind
 * parameters, comfortably under Postgres's limit of 65535.
 */
const INSERT_CHUNK = 200;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

// ───────────────────────────────────
// 1. The registry
// ───────────────────────────────────

export type SeedSummary = {
  /** Distinct boards the repos named. */
  named: number;
  /** Rows this run actually created. */
  inserted: number;
};

/**
 * Bring the registry up to date with what the listing repos currently publish.
 *
 * Deduplication is left to the database rather than done with a read first.
 * `boards_ats_board_token_key` is the real authority on whether a board is
 * already known, and a select then insert would race two syncs against each
 * other and lose. `onConflictDoNothing` on that key cannot.
 */
export async function seedBoardRegistry(
  harvested?: readonly HarvestedBoard[]
): Promise<SeedSummary> {
  const found = harvested ?? (await harvestBoardsFromListingRepos());
  if (found.length === 0) return { named: 0, inserted: 0 };

  let inserted = 0;
  for (const batch of chunk(found, INSERT_CHUNK)) {
    const returned = await db()
      .insert(boards)
      .values(
        batch.map((entry) => ({
          ats: entry.ats,
          boardToken: entry.boardToken,
          company: placeholderCompanyName(entry.boardToken),
        }))
      )
      .onConflictDoNothing({ target: [boards.ats, boards.boardToken] })
      .returning({ id: boards.id });
    inserted += returned.length;
  }

  console.log(
    `[job-003] registry: ${found.length} board(s) named by the listing repos, ` +
      `${inserted} new`
  );
  return { named: found.length, inserted };
}

// ───────────────────────────────────
// 2. The listings
// ───────────────────────────────────

export type IngestOutcome = {
  boardId: string;
  ats: AtsPlatform;
  boardToken: string;
  status: "ok" | "deferred" | "failed";
  /** Listings the board published, before the relevance filter. */
  seen: number;
  /** Listings that survived it and were written. */
  kept: number;
  /** Listings dropped because their apply URL failed `checkApplyUrl`. */
  rejected: number;
  reason?: string;
};

/**
 * One board, read and written.
 *
 * A failure is returned rather than thrown. One employer taking its board
 * offline is an ordinary Tuesday, and it must not stop the other sixty two
 * boards in the same run from syncing.
 */
export async function ingestBoard(board: BoardRow): Promise<IngestOutcome> {
  const base = { boardId: board.id, ats: board.ats, boardToken: board.boardToken };

  const result = await readBoardFeed(board.ats, board.boardToken);
  if (result.status !== "ok") {
    return { ...base, status: result.status, seen: 0, kept: 0, rejected: 0, reason: result.reason };
  }

  const relevant = result.feed.jobs
    .map((job) => ({ job, relevance: classifyTitle(job.title) }))
    .filter((entry) => entry.relevance.relevant)
    .map(({ job, relevance }) => ({
      job,
      isIntern: relevance.isIntern,
      isNewGrad: relevance.isNewGrad,
    }));

  const { kept, rejected } = screenApplyUrls(board, relevant);
  for (const drop of rejected) {
    console.warn(
      `[sec] ${board.ats}/${board.boardToken}: dropped listing ${forLog(drop.externalId, 120)} ` +
        `because ${drop.reason}. The url was ${JSON.stringify(forLog(drop.url))}.`
    );
  }

  if (kept.length > 0) {
    await upsertJobs(board, kept);
  }

  await db()
    .update(boards)
    .set({
      lastSyncedAt: new Date(),
      // Only when the platform said something. See the module header.
      ...(result.feed.company ? { company: result.feed.company } : {}),
    })
    .where(eq(boards.id, board.id));

  return {
    ...base,
    status: "ok",
    seen: result.feed.jobs.length,
    kept: kept.length,
    rejected: rejected.length,
  };
}

type ClassifiedJob = { job: FeedJob; isIntern: boolean; isNewGrad: boolean };

/** One listing this board published that will not be written, and why. */
export type RejectedListing = { externalId: string; url: string; reason: string };

/**
 * Splits a board's listings into the ones whose apply URL may be stored and the
 * ones whose may not.
 *
 * ── Why a rejected listing is dropped rather than fatal ─────────────────────
 * Failing the board, or the sync, would hand any single tenant on any of these
 * platforms a switch that turns off everybody else's job discovery: one bad
 * `applyUrl` in one posting would stop the other sixty two boards in the run
 * from ever being read. That is the same reasoning `ingestBoard` already
 * applies to a board that is offline, and it points the same way here. The
 * listing is dropped, the reason is logged with the URL that caused it, and the
 * count comes back on the outcome so a spike is visible rather than silent.
 *
 * A dropped listing loses nothing recoverable either. It is one posting that
 * cannot be applied to through this pipeline, and the alternative was applying
 * to it with somebody's real resume at an address the ATS platform does not
 * control.
 *
 * Exported so the screen can be tested without a database, which is where the
 * interesting cases are.
 */
export function screenApplyUrls(
  board: Pick<BoardRow, "ats" | "boardToken">,
  entries: readonly ClassifiedJob[]
): { kept: ClassifiedJob[]; rejected: RejectedListing[] } {
  const kept: ClassifiedJob[] = [];
  const rejected: RejectedListing[] = [];

  for (const entry of entries) {
    const verdict = checkApplyUrl(entry.job.url, {
      ats: board.ats,
      boardToken: board.boardToken,
    });
    if (verdict.ok) {
      kept.push(entry);
    } else {
      rejected.push({
        externalId: entry.job.externalId,
        url: entry.job.url,
        reason: verdict.reason,
      });
    }
  }

  return { kept, rejected };
}

/**
 * One entry per `external_id`, first occurrence winning. See `upsertJobs` for
 * the board that made this necessary.
 *
 * Exported so it can be tested without a database, which is the only way to
 * test the case that actually broke.
 */
export function dedupeByExternalId(entries: readonly ClassifiedJob[]): ClassifiedJob[] {
  const seen = new Map<string, ClassifiedJob>();
  for (const entry of entries) {
    if (!seen.has(entry.job.externalId)) seen.set(entry.job.externalId, entry);
  }
  return [...seen.values()];
}

/**
 * Insert or refresh listings, keyed on `(ats, external_id)`.
 *
 * The update list is deliberately every mapped column but `id`: a board edits
 * a posting's title, moves it to another office and rewrites its description,
 * and the row should follow. `raw` is refreshed for the same reason, since a
 * stale payload is worse than no payload for anything trying to reconstruct
 * what a form asked.
 *
 * ── Why the deduplication above is not paranoia ─────────────────────────────
 * A board really does publish the same posting more than once. Workable's
 * `capula-investment-management-ltd` lists twelve jobs under eight shortcodes,
 * because a posting open in four offices appears once per office, and the
 * shortcode is the posting. Postgres refuses an `on conflict do update` whose
 * own VALUES list names one key twice, with "cannot affect row a second time",
 * so an undeduplicated statement does not write a duplicate row, it writes
 * nothing at all and loses the whole board. Found by running this against the
 * real registry, not reasoned about in advance.
 */
async function upsertJobs(board: BoardRow, entries: readonly ClassifiedJob[]): Promise<void> {
  const rows = dedupeByExternalId(entries).map(({ job, isIntern, isNewGrad }) => ({
    boardId: board.id,
    ats: board.ats,
    externalId: job.externalId,
    title: job.title,
    location: job.location,
    url: job.url,
    description: job.description,
    postedAt: job.postedAt,
    isIntern,
    isNewGrad,
    raw: job.raw,
  }));

  for (const batch of chunk(rows, INSERT_CHUNK)) {
    await db()
      .insert(jobs)
      .values(batch)
      .onConflictDoUpdate({
        target: [jobs.ats, jobs.externalId],
        set: {
          boardId: sql`excluded.board_id`,
          title: sql`excluded.title`,
          location: sql`excluded.location`,
          url: sql`excluded.url`,
          description: sql`excluded.description`,
          postedAt: sql`excluded.posted_at`,
          isIntern: sql`excluded.is_intern`,
          isNewGrad: sql`excluded.is_new_grad`,
          raw: sql`excluded.raw`,
        },
      });
  }
}

// ───────────────────────────────────
// Driving a whole sync
// ───────────────────────────────────

/** Every board the sync should read, oldest sync first so nothing starves. */
export async function listActiveBoards(): Promise<BoardRow[]> {
  const rows = await db()
    .select({
      id: boards.id,
      ats: boards.ats,
      boardToken: boards.boardToken,
      company: boards.company,
    })
    .from(boards)
    .where(eq(boards.active, true))
    .orderBy(sql`${boards.lastSyncedAt} asc nulls first`);

  return rows as BoardRow[];
}

/** The same rows, for a named subset. Used to keep an Inngest step's input small. */
export async function loadBoards(ids: readonly string[]): Promise<BoardRow[]> {
  if (ids.length === 0) return [];
  const rows = await db()
    .select({
      id: boards.id,
      ats: boards.ats,
      boardToken: boards.boardToken,
      company: boards.company,
    })
    .from(boards)
    .where(and(eq(boards.active, true), inArray(boards.id, [...ids])));

  return rows as BoardRow[];
}

export type IngestSummary = {
  boards: number;
  ok: number;
  deferred: number;
  failed: number;
  seen: number;
  kept: number;
  /** Listings dropped by `screenApplyUrls`. Should be zero, and is worth watching. */
  rejected: number;
};

/**
 * Read a set of boards, a few at a time.
 *
 * The concurrency ceiling is politeness rather than throughput: these are other
 * companies' public APIs, being read for free, and there is no deadline here
 * worth being rude about.
 */
export async function ingestBoards(
  rows: readonly BoardRow[],
  concurrency = 4
): Promise<{ summary: IngestSummary; outcomes: IngestOutcome[] }> {
  const outcomes: IngestOutcome[] = new Array(rows.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= rows.length) return;
      const board = rows[index];
      try {
        outcomes[index] = await ingestBoard(board);
      } catch (err) {
        outcomes[index] = {
          boardId: board.id,
          ats: board.ats,
          boardToken: board.boardToken,
          status: "failed",
          seen: 0,
          kept: 0,
          rejected: 0,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
  });
  await Promise.all(runners);

  const summary: IngestSummary = {
    boards: outcomes.length,
    ok: outcomes.filter((outcome) => outcome.status === "ok").length,
    deferred: outcomes.filter((outcome) => outcome.status === "deferred").length,
    failed: outcomes.filter((outcome) => outcome.status === "failed").length,
    seen: outcomes.reduce((total, outcome) => total + outcome.seen, 0),
    kept: outcomes.reduce((total, outcome) => total + outcome.kept, 0),
    rejected: outcomes.reduce((total, outcome) => total + outcome.rejected, 0),
  };

  if (summary.rejected > 0) {
    console.warn(
      `[sec] ${summary.rejected} listing(s) were dropped because their apply URL did not ` +
        `belong to the board that published them. See the [sec] lines above for each one.`
    );
  }

  for (const outcome of outcomes) {
    if (outcome.status === "failed") {
      console.warn(
        `[job-003] ${outcome.ats}/${outcome.boardToken} failed: ${outcome.reason ?? "no reason"}`
      );
    }
  }

  return { summary, outcomes };
}
