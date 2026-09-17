/**
 * JOB-365. The single fixed size canvas every one of the 15 mock pages
 * renders into, so the "hard clip to 1920x1080" requirement lives in one
 * place instead of fifteen.
 *
 * Two things make the clip real rather than aspirational:
 *
 *   - `width` and `height` are literal pixels, not `100vw` / `100vh`. A
 *     viewport unit tracks whatever window opened the page; a literal pixel
 *     size does not, so the frame is exactly 1920x1080 whether it is opened
 *     in Playwright's 1920x1080 context or in a developer's laptop browser
 *     that is narrower than that.
 *   - `overflow: hidden` means content that runs long is clipped, not
 *     scrolled. `scripts/capture-visuals.ts` screenshots with an explicit
 *     `clip: { x: 0, y: 0, width: 1920, height: 1080 }`, which would already
 *     enforce this from outside, but a page that scrolls past the frame
 *     under a person's own eyes while previewing it locally is a bug this
 *     wrapper should catch before the capture script ever runs.
 *
 * `dark` is applied directly on this element, not left to `next-themes`
 * resolving on `<html>`. `next-themes` decides the theme in a `useEffect`
 * after hydration (see `components/theme.tsx`), and a screenshot taken
 * before that effect has run, or a system color scheme that happens to
 * resolve light, would both produce a light frame despite the ticket's
 * "dark background matching the app" requirement. Putting `dark` on the
 * frame's own root means every descendant that reads `bg-background`,
 * `text-foreground`, or any other themed token in `app/globals.css` is dark
 * from the very first paint, with nothing to race.
 */

import type { ReactNode } from "react";

export const VISUAL_FRAME_WIDTH = 1920;
export const VISUAL_FRAME_HEIGHT = 1080;

export function VisualFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="dark bg-background text-foreground"
      style={{
        width: VISUAL_FRAME_WIDTH,
        height: VISUAL_FRAME_HEIGHT,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {children}
    </div>
  );
}
