// @vitest-environment node
/**
 * JOB-319 — regression coverage for the two onboarding routing pages that
 * used to swallow a Supabase `error` field and misroute the user.
 *
 * Both `app/onboarding/page.tsx` and `app/onboarding/preview/page.tsx`
 * destructured `data` off a pair of `.maybeSingle()` reads and dropped
 * `error`, so a transient PostgREST failure came through as a null row and
 * `earliestIncompleteStep` interpreted that as "profile not filled in
 * yet". For an already-attested user, that silently sent them back into
 * onboarding.
 *
 * The properties these tests lock in:
 *
 *  1. A profile read error redirects to `/login` with a soft error query
 *     param, not on into `postAuthOnboardingPath` with a null row.
 *  2. A resume read error does the same, even when the profile itself came
 *     back attested (this is the exact misroute the ticket fixes).
 *  3. A clean pair still routes normally through `postAuthOnboardingPath`,
 *     so this fix does not regress the happy path.
 *  4. The console.error line names the query that failed and the user id,
 *     matching the log format the sibling pages already use so one grep
 *     works across all of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

type MaybeSingleResult = { data: unknown; error: unknown };

/** What each page's Promise.all pair will yield, in call order. */
type ReadQueue = MaybeSingleResult[];

// Stable references the vi.mock factories capture at hoist time. Each
// beforeEach clears them and stamps in the per-test resolutions; the pages
// call these bindings directly, so the tests never have to rewire the mock
// object graph after the first import.
const getUserMock = vi.fn();
const getPreviewJobsMock = vi.fn();
const readQueue: ReadQueue = [];

/**
 * The redirect() from next/navigation throws internally so control never
 * falls through to code past it. Our mock throws too, and we recognise the
 * throw here to capture the destination URL for assertions.
 */
class RedirectThrown extends Error {
  constructor(public readonly url: string) {
    super(`redirect(${url})`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectThrown(url);
  },
}));

// The two pages both build a `.from("profiles")...maybeSingle()` and a
// `.from("resumes")...maybeSingle()` in one Promise.all. This fake shuffles
// each `.from()` off the queue in order, matching what the real client
// would produce.
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({
    auth: { getUser: getUserMock },
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          const next = readQueue.shift();
          return next ?? { data: null, error: null };
        },
      };
      return chain;
    },
  }),
}));

// getPreviewJobs is imported by the preview page but never reached in the
// error-branch tests; a stub that resolves to an empty array keeps the
// happy-path assertion honest without triggering a real query.
vi.mock("@/lib/onboarding/preview-query", () => ({
  getPreviewJobs: getPreviewJobsMock,
}));

const { default: OnboardingPage } = await import("@/app/onboarding/page");
const { default: OnboardingPreviewPage } = await import(
  "@/app/onboarding/preview/page"
);

beforeEach(() => {
  getUserMock.mockReset();
  getUserMock.mockResolvedValue({
    data: { user: { id: SESSION_USER } },
  });
  readQueue.length = 0;
  getPreviewJobsMock.mockReset();
  getPreviewJobsMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A tiny wrapper that runs the async page component and hands back whatever
// URL the redirect threw. Anything else propagates.
async function runAndCaptureRedirect(
  page: () => Promise<unknown>,
): Promise<string> {
  try {
    await page();
  } catch (err) {
    if (err instanceof RedirectThrown) return err.url;
    throw err;
  }
  throw new Error("expected the page to redirect, but it returned normally");
}

describe("app/onboarding/page.tsx JOB-319 error handling", () => {
  it("redirects to /login with a soft error param when the profile read errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    readQueue.push(
      { data: null, error: { message: "boom", code: "PGRST000" } },
      { data: null, error: null },
    );
    const url = await runAndCaptureRedirect(
      OnboardingPage as unknown as () => Promise<unknown>,
    );
    expect(url).toMatch(/^\/login\?error=/);
    expect(url).toContain(encodeURIComponent("Could not load your account"));
  });

  it("redirects to /login when the resume read errors even if the profile row is attested", async () => {
    // This is the exact misroute JOB-319 fixes: pre-fix, the null resume
    // row that came out of an errored resume read pinned the user back to
    // step 1 despite the profile being complete.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    readQueue.push(
      {
        data: {
          citizenship_status: "f1",
          current_city: "Austin",
          clearance_eligibility: "no",
          attested_at: "2026-08-31T00:00:00.000Z",
        },
        error: null,
      },
      { data: null, error: { message: "statement timeout" } },
    );
    const url = await runAndCaptureRedirect(
      OnboardingPage as unknown as () => Promise<unknown>,
    );
    expect(url).toMatch(/^\/login\?error=/);
    // The log line names the read that failed and the user id so an
    // engineer can grep for it. Kept a substring check, not a whole
    // string match, so a future co-author who tweaks the wording does not
    // have to update this test in lockstep.
    expect(spy).toHaveBeenCalled();
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain("resume");
    expect(line).toContain(SESSION_USER);
  });

  it("routes through postAuthOnboardingPath on a clean pair (no regression on the happy path)", async () => {
    readQueue.push(
      {
        data: {
          citizenship_status: "f1",
          current_city: "Austin",
          clearance_eligibility: "no",
          attested_at: "2026-08-31T00:00:00.000Z",
        },
        error: null,
      },
      {
        data: { storage_path: "resumes/abc/def.pdf" },
        error: null,
      },
    );
    const url = await runAndCaptureRedirect(
      OnboardingPage as unknown as () => Promise<unknown>,
    );
    expect(url).toBe("/dashboard");
  });
});

describe("app/onboarding/preview/page.tsx JOB-319 error handling", () => {
  it("redirects to /login with a soft error param when the profile read errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    readQueue.push(
      { data: null, error: { message: "boom", code: "PGRST000" } },
      { data: null, error: null },
    );
    const url = await runAndCaptureRedirect(
      OnboardingPreviewPage as unknown as () => Promise<unknown>,
    );
    expect(url).toMatch(/^\/login\?error=/);
    expect(url).toContain(encodeURIComponent("Could not load your account"));
    // The preview page's fallback jobs query must not run when the error
    // branch is taken, since a bounced request should not spend another
    // Supabase round trip.
    expect(getPreviewJobsMock).not.toHaveBeenCalled();
  });

  it("redirects to /login when the resume read errors even if the profile is complete", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    readQueue.push(
      {
        data: {
          citizenship_status: "f1",
          current_city: "Austin",
          clearance_eligibility: "no",
          attested_at: "2026-08-31T00:00:00.000Z",
        },
        error: null,
      },
      { data: null, error: { message: "statement timeout" } },
    );
    const url = await runAndCaptureRedirect(
      OnboardingPreviewPage as unknown as () => Promise<unknown>,
    );
    expect(url).toMatch(/^\/login\?error=/);
    expect(spy).toHaveBeenCalled();
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain("resume");
    expect(line).toContain(SESSION_USER);
  });

  it("bounces an already-attested visitor onward through postAuthOnboardingPath on a clean pair", async () => {
    readQueue.push(
      {
        data: {
          citizenship_status: "f1",
          current_city: "Austin",
          clearance_eligibility: "no",
          attested_at: "2026-08-31T00:00:00.000Z",
        },
        error: null,
      },
      {
        data: { storage_path: "resumes/abc/def.pdf" },
        error: null,
      },
    );
    const url = await runAndCaptureRedirect(
      OnboardingPreviewPage as unknown as () => Promise<unknown>,
    );
    expect(url).toBe("/dashboard");
    expect(getPreviewJobsMock).not.toHaveBeenCalled();
  });
});
