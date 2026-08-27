"use client";

/**
 * JOB-228 — the one link `/settings/gmail` gained anywhere in the app's own
 * navigation before this ticket: none. Google's OAuth verification review
 * requires a demo of a person clicking a real button in the product to
 * reach the Gmail consent flow, not one typed into the address bar, and
 * nothing in the header pointed there.
 *
 * Self hides when there is no session, mirroring
 * `components/sign-out-button.tsx` exactly: `PageShell` is a server
 * component rendered on routes like `/login` before authentication, so it
 * cannot know from its own render pass whether the viewer is signed in.
 * Checking here, on the client, lets one shell serve every route without a
 * prop threaded through from each page.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

import { createClient } from "@/lib/supabase/client";

export function SettingsLink() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setSignedIn(!!data.user);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) setSignedIn(!!session?.user);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  if (!signedIn) return null;

  return (
    <Link
      href="/settings/gmail"
      className="text-muted-foreground hover:text-foreground text-sm font-medium"
    >
      Settings
    </Link>
  );
}
