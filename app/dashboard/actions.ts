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
 */

import { revalidatePath } from "next/cache";

import { requestJobSearch } from "@/lib/job-search-trigger";
import { createServerClient } from "@/lib/supabase/server";
import { readDashboardProfile } from "@/lib/dashboard/dashboard-data";

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
    return { ok: false, message: messageOf(error) };
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

  try {
    await requestJobSearch(user.id);
  } catch (error) {
    return { ok: false, message: `We could not start that search: ${messageOf(error)}` };
  }

  // The rows this search produces arrive over the next several minutes, so this
  // is not what shows them. It is what makes the allowance and the list on the
  // page current again for anyone who left the tab open a while.
  revalidatePath("/dashboard");
  return { ok: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
