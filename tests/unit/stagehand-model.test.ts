// @vitest-environment node
/**
 * JOB-175. The default model driving Stagehand's act, extract, and observe
 * calls is Fireworks hosted DeepSeek V4 Flash, replacing the previous
 * openai/gpt-5.6-luna default. The switch itself is the deliverable; live
 * end to end validation against a real form fill is scheduled with the
 * JOB-207, JOB-211, JOB-212 targets.
 *
 * These tests anchor three things a silent regression would hide: the live
 * verified Fireworks slug the adapter and the session module both agree on,
 * the env var override that lets a rollback or an A/B swap happen through a
 * Vercel dashboard edit rather than a code deploy, AND the review fix that
 * the resolved id actually reaches `Stagehand.create` and the Fireworks
 * client factory. The first cut of PR #225 shipped a resolver whose
 * override was thrown away one call deeper (see review comment); the
 * integration block below fails on that first cut and passes on the fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stagehandCreateMock = vi.hoisted(() => vi.fn());
const browserbaseLaunchMock = vi.hoisted(() => vi.fn());
const localBrowserLaunchMock = vi.hoisted(() => vi.fn());
const createFireworksClientLLMMock = vi.hoisted(() => vi.fn());

vi.mock("@browserbasehq/stagehand", () => {
  const makeContext = () => ({
    setDomainPolicy: async () => undefined,
    activePage: async () => ({ url: () => "about:blank" }),
    newPage: async () => ({ url: () => "about:blank" }),
    on: () => undefined,
  });

  browserbaseLaunchMock.mockImplementation(async () => ({
    provider: "browserbase" as const,
    sessionId: "session-integration",
    context: makeContext(),
    close: async () => undefined,
  }));
  localBrowserLaunchMock.mockImplementation(async () => ({
    provider: "local" as const,
    context: makeContext(),
    close: async () => undefined,
  }));

  stagehandCreateMock.mockImplementation(async ({ browser }: { browser: unknown }) => ({
    browser,
    close: async () => undefined,
  }));

  return {
    browserbase: { launch: browserbaseLaunchMock },
    localBrowser: { launch: localBrowserLaunchMock },
    Stagehand: { create: stagehandCreateMock },
  };
});

vi.mock("@/lib/fireworks-client-llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fireworks-client-llm")>();
  return {
    ...actual,
    createFireworksClientLLM: createFireworksClientLLMMock,
  };
});

import { FIREWORKS_DEEPSEEK_MODEL } from "@/lib/fireworks-client-llm";
import {
  STAGEHAND_MODEL,
  STAGEHAND_OPENAI_FALLBACK_MODEL,
  closeBrowserSession,
  openBrowserSession,
  resolveStagehandModel,
} from "@/lib/stagehand-session";

describe("STAGEHAND_MODEL", () => {
  it("names the Fireworks DeepSeek V4 Flash slug the adapter was live verified against", () => {
    // The literal string is repeated on purpose so a silent rename in the
    // adapter shows up here as a failing assertion rather than as a passing
    // identity check that hides the drift.
    expect(FIREWORKS_DEEPSEEK_MODEL).toBe(
      "accounts/fireworks/models/deepseek-v4-flash-0731"
    );
    expect(STAGEHAND_MODEL).toBe(FIREWORKS_DEEPSEEK_MODEL);
  });

  it("routes through the Fireworks ClientLLM adapter, not Stagehand's built in provider path", () => {
    // Every accounts/fireworks/ slug is picked up by the prefix check in
    // openBrowserSession; a slug that ever loses the prefix would silently
    // fall through to the OpenAI fallback path instead.
    expect(STAGEHAND_MODEL.startsWith("accounts/fireworks/")).toBe(true);
  });
});

describe("resolveStagehandModel", () => {
  it("defaults to the Fireworks DeepSeek slug when STAGEHAND_MODEL is unset", () => {
    expect(resolveStagehandModel({})).toBe(FIREWORKS_DEEPSEEK_MODEL);
  });

  it("reads STAGEHAND_MODEL from the env when it is set", () => {
    // The override lets a Vercel dashboard edit swap builds without a code
    // deploy. A different Fireworks build stays inside the Fireworks path
    // because the routing checks the accounts/fireworks/ prefix.
    expect(
      resolveStagehandModel({
        STAGEHAND_MODEL: "accounts/fireworks/models/deepseek-v4-flash-0813",
      })
    ).toBe("accounts/fireworks/models/deepseek-v4-flash-0813");
  });

  it("treats a blank or whitespace only value as unset rather than as an override", () => {
    // A copied .env.local sometimes carries a padded value or an empty one;
    // the resolver should fall back to the default rather than pass an
    // empty string into Stagehand's own schema validator.
    expect(resolveStagehandModel({ STAGEHAND_MODEL: "" })).toBe(
      FIREWORKS_DEEPSEEK_MODEL
    );
    expect(resolveStagehandModel({ STAGEHAND_MODEL: "   " })).toBe(
      FIREWORKS_DEEPSEEK_MODEL
    );
  });

  it("trims a value that a copied .env.local left padded", () => {
    expect(
      resolveStagehandModel({
        STAGEHAND_MODEL: "  accounts/fireworks/models/deepseek-v4-flash-0731  ",
      })
    ).toBe(FIREWORKS_DEEPSEEK_MODEL);
  });
});

/**
 * JOB-175 review fix (PR #225). The four cases below fail on the first cut
 * of this PR, whose `createFireworksClientLLM` had no model parameter and
 * whose `Stagehand.create` call passed a hardcoded fallback constant on
 * the OpenAI path. They pass once the resolved model id actually flows
 * through into both factories.
 */
