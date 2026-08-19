/**
 * JOB-008 — the one way to start a search.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 * `discoverListings` has been a real, working, registered Inngest function
 * since JOB-004, and nothing in this repository has ever sent the event that
 * triggers it. A durable pipeline with no trigger is a pipeline that has never
 * run, and it presents as nothing at all: no error, no empty dashboard, no
 * failing test. So the trigger is a named module rather than an
 * `inngest.send()` inlined wherever the first caller happens to be.
 *
 * Two callers, and they need different things from the same event:
 *
 *  · `inngest/job-search-schedule.ts`, the daily cron, which sends inside a
 *    durable function and must therefore go through `step.sendEvent` rather
 *    than through the client directly. It takes `jobSearchEvent` and does its
 *    own sending.
 *  · JOB-009's dashboard, whose "Find Jobs Now" button is an ordinary server
 *    side call with no Inngest run around it. It takes `requestJobSearch`.
 *
 * Both build the payload here, so the event's shape has one definition.
 *
 * ── The contract JOB-009 should hold this to ────────────────────────────────
 * `requestJobSearch(userId)` and nothing else is required. Preferences are
 * optional and a call that passes none is the intended shape: the person's
 * stored `target_locations` are read during matching, and every board is in
 * scope by default. Returning `void` is deliberate too — the event is
 * accepted or it throws, and the run's outcome arrives later, in the
 * `applications` rows the dashboard is already reading.
 */

import {
  JOB_SEARCH_REQUESTED,
  inngest,
  type JobSearchRequestedData,
} from "@/inngest/job-application-pipeline";
import type { MatchPreferences } from "@/lib/job-matching";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The event, built and checked but not sent.
 *
 * Exported for the cron, which has to hand its events to `step.sendEvent`
 * instead of to the client so that a retry of that step does not re-send them.
 *
 * The preferences key is omitted entirely when nothing narrows the search,
 * rather than set to an empty object. An event carrying `preferences: {}` and
 * one carrying no preferences at all mean the same thing to the handler, and
 * the shorter one is the one that reads correctly in the Inngest dashboard.
 */
export function jobSearchEvent(
  userId: string,
  preferences?: MatchPreferences
): { name: typeof JOB_SEARCH_REQUESTED; data: JobSearchRequestedData } {
  const id = String(userId ?? "").trim();
  if (!UUID_RE.test(id)) {
    // Checked here rather than only in the handler. A malformed id sent from a
    // dashboard button fails as a run somebody has to go and look at; the same
    // id refused here fails in the request that caused it, where the person who
    // pressed the button can be told.
    throw new Error(
      `requestJobSearch needs a profiles.id UUID, got ${JSON.stringify(userId)}.`
    );
  }

  const narrowed = trimPreferences(preferences);

  return {
    name: JOB_SEARCH_REQUESTED,
    data: { userId: id, ...(narrowed === undefined ? {} : { preferences: narrowed }) },
  };
}

/**
 * Ask for a search for one person.
 *
 * Resolves once Inngest has accepted the event, which is not the same as the
 * search having finished and is not meant to be: a fan out drives real browsers
 * against real employers and takes minutes to hours.
 */
export async function requestJobSearch(
  userId: string,
  preferences?: MatchPreferences
): Promise<void> {
  await inngest.send(jobSearchEvent(userId, preferences));
}

/**
 * Drops the fields that would narrow nothing.
 *
 * An empty string and an empty array both mean "I did not specify this", and
 * both have to be removed here rather than passed on, because the handler reads
 * a present `companies: []` as an allowlist of no boards if it is not careful
 * and this is the cheaper place to be careful.
 */
function trimPreferences(preferences?: MatchPreferences): MatchPreferences | undefined {
  if (!preferences) return undefined;

  const companies = (preferences.companies ?? [])
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry !== "");
  const locations = (preferences.locations ?? [])
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry !== "");
  const title = String(preferences.title ?? "").trim();

  const narrowed: MatchPreferences = {
    ...(companies.length > 0 ? { companies } : {}),
    ...(locations.length > 0 ? { locations } : {}),
    ...(title === "" ? {} : { title }),
  };

  return Object.keys(narrowed).length === 0 ? undefined : narrowed;
}
