/**
 * Stagehand session lifecycle + the observe→act replay cache.
 *
 * Every line here was `create-board-account.ts`'s (ACT-005/ACT-012) and moved
 * out verbatim in ACT-007, because ACT-007's form-fill needs exactly the same
 * machinery and a second copy of it would be worse than a shared module. That
 * is the rule `create-board-account.ts`'s own header states for its duplicated
 * Supabase guard — "if a third consumer appears, lift both copies into a shared
 * module at that point rather than now" — applied at the point it came true.
 *
 * Two things changed in the move, both deliberate and both noted at their site:
 *
 *  · `BrowserSession` now carries a `logTag`, so a shared helper's log lines say
 *    which ticket's flow they came from instead of always saying `[act-005]`.
 *
 *  · `typeInto` now overwrites the action's `description` with the caller's own
 *    fixed instruction before acting. See the comment there — it is a security
 *    fix, not cosmetics.
 *
 * Nothing else about the behaviour is different.
 */

import {
  Stagehand,
  browserbase,
  localBrowser,
  type Page,
  type StagehandBrowser,
} from "@browserbasehq/stagehand";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Model driving `act`/`extract`/`observe`. Stagehand validates this string
 * against a closed per-provider allowlist at `Stagehand.create()`, so the
 * provider prefix is mandatory and a typo fails before any request is billed.
 */
export const STAGEHAND_MODEL = "openai/gpt-5.6-luna" as const;

/**
 * How long Stagehand waits for the DOM to stop changing before it reads the
 * page. Stagehand's own default is 5s; this is raised because the boards that
 * matter here are the slow ones — Workday's careers SPA fetches its data and
 * mounts the application well after the HTML is parsed.
 */
export const DOM_SETTLE_TIMEOUT_MS = 30_000;

/** Navigation lifecycle to wait for. */
export const NAVIGATION_TIMEOUT_MS = 60_000;

export type BrowserSession = {
  stagehand: Stagehand;
  browser: StagehandBrowser;
  page: Page;
  /** Log prefix of the flow that opened this session, e.g. `[act-007]`. */
  logTag: string;
};

export type OpenBrowserSessionOptions = {
  headless: boolean;
  logTag: string;
};

// ───────────────────────────────────
// Which browser provider this process uses (JOB-005)
// ───────────────────────────────────

/**
 * What the readers below accept. `process.env` satisfies it, and so does a
 * plain object literal, which `NodeJS.ProcessEnv` does not: Next.js augments
 * that interface with a required `NODE_ENV`, so every test fixture would have
 * to carry a `NODE_ENV` it does not care about to typecheck.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export const BROWSERBASE_API_KEY_ENV_VAR = "BROWSERBASE_API_KEY";
export const BROWSERBASE_PROJECT_ID_ENV_VAR = "BROWSERBASE_PROJECT_ID";
export const BROWSERBASE_CONCURRENCY_ENV_VAR = "BROWSERBASE_CONCURRENCY";

/**
 * Sessions this Browserbase project may run at once, when
 * `BROWSERBASE_CONCURRENCY` does not say otherwise.
 *
 * Not a guess. `GET /v1/projects/{id}` on the live Jobinno project reports
 * `"concurrency": 3`, which is the plan's own cap: ask for a fourth session and
 * Browserbase refuses it rather than queueing it. The number is therefore a
 * property of the billing plan, so it lives in an env var and this constant is
 * only the fallback for an environment that has not set one.
 */
export const BROWSERBASE_DEFAULT_CONCURRENCY = 3;

/**
 * Seconds before Browserbase ends a session on its own, passed on every launch
 * rather than left at the project default of 300.
 *
 * One application is an account check, a form fill of up to a few dozen fields
 * and a submit, and every step of that waits on both an LLM call and a slow
 * careers SPA. Five minutes is not reliably enough. A session cut off mid
 * submit lands the row on `submission_unconfirmed`, which is terminal and never
 * retried, so a ceiling set too low costs the candidate an application they
 * cannot recover, while one set too high costs nothing: Browserbase bills the
 * minutes a session actually uses, and `closeBrowserSession` closes on every
 * exit path. Twenty minutes is generous for a form that is working and still
 * bounded for one that is not.
 */
