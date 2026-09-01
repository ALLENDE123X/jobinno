// @vitest-environment node
/**
 * JOB-004. `app/api/inngest/route.ts` really registers the functions.
 *
 * ── Why this is worth a test at all ─────────────────────────────────────────
 * An Inngest function is not code that runs on a timer inside this process. It
 * is an HTTP endpoint that Inngest calls, and a cron is stored on Inngest's
 * side from what the serve route's own sync reply says. So a function that is
 * not in the route's list has no schedule and receives no events, and nothing
 * else in the repository would fail if it were missing: `inngest/board-sync.ts`
 * type checked, linted and did nothing at all for the whole of JOB-003, which
 * is exactly the failure this asserts against.
 *
 * ── The two things checked, and why neither alone is enough ─────────────────
 * The registration list is captured by wrapping `serve` rather than replacing
 * it, so the real handler is still built and the list is still observable. That
 * says which functions were passed but nothing about whether the handler works.
 * The introspection request says the handler works and reports how many
 * functions it holds, but not which. Together they pin both.
 */
import { describe, expect, it, vi } from "vitest";

/** Filled in by the `serve` wrapper below, at import time. */
const captured = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("inngest/next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("inngest/next")>();
  return {
    ...actual,
    serve: (options: Parameters<typeof actual.serve>[0]) => {
      // `ServeHandlerOptions["functions"]` is a structural `Like<>` union that
      // does not surface `id()`, which is a real method on every function the
      // route passes. Narrowed here rather than upstream: widening the route's
      // own types to satisfy a test would be the test changing the code.
      captured.ids = (options.functions as unknown as { id: () => string }[]).map((fn) =>
        fn.id()
      );
      // Delegated, not replaced. A mock that returned a stub handler would make
      // every assertion below about the mock rather than about the route.
      return actual.serve(options);
    },
  };
});

// The pipeline reaches Stagehand through `submit-application.ts`, and the real
// package cannot be resolved outside a bundler. Nothing here opens a browser,
// so the module is stood in for wholesale; `browserConcurrencyLimit` is the one
// thing the route's module graph actually reads from it, at the moment
// `createFunction` builds `apply-to-job`'s configuration.
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

// Dev mode, because talking to Inngest Cloud would need a real signing key and
// would put the network in the middle of a unit test. `load-env.ts` documents
// this as the committed default for this repository's local stage.
process.env.INNGEST_DEV = "1";
// Assigned rather than defaulted. CI sets both from repository secrets and an
// unset secret arrives as an empty string, which the SDK reads as absent — so a
// `??=` here would leave the two assertions below testing CI's configuration
// instead of the route's.
process.env.INNGEST_SIGNING_KEY = `signkey-test-${"a".repeat(64)}`;
process.env.INNGEST_EVENT_KEY = "test-event-key";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const route = await import("@/app/api/inngest/route");

/**
 * The introspection request: unsigned, read only, and what Inngest's dev server
 * and dashboard use to check an endpoint is alive. `NextRequest` is a `Request`
 * subclass and the handler only touches the parts a plain `Request` has.
 */
const introspect = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await route.GET(
    new Request("http://localhost:3000/api/inngest", { method: "GET" }) as never,
    undefined
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("the Inngest serve route", () => {
  it("exports the three verbs the App Router integration needs", () => {
    // Not decoration. PUT is the sync that registers the functions, POST is
    // execution, GET is introspection. A route missing PUT type checks, serves
    // GET happily, and can never be synced — which means its crons never exist.
    expect(typeof route.GET).toBe("function");
    expect(typeof route.POST).toBe("function");
    expect(typeof route.PUT).toBe("function");
  });

  it("runs on Node rather than the Edge runtime", () => {
    // Stagehand and the Postgres driver do not exist on the Edge runtime, so
    // this is a correctness constraint and not a preference.
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });

  it("registers both crons and both pipeline functions", () => {
    // `sync-job-boards` is the one that matters most: it is JOB-003's cron, and
    // before this route existed it was registered nowhere at all.
    //
    // `schedule-job-searches` is JOB-008's, and it has the same property one
    // layer up: `discover-listings` was registered from the day this route
    // existed and no event ever reached it, because nothing sent one. A cron
    // missing from this list has no schedule, so this assertion is the whole of
    // what makes the daily search real.
    // `reengagement-cron` is JOB-311's, same property again: it has a cron
    // expression whether or not it is on this list, and only being on this
    // list gives it an actual schedule.
    // `parse-candidate-documents` is JOB-112's, and it has the same property as
    // the ones above: `intake/completed` is sent by onboarding and reaches
    // nothing at all unless this route registers the function that consumes it,
    // which presents as onboarding succeeding and `resumes.parsed` staying NULL
    // forever. Exactly the state that ticket exists to fix.
    expect(captured.ids).toEqual([
      "sync-job-boards",
      "schedule-job-searches",
      "reengagement-cron",
      "parse-candidate-documents",
      "discover-listings",
      "apply-to-job",
    ]);
  });

  it("answers Inngest's introspection request", async () => {
    const { status, body } = await introspect();

    expect(status).toBe(200);
    expect(body.function_count).toBe(6);
    expect(body.mode).toBe("dev");
    // Present, whatever its value: the handler reports the schema it speaks and
    // a reply without one is not an Inngest introspection response.
    expect(typeof body.schema_version).toBe("string");
  });

  it("picks both keys up from the environment rather than from a literal", async () => {
    // The route passes neither key to `serve()`. These two flags are the SDK
    // saying it found them itself, which is the whole of the wiring: without a
    // signing key every execution POST is refused, and without an event key the
    // fan-out in `discoverListings` cannot send.
    const { body } = await introspect();
    expect(body.has_signing_key).toBe(true);
    expect(body.has_event_key).toBe(true);
  });
});
