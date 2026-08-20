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
 */

import Link from "next/link";
import { ArrowRight, Check, Clock, Moon, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DotPattern } from "@/components/ui/dot-pattern";
import { ApplicationFeed } from "@/components/landing/application-feed";
import { PipelineDiagram } from "@/components/landing/pipeline-diagram";
import { StatsBand } from "@/components/landing/stats-band";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme";
import { cn } from "@/lib/utils";

/**
 * The two paid plans are the real ones. Do not adjust a number here without the
 * matching change wherever billing reads them once JOB-010 lands.
 */
const PLANS = [
  {
    name: "Free",
    price: "$0",
    cadence: "to try it",
    allowance: "10 applications, total",
    features: [
      "10 applications, once",
      "Every supported ATS platform",
      "Full log of what was submitted",
    ],
    cta: "Start free",
    featured: false,
  },
  {
    name: "Starter",
    price: "$29",
    cadence: "per month",
    allowance: "150 applications every month",
    features: [
      "150 applications per month",
      "Runs overnight, every night",
      "Full log of what was submitted",
      "Cancel whenever you want",
    ],
    cta: "Get Starter",
    featured: true,
  },
  {
    name: "Season Pass",
    price: "$99",
    cadence: "one time",
    allowance: "500 applications, valid 6 months",
    features: [
      "500 applications",
      "Valid for 6 months",
      "Built for one recruiting season",
      "No subscription to remember",
    ],
    cta: "Get the Season Pass",
    featured: false,
  },
] as const;

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

export default function Home() {
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
              <Link href="/login">Get started</Link>
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
                  Every other tool hands you a list and still makes you press
                  apply, one posting at a time. Jobinno drives the real
                  application forms itself, hundreds of them a night, from one
                  resume and one short intake.
                </p>

                <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
                  <Button size="lg" asChild className="h-11 px-6 text-base">
                    <Link href="/login">
                      Get started free
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
                  10 applications free. No card needed.
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

                <Button
                  className="mt-8 h-10 w-full text-sm"
                  variant={plan.featured ? "default" : "outline"}
                  size="lg"
                  asChild
                >
                  <Link href="/login">{plan.cta}</Link>
                </Button>
              </div>
            ))}
          </div>

          <p className="mt-8 text-center text-sm text-muted-foreground">
            Race, gender, veteran status and disability status are always
            answered as decline to self identify, and never stored.
          </p>
        </Section>
      </main>

      <footer className="border-t px-4 py-10 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 text-sm text-muted-foreground sm:flex-row">
          <p className="font-medium text-foreground">Jobinno</p>
          <p>Applications you did not have to sit through.</p>
        </div>
      </footer>
    </div>
  );
}
