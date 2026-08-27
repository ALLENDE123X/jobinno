"use client";

/**
 * JOB-228 — the one interactive control on the connected state of
 * `app/settings/gmail/page.tsx`. Posts to `app/api/auth/gmail/disconnect/route.ts`,
 * then refreshes the page so the server component above re-reads
 * `profiles.gmail_refresh_token` and renders the not connected state.
 *
 * A client component only because a button that fires a fetch call needs
 * one; the page itself stays a server component, matching
 * `app/dashboard/find-jobs-button.tsx`'s split between a server page and one
 * small client control.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

const DISCONNECT_PATH = "/api/auth/gmail/disconnect";

type State = { kind: "idle" } | { kind: "working" } | { kind: "failed"; message: string };

export function DisconnectGmailButton() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const router = useRouter();

  async function onClick() {
    setState({ kind: "working" });

    try {
      const response = await fetch(DISCONNECT_PATH, { method: "POST" });
      if (!response.ok) {
        setState({
          kind: "failed",
          message: "Could not disconnect Gmail right now. Try again in a moment.",
        });
        return;
      }
      router.refresh();
    } catch {
      setState({
        kind: "failed",
        message: "Could not reach Jobinno to disconnect Gmail. Check your connection and try again.",
      });
    }
  }

  const busy = state.kind === "working";

  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={onClick} disabled={busy}>
        {busy ? "Disconnecting" : "Disconnect Gmail"}
      </Button>
      {state.kind === "failed" ? (
        <p className="text-destructive text-sm" role="status" aria-live="polite">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