export const BROWSERBASE_SESSION_TIMEOUT_S = 20 * 60;

/**
 * Sessions the local Chromium path may run at once.
 *
 * Two, and the reason is memory rather than taste, as
 * `inngest/job-application-pipeline.ts` records at length: a 5 wide fan out on
 * an 8 GB machine put the load average at 32 on 8 cores and pushed swap to 5 GB
 * of 6 GB, at which point Chrome stops answering CDP or dies outright. That is
 * a property of one developer machine and it has nothing to say about remote
 * sessions, which is exactly why the two numbers are now separate.
 */
export const LOCAL_BROWSER_CONCURRENCY = 2;

/**
 * Which provider `openBrowserSession` will use, and why.
 *
 * `incomplete` is a third state on purpose. One credential set and the other
 * missing is a typo every time, never a choice, and silently falling back to a
 * local Chromium there is the worst of the three outcomes: it looks like it
 * worked, right up until the same code runs somewhere that has no Chrome
 * installed at all.
 */
export type BrowserProviderChoice =
  | { provider: "browserbase"; apiKey: string; projectId: string }
  | { provider: "local" }
  | { provider: "incomplete"; missing: string; present: string };

/** Trimmed value, or undefined when the variable is unset or only whitespace. */
function readEnv(env: EnvSource, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * Reads the provider choice out of the environment. Pure, and takes the env it
 * reads, so a test can exercise both branches without a browser and without
 * mutating `process.env` around whatever else is running.
 *
 * Additive by design. With neither Browserbase variable set this returns
 * `local` and the Chromium path behaves exactly as it did before JOB-005, which
 * is what keeps `npm run fill-form` working on a laptop with no Browserbase
 * account.
 */
export function chooseBrowserProvider(
  env: EnvSource = process.env
): BrowserProviderChoice {
  const apiKey = readEnv(env, BROWSERBASE_API_KEY_ENV_VAR);
  const projectId = readEnv(env, BROWSERBASE_PROJECT_ID_ENV_VAR);

  if (apiKey !== undefined && projectId !== undefined) {
    return { provider: "browserbase", apiKey, projectId };
  }
  if (apiKey === undefined && projectId === undefined) {
    return { provider: "local" };
  }
  return apiKey === undefined
    ? {
        provider: "incomplete",
        missing: BROWSERBASE_API_KEY_ENV_VAR,
        present: BROWSERBASE_PROJECT_ID_ENV_VAR,
      }
    : {
        provider: "incomplete",
        missing: BROWSERBASE_PROJECT_ID_ENV_VAR,
        present: BROWSERBASE_API_KEY_ENV_VAR,
      };
}

/**
 * How many sessions may run at once under the active provider.
 *
 * `inngest/job-application-pipeline.ts` reads this for `applyToJob`'s
 * `concurrency.limit`, so the fan out width and the launch queue below always
 * agree about which bottleneck is real: this machine's cores when the browsers
 * are local, and the Browserbase plan's session cap when they are not.
 *
 * Never throws, including on the `incomplete` case. It runs at module load in
 * the pipeline, and a tuning number is not worth failing an import over. The
 * run that would have used it fails with a readable reason in
 * `openBrowserSession` instead.
 */
export function browserConcurrencyLimit(env: EnvSource = process.env): number {
  if (chooseBrowserProvider(env).provider !== "browserbase") {
    return LOCAL_BROWSER_CONCURRENCY;
  }

  const configured = readEnv(env, BROWSERBASE_CONCURRENCY_ENV_VAR);
  if (configured === undefined) return BROWSERBASE_DEFAULT_CONCURRENCY;

  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      `${BROWSERBASE_CONCURRENCY_ENV_VAR}=${JSON.stringify(configured)} is not a positive ` +
        `whole number; falling back to ${BROWSERBASE_DEFAULT_CONCURRENCY}`
    );
    return BROWSERBASE_DEFAULT_CONCURRENCY;
  }
  return parsed;
}

