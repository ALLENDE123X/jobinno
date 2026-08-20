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
        captureClientEvent(ANALYTICS_EVENT.MAGIC_LINK_REQUESTED, { outcome: "refused" });
        setStatus({ kind: "error", message: error.message });
        return;
      }

      captureClientEvent(ANALYTICS_EVENT.MAGIC_LINK_REQUESTED, { outcome: "sent" });
      setStatus({ kind: "sent", email: trimmed });
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Something went wrong sending that link.",
      });
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
          <form onSubmit={onSubmit} className="space-y-5" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@university.edu"
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
              size="lg"
              className="h-10 w-full text-sm"
              disabled={status.kind === "sending"}
            >
              {status.kind === "sending" ? "Sending" : "Email me a link"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
