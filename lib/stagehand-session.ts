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
 *
 * ── JOB-006 ─────────────────────────────────────────────────────────────────
 * One more cache sits in front of the file backed one below, and it is the one
 * that matters commercially. The file cache is keyed by page URL, so it can only
 * help a posting this machine has already opened, and in production every
 * posting is one nobody has opened. `lib/form-action-cache.ts` keys the same
 * answers by what the *form* looks like instead, in Postgres, shared by every
 * run, so a first visit to a new Greenhouse posting already knows where the
 * email box is.
 *
 * The wiring here is three small things: `BrowserSession` can carry an
 * `actionPlan`, `resolveAction` consults it before anything else and files what
 * it learns back into it, and `reResolveLive` is the escape hatch a caller uses
 * when a replayed answer fails the checks it is put through. With no plan
 * attached every function below behaves exactly as it did before.
 */

import {
  Stagehand,
  localBrowser,
  type Page,
  type StagehandBrowser,
} from "@browserbasehq/stagehand";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planInvalidate,
  planLookup,
  planRecord,
  type ActionPlan,
} from "@/lib/form-action-cache";

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
  /**
   * JOB-006. The replayable plan for the form shape this session has landed on,
   * once a caller has looked one up and attached it.
   *
   * Mutable and optional on purpose. Optional because a session is opened long
   * before there is a form to fingerprint, and every helper here behaves exactly
   * as it did before this field existed when it is absent. Mutable because a run
   * both reads from it and teaches it, and what it learned is written back once
   * at the end rather than a row at a time.
   */
  actionPlan?: ActionPlan | null;
};

export type OpenBrowserSessionOptions = {
  headless: boolean;
  logTag: string;
};

/**
 * Launches a Chrome this run owns outright and attaches Stagehand to it.
 *
 * Deliberately no shared instance, no keepalive, no pool: a browser nobody else
 * can reach is what makes a hijack-defence layer unnecessary, and it is also
 * what makes `concurrency: { limit: 5 }` in
 * `inngest/job-application-pipeline.ts` safe — five calls are five Chrome
 * processes with five temp profiles.
 *
 * `port` and `userDataDir` are deliberately left unset. Stagehand's launcher
 * only picks a random free port and a fresh temp profile when they are absent;
 * pinning either would make concurrent runs collide on the debug port or on
 * Chrome's profile lock.
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
 */
const MAX_CONCURRENT_LAUNCHES = 2;

/** Resolves when a launch slot is free; the returned function gives it back. */
const launchQueue: Array<() => void> = [];
let launchesInFlight = 0;

