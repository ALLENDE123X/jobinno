// JOB-365. Close up of a single submitted row, the viewer's target company
// featured, matching the real dashboard's card styling.
import { CheckCircle2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SubmittedBadgeView() {
  return (
    <div className="flex h-full w-full items-center justify-center px-16">
      <Card className="w-[900px] gap-4 border-emerald-500/30 bg-emerald-500/5">
        <CardHeader className="grid-cols-[1fr_auto] items-start gap-3">
          <CardTitle className="min-w-0 text-2xl">
            <span className="block">Software Engineer, New Grad</span>
            <span className="text-muted-foreground block text-lg font-normal">Anthropic</span>
          </CardTitle>
          <span className="flex shrink-0 items-center gap-2 rounded-full bg-emerald-500/10 px-4 py-2 text-base font-medium text-emerald-400">
            <CheckCircle2 className="size-5" />
            submitted
          </span>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-lg">Sent 8:47am, this morning</p>
        </CardContent>
      </Card>
    </div>
  );
}
