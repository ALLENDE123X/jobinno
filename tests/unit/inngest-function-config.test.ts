// @vitest-environment node
/**
 * The declared configuration of the pipeline's Inngest functions.
 *
 * ── Why configuration gets its own suite ────────────────────────────────────
 * A concurrency limit is not code that runs in this process. It is a field on
 * the object handed to `createFunction`, shipped to Inngest by the serve
 * route's sync, and enforced by Inngest's queue. Nothing in this repository
 * executes it, nothing type checks it against the event it keys on, and a run
 * with the guard removed behaves identically in every other test here — it just
 * stops being safe in production. So the declaration is asserted directly,
 * which is the same reasoning `tests/unit/inngest-serve-route.test.ts` gives
 * for asserting the registration list.
 *
 * ── What the key expression is, and why it is checked against a real payload ─
 * `key` is a CEL expression evaluated by Inngest against the triggering event.
 * It is a string, so `"event.data.userId"` survives any rename of `userId` on
 * this side without a compile error — and a key that names a field the event
 * does not carry does not fail loudly. It evaluates to nothing, every run lands
 * in one group, and the limit silently becomes global. The last test walks the
 * path over an event `jobSearchEvent` really built, so the expression is pinned
 * to the payload rather than to itself.
 *
 * Stagehand cannot be resolved outside a bundler and the pipeline's module
 * graph reaches it; the two suites named above stand it in the same way.
 * Nothing here opens a browser or reaches the network.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stagehand-session", () => ({
  NAVIGATION_TIMEOUT_MS: 30_000,
  browserConcurrencyLimit: () => 2,
  openBrowserSession: async () => {
    throw new Error("no browser in this test");
  },
  closeBrowserSession: async () => undefined,
  typeInto: async () => ({ selector: "", description: "" }),
  tryResolveAction: async () => null,
  clickControl: async () => null,
  describeControl: async () => ({ found: false }),
  observeOnce: async () => [],
  uploadFile: async () => undefined,
}));

vi.mock("@/lib/supabase-project-guard", () => ({ assertSupabaseProject: () => undefined }));

// Dev mode, so constructing the client needs no real signing key. See
// `inngest/load-env.ts` for why this has to be set before the imports below.
process.env.INNGEST_DEV = "1";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const { applyToJob, discoverListings } = await import("@/inngest/job-application-pipeline");
const { scheduleJobSearches } = await import("@/inngest/job-search-schedule");
const { jobSearchEvent } = await import("@/lib/job-search-trigger");

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/**
 * The single concurrency option a function declared, narrowed to read `key`.
 *
 * `concurrency` is typed as a union — a bare number, one option object, or a
 * tuple of up to two — so `.key` does not type check even where the source
 * plainly declares an object. Asserted rather than cast: a declaration that
 * became a number or a tuple should fail these tests loudly instead of reading
 * `undefined` off it and passing.
 */
function soleConcurrency(declared: unknown): { limit: number; key?: string } {
  expect(declared).toBeTypeOf("object");
  expect(Array.isArray(declared)).toBe(false);
  return declared as { limit: number; key?: string };
}

/** Reads a dotted CEL-style path the way Inngest's evaluator would. */
function resolvePath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, root);
}

describe("discover-listings", () => {
  it("runs at most one discovery at a time per user", () => {
    // The race this closes: two `job-search/requested` events for one person —
    // a double clicked "Find Jobs Now", a retry overtaking the original — both
    // reach the already-applied anti join before either has written an
    // `applications` row, so both match the same listings and both fan out.
    // `(user_id, job_id)` has no unique index, so `claimApplicationRow` inserts
    // rather than reuses, and the employer receives two real applications for
    // one listing.
    expect(discoverListings.opts.concurrency).toEqual({ limit: 1, key: "event.data.userId" });
  });

  it("keys the limit on the user rather than serializing everybody", () => {
    // Stated separately because dropping the key is the plausible edit, and it
    // is not a small one: `{ limit: 1 }` alone is one discovery run at a time
    // across the entire product, which is a queue rather than a guard.
    expect(soleConcurrency(discoverListings.opts.concurrency).key).toBe("event.data.userId");
  });

  it("keys on a field the event it is triggered by actually carries", () => {
    const event = jobSearchEvent(USER_ID);
    const key = soleConcurrency(discoverListings.opts.concurrency).key ?? "";

    expect(key.startsWith("event.")).toBe(true);
    expect(resolvePath({ event }, key)).toBe(USER_ID);
  });
});

describe("the guards this one has to coexist with", () => {
  it("leaves apply-to-job's own browser limit alone", () => {
    // A different constraint on a different function: how many browsers may be
    // resident at once, not how many discoveries one person may run. Pinned
    // here so that a change to either is a deliberate one. The mock above makes
    // `browserConcurrencyLimit()` 2 for this run; the real value is read from
    // the environment, which is the point of it being a call and not a literal.
    expect(applyToJob.opts.concurrency).toEqual({ limit: 2 });
  });

  it("leaves the cron's single-run limit alone", () => {
    // Unkeyed on purpose: two overlapping cron runs would read the same set of
    // people. That is a whole-function limit and it does not conflict with the
    // per-user one above — the cron decides who is dispatched, one layer up.
    expect(scheduleJobSearches.opts.concurrency).toEqual({ limit: 1 });
  });
});
