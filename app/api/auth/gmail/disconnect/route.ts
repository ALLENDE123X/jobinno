/**
 * JOB-228 — the other half of `app/settings/gmail/page.tsx`'s connected
 * state. Nulls out `profiles.gmail_refresh_token` for the signed in caller,
 * revoking Jobinno's own record of the connection without touching
 * anything on Google's side; the page also links out to
 * https://myaccount.google.com/permissions so a person can revoke Jobinno's
 * grant there too.
 *
 * POST /api/auth/gmail/disconnect
 *  1. Requires a signed in user. Anyone else gets a 401, since this is
 *     called by client side `fetch` from `disconnect-gmail-button.tsx`
 *     rather than navigated to directly, so a redirect to /login would
 *     never be followed by a browser.
 *  2. Nulls `gmail_refresh_token` through the service role client, the same
 *     one `app/api/auth/gmail/callback/route.ts` writes it with, because
 *     that column has no user side UPDATE grant at all — see
 *     drizzle/0026_profiles_gmail_refresh_token_privileges.sql.
 *
 * The user id comes only from `supabase.auth.getUser()`, which asks the
 * Auth server rather than trusting anything the request body could name.
 * There is no request body this route reads at all.
 */

import { NextResponse } from "next/server";

import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";

const LOG = "[gmail-oauth-disconnect]";

export async function POST(): Promise<NextResponse> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  let serviceClient: ReturnType<typeof createServiceRoleClient>;
  try {
    serviceClient = createServiceRoleClient();
  } catch (thrown) {
    const detail = thrown instanceof Error ? thrown.message : "service role client unavailable";
    console.error(`${LOG} service role client unavailable for user ${user.id}: ${detail}`);
    return NextResponse.json({ error: "could not disconnect Gmail" }, { status: 500 });
  }

  const { data: updatedRows, error: writeError } = await serviceClient
    .from("profiles")
    .update({ gmail_refresh_token: null })
    .eq("id", user.id)
    .select("id");

  if (writeError) {
    console.error(`${LOG} could not clear refresh token for user ${user.id}: ${writeError.message}`);
    return NextResponse.json({ error: "could not disconnect Gmail" }, { status: 500 });
  }

  if (updatedRows?.length !== 1) {
    console.error(
      `${LOG} update matched ${updatedRows?.length ?? 0} profiles rows for user ${user.id}; ` +
        "refresh token not cleared"
    );
    return NextResponse.json({ error: "profile row not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