/**
 * Launches a browser this run owns outright and attaches Stagehand to it.
 *
 * JOB-005 made which browser a property of the environment rather than of this
 * function: a Browserbase session when both credentials are set, and the local
 * Chromium below when neither is. Nothing else in the function changed, because
 * nothing else needed to. Stagehand hands back the same `StagehandBrowser`
 * either way, so every caller, the observe cache and the teardown path are all
 * provider blind by construction.
 *
 * Deliberately no shared instance, no keepalive, no pool: a browser nobody else
 * can reach is what makes a hijack-defence layer unnecessary, and it is also
 * what makes `applyToJob`'s `concurrency.limit` in
 * `inngest/job-application-pipeline.ts` safe: N calls are N browsers, with N
 * temp profiles locally and N isolated remote sessions on Browserbase.
 *
 * `port` and `userDataDir` are deliberately left unset on the local path.
 * Stagehand's launcher only picks a random free port and a fresh temp profile
 * when they are absent; pinning either would make concurrent runs collide on
 * the debug port or on Chrome's profile lock.
 */
/**
 * How many browsers may be *starting* at once. Not how many may be running.
 *
 * Stagehand enforces a hard-coded, non-configurable 60s ceiling on
 * `create()` — launch plus init. Chrome's cold start is the expensive part of
 * that and it is almost entirely CPU: five processes racing through startup on
 * one machine take far longer each than five started in sequence, and past a
 * point they simply do not make the ceiling.
 *
 * That is not hypothetical. A live 5-wide fan-out lost three of five runs to
 * "Stagehand initialization timed out after 60000ms" and a
 * `connect ECONNREFUSED`, on an 8-core / 8 GB machine whose 15-minute load
 * average was 23 at the time. The two that survived went on to fill forms
 * normally.
 *
 * The fix is not fewer applications. Once a browser is up it spends nearly all
 * its time idle, waiting on the network and on model calls, so five *running*
 * browsers cost little — it is five *starting* browsers that do. Queueing the
 * starts keeps `concurrency: { limit: 5 }` in
 * `inngest/job-application-pipeline.ts` meaning what it says, while never
 * putting more than this many launches in flight at once.
 *
 * ── JOB-005: the limit is now the active provider's, not a constant ──────────
 *
 * Every word above is about a Chrome process starting on this machine, so none
 * of it applies to a Browserbase session. There `launch()` is one HTTPS call
 * that creates a session on someone else's fleet, it costs this process no CPU,
 * and starts do not contend with each other at all.
 *
 * The queue is kept rather than skipped for the remote path, for one reason
 * that is worth being precise about. Browserbase caps concurrent sessions per
 * project and refuses the one over the line instead of queueing it, so a bound
 * is still wanted. Set to the plan's cap it is close to a no op underneath
 * `applyToJob`'s own `concurrency.limit`, which reads the same number. It earns
 * its place on the entry points that never touch Inngest, `npm run fill-form`
 * and `npm run submit-application`, where nothing else is counting.
 *
 * What it deliberately does not claim to be is an enforcement of that cap. It
 * gates starts, not runs, and releases as soon as a session is up, so three
 * live sessions plus a fourth start is still a refusal from Browserbase. The
 * pipeline's `concurrency.limit` is what actually holds the line.
 */
function maxConcurrentLaunches(): number {
  return browserConcurrencyLimit();
}

/** Resolves when a launch slot is free; the returned function gives it back. */
const launchQueue: Array<() => void> = [];
let launchesInFlight = 0;

async function acquireLaunchSlot(logTag: string): Promise<() => void> {
  if (launchesInFlight >= maxConcurrentLaunches()) {
    console.log(
      `${logTag} waiting for a browser-launch slot (${launchesInFlight} starting, ` +
        `${launchQueue.length} already queued) — starts are serialised so none of them ` +
        `misses Stagehand's fixed 60s init ceiling`
    );
    await new Promise<void>((resolve) => launchQueue.push(resolve));
  }
  launchesInFlight++;
  let released = false;
  return () => {
    // Idempotent: the caller releases on both the success and failure paths,
    // and double-releasing would let the queue outgrow the limit.
    if (released) return;
    released = true;
    launchesInFlight--;
    launchQueue.shift()?.();
  };
}

