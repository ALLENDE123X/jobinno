/**
 * Where app/api/auth/gmail/callback/route.ts sends someone once their Gmail
 * refresh token is stored (JOB-189).
 *
 * ── Why this page trusts arriving here, unlike app/billing/success ─────────
 * That page re-reads the database rather than trusting the mere act of
 * landing on its URL, because Stripe's webhook writes the plan on its own
 * schedule and can arrive after the browser does — trusting the URL there
 * would tell somebody they are on a paid plan before the write has landed.
 * Nothing here has that race: the callback route writes
 * `profiles.gmail_refresh_token` synchronously, in the same request, and only
 * redirects here after that write has already succeeded. A failed write sends
 * the person back to sign in with an error instead. There is also no column
 * this page could re-read to double check: `gmail_refresh_token` has no user
 * side SELECT grant of its own, and reading it back here would be the reason
 * to add one.
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

export default async function GmailConnectedPage() {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

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