async function acquireLaunchSlot(logTag: string): Promise<() => void> {
  if (launchesInFlight >= MAX_CONCURRENT_LAUNCHES) {
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

  // Held across launch *and* `Stagehand.create()`, because the 60s ceiling
  // covers both and init is not the cheap half.
  const releaseLaunchSlot = await acquireLaunchSlot(options.logTag);
  let browser: Awaited<ReturnType<typeof localBrowser.launch>>;
  try {
    browser = await localBrowser.launch({ headless: options.headless });
  } catch (err) {
    releaseLaunchSlot();
    throw err;
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
    console.warn(`${session.logTag} closing the local browser failed (ignored): ${reason}`);
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

/** What a resolve produced, and where it came from. */
export type ResolvedAction = {
  action: CachedAction;
  cacheKey: string;
  /** True when the per URL file cache answered, so a retry may safely re observe. */
  cached: boolean;
  /**
   * JOB-006. True when the shared per shape plan answered instead of a model.
   *
   * Callers use it for one thing: a replayed answer that does not hold up when
   * it is checked against the DOM, or that fails when acted on, earns exactly
   * one live observation rather than being treated as a real result. See
   * `reResolveLive`.
   */
  replayed: boolean;
};

/**
 * The cached half of the observe → act pattern: return a replayable `Action`
 * for `instruction` on this page, observing only on a miss.
 *
 * Throws when nothing matches. Callers that treat an absent control as an
 * ordinary outcome should use `tryResolveAction`.
 *
 * JOB-006 put one more cache in front of the two that were already here. The
 * order is shared plan, then per URL file, then a model, and it goes that way
 * because it is cheapest first: the plan is the only one that can answer for a
 * posting this machine has never opened, which in production is every posting.
 * A plan is only consulted for the instructions its owner marked cacheable, so
 * click paths reach the model exactly as they always did.
 */
export async function resolveAction(
  session: BrowserSession,
  url: string,
  instruction: string
): Promise<ResolvedAction> {
  const cacheKey = observeCacheKey(url, instruction);

  const planned = planLookup(session.actionPlan, instruction);
  if (planned.hit) {
    if (planned.action === null) {
      console.log(`${session.logTag} form action plan says absent (no model call): ${instruction}`);
      throw new ControlNotFoundError(instruction, url);
    }
    console.log(
      `${session.logTag} form action plan REPLAY (no model call): ${instruction} → ` +
        `${planned.action.selector}`
    );
    return {
      // The caller's own constant, never a stored model written description.
      // `lib/form-action-cache.ts` explains at length why nothing else is
      // allowed to come out of a table every user's runs read.
      action: {
        selector: planned.action.selector,
        description: instruction,
        ...(planned.action.method === undefined ? {} : { method: planned.action.method }),
      },
      cacheKey,
      cached: false,
      replayed: true,
    };
  }

  const cache = await loadObserveCache();
  const hit = cache[cacheKey];
  if (hit?.selector) {
    console.log(`${session.logTag} observe cache HIT — ${instruction}`);
    return { action: hit, cacheKey, cached: true, replayed: false };
  }

  const { data: candidates } = await session.stagehand.observe(instruction, {
    page: session.page,
  });
  const found = candidates[0];
  if (!found?.selector) {
    // An absence is worth remembering too. A board with no LinkedIn box costs a
    // model call to discover that on every single run otherwise.
    planRecord(session.actionPlan, instruction, null);
    throw new ControlNotFoundError(instruction, url);
  }

  const action: CachedAction = {
    selector: found.selector,
    description: found.description,
    ...(found.method === undefined ? {} : { method: found.method }),
  };
  cache[cacheKey] = action;
  await saveObserveCache(cache, session.logTag);
  planRecord(session.actionPlan, instruction, {
    selector: action.selector,
    ...(action.method === undefined ? {} : { method: action.method }),
  });
  console.log(
    `${session.logTag} observe cache MISS — cached ${instruction} → ${action.selector}`
  );
  return { action, cacheKey, cached: false, replayed: false };
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
): Promise<ResolvedAction | null> {
  try {
    return await resolveAction(session, url, instruction);
  } catch (err) {
    if (err instanceof ControlNotFoundError) return null;
    throw err;
  }
}

/**
 * JOB-006. Throws away a replayed answer that did not survive checking, and
 * observes the control live instead.
 *
 * This is what keeps the shared cache from ever being able to make a run worse
 * than it was before the cache existed. A stored selector is a guess made on
 * some other posting; the caller checks it against the DOM the way it checks
 * every other observation, and when the check fails this drops the entry from
 * the plan, drops the per URL copy with it, and pays for one real model call.
 * The cost of a wrong row is therefore exactly the call it tried to save.
 *
 * Returns `null` when the live observation finds nothing either, which is a real
 * answer and not a failure: the control is genuinely not on this page.
 */
export async function reResolveLive(
  session: BrowserSession,
  url: string,
  instruction: string,
  why: string
): Promise<ResolvedAction | null> {
  console.warn(
    `${session.logTag} replayed action for "${instruction}" did not hold up (${why}); ` +
      `observing it live once`
  );
  planInvalidate(session.actionPlan, instruction);
  await forgetAction(observeCacheKey(url, instruction), session.logTag);
  return await tryResolveAction(session, url, instruction);
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
  const { action, cacheKey, cached, replayed } = await resolveAction(session, url, instruction);

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
    // JOB-006 widened this from `cached` to "not observed live in this call".
    // A selector replayed from the shared per shape plan is a guess made against
    // some other posting, so it fails this way more often than a per URL one
    // does, and it is recoverable for exactly the same reason: nothing has been
    // submitted, and filling a field twice is idempotent. Still deliberately not
    // extended to any click, where a retry is not idempotent at all.
    if (!cached && !replayed) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${session.logTag} cached selector for "${instruction}" no longer works (${reason}); ` +
        `re-observing once`
    );
    // Both layers, or the same stale answer comes straight back.
    planInvalidate(session.actionPlan, instruction);
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
