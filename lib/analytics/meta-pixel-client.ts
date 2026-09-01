/**
 * JOB-328. Meta Pixel thin wrapper for browser use.
 *
 * The Pixel base code loads through a `<Script>` tag in `app/layout.tsx`,
 * which is the standard install pattern Meta documents: the loader stub
 * assigns `window.fbq` synchronously and queues calls until the real
 * library arrives, so calling `fbq('track', 'Lead')` from a `useEffect`
 * that runs after the loader script has evaluated is safe.
 *
 * This file exists so callers do not have to know that pattern, and so the
 * "is the pixel configured" check lives in exactly one place. Two rules,
 * both matching the PostHog client's decisions and both for the same
 * reasons:
 *
 *  · **No op when `NEXT_PUBLIC_META_PIXEL_ID` is unset.** The project ships
 *    to prod before Pranav sets the vars on Vercel, and every intermediate
 *    build has to be silent about a missing pixel id rather than error.
 *  · **Never throws.** The three callers are on paths where analytics is
 *    the least important thing happening: a sign in page mount, an intake
 *    save, a Stripe webhook. A pixel outage cannot break any of those.
 *
 * The Pixel id is deliberately `NEXT_PUBLIC_`: Meta reads it from the base
 * code in the browser, so keeping it out of the bundle would defeat the
 * point. Pixel ids are treated as public by Meta; the paired secret is
 * `META_CAPI_ACCESS_TOKEN`, which never leaves the server.
 */

const LOG = "[job-328]";

/**
 * The three canonical Meta events this project fires. Kept here rather than
 * in `meta-conversions-api.ts` so a client component can import the names
 * without dragging Node's `crypto` module into the browser bundle.
 */
export const META_EVENT = {
  LEAD: "Lead",
  COMPLETE_REGISTRATION: "CompleteRegistration",
  PURCHASE: "Purchase",
} as const;

export type MetaEventName = (typeof META_EVENT)[keyof typeof META_EVENT];

/**
 * The subset of `window.fbq` this file uses. Meta's real signature accepts
 * far more, but the two variants below are the ones this project needs and
 * declaring them here keeps the caller's TS happy without a global .d.ts
 * that would leak into every file.
 */
type FbqFn = ((command: "init", pixelId: string) => void) &
  ((command: "track", eventName: string, params?: Record<string, unknown>) => void);

interface WindowWithFbq extends Window {
  fbq?: FbqFn;
}

/**
 * Reads `NEXT_PUBLIC_META_PIXEL_ID`. Written out literally rather than
 * through a dynamic key for the same reason `lib/analytics/events.ts`
 * documents: Next inlines the `NEXT_PUBLIC_` reads at build time by matching
 * the literal spelling.
 */
export function metaPixelId(): string | null {
  const id = (process.env.NEXT_PUBLIC_META_PIXEL_ID ?? "").trim();
  return id === "" ? null : id;
}

let missingIdWarned = false;
let missingFbqWarned = false;

export function resetMetaPixelWarningsForTests(): void {
  missingIdWarned = false;
  missingFbqWarned = false;
}

/**
 * Fire one Meta pixel event from the browser.
 *
 * Silently no-ops when the pixel id is missing (env not set in this
 * deployment) or when `window.fbq` has not yet materialised (pixel base
 * code has not loaded yet, or the script was blocked). Logs one warning
 * per case per process so the miss is visible in dev without spamming.
 */
export function trackMetaPixelEvent(
  eventName: string,
  params?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;

  const id = metaPixelId();
  if (id === null) {
    if (!missingIdWarned) {
      console.warn(
        `${LOG} NEXT_PUBLIC_META_PIXEL_ID not set, Meta pixel events are off`,
      );
      missingIdWarned = true;
    }
    return;
  }

  const w = window as WindowWithFbq;
  const fbq = w.fbq;
  if (typeof fbq !== "function") {
    if (!missingFbqWarned) {
      console.warn(
        `${LOG} window.fbq not available, Meta pixel base code has not loaded`,
      );
      missingFbqWarned = true;
    }
    return;
  }

  try {
    if (params) {
      fbq("track", eventName, params);
    } else {
      fbq("track", eventName);
    }
  } catch (err) {
    console.warn(
      `${LOG} could not fire Meta pixel ${eventName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