export async function openBrowserSession(
  options: OpenBrowserSessionOptions
): Promise<BrowserSession> {
  const apiKey = process.env.STAGEHAND_LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "STAGEHAND_LLM_API_KEY env var is required (the LLM key Stagehand drives " +
        `${STAGEHAND_MODEL} with — see .env.example). This is a dedicated key for this ` +
        `pipeline; do not point it at another project's key.`
    );
  }

  // Resolved before a slot is taken, so a half configured environment fails
  // immediately and without ever occupying the queue.
  const choice = chooseBrowserProvider();
  if (choice.provider === "incomplete") {
    throw new Error(
      `${choice.present} is set but ${choice.missing} is not. Browserbase needs both, and ` +
        `running a local Chromium instead would hide the mistake rather than report it. ` +
        `Set both to use remote browsers, or unset both to use the local browser.`
    );
  }

  // Held across launch *and* `Stagehand.create()`, because the 60s ceiling
  // covers both and init is not the cheap half.
  const releaseLaunchSlot = await acquireLaunchSlot(options.logTag);
  let browser: StagehandBrowser;
  try {
    browser =
      choice.provider === "browserbase"
        ? await browserbase.launch({
            apiKey: choice.apiKey,
            projectId: choice.projectId,
            // `options.headless` has no remote equivalent and is not silently
            // mapped to anything: a Browserbase session has no display either
            // way, and its live view is how a run gets watched.
            api_timeout: BROWSERBASE_SESSION_TIMEOUT_S,
          })
        : await localBrowser.launch({ headless: options.headless });
  } catch (err) {
    releaseLaunchSlot();
    throw err;
  }

  if (browser.provider === "browserbase") {
    // The session id is the only handle on the recording and the live view in
    // the Browserbase dashboard, and there is no way back to it from a log line
    // that does not carry it.
    console.log(
      `${options.logTag} Browserbase session ${browser.sessionId ?? "(id unavailable)"} started`
    );
  }

  try {
    const stagehand = await Stagehand.create({
      browser,
      model: { modelName: STAGEHAND_MODEL, apiKey },
      domSettleTimeoutMs: DOM_SETTLE_TIMEOUT_MS,
      // Re-find a control whose cached selector no longer resolves rather than
      // failing the run. Only ever re-finds the control the instruction already
      // named; it cannot widen what a caller is willing to click.
      selfHeal: true,
      logging: { level: "error" },
    });

    const context = stagehand.browser.context;
    const page = (await context.activePage()) ?? (await context.newPage());
    return { stagehand, browser, page, logTag: options.logTag };
  } catch (err) {
    // The browser is ours and nothing else will ever close it.
    await browser.close().catch(() => undefined);
    throw err;
  } finally {
    // The slot covers starting, not running: the next launch may begin as soon
    // as this one is up, however long the flow that owns it then runs for.
    releaseLaunchSlot();
  }
}

/**
 * Tears the session down. Order matters and is not interchangeable:
 * `stagehand.close()` releases the SDK's connection to the browser but leaves
 * the Chrome process running — only `browser.close()` kills it.
 *
 * Both halves matter more on Browserbase than they did locally, not less. A
 * remote session that is never closed keeps burning billed minutes until the
 * project timeout ends it, and it holds one of the plan's concurrency slots the
 * whole time, so the next run waits on a browser nobody is using.
 *
 * Never throws. This runs in a `finally` next to a real error often enough that
 * letting a teardown failure replace the original diagnosis would be a bad
 * trade every time.
 */
