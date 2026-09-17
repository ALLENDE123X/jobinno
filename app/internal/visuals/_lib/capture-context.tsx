"use client";

/**
 * JOB-365 followup. Carries the `?capture=1` query param from the server
 * side `[slug]/page.tsx` down to any client component that needs to know it
 * is being rendered for `scripts/capture-visuals.ts` rather than for a
 * person previewing a page in a browser.
 *
 * This exists because of a real bug: `NumberTicker`'s spring animation
 * (`components/ui/number-ticker.tsx`, damping 60, stiffness 100) has a slow
 * pole that, for some target values, has not fully settled by the time the
 * capture script's fixed wait elapses, so the captured PNG can be off by one
 * from the real final value (see money-time-saved-counter.tsx, which read
 * $3,374 instead of $3,375). `CaptureTicker` in `_components/capture-ticker.tsx`
 * uses this context to skip the animation and render the final value
 * directly whenever `capture=1` is set, which removes the race instead of
 * trying to out wait it.
 *
 * Deliberately not `useSearchParams()`. `[slug]/page.tsx` is already an
 * async server component reading `searchParams`, and `app/login/login-form.tsx`
 * already established the pattern this repo prefers: read the query on the
 * server, hand the resolved value down as a prop (here, via context, since
 * the registry maps a slug to a bare `ComponentType` with no props), rather
 * than pulling `useSearchParams` and its Suspense boundary into every page
 * that might care.
 */

import { createContext, useContext, type ReactNode } from "react";

const CaptureContext = createContext(false);

export function CaptureProvider({
  capture,
  children,
}: {
  capture: boolean;
  children: ReactNode;
}) {
  return <CaptureContext.Provider value={capture}>{children}</CaptureContext.Provider>;
}

/** True only when the current request is `scripts/capture-visuals.ts`
 * screenshotting this page with `?capture=1`. False in every other context,
 * including a developer previewing the page directly. */
export function useCapture(): boolean {
  return useContext(CaptureContext);
}
