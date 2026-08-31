/**
 * The Jobinno landing page (JOB-016).
 *
 * The whole page exists to sell one contrast: every other tool in this category
 * hands you a list and still makes you press apply once per posting, and this
 * one presses it for you while you are asleep. The animated feed in the hero is
 * that argument made visible, and it stands in for a product demo video.
 *
 * The page itself is a server component. Only the four pieces that animate or
 * read the theme are client components, so the hero copy and the pricing
 * numbers are in the initial HTML.
 *
 * ── The waitlist banner, now at the bottom (JOB-031, JOB-032, JOB-038) ───
 * jobinno.app is gated behind a waitlist while known bugs are fixed on `v1`;
 * see `lib/waitlist-gate.ts`. JOB-031 first shipped this by rewriting `/`
 * entirely to a separate, much shorter page, which meant nobody could see the
 * real pitch below, the very thing this file exists for. JOB-032 replaced
 * that: `WaitlistBanner` here is the same form and copy that page used, first
 * placed at the top of `<main>`, everything below it unchanged from what
 * JOB-016 shipped. JOB-038 moved it to the end instead, right before the
 * footer, on user feedback that the real pitch should come first.
 *
 * ── Creator referral attribution (JOB-041) ────────────────────────────────
 * `?ref=<code>` on this URL names the creator whose link brought the visitor
 * here. This page reads the live query param via `searchParams`, and falls
 * back to the cookie `middleware.ts` set from an earlier visit's `?ref=` when
 * there is no live one, through `resolveWaitlistReferral` in
 * `lib/waitlist.ts`. The resolved value is threaded down to `WaitlistBanner`
 * and then to `WaitlistForm`, which is what actually submits it.
 *
 * ── Somebody already signed in has no reason to see the marketing pitch
 *    (JOB-020), except while the gate is active ────────────────────────────
 * The check mirrors the one on `/login`: a session sends the visitor straight
 * to `/dashboard` instead of the pitch they have already been sold on. But
 * `/dashboard` is itself gated while `WAITLIST_GATE_ACTIVE` is true and
 * redirects back here, so firing this redirect while the gate is active would
 * send a signed in visitor back and forth between the two routes forever.
 * `WAITLIST_GATE_ACTIVE` (see `lib/waitlist-gate.ts`) suppresses the redirect
 * for exactly as long as the gate is active, and only that; the redirect
 * itself is untouched, so it needs no work to start firing again the moment
 * that flag flips back to false.
 *
 * One case has to skip it regardless of the flag above.
 * `app/api/billing/checkout/route.ts` sends an already signed in person back
 * here with `?billing_error=<code>` when their purchase was refused, for
 * instance somebody who already holds a paid plan pressing buy again, and
 * `BillingError` below is what shows them why. Firing the redirect in that
 * case would send them straight past the message and they would never learn
 * why the purchase did not go through, so the redirect is skipped whenever
 * that parameter is present, and only then.
 */

import { Suspense } from "react";

