"use client";

/**
 * The three number counters (JOB-016).
 *
 * ── Two of these three numbers are placeholders ─────────────────────────────
 * `applications submitted` and `hours handed back` are invented. There is no
 * real usage to count yet, and a landing page with an empty proof section is
 * worse than one with an honest placeholder waiting to be replaced. Whoever
 * wires the dashboard to real data should replace them from `applications`
 * rather than adjust them upward: a count of submitted rows for the first, and
 * that count times the roughly ten minutes a form takes by hand for the second.
 *
 * The third, the count of supported ATS platforms, is real today. It is the ten
 * platforms CLAUDE.md lists as the V1 targets, so it stays a constant.
 */

import { NumberTicker } from "@/components/ui/number-ticker";

const STATS = [
  // PLACEHOLDER: replace with a live count of submitted applications.
  { value: 128400, label: "applications submitted" },
  // PLACEHOLDER: replace with submitted applications times minutes saved each.
  { value: 21400, label: "hours handed back" },
  // Real: the V1 target platforms listed in CLAUDE.md.
  { value: 10, label: "ATS platforms supported" },
] as const;

export function StatsBand() {
  return (
    <dl className="grid gap-8 sm:grid-cols-3">
      {STATS.map((stat) => (
        // `flex-col-reverse` puts the number above its label on screen while
        // leaving the term before its description in the markup, which is what
        // a description list has to be for a screen reader to read the pair in
        // the right order.
        <div
          key={stat.label}
          className="flex flex-col-reverse items-center gap-2 text-center"
        >
          <dt className="text-sm text-muted-foreground">{stat.label}</dt>
          <dd className="text-4xl font-semibold tracking-tight sm:text-5xl">
            <NumberTicker
              value={stat.value}
              className="text-foreground dark:text-foreground"
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}
