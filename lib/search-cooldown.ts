/**
 * The server side rate limit on asking for a job search.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * `app/dashboard/find-jobs-button.tsx` already has a cooldown, and its own
 * header is correct that it is UX and not a guard: it lives in React state, so
 * a reload clears it and a script that never renders it was never subject to it
 * at all. The action behind the button is a public HTTP endpoint. Anything can
 * POST at it in a loop.
 *
 * The money is not what is at risk. `lib/application-quota.ts` reserves against
 * `applications_used < applications_cap` in one conditional UPDATE, so no
 * quantity of redundant searches buys a single extra application. What is at
 * risk is the queue: every accepted call sends another `job-search/requested`,
 * `discoverListings` is configured `concurrency: { limit: 1, key:
 * "event.data.userId" }`, and Inngest serialises rather than drops. A thousand
 * calls become a thousand runs waiting their turn behind each other, for one
 * person, on a shared worker budget.
 *
 * ── Why a column, when the cron manages without one ─────────────────────────
 * `inngest/job-search-schedule.ts` has a real idempotency check and it needs no
 * new column: `listUsersDueForSearch` excludes anybody holding a non terminal
 * `applications` row created inside `IN_FLIGHT_WINDOW_HOURS`. That works there
 * and does not work here, for two reasons.
 *
 * The first is timing. Those rows are written by `discoverListings`, minutes
 * after the event is accepted, and the abuse this exists to refuse is a burst:
 * a hundred POSTs in two seconds all read a table that no run has written to
 * yet, all pass, and all send. A signal produced by the thing being rate limited
 * cannot rate limit it.
 *
 * The second is that the signal is not always produced. A search that matches
 * nothing writes no `applications` row at all, and a person whose every match
 * has already been applied to is exactly the person whose repeated searches are
 * pure waste. They would have been the least limited.
 *
 * So the stamp is written by the request itself, before the event is sent, and
 * one conditional UPDATE is both the check and the write. This is the same shape
 * as `reserveApplicationSlot`, and for the same reason: read the column, compare
 * it, write it back, and two simultaneous requests both read a stale value and
 * both proceed. Postgres serialises the statement below on the row lock, so the
 * second one finds the first one's timestamp already there, matches no row and
 * is refused by that fact rather than by a check in front of it.
 *
 * ── Five minutes ────────────────────────────────────────────────────────────
 * Long enough that a caller cannot outrun the work: a fan out takes minutes, so
 * twelve accepted searches an hour is roughly the rate one person's runs can be
 * consumed at, and a backlog stops growing. Short enough to be no obstacle to a
 * person, who has a daily scheduled search underneath this and presses the
 * button when they want one sooner rather than sixty times an hour.
 *
 * It is deliberately longer than the button's own cooldown rather than equal to
 * it. The two are not the same mechanism and making the browser's number
 * authoritative would mean trusting it.
 *
 * ── The one thing it does not do ────────────────────────────────────────────
 * The stamp is spent before `requestJobSearch` is called, so a send that fails
 * costs the person one window. That is the direction to be wrong in for a guard,
 * and putting the claim after the send would restore the burst this module
 * exists to refuse. Handing the window back wants the row's previous value out
 * of the UPDATE, which is not something Postgres offers here.
 */

import { and, eq, isNull, lt, or } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";

/** The Drizzle client the statement runs on. Injectable so a test can supply its own pool. */
export type CooldownDatabase = ReturnType<typeof db>;

/** How long a person has to wait between searches they asked for by hand. */
export const SEARCH_COOLDOWN_MINUTES = 5;

const SEARCH_COOLDOWN_MS = SEARCH_COOLDOWN_MINUTES * 60 * 1000;

export type SearchCooldown =
  | { allowed: true }
  | { allowed: false; reason: "too_soon"; retryAfterSeconds: number }
  | { allowed: false; reason: "no_profile" };

/**
 * Takes the person's next search slot, or refuses it.
 *
 * The UPDATE is the whole decision, exactly as in `reserveApplicationSlot`:
 * rows back means the stamp is now this caller's, no rows means the row did not
 * satisfy the window at the instant the lock was held.
 *
 * The follow up SELECT runs only on the refusal path and only to say how long
 * is left, which is the difference between a message a person can act on and
 * one that just says no. It is not part of the decision.
 */
export async function claimSearchSlot(
  userId: string,
  database: CooldownDatabase = db(),
  now: Date = new Date()
): Promise<SearchCooldown> {
  const readyAfter = new Date(now.getTime() - SEARCH_COOLDOWN_MS);

  const [claimed] = await database
    .update(profiles)
    .set({ lastSearchRequestedAt: now, updatedAt: now })
    .where(
      and(
        eq(profiles.id, userId),
        or(
          isNull(profiles.lastSearchRequestedAt),
          lt(profiles.lastSearchRequestedAt, readyAfter)
        )
      )
    )
    .returning({ id: profiles.id });

  if (claimed) return { allowed: true };

  const [current] = await database
    .select({ lastSearchRequestedAt: profiles.lastSearchRequestedAt })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (!current) return { allowed: false, reason: "no_profile" };

  return {
    allowed: false,
    reason: "too_soon",
    retryAfterSeconds: retryAfterSeconds(current.lastSearchRequestedAt, now),
  };
}

/**
 * Whole seconds until the window is open again, and never zero.
 *
 * A refusal that says "try again in 0 seconds" is a refusal that reads like a
 * bug. The floor of one costs a caller nothing, since the statement above is
 * what decides and this number only describes it.
 */
function retryAfterSeconds(lastRequestedAt: Date | null, now: Date): number {
  const readyAt = (lastRequestedAt?.getTime() ?? now.getTime()) + SEARCH_COOLDOWN_MS;
  return Math.max(1, Math.ceil((readyAt - now.getTime()) / 1000));
}

/**
 * "in about four minutes", from a number of seconds.
 *
 * Here rather than in the action because it is the only prose this mechanism
 * produces and the number it describes is this module's. Minutes once there is
 * more than a minute to wait: a countdown in the hundreds of seconds is a number
 * nobody converts in their head.
 */
export function describeRetryAfter(seconds: number): string {
  if (seconds <= 90) return `about ${Math.max(1, Math.round(seconds))} seconds`;
  return `about ${Math.round(seconds / 60)} minutes`;
}
