/**
 * JOB-228 — the missing entry point into the Gmail OAuth flow
 * `app/api/auth/gmail/start/route.ts` and
 * `app/api/auth/gmail/callback/route.ts` already carry end to end (JOB-189,
 * JOB-198, JOB-211). Nothing in the app pointed at either route before this
 * page: Google's OAuth verification review requires a demo video of a
 * person clicking a real button in the product to begin consent, and a
 * typed in start URL fails that review outright.
 *
 * ── Reading connection state needs the service role client ─────────────────
 * `drizzle/0027_profiles_column_select_lockdown.sql` revoked the table wide
 * SELECT grant `authenticated` used to hold on `profiles` and granted back
 * every column a signed in person legitimately reads about themselves.
 * `gmail_refresh_token` is deliberately not on that list, the same way
 * `stripe_customer_id` and `browserbase_context_id` are not, so a query
 * through the session client (`createServerClient()`) would read back
 * `null` for this column even when a token is actually stored, which would
 * render this page's connected state as disconnected forever. Reading it at
 * all needs `createServiceRoleClient()`, the same client
 * `app/api/auth/gmail/callback/route.ts` already writes it with, scoped to
 * this signed in user's own id.
 *
 * ── Why there is no email address to show ───────────────────────────────────
 * `profiles` has exactly one column for this feature, `gmail_refresh_token`
 * (`drizzle/0025_profiles_gmail_refresh_token.sql`). There is no
 * `gmail_email` column or anything like it, so the callback route never had
 * anywhere to store which Gmail address a person actually granted consent
 * for, and it cannot be assumed to be the same address they signed into
 * Jobinno with. Rather than invent a column outside this ticket's scope,
 * `GmailSettingsView`'s connected state says plainly that a Gmail account
 * is connected without naming one. JOB-229 tracks adding the column.
 */

import { redirect } from "next/navigation";

import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

import { GmailSettingsView } from "./gmail-settings-view";

const LOGIN_PATH = "/login";

export default async function GmailSettingsPage() {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect(LOGIN_PATH);

  const serviceClient = createServiceRoleClient();
  const { data: profile, error } = await serviceClient
    .from("profiles")
    .select("gmail_refresh_token")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.error(
      `[settings-gmail-page] could not read gmail_refresh_token for user ${user.id}: ${error.message}`
    );
    throw new Error("Could not load Gmail connection state. Please refresh and try again.");
  }

  const connected =
    typeof profile?.gmail_refresh_token === "string" && profile.gmail_refresh_token.length > 0;

  return <GmailSettingsView connected={connected} />;
}
