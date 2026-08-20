/**
 * The allowance, said out loud.
 *
 * `profiles.applications_used` against `profiles.applications_cap`, which are
 * the two numbers the pipeline itself enforces in
 * `lib/application-quota.ts`. Nothing here recomputes either of them from the
 * `applications` rows on the same page: that count is the record of what
 * happened and it is deliberately not the meter, for the three reasons that
 * module's header sets out.
 *
 * ── The cap of zero is its own sentence ─────────────────────────────────────
 * A zero cap means the account is not provisioned to apply yet, not that it may
 * apply without limit, and "0 of 0 applications used" says neither of those
 * things to anybody. So it gets its own wording, and the person is pointed at
 * the plans instead of at a full bar.
 */

import Link from "next/link";

import type { DashboardQuota } from "@/lib/dashboard/dashboard-data";

export function QuotaMeter({ quota }: { quota: DashboardQuota }) {
  const { used, cap, remaining, atCap } = quota;
  const unprovisioned = cap === 0;
  const filledPercent = unprovisioned ? 0 : Math.min(100, Math.round((used / cap) * 100));

  return (
    <section aria-labelledby="quota-heading" className="space-y-2">
      <h2 id="quota-heading" className="sr-only">
        Your plan allowance
      </h2>

      <p className="text-sm font-medium">
        {unprovisioned ? "No applications on your plan yet" : `${used} of ${cap} applications used`}
      </p>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={used}
        aria-label="Applications used"
        className="bg-muted h-2 w-full overflow-hidden rounded-full"
      >
        <div
          className={atCap && !unprovisioned ? "bg-destructive h-full" : "bg-primary h-full"}
          style={{ width: `${filledPercent}%` }}
        />
      </div>

      <p className="text-muted-foreground text-sm">
        {unprovisioned ? (
          <>
            Choose a plan and we will start applying.{" "}
            <Link href="/#pricing" className="text-foreground underline underline-offset-4">
              See the plans
            </Link>
          </>
        ) : atCap ? (
          <>
            That is everything on your plan.{" "}
            <Link href="/#pricing" className="text-foreground underline underline-offset-4">
              Add more applications
            </Link>{" "}
            to keep going.
          </>
        ) : (
          `${remaining} left.`
        )}
      </p>
    </section>
  );
}
