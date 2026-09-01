"use client";

/**
 * JOB-309 — client half of the zero cost preview page.
 *
 * Renders whatever getPreviewJobs found server side. Every field on a card
 * is a real jobs/boards column (HARD STOP 9): nothing here is generated per
 * person, because personalization is explicitly out of scope until a resume
 * has been parsed.
 *
 * ── The localStorage skip ───────────────────────────────────────────────────
 * A profiles.preview_seen_at column would need a migration, a named grant
 * (see CLAUDE.md's rule on new profiles columns) and a round trip on every
 * future /onboarding visit just to answer one yes or no question, for as
 * long as somebody is mid intake. localStorage answers the same question
 * for free, scoped to this browser, which is exactly where "have you
 * already seen this once" belongs: nothing downstream ever reads it, and it
 * is gone the moment this browser's storage is cleared.
 *
 * Checked client side only, because localStorage does not exist on the
 * server that renders this component's first pass. That means the very
 * first paint always shows nothing rather than the cards. That is
 * deliberate: showing the cards and then yanking them away a moment later
 * for a returning visitor would be a worse flash than a brief blank beat
 * before either the cards or the redirect land.
 *
 * No prose hyphens or em dashes per HARD STOP 8.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { PreviewJob } from "@/lib/onboarding/preview-query";

const PREVIEW_SEEN_KEY = "jobinno.onboarding.preview_seen";
const STEP_1_PATH = "/onboarding/step/1";
const INITIAL_VISIBLE = 5;

/**
 * The ten platforms this product targets (see CLAUDE.md), proper cased for
 * display. `jobs.ats` itself is always one of these lowercase strings; a
 * platform this map does not recognise falls back to the raw value rather
 * than guessing at a spelling.
 */
const ATS_DISPLAY_NAME: Record<string, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workable: "Workable",
  bamboohr: "BambooHR",
  breezy: "Breezy",
  jazzhr: "JazzHR",
  recruitee: "Recruitee",
  teamtailor: "Teamtailor",
  smartrecruiters: "SmartRecruiters",
};

function atsLabel(ats: string): string {
  return ATS_DISPLAY_NAME[ats] ?? ats;
}

export function PreviewView({ jobs }: { jobs: PreviewJob[] }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(PREVIEW_SEEN_KEY)) {
        router.replace(STEP_1_PATH);
        return;
      }
      window.localStorage.setItem(PREVIEW_SEEN_KEY, "1");
    } catch {
      // Private browsing, or storage disabled outright. Fail open: showing
      // the preview an extra time on a later visit costs nothing next to
      // blocking onboarding on a browser API that will not cooperate.
    }
    setReady(true);
  }, [router]);

  if (!ready) return null;

  const hasJobs = jobs.length > 0;
  const visibleJobs = jobs.slice(0, visibleCount);
  const hasMore = visibleCount < jobs.length;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Jobinno is already working
        </h1>
        {hasJobs ? (
          <p className="max-w-xl text-base text-pretty text-muted-foreground">
            Queue these for tonight, attach your resume.
          </p>
        ) : null}
      </header>

      {hasJobs ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {visibleJobs.map((job) => (
            <Card key={job.id} size="sm">
              <CardHeader>
                <CardTitle>
                  <span className="block truncate">{job.title}</span>
                  <span className="text-muted-foreground block truncate text-sm font-normal">
                    {job.company}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {job.location ? (
                  <p className="text-muted-foreground text-sm">{job.location}</p>
                ) : null}
                <Badge variant="outline">Via {atsLabel(job.ats)}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardDescription className="text-base">
              500+ CS intern roles are queued and waiting for you.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={() => router.push(STEP_1_PATH)}>
          Continue and attach resume
        </Button>
        {hasMore ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => setVisibleCount(jobs.length)}
          >
            See more first
          </Button>
        ) : null}
      </div>
    </div>
  );
}
