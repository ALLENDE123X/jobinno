// JOB-365. Big number display of unpaid job hunt labor automated.
//
// JOB-365 followup: uses `CaptureTicker` rather than `NumberTicker` directly.
// This is the page whose captured PNG read $3,374 instead of $3,375 because
// the spring animation had not always settled by the time
// `scripts/capture-visuals.ts` took its screenshot. See
// `_components/capture-ticker.tsx`.
import { CaptureTicker } from "../_components/capture-ticker";

export function MoneyTimeSavedCounter() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6">
      <p className="text-muted-foreground text-2xl">
        Unpaid job hunt labor automated for pranav.l
      </p>
      <div className="flex items-end text-[200px] leading-none font-semibold">
        <span>$</span>
        <CaptureTicker value={3375} className="text-[200px] leading-none font-semibold" />
      </div>
      <p className="text-muted-foreground text-2xl">
        based on 90 applications at 25 dollars an hour, 90 minutes each
      </p>
    </div>
  );
}
