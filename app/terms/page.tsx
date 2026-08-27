/**
 * JOB-205 — the public terms of service at /terms.
 *
 * Paired with `app/privacy/page.tsx`. Both pages are named in the Google
 * Auth Platform branding submission for the OAuth app that requests the
 * gmail.readonly scope. This page is deliberately public and pure content,
 * so a signed out visitor sees the same page a signed in one does. `/terms`
 * is added to the waitlist gate's exempt list (see `lib/waitlist-gate.ts`)
 * so it stays reachable if the gate is turned back on.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { Logo } from "@/components/logo";

export const metadata: Metadata = {
  title: "Terms of Service: Jobinno",
  description:
    "The terms that govern your use of Jobinno, an autonomous job application agent for CS interns and new grads.",
};

const LAST_UPDATED = "August 26, 2026";

export default function TermsPage() {
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
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>
          <a
            href="mailto:hello@jobinno.app"
            className="hover:text-foreground"
          >
            Contact
          </a>
        </nav>
      </header>

      <main className="flex flex-col gap-4 text-base leading-relaxed text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-foreground [&_h2]:mt-8 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_ul]:list-disc [&_ul]:pl-6 [&_li]:mt-1">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Terms of Service
        </h1>
        <p className="text-sm text-muted-foreground">
          Last updated: {LAST_UPDATED}
        </p>

        <p>
          These terms govern your use of Jobinno, an autonomous job
          application agent for CS interns and new grads. Jobinno is a
          product operated by Pranav Lende. By creating an account or using
          the service, you agree to these terms and to the{" "}
          <Link href="/privacy">Privacy Policy</Link>.
        </p>

        <h2>What Jobinno does</h2>
        <p>
          Jobinno reads one resume and one short set of intake answers you
          provide, finds openings on public job boards, and drives a real
          browser through each application form on your behalf. Every
          submitted application is logged for you to review.
        </p>

        <h2>Your account</h2>
        <p>
          You need a Jobinno account to use the service. You are
          responsible for the answers you enter into the intake, for the
          resume you upload, and for keeping your login credentials safe.
          You confirm that everything you supply is truthful, and you
          understand that submitting an application through Jobinno is,
          from a legal standpoint, the same as submitting it yourself.
        </p>

        <h2>Acceptable use</h2>
        <p>
          You may use Jobinno to apply on your own behalf to positions you
          are legitimately interested in. You may not:
        </p>
        <ul>
          <li>
            Use Jobinno to apply on behalf of another person without their
            explicit permission.
          </li>
          <li>
            Submit false information about yourself, your education, your
            work authorization, or your identity.
          </li>
          <li>
            Use Jobinno to send abusive, harassing, unlawful, or
            misleading content through any application form.
          </li>
          <li>
            Attempt to reverse engineer, disrupt, or overload the service,
            or bypass rate limits and usage caps.
          </li>
          <li>
            Resell, sublicense, or provide the service to a third party as
            your own.
          </li>
        </ul>
        <p>
          Jobinno may suspend or terminate an account that violates any of
          these rules, or that appears to be operated by an automated
          system rather than by a real applicant.
        </p>

        <h2>Applications you submit</h2>
        <p>
          Jobinno drives the real form on the real job board. Once the
          form is submitted, that copy of your application belongs to the
          job board and is governed by the board&apos;s own terms and
          privacy policy. Jobinno cannot recall or delete an application
          that has already been submitted.
        </p>
        <p>
          Jobinno answers form questions only from your intake data. It
          does not invent facts about you. If your intake data does not
          support an honest answer to a required question, the run stops
          and asks you rather than filling the gap.
        </p>

        <h2>Demographic questions</h2>
        <p>
          Race, gender, veteran status, and disability status are always
          answered as decline to self identify. Those fields are never
          stored, inferred, or transmitted anywhere by Jobinno.
        </p>

        <h2>Paid plans</h2>
        <p>
          Paid plans are billed through Stripe. Each plan carries an
          application cap and a billing cadence disclosed at checkout.
          Monthly plans renew automatically until you cancel. A plan you
          buy once does not renew.
        </p>
        <p>
          You can cancel a subscription at any time. Cancellation takes
          effect at the end of the current billing period, and
          applications already submitted within that period are not
          refunded. If you believe you were billed in error, write to{" "}
          <a href="mailto:hello@jobinno.app">hello@jobinno.app</a>.
        </p>

        <h2>Third party services</h2>
        <p>
          Jobinno relies on Supabase, Vercel, Inngest, Browserbase, Stripe,
          PostHog, Anthropic, and Google to run the product. Their terms
          govern their part of the service. If any of those providers
          becomes unavailable, Jobinno may pause the pipeline until the
          outage is resolved.
        </p>

        <h2>Warranties</h2>
        <p>
          Jobinno is provided as is and as available. We do not promise
          that it will find you a job, that any specific board will remain
          reachable, or that a particular form will submit successfully.
          To the fullest extent allowed by law, Jobinno disclaims all
          warranties of any kind, express or implied, including
          merchantability, fitness for a particular purpose, and
          noninfringement.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          To the fullest extent allowed by law, Jobinno&apos;s total
          liability for any claim relating to the service is limited to
          the greater of one hundred United States dollars or the amount
          you paid Jobinno in the twelve months before the claim arose.
          Jobinno is not liable for indirect, incidental, consequential,
          special, or punitive damages, or for lost profits, lost
          opportunities, or lost data.
        </p>

        <h2>Indemnification</h2>
        <p>
          You agree to defend and hold Jobinno harmless from any claim,
          demand, or expense that arises out of information you supplied
          that turned out to be false, or out of a use of the service that
          violates these terms.
        </p>

        <h2>Termination</h2>
        <p>
          You can close your account at any time by writing to{" "}
          <a href="mailto:hello@jobinno.app">hello@jobinno.app</a>.
          Jobinno may terminate an account for a violation of these terms,
          for prolonged inactivity, or if the service is discontinued. On
          termination, the retention rules in the{" "}
          <Link href="/privacy">Privacy Policy</Link> govern what happens
          to your data.
        </p>

        <h2>Changes to these terms</h2>
        <p>
          If these terms change in a way that meaningfully affects your
          rights, the change will be posted here and a notice will be sent
          to the email address on your account.
        </p>

        <h2>Governing law and disputes</h2>
        <p>
          These terms are governed by the laws of the State of California,
          without regard to conflict of law rules. Any dispute that cannot
          be resolved by writing to{" "}
          <a href="mailto:hello@jobinno.app">hello@jobinno.app</a> must be
          brought in the state or federal courts located in San Francisco
          County, California, and both parties consent to that
          jurisdiction.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these terms go to{" "}
          <a href="mailto:hello@jobinno.app">hello@jobinno.app</a>.
        </p>
      </main>

      <footer className="mt-16 border-t pt-6 text-sm text-muted-foreground">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <p className="font-medium text-foreground">Jobinno</p>
          <div className="flex items-center gap-4">
            <Link href="/" className="hover:text-foreground">
              Home
            </Link>
            <Link href="/privacy" className="hover:text-foreground">
              Privacy
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
