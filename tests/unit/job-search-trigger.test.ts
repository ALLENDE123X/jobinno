// @vitest-environment node
/**
 * JOB-008. `requestJobSearch` really sends a well formed `job-search/requested`
 * event.
 *
 * ── Why this is worth a test ────────────────────────────────────────────────
 * The same reason `tests/unit/inngest-serve-route.test.ts` exists. Nothing else
 * in the repository fails if this is wrong: an event with a misspelled name, or
 * with the user id under the wrong key, is accepted by Inngest, charged for,
 * and matches no trigger. It presents as a "Find Jobs Now" button that does
 * nothing at all, with no error anywhere. JOB-009 is about to build that button
 * against this function, so the shape is a contract now rather than a detail.
 *
 * ── Why the client is spied on rather than replaced ─────────────────────────
 * `vi.mock`ing `@/inngest/job-application-pipeline` wholesale would stub out
 * `JOB_SEARCH_REQUESTED` too, and the assertion that the event name matches the
 * function's trigger would then be an assertion about the mock. So the real
 * module is imported and only `send` is intercepted, which means the name
 * asserted below is the same constant `discoverListings` is registered with.
 *
 * Importing it for real pulls in the pipeline's module graph, and Stagehand
 * cannot be resolved outside a bundler — the serve route's suite hits the same
 * wall and stands the module in the same way. Nothing here opens a browser.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
// `inngest/load-env.ts` for why this has to be set before the import below.
process.env.INNGEST_DEV = "1";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const { JOB_SEARCH_REQUESTED, inngest, jobSearchRequested } = await import(
  "@/inngest/job-application-pipeline"
);
const { jobSearchEvent, requestJobSearch } = await import("@/lib/job-search-trigger");

/** Intercepts the outbound send. Nothing in this file reaches Inngest. */
const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const sentEvent = () => {
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0][0] as { name: string; data: Record<string, unknown> };
};

describe("requesting a job search", () => {
  beforeEach(() => {
    send.mockClear();
  });

  it("sends one event carrying the user id under the key the handler reads", async () => {
    await requestJobSearch(USER_ID);

    const event = sentEvent();
    expect(event.name).toBe(JOB_SEARCH_REQUESTED);
    expect(event.data).toEqual({ userId: USER_ID });
  });

  it("names the event the discovery function is actually triggered by", () => {
    // The whole failure mode this file guards: an event nothing is listening
    // for is accepted, billed, and silently ignored.
    //
    // `jobSearchRequested` is the `eventType` handed to `discoverListings`'s
    // `triggers`, and `JOB_SEARCH_REQUESTED` is the string `jobSearchEvent`
    // stamps on the payload. Nothing in the type system ties the two together —
    // the trigger takes an event type and `send` takes a name — so a rename of
    // one and not the other compiles cleanly and produces a button that does
    // nothing. This is the assertion that they are still one value.
    expect(jobSearchRequested.name).toBe(JOB_SEARCH_REQUESTED);
    expect(jobSearchEvent(USER_ID).name).toBe(jobSearchRequested.name);
  });

  it("passes preferences through when they narrow something", async () => {
    await requestJobSearch(USER_ID, {
      companies: ["  Stripe ", "ramp"],
      title: " intern ",
      locations: ["New York"],
    });

    expect(sentEvent().data).toEqual({
      userId: USER_ID,
      // Trimmed, and no `payMin` or `maxPerCompany`: neither exists on the
      // event any more, because neither can be matched against `jobs`.
      preferences: { companies: ["Stripe", "ramp"], locations: ["New York"], title: "intern" },
    });
  });

  it("omits preferences entirely when they would narrow nothing", async () => {
    // A present `companies: []` reads as an allowlist of no boards. An absent
    // one reads as every board, which is what an empty form means.
    await requestJobSearch(USER_ID, { companies: [], title: "   ", locations: [] });

    expect(sentEvent().data).toEqual({ userId: USER_ID });
  });

  it("refuses an id that is not a profiles.id, without sending anything", async () => {
    // Checked in the caller's own request rather than as a run somebody has to
    // go and find in a dashboard.
    await expect(requestJobSearch("not-a-uuid")).rejects.toThrow(/profiles\.id UUID/);
    expect(send).not.toHaveBeenCalled();
  });

  it("builds the same event without sending it, for the cron to hand to step.sendEvent", () => {
    // The scheduled function cannot use `requestJobSearch`: sending through the
    // client from inside a durable run re-sends on every retry of that step.
    expect(jobSearchEvent(USER_ID)).toEqual({
      name: JOB_SEARCH_REQUESTED,
      data: { userId: USER_ID },
    });
    expect(send).not.toHaveBeenCalled();
  });
});
