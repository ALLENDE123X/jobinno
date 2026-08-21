// @vitest-environment node
/**
 * JOB-025. The limiter that decides how many browser sessions this process may
 * hold against the provider's cap at once.
 *
 * There is a real run behind every assertion here. A fan-out of 17 applications
 * lost 9 of them to `"Failed to create a Browserbase session"`, which is the
 * bare string Stagehand throws when `sessions.create` is refused, against a
 * project whose own API reports `"concurrency": 3` and against code that
 * configures 3 in two places. The cap and the configuration agreed. What
 * disagreed was the count: the limiter took a slot before `launch()` and gave
 * it back the moment `Stagehand.create()` returned, so it bounded how many
 * sessions were *starting* and placed no bound at all on how many were alive.
 * Browserbase counts the second number.
 *
 * Nothing below launches a browser or reaches the network. The whole provider
 * is the `provider` object: a live-session counter, a peak watermark, and a way
 * to park a create call mid flight so that a test can pin down the exact moment
 * a slot changes hands. `provider.peak` is the assertion that matters, and on
 * the pre-JOB-025 limiter the first test reports 12 for it rather than 3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The provider's own view of itself, which is the only view that decides
 * whether a `sessions.create` is refused.
 */
const provider = vi.hoisted(() => ({
  /** Sessions the provider considers to exist right now. */
  live: 0,
  /** The most it ever held at once. The number this suite exists to bound. */
  peak: 0,
  /** Every `sessions.create` call, including the ones that go on to fail. */
  createCalls: 0,
  /** Resumers for creates parked by `hold`, oldest first. */
  parked: [] as Array<() => void>,
  /** While true, a create call blocks after taking its slot. */
  hold: false,
  /** How many of the next create calls are refused, as the live project did. */
  refuseNext: 0,
}));

