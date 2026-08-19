/**
 * JOB-003, part four: the schedule.
 *
 * One Inngest function, on a cron, doing the two writes in `lib/board-ingest.ts`
 * in order: refresh the board registry from the listing repos, then read every
 * active board off its ATS platform's own API and upsert the listings a CS
 * intern or new grad could apply to.
 *
 * It lives beside `job-application-pipeline.ts` rather than inside it because
 * the two have nothing in common but the Inngest client. That file fans one
 * candidate's search out into one durable run per listing, each driving a real
 * browser; this one is a scheduled read of public JSON that touches no
 * candidate, no browser and no personal data at all. Extending it would have
 * meant a second, unrelated reason for that module to change.
 *
 * The client is imported from there for the one reason that matters: two
 * Inngest clients are two apps, and functions registered under different app
 * ids do not share a dashboard, a concurrency budget or a signing key.
 *
 * ── The schedule ────────────────────────────────────────────────────────────
 * Four times a day, at midnight, six in the morning, noon and six in the
 * evening, UTC. Six hours is a compromise between two real costs: internships
 * at the firms these repos track can fill within a day of opening, so a daily
 * sync is too slow to be useful, while an hourly one is sixty three companies'
 * public APIs read twenty four times a day for free, which is rude and is the
 * kind of thing that gets a user agent blocked.
 *
 * The literal expression is on the constant below, as a line comment, because
 * writing a cron expression inside a block comment is how a star and a slash
 * end up closing it early. See HARD STOP 4 in CLAUDE.md.
 *
 * ── Steps, and why they are chunked ─────────────────────────────────────────
 * Every board could be read in one step. It would also mean that a timeout
 * ninety per cent of the way through re reads ninety per cent of the boards on
 * the retry. Chunking makes a retry cost one chunk. The chunk ids are derived
 * from a memoized step's output, so they are stable across a replay, which is
 * what Inngest needs them to be.
 *
 * ── Reachable since JOB-004 ─────────────────────────────────────────────────
 * `app/api/inngest/route.ts` registers this function, which is what makes the
 * schedule above real: a cron is stored on Inngest's side from what that
 * route's sync reply says, so before it existed this function had a cron
 * expression and no schedule. `npm run sync-boards` still makes the same two
 * calls without Inngest in the way, which is the faster way to run one by
 * hand. See `lib/board-sync-cli.ts`.
 */

// The pipeline's first import is `./load-env`, so importing the client from it
// keeps the ordering that file's header depends on.
import { inngest } from "./job-application-pipeline";

import {
  ingestBoards,
  listActiveBoards,
  loadBoards,
  seedBoardRegistry,
  type IngestSummary,
} from "@/lib/board-ingest";

// Midnight, 06:00, noon and 18:00 UTC. Described in words in the header.
const SYNC_CRON = "0 0,6,12,18 * * *";

/** Boards per step. Sixty three boards is six steps, and a retry costs one. */
const BOARDS_PER_STEP = 12;

export const syncJobBoards = inngest.createFunction(
  {
    id: "sync-job-boards",
    triggers: [{ cron: SYNC_CRON }],
    // One sync at a time. Two overlapping runs would do the same reads twice
    // and race each other's upserts to no benefit at all.
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const registry = await step.run("seed-board-registry", () => seedBoardRegistry());

    // Only the ids cross the step boundary. A step's return value is durable
    // state that outlives the run, and the rest of the row is re read inside
    // the step that needs it, fresh, a moment later.
    const boardIds = await step.run("list-active-boards", async () =>
      (await listActiveBoards()).map((board) => board.id)
    );

    const totals: IngestSummary = {
      boards: 0,
      ok: 0,
      deferred: 0,
      failed: 0,
      seen: 0,
      kept: 0,
    };

    for (let offset = 0; offset < boardIds.length; offset += BOARDS_PER_STEP) {
      const slice = boardIds.slice(offset, offset + BOARDS_PER_STEP);
      const stepId = `ingest-boards-${offset / BOARDS_PER_STEP}`;

      const summary = await step.run(stepId, async () => {
        const rows = await loadBoards(slice);
        const { summary: chunkSummary } = await ingestBoards(rows);
        return chunkSummary;
      });

      totals.boards += summary.boards;
      totals.ok += summary.ok;
      totals.deferred += summary.deferred;
      totals.failed += summary.failed;
      totals.seen += summary.seen;
      totals.kept += summary.kept;
    }

    console.log(
      `[job-003] sync complete: ${registry.inserted} new board(s), ` +
        `${totals.ok} synced, ${totals.deferred} deferred, ${totals.failed} failed, ` +
        `${totals.kept} listing(s) kept of ${totals.seen} seen`
    );

    return { registry, ingest: totals };
  }
);
