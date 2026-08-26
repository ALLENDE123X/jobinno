"use client";

/**
 * A "Sign out" button that only renders when there is a session to sign out
 * of, so `PageShell` can drop it into the header on every route without it
 * showing up on the landing page or on `/login` for someone who arrived there
 * signed out already.
 *
 * The session check happens on the client rather than the server for one
 * reason: `PageShell` is a server component that a page like `/login` renders
 * before authentication, so it cannot know from the render pass whether the
 * viewer is signed in. Checking here lets one shell serve every route without
 * needing a prop threaded through from each page.
 *
 * On sign out we push the browser to `/login` and call `router.refresh()`.
 * The push updates the URL, and the refresh re-runs the middleware plus every
 * server component with the cookie cleared, which is what actually flushes
 * cached content the previous session might have rendered.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const [signedIn, setSignedIn] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setSignedIn(!!data.user);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (!cancelled) setSignedIn(!!session?.user);
      },
    );

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  if (!signedIn) return null;

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <Button variant="ghost" onClick={handleSignOut} type="button">
      Sign out
    </Button>
  );
}
