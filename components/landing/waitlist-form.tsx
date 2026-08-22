"use client";

/**
 * The waitlist form itself (JOB-031). Originally paired with its own
 * `app/waitlist/page.tsx`, the server half: the hero copy, the value bullets,
 * everything that did not need to run in the browser. JOB-032 folded that
 * copy into `app/page.tsx` and removed the standalone page, and moved this
 * file here since it is now part of the landing page rather than its own
 * route, alongside the other client pieces in `components/landing/`. This
 * file is still the one piece that has to run in the browser, on the same
 * split `app/login/login-form.tsx` and `components/feedback-widget.tsx`
 * already use for the same reason.
 *
 * The insert is a direct client side call to Supabase through
 * `lib/waitlist.ts`, on the same reasoning `lib/feedback.ts` documents: RLS on
 * `waitlist` allows an anonymous insert outright, so there is no server route
 * for this to post to, and none needs to exist.
 *
 * `referredBy` (JOB-041) is a prop, not state: nobody types it, it is the
 * value `app/page.tsx` already resolved server side from `?ref=` and the
 * cookie before this client component ever rendered. It is only read at
 * submit time below, passed straight through to `submitWaitlist` alongside
 * whatever the person actually typed.
 */

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BorderBeam } from "@/components/ui/border-beam";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import {
  submitWaitlist,
  WAITLIST_WEEKLY_VOLUME_OPTIONS,
  type WaitlistWeeklyVolume,
} from "@/lib/waitlist";

/**
 * `createClient` throws when the project is not configured. Same shape of
 * message `feedback-widget.tsx` shows for the same failure, so the two forms
 * that can appear on a page together never disagree about what is wrong.
 */
const CONFIG_ERROR_MESSAGE =
  "Joining the waitlist is not configured in this environment yet.";

const GENERIC_ERROR_MESSAGE =
  "Something went wrong. Please try again in a moment.";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "joined"; email: string; alreadyJoined: boolean }
  | { kind: "error"; message: string };

export function WaitlistForm({
  referredBy,
}: {
  /** Resolved server side by `app/page.tsx`; see the file header. */
  referredBy: string | null;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [biggestFrustration, setBiggestFrustration] = useState("");
  const [weeklyApplicationVolume, setWeeklyApplicationVolume] = useState<
    WaitlistWeeklyVolume | ""
  >("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function reset() {
    setEmail("");
    setName("");
    setBiggestFrustration("");
    setWeeklyApplicationVolume("");
    setStatus({ kind: "idle" });
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = email.trim();
    if (!trimmed) {
      setStatus({ kind: "error", message: "Enter your email address." });
      return;
    }

    setStatus({ kind: "submitting" });

    let client: ReturnType<typeof createClient>;
    try {
      client = createClient();
    } catch {
      setStatus({ kind: "error", message: CONFIG_ERROR_MESSAGE });
      return;
    }

    try {
      const result = await submitWaitlist(client, {
        email: trimmed,
        name,
        biggestFrustration,
        weeklyApplicationVolume,
        referredBy,
      });

      if (!result.ok) {
        setStatus({ kind: "error", message: result.message });
        return;
      }

      setStatus({
        kind: "joined",
        email: trimmed,
        alreadyJoined: result.alreadyJoined,
      });
    } catch (error) {
      console.error("Jobinno could not add that email to the waitlist.", error);
      setStatus({ kind: "error", message: GENERIC_ERROR_MESSAGE });
    }
  }

  return (
    <Card className="relative w-full max-w-md overflow-hidden rounded-2xl text-left shadow-xl">
      <BorderBeam duration={8} size={220} />

      <CardHeader>
        <CardTitle className="text-2xl">Join the waitlist</CardTitle>
        <CardDescription className="text-base">
          Leave your email and we will let you know the moment Jobinno opens
          back up. One message, when it is your turn, nothing else.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {status.kind === "joined" ? (
          <div className="space-y-4" role="status">
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertTitle>
                {status.alreadyJoined
                  ? "You are already on the list"
                  : "You are on the list"}
              </AlertTitle>
              <AlertDescription>
                We will email {status.email} as soon as a spot opens up.
              </AlertDescription>
            </Alert>
            <Button variant="outline" onClick={reset}>
              Join with a different email
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-5" noValidate>
            <div className="space-y-2">
              <Label htmlFor="waitlist-email">Email</Label>
              <Input
                id="waitlist-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@university.edu"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={status.kind === "submitting"}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="waitlist-name">
                Name <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="waitlist-name"
                name="name"
                autoComplete="name"
                placeholder="Jane Doe"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="waitlist-volume">
                Applications a week{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Select
                value={weeklyApplicationVolume}
                onValueChange={(next) =>
                  setWeeklyApplicationVolume(next as WaitlistWeeklyVolume)
                }
              >
                <SelectTrigger id="waitlist-volume" className="w-full">
                  <SelectValue placeholder="About how many do you send now" />
                </SelectTrigger>
                <SelectContent>
                  {WAITLIST_WEEKLY_VOLUME_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="waitlist-frustration">
                Most frustrating part of job hunting right now{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="waitlist-frustration"
                value={biggestFrustration}
                onChange={(event) => setBiggestFrustration(event.target.value)}
                placeholder="Retyping the same six answers on every form."
                rows={3}
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
              disabled={status.kind === "submitting"}
            >
              {status.kind === "submitting" ? "Joining" : "Join the waitlist"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
