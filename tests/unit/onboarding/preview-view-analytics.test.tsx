/**
 * JOB-320. That the two preview events fire when the funnel says they fire,
 * carry nothing but a listing count, and do not fire on the localStorage skip
 * auto redirect path a returning visitor takes.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `components/analytics.tsx` starts PostHog lazily and only after `posthog.init`
 * has run. In a jsdom test there is no init, so `captureClientEvent` is a no op
 * regardless of what a caller passes it. That is fine for testing that the
 * runtime does not throw, but it says nothing about whether the right event
 * fired at the right moment with the right shape, which is the whole point of
 * an instrumentation ticket. The module is stubbed at its own boundary so the
 * calls become observable, mirroring the pattern
 * `tests/unit/analytics-instrumentation.test.ts` uses for the server side.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewJob } from "@/lib/onboarding/preview-query";

const push = vi.fn();
const replace = vi.fn();
const captureClientEvent = vi.fn();

// One stable router object, not a fresh literal per call. The real hook
// returns a memoized object, and the effect under test lists `router` in its
// dependency array; a per-call literal would re-fire the effect on every
// render and hide the intent of what is being tested.
const router = { push, replace };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

vi.mock("@/components/analytics", () => ({
  captureClientEvent: (...args: unknown[]) => captureClientEvent(...args),
}));

const { PreviewView } = await import("@/app/onboarding/preview/preview-view");

const PREVIEW_SEEN_KEY = "jobinno.onboarding.preview_seen";

function fixtureJobs(count: number): PreviewJob[] {
  return Array.from({ length: count }).map((_, index) => ({
    id: `job-${index}`,
    title: `Software Engineer Intern ${index}`,
    company: `Fixture Company ${index}`,
    location: "Remote",
    ats: "greenhouse",
  }));
}

beforeEach(() => {
  push.mockClear();
  replace.mockClear();
  captureClientEvent.mockClear();
  window.localStorage.clear();
});

describe("PreviewView analytics", () => {
  it("fires PREVIEW_VIEWED on the first visit with the count of listings shown", async () => {
    render(<PreviewView jobs={fixtureJobs(4)} />);

    // Wait for the cards to actually render, which happens after the effect
    // has decided this is not the auto redirect path.
    await screen.findByRole("button", { name: "Continue and attach resume" });

    expect(captureClientEvent).toHaveBeenCalledWith("preview_viewed", {
      preview_listing_count: 4,
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not fire PREVIEW_VIEWED on the localStorage skip auto redirect", async () => {
    window.localStorage.setItem(PREVIEW_SEEN_KEY, "1");

    render(<PreviewView jobs={fixtureJobs(3)} />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/onboarding/step/1"));

    // The whole reason this event exists is to distinguish a genuine view from
    // the skip path a returning visitor takes. If it fires here, the funnel
    // signal is contaminated exactly the way the ticket set out to prevent.
    expect(captureClientEvent).not.toHaveBeenCalledWith(
      "preview_viewed",
      expect.anything(),
    );
  });

  it("fires PREVIEW_CTA_CLICKED before it navigates to step 1", async () => {
    render(<PreviewView jobs={fixtureJobs(5)} />);

    const button = await screen.findByRole("button", { name: "Continue and attach resume" });
    captureClientEvent.mockClear();

    fireEvent.click(button);

    expect(captureClientEvent).toHaveBeenCalledWith("preview_cta_clicked", {
      preview_listing_count: 5,
    });
    expect(push).toHaveBeenCalledWith("/onboarding/step/1");
  });

  it("reports zero listings honestly when the pool was empty", async () => {
    render(<PreviewView jobs={[]} />);

    await screen.findByRole("button", { name: "Continue and attach resume" });

    expect(captureClientEvent).toHaveBeenCalledWith("preview_viewed", {
      preview_listing_count: 0,
    });
  });
});
