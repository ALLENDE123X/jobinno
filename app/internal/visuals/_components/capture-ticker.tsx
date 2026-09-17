"use client";

/**
 * JOB-365 followup. Drop in replacement for `NumberTicker` on the two mock
 * pages that use it (`money-time-saved-counter.tsx`,
 * `dashboard-counter-climbing.tsx`). Outside a capture run it is exactly
 * `NumberTicker`: same spring animation, same props, same look. Under
 * `scripts/capture-visuals.ts` (`?capture=1`, see
 * `app/internal/visuals/_lib/capture-context.tsx`) it skips the spring
 * entirely and renders the settled final value on the first paint.
 *
 * This is the fix for the round 2 red team's BLOCKING #1: the spring's slow
 * pole had not always finished settling by the time the capture script's
 * fixed wait elapsed, so `money-time-saved-counter.png` could read $3,374
 * instead of $3,375 depending on exactly where the animation was sampled.
 * Rendering the final value directly during capture removes the race
 * instead of trying to out wait it with a longer timeout.
 *
 * The formatting matches `NumberTicker`'s own `springValue.on("change", ...)`
 * handler exactly (same `Intl.NumberFormat` call, same rounding), so a
 * capture render and a fully settled live render produce identical text.
 */

import type { ComponentPropsWithoutRef } from "react";

import { NumberTicker } from "@/components/ui/number-ticker";

import { useCapture } from "../_lib/capture-context";

interface CaptureTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number;
  startValue?: number;
  direction?: "up" | "down";
  delay?: number;
  decimalPlaces?: number;
}

export function CaptureTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  decimalPlaces = 0,
  className,
  ...props
}: CaptureTickerProps) {
  const capture = useCapture();

  if (capture) {
    const settled = direction === "down" ? startValue : value;
    const formatted = Intl.NumberFormat("en-US", {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces,
    }).format(Number(settled.toFixed(decimalPlaces)));

    return (
      <span className={className} {...props}>
        {formatted}
      </span>
    );
  }

  return (
    <NumberTicker
      value={value}
      startValue={startValue}
      direction={direction}
      delay={delay}
      decimalPlaces={decimalPlaces}
      className={className}
      {...props}
    />
  );
}
