// @vitest-environment node
/**
 * JOB-046 (issue #80). Ashby rejected 10 of 10 real applications in one run
 * with its own "flagged as possible spam" message. The investigation behind
 * issue #80 named two plain absences on the only `browserbase.launch()` call
 * site (`lib/stagehand-session.ts`) as the highest-confidence, lowest-effort
 * fix: no proxy configured at all, and no `browserSettings` at all, so every
 * session ran on whatever Browserbase's bare default happens to be —
 * identically, every time.
 *
 * This suite is the only thing that pins the actual shape of that call. It
 * never launches a browser or reaches the network — the whole provider is a
 * `launch` mock that records what it was called with, the same pattern
 * `browser-session-concurrency.test.ts` (JOB-025) uses for the same reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launchCalls = vi.hoisted(() => ({ args: [] as unknown[] }));
/** Every listener a test registered via the mock page's `on("console", …)`. */
const consoleListeners = vi.hoisted(() => ({
  handlers: [] as Array<(event: unknown) => unknown>,
}));
/**
 * Whether the mock page exposes `on()` at all. False for exactly one test
 * below, standing in for a page that does not implement it — every mocked
 * page elsewhere in this repo's suite, until now, and any future
 * non-Browserbase provider.
 */
const pageCapabilities = vi.hoisted(() => ({ supportsOn: true }));

vi.mock("@browserbasehq/stagehand", () => {
  const makePage = () => ({
    url: () => "about:blank",
    // This SDK's real `Page.on()` returns `Promise<CDPSubscription>` — see
    // `watchForCaptchaSolvingEvidence` in `lib/stagehand-session.ts`.
    ...(pageCapabilities.supportsOn
      ? {
          on: async (_event: string, listener: (event: unknown) => unknown) => {
            consoleListeners.handlers.push(listener);
            return { unsubscribe: async () => undefined };
          },
        }
      : {}),
  });

  const makeContext = () => ({
    setDomainPolicy: async () => undefined,
    activePage: async () => makePage(),
    newPage: async () => makePage(),
  });

  const launch = async (options: unknown) => {
    launchCalls.args.push(options);
    return {
      provider: "browserbase" as const,
      sessionId: "session-job-046",
      context: makeContext(),
      close: async () => undefined,
    };
  };

  return {
    browserbase: { launch },
    localBrowser: { launch },
    Stagehand: {
      create: async ({ browser }: { browser: unknown }) => ({
        browser,
        close: async () => undefined,
      }),
    },
  };
});

import {
  BROWSERBASE_API_KEY_ENV_VAR,
  BROWSERBASE_PROJECT_ID_ENV_VAR,
  BROWSERBASE_SESSION_TIMEOUT_S,
  BROWSERBASE_VIEWPORT,
  closeBrowserSession,
  openBrowserSession,
} from "@/lib/stagehand-session";

const ENV_NAMES = [
  "STAGEHAND_LLM_API_KEY",
  BROWSERBASE_API_KEY_ENV_VAR,
  BROWSERBASE_PROJECT_ID_ENV_VAR,
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of ENV_NAMES) saved.set(name, process.env[name]);
  process.env.STAGEHAND_LLM_API_KEY = "test-llm-key";
  process.env[BROWSERBASE_API_KEY_ENV_VAR] = "bb_live_test_key";
  process.env[BROWSERBASE_PROJECT_ID_ENV_VAR] = "00000000-0000-4000-8000-000000000000";
  launchCalls.args = [];
  consoleListeners.handlers = [];
  pageCapabilities.supportsOn = true;

  // Real production narration. Right for a live run, noise here.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

