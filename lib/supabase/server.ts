/**
 * Server side Supabase clients. Two of them, with very different powers, kept
 * in one file so the difference is visible in one screen.
 *
 * `createServerClient()` acts as the signed in user. It reads the session out
 * of cookies and every query it makes is subject to row level security, which
 * is what makes it safe to hand a user supplied filter.
 *
 * `createServiceRoleClient()` bypasses row level security entirely. It exists
 * for the one thing the browser genuinely cannot do: create a `profiles` row.
 * The schema deliberately gives `profiles` no insert policy, because a client
 * that could insert one could mint a profile for an id it does not own, so the
 * row has to be created by something the policies do not apply to. Use it for
 * that and for nothing that a user scoped client could have done instead.
 */

import { createServerClient as createSsrServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { assertSupabaseProject } from "@/lib/supabase-project-guard";

/** The bucket holding resumes and LinkedIn exports. Private, owner scoped. */
export const RESUMES_BUCKET = "resumes";

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both " +
        "be set (see .env.example)."
    );
  }

  return { url, anonKey };
}

/**
 * A client bound to the caller's session cookies. Await it: `cookies()` is
 * async in the App Router.
 */
export async function createServerClient() {
  const { url, anonKey } = publicConfig();
  const cookieStore = await cookies();

  return createSsrServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // A Server Component cannot set a cookie, and Next throws if it
          // tries. That is not a failure here: `middleware.ts` refreshes the
          // session on every request, so the cookies this call wanted to write
          // have already been written by the time a page renders. Swallowing it
          // is the documented pattern rather than a shortcut.
        }
      },
    },
  });
}

/**
 * A client holding the service role key. Bypasses row level security, so treat
 * every call as if it had already been authorised, because the database will
 * not do it for you.
 */
export function createServiceRoleClient() {
  // `SUPABASE_URL` rather than the public one, matching every ported module in
  // `lib/`. CLAUDE.md's known gap 2 tracks unifying the two names; until that
  // lands both are set to the same project and this stays consistent with the
  // code the guard was written for.
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set " +
        "(see .env.example)."
    );
  }

  assertSupabaseProject(url);

  // No session to persist and nothing to refresh, matching the ported modules.
  return createSupabaseClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
