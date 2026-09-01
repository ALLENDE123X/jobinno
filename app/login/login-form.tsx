"use client";

/**
 * The sign in form itself. `page.tsx` is the server half; it reads the `error`
 * the callback route may have redirected back with and seeds this component
 * with it, which keeps `useSearchParams` and its Suspense boundary out of a
 * component whose real job is one input and one button.
 *
 * The redirect URL comes from `authCallbackUrlFor`, which throws on an origin
 * that is not allowlisted rather than letting Supabase quietly substitute the
 * project Site URL. See `lib/auth/redirect-urls.ts` for why that matters.
 *
 * What that function throws is a developer's message, and this component is the
 * boundary that has to stop it becoming a user's message. See
 * `SEND_FAILURE_MESSAGE` below.
 *
 * ── JOB-327: the page is now a continuation of the landing ────────────────
 * Funnel analysis of the ad click drop off (2026-09-01) found that a cold
 * visitor who taps "Queue tonight's applications" on the landing was landing
 * on a generic "Sign in to Jobinno" shell with none of the trust the landing
 * built restated. This component now renders an H1 that echoes the landing's
 * CTA, a three step preview of the flow the visitor is about to enter, a
 * plain sentence about the Gmail scope that comes later, a free tier chip,
 * and Terms and Privacy inline under the buttons. Google is the full width
 * primary; the emailed link is a secondary path below a labelled divider,
 * kept for the .edu Google Workspace deliverability edge cases the emailed
 * link is a proven fallback for. The auth mechanics themselves are unchanged
 * from what JOB-307 wired up: Supabase's `signInWithOAuth` for Google and
 * `signInWithOtp` for the emailed link, both handed the same allowlisted
 * `/auth/callback` URL.
 *
 * One field on the email form, and no password anywhere in Jobinno by design:
 * a password is a credential we would have to store, reset, rate limit and
 * eventually apologise for, and an emailed link does the same job while
 * proving the same thing.
 */

import { useEffect, useState } from "react";

import Link from "next/link";
import { FileText, LogIn, Moon } from "lucide-react";

import { captureClientEvent } from "@/components/analytics";
import { ANALYTICS_EVENT } from "@/lib/analytics/events";
import {
  META_EVENT,
  trackMetaPixelEvent,
} from "@/lib/analytics/meta-pixel-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authCallbackUrlFor } from "@/lib/auth/redirect-urls";
import { createClient } from "@/lib/supabase/client";

/**
 * The one thing a person is shown when a sign in link cannot be sent, whatever
 * the reason it could not be sent (JOB-023).
 *
 * ── Why every failure collapses to one sentence ─────────────────────────────
 * The reasons are accurate and none of them are for the reader.
 * `authCallbackUrlFor` throws a paragraph naming `AUTH_REDIRECT_ALLOWLIST`,
 * `supabase/config.toml` and the command that pushes it. Supabase returns
 * strings like "email rate limit exceeded", which describes our mail provider
 * and not anything the person did. Both used to be rendered here verbatim,
 * because this component put `error.message` straight into the markup, and both
 * were seen by real people on the live site.
 *
 * That is a professionalism problem and a small disclosure one: an error string
 * assembled for an operator names internal constants, file paths and commands,
 * and a sign in form is reachable by anyone. So the flow is one way. The
 * message goes to the console for whoever is debugging, and the reader gets a
 * sentence written for them.
 *
 * "Enter your email address." is not routed through here on purpose. That one
 * is about something the reader can actually act on.
 */
const SEND_FAILURE_MESSAGE =
  "Something went wrong sending your sign in link. Please try again in a moment.";

/**
 * The three step preview above the buttons. Order is the order of the visit:
 * sign in first, intake next, applications go out overnight. Kept in one array
 * so the render is a single loop and adding or reordering steps is a data
 * edit, not a jsx one.
 */
const FLOW_STEPS = [
  { icon: LogIn, label: "Sign in" },
  { icon: FileText, label: "3 minute intake" },
  { icon: Moon, label: "First 10 applications go out tonight" },
] as const;

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

/**
 * The Google monogram, inlined so the primary button has the recognisable
 * color mark even before any font or icon sheet loads. The paths are the
 * ones Google's brand guidelines publish; the wrapper carries `aria-hidden`
 * because the button text already reads "Continue with Google".
 */
