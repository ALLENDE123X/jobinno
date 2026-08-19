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

      if (error) {
        setStatus({ kind: "error", message: error.message });
        return;
      }

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
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Sign in to Jobinno</CardTitle>
        <CardDescription>
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
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
              className="w-full"
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
