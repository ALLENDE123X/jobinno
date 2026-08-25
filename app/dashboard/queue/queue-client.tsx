"use client";

/**
 * The queue view's interactive shell (v1-D). Given the first paint's data by
 * the server component, it polls `/api/applications/queue` every 30 seconds
 * while the tab is visible, hands the pending row's form its resolve
 * callback, and does the optimistic UI: a submitted row disappears from the
 * pending column immediately and appears at the top of the applied column
 * with a "resuming" placeholder until the next poll picks up whatever the
 * pipeline did with it.
 *
 * ── Why polling and not realtime ────────────────────────────────────────────
 * A realtime channel on `applications` scoped to the user would be nicer, but
 * v1-D does not depend on subscribing to it: the pipeline can take a minute
 * or more to pick a row back up, and a 30 second poll is well below the
 * cadence a person watching the tab notices. Realtime is a follow-up ticket,
 * not this one.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  ApplicationQueue,
  AppliedQueueRow,
  PendingQueueRow,
} from "@/lib/dashboard/queue-data";
import { cn } from "@/lib/utils";

import { EscalationForm } from "./escalation-form";

/**
 * A local view model for one applied row. The `resuming` flag is client only
 * and represents an optimistic move from pending to applied: it means the
 * person just answered on this row and the pipeline has not caught up yet.
 * The next successful poll replaces the flagged placeholder with the real
 * server row.
 */
type AppliedView = AppliedQueueRow & {
  resuming?: boolean;
  /** Set alongside `resuming`; the earliest we would expect the row to move. */
  resumingSince?: number;
};

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "submitted":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "submission_unconfirmed":
      return "bg-amber-500/10 text-amber-800 dark:text-amber-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function statusBadgeLabel(status: string): string {
  switch (status) {
    case "submitted":
      return "submitted";
    case "submission_unconfirmed":
      return "unconfirmed";
    default:
      return status.replace(/_/g, " ");
  }
}

function statusTooltip(status: string): string | undefined {
  if (status === "submission_unconfirmed") {
    return "Submission attempted but confirmation did not arrive. It may still be received.";
  }
  return undefined;
}