function GoogleMonogram({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.44c-.28 1.49-1.12 2.75-2.4 3.59v2.98h3.87c2.27-2.09 3.58-5.17 3.58-8.81z"
        fill="#4285F4"
      />
      <path
        d="M12 24c3.24 0 5.95-1.08 7.94-2.91l-3.87-2.98c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.28 21.31 7.31 24 12 24z"
        fill="#34A853"
      />
      <path
        d="M5.27 14.31c-.24-.72-.38-1.49-.38-2.31s.14-1.59.38-2.31V6.6H1.29A11.98 11.98 0 000 12c0 1.93.46 3.76 1.29 5.4l3.98-3.09z"
        fill="#FBBC05"
      />
      <path
        d="M12 4.73c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.94 1.19 15.23 0 12 0 7.31 0 3.28 2.69 1.29 6.6l3.98 3.09C6.22 6.84 8.87 4.73 12 4.73z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function LoginForm({ initialError }: { initialError?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>(
    initialError ? { kind: "error", message: initialError } : { kind: "idle" }
  );

  // JOB-328. Meta Pixel Lead event, fired once per mount of this form. The
  // Meta ad auction learns which impressions produced a Lead by seeing the
  // event fire on the landing page a click delivered to. `page.tsx` already
  // redirects a signed-in visitor away from this route, so the effect only
  // runs for a visitor who is actually seeing the sign-in form and is a
  // legitimate top of funnel event. Empty deps so a route change back to
  // /login refires once rather than on every re-render. Silently no-ops
  // when NEXT_PUBLIC_META_PIXEL_ID is unset; see meta-pixel-client.ts.
  useEffect(() => {
    trackMetaPixelEvent(META_EVENT.LEAD);
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = email.trim();
    if (!trimmed) {
      setStatus({ kind: "error", message: "Enter your email address." });
      return;
    }

    setStatus({ kind: "sending" });

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { emailRedirectTo: authCallbackUrlFor(window.location.origin) },
      });

      // JOB-014. The top of the funnel, and the one event that fires before
      // there is any session to attribute it to, so PostHog files it against
      // the anonymous id it already gave this browser and stitches it to the
      // real person when `AnalyticsProvider` identifies them after the link is
      // opened. `trimmed` is an email address and is never sent: `outcome` is
      // the whole payload, and `sanitizeProperties` would drop the address
      // anyway if a later edit tried to add it.
      if (error) {
        captureClientEvent(ANALYTICS_EVENT.MAGIC_LINK_REQUESTED, {
          outcome: "refused",
          method: "email",
        });
        console.error("Jobinno could not send a sign in link.", error);
        setStatus({ kind: "error", message: SEND_FAILURE_MESSAGE });
        return;
      }

      captureClientEvent(ANALYTICS_EVENT.MAGIC_LINK_REQUESTED, {
        outcome: "sent",
        method: "email",
      });
      setStatus({ kind: "sent", email: trimmed });
    } catch (error) {
      // Where the allowlist safeguard lands. `authCallbackUrlFor` throws before
      // `signInWithOtp` is ever called, so this branch is reached with nothing
      // captured yet, and the funnel would otherwise lose the failure entirely.
      captureClientEvent(ANALYTICS_EVENT.MAGIC_LINK_REQUESTED, {
        outcome: "refused",
        method: "email",
      });
      console.error("Jobinno could not send a sign in link.", error);
      setStatus({ kind: "error", message: SEND_FAILURE_MESSAGE });
    }
  }

  /**
   * JOB-307. The Google OAuth entry point. Supabase handles the whole redirect
   * itself, so this just tells it where to send the person after the round
   * trip: the same `/auth/callback` route the emailed link uses. The route
   * exchanges whatever it is given for a session and takes it from there.
   *
   * The `authCallbackUrlFor` guard is the same one the email flow runs, and it
   * throws the same developer sentence when the origin is not allowlisted, so
   * the catch below collapses it to `SEND_FAILURE_MESSAGE` for the same reason.
   */
  async function onGoogleSignIn() {
    setStatus({ kind: "sending" });

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: authCallbackUrlFor(window.location.origin) },
      });

      if (error) {
        captureClientEvent(ANALYTICS_EVENT.MAGIC_LINK_REQUESTED, {
          outcome: "refused",
          method: "google",
        });
        console.error("Jobinno could not start Google sign in.", error);
        setStatus({ kind: "error", message: SEND_FAILURE_MESSAGE });
        return;
      }

      // On success Supabase navigates the browser to Google, so this code path
      // typically unmounts before it can be observed. Fire the funnel event
      // anyway on the chance the redirect is delayed, and leave the status on
      // "sending" so the button stays disabled during the handoff.
      captureClientEvent(ANALYTICS_EVENT.MAGIC_LINK_REQUESTED, {
        outcome: "sent",
        method: "google",
      });
    } catch (error) {
      captureClientEvent(ANALYTICS_EVENT.MAGIC_LINK_REQUESTED, {
        outcome: "refused",
        method: "google",
      });
      console.error("Jobinno could not start Google sign in.", error);
      setStatus({ kind: "error", message: SEND_FAILURE_MESSAGE });
    }
  }

  const sending = status.kind === "sending";
  const sent = status.kind === "sent";

  return (
    <div className="w-full max-w-md">
      {sent ? null : (
        <div className="mb-6 flex flex-col items-center gap-5 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            {"One step to tonight's applications."}
          </h1>

          <ol
            aria-label="What happens next"
            className="grid w-full grid-cols-3 gap-2 text-xs text-muted-foreground sm:text-sm"
          >
            {FLOW_STEPS.map((step, index) => (
              <li
                key={step.label}
                className="flex flex-col items-center gap-2 rounded-xl border bg-background/60 px-2 py-3"
              >
                <span
                  aria-hidden="true"
                  className="flex size-7 items-center justify-center rounded-full border bg-background text-foreground/80"
                >
                  <step.icon className="size-4" />
                </span>
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Step {index + 1}
                </span>
                <span className="text-pretty leading-snug text-foreground/80">
                  {step.label}
                </span>
              </li>
            ))}
          </ol>

          <p className="text-sm text-pretty text-muted-foreground">
            No card needed to try it.
          </p>
        </div>
      )}

      <div className="rounded-2xl border bg-background/80 p-6 shadow-xl backdrop-blur sm:p-8">
        {sent ? (
          <div className="space-y-3 text-sm" role="status">
            <p className="text-lg font-semibold">Check your inbox.</p>
            <p className="text-muted-foreground">
              We sent a sign in link to {status.email}. Open it on this device
              and you are in. It expires in an hour.
            </p>
            <Button
              variant="outline"
              onClick={() => setStatus({ kind: "idle" })}
            >
              Use a different email
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-col gap-2 text-xs text-muted-foreground">
              <p
                data-testid="login-free-tier-chip"
                className="rounded-full border bg-muted/40 px-3 py-1.5 text-center font-medium text-foreground/80"
              >
                Free tier: 10 applications. No card required.
              </p>
              <p
                data-testid="login-gmail-scope-chip"
                className="rounded-full border bg-muted/40 px-3 py-1.5 text-center text-foreground/70"
              >
                Read only Gmail access is requested later, not on this screen.
              </p>
            </div>

            <Button
              type="button"
              size="lg"
              className="h-11 w-full text-sm"
              onClick={onGoogleSignIn}
              disabled={sending}
            >
              <GoogleMonogram className="size-4" />
              {sending ? "Redirecting" : "Continue with Google"}
            </Button>

            <div className="my-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">
                or use email instead
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <form onSubmit={onSubmit} className="space-y-3" noValidate>
              <div className="space-y-2">
                <Label htmlFor="email" className="sr-only">
                  Email
                </Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@gmail.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={sending}
                  required
                />
              </div>

              {status.kind === "error" ? (
                <p className="text-sm text-destructive" role="alert">
                  {status.message}
                </p>
              ) : null}

              <div className="flex justify-center">
                <Button
                  type="submit"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-sm"
                  disabled={sending}
                >
                  {sending ? "Sending" : "Email me a link"}
                </Button>
              </div>
            </form>

            <p className="mt-5 text-center text-xs text-muted-foreground">
              By continuing you agree to our{" "}
              <Link
                href="/terms"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Terms
              </Link>{" "}
              and{" "}
              <Link
                href="/privacy"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Privacy
              </Link>
              .
            </p>
          </>
        )}
      </div>
    </div>
  );
}
