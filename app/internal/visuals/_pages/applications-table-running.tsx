// JOB-365. 40+ row table, mixed statuses, real ATS-hosted company names.
// The frame clips overflow rather than scrolling it, so only the top rows
// are visible in the capture; the full row count still exists underneath,
// matching the ticket's "40+ rows" instruction on the underlying data.
import { cn } from "@/lib/utils";

import { buildApplicationRows, STATUS_LABELS, STATUS_TONE_CLASSES } from "../_lib/mock-data";

export function ApplicationsTableRunning() {
  const rows = buildApplicationRows(42);
  return (
    <div className="flex h-full w-full flex-col gap-6 px-16 py-14">
      <h1 className="text-3xl font-semibold tracking-tight">Your applications</h1>
      <div className="overflow-hidden rounded-2xl border border-white/10">
        <div className="text-muted-foreground grid grid-cols-[2fr_2fr_1fr_1fr] gap-4 border-b border-white/10 px-6 py-3 text-sm">
          <span>Company</span>
          <span>Role</span>
          <span>Status</span>
          <span>Time</span>
        </div>
        {rows.map((row, i) => (
          <div
            key={`${row.company}-${i}`}
            className="grid grid-cols-[2fr_2fr_1fr_1fr] items-center gap-4 border-b border-white/5 px-6 py-3 text-lg"
          >
            <span className="font-medium">{row.company}</span>
            <span className="text-muted-foreground truncate">{row.title}</span>
            <span
              className={cn(
                "w-fit rounded-full px-2.5 py-1 text-xs font-medium",
                STATUS_TONE_CLASSES[row.status],
              )}
            >
              {STATUS_LABELS[row.status]}
            </span>
            <span className="text-muted-foreground text-sm">{row.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