export async function closeBrowserSession(session: BrowserSession): Promise<void> {
  try {
    await session.stagehand.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${session.logTag} closing Stagehand failed (ignored): ${reason}`);
  }
  try {
    await session.browser.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const what = session.browser.provider === "browserbase" ? "Browserbase" : "local";
    console.warn(`${session.logTag} closing the ${what} browser failed (ignored): ${reason}`);
  }
}

/** Compares URLs by origin + path — query/hash churn is not a different page. */
export function samePage(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.origin === right.origin &&
      left.pathname.replace(/\/+$/, "") === right.pathname.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// ───────────────────────────────────
// observe() cache
// ───────────────────────────────────

/**
 * Cached `observe()` results, keyed by page origin+path and instruction.
 *
 * Why this exists: `observe()` is an LLM call, and an LLM call is the one step
 * in these flows that can answer differently on two identical runs. For a demo
 * take — or for any run whose failure has to be reproducible — a re-observed
 * "which box is the password field" that lands somewhere new is a real risk.
 * Replaying a stored `Action` skips inference entirely and executes the same
 * selector every time.
 *
 * Gitignored, because it is a per-machine artefact of pages this machine has
 * visited, not source. Shared by every flow in this repo: the key carries the
 * instruction, and instructions are unique per flow, so there is nothing to
 * collide.
 */
const OBSERVE_CACHE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".stagehand-observe-cache.json"
);

/**
 * A cached action never carries `arguments`.
 *
 * `Action.arguments` is where the value being typed lives, and the values these
 * flows type are a candidate's email address, a board password and their resume
 * details. None of that belongs in a file on disk, and none of it is stable
 * across runs anyway — the cache stores *where to type*, and the caller supplies
 * *what to type* at replay. Stripping the field rather than trusting callers not
 * to pass one is the only version of this that cannot leak a password by
 * omission.
 */
export type CachedAction = { selector: string; description: string; method?: string };

type ObserveCache = Record<string, CachedAction>;

function observeCacheKey(url: string, instruction: string): string {
  let scope: string;
  try {
    const parsed = new URL(url);
    scope = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    scope = url;
  }
  return `${scope} :: ${instruction}`;
}

async function loadObserveCache(): Promise<ObserveCache> {
  try {
    const raw = await readFile(OBSERVE_CACHE_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ObserveCache;
  } catch {
    // No cache yet, or an unreadable one. Either way the answer is the same:
    // observe from scratch. A cache that cannot be read is not an error.
    return {};
  }
}

/**
 * Writes via a temp file + rename so a reader (or a concurrent run) never sees
 * a half-written file. Concurrent writers still last-write-wins, which costs at
 * most a re-observe on some later run — the cache is an optimisation, and
 * treating a lost update as a failure would make it one.
 */
async function saveObserveCache(cache: ObserveCache, logTag: string): Promise<void> {
  const temp = `${OBSERVE_CACHE_PATH}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    await rename(temp, OBSERVE_CACHE_PATH);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`${logTag} could not persist the observe cache (ignored): ${reason}`);
  }
}

/**
 * The cached half of the observe → act pattern: return a replayable `Action`
 * for `instruction` on this page, observing only on a miss.
 *
 * Throws when nothing matches. Callers that treat an absent control as an
 * ordinary outcome should use `tryResolveAction`.
 */
export async function resolveAction(
  session: BrowserSession,
  url: string,
  instruction: string
): Promise<{ action: CachedAction; cacheKey: string; cached: boolean }> {
  const cacheKey = observeCacheKey(url, instruction);
  const cache = await loadObserveCache();
  const hit = cache[cacheKey];
  if (hit?.selector) {
    console.log(`${session.logTag} observe cache HIT — ${instruction}`);
    return { action: hit, cacheKey, cached: true };
  }

  const { data: candidates } = await session.stagehand.observe(instruction, {
    page: session.page,
  });
  const found = candidates[0];
  if (!found?.selector) {
    throw new ControlNotFoundError(instruction, url);
  }

  const action: CachedAction = {
    selector: found.selector,
    description: found.description,
    ...(found.method === undefined ? {} : { method: found.method }),
  };
  cache[cacheKey] = action;
  await saveObserveCache(cache, session.logTag);
  console.log(
    `${session.logTag} observe cache MISS — cached ${instruction} → ${action.selector}`
  );
  return { action, cacheKey, cached: false };
}

