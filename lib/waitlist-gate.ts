/**
 * Which request paths are exempt from the waitlist gate (JOB-031), factored
 * out of `middleware.ts` so the exemption list is testable without
 * constructing a `NextRequest`, the same reason `lib/auth/redirect-urls.ts`
 * is its own module rather than logic inline in the routes that use it.
 *
 * ── Why the live site is gated at all ────────────────────────────────────────
 * jobinno.app is live and still has open bugs being fixed on `v1`. Rather than
 * leave the full application reachable while that work continues, the
 * waitlist becomes the front page and every other URL leads there until `v1`
 * merges and this gate is removed. See `app/waitlist/page.tsx`.
 *
 * ── Two paths, not one, for the waitlist itself ──────────────────────────────
 * `WAITLIST_PATH` (`/`) is what a visitor sees and what everything redirects
 * to — the actual "no other URL path" surface. `WAITLIST_CONTENT_PATH`
 * (`/waitlist`) is where the page component actually lives on disk; `/` is
 * rewritten to it in `middleware.ts` rather than the waitlist page being moved
 * into `app/page.tsx`, so the real marketing site (JOB-016) stays exactly
 * where it is and is never overwritten. A direct request for
 * `WAITLIST_CONTENT_PATH` itself is not exempt — it redirects to
 * `WAITLIST_PATH` like everything else, so there is genuinely one reachable
 * URL, not two that happen to show the same thing.
 *
 * `/api/inngest` and `/api/webhooks/stripe` are service to service endpoints,
 * not pages. Inngest calls the first on its own schedule and Stripe calls the
 * second the moment a real event fires; neither holds a browser session, and
 * neither has any way to act on a redirect, a 307 back to an HTML page is not
 * something either caller interprets as "try the waitlist page instead", it
 * is a broken delivery. Gating either would silently stop the board sync
 * cron and the application pipeline behind the first, and silently drop
 * billing events, active subscriptions renewing or lapsing, for real people
 * who paid before this gate went up, behind the second. Neither failure mode
 * announces itself: nothing here throws or 500s, the webhook sender just stops
 * hearing back and gives up quietly on its own retry schedule.
 *
 * Everything else, `/login`, `/dashboard`, `/onboarding`, `/billing/success`,
 * `/auth/callback`, `/api/billing/checkout`, and every other page or page
 * adjacent route this app has or ever adds, is gated on purpose:
 *
 *  · `/auth/callback` is where a magic link lands and a session is created.
 *    Gating it is deliberate and not an oversight. Nobody should be able to
 *    finish signing in while this is active, that is the whole point of the
 *    gate, not a gap in it.
 *  · `/api/billing/checkout` is reachable today only from a pricing section
 *    nobody can navigate to any more, but it is a real POST handler that
 *    starts a real Stripe checkout session, and a crafted request straight to
 *    it would still work if it were not gated. The product being down for
 *    maintenance should not have a working, unlisted way to pay for it
 *    anyway.
 *
 * ── How to remove the gate later ─────────────────────────────────────────────
 * Nothing above deletes or restructures a route; it only stops middleware
 * sending traffic to it. Reverting the check in `middleware.ts` that calls
 * `isExemptFromWaitlistGate` is enough to put every page back within reach,
 * this module and `app/waitlist/` can be left in place afterwards without
 * affecting anything.
 */
const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/api/inngest",
  "/api/webhooks/stripe",
]);

/** Where the gate sends everyone who is not already headed somewhere exempt. */
export const WAITLIST_PATH = "/";

/** Where `app/waitlist/page.tsx` actually lives — `WAITLIST_PATH` rewrites here. */
export const WAITLIST_CONTENT_PATH = "/waitlist";

export function isExemptFromWaitlistGate(pathname: string): boolean {
  return EXEMPT_PATHS.has(pathname);
}
