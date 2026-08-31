"use client";

/**
 * The sign in form itself. `page.tsx` is the server half; it reads the `error`
 * the callback route may have redirected back with and seeds this component
 * with it, which keeps `useSearchParams` and its Suspense boundary out of a
 * component whose real job is one input and one button.
 *
 * One field, and no password anywhere in Jobinno by design: a password
 * is a credential we would have to store, reset, rate limit and eventually
 * apologise for, and an emailed link does the same job while proving the same
 * thing.
 *
 * The redirect URL comes from `authCallbackUrlFor`, which throws on an origin
 * that is not allowlisted rather than letting Supabase quietly substitute the
 * project Site URL. See `lib/auth/redirect-urls.ts` for why that matters.
 *
 * What that function throws is a developer's message, and this component is the
 * boundary that has to stop it becoming a user's message. See
 * `SEND_FAILURE_MESSAGE` below.
 */

import { useState } from "react";

import { captureClientEvent } from "@/components/analytics";
import { ANALYTICS_EVENT } from "@/lib/analytics/events";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

export function LoginForm({ initialError }: { initialError?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>(
    initialError ? { kind: "error", message: initialError } : { kind: "idle" }
  );

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

  return (
    <Card className="w-full max-w-md rounded-2xl shadow-xl">
      <CardHeader>
        <CardTitle className="text-2xl">Sign in to Jobinno</CardTitle>
        <CardDescription className="text-base">
          We email you a link that signs you in. There is no password to
          remember.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {status.kind === "sent" ? (
          <div className="space-y-3 text-sm" role="status">
            <p className="font-medium">Check your inbox.</p>
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
            <Button
              type="button"
              size="lg"
              className="h-10 w-full text-sm"
              onClick={onGoogleSignIn}
              disabled={status.kind === "sending"}
            >
              {status.kind === "sending" ? "Redirecting" : "Continue with Google"}
            </Button>

            <div className="my-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <form onSubmit={onSubmit} className="space-y-5" noValidate>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@gmail.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={status.kind === "sending"}
                  required
                />
              </div>

              {status.kind === "error" ? (
                <p className="text-sm text-destructive" role="alert">
                  {status.message}
                </p>
              ) : null}

              <Button
                type="submit"
                variant="outline"
                size="lg"
                className="h-10 w-full text-sm"
                disabled={status.kind === "sending"}
              >
                {status.kind === "sending" ? "Sending" : "Email me a link"}
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