/**
 * Raised when `observe()` matched nothing. Its own class so a caller can tell
 * "this control is not on the page" — an ordinary, expected outcome when
 * probing for an optional form field — apart from a genuine browser failure,
 * without matching on message text.
 */
export class ControlNotFoundError extends Error {
  constructor(
    readonly instruction: string,
    readonly url: string
  ) {
    super(
      `observe() found no control for "${instruction}" on ${url} — refusing to guess ` +
        `which element was meant.`
    );
    this.name = "ControlNotFoundError";
  }
}

/** `resolveAction`, but `null` instead of a throw when the control is absent. */
export async function tryResolveAction(
  session: BrowserSession,
  url: string,
  instruction: string
): Promise<{ action: CachedAction; cacheKey: string; cached: boolean } | null> {
  try {
    return await resolveAction(session, url, instruction);
  } catch (err) {
    if (err instanceof ControlNotFoundError) return null;
    throw err;
  }
}

export async function forgetAction(cacheKey: string, logTag: string): Promise<void> {
  const cache = await loadObserveCache();
  if (cache[cacheKey] === undefined) return;
  delete cache[cacheKey];
  await saveObserveCache(cache, logTag);
}

/** Text-entry methods. Anything else observed is overridden — see `typeInto`. */
const TEXT_ENTRY_METHODS = new Set(["fill", "type"]);

function textEntryMethod(action: CachedAction): string {
  return action.method !== undefined && TEXT_ENTRY_METHODS.has(action.method)
    ? action.method
    : "fill";
}

/**
 * Every `act()` in this repo goes through here or through an equally structured
 * call site, and never through `act("some sentence")`.
 *
 * Two separate properties come out of that, and both are load-bearing:
 *
 *  1. **The value never reaches a model.** Passing an `Action` object rather
 *     than a string makes Stagehand take its deterministic path — verified in
 *     the SDK, not assumed: `dist/extension/service-worker.js`, region
 *     `services/actService.ts`, opens with
 *     `if (typeof actInstruction !== "string") return actResult(await
 *     takeDeterministicAction(...))`. No snapshot is captured, no prompt is
 *     built, no inference runs. The board password, the candidate's email and
 *     every resume-derived value reach the browser and nowhere else.
 *
 *  2. **The instruction a model *can* see is always the caller's constant.**
 *     `description` is overwritten with `instruction` on purpose. Stagehand's
 *     `selfHeal` path (`selfHealAction` in the same region) re-infers from
 *     `action.description` when a cached selector stops resolving — and
 *     `description` as `observe()` returns it is model-written text derived from
 *     page content, i.e. the untrusted string this whole design exists to keep
 *     out of an action-capable call. Replacing it with the fixed instruction the
 *     caller already wrote closes that path. It costs nothing: `description` is
 *     otherwise only used for logging.
 *
 * The observed `method` is honoured only when it is a text-entry method. An
 * observation that came back as `click` or `press` for a field we are about to
 * type into is a misunderstanding, and carrying it through would click
 * something instead of filling it.
 */
export async function typeInto(
  session: BrowserSession,
  url: string,
  instruction: string,
  value: string
): Promise<CachedAction> {
  const { action, cacheKey, cached } = await resolveAction(session, url, instruction);

  try {
    await session.stagehand.act(
      {
        selector: action.selector,
        description: instruction,
        method: textEntryMethod(action),
        arguments: [value],
      },
      { page: session.page }
    );
    return action;
  } catch (err) {
    if (!cached) throw err;
    // A cached selector that no longer resolves is the one failure this can
    // recover from safely: nothing has been submitted, and re-observing a field
    // and filling it again is idempotent. Deliberately not extended to any
    // click, where a retry is not idempotent at all.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${session.logTag} cached selector for "${instruction}" no longer works (${reason}); ` +
        `re-observing once`
    );
    await forgetAction(cacheKey, session.logTag);
    const fresh = await resolveAction(session, url, instruction);
    await session.stagehand.act(
      {
        selector: fresh.action.selector,
        description: instruction,
        method: textEntryMethod(fresh.action),
        arguments: [value],
      },
      { page: session.page }
    );
    return fresh.action;
  }
}
