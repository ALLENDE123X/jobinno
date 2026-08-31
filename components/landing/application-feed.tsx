"use client";

/**
 * The live looking application feed that carries the hero (JOB-016).
 *
 * This is the demo. The pitch is that every other tool makes you press apply
 * once per job while Jobinno presses it for you, and a paragraph saying so is
 * far less convincing than watching submissions stack up on their own. It
 * stands in for the product video we do not have yet.
 *
 * ── The events are invented ─────────────────────────────────────────────────
 * Every row below is marketing chrome. The companies are real names used for
 * flavour, the postings are not real postings, and nothing here reads from the
 * database. When there is real usage worth showing, this should be replaced by
 * a recorded or live slice of `applications`, not padded out with more invented
 * rows.
 *
 * ── Why the list is precomputed and deterministic ───────────────────────────
 * The server renders this too. Anything random or clock derived at render time
 * gives the server one answer and the client another, and React reports that as
 * a hydration error. The cycle below is pure index arithmetic for that reason.
 */

import { cn } from "@/lib/utils";
import { AnimatedList } from "@/components/ui/animated-list";

const COMPANIES = [
  { name: "Stripe", tint: "#635bff" },
  { name: "Figma", tint: "#f24e1e" },
  { name: "Notion", tint: "#111827" },
  { name: "Ramp", tint: "#1c6c4a" },
  { name: "Linear", tint: "#5e6ad2" },
  { name: "Vercel", tint: "#0f172a" },
  { name: "Databricks", tint: "#ff3621" },
  { name: "Cloudflare", tint: "#f38020" },
  { name: "Plaid", tint: "#0a85ea" },
  { name: "Datadog", tint: "#632ca6" },
  { name: "Retool", tint: "#3c3c3c" },
  { name: "Brex", tint: "#f36b3b" },
] as const;

const ROLES = [
  "Software Engineer Intern",
  "New Grad Software Engineer",
  "Backend Engineer Intern",
  "Machine Learning Intern",
  "Frontend Engineer, New Grad",
  "Site Reliability Engineer, New Grad",
  "Data Engineer Intern",
  "Product Engineer Intern",
] as const;

const BOARDS = [
  "Greenhouse",
  "Lever",
  "Ashby",
  "Workable",
  "SmartRecruiters",
] as const;

interface FeedEvent {
  role: string;
  company: string;
  tint: string;
  board: string;
  ago: string;
}

/**
 * Walks the three lists at different strides so the pairings keep changing
 * instead of repeating every twelve rows.
 */
function buildFeed(count: number): FeedEvent[] {
  return Array.from({ length: count }, (_unused, index) => {
    const company = COMPANIES[index % COMPANIES.length];
    return {
      role: ROLES[(index * 5) % ROLES.length],
      company: company.name,
      tint: company.tint,
      board: BOARDS[(index * 3) % BOARDS.length],
      ago: index === 0 ? "just now" : `${index}s ago`,
    };
  });
}

const FEED = buildFeed(40);

function FeedRow({ role, company, tint, board, ago }: FeedEvent) {
  return (
    <figure
      className={cn(
        "relative mx-auto w-full overflow-hidden rounded-xl p-3 sm:p-4",
        "bg-card ring-1 ring-border",
        "dark:bg-white/[0.08] dark:ring-white/15 dark:backdrop-blur-sm"
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white sm:size-10"
          style={{ backgroundColor: tint }}
          aria-hidden
        >
          {company.charAt(0)}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {role} at {company}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            Submitted via {board} · {ago}
          </p>
        </div>

        <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 sm:inline-flex dark:text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
          Submitted
        </span>
      </div>
    </figure>
  );
}

export function ApplicationFeed({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-background/60 shadow-xl backdrop-blur",
        className
      )}
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          <span className="text-sm font-medium">Applying now</span>
        </div>
        <span className="text-xs text-muted-foreground">
          while you are asleep
        </span>
      </div>

      <div className="relative h-[360px] overflow-hidden p-3 sm:h-[420px] sm:p-4">
        <AnimatedList delay={1400} className="gap-3">
          {FEED.map((event, index) => (
            <FeedRow key={`${event.company}-${index}`} {...event} />
          ))}
        </AnimatedList>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-background to-transparent" />
      </div>
    </div>
  );
}
