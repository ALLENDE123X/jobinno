/**
 * JOB-228 — what a person actually sees on `/settings/gmail`, split from
 * `page.tsx` the same way `app/dashboard/dashboard-view.tsx` is split from
 * `app/dashboard/page.tsx`: the page is a session check and a query, this is
 * everything a person looks at, and rendering is then testable with a
 * boolean prop instead of a database, which is what
 * `tests/unit/gmail-settings-view.test.tsx` does.
 */

import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { DisconnectGmailButton } from "./disconnect-gmail-button";

const GMAIL_START_PATH = "/api/auth/gmail/start";
const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

export function GmailSettingsView({ connected }: { connected: boolean }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-4 py-12 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>Connect Gmail</CardTitle>
          <CardDescription>
            {connected
              ? "A Gmail account is connected to your Jobinno account."
              : "Jobinno can read verification and security code emails so it can finish account creation and confirm identity while it applies for you."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {connected ? (
            <>
              <p className="text-muted-foreground max-w-prose text-sm">
                We only read messages from job boards such as Ashby, Greenhouse, and other
                applicant tracking systems, looking for verification links and one time codes
                needed to finish creating an account on your behalf. Nothing else in your inbox
                is read or stored.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <DisconnectGmailButton />
                <Button asChild variant="outline" size="sm">
                  <a href={GOOGLE_PERMISSIONS_URL} target="_blank" rel="noreferrer noopener">
                    Review access on Google
                  </a>
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-muted-foreground max-w-prose text-sm">
                Connecting sends you to Google to grant Jobinno readonly access to this Gmail
                account. Once connected, Jobinno will read verification and security code emails
                from Ashby, Greenhouse, and other applicant tracking systems, so it can complete
                account creation and confirm your identity partway through an application. It
                never sends mail from this account and never reads anything unrelated to a job
                application. See our{" "}
                <Link href="/privacy" className="underline underline-offset-4">
                  privacy policy
                </Link>{" "}
                for the full data handling policy.
              </p>

              <Button asChild>
                <a href={GMAIL_START_PATH}>Connect Gmail</a>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
