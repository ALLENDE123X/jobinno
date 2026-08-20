"use server";

/**
 * "Find Jobs Now", server side.
 *
 * ── Why there is no user id parameter ───────────────────────────────────────
 * A server action is a public HTTP endpoint. An id the browser passes in is an
 * id anybody can pass in, and this one is handed straight to a function that
 * spends somebody's allowance driving real browsers at real employers. So the
 * only id this file will use is the one `getUser()` reads back from the Auth
 * server, and the button has nothing to send.
 *
 * ── Why the two refusals are here as well as on the page ────────────────────
 * The page hides the button from anyone who has not attested and disables it at
 * the cap. Neither of those is a check; they are what the page looks like.
 * `claimApplicationRow` would refuse both cases eventually, but by then the
 * event has been sent, a discovery run has started, and the person who pressed
 * a button that said it worked is waiting for applications that will never
 * arrive. Refusing here means the answer comes back in the same request.
 *
 * ── Why it does not wait for anything ───────────────────────────────────────
 * `requestJobSearch` resolves when Inngest accepts the event, which is well
 * before any application exists. That is the documented contract and the honest
 * one: a fan out takes minutes to hours, and the outcome arrives as rows in the
 * list below, not as a return value here.
 *
 * ── The third refusal, and why it is last ───────────────────────────────────
 * `claimSearchSlot` is the real rate limit; the button's cooldown is React
 * state and a script never rendered it. It runs after the other two checks
 * because it writes: spending somebody's window on a call that was going to be
 * refused for being over the cap would be charging them for a refusal. See
 * `lib/search-cooldown.ts`.
 *
 * ── What a failure is allowed to say ────────────────────────────────────────
 * Every message below is a fixed sentence written here. None is built from an
 * error somebody else's library produced, because this is a public HTTP endpoint
 * and its response body is readable by whoever called it: a Postgres error names
 * tables and policies, and an Inngest one names our own infrastructure. The real
 * text goes to the log instead. `lib/dashboard/dashboard-data.ts` holds the same
 * line for the reads it owns.
 */

import { revalidatePath } from "next/cache";

import { ANALYTICS_EVENT } from "@/lib/analytics/events";
import { captureServerEvent } from "@/lib/analytics/posthog-server";
import { requestJobSearch } from "@/lib/job-search-trigger";
import { createServerClient } from "@/lib/supabase/server";
import { DASHBOARD_READ_FAILED, readDashboardProfile } from "@/lib/dashboard/dashboard-data";
import { claimSearchSlot, describeRetryAfter } from "@/lib/search-cooldown";

export type FindJobsResult = { ok: true } | { ok: false; message: string };

export async function findJobsNow(): Promise<FindJobsResult> {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, message: "Your session has expired. Sign in again and try once more." };
  }

  let profile;
  try {
    profile = await readDashboardProfile(supabase, user.id);
  } catch (error) {
    // `readDashboardProfile` has already logged the real failure and thrown one
    // of its own fixed sentences. This does not repeat what it threw anyway: a
    // client that fails before PostgREST answers, on DNS or on a socket, throws
    // through this same catch and its message is ours to keep quiet about too.
    logFailure("readDashboardProfile", user.id, error);
    return { ok: false, message: DASHBOARD_READ_FAILED.profile };
  }

  if (!profile?.attestedAt) {
    return {
      ok: false,
      message: "Finish your intake first. We cannot apply for you until you have confirmed your answers.",
    };
  }

  if (profile.quota.atCap) {
    return {
      ok: false,
      message:
        profile.quota.cap === 0
          ? "There are no applications on your plan yet, so there is nothing to search with."
          : `You have used all ${profile.quota.cap} applications on your plan.`,
    };
  }

  let slot;
  try {
    slot = await claimSearchSlot(user.id);
  } catch (error) {
    logFailure("claimSearchSlot", user.id, error);
    return { ok: false, message: COULD_NOT_START };
  }

  if (!slot.allowed) {
    return {
      ok: false,
      message:
        slot.reason === "too_soon"
          ? `We are already looking. You can start another search in ${describeRetryAfter(slot.retryAfterSeconds)}.`
          : COULD_NOT_START,
    };
  }

  try {
    await requestJobSearch(user.id);
  } catch (error) {
    // Nothing here is repeatable to the browser. `requestJobSearch` throws with
    // the id it was given when the id is malformed, and Inngest throws with our
    // own event key and endpoint when it will not accept the event.
    logFailure("requestJobSearch", user.id, error);
    return { ok: false, message: COULD_NOT_START };
  }

  // JOB-014. Only on the path where Inngest actually accepted the event, so
  // that this counts searches that started rather than button presses. The
  // three refusals above are their own question and are visible on the page.
  //
  // `source` is what makes this event worth having: the daily cron in
  // `inngest/job-search-schedule.ts` sends the identical event for the same
  // person, and a funnel that cannot tell a search somebody asked for from one
  // that happened while they slept is measuring the cron rather than the
  // product.
  await captureServerEvent({
    event: ANALYTICS_EVENT.SEARCH_REQUESTED,
    distinctId: user.id,
    properties: { source: "dashboard" },
  });

  // The rows this search produces arrive over the next several minutes, so this
  // is not what shows them. It is what makes the allowance and the list on the
  // page current again for anyone who left the tab open a while.
  revalidatePath("/dashboard");
  return { ok: true };
}

/** The one sentence every failure that is not the person's doing comes back as. */
const COULD_NOT_START = "We could not start that search. Try again in a moment.";

/** The real failure, in the log, where it is an engineer reading it and not a caller. */
function logFailure(where: string, userId: string, error: unknown): void {
  console.error(
    `[job-009] ${where} failed for user ${userId}:`,
    error instanceof Error ? error.message : String(error)
  );
}