describe("openBrowserSession model routing", () => {
  const ENV_NAMES = [
    "STAGEHAND_LLM_API_KEY",
    "FIREWORKS_API_KEY",
    "STAGEHAND_MODEL",
    "STAGEHAND_LLM_PROVIDER",
    "BROWSERBASE_API_KEY",
    "BROWSERBASE_PROJECT_ID",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of ENV_NAMES) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    // Local browser path (no Browserbase configured), avoids any provider
    // credentials mattering.
    process.env.STAGEHAND_LLM_API_KEY = "test-openai-key";
    process.env.FIREWORKS_API_KEY = "test-fireworks-key";

    stagehandCreateMock.mockClear();
    browserbaseLaunchMock.mockClear();
    localBrowserLaunchMock.mockClear();
    createFireworksClientLLMMock.mockClear();
    createFireworksClientLLMMock.mockReturnValue({ generate: async () => ({}) });
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const value = savedEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("passes the Fireworks default slug into createFireworksClientLLM when STAGEHAND_MODEL is unset", async () => {
    const session = await openBrowserSession({ headless: true, logTag: "[job-175-integration-default]" });
    await closeBrowserSession(session);

    expect(createFireworksClientLLMMock).toHaveBeenCalledTimes(1);
    expect(createFireworksClientLLMMock).toHaveBeenCalledWith(
      "test-fireworks-key",
      FIREWORKS_DEEPSEEK_MODEL
    );
    expect(stagehandCreateMock).toHaveBeenCalledTimes(1);
    // The Stagehand.create model on the Fireworks path is the ClientLLM the
    // factory returned; the assertion above is what proves the slug actually
    // reached Fireworks.
    const createArg = stagehandCreateMock.mock.calls[0][0] as { model: unknown };
    expect(createArg.model).toBe(createFireworksClientLLMMock.mock.results[0].value);
  });

  it("passes an override Fireworks slug from STAGEHAND_MODEL into createFireworksClientLLM (the review fix)", async () => {
    // On the first cut of this PR this test failed: the resolver returned
    // the override, but createFireworksClientLLM ignored it and used the
    // hardcoded FIREWORKS_DEEPSEEK_MODEL. A silent no op is exactly what a
    // rollback lever cannot be.
    const OVERRIDE = "accounts/fireworks/models/deepseek-v4-flash-0813";
    process.env.STAGEHAND_MODEL = OVERRIDE;

    const session = await openBrowserSession({ headless: true, logTag: "[job-175-integration-override]" });
    await closeBrowserSession(session);

    expect(createFireworksClientLLMMock).toHaveBeenCalledWith("test-fireworks-key", OVERRIDE);
    expect(createFireworksClientLLMMock).not.toHaveBeenCalledWith(
      "test-fireworks-key",
      FIREWORKS_DEEPSEEK_MODEL
    );
  });

  it("routes STAGEHAND_LLM_PROVIDER=openai through the OpenAI fallback slug regardless of STAGEHAND_MODEL", async () => {
    // The documented rollback lever: opting out to OpenAI ignores whatever
    // STAGEHAND_MODEL was set to and uses the literal typed
    // STAGEHAND_OPENAI_FALLBACK_MODEL so ModelConfigSchema accepts it.
    process.env.STAGEHAND_MODEL = "accounts/fireworks/models/deepseek-v4-flash-0813";
    process.env.STAGEHAND_LLM_PROVIDER = "openai";

    const session = await openBrowserSession({ headless: true, logTag: "[job-175-integration-rollback]" });
    await closeBrowserSession(session);

    expect(createFireworksClientLLMMock).not.toHaveBeenCalled();
    const createArg = stagehandCreateMock.mock.calls[0][0] as {
      model: { modelName: string; apiKey: string };
    };
    expect(createArg.model.modelName).toBe(STAGEHAND_OPENAI_FALLBACK_MODEL);
    expect(createArg.model.apiKey).toBe("test-openai-key");
  });

  it("passes a non Fireworks STAGEHAND_MODEL slug straight through to Stagehand.create as modelName", async () => {
    // When an operator points STAGEHAND_MODEL at an OpenAI slug without
    // touching STAGEHAND_LLM_PROVIDER, the routing recognizes it as
    // non Fireworks and passes it to Stagehand's own provider path. That
    // slug reaches ModelConfigSchema, which either accepts it or rejects
    // it at Stagehand.create() time; both outcomes are correct, and the
    // silent no op the first cut of this PR had is not.
    process.env.STAGEHAND_MODEL = "openai/gpt-5.6-luna";

    const session = await openBrowserSession({ headless: true, logTag: "[job-175-integration-openai-passthrough]" });
    await closeBrowserSession(session);

    expect(createFireworksClientLLMMock).not.toHaveBeenCalled();
    const createArg = stagehandCreateMock.mock.calls[0][0] as {
      model: { modelName: string };
    };
    expect(createArg.model.modelName).toBe("openai/gpt-5.6-luna");
  });
});
