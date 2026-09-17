// JOB-365. Beat 4 visual: the overnight run animating from 0 to 47 while the
// viewer was asleep. `NumberTicker` already ships in components/ui, so this
// page only supplies the copy and the layout around it.
//
// JOB-365 followup: uses `CaptureTicker` instead of `NumberTicker` directly,
// so a `scripts/capture-visuals.ts` run renders 47 immediately rather than
// hoping the spring animation has settled by screenshot time. See
// `_components/capture-ticker.tsx`.
import { Logo } from "@/components/logo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { CaptureTicker } from "../_components/capture-ticker";

const RECENT = [
  { company: "Anthropic", time: "8:47am" },
  { company: "Ramp", time: "8:31am" },
  { company: "Vercel", time: "8:12am" },
  { company: "Notion", time: "7:58am" },
  { company: "Linear", time: "7:40am" },
];

export function DashboardCounterClimbing() {
  return (
    <div className="flex h-full w-full items-center justify-between gap-16 px-24">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3 text-lg font-semibold tracking-tight">
          <Logo />
          Jobinno
        </div>
        <p className="text-muted-foreground text-2xl">While you slept</p>
        <CaptureTicker value={47} className="text-[220px] leading-none font-semibold" />
        <p className="text-muted-foreground text-2xl">applications submitted overnight</p>
      </div>

      <Card className="w-[560px] gap-4 border-white/10">
        <CardHeader>
          <CardTitle className="text-muted-foreground text-sm font-normal tracking-wide uppercase">
            3:04am to 8:47am
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {RECENT.map((row) => (
            <div key={row.company} className="flex items-center justify-between text-xl">
              <span>{row.company}</span>
              <span className="text-emerald-400">submitted, {row.time}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
