/**
 * The sign in page. Server side so that an `error` handed back by
 * `app/auth/callback/route.ts` is rendered on the first paint rather than after
 * a client component has mounted and gone looking for it.
 *
 * ── Somebody already signed in has no reason to see this form (JOB-020) ─────
 * The check is the mirror of the one on `/dashboard`: no session goes to sign
 * in, and here a session goes straight past it. `getUser()` asks the Auth
 * server rather than reading a cookie, matching every other page that gates on
 * a session, so this cannot be fooled by a stale cookie the server has already
 * invalidated.
 *
 * The `error` query parameter still matters for a signed out visitor, since
 * that is who lands here after a failed magic link exchange. It is read after
 * the redirect check rather than before, because by the time this line runs
 * the visitor is confirmed signed out, and the redirect branch above already
 * fired for anyone who is not.
 */

import { redirect } from "next/navigation";

import { PageShell } from "@/components/page-shell";
import { createServerClient } from "@/lib/supabase/server";

import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) redirect("/dashboard");

  const params = await searchParams;
  const error = params.error;

  return (
    <PageShell>
      <main className="relative flex flex-1 items-center justify-center px-4 py-16 sm:px-6">
        <LoginForm initialError={typeof error === "string" ? error : undefined} />
      </main>
    </PageShell>
  );
}
