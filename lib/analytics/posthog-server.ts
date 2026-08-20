/**
 * JOB-014 — capture from the server, for the events a browser cannot honestly
 * report.
 *
 * ── Which events belong here, and why it is not "all of them" ───────────────
 * An event should be fired by whichever runtime actually knows the fact. Three
 * of Jobinno's five do not happen in a browser at all:
 *
 *  · **`session_established`.** The magic link is opened in a browser, but the
 *    thing worth counting is the session existing, and that is decided by
 *    `app/auth/callback/route.ts` exchanging a code. The browser at that moment
 *    is mid redirect and has run no JavaScript of ours.
 *  · **`search_requested` from the cron.** `inngest/job-search-schedule.ts`
 *    runs at one in the afternoon UTC with nobody watching. There is no browser
 *    within a day of it.
 *  · **`application_outcome`.** An application is submitted by a remote
 *    Browserbase session driven from an Inngest function, minutes to hours
 *    after the person who asked for it closed their laptop. A client side event
 *    for this would either not fire or would be a guess.
 *
 * `intake_completed` and the dashboard's `search_requested` are fired here too,
 * from their server actions, for a smaller reason: both are the moment a write
 * actually landed, and the client only knows what the action told it.
 *
 * ── Why nothing in this file throws ─────────────────────────────────────────
 * Every caller is on a path where failing matters: a sign in, an attestation,
 * an application against a real employer. Analytics is the least important
 * thing happening in any of them, and it is not allowed to be the thing that
 * breaks them. So the client is constructed inside a try, capture is inside a
 * try, and the flush is inside a try. A missing key, a bad key, an unreachable
 * host and a PostHog outage all come out the same way: a warning in the log and
 * a resolved promise.
 *
 * ── Why it flushes on every call ────────────────────────────────────────────
 * `posthog-node` batches by default and flushes on a timer, which is right for
 * a long lived process and wrong for every runtime this code has. A Vercel
 * function is frozen the moment its response is returned and an Inngest step
 * ends when its promise resolves, so a batch waiting on a timer is a batch that
 * is never sent. `flushAt: 1` with an awaited `flush()` is PostHog's documented
 * answer for serverless, and `captureServerEvents` exists so that the cron's
 * hundred people cost one flush rather than a hundred.
 */

import { PostHog } from "posthog-node";

import {
  analyticsHost,
  analyticsKey,
  sanitizeProperties,
  type AnalyticsEvent,
} from "@/lib/analytics/events";

const LOG = "[job-014]";

export type ServerCapture = {
  event: AnalyticsEvent;
  /**
   * The Supabase `auth.uid()` and nothing else. Never an email address, never a
   * name. See the identifier note in `lib/analytics/events.ts`.
   */
  distinctId: string;
  properties?: Record<string, unknown>;
};

/**
 * `undefined` means "not decided yet", `null` means "decided, and there is no
 * client". The three way state is what stops a disabled deployment building a
 * client object on every single capture.
 */
let client: PostHog | null | undefined;

function serverClient(): PostHog | null {
  if (client !== undefined) return client;

  const key = analyticsKey();
  if (key === null) {
    client = null;
    return null;
  }

  try {
    client = new PostHog(key, {
      host: analyticsHost(),
      // See the header. Serverless runtimes do not survive a timer.
      flushAt: 1,
      flushInterval: 0,
    });
  } catch (err) {
    console.warn(`${LOG} could not start the PostHog client, capture is off: ${messageOf(err)}`);
    client = null;
  }

  return client;
}

/**
 * Forgets the memoized client.
 *
 * For tests, which change the environment between cases and would otherwise get
 * whichever decision the first case happened to make. Nothing in the running
 * app calls it.
 */
export function resetAnalyticsClientForTests(): void {
  client = undefined;
}

/** One event. Resolves either way; see the header on why it cannot reject. */
export async function captureServerEvent(capture: ServerCapture): Promise<void> {
  await captureServerEvents([capture]);
}

/**
 * Many events, one flush.
 *
 * The cron dispatches a search for everybody due on a given day, and each of
 * those is its own `search_requested` against its own distinct id. Flushing per
 * event would make one Inngest step wait on one HTTP round trip per person.
 */
export async function captureServerEvents(captures: readonly ServerCapture[]): Promise<void> {
  if (captures.length === 0) return;

  const posthog = serverClient();
  if (posthog === null) return;

  for (const capture of captures) {
    const distinctId = String(capture.distinctId ?? "").trim();
    if (distinctId === "") {
      // Sending this anyway would file the event against an empty string, which
      // PostHog is happy to treat as one very busy person.
      console.warn(`${LOG} skipped ${capture.event}: no distinct id to file it against`);
      continue;
    }

    try {
      posthog.capture({
        distinctId,
        event: capture.event,
        properties: sanitizeProperties(capture.event, capture.properties),
      });
    } catch (err) {
      console.warn(`${LOG} could not capture ${capture.event}: ${messageOf(err)}`);
    }
  }

  try {
    await posthog.flush();
  } catch (err) {
    // The events are lost. That is the correct trade against failing the
    // request that produced them, and it is worth a line in the log.
    console.warn(`${LOG} could not flush ${captures.length} event(s) to PostHog: ${messageOf(err)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
