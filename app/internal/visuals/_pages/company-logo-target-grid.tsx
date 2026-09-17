// JOB-365. Grid of target companies with a "done today" counter overlay.
import { cn } from "@/lib/utils";

import { REAL_COMPANIES } from "../_lib/mock-data";

const DONE_TODAY = 12;

export function CompanyLogoTargetGrid() {
  return (
    <div className="flex h-full w-full flex-col gap-6 px-16 py-12">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Target companies</h1>
        <p className="text-2xl">
          <span className="font-semibold text-emerald-400">{DONE_TODAY}</span>
          <span className="text-muted-foreground"> / 500 done today</span>
        </p>
      </div>
      <div className="grid grid-cols-10 gap-3">
        {REAL_COMPANIES.map((company, i) => (
          <div
            key={company}
            className={cn(
              "flex aspect-video items-center justify-center rounded-lg border text-center text-sm font-medium",
              i < DONE_TODAY
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-white/10 text-muted-foreground",
            )}
          >
            {company}
          </div>
        ))}
      </div>
    </div>
  );
}
