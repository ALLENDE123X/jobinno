/**
 * The waitlist landing page (JOB-031). The only page a real visitor can reach
 * while the live site is gated; see `middleware.ts` and `lib/waitlist-gate.ts`
 * for the redirect that sends everyone here.
 *
 * Deliberately does not check for a signed in session the way `app/page.tsx`
 * and `app/login/page.tsx` do. There is nowhere for a session to send someone
 * on to while the gate is active, `/dashboard` redirects here exactly like
 * everything else does, so the right behaviour is to render the same page for
 * every visitor regardless of who they are.
 *
 * A server component. `WaitlistForm`, in its own file, is the one piece that
 * has to run in the browser, matching the split `app/login/page.tsx` uses
 * with `login-form.tsx`.
 */

import { Bot, ShieldCheck, Target } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";

import { WaitlistForm } from "./waitlist-form";

const PROMISES = [
  {
    icon: Target,
    title: "It finds the right postings",
    body: "Matches openings against your resume and intake so the search targets internship and new grad roles instead of everything a board happens to list.",
  },
  {
    icon: Bot,
    title: "It fills out the real form",
    body: "Drives an actual browser through Greenhouse, Lever, Ashby and the rest, typing and uploading exactly like you would, one field at a time.",
  },
  {
    icon: ShieldCheck,
    title: "It never invents an answer",
    body: "Every free text answer is built from what you told it. If your data does not support an honest one, it stops and asks you rather than guessing.",
  },
] as const;

/** The V1 target platforms, per CLAUDE.md. Shown so the pitch reads concrete rather than vague. */
const ATS_PLATFORMS_DISPLAY = [
  "Greenhouse",
  "Lever",
  "Ashby",
  "Workable",
  "BambooHR",
  "Breezy",
  "JazzHR",
  "Recruitee",
  "Teamtailor",
  "SmartRecruiters",
] as const;

export default function WaitlistPage() {
  return (
    <PageShell>
      <main className="relative flex-1 px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-16">
          <div className="flex max-w-2xl flex-col items-center gap-6 text-center">
            <Badge
              variant="secondary"
              className="rounded-full px-3 py-1 text-xs font-medium"
            >
              Private beta, opening back up soon
            </Badge>

            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              An AI agent that applies to jobs for you.
            </h1>

            <p className="text-base text-pretty text-muted-foreground sm:text-lg">
              Jobinno finds relevant openings and fills out and submits the
              real application forms itself, so you do not have to enter the
              same information fifty times. We are putting the finishing
              touches on it. Join the waitlist and we will email you the
              moment it opens back up.
            </p>
          </div>

          <WaitlistForm />

          <div className="grid w-full gap-8 sm:grid-cols-3">
            {PROMISES.map((promise) => (
              <div
                key={promise.title}
                className="flex flex-col items-center gap-3 text-center sm:items-start sm:text-left"
              >
                <promise.icon className="size-5" />
                <h3 className="text-base font-medium">{promise.title}</h3>
                <p className="text-sm text-pretty text-muted-foreground">
                  {promise.body}
                </p>
              </div>
            ))}
          </div>

          <div className="flex max-w-2xl flex-col items-center gap-3">
            <p className="text-sm font-medium text-muted-foreground">
              Currently built for
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {ATS_PLATFORMS_DISPLAY.map((name) => (
                <Badge
                  key={name}
                  variant="outline"
                  className="rounded-full px-3 py-1 text-xs font-normal text-muted-foreground"
                >
                  {name}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </main>
    </PageShell>
  );
}
