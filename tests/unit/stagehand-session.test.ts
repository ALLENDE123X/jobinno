// @vitest-environment node
/**
 * JOB-005. Which browser provider a run uses is decided by two env vars, and
 * getting that decision wrong is expensive in both directions: a local Chromium
 * where a remote session was meant fails on a host that has no Chrome, and a
 * remote session where a local one was meant bills a real account during a
 * developer's test run.
 *
 * Every case below is pure string and number work against an injected env, so
 * the suite never launches a browser, never reads `process.env`, and never
 * touches Browserbase. That is also why `chooseBrowserProvider` takes its
 * environment as an argument rather than reaching for the global one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSERBASE_API_KEY_ENV_VAR,
  BROWSERBASE_CONCURRENCY_ENV_VAR,
  BROWSERBASE_DEFAULT_CONCURRENCY,
  BROWSERBASE_PROJECT_ID_ENV_VAR,
  LOCAL_BROWSER_CONCURRENCY,
  browserConcurrencyLimit,
  chooseBrowserProvider,
  openBrowserSession,
  type EnvSource,
} from "@/lib/stagehand-session";

const BOTH_SET: EnvSource = {
  [BROWSERBASE_API_KEY_ENV_VAR]: "bb_live_test_key",
  [BROWSERBASE_PROJECT_ID_ENV_VAR]: "00000000-0000-4000-8000-000000000000",
};

describe("chooseBrowserProvider", () => {
  it("picks Browserbase when both credentials are set, and carries them", () => {
    expect(chooseBrowserProvider(BOTH_SET)).toEqual({
      provider: "browserbase",
      apiKey: "bb_live_test_key",
      projectId: "00000000-0000-4000-8000-000000000000",
    });
  });

  it("falls back to the local browser when neither is set", () => {
    expect(chooseBrowserProvider({})).toEqual({ provider: "local" });
  });

  it("treats a blank value as unset rather than as a credential", () => {
    expect(
      chooseBrowserProvider({
        [BROWSERBASE_API_KEY_ENV_VAR]: "   ",
        [BROWSERBASE_PROJECT_ID_ENV_VAR]: "",
      })
    ).toEqual({ provider: "local" });
  });

  it("trims a value that a copied .env.local left padded", () => {
    const choice = chooseBrowserProvider({
      [BROWSERBASE_API_KEY_ENV_VAR]: "  bb_live_test_key  ",
      [BROWSERBASE_PROJECT_ID_ENV_VAR]: " project-id ",
    });
    expect(choice).toEqual({
      provider: "browserbase",
      apiKey: "bb_live_test_key",
      projectId: "project-id",
    });
  });

  it("refuses to guess when only the API key is set", () => {
    expect(
      chooseBrowserProvider({ [BROWSERBASE_API_KEY_ENV_VAR]: "bb_live_test_key" })
    ).toEqual({
      provider: "incomplete",
      missing: BROWSERBASE_PROJECT_ID_ENV_VAR,
      present: BROWSERBASE_API_KEY_ENV_VAR,
    });
  });

  it("refuses to guess when only the project id is set", () => {
    expect(
      chooseBrowserProvider({ [BROWSERBASE_PROJECT_ID_ENV_VAR]: "project-id" })
    ).toEqual({
      provider: "incomplete",
      missing: BROWSERBASE_API_KEY_ENV_VAR,
      present: BROWSERBASE_PROJECT_ID_ENV_VAR,
    });
  });
});

describe("browserConcurrencyLimit", () => {
  it("uses the local limit when there is no Browserbase configured", () => {
    expect(browserConcurrencyLimit({})).toBe(LOCAL_BROWSER_CONCURRENCY);
  });

  it("uses the Browserbase plan cap when there is", () => {
    expect(browserConcurrencyLimit(BOTH_SET)).toBe(BROWSERBASE_DEFAULT_CONCURRENCY);
  });

  it("is higher on Browserbase than locally, which is the whole point", () => {
    expect(browserConcurrencyLimit(BOTH_SET)).toBeGreaterThan(browserConcurrencyLimit({}));
  });

  it("lets BROWSERBASE_CONCURRENCY override the default", () => {
    expect(
      browserConcurrencyLimit({ ...BOTH_SET, [BROWSERBASE_CONCURRENCY_ENV_VAR]: "8" })
    ).toBe(8);
  });

  it("ignores BROWSERBASE_CONCURRENCY on the local path", () => {
    expect(
      browserConcurrencyLimit({ [BROWSERBASE_CONCURRENCY_ENV_VAR]: "8" })
    ).toBe(LOCAL_BROWSER_CONCURRENCY);
  });

  it("falls back to the default on a value that is not a positive whole number", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const bad of ["0", "-1", "2.5", "lots"]) {
      expect(
        browserConcurrencyLimit({ ...BOTH_SET, [BROWSERBASE_CONCURRENCY_ENV_VAR]: bad })
      ).toBe(BROWSERBASE_DEFAULT_CONCURRENCY);
    }
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it("never throws on a half configured environment, because it runs at import", () => {
    expect(() =>
      browserConcurrencyLimit({ [BROWSERBASE_API_KEY_ENV_VAR]: "bb_live_test_key" })
    ).not.toThrow();
    expect(
      browserConcurrencyLimit({ [BROWSERBASE_API_KEY_ENV_VAR]: "bb_live_test_key" })
    ).toBe(LOCAL_BROWSER_CONCURRENCY);
  });
});

/**
 * The wiring, as opposed to the decision. This is the one place the real
 * `process.env` is touched, and it is safe to do so because the refusal happens
 * before the launch queue and before any launch call: no browser starts, local
 * or remote, whatever the machine running the suite has configured.
 */
describe("openBrowserSession", () => {
  const NAMES = [
    "STAGEHAND_LLM_API_KEY",
    BROWSERBASE_API_KEY_ENV_VAR,
    BROWSERBASE_PROJECT_ID_ENV_VAR,
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of NAMES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of NAMES) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("names the missing variable rather than falling back to a local browser", async () => {
    process.env.STAGEHAND_LLM_API_KEY = "test-llm-key";
    process.env[BROWSERBASE_API_KEY_ENV_VAR] = "bb_live_test_key";

    await expect(
      openBrowserSession({ headless: true, logTag: "[job-005-test]" })
    ).rejects.toThrow(
      new RegExp(`${BROWSERBASE_PROJECT_ID_ENV_VAR} is not`)
    );
  });

  it("still requires the LLM key before it looks at a browser at all", async () => {
    await expect(
      openBrowserSession({ headless: true, logTag: "[job-005-test]" })
    ).rejects.toThrow(/STAGEHAND_LLM_API_KEY/);
  });
});