describe("the Browserbase launch call (JOB-046, issue #80)", () => {
  it("asks for Browserbase's managed proxy and a consistent viewport", async () => {
    const session = await openBrowserSession({ headless: true, logTag: "[job-046-test]" });
    await closeBrowserSession(session);

    expect(launchCalls.args).toHaveLength(1);
    expect(launchCalls.args[0]).toMatchObject({
      apiKey: "bb_live_test_key",
      projectId: "00000000-0000-4000-8000-000000000000",
      api_timeout: BROWSERBASE_SESSION_TIMEOUT_S,
      proxies: true,
      browserSettings: {
        viewport: BROWSERBASE_VIEWPORT,
        blockAds: true,
      },
    });
  });

  it("turns blockAds on (issue #85)", async () => {
    const session = await openBrowserSession({ headless: true, logTag: "[issue-85-test]" });
    await closeBrowserSession(session);

    const call = launchCalls.args[0] as { browserSettings?: Record<string, unknown> };
    expect(call.browserSettings?.blockAds).toBe(true);
  });

  it("does not set os, advancedStealth, or verified — os broke every session on this plan (400: Enterprise-only), and the other two were confirmed gated to Scale", async () => {
    const session = await openBrowserSession({ headless: true, logTag: "[job-046-test]" });
    await closeBrowserSession(session);

    const call = launchCalls.args[0] as { browserSettings?: Record<string, unknown> };
    expect(call.browserSettings).not.toHaveProperty("os");
    expect(call.browserSettings).not.toHaveProperty("advancedStealth");
    expect(call.browserSettings).not.toHaveProperty("verified");
  });
});

/**
 * Issue #85. `browserSettings.solveCaptchas` is already on by default and
 * nothing here turns it on — what this suite pins down is the *evidence*
 * path: a `page.on("console", …)` listener that recognises Browserbase's own
 * `browserbase-solving-started` / `browserbase-solving-finished` markers and
 * narrates them under the caller's `logTag`, the same tag the rest of a run's
 * `[act-007]`/`[act-008]` lines use.
 *
 * The mock page's `on()` matches this SDK's real signature (see
 * `Page.on()` in `@browserbasehq/stagehand`'s type declarations): it hands
 * the listener a raw `Runtime.consoleAPICalled` CDP event, not a Playwright
 * `ConsoleMessage`, so the fixtures below are shaped that way too.
 */
describe("captcha-solving evidence (issue #85)", () => {
  const consoleEvent = (text: string) => ({
    pageId: "page-1",
    method: "Runtime.consoleAPICalled",
    params: { args: [{ type: "string", value: text }] },
    sessionId: "session-1",
    targetId: "target-1",
  });

  it("logs a tagged line when the solving-started and solving-finished markers appear", async () => {
    const session = await openBrowserSession({ headless: true, logTag: "[issue-85-test]" });

    expect(consoleListeners.handlers).toHaveLength(1);
    const handler = consoleListeners.handlers[0]!;
    handler(consoleEvent("browserbase-solving-started"));
    handler(consoleEvent("browserbase-solving-finished"));
    // Ordinary page chatter must not be mistaken for either marker.
    handler(consoleEvent("hello from the job application form"));

    await closeBrowserSession(session);

    const log = vi.mocked(console.log);
    expect(log).toHaveBeenCalledWith("[issue-85-test] captcha solving detected: started");
    expect(log).toHaveBeenCalledWith("[issue-85-test] captcha solving detected: finished");
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("hello from the job application form"));
  });

  it("does not fail a session that opens against a page with no on() (e.g. a future non-Browserbase provider)", async () => {
    // Every other test in this file uses the shared mock, whose `page.on()`
    // works. This one swaps in a page that doesn't have the method at all —
    // the same shape every mocked page in `browser-session-concurrency.test.ts`
    // and `stagehand-session.test.ts` has — to prove the best-effort
    // try/catch in `watchForCaptchaSolvingEvidence` is what stands between
    // that and a broken session open, the same discipline
    // `blockUnroutableDomains` already follows just above it.
    pageCapabilities.supportsOn = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const session = await openBrowserSession({ headless: true, logTag: "[issue-85-test]" });
    await closeBrowserSession(session);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[issue-85-test] could not attach a console listener for captcha-solving evidence"
      )
    );
  });
});
