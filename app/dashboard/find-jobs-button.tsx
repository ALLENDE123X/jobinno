"use client";

/**
 * The one control on this page that starts anything.
 *
 * ── Why there is a cooldown when the backend does not need one ──────────────
 * JOB-008 put a per user concurrency guard on the discovery function, so a
 * second press queues behind the first rather than running twice. Correctness
 * is therefore not the problem. What is left is that a search takes minutes and
 * shows nothing while it works, so a button that goes straight back to "Find
 * jobs now" reads as one that did nothing, and the reasonable response to a
 * button that did nothing is to press it again.
 *
 * The cooldown is one minute of the button saying, plainly, that a search is
 * already running. It is UX and it is not a guard, which is why it can live in
 * the browser at all: it is React state, so a reload clears it and a caller that
 * never rendered it was never subject to it.
 *
 * The guard is `claimSearchSlot`, on the server, in `lib/search-cooldown.ts`.
 * Its window is the longer of the two on purpose, so somebody who reloads past
 * this one gets an answer in words rather than a search: that answer arrives as
 * `result.message` below, which is already how every other refusal is rendered.
 * Do not read the server's window from here and do not shorten it to match this
 * one, because a limit the browser can choose is not a limit.
 *
 * ── Why the action is called with no arguments ──────────────────────────────
 * Because it takes none. The user id comes from the session on the server; see
 * `actions.ts`. There is nothing this component could send that would be worth
 * trusting.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import { findJobsNow } from "./actions";

/** How long the button stays quiet after a search really was accepted. */
export const COOLDOWN_MS = 60_000;

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "started"; until: number }
  | { kind: "failed"; message: string };

export function FindJobsButton({
  disabled = false,
  disabledReason,
}: {
  /** True when the person is at their cap. The action refuses these too. */
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (state.kind !== "started") {
      setSecondsLeft(0);
      return;
    }

    // Read off a stored deadline rather than counted down from sixty, so that a
    // tab left in the background does not come back with a stale number.
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((state.until - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) setState({ kind: "idle" });
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state]);

  async function onClick() {
    setState({ kind: "starting" });

    try {
      const result = await findJobsNow();
      setState(
        result.ok
          ? { kind: "started", until: Date.now() + COOLDOWN_MS }
          : { kind: "failed", message: result.message }
      );
    } catch (error) {
      setState({
        kind: "failed",
        message: error instanceof Error ? error.message : "Something went wrong starting that search.",
      });
    }
  }

  const cooling = state.kind === "started";
  const busy = state.kind === "starting";

  return (
    <div className="space-y-2">
      <Button
        size="lg"
        onClick={onClick}
        disabled={disabled || busy || cooling}
        aria-disabled={disabled || busy || cooling}
      >
        {busy ? "Starting your search" : cooling ? "Search running" : "Find jobs now"}
      </Button>

      <p className="text-muted-foreground max-w-prose text-sm" role="status" aria-live="polite">
        {disabled
          ? (disabledReason ?? "")
          : state.kind === "failed"
            ? state.message
            : cooling
              ? `We are looking. New applications show up here as they go out, so give it a few minutes. You can start another search in ${secondsLeft} seconds.`
              : state.kind === "starting"
                ? "Sending that off."
                : "We will match new openings against your saved answers and start applying."}
      </p>
    </div>
  );
}