import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Check, Clock, Moon, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DotPattern } from "@/components/ui/dot-pattern";
import { ApplicationFeed } from "@/components/landing/application-feed";
import { BillingError } from "@/components/landing/billing-error";
import { PipelineDiagram } from "@/components/landing/pipeline-diagram";
import { StatsBand } from "@/components/landing/stats-band";
import { WaitlistForm } from "@/components/landing/waitlist-form";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme";
import {
  BILLING_ERROR_PARAM,
  CHECKOUT_PATH,
  CHECKOUT_PLAN_PARAM,
} from "@/lib/billing/plans";
import { LANDING_PLANS } from "@/lib/pricing";
import { createServerClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import {
  resolveWaitlistReferral,
  WAITLIST_REFERRAL_COOKIE,
  WAITLIST_REFERRAL_QUERY_PARAM,
} from "@/lib/waitlist";
import { WAITLIST_GATE_ACTIVE } from "@/lib/waitlist-gate";

/**
 * The two paid plans are the real ones. The catalog itself is in
 * `lib/pricing.ts`, so the landing page and the dashboard's upgrade cards
 * (`app/dashboard/upgrade-cards.tsx`, JOB-284) render the same numbers and
 * the same copy without either surface owning the source of truth. Do not
 * adjust a number by editing the render here; edit `LANDING_PLANS`.
 */
const PLANS = LANDING_PLANS;

/**
 * The id the waitlist section carries, and where this page's calls to action
 * point while the gate is up.
 *
 * ── Why the buttons could not have worked ───────────────────────────────────
 * `WAITLIST_GATE_ACTIVE` redirects every non-exempt path to `/`, and `/login`
 * is deliberately one of them (see `lib/waitlist-gate.ts`). So a "Get started"
 * button linking to `/login` sent a visitor to the page they were already on,
 * scrolled back to the top, with nothing else to show for it. That is not a
 * button that fails, it is a button that reads as broken, which is how it was
 * reported: Courtney, testing the live site, said the get started button was
 * not working for her and suggested the button say waitlist instead.
 *
 * Both halves of that are the same fix. While the gate is up every call to
 * action leads to the waitlist form at the bottom of this page and says so;
 * when it comes down they go back to `/login` with their original copy, with
 * no second edit here to remember.
 *
 * The paid plan buttons below are the same story for a different reason: they
 * POST to `CHECKOUT_PATH`, which is gated too and for a stated reason — the
 * product being down for maintenance should not have a working, unlisted way
 * to pay for it. While that holds they are links to the waitlist like the
 * rest, rather than a form post that cannot complete.
 */
const WAITLIST_SECTION_ID = "waitlist";
const CTA_HREF = WAITLIST_GATE_ACTIVE ? `#${WAITLIST_SECTION_ID}` : "/login";

/** The copy a call to action carries, given what it would say once open. */
function ctaLabel(whenOpen: string): string {
  return WAITLIST_GATE_ACTIVE ? "Join the waitlist" : whenOpen;
}

const PROMISES = [
  {
    icon: Moon,
    title: "It runs while you sleep",
    body: "Hand it your resume once. It queues overnight and you wake up to submissions, not to a list of things to go press apply on.",
  },
  {
    icon: ShieldCheck,
    title: "It never invents an answer",
    body: "Every free text answer is built from what you told it in your intake. If your data does not support an honest answer, it stops and asks you rather than filling the gap.",
  },
  {
    icon: Clock,
    title: "It logs every single one",
    body: "Role, company, board, timestamp, outcome. You can see exactly what went out under your name.",
  },
] as const;

/** The waitlist form and its surrounding copy (JOB-031), moved here from the
 * page it used to have to itself (JOB-032). See the file header for why.
 * `referredBy` (JOB-041) is only ever handed down from `Home` below, never
 * computed here: this component has no access to the request, only the
 * resolved value it was given. */
function WaitlistBanner({ referredBy }: { referredBy: string | null }) {
  return (
    <Section id={WAITLIST_SECTION_ID} className="border-t bg-muted/30">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 text-center">
        <Badge
          variant="secondary"
          className="rounded-full px-3 py-1 text-xs font-medium"
        >
          Private beta, opening back up soon
        </Badge>

        <div className="flex flex-col items-center gap-3">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Join the waitlist
          </h2>
          <p className="text-base text-pretty text-muted-foreground sm:text-lg">
            We are putting the finishing touches on Jobinno. Leave your email
            and we will let you know the moment it opens back up.
          </p>
        </div>

        <WaitlistForm referredBy={referredBy} />
      </div>
    </Section>
  );
}

function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      // `scroll-mt` keeps the sticky header from covering a heading that an
      // anchor link just jumped to.
      className={cn("scroll-mt-16 px-4 py-16 sm:px-6 sm:py-24", className)}
    >
      <div className="mx-auto w-full max-w-6xl">{children}</div>
    </section>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hasBillingError = typeof params[BILLING_ERROR_PARAM] === "string";

  if (!hasBillingError && !WAITLIST_GATE_ACTIVE) {
    const supabase = await createServerClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) redirect("/dashboard");
  }

  // ── JOB-041: resolve the referral code for this render ───────────────────
  // The live `?ref=` on this request, if any, plus whatever `middleware.ts`
  // already stamped into `WAITLIST_REFERRAL_COOKIE` from an earlier one.
  // `resolveWaitlistReferral` is the one place that decides which wins; see
  // its doc comment in `lib/waitlist.ts`. A `?ref=` repeated in the URL
  // becomes an array, which is never a real referral code, so only a single
  // string value is read from the query.
  const rawReferralParam = params[WAITLIST_REFERRAL_QUERY_PARAM];
  const referralFromQuery =
    typeof rawReferralParam === "string" ? rawReferralParam : undefined;
  const cookieStore = await cookies();
  const referralFromCookie = cookieStore.get(WAITLIST_REFERRAL_COOKIE)?.value;
  const referredBy = resolveWaitlistReferral(
    referralFromQuery,
    referralFromCookie
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <Logo />
            Jobinno
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2">
            <Button
              variant="ghost"
              size="lg"
              asChild
              className="hidden sm:inline-flex"
            >
              <Link href="#how-it-works">How it works</Link>
            </Button>
            <Button
              variant="ghost"
              size="lg"
              asChild
              className="hidden sm:inline-flex"
            >
              <Link href="#pricing">Pricing</Link>
            </Button>
            <ThemeToggle />
            <Button size="lg" asChild>
              <Link href={CTA_HREF}>{ctaLabel("Get started")}</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero. The feed on the right is the demo, see application-feed.tsx. */}
        <div className="relative overflow-hidden">
          <DotPattern className="opacity-60 [mask-image:radial-gradient(520px_circle_at_center,white,transparent)]" />

          <Section className="relative pt-12 sm:pt-20">
            <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
              <div className="flex flex-col items-start gap-6">
                <span className="inline-flex items-center rounded-full border bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
                  Built for CS interns and new grads
                </span>

                <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
                  You sleep. AI applies.
                </h1>

                <p className="max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
                  Jobinno drives the real application forms itself. One resume
                  and a three minute intake, then it fills and submits every
                  night while you sleep.
                </p>

                <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
                  <Button size="lg" asChild className="h-11 px-6 text-base">
                    <Link href={CTA_HREF}>
                      {ctaLabel("Queue tonight's applications")}
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                  <Button
                    variant="outline"
                    size="lg"
                    asChild
                    className="h-11 px-6 text-base"
                  >
                    <Link href="#how-it-works">See how it works</Link>
                  </Button>
                </div>

                <p className="text-sm text-muted-foreground">
                  3 applications free. No card needed.
                </p>
              </div>

              <ApplicationFeed className="w-full" />
            </div>
          </Section>
        </div>

        {/* The contrast, said plainly for anyone who scrolled past the feed. */}
        <Section className="border-t bg-muted/30">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border bg-background p-6 sm:p-8">
              <p className="text-sm font-medium text-muted-foreground">
                Every other tool
              </p>
              <p className="mt-3 text-lg font-medium text-pretty">
                Open a board. Filter. Open a posting. Press apply. Retype the
                same six answers. Upload the same resume. Do it again, three
                hundred times, in the evenings, for months.
              </p>
            </div>
            <div className="rounded-2xl border bg-foreground p-6 text-background sm:p-8">
              <p className="text-sm font-medium opacity-70">Jobinno</p>
              <p className="mt-3 text-lg font-medium text-pretty">
                Upload once. Answer a short intake once. The agent finds the
                openings, fills the real forms on Greenhouse, Lever, Ashby and
                the rest, submits them, and shows you what it did.
              </p>
            </div>
          </div>
        </Section>

        {/* Pipeline. */}
        <Section id="how-it-works" className="border-t">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              One upload in. Hundreds of submissions out.
            </h2>
            <p className="mt-4 text-base text-pretty text-muted-foreground">
              Your resume and your intake answers go in once. Everything after
              that is the agent matching you against live postings and driving a
              real browser through each application form.
            </p>
          </div>

          <div className="mt-12">
            <PipelineDiagram />
          </div>

          <div className="mt-12 grid gap-8 sm:grid-cols-3">
            {PROMISES.map((promise) => (
              <div key={promise.title} className="flex flex-col gap-3">
                <promise.icon className="size-5" />
                <h3 className="text-base font-medium">{promise.title}</h3>
                <p className="text-sm text-pretty text-muted-foreground">
                  {promise.body}
                </p>
              </div>
            ))}
          </div>

          {/* Gmail scope justification (JOB-245) moved to /permissions in
              JOB-306 to remove ~200 words of legal CYA copy from the
              middle of the landing page while preserving the disclosure
              a Google OAuth reviewer expects. See app/permissions/page.tsx
              and the Permissions link in the footer below. */}
        </Section>

        {/* Stats. Two of the three numbers are placeholders, see stats-band.tsx. */}
        <Section className="border-t bg-muted/30">
          <StatsBand />
        </Section>

        {/* Pricing. */}
        <Section id="pricing" className="border-t">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Pricing
            </h2>
            <p className="mt-4 text-base text-pretty text-muted-foreground">
              Start free. Pay when you want the volume.
            </p>
          </div>

          {/* Suspended so that reading the query string here does not make the
              whole landing page render on demand. See billing-error.tsx. */}
          <Suspense fallback={null}>
            <BillingError />
          </Suspense>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={cn(
                  "flex flex-col rounded-2xl border p-6 sm:p-8",
                  plan.featured
                    ? "border-foreground/20 bg-card shadow-lg ring-1 ring-foreground/10"
                    : "bg-card/40"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-lg font-medium">{plan.name}</h3>
                  {plan.featured ? (
                    <span className="rounded-full bg-foreground px-2.5 py-1 text-xs font-medium whitespace-nowrap text-background">
                      Most popular
                    </span>
                  ) : null}
                </div>

                <p className="mt-4 flex items-baseline gap-2">
                  <span className="text-4xl font-semibold tracking-tight">
                    {plan.price}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {plan.cadence}
                  </span>
                </p>

                <p className="mt-2 text-sm font-medium">{plan.allowance}</p>

                <ul className="mt-6 flex flex-1 flex-col gap-3">
                  {plan.features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-start gap-2 text-sm"
                    >
                      <Check className="mt-0.5 size-4 shrink-0" />
                      <span className="text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>

                {plan.slug === "free" || WAITLIST_GATE_ACTIVE ? (
                  <Button
                    className="mt-8 h-10 w-full text-sm"
                    variant={plan.featured ? "default" : "outline"}
                    size="lg"
                    asChild
                  >
                    <Link href={CTA_HREF}>{ctaLabel(plan.cta)}</Link>
                  </Button>
                ) : (
                  // A plain form post rather than an onClick, so the button
                  // needs no client JavaScript and this page stays a server
                  // component. The route checks the session and sends somebody
                  // who is signed out to sign in first, then back here.
                  <form action={CHECKOUT_PATH} method="post" className="mt-8">
                    <input
                      type="hidden"
                      name={CHECKOUT_PLAN_PARAM}
                      value={plan.slug}
                    />
                    <Button
                      type="submit"
                      className="h-10 w-full text-sm"
                      variant={plan.featured ? "default" : "outline"}
                      size="lg"
                    >
                      {plan.cta}
                    </Button>
                  </form>
                )}
              </div>
            ))}
          </div>

          <p className="mt-8 text-center text-sm text-muted-foreground">
            Race, gender, veteran status and disability status are always
            answered as decline to self identify, and never stored.
          </p>
        </Section>

        {WAITLIST_GATE_ACTIVE ? <WaitlistBanner referredBy={referredBy} /> : null}
      </main>

      <footer className="border-t px-4 py-10 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 text-sm text-muted-foreground sm:flex-row">
          <div className="flex flex-col items-center gap-1 sm:items-start">
            <p className="font-medium text-foreground">Jobinno</p>
            <p className="text-xs">Operated by Pranav Lende</p>
          </div>
          <p>Applications you did not have to sit through.</p>
          <div className="flex items-center gap-4">
            <Link
              href="/privacy"
              className="underline underline-offset-3 hover:text-foreground"
            >
              Privacy
            </Link>
            <Link
              href="/permissions"
              className="underline underline-offset-3 hover:text-foreground"
            >
              Permissions
            </Link>
            <Link
              href="/terms"
              className="underline underline-offset-3 hover:text-foreground"
            >
              Terms
            </Link>
            <a
              href="mailto:hello@jobinno.app"
              className="underline underline-offset-3 hover:text-foreground"
            >
              hello@jobinno.app
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
