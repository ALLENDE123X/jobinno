#!/usr/bin/env node
/**
 * JOB-028 (follow-up to JOB-025, issue #41). How long Browserbase actually
 * takes to free a session's concurrency slot after this process is done with
 * it — not how long `browser.close()` takes to resolve.
 *
 * `closeBrowserSession` calling `browser.close()` sends Browserbase a
 * `sessions.update(id, {status: "REQUEST_RELEASE"})` — a request, not a
 * confirmation. The in-process limiter (`lib/stagehand-session.ts`) frees its
 * slot the instant that call resolves; the provider frees the real slot only
 * once it has reaped the session, on its own schedule. This script opens a
 * real session, closes it exactly the way the pipeline does, and polls
 * `GET /v1/sessions/{id}` until the provider's own record shows the session is
 * no longer `RUNNING`, reading the lag off `updatedAt` — the provider's own
 * timestamp for the transition — rather than off polling granularity.
 *
 * Run with `npm run measure:reap-lag -- [trials]` (default 8). Opens and
 * closes `trials` real Browserbase sessions serially, one at a time; nothing
 * is navigated to and nothing is submitted anywhere.
 *
 * Measured on the live Jobinno project on 2026-08-21, 8 trials: every one read
 * back `COMPLETED` on the first poll, and the provider's own `updatedAt` for
 * that transition was before this process's local `browser.close()` call had
 * even resolved (-275ms to -442ms, mean -372ms) — see the full writeup on
 * `BROWSERBASE_DEFAULT_CONCURRENCY` in `lib/stagehand-session.ts`. No reap lag
 * to budget for, as of that measurement.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

import { closeBrowserSession, openBrowserSession } from "@/lib/stagehand-session";

const BROWSERBASE_API = "https://api.browserbase.com/v1";
const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS = 60_000;

type Sample = {
  sessionId: string;
  closeResolvedAt: number;
  freedObservedAt: number;
  providerUpdatedAt: number;
  pollCount: number;
};

async function fetchSessionStatus(
  sessionId: string,
  apiKey: string
): Promise<{ status: string; updatedAt: string }> {
  const response = await fetch(`${BROWSERBASE_API}/sessions/${sessionId}`, {
    headers: { "x-bb-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`GET /sessions/${sessionId} → HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as { status: string; updatedAt: string };
}

async function measureOne(apiKey: string, index: number): Promise<Sample> {
  console.log(`\n[trial ${index}] opening a session…`);
  const session = await openBrowserSession({ headless: true, logTag: `[reap-lag ${index}]` });
  const sessionId = session.browser.sessionId;
  if (sessionId === undefined) {
    await closeBrowserSession(session);
    throw new Error("Session opened with no Browserbase session id — cannot measure a local session.");
  }
  console.log(`[trial ${index}] session ${sessionId} open — closing immediately, no navigation`);

  await closeBrowserSession(session);
  const closeResolvedAt = Date.now();
  console.log(`[trial ${index}] closeBrowserSession resolved — polling for the provider to free it…`);

  let pollCount = 0;
  const deadline = closeResolvedAt + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    pollCount += 1;
    const { status, updatedAt } = await fetchSessionStatus(sessionId, apiKey);
    if (status !== "RUNNING") {
      const freedObservedAt = Date.now();
      const providerUpdatedAt = new Date(updatedAt).getTime();
      console.log(
        `[trial ${index}] status → ${status} after ${pollCount} poll(s), ` +
          `${freedObservedAt - closeResolvedAt}ms of wall-clock polling`
      );
      return { sessionId, closeResolvedAt, freedObservedAt, providerUpdatedAt, pollCount };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Session ${sessionId} still RUNNING ${POLL_TIMEOUT_MS}ms after close — giving up.`);
}

function stats(values: number[]): { min: number; max: number; mean: number } {
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

async function main(): Promise<void> {
  const trials = Number(process.argv[2]) || 8;
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  if (!apiKey) {
    console.error("BROWSERBASE_API_KEY is required.");
    process.exit(1);
  }

  console.log(`Measuring Browserbase reap lag over ${trials} real session(s), one at a time…`);
  const samples: Sample[] = [];
  for (let i = 1; i <= trials; i += 1) {
    samples.push(await measureOne(apiKey, i));
  }

  // The provider's own `updatedAt` is the timestamp of the actual state
  // transition; wall-clock is only an upper bound shaped by how often this
  // script happened to poll. Both are reported so the wall-clock figure can
  // sanity-check that the provider timestamp is not clock-skewed nonsense.
  const serverLagMs = samples.map((s) => s.providerUpdatedAt - s.closeResolvedAt);
  const wallClockLagMs = samples.map((s) => s.freedObservedAt - s.closeResolvedAt);

  console.log(`\n${"─".repeat(72)}`);
  console.log("sessionId                              server-lag(ms)  wall-clock(ms)  polls");
  samples.forEach((s, i) => {
    console.log(
      `${s.sessionId.padEnd(38)}  ${String(serverLagMs[i]).padStart(13)}  ${String(wallClockLagMs[i]).padStart(14)}  ${s.pollCount}`
    );
  });
  console.log(`${"─".repeat(72)}`);
  const server = stats(serverLagMs);
  const wall = stats(wallClockLagMs);
  console.log(`server-lag(ms):     min ${server.min}  max ${server.max}  mean ${server.mean}`);
  console.log(`wall-clock-lag(ms): min ${wall.min}  max ${wall.max}  mean ${wall.mean}`);
}

main().catch((err: unknown) => {
  console.error(`measure:reap-lag failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
