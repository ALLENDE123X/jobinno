/**
 * JOB-205 — the public privacy policy at /privacy.
 *
 * This exists to satisfy Google OAuth verification for the gmail.readonly
 * scope the app requests through `app/api/auth/gmail/start/route.ts`. The
 * page is deliberately public and pure content, without any client state or
 * side effect, so that Google's crawler and a signed out visitor see exactly
 * the same thing. `/privacy` is added to the waitlist gate's exempt list
 * (see `lib/waitlist-gate.ts`) so it stays reachable if the gate is turned
 * back on.
 *
 * Every claim on the page below has to be true of what the code actually
 * does today. See CLAUDE.md HARD STOP 9 and the accompanying PR body for
 * the items that are flagged as blocked on other work rather than claimed
 * here.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { Logo } from "@/components/logo";

export const metadata: Metadata = {
  title: "Privacy Policy: Jobinno",
  description:
    "How Jobinno collects, uses, and protects your data, including the Gmail data you may choose to connect for the gmail.readonly scope.",
};

const LAST_UPDATED = "August 26, 2026";

export default function PrivacyPage() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-10 sm:px-6 sm:py-16">
      <header className="mb-10 flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 text-base font-semibold tracking-tight"
        >
          <Logo />
          Jobinno
        </Link>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link href="/terms" className="hover:text-foreground">
            Terms
          </Link>
          <a
            href="mailto:hello@jobinno.app"
            className="hover:text-foreground"
          >
            Contact
          </a>
        </nav>
      </header>

      <main className="flex flex-col gap-4 text-base leading-relaxed text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-foreground [&_h2]:mt-8 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-6 [&_li]:mt-1 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Privacy Policy
        </h1>
        <p className="text-sm text-muted-foreground">
          Last updated: {LAST_UPDATED}
        </p>

        <p>
          Jobinno is an autonomous job application agent for CS interns and
          new grads, operated by Pranav Lende and reachable at{" "}
          <a href="mailto:hello@jobinno.app">hello@jobinno.app</a>. This
          policy describes what data Jobinno collects, how it is used, who it
          is shared with, and the choices you have about it.
        </p>

        <h2>What Jobinno collects</h2>
        <p>
          Account and profile data. When you sign up, Jobinno stores your
          email address, an authentication record managed by Supabase Auth,
          and the intake answers you provide (such as your name, phone
          number, work authorization status, target role, and similar fields
          you enter into the intake form).
        </p>
        <p>
          Resume file. If you upload a resume, the file is stored in a
          private Supabase storage bucket and the parsed text is stored in
          the database so the agent can read it while filling application
          forms.
        </p>
        <p>
          Application activity. Every application the agent submits on your
          behalf is logged: the role, the company, the board, a timestamp,
          and the outcome. This is what shows up in your dashboard.
        </p>
        <p>
          Billing data. If you buy a paid plan, Stripe handles the payment.
          Jobinno stores only your Stripe customer identifier and the plan
          you are on. Card numbers and payment credentials never touch
          Jobinno&apos;s servers.
        </p>
        <p>
          Product analytics. PostHog collects event data about how you use
          the dashboard so we can see which parts of the product work and
          which do not. Analytics are not tied to your resume content or to
          any Gmail data.
        </p>

        <h2>Gmail data</h2>
        <p>
          Jobinno requests read only access to your Gmail through the Google
          OAuth scope named <code>gmail.readonly</code>. Granting this scope
          is optional. If you choose not to connect Gmail, every other part
          of Jobinno still works.
        </p>

        <h3>Why the scope is requested</h3>
        <p>
          Some job boards require you to create an account on their site
          before you can apply, and creating that account means receiving a
          security code by email and typing it back into the board. Once the
          automated account creation feature is turned on for your account,
          Jobinno will read only the specific verification code messages
          needed to complete those signups on your behalf. Today, before
          that feature is enabled, connecting Gmail stores the refresh token
          but the app does not open any messages. The stored token exists so
          that when the feature ships you do not need to grant consent
          again.
        </p>

        <h3>What Jobinno reads and does not read</h3>
        <p>
          When the feature is enabled, the app fetches only messages that
          match a verification pattern (a security code, a confirm your
          email link, or similar) from a small allowlist of known job board
          sender domains. Jobinno does not read personal correspondence,
          marketing mail, drafts, contacts, calendar invites, attachments,
          or any other Gmail data. It does not search your inbox for job
          related content, resumes, offers, or salary information.
        </p>
        <p>
          The scope named <code>gmail.readonly</code> grants more access
          than the app uses; the code is written to restrict itself to the
          messages described above. You can review or revoke Jobinno&apos;s
          access to your Gmail at any time at{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
          >
            https://myaccount.google.com/permissions
          </a>
          .
        </p>

        <h3>How the token is stored</h3>
        <p>
          The Gmail OAuth refresh token is encrypted at rest with an
          application key held outside the database, and written to a
          column on your profile that has no user side read grant. Only the
          code paths that call the Gmail API on your behalf can decrypt it.
        </p>

        <h3>Limited Use</h3>
        <p>
          Jobinno&apos;s use of information received from Google APIs
          adheres to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. Specifically:
        </p>
        <ul>
          <li>Jobinno does not use Gmail data for advertising.</li>
          <li>Jobinno does not sell Gmail data.</li>
          <li>
            Jobinno does not transfer Gmail data to third parties, except as
            needed to provide or improve the specific feature that reads
            verification code messages, to comply with applicable law, or as
            part of a merger, acquisition, or asset sale in which the
            acquiring party honors this policy.
          </li>
          <li>
            Jobinno does not use Gmail data to develop, improve, or train
            generalized artificial intelligence or machine learning models.
          </li>
          <li>
            Human beings do not read your Gmail messages except when you
            explicitly ask for support that requires it, when required by
            law, or to investigate suspected abuse or a security incident.
          </li>
        </ul>

        <h2>How Jobinno uses your data</h2>
        <p>
          The intake answers and resume are read by the automation agent
          while it fills application forms, and by the language model that
          decides how to answer a specific question on a specific form.
          Every free text answer the agent submits is grounded in what you
          told the intake. The model is not permitted to invent facts about
          you. If your intake data does not support an honest answer, the
          run stops and asks you rather than filling the gap.
        </p>
        <p>
          Application activity is used to build the dashboard and to
          enforce the applications cap on your plan.
        </p>
        <p>Billing data is used only to run billing.</p>

        <h2>Who Jobinno shares data with</h2>
        <p>
          Jobinno relies on a small set of infrastructure providers to run
          the product. Each provider processes only the data needed to
          deliver its part of the service:
        </p>
        <ul>
          <li>
            Supabase hosts the database, authentication, and the private
            resume storage bucket.
          </li>
          <li>Vercel hosts the web application.</li>
          <li>
            Inngest runs the background pipeline that queues and executes
            applications.
          </li>
          <li>
            Browserbase runs the remote browser sessions the agent drives.
          </li>
          <li>
            Anthropic and Google provide the language models the agent
            calls while deciding how to answer form questions.
          </li>
          <li>Stripe runs billing for paid plans.</li>
          <li>PostHog runs product analytics.</li>
        </ul>
        <p>
          Jobinno does not sell your data. Jobinno does not share Gmail
          data with any third party for that third party&apos;s own
          purposes.
        </p>

        <h2>Data on job boards you apply to</h2>
        <p>
          The whole point of the product is that Jobinno submits your
          application to job boards you name. Once a form is submitted, the
          board holds that copy of your data under its own privacy policy,
          and Jobinno cannot delete it on your behalf.
        </p>

        <h2>Demographic data</h2>
        <p>
          Race, gender, veteran status, and disability status are always
          answered as decline to self identify on every form Jobinno fills.
          Those fields are never stored by Jobinno, never inferred from any
          other data, and never transmitted anywhere by us.
        </p>

        <h2>Retention and deletion</h2>
        <p>
          Account and profile data, resume files, and application activity
          are retained while your account is active. Application activity
          is retained after cancellation for as long as it is needed to
          answer billing questions and to comply with tax and accounting
          obligations, then deleted.
        </p>
        <p>
          To disconnect Jobinno from your Gmail account, revoke access at{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
          >
            https://myaccount.google.com/permissions
          </a>
          . You can also request that the stored refresh token be removed
          from Jobinno by writing to{" "}
          <a href="mailto:hello@jobinno.app">hello@jobinno.app</a>; it will
          be deleted within thirty days of the request.
        </p>
        <p>
          To delete your Jobinno account and all associated data, write to{" "}
          <a href="mailto:hello@jobinno.app">hello@jobinno.app</a>. Account
          data, resume files, intake answers, and application logs will be
          deleted within thirty days of the request, except where a longer
          retention period is required by law.
        </p>

        <h2>Security</h2>
        <p>
          Data is transmitted over TLS. The database uses row level
          security so that one user&apos;s data is not visible to another.
          Gmail refresh tokens are encrypted at rest. Application keys and
          secrets are held in the deployment environment and never checked
          into source control.
        </p>

        <h2>Children</h2>
        <p>
          Jobinno is not directed at anyone under the age of sixteen and
          does not knowingly collect their data. If you believe a minor has
          created an account, write to{" "}
          <a href="mailto:hello@jobinno.app">hello@jobinno.app</a> and we
          will remove it.
        </p>

        <h2>Changes to this policy</h2>
        <p>
          If this policy changes in a way that meaningfully affects what
          Jobinno does with your data, the change will be posted here and a
          notice will be sent to the email address on your account.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this policy, or requests to delete your data, go
          to <a href="mailto:hello@jobinno.app">hello@jobinno.app</a>.
        </p>
      </main>

      <footer className="mt-16 border-t pt-6 text-sm text-muted-foreground">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <p className="font-medium text-foreground">Jobinno</p>
          <div className="flex items-center gap-4">
            <Link href="/" className="hover:text-foreground">
              Home
            </Link>
            <Link href="/terms" className="hover:text-foreground">
              Terms
            </Link>
            <a
              href="mailto:hello@jobinno.app"
              className="hover:text-foreground"
            >
              hello@jobinno.app
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
