"use client";

/**
 * The floating feedback button, mounted once in the root layout so it is on
 * every page rather than on the pages somebody remembered to add it to
 * (JOB-016).
 *
 * The payload building and the insert live in `lib/feedback.ts`. This file is
 * only the box: open, collect, hand off, say what happened.
 *
 * Signed in submitters get their own id stamped on the row, anonymous ones get
 * null, and RLS on the table refuses anything else. The id is read from the
 * local session rather than from `getUser()` so that an anonymous visitor on the
 * landing page does not pay a network round trip to be told they are anonymous.
 * Reading it unverified is safe because nothing downstream trusts it: the insert
 * carries the same session's token and the `feedback_insert_any` policy checks
 * the id against `auth.uid()` in Postgres, so a tampered cookie fails the policy
 * rather than mislabelling a row.
 *
 * The client is the app's own, from `lib/supabase/client.ts` (JOB-011). It has
 * to be. Jobinno's session lives in a cookie, and the private client this file
 * used to reach for kept its own in `localStorage`, so it never found a session
 * and stamped every report `user_id: null`. See the header of `lib/feedback.ts`.
 *
 * JOB-365: hidden under `/internal/visuals`. Those 15 routes render a fixed
 * 1920x1080 frame meant to be screenshotted for a reel, and this button's own
 * `fixed right-4 bottom-4` position would sit on top of every one of them.
 * Checking the path here, rather than making the mock pages themselves aware
 * of this widget, keeps the fix in the one file that owns the positioning.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  captureFeedbackContext,
  submitFeedback,
  FEEDBACK_CATEGORY_OPTIONS,
  type FeedbackCategory,
} from "@/lib/feedback";
import { createClient } from "@/lib/supabase/client";

type Phase = "editing" | "sending" | "sent";

export function FeedbackWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [body, setBody] = useState("");
  const [phase, setPhase] = useState<Phase>("editing");
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  const send = useCallback(async () => {
    setPhase("sending");
    setError(null);

    // `createClient` throws when the project is not configured, where the
    // client this replaced returned null. Same outcome for the person either
    // way: one sentence saying so, and no half sent report.
    let client: ReturnType<typeof createClient>;
    try {
      client = createClient();
    } catch {
      setPhase("editing");
      setError("Feedback is not configured in this environment yet.");
      return;
    }

    let userId: string | null = null;
    try {
      const { data } = await client.auth.getSession();
      userId = data.session?.user.id ?? null;
    } catch {
      // No session is the normal case for a visitor. Nothing to report.
      userId = null;
    }

    const result = await submitFeedback(client, {
      category,
      body,
      userId,
      context: captureFeedbackContext(window),
    });

    if (!result.ok) {
      setPhase("editing");
      setError(result.message);
      return;
    }

    setPhase("sent");
    setBody("");
    resetTimer.current = setTimeout(() => {
      setOpen(false);
      setPhase("editing");
    }, 1600);
  }, [body, category]);

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setPhase("editing");
      setError(null);
    }
  }, []);

  // After every hook above, so this stays a conditional return rather than a
  // conditional hook call.
  if (pathname?.startsWith("/internal/visuals")) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          aria-label="Send feedback"
          className="fixed right-4 bottom-4 z-50 h-11 gap-2 rounded-full px-4 shadow-lg sm:right-6 sm:bottom-6"
        >
          <MessageSquarePlus className="size-4" />
          <span className="hidden sm:inline">Feedback</span>
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tell us what you found</DialogTitle>
          <DialogDescription>
            Goes straight to the people building this. You do not need an
            account.
          </DialogDescription>
        </DialogHeader>

        {phase === "sent" ? (
          <p className="py-6 text-center text-sm font-medium" role="status">
            Got it. Thank you.
          </p>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="feedback-category">Category</Label>
              <Select
                value={category}
                onValueChange={(next) => setCategory(next as FeedbackCategory)}
              >
                <SelectTrigger id="feedback-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEEDBACK_CATEGORY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="feedback-body">What happened</Label>
              <Textarea
                id="feedback-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="The more specific the better."
                rows={5}
                required
              />
            </div>

            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <Button
              type="submit"
              size="lg"
              disabled={phase === "sending" || body.trim().length === 0}
            >
              {phase === "sending" ? "Sending" : "Send feedback"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
