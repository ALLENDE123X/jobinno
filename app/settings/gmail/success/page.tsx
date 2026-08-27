/**
 * Represents the outcome of the Gmail connect flow that
 * app/api/auth/gmail/callback/route.ts drives (JOB-189, and JOB-198's fix
 * to stop dropping the error info on a page that never rendered it). The
 * callback lands the browser here in both branches, after its session
 * check has passed: on success, once the encrypted refresh token has been
 * written to `profiles`; and on failure of any step after the session
 * check, with an `error` search param carrying the reason string. This
 * page decides which card to render by looking at that search param. No
 * `error` means the success card. A present `error` means the error card,
 * with the callback's own reason string used as the description, so the
 * message a person reads here is the same one the handler wrote and
 * nothing invents a new taxonomy of codes on top of it.
 *
 * ── Why this page trusts arriving here, unlike app/billing/success ─────────
 * That page re-reads the database rather than trusting the mere act of
 * landing on its URL, because Stripe's webhook writes the plan on its own
 * schedule and can arrive after the browser does — trusting the URL there
 * would tell somebody they are on a paid plan before the write has landed.
 * Nothing here has that race: the callback route writes
 * `profiles.gmail_refresh_token` synchronously, in the same request, and
 * only redirects here without an `error` after that write has already
 * succeeded. A failed write redirects here with `error` set instead, so
 * the success card only ever renders on a run that actually stored a
 * token. There is also no column this page could re-read to double check:
 * `gmail_refresh_token` has no user side SELECT grant of its own, and
 * reading it back here would be the reason to add one.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createServerClient } from "@/lib/supabase/server";

export default async function GmailConnectedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const params = await searchParams;
  const errorRaw = params.error;
  const errorMessage =
    typeof errorRaw === "string"
      ? errorRaw
      : Array.isArray(errorRaw) && typeof errorRaw[0] === "string"
        ? errorRaw[0]
        : null;

  if (errorMessage) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Gmail could not be connected</CardTitle>
            <CardDescription>{errorMessage}</CardDescription>
          </CardHeader>

          <CardContent>
            <Button asChild>
              <Link href="/dashboard">Back to your dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Gmail is connected</CardTitle>
          <CardDescription>
            Jobinno can now read this Gmail account when a job board asks for
            an emailed verification code.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <Button asChild>
            <Link href="/dashboard">Back to your dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
