"use client";

/**
 * JOB-014 — product analytics in the browser.
 *
 * Mounted once in the root layout, the same way `ThemeProvider` and
 * `FeedbackWidget` are and for the same reason: page views belong on every page
 * rather than on the pages somebody remembered to add them to.
 *
 * ── Why page views are captured by hand ─────────────────────────────────────
 * `posthog-js` captures `$pageview` automatically off the browser's load event.
 * In the App Router there is one load event for the whole session, so automatic
 * capture reports the landing page and then never reports anything again, which
 * looks exactly like a funnel where nobody ever leaves the first step.
 * `capture_pageview: false` turns that off and the effect below sends one per
 * route instead.
 *
 * `usePathname` is the whole dependency, and `useSearchParams` is deliberately
 * not used. Reading search parameters in a component this high up opts every
 * statically rendered page in the app into client side rendering unless each is
 * wrapped in its own Suspense boundary, and `next build` fails the build when
 * one is not. The URL still reaches PostHog: `$current_url` is filled from
 * `window.location.href` at capture time, query string and all.
 *
 * ── Why Do Not Track is honoured ────────────────────────────────────────────
 * `respect_dnt` is a one line setting and a browser sending the header has
 * asked plainly. Nothing about this product's funnel is worth arguing with
 * that. Capture is off outside production regardless, so the ordinary
 * development case never reaches PostHog at all. See `analyticsEnabled`.
 *
 * ── Why identify runs off the auth listener ─────────────────────────────────
 * The distinct id has to be the Supabase `auth.uid()`, which the server knows
 * from a cookie and the browser knows from its own session. Subscribing to
 * `onAuthStateChange` rather than reading the session once means the anonymous
 * events on the landing page get stitched to the real person the moment they
 * sign in, and `reset()` on sign out stops the next person on a shared machine
 * inheriting the previous one's id.
 *
 * ── Why `capture_exceptions` and `enable_heatmaps` are pinned rather than
 *    left undefined ──────────────────────────────────────────────────────────
 * Leaving either undefined does not mean "off". It means "ask PostHog's own
 * dashboard", because both fall back to a remote config flag when the local
 * config says nothing, and that flag can be flipped on with zero code change
 * and no PR. For `capture_exceptions` that is browser `$exception` capture —
 * error message, full stack trace, `$current_url` — on every page, including
 * the ones holding a resume and a work authorization answer, bypassing this
 * file's property allowlist entirely since PostHog builds that payload
 * itself. `enable_heatmaps` is the same remote-gating shape for a smaller
 * payload — pinned `false` for the same reason, one line, while here.
 *
 * ── Why `$geoip_disable` is registered as a super property ──────────────────
 * PostHog derives `$geoip_city_name`, `$geoip_country_name` and friends from
 * the request's IP on every event by default, which is a person's
 * approximate location riding along with page views this PR never put in an
 * exclusion list. `$geoip_disable` is PostHog's own documented per-event opt
 * out; registering it once makes it a property PostHog merges into every
 * capture, `$pageview` included, without this file or `sanitizeProperties`
 * having to touch it. It does not remove the request's source IP itself —
 * that is a project level "Discard IP data" setting in the PostHog
 * dashboard, outside what code here can reach.
 *
 * ── Why `before_send` strips the query string off `$current_url` ───────────
 * `$current_url` is `window.location.href` at capture time, and
 * `app/login/page.tsx` renders whatever `app/auth/callback/route.ts` put in
 * `?error=`, which includes Supabase's own `error_description` reflected
 * back verbatim rather than one of this app's own fixed sentences. A
 * `$pageview` fired on that URL would carry that text into `$current_url`
 * unfiltered. Stripping the query string (and hash) before send closes that
 * for every capture, not just the pageview effect below.
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import posthog from "posthog-js";

import {
  analyticsEnabled,
  analyticsHost,
  analyticsKey,
  sanitizeProperties,
  type AnalyticsEvent,
} from "@/lib/analytics/events";
import { createClient } from "@/lib/supabase/client";

const LOG = "[job-014]";

/** Set once `posthog.init` has run, so `captureClientEvent` knows there is a client. */
let started = false;

/**
 * One event from the browser.
 *
 * Exported rather than kept behind a hook because the one caller that needs it
 * fires from inside a submit handler, and a hook would make the capture
 * conditional on a render that has already happened. No op when analytics is
 * off, and never throws for the reason `posthog-server.ts` gives at length:
 * this is the least important thing happening on any path that calls it.
 */
export function captureClientEvent(
  event: AnalyticsEvent,
  properties?: Record<string, unknown>
): void {
  if (!started) return;

  try {
    posthog.capture(event, sanitizeProperties(event, properties));
  } catch (err) {
    console.warn(`${LOG} could not capture ${event}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Start up, once. Split from the page view effect below so that a route
  // change does not re-run initialization.
  useEffect(() => {
    if (started) return;

    const key = analyticsKey();
    if (key === null) return;

    try {
      posthog.init(key, {
        api_host: analyticsHost(),
        // See the header: the App Router fires one load event per session.
        capture_pageview: false,
        respect_dnt: true,
        // Session recording would put the contents of the intake form and the
        // resume upload on somebody else's server. Funnels need none of that.
        disable_session_recording: true,
        // Everything this app measures is a funnel step somebody deliberately
        // took. Nothing is learned from every stray click that is worth
        // hoovering up the labels of controls on a page full of personal data.
        autocapture: false,
        // See the header: left undefined, both of these ask PostHog's remote
        // config instead of staying off.
        capture_exceptions: false,
        enable_heatmaps: false,
        // See the header. `cr` is null on a capture PostHog decided not to
        // send at all — nothing to strip, hand it back unchanged.
        before_send: (cr) => {
          if (!cr) return cr;

          const currentUrl = cr.properties?.$current_url;
          if (typeof currentUrl === "string") {
            try {
              const url = new URL(currentUrl);
              url.search = "";
              url.hash = "";
              cr.properties.$current_url = url.toString();
            } catch {
              // Not a parseable URL. Leave it alone rather than guess.
            }
          }

          return cr;
        },
      });
      // See the header. Applies to every capture from here on, `$pageview`
      // included, because it is a super property rather than an argument to
      // any one `capture()` call.
      posthog.register({ $geoip_disable: true });
      started = true;
    } catch (err) {
      console.warn(
        `${LOG} could not start PostHog, analytics is off for this session: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, []);

  // Identify, and keep the identity current. Separate from the page view effect
  // so a route change does not open a second subscription.
  useEffect(() => {
    if (!analyticsEnabled()) return;

    let supabase;
    try {
      supabase = createClient();
    } catch {
      // `createClient` throws when the Supabase variables are unset, which is a
      // problem for the whole app rather than for this file. Sign in is where
      // somebody finds out, not here.
      return;
    }

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // The id, and nothing beside it. `session.user.email` is right there and
      // is deliberately never read: see the identifier note in
      // `lib/analytics/events.ts`.
      const userId = session?.user?.id;

      if (event === "SIGNED_OUT" || !userId) {
        if (event === "SIGNED_OUT" && started) posthog.reset();
        return;
      }

      if (started) posthog.identify(userId);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  // One `$pageview` per route.
  useEffect(() => {
    if (!started || pathname === null) return;

    try {
      posthog.capture("$pageview");
    } catch {
      // Deliberately silent. A failed page view on every navigation would fill
      // a console with something nobody can act on.
    }
  }, [pathname]);

  return <>{children}</>;
}
