/**
 * The page a signed in, onboarded person lands on (JOB-009).
 *
 * ── The two gates, and why they are here ────────────────────────────────────
 * No session goes to sign in, and no attestation goes to intake. Both checks
 * are the page's own, next to the thing they protect, which is the pattern
 * `/onboarding` set and the reason `middleware.ts` deliberately authorises
 * nothing: middleware keeps the session fresh, a page decides who may see it.
 *
 * `profiles.attested_at` is the onboarding check rather than anything invented
 * here, because it is the same column `claimApplicationRow` refuses on. A
 * dashboard that let somebody press "Find jobs now" before intake would be
 * offering a button whose every application the pipeline is going to refuse.
 *
 * ── Where the user id comes from, and where it does not ─────────────────────
 * `supabase.auth.getUser()`, which asks the Auth server rather than reading a
 * cookie, exactly as `/onboarding` and its server action do. Nothing on this
 * route accepts an id from anywhere else: there is no route parameter, no
 * search parameter and no request body in the whole feature, and the server
 * action behind the button takes no arguments at all. That is deliberate. The
 * id reaches `requestJobSearch`, which spends a real allowance driving real
 * browsers at real employers, and an id a caller can choose is an id an
 * attacker can choose.
 *
 * The queries are scoped on that id as well as run through the user's own
 * client, so row level security and an explicit filter both have to fail before
 * anybody sees a row that is not theirs. See `lib/dashboard/dashboard-data.ts`.
 *
 * ── What this page cannot do yet ────────────────────────────────────────────
 * Nothing here can unblock a `form_fill_blocked` application. The pipeline can:
 * re-sending `job-application/requested` with `additionalAnswers` resumes one
 * once a human supplies the answer the board asked for. What is missing is the
 * half that shows the person the actual question and takes their reply, which
 * is its own ticket rather than a corner of this one. The PR says so explicitly.
 */

import { redirect } from "next/navigation";

import { listApplications, readDashboardProfile } from "@/lib/dashboard/dashboard-data";
import { createServerClient } from "@/lib/supabase/server";

import { DashboardView } from "./dashboard-view";

export default async function DashboardPage() {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const profile = await readDashboardProfile(supabase, user.id);

  // No profile row is the same situation as an unattested one from here: there
  // is nothing to apply on behalf of. Intake creates both.
  if (!profile?.attestedAt) redirect("/onboarding");

  const applications = await listApplications(supabase, user.id);

  return (
    <DashboardView
      email={user.email ?? "you"}
      quota={profile.quota}
      applications={applications}
    />
  );
}
