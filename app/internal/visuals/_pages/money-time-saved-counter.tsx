// JOB-365. Big number display of unpaid job hunt labor automated.
import { NumberTicker } from "@/components/ui/number-ticker";

export function MoneyTimeSavedCounter() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6">
      <p className="text-muted-foreground text-2xl">
        Unpaid job hunt labor automated for pranav.l
      </p>
      <div className="flex items-end text-[200px] leading-none font-semibold">
        <span>$</span>
        <NumberTicker value={3375} className="text-[200px] leading-none font-semibold" />
      </div>
      <p className="text-muted-foreground text-2xl">
        based on 90 applications at 25 dollars an hour, 90 minutes each
      </p>
    </div>
  );
}
