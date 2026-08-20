/**
 * Where Stripe returns somebody after a successful checkout (JOB-010).
 *
 * ── Why this page does not activate anything ────────────────────────────────
 * Landing here means Stripe took the payment, not that we have heard about it.
 * The webhook is the only thing that writes a plan, and it is a separate
 * request on its own schedule, so it may well arrive after the browser does.
 *
 * Two ways to get that wrong. Activating from this page would put the write on
 * a path anybody can visit by typing the URL, and a `session_id` in a query
 * string is not proof of anything. Asserting the plan is live before reading it
 * would tell somebody they are on Starter when the write has not landed. So the
 * page reads the row and says what is actually true right now, which for the
 * first second or two is usually "paid, still settling".
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
import { PAID_PLANS, isPaidPlanSlug } from "@/lib/billing/plans";
import { createServerClient } from "@/lib/supabase/server";

export default async function BillingSuccessPage() {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("plan, applications_cap")
    .eq("id", user.id)
    .maybeSingle();

  const plan = profile?.plan;
  const isActive = isPaidPlanSlug(plan);
  const label = isActive ? PAID_PLANS[plan].label : null;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Thank you, your payment went through</CardTitle>
          <CardDescription>
            {isActive
              ? `${label} is active on your account.`
              : "We are waiting on Stripe to confirm it. This usually takes a few seconds, so refresh in a moment and it will be here."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {isActive ? (
            <p className="text-sm text-muted-foreground">
              You can send {profile?.applications_cap} applications. Finish your
              intake and Jobinno will start working through them.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/onboarding">Go to your intake</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">Back to the home page</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
