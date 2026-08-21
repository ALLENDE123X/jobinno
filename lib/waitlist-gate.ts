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
 * merges and this gate is removed. See `app/page.tsx`.
 *
 * ── One path, not two, for the waitlist itself (JOB-032) ─────────────────────
 * JOB-031 originally kept the real marketing site (JOB-016) at `app/page.tsx`
 * untouched by rewriting `WAITLIST_PATH` (`/`) to a separate, shorter page at
 * `/waitlist` instead. That traded a real problem, a visitor could never see
 * the actual landing page while the gate was active, for a smaller one.
 * JOB-032 fixed it properly: the waitlist form and its copy now live at the
 * top of `app/page.tsx` itself, above the untouched marketing content, so `/`
 * renders that file directly for every visitor and there is nothing left to
 * rewrite it to. `WAITLIST_PATH` stays in `EXEMPT_PATHS` below for exactly
 * that reason: it is not exempt from the gate in the sense of being
 * unrestricted, it is the one destination the gate sends everyone to, so
 * middleware has to let a request for it render rather than redirect it to
 * itself.
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
 * this module can be left in place afterwards without affecting anything.
 *
 * Also flip `WAITLIST_GATE_ACTIVE` below back to `false` (or delete it and
 * the check in `app/page.tsx` that reads it). That check exists only to
 * suppress JOB-020's signed in redirect while this gate makes `/dashboard`
 * redirect back to `/`; leaving `WAITLIST_GATE_ACTIVE` on after the rest of
 * the gate is gone would not loop anything, `/dashboard` would render
 * normally again, but a signed in visitor would see the marketing pitch
 * instead of being sent straight to their dashboard, which is not the
 * intended behaviour either.
 */

/** Where the gate sends everyone who is not already headed somewhere exempt.
 * Renders its own content directly (JOB-032); nothing rewrites to it. */
export const WAITLIST_PATH = "/";

const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  WAITLIST_PATH,
  "/api/inngest",
  "/api/webhooks/stripe",
]);

/**
 * Whether JOB-031's waitlist gate is active. `app/page.tsx` reads this to
 * skip its JOB-020 signed in redirect while the gate is on: `/dashboard` is
 * itself gated and redirects back to `/`, so firing that redirect here while
 * the gate is active would send a signed in visitor back and forth between
 * the two routes forever. See "How to remove the gate later" above.
 */
export const WAITLIST_GATE_ACTIVE = true;

export function isExemptFromWaitlistGate(pathname: string): boolean {
  return EXEMPT_PATHS.has(pathname);
}