vi.mock("@browserbasehq/stagehand", () => {
  const makeContext = () => ({
    setDomainPolicy: async () => undefined,
    activePage: async () => ({ url: () => "about:blank" }),
    newPage: async () => ({ url: () => "about:blank" }),
  });

  /**
   * Stands in for `sessions.create`.
   *
   * The counter goes up on the call rather than on the reply, because that is
   * what the provider does: a session that is still being created already holds
   * a slot, and a limiter that only counts finished ones is the bug this ticket
   * is about.
   */
  const launch = async () => {
    provider.createCalls += 1;

    if (provider.refuseNext > 0) {
      provider.refuseNext -= 1;
      // The exact message Stagehand throws. It discards the provider's own
      // response, so a refusal for want of a slot and any other failure arrive
      // here as the same string.
      throw new Error("Failed to create a Browserbase session");
    }

    provider.live += 1;
    provider.peak = Math.max(provider.peak, provider.live);

    if (provider.hold) {
      await new Promise<void>((resume) => provider.parked.push(resume));
    }

    let closed = false;
    return {
      provider: "browserbase" as const,
      sessionId: `session-${provider.createCalls}`,
      context: makeContext(),
      close: async () => {
        if (closed) return;
        closed = true;
        provider.live -= 1;
      },
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
  BROWSERBASE_CONCURRENCY_ENV_VAR,
  BROWSERBASE_DEFAULT_CONCURRENCY,
  BROWSERBASE_PROJECT_ID_ENV_VAR,
  browserSessionSlotsInUse,
  closeBrowserSession,
  openBrowserSession,
  type BrowserSession,
} from "@/lib/stagehand-session";

const CAP = BROWSERBASE_DEFAULT_CONCURRENCY;

/** Lets every pending microtask and timer callback run before asserting. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((done) => setTimeout(done, 0));
  }
}

function open(tag: string): Promise<BrowserSession> {
  return openBrowserSession({ headless: true, logTag: `[job-025-${tag}]` });
}

const ENV_NAMES = [
  "STAGEHAND_LLM_API_KEY",
  BROWSERBASE_API_KEY_ENV_VAR,
  BROWSERBASE_PROJECT_ID_ENV_VAR,
  BROWSERBASE_CONCURRENCY_ENV_VAR,
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of ENV_NAMES) savedEnv.set(name, process.env[name]);

  // Browserbase, at the plan's own cap, with no override in force. This is what
  // production runs on, and `BROWSERBASE_CONCURRENCY` is cleared rather than
  // left alone so that a developer machine that sets it cannot quietly change
  // what these tests are asserting.
  process.env.STAGEHAND_LLM_API_KEY = "test-llm-key";
  process.env[BROWSERBASE_API_KEY_ENV_VAR] = "bb_live_test_key";
  process.env[BROWSERBASE_PROJECT_ID_ENV_VAR] = "00000000-0000-4000-8000-000000000000";
  delete process.env[BROWSERBASE_CONCURRENCY_ENV_VAR];

  provider.live = 0;
  provider.peak = 0;
  provider.createCalls = 0;
  provider.parked = [];
  provider.hold = false;
  provider.refuseNext = 0;

  // The limiter narrates every wait and every hand-off, which is the right
  // thing in production and noise here.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

describe("the browser session limiter", () => {
  it("holds a fan-out of 12 to the provider's cap of 3 sessions at once", async () => {
    const attempts = 12;

    await Promise.all(
      Array.from({ length: attempts }, async (_unused, index) => {
        const session = await open(`fanout-${index}`);
        // A real application spends minutes here. One timer turn is enough to
        // make the point: the session is up, it is doing nothing, and it is
        // still holding a slot on the provider. The old limiter had released
        // its slot at this line.
        await new Promise<void>((done) => setTimeout(done, 1));
        await closeBrowserSession(session);
      })
    );

    expect(provider.createCalls).toBe(attempts);
    // The assertion the ticket asks for. Pre-JOB-025 this reads 12.
    expect(provider.peak).toBe(CAP);
    expect(provider.live).toBe(0);
    expect(browserSessionSlotsInUse()).toEqual({ held: 0, waiting: 0, limit: CAP });
  });

  it("counts a session that is open and idle, not only one that is starting", async () => {
    const held = await Promise.all([open("held-0"), open("held-1"), open("held-2")]);
    expect(browserSessionSlotsInUse()).toMatchObject({ held: CAP, waiting: 0 });

    // Three sessions that have finished starting and are sitting on a form.
    // This is the exact state the old limiter waved a fourth caller through,
    // because it had given all three slots back the moment they came up.
    let fourthIsOpen = false;
    const fourth = open("fourth").then((session) => {
      fourthIsOpen = true;
      return session;
    });

    await settle();
    expect(fourthIsOpen).toBe(false);
    expect(provider.createCalls).toBe(CAP);
    expect(browserSessionSlotsInUse()).toMatchObject({ held: CAP, waiting: 1 });

    await closeBrowserSession(held[0]);
    const opened = await fourth;
    expect(provider.createCalls).toBe(CAP + 1);
    expect(provider.peak).toBe(CAP);

    await Promise.all([held[1], held[2], opened].map(closeBrowserSession));
    expect(browserSessionSlotsInUse()).toMatchObject({ held: 0, waiting: 0 });
  });

  it("does not ask the provider for a session until it holds the slot for one", async () => {
    provider.hold = true;

    const starting = [open("start-0"), open("start-1"), open("start-2"), open("start-3")];
    await settle();

    // Three creates are in flight and the fourth caller has not made its call
    // at all. A limiter that let the fourth reach `sessions.create` and relied
    // on the provider to refuse it is the failure mode in production, and the
    // count of calls is the only place that shows up.
    expect(provider.createCalls).toBe(CAP);
    expect(browserSessionSlotsInUse()).toMatchObject({ held: CAP, waiting: 1 });

    provider.hold = false;
    for (const resume of provider.parked.splice(0)) resume();

    const first = await Promise.all(starting.slice(0, CAP));
    await closeBrowserSession(first[0]);

    const fourth = await starting[CAP];
    expect(provider.peak).toBe(CAP);

    await Promise.all([...first.slice(1), fourth].map(closeBrowserSession));
    expect(browserSessionSlotsInUse()).toMatchObject({ held: 0, waiting: 0 });
  });

  it("gives a freed slot to the caller that has waited longest", async () => {
    const held = await Promise.all([open("fifo-0"), open("fifo-1"), open("fifo-2")]);

    const served: string[] = [];
    const waiter = open("waiter").then((session) => {
      served.push("waiter");
      return session;
    });
    await settle();

    const newcomer = open("newcomer").then((session) => {
      served.push("newcomer");
      return session;
    });
    await settle();
    expect(browserSessionSlotsInUse()).toMatchObject({ held: CAP, waiting: 2 });

    await closeBrowserSession(held[0]);
    await closeBrowserSession(held[1]);

    const [servedWaiter, servedNewcomer] = await Promise.all([waiter, newcomer]);
    expect(served).toEqual(["waiter", "newcomer"]);
    expect(provider.peak).toBe(CAP);

    await Promise.all([held[2], servedWaiter, servedNewcomer].map(closeBrowserSession));
    expect(browserSessionSlotsInUse()).toMatchObject({ held: 0, waiting: 0 });
  });

  it("gives the slot back when the provider refuses, so a retry can have it", async () => {
    const held = await Promise.all([open("refuse-0"), open("refuse-1"), open("refuse-2")]);

    // `applyToJob` runs with `retries: 2` and a refused session is not one of
    // the terminal errors, so every refusal comes back through here as another
    // attempt. An attempt that stranded its slot would take the cap down by one
    // for the rest of the process's life.
    provider.refuseNext = 1;
    const refused = open("refused");
    await settle();
    expect(browserSessionSlotsInUse()).toMatchObject({ held: CAP, waiting: 1 });

    await closeBrowserSession(held[0]);
    await expect(refused).rejects.toThrow(/Failed to create a Browserbase session/);

    expect(browserSessionSlotsInUse()).toMatchObject({ held: CAP - 1, waiting: 0 });

    const retried = await open("retried");
    expect(provider.peak).toBe(CAP);

    await Promise.all([held[1], held[2], retried].map(closeBrowserSession));
    expect(browserSessionSlotsInUse()).toMatchObject({ held: 0, waiting: 0 });
  });
});
