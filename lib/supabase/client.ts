/**
 * The browser Supabase client. Anon key only, and it stays that way: anything
 * prefixed `NEXT_PUBLIC_` is compiled into the bundle that ships to a user's
 * machine, so a service role key put here would be readable by anyone who
 * opened dev tools.
 *
 * What keeps this client safe is not the key, it is row level security. Every
 * table it can reach has policies keyed on `auth.uid()`, and so does the
 * `resumes` storage bucket, so the worst a tampered client can do is ask for
 * its own rows in an unusual way.
 */

import { createBrowserClient } from "@supabase/ssr";

/** The bucket holding resumes and LinkedIn exports. Private, owner scoped. */
export const RESUMES_BUCKET = "resumes";

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both " +
        "be set (see .env.example)."
    );
  }

  // `createBrowserClient` writes its session and its PKCE code verifier to
  // document.cookie rather than to localStorage, which is what lets the server
  // side callback route read them back. A plain `createClient` from
  // `@supabase/supabase-js` would keep both in localStorage, where no server
  // route can see them, and the code exchange in the callback would fail with
  // a missing verifier.
  return createBrowserClient(url, anonKey);
}
