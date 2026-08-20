/**
 * JOB-008, part two: the schedule that actually starts searches.
 *
 * `discoverListings` has been registered and reachable since JOB-004 and
 * nothing has ever sent it an event. This is what does, once a day, for
 * everybody who should be searched.
 *
 * It lives beside `board-sync.ts` rather than inside
 * `job-application-pipeline.ts` for the same reason that one does: this asks a
 * question about *people* — who is onboarded, who has allowance left, whose
 * last search has finished — and that is a different concern from running one
 * person's application against one listing. The client is imported from the
 * pipeline because two Inngest clients are two apps, with separate dashboards,
 * concurrency budgets and signing keys.
 *
 * ── The cadence ─────────────────────────────────────────────────────────────
 * Once a day, at one in the afternoon UTC. Two things decided that:
 *
 *  · **Daily rather than hourly**, because the thing being searched moves
 *    slowly relative to the thing doing the searching. `jobs` is refreshed four
 *    times a day by JOB-003's sync, so an hourly search would spend most runs
 *    matching against a table nothing had changed, and each of those runs ends
 *    in real browsers opening against real employers. A person's allowance is
 *    also a finite, paid thing: spending it in one considered daily batch is
 *    closer to what somebody buying 150 applications wants than trickling it
 *    out around the clock.
 *  · **One in the afternoon UTC**, an hour after the sync's midday pass. That
 *    pass reads sixty three boards, so leaving it an hour means the day's
 *    search matches against listings ingested today rather than yesterday.
 *
 * The literal expression is on the constant below, as a line comment. HARD STOP
 * 4 in CLAUDE.md: a cron expression inside a block comment is how a star and a
 * slash close it early.
 *
 * ── Idempotency, and what it is really made of ──────────────────────────────
 * There is no "last searched at" column, and this ticket does not add one. The
 * signal used instead is the fan out's own output: `listUsersDueForSearch`
 * excludes anybody holding an `applications` row in a non terminal status
 * created inside the last six hours, which is what "their previous search has
 * not finished" looks like from the database. See `lib/job-matching.ts` for the
 * status list and for why the window exists at all.
 *
 * That is deliberately a coarse guard rather than a lock, and it does not have
 * to be more: matching itself excludes every listing a person already has a row
 * for, so the worst a duplicated search can do is match fewer listings than the
 * first one did. Nothing double applies. This exists to stop the wasted work,
 * not to stop a correctness failure, because the correctness failure is closed
 * one layer down.
 */

// The pipeline's first import is `./load-env`, so importing the client from it
// keeps the ordering that file's header depends on.
import { inngest } from "./job-application-pipeline";

import { ANALYTICS_EVENT } from "@/lib/analytics/events";
import { captureServerEvents } from "@/lib/analytics/posthog-server";
import { listUsersDueForSearch } from "@/lib/job-matching";
import { jobSearchEvent } from "@/lib/job-search-trigger";

// 13:00 UTC, every day. Described in words in the header.
const DAILY_SEARCH_CRON = "0 13 * * *";

/**
 * Events per `step.sendEvent`.
 *
 * These payloads are a UUID each, so a hundred of them is a few kilobytes and
 * the chunking is not about size. It is about what a retry costs: one step that
 * sends every event re-sends every event when it fails halfway, and Inngest
 * memoizes at step granularity, so smaller steps mean a smaller replay. Same
 * reasoning as `BOARDS_PER_STEP` in `board-sync.ts`.
 */
const USERS_PER_STEP = 100;

export const scheduleJobSearches = inngest.createFunction(
  {
    id: "schedule-job-searches",
    triggers: [{ cron: DAILY_SEARCH_CRON }],
    // One at a time. Two overlapping runs would read the same set of people and
    // fan out two searches each, which the in flight window is meant to prevent
    // and would not, because neither run's applications rows exist yet when the
    // other reads.
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    // Only the ids cross the step boundary, and they are re read from nothing:
    // the event needs nothing else about the person, because matching reads the
    // profile itself, fresh, inside `discoverListings`.
    const userIds = await step.run("list-users-due-for-search", () => listUsersDueForSearch());

    if (userIds.length === 0) {
      console.log(
        "[job-008] nobody due for a scheduled search: every profile is either not yet " +
          "attested, missing a resume, out of allowance, or still working through its " +
          "last search."
      );
      return { due: 0, dispatched: 0 };
    }

    for (let offset = 0; offset < userIds.length; offset += USERS_PER_STEP) {
      const slice = userIds.slice(offset, offset + USERS_PER_STEP);
      await step.sendEvent(
        `request-job-searches-${offset / USERS_PER_STEP}`,
        slice.map((userId) => jobSearchEvent(userId))
      );
    }

    // JOB-014. The cron half of `search_requested`, and the reason that event
    // carries a `source` at all: this sends the same event the dashboard button
    // sends, for people who are asleep, and a funnel that cannot tell the two
    // apart is measuring this function rather than the product.
    //
    // Its own step so that Inngest memoizes it. Without one the whole function
    // body re-runs on a retry and everybody due today is counted twice.
    // `captureServerEvents` batches, so a hundred people cost one flush rather
    // than a hundred round trips inside the step.
    await step.run("record-searches-requested", async () => {
      await captureServerEvents(
        userIds.map((userId) => ({
          event: ANALYTICS_EVENT.SEARCH_REQUESTED,
          distinctId: userId,
          properties: { source: "cron" },
        }))
      );
      return { captured: userIds.length };
    });

    console.log(`[job-008] requested a search for ${userIds.length} profile(s)`);
    return { due: userIds.length, dispatched: userIds.length };
  }
);