function AppliedCard({ row }: { row: AppliedView }) {
  const submitted = formatDate(row.submittedAt);
  const tooltip = statusTooltip(row.status);
  return (
    <Card size="sm" className="gap-2 transition-shadow hover:shadow-md">
      <CardHeader className="grid-cols-[1fr_auto] items-start gap-3">
        <CardTitle className="min-w-0">
          <span className="block truncate">{row.title}</span>
          <span className="text-muted-foreground block truncate text-sm font-normal">
            {row.company}
          </span>
        </CardTitle>
        {row.resuming ? (
          <span className="bg-sky-500/10 text-sky-700 dark:text-sky-400 shrink-0 rounded-full px-2.5 py-1 text-xs font-medium">
            resuming your application...
          </span>
        ) : (
          <span
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
              statusBadgeClass(row.status)
            )}
            title={tooltip}
          >
            {statusBadgeLabel(row.status)}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-1.5">
        {row.location ? (
          <p className="text-muted-foreground text-sm">{row.location}</p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {row.resuming
            ? "Answers sent. The next check picks this up in a moment."
            : submitted
              ? `Submitted ${submitted}`
              : "Not submitted yet"}
          {row.url ? (
            <>
              {" · "}
              <Link
                href={row.url}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-4"
              >
                Open the listing
              </Link>
            </>
          ) : null}
        </p>
        {row.confirmationText ? (
          <p
            className="text-muted-foreground truncate text-xs"
            title={row.confirmationText}
          >
            The board said: {row.confirmationText}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PendingCard({
  row,
  onResolved,
}: {
  row: PendingQueueRow;
  onResolved: (id: string) => void;
}) {
  const created = formatDate(row.escalationCreatedAt);
  return (
    <Card size="sm" className="gap-3">
      <CardHeader className="grid-cols-[1fr_auto] items-start gap-3">
        <CardTitle className="min-w-0">
          <span className="block truncate">{row.title}</span>
          <span className="text-muted-foreground block truncate text-sm font-normal">
            {row.company}
          </span>
        </CardTitle>
        <span className="bg-amber-500/10 text-amber-800 dark:text-amber-400 shrink-0 rounded-full px-2.5 py-1 text-xs font-medium">
          waiting on you
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {row.location ? (
          <p className="text-muted-foreground text-sm">{row.location}</p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {created ? `Escalated ${created}` : "Waiting on your answers"}
          {row.url ? (
            <>
              {" · "}
              <Link
                href={row.url}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-4"
              >
                Open the listing
              </Link>
            </>
          ) : null}
        </p>
        {row.escalationQuestions.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            The escalation payload for this row is empty. Refresh in a moment; the pipeline
            may still be writing it.
          </p>
        ) : (
          <EscalationForm
            applicationId={row.id}
            questions={row.escalationQuestions}
            onResolved={onResolved}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function QueueClient({ initial }: { initial: ApplicationQueue }) {
  // Rows the server sent, kept in state so the poll can replace them and the
  // optimistic move can mutate them.
  const [applied, setApplied] = useState<AppliedView[]>(() => initial.applied);
  const [pending, setPending] = useState<PendingQueueRow[]>(() => initial.pending);
  /**
   * Ids we optimistically moved out of pending. Kept as a Set on a ref so the
   * polling reconciler can survive React 18 concurrent rendering re rendering
   * the same tick twice; the reconciler drops a `resuming` placeholder as
   * soon as the real row appears in the applied response, whichever side of
   * the poll the server got to first.
   */
  const resumingIds = useRef<Set<string>>(new Set());

  const reconcile = useCallback((next: ApplicationQueue) => {
    const now = Date.now();
    // Drop any resuming placeholder whose real row is now present on either
    // side of the queue. If the pipeline picked it up and moved it to
    // submitted, the applied side has it. If the pipeline stumbled and put
    // it back into pending_user_input with new questions, the pending side
    // has it. Either way, the placeholder is stale.
    const realIds = new Set<string>();
    for (const row of next.applied) realIds.add(row.id);
    for (const row of next.pending) realIds.add(row.id);

    const placeholders: AppliedView[] = [];
    for (const id of resumingIds.current) {
      if (realIds.has(id)) {
        resumingIds.current.delete(id);
      } else {
        // Find the last known applied row for this id, or synthesise a stub.
        const existing = applied.find((r) => r.id === id);
        if (existing) {
          placeholders.push({ ...existing, resuming: true, resumingSince: now });
        }
      }
    }

    const merged: AppliedView[] = [...placeholders, ...next.applied];
    setApplied(merged);
    setPending(next.pending);
  }, [applied]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/applications/queue", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as ApplicationQueue;
        if (cancelled) return;
        reconcile(body);
      } catch {
        // Silent. The next tick tries again.
      }
    }

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, 30_000);

    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reconcile]);

  const onResolved = useCallback((applicationId: string) => {
    // Optimistic: pull the row out of pending, drop a "resuming" placeholder
    // at the top of the applied column, and remember the id so the poll
    // reconciler can clear it once the real row shows up. Nested state
    // updates are done through refs and functional updaters kept side effect
    // free, because React 18 strict mode calls each updater twice and a
    // `setState` nested inside another updater would run twice as well —
    // that was the source of the "two placeholders for one submission" bug
    // caught on the first real browser run.
    resumingIds.current.add(applicationId);
    const now = Date.now();
    let removedRow: PendingQueueRow | undefined;
    setPending((prev) => {
      removedRow = prev.find((r) => r.id === applicationId);
      if (!removedRow) return prev;
      return prev.filter((r) => r.id !== applicationId);
    });
    setApplied((prev) => {
      // If a placeholder for this id is already at the top, do not stack a
      // second one. This makes the update idempotent under React's strict
      // mode double invocation and under a rapid double click.
      if (prev.some((r) => r.id === applicationId && r.resuming)) return prev;
      const row = removedRow;
      const placeholder: AppliedView = {
        id: applicationId,
        title: row?.title ?? "Application",
        company: row?.company ?? "",
        location: row?.location ?? null,
        url: row?.url ?? null,
        status: "discovered",
        submittedAt: null,
        confirmationText: null,
        resuming: true,
        resumingSince: now,
      };
      return [placeholder, ...prev];
    });
  }, []);

  const both = applied.length === 0 && pending.length === 0;
  const hasPending = pending.length > 0;
  const hasApplied = applied.length > 0;
  const applyingCount = useMemo(() => applied.filter((r) => r.resuming).length, [applied]);

  return (
    <div className="space-y-8">
      {both ? (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-xl">Your application queue is empty</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground max-w-prose space-y-2 text-sm">
            <p>
              Jobinno is scanning for jobs that fit your profile. Check back soon and this page
              will fill in on its own.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {hasApplied ? (
            <section aria-labelledby="applied-heading">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 id="applied-heading" className="text-xl font-semibold tracking-tight">
                  Applied
                </h2>
                {applyingCount > 0 ? (
                  <span className="text-muted-foreground text-xs">
                    {applyingCount} resuming...
                  </span>
                ) : null}
              </div>
              <ul className="space-y-3">
                {applied.map((row) => (
                  <li key={`${row.id}-${row.resuming ? "r" : "s"}`}>
                    <AppliedCard row={row} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {hasPending ? (
            <section aria-labelledby="pending-heading">
              <div className="mb-3">
                <h2 id="pending-heading" className="text-xl font-semibold tracking-tight">
                  Pending your input
                </h2>
                <p className="text-muted-foreground text-sm">
                  One question stopped each of these before submit. Answer here and we resume.
                </p>
              </div>
              <ul className="space-y-3">
                {pending.map((row) => (
                  <li key={row.id}>
                    <PendingCard row={row} onResolved={onResolved} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
