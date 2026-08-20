/**
 * Intake, in one sitting. Everything the pipeline needs to fill a real
 * application form, asked once.
 *
 * Authorization lives here rather than in `middleware.ts`, next to the thing it
 * protects and where a redirect can say why. Middleware's job is keeping the
 * session fresh; deciding who may see a page is a page's own business.
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

import { IntakeForm } from "./intake-form";

export default async function OnboardingPage() {
  const supabase = await createServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("attested_at")
    .eq("id", user.id)
    .maybeSingle();

  const attestedAt: string | null = profile?.attested_at ?? null;

  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      {attestedAt ? (
        // Intake is answered once for now. Editing it again means deciding what
        // happens to a run already in flight against these answers, and that is
        // a question worth its own ticket rather than a second submit button.
        <Card>
          <CardHeader>
            <CardTitle>You are set up</CardTitle>
            <CardDescription>
              You confirmed your details on{" "}
              {new Date(attestedAt).toLocaleDateString()}. To change anything,
              get in touch and we will sort it out.
            </CardDescription>
          </CardHeader>
          {/*
            JOB-009. Without this there is no route to the dashboard anywhere in
            the app: sign in lands here, and an onboarded person saw a card with
            nothing after it.
          */}
          <CardContent>
            <Button asChild>
              <Link href="/dashboard">Go to your applications</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <header className="mb-6 space-y-1">
            <h1 className="text-2xl font-semibold">Tell us about your search</h1>
            <p className="text-muted-foreground text-sm">
              Jobinno fills real application forms with these answers, so it is
              worth getting them right. It takes about three minutes.
            </p>
          </header>

          <IntakeForm userId={user.id} />
        </>
      )}
    </main>
  );
}
