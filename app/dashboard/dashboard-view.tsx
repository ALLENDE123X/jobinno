/**
 * The dashboard itself, given data rather than fetching it (JOB-009).
 *
 * Split from `page.tsx` so that the two halves can be wrong independently:
 * the page is a session check, an onboarding check and two queries, and this is
 * everything a person actually looks at. Rendering is then testable with a
 * fixture instead of with a database, which is what
 * `tests/unit/dashboard-view.test.tsx` does, and it is also what makes it
 * possible to look at every state of this page locally without seeding rows
 * into a real Supabase project to do it.
 *
 * Nothing here reads a status or a reason code out loud. `plain-language.ts`
 * owns that, and the only thing this file adds is which colour a tone gets.
 */

import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardApplication, DashboardQuota } from "@/lib/dashboard/dashboard-data";
import { describeSkipReason, describeStatus, type StatusTone } from "@/lib/dashboard/plain-language";
import { cn } from "@/lib/utils";

import { FindJobsButton } from "./find-jobs-button";
import { QuotaMeter } from "./quota-meter";

/** Pill colours per tone. The tone itself is never rendered. */
const TONE_CLASSES: Record<StatusTone, string> = {
  waiting: "bg-muted text-muted-foreground",
  working: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  sent: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  attention: "bg-amber-500/10 text-amber-800 dark:text-amber-400",
};

/**
 * A fixed locale, because this renders on the server and a server whose locale
 * differs from the reader's would otherwise pick the date format for them.
 */
function formatDate(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ApplicationRow({ application }: { application: DashboardApplication }) {
  const status = describeStatus(application.status);
  // Looked up only for the rows a person has to do something about. Every other
  // row's skip log is history, and history belongs in the log rather than on a
  // page somebody is scanning for what needs them.
  const reason = status.needsHuman ? describeSkipReason(application.skipReason) : null;
  const submitted = application.submittedAt ? formatDate(application.submittedAt) : null;

  return (
    <Card size="sm" className="gap-2">
      <CardHeader className="grid-cols-[1fr_auto] items-start gap-3">
        <CardTitle className="min-w-0">
          <span className="block truncate">{application.title}</span>
          <span className="text-muted-foreground block truncate text-sm font-normal">
            {application.company}
          </span>
        </CardTitle>

        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
            TONE_CLASSES[status.tone]
          )}
        >
          {status.label}
        </span>
      </CardHeader>

      <CardContent className="space-y-1.5">
        <p className="text-muted-foreground text-sm">{status.description}</p>

        {reason ? (
          <p className="text-sm">
            <span className="font-medium">What stopped it: </span>
            {reason}
          </p>
        ) : null}

        {application.confirmationText ? (
          <p className="text-sm">
            <span className="font-medium">The board said: </span>
            {application.confirmationText}
          </p>
        ) : null}

        <p className="text-muted-foreground text-xs">
          {submitted ? `Sent ${submitted}` : "Not sent yet"}
          {application.url ? (
            <>
              {" · "}
              <Link
                href={application.url}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-4"
              >
                View the listing
              </Link>
            </>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
}

function EmptyState({ quota }: { quota: DashboardQuota }) {
  // Three different nothings, and telling them apart is the whole job of this
  // card. A new account has no plan, a spent one has no allowance left, and a
  // funded one simply has not searched yet, and only the last of those is an
  // invitation to press the button.
  const unprovisioned = quota.cap === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {unprovisioned
            ? "Nothing here yet"
            : quota.atCap
              ? "Nothing applied for yet"
              : "No applications yet"}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground max-w-prose space-y-2 text-sm">
        {unprovisioned ? (
          <p>
            Once there is a plan on your account we will start matching openings against the
            answers you gave at intake, and everything we do shows up here.
          </p>
        ) : quota.atCap ? (
          <p>
            Your plan has no applications left on it, so a search would have nothing to spend. Top
            it up and this page fills in on its own.
          </p>
        ) : (
          <>
            <p>
              Press find jobs now and we will match openings against the answers you gave at
              intake, then start filling their forms.
            </p>
            <p>
              The first ones usually appear within a few minutes. Nothing gets submitted that your
              intake cannot answer honestly, so some listings will stop and tell you why instead.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardView({
  email,
  quota,
  applications,
}: {
  email: string;
  quota: DashboardQuota;
  applications: DashboardApplication[];
}) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Your applications</h1>
        <p className="text-muted-foreground text-sm">
          Everything Jobinno has done for {email}, newest first.
        </p>
      </header>

      <div className="space-y-6">
        <QuotaMeter quota={quota} />
        <FindJobsButton
          disabled={quota.atCap}
          disabledReason={
            quota.cap === 0
              ? "Choose a plan and this button starts your first search."
              : "You have used every application on your plan, so a new search has nothing to spend."
          }
        />
      </div>

      {applications.length === 0 ? (
        <EmptyState quota={quota} />
      ) : (
        <ul className="space-y-3">
          {applications.map((application) => (
            <li key={application.id}>
              <ApplicationRow application={application} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
