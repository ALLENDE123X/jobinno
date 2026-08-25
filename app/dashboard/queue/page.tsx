/**
 * The queue view (v1-D). Two lists, side by side on desktop, stacked on
 * mobile: what jobinno has sent for you, and what jobinno is waiting for you
 * to answer.
 *
 * ── Auth and onboarding, same shape as the dashboard root ───────────────────
 * The two gates from `app/dashboard/page.tsx` apply verbatim: no session goes
 * to `/login`, no attestation goes to `/onboarding`. The user id comes from
 * `supabase.auth.getUser()` and never from the URL or the body.
 *
 * ── Server component with a client shell inside ─────────────────────────────
 * The first paint is server rendered so the person sees their real data
 * without a spinner and without a client roundtrip. Everything interactive
 * (the escalation form, the poll that reconciles the two lists) is inside
 * `QueueClient`, which is a client component. That mirrors the split
 * `dashboard-view.tsx` uses on the main dashboard.
 */

import { redirect } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { readDashboardProfile } from "@/lib/dashboard/dashboard-data";
import { readApplicationQueue } from "@/lib/dashboard/queue-data";
import { createServerClient } from "@/lib/supabase/server";

import { QueueClient } from "./queue-client";

export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await readDashboardProfile(supabase, user.id);
  if (!profile?.attestedAt) redirect("/onboarding");

  const queue = await readApplicationQueue(supabase, user.id);

  return (
    <PageShell>
      <main className="relative mx-auto w-full max-w-6xl flex-1 space-y-8 px-4 py-12 sm:px-6 sm:py-16">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Your queue
          </h1>
          <p className="text-muted-foreground text-base">
            Everything jobinno has submitted for you, and everything jobinno is waiting on
            you to answer.
          </p>
        </header>

        <QueueClient initial={queue} />
      </main>
    </PageShell>
  );
}
