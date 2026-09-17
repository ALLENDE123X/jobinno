#!/usr/bin/env node
/**
 * JOB-365. Screenshots the 15 mock pages under
 * `app/internal/visuals/[slug]/page.tsx` at exactly 1920x1080, for the
 * `/scripts-jobinno` skill's beat 4 Drive folder.
 *
 * Developer run only. `npm run capture:visuals` starts its own throwaway
 * Next.js dev server with `NEXT_PUBLIC_ALLOW_MOCK_PAGES=1`, so nobody has to
 * remember to set that env var by hand first, screenshots each of the 15
 * slugs in `lib/internal-visuals-slugs.ts` with Playwright, and tears the
 * server back down. Never wired into CI or into the app itself: see the
 * ticket's own instruction not to deploy this script anywhere.
 *
 * The viewport and the screenshot's `clip` are both pinned to 1920x1080
 * independently. The viewport alone is not enough of a guarantee, because a
 * page that renders taller than the viewport would still produce a
 * screenshot at the page's full scroll height rather than the viewport size
 * if `fullPage` were ever left on; the explicit `clip` is what makes the
 * output dimensions unconditional on how any one page renders.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { VISUAL_SLUGS } from "../lib/internal-visuals-slugs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const READY_PROBE_PATH = "/internal/visuals/dashboard-counter-climbing";
const OUTPUT_DIR = "/tmp/jobinno-visuals";
const VIEWPORT = { width: 1920, height: 1080 };
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 1_000;
// Lets the number tickers on a couple of pages (dashboard-counter-climbing,
// money-time-saved-counter) finish their spring animation before the
// screenshot, so the captured PNG shows the settled final value rather than
// a mid animation frame. `networkidle` alone does not wait for this: no
// network activity is involved in a CSS/JS spring running client side.
const ANIMATION_SETTLE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}${READY_PROBE_PATH}`);
      if (response.status === 200) return;
    } catch {
      // Server not accepting connections yet. Keep polling.
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
  throw new Error(`Dev server did not become ready within ${READY_TIMEOUT_MS}ms`);
}

function startDevServer(): ChildProcess {
  // `detached: true` puts the child in its own process group so
  // `stopDevServer` can kill it and the `next dev` process it spawns in turn,
  // rather than leaving an orphaned `next dev` running after this script
  // exits. `--` forwards `-p` to the underlying `next dev` invocation instead
  // of npm trying to parse it as one of npm's own flags.
  return spawn("npm", ["run", "dev", "--", "-p", String(PORT)], {
    cwd: REPO_ROOT,
    env: { ...process.env, NEXT_PUBLIC_ALLOW_MOCK_PAGES: "1" },
    detached: true,
    stdio: "inherit",
  });
}

function stopDevServer(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already exited. Nothing to clean up.
  }
}

async function captureAll(): Promise<void> {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    for (const slug of VISUAL_SLUGS) {
      const url = `${BASE_URL}/internal/visuals/${slug}`;
      console.log(`Capturing ${slug}...`);
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForTimeout(ANIMATION_SETTLE_MS);
      await page.screenshot({
        path: `${OUTPUT_DIR}/${slug}.png`,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
      });
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const devServer = startDevServer();
  try {
    await waitForServerReady();
    await captureAll();
  } finally {
    stopDevServer(devServer);
  }
  console.log(`Done. Screenshots written to ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
