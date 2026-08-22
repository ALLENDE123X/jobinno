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

vi.mock("@browserbasehq/stagehand", () => {
  const makeContext = () => ({
    setDomainPolicy: async () => undefined,
    activePage: async () => ({ url: () => "about:blank" }),
    newPage: async () => ({ url: () => "about:blank" }),
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
  BROWSERBASE_STEALTH_OS,
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
  it("asks for Browserbase's managed proxy and a consistent desktop fingerprint", async () => {
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
        os: BROWSERBASE_STEALTH_OS,
      },
    });
  });

  it("does not attempt advancedStealth or verified, which the issue left unconfirmed for this plan", async () => {
    const session = await openBrowserSession({ headless: true, logTag: "[job-046-test]" });
    await closeBrowserSession(session);

    const call = launchCalls.args[0] as { browserSettings?: Record<string, unknown> };
    expect(call.browserSettings).not.toHaveProperty("advancedStealth");
    expect(call.browserSettings).not.toHaveProperty("verified");
  });
});
