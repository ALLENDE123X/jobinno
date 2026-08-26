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

// Type-only: erased before runtime, so this half of the package is never
// actually resolved by `require()` and is unaffected by the JOB-029 issue
// below. The runtime values (`Stagehand`, `browserbase`, `localBrowser`) come
// from `loadStagehandRuntime()` instead of a top-level import — see the
// comment on that function for why.
import type { Page, Stagehand, StagehandBrowser } from "@browserbasehq/stagehand";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planInvalidate,
  planLookup,
  planRecord,
  type ActionPlan,
} from "@/lib/form-action-cache";
import { createFireworksClientLLM } from "@/lib/fireworks-client-llm";

/**
 * JOB-029 (issue #47): `@browserbasehq/stagehand`'s package.json declares
 * only an `"import"` export condition — it ships pure ESM (`dist/index.mjs`)
 * and has no `"require"` condition at all. This file has no
 * `"type": "module"` ancestor in package.json, so when it's run through
 * `tsx <file>` (as every `lib/*-cli.ts` entrypoint is) tsx transpiles it to
 * CommonJS and a top-level `import ... from "@browserbasehq/stagehand"` here
 * becomes a plain `require()` at runtime — which fails outright with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, because Node's `require()` matches a
 * package's exports map against the "require"/"node"/"default" conditions
 * only and never falls back to "import". That happens for a bare
 * `import { Stagehand } from "@browserbasehq/stagehand"` all on its own —
 * it is not a tsx version regression (reproduces identically on tsx 4.7.0
 * through the pinned 4.23.12) and has nothing to do with any other import
 * sharing the file.
 *
 * A dynamic `import()`, by contrast, always goes through Node's real ESM
 * resolver, which does honor the "import" condition, regardless of whether
 * the calling file itself is CJS or ESM — so that's what loads the runtime
 * values here instead. Deliberately called once and memoized, rather than
 * inline at each call site: `openBrowserSession` can run many times
 * concurrently (see `tests/unit/browser-session-concurrency.test.ts`), and
 * routing every one of those calls through its own fresh `import()` call
 * turned out to matter under Vitest specifically — concurrent first-time
 * `import()` calls for the same specifier could race ahead of `vi.mock`'s
 * module-registry substitution and load the real package instead of the
 * mock. A single shared promise means only the first caller ever triggers a
 * resolution at all; every later call, concurrent or not, awaits that same
 * settled promise instead of starting a new one.
 */
type StagehandRuntime = typeof import("@browserbasehq/stagehand");
let stagehandRuntimePromise: Promise<StagehandRuntime> | undefined;
function loadStagehandRuntime(): Promise<StagehandRuntime> {
  if (!stagehandRuntimePromise) {
    stagehandRuntimePromise = import("@browserbasehq/stagehand");
  }
  return stagehandRuntimePromise;
}

/**
 * Model driving `act`/`extract`/`observe`. Stagehand validates this string
 * against a closed per-provider allowlist at `Stagehand.create()`, so the
 * provider prefix is mandatory and a typo fails before any request is billed.
 *
 * JOB-175: this is the default and stays the default. Setting
 * `STAGEHAND_LLM_PROVIDER=fireworks` swaps `openBrowserSession` onto the
 * `lib/fireworks-client-llm.ts` adapter instead (Fireworks-hosted DeepSeek V4
 * Flash), which does not go through this constant or through
 * `ModelConfigSchema` at all — see that file's header for why a `ClientLLM`
 * callback was the only path available under the pinned Stagehand version.
 */
export const STAGEHAND_MODEL = "openai/gpt-5.6-luna" as const;

/** Set to exactly `"fireworks"` to drive Stagehand with Fireworks' DeepSeek V4 Flash instead of {@link STAGEHAND_MODEL}. Any other value, including unset, keeps the OpenAI path. */
export const STAGEHAND_LLM_PROVIDER_ENV_VAR = "STAGEHAND_LLM_PROVIDER";

/**
 * How long Stagehand waits for the DOM to stop changing before it **acts** on
 * the page. Stagehand's own default is 5s; this is raised because the boards
 * that matter here are the slow ones — Workday's careers SPA fetches its data
 * and mounts the application well after the HTML is parsed.
 *
 * JOB-021 corrected what this comment claims, because the original wording said
 * "before it reads the page" and that was wrong in a way that cost a production
 * run. In `@browserbasehq/stagehand` 4.0.1 this value reaches exactly one
 * function, `act()`, which awaits `waitForDomNetworkQuiet` before doing
 * anything at all. `extract()` and `observe()` accept no settle parameter and
 * call no such thing. So a click is followed by a settled page and a `goto` is
 * not, and anything that navigates and then reads has to wait for the page
 * itself. See `settleBeforeReading` in `lib/fill-application-form.ts`.
 */
export const DOM_SETTLE_TIMEOUT_MS = 30_000;

/**
 * How long a navigation may take.
 *
 * Not a lifecycle. `page.goto` in this SDK defaults to
 * `waitUntil: "domcontentloaded"` and no caller here overrides it, so a
 * navigation returns as soon as the HTML is parsed however long this is set to.
 * Waiting for a client rendered board to become a page is a separate job and
 * belongs to whoever is about to read it.
 */
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
  /**
   * Issue #88. When provided and `BROWSERBASE_CONTEXTS_ENABLED=1`, this
   * Browserbase Context ID is attached to the session so cookies and
   * localStorage persist across runs for the same user.
   *
   * Obtain it via `createBrowserbaseContext()` and store it in
   * `profiles.browserbase_context_id`. Ignored for local browser sessions.
   */
  contextId?: string;
  /**
   * When `true`, the Browserbase session is launched without proxies.
   *
   * Ashby's spam filter specifically detects proxy IPs and rejects submissions
   * from them (their rejection page lists "Turn off your VPN or proxy" as the
   * first suggestion). Setting this disables proxies for Ashby sessions so the
   * outbound IP is the Browserbase host rather than a proxy node.
   */
  disableProxies?: boolean;
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
 * Set to `"1"` to enable Browserbase Contexts (issue #88). When enabled,
 * `openBrowserSession` passes a persistent Context to the Browserbase session,
 * carrying cookies and localStorage across runs for the same user.
 *
 * Off by default so existing deployments are unaffected until the Context IDs
 * have been provisioned and stored in `profiles.browserbase_context_id`.
 */
export const BROWSERBASE_CONTEXTS_ENABLED_ENV_VAR = "BROWSERBASE_CONTEXTS_ENABLED";

/**
 * Sessions this Browserbase project may run at once, when
 * `BROWSERBASE_CONCURRENCY` does not say otherwise.
 *
 * Not a guess, but no longer the account's hard cap either. `GET
 * /v1/projects/{id}` on the live Jobinno project originally reported
 * `"concurrency": 3`, which was the plan's own ceiling at the time — ask for a
 * fourth session and Browserbase refused it rather than queueing it. A plan
 * upgrade on 2026-08-21 raised that ceiling to 25 (`GET /v1/projects/{id}`
 * re-checked the same way). `3` stays the default here anyway: it is now a
 * deliberate fan-out width rather than a number forced by the account, and
 * widening it is a throughput decision for whoever wants the extra headroom,
 * not a side effect of this comment.
 *
 * ── JOB-028: does the gap between "this process is done with a session" and
 * "Browserbase has actually freed the slot" eat into that headroom? ─────────
 * `closeBrowserSession`'s `browser.close()` sends Browserbase a
 * `sessions.update(id, {status: "REQUEST_RELEASE"})` — a request, not a
 * confirmation — so in principle the provider could keep counting a session
 * against the cap for a while after this process has moved on and its own
 * in-process slot (JOB-025) is free again. Measured directly rather than
 * assumed: 8 real sessions, opened and closed exactly the way
 * `closeBrowserSession` does it (`stagehand.close()` then `browser.close()`),
 * polling `GET /v1/sessions/{id}` immediately after `browser.close()` resolved
 * locally. All 8 read back `COMPLETED` — never `RUNNING` — on the very first
 * poll, and the provider's own `updatedAt` for that transition was *before*
 * the local `browser.close()` call had even resolved in every trial (-275ms to
 * -442ms, mean -372ms). The provider is not lagging behind this process; if
 * anything the reverse. There is no measured reap lag to budget headroom for,
 * so no reduction to `BROWSERBASE_CONCURRENCY` is warranted on that basis —
 * see `scripts/browserbase-reap-lag.ts` to re-run this if Browserbase's own
 * infrastructure ever changes that answer.
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
 * Proxy and browser-presentation settings passed to Browserbase on every
 * remote launch, for JOB-046 (issue #80): a real run sent 10 applications
 * through Ashby-hosted boards across 6 unrelated companies and all 10 came
 * back rejected with Ashby's own platform-wide "flagged as possible spam"
 * message. The investigation the issue records traced the only
 * `browserbase.launch()` call site (right below) and found two plain
 * absences ranked as the highest-confidence, lowest-effort fix, ahead of
 * typing cadence and mouse movement, which are separate, higher-effort work
 * the issue explicitly defers until after this is re-tested: no proxy
 * configured at all, and no `browserSettings` at all, so every session ran
 * on whatever Browserbase's bare default happens to be — identically, every
 * time. A third-party benchmark cited in the issue (moderate confidence, not
 * first-party proof) found that exact unconfigured default leaking a
 * `Playwright: true` framework flag and an identical hardware/GPU
 * fingerprint across sessions.
 *
 * `BROWSERBASE_VIEWPORT` exists as its own named constant, following
 * `BROWSERBASE_SESSION_TIMEOUT_S` immediately above, rather than an inline
 * object at the call site, so a future caller — or a test — has one place to
 * read what this pipeline claims to be and one place to change it.
 *
 * `browserSettings.os` was here too, set to `"windows"`, until a live test
 * against the real Browserbase session-create API on this project's actual
 * plan came back `400 Bad Request: "windows OS is only available for
 * verified users, which is only available on the Enterprise plan. By
 * default, we only support Linux."` — confirmed directly, not inferred.
 * Every session on this project failed to create at all while that setting
 * was live, which is strictly worse than the fingerprint gap it was meant to
 * close. Removed rather than left in behind a flag: the whole point of
 * naming it here was one place to change it, and Linux (Browserbase's
 * default, unconfigured) is what this project can actually run. Revisit if
 * the project ever moves to Enterprise. `advancedStealth` and `verified` are
 * deliberately absent for the same reason `os` almost stayed in by mistake:
 * issue #80's investigation confirmed `advancedStealth` is Scale-plan-gated,
 * and `verified` gates `os` the same way `os` alone turned out to require it.
 *
 * `browserSettings.blockAds: true` was added for issue #85, for a different
 * pair of stops than `os` was chasing: SmartRecruiters (`oneclick-ui` shape)
 * filled an entire form and then reported no usable submit control at all,
 * and Workable clicked what it identified as the submit control and got no
 * confirmation either way — both genuinely unexplained. An ad iframe or
 * overlay sitting on top of the real submit control, or intercepting the
 * click, is a plausible explanation for either. Confidence: moderate — a
 * real mechanism, not a documented Browserbase claim tied to this specific
 * symptom. It is also a setting that can break something else: ad blocking
 * can take out legitimate functionality served from an ad-network-adjacent
 * domain, so this wants a re-run against both SmartRecruiters and Workable to
 * confirm nothing this pipeline actually needs got blocked along with it.
 */
export const BROWSERBASE_VIEWPORT = { width: 1920, height: 1080 } as const;

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
// ───────────────────────────────────
// The session slot limiter (JOB-025)
// ───────────────────────────────────

/**
 * How many browser sessions this process may hold open at once, and why the
 * thing being counted is a live session rather than a start.
 *
 * ── What this was, and the production run that disproved it ─────────────────
 *
 * Until JOB-025 the queue below gated *launches*. It took a slot before
 * `launch()` and gave it straight back once `Stagehand.create()` returned, on
 * the reasoning that the expensive, contended part of a local Chromium is its
 * cold start. That reasoning is still true of a local Chromium and is kept
 * verbatim below, because it is why the queue exists at all:
 *
 *   Stagehand enforces a hard-coded, non-configurable 60s ceiling on
 *   `create()`, covering launch plus init. Chrome's cold start is the expensive
 *   part of that and it is almost entirely CPU: five processes racing through
 *   startup on one machine take far longer each than five started in sequence,
 *   and past a point they simply do not make the ceiling. A live 5-wide fan-out
 *   lost three of five runs to "Stagehand initialization timed out after
 *   60000ms" and a `connect ECONNREFUSED`, on an 8-core / 8 GB machine whose
 *   15-minute load average was 23 at the time. The two that survived went on to
 *   fill forms normally. Once a browser is up it spends nearly all its time
 *   idle, waiting on the network and on model calls, so five *running* browsers
 *   cost little. It is five *starting* browsers that do.
 *
 * None of that was ever true of the resource Browserbase meters. Browserbase
 * caps concurrent sessions per project, counts a session from the moment
 * `sessions.create` is accepted until the session is released and reaped, and
 * refuses the one over the line rather than queueing it. A limiter that lets go
 * as soon as a session is up therefore places no bound whatsoever on the number
 * that matters. The old header said exactly that and treated it as acceptable:
 * "three live sessions plus a fourth start is still a refusal from
 * Browserbase", with the pipeline's own `concurrency.limit` nominated as the
 * thing that holds the line.
 *
 * It does not hold the line in principle: a caller whose continuation was
 * already queued when a release fired could read the lowered count before the
 * woken waiter resumed, and take a slot meant for whoever was already waiting.
 * That defect was real and confirmed against the old code (a brute force of
 * every interleaving overshoots to 3 sessions against a cap of 1), but it is
 * not what caused the incident below — nothing in that incident ever crossed
 * paths with it.
 *
 * On 2026-08-21, ten applications in one run failed to `internal_error` with
 * `"Failed to create a Browserbase session"`, the bare string Stagehand throws
 * when `sessions.create` is refused (it discards the cause, so the reason
 * never reached our logs). All ten refusals fell inside one four-minute
 * window, and the project's session history shows zero live sessions at the
 * moment each one fired — peak concurrent sessions across this project's
 * entire history never exceeded 3, the same 3 both the provider's cap and
 * this module's own limit carry. The cap was never approached, so this was
 * never an overshoot. Calling `POST /v1/sessions` directly, bypassing
 * Stagehand, reproduced the refusal and returned the reason it had been
 * discarding: `402 Payment Required — "Free plan browser minutes limit
 * reached."` The incident was a billing wall, not a concurrency race, and
 * nothing below fixes that; the account needs a plan upgrade before another
 * fan-out this size runs clean.
 *
 * What the incident did surface correctly is that the old release-then-
 * hand-off ordering could not be trusted to stay unreachable forever, and
 * that this module's real defect — a slot released the instant a session was
 * up rather than when it actually closed, against a resource Browserbase
 * meters by session lifetime, not by launch — was worth fixing regardless of
 * which failure mode found it first.
 *
 * ── What it is now ──────────────────────────────────────────────────────────
 *
 * A slot is taken before the provider is asked for a session and given back
 * only after `closeBrowserSession` has finished tearing that session down. The
 * number of slots held is therefore the number of sessions this process is
 * responsible for at the provider, counting one that is still being created and
 * one that is still being closed. That is the quantity Browserbase counts, so
 * it is now the quantity this module counts.
 *
 * What it still cannot see is a session belonging to some other process. This
 * limiter is module state, so it binds every caller inside one Node process
 * (the CLIs in `lib/`, and every Inngest run that a warm host executes in the
 * same instance) and nothing outside it. Across processes `applyToJob`'s
 * `concurrency.limit` is the only bound, and it counts runs rather than
 * sessions. Both read `browserConcurrencyLimit()` so the two numbers cannot
 * drift apart, and `BROWSERBASE_CONCURRENCY` lowers both together for anyone
 * who wants headroom under the plan cap rather than a pipeline that runs
 * permanently level with it.
 */
function sessionSlotLimit(): number {
  return browserConcurrencyLimit();
}

/**
 * One session's claim on the provider's cap, held from before the session is
 * created until after it is closed.
 *
 * The object identity is the handle. `releaseSessionSlot` takes the slot it was
 * handed rather than a count to subtract, which is what makes a double release
 * a no op instead of a hole in the limit.
 */
type SessionSlot = {
  readonly logTag: string;
  readonly acquiredAt: number;
  released: boolean;
};

/** A caller parked until a slot frees, in the order it arrived. */
type SlotWaiter = {
  readonly logTag: string;
  readonly queuedAt: number;
  readonly grant: (slot: SessionSlot) => void;
};

const heldSlots = new Set<SessionSlot>();
const slotWaiters: SlotWaiter[] = [];

/**
 * How long a slot may be held before it is treated as leaked rather than live.
 *
 * A ceiling is wanted because a slot is now released by a
 * `closeBrowserSession` that some caller has to reach, and a caller that never
 * reaches it would park a slot forever and eventually stop this process opening
 * any session at all. Every path in this repository closes in a `finally`, so
 * this should never fire, and it is loud when it does.
 *
 * The number is not a guess. `BROWSERBASE_SESSION_TIMEOUT_S` is passed on every
 * remote launch, so a session older than that has already been ended by
 * Browserbase and its slot freed on the provider's side, which makes it the
 * first moment at which reclaiming cannot overshoot the cap. The extra minute
 * is margin for the clock skew between the two. Reclaiming any earlier would
 * reintroduce the bug this file exists to fix.
 */
const SESSION_SLOT_MAX_HOLD_MS = (BROWSERBASE_SESSION_TIMEOUT_S + 60) * 1000;

/** Adds a slot to the held set. The only place that set ever grows. */
function takeSlot(logTag: string): SessionSlot {
  const slot: SessionSlot = { logTag, acquiredAt: Date.now(), released: false };
  heldSlots.add(slot);
  return slot;
}

/**
 * Drops slots held for longer than any session can still be alive.
 *
 * Runs on acquire rather than on a timer, so it costs nothing when nobody is
 * asking for a session and there is no interval keeping a CLI process alive
 * after its work is done.
 */
function reclaimLeakedSlots(): void {
  const cutoff = Date.now() - SESSION_SLOT_MAX_HOLD_MS;
  let reclaimed = false;
  for (const slot of heldSlots) {
    if (slot.acquiredAt > cutoff) continue;
    slot.released = true;
    heldSlots.delete(slot);
    reclaimed = true;
    console.error(
      `${slot.logTag} a browser session slot was held for over ` +
        `${Math.round(SESSION_SLOT_MAX_HOLD_MS / 1000)}s and has been reclaimed. That is ` +
        `longer than a session can live, so the provider has already ended it, but a slot ` +
        `only reaches this state when a session was opened and never closed. Find the path ` +
        `that skipped closeBrowserSession.`
    );
  }
  // A reclaim frees capacity the same way a normal release does, and a waiter
  // parked before the reclaim has no other way to learn about it: nothing here
  // otherwise wakes `slotWaiters`, so freed capacity would sit idle while a
  // caller waits on it, potentially forever if every slot leaked this way.
  if (reclaimed) grantWaitingSlots();
}

/**
 * Waits for a slot under the active provider's cap and returns the claim on it.
 *
 * The test and the take are both synchronous with no `await` between them, so
 * no other caller can run in the gap and two callers cannot pass the same test
 * on the same free slot. The interesting case is not this one though. It is the
 * hand-off in `grantWaitingSlots`.
 */
async function acquireSessionSlot(logTag: string): Promise<SessionSlot> {
  reclaimLeakedSlots();

  const limit = sessionSlotLimit();
  // Also requires an empty queue: without it, a slot freed by the reclaim
  // above (or any release whose `grantWaitingSlots` hand-off has not yet run)
  // could let this caller take it out of turn, ahead of whoever has been
  // waiting longest.
  if (slotWaiters.length === 0 && heldSlots.size < limit) return takeSlot(logTag);

  console.log(
    `${logTag} waiting for a browser session slot (${heldSlots.size} of ${limit} in use, ` +
      `${slotWaiters.length} already waiting). The provider counts a session from creation ` +
      `until it is closed and refuses the one over its cap, so waiting here is what stops a ` +
      `refusal there.`
  );

  return await new Promise<SessionSlot>((grant) => {
    slotWaiters.push({ logTag, queuedAt: Date.now(), grant });
  });
}

/** Gives a slot back. Idempotent, because callers release on every exit path. */
function releaseSessionSlot(slot: SessionSlot): void {
  if (slot.released) return;
  slot.released = true;
  heldSlots.delete(slot);
  grantWaitingSlots();
}

/**
 * Hands freed slots to whoever has been waiting longest.
 *
 * The order of the two statements in the loop body is worth stating plainly,
 * and worth being honest about. The old release decremented a counter and then
 * resolved a waiter's promise, which leaves the count one below the limit for
 * as long as it takes that waiter to resume. Reading the old code that looks
 * like an open window: a caller arriving in it would read the lowered count,
 * skip the queue and take the slot, and the woken waiter would then increment
 * on top of it. It is not actually reachable, and the reason it is not is worth
 * knowing rather than relying on. `resolve` schedules the waiter's continuation
 * as a microtask, the wait path is exactly one continuation deep, and microtask
 * order is FIFO, so the waiter always resumes before any caller that arrives
 * after the release. The old limiter was safe there by scheduling accident, and
 * it would have stopped being safe the first time anyone put a second `await`
 * on that path.
 *
 * Below it is safe by construction instead. `takeSlot` puts the replacement
 * slot in `heldSlots` *before* `grant` is called, and `grant` only resolves a
 * promise, so the set is never observably smaller than the limit while a waiter
 * is owed a slot. A caller arriving at any moment, through any number of
 * continuations, sees the true size and queues behind the waiter rather than in
 * front of it.
 *
 * The limit is re-read each pass rather than captured, so lowering
 * `BROWSERBASE_CONCURRENCY` takes effect as slots come back instead of being
 * fixed at whatever it was when this process started.
 */
function grantWaitingSlots(): void {
  while (slotWaiters.length > 0 && heldSlots.size < sessionSlotLimit()) {
    const waiter = slotWaiters.shift();
    if (waiter === undefined) return;
    const slot = takeSlot(waiter.logTag);
    console.log(
      `${waiter.logTag} took a browser session slot after ${Date.now() - waiter.queuedAt}ms ` +
        `(${heldSlots.size} of ${sessionSlotLimit()} in use)`
    );
    waiter.grant(slot);
  }
}

/**
 * Which slot each open session is holding.
 *
 * A `WeakMap` rather than a field on `BrowserSession`, for two reasons. The
 * slot is bookkeeping this module owns outright and no caller has any business
 * reading or replacing it, and a session built by a test fixture rather than by
 * `openBrowserSession` has no entry at all, so `closeBrowserSession` on one
 * stays the plain teardown it always was.
 */
const slotForSession = new WeakMap<BrowserSession, SessionSlot>();

/**
 * How many sessions this process currently holds against the provider's cap,
 * and what the cap is.
 *
 * Exported for the tests, which is the only honest reason: a limiter whose
 * whole job is a number nobody can see is a limiter nobody can prove. Reading
 * it changes nothing.
 */
export function browserSessionSlotsInUse(): { held: number; waiting: number; limit: number } {
  return { held: heldSlots.size, waiting: slotWaiters.length, limit: sessionSlotLimit() };
}

/**
 * Names and addresses the browser is told to refuse, whoever asks it to go
 * there.
 *
 * This is defence in depth behind `lib/apply-url-guard.ts`, which is the real
 * gate: no URL reaches a `goto` in this pipeline without having been checked
 * against the board it claims to belong to. What this adds is a second layer
 * for the navigations nobody in this repository writes, the ones a page starts
 * for itself with a redirect or a script, and it matters most on the local
 * browser: a remote Browserbase session that reaches `169.254.169.254` reaches
 * Browserbase's own metadata endpoint, while a local one reaches ours.
 *
 * The list is names and literal addresses because that is what the API takes.
 * There is no CIDR here, so this cannot stand in for the address range check in
 * `unroutableHostReason`, and it is not meant to.
 */
export const BLOCKED_BROWSER_DOMAINS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  // The cloud metadata endpoints. Every one of these answers with credentials
  // to something, and none of them is ever a job application form.
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "100.100.100.200",
];

/**
 * Applies `BLOCKED_BROWSER_DOMAINS` to a freshly opened context, before it has
 * been asked to go anywhere.
 *
 * Best effort, and deliberately so. `setDomainPolicy` is a call into whichever
 * Stagehand server is on the other end of the session, and a provider that does
 * not implement it must not be the reason a candidate's application does not
 * get filed. A failure is loud in the log and the run continues, protected by
 * the URL check that would have had to fail first for any of this to matter.
 */
async function blockUnroutableDomains(
  context: { setDomainPolicy(policy: { blockedDomains?: string[] }): Promise<void> },
  logTag: string
): Promise<void> {
  try {
    await context.setDomainPolicy({ blockedDomains: [...BLOCKED_BROWSER_DOMAINS] });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${logTag} could not block loopback and metadata addresses at the browser ` +
        `(${reason}). The run continues; every URL it opens is still checked against the ` +
        `board it belongs to first.`
    );
  }
}

// ───────────────────────────────────
// Captcha-solving evidence (issue #85)
// ───────────────────────────────────

/** The two console markers Browserbase's own managed solver writes. */
const CAPTCHA_SOLVING_STARTED_MARKER = "browserbase-solving-started";
const CAPTCHA_SOLVING_FINISHED_MARKER = "browserbase-solving-finished";

/**
 * Best-effort text out of a `Runtime.consoleAPICalled` CDP event's `args`.
 *
 * This SDK's `page.on("console", …)` (below) hands a listener the raw CDP
 * event, not a Playwright `ConsoleMessage` — there is no `.text()` to call.
 * Each console argument is a Chrome DevTools `RemoteObject`; for the plain
 * string `console.log(...)` calls a marker like this is written with, `value`
 * carries the text directly. Deliberately permissive rather than a full CDP
 * `RemoteObject` parser: this only ever has to recognise two fixed strings.
 */
function consoleEventArgsText(params: Record<string, unknown> | undefined): string {
  const args = params?.args;
  if (!Array.isArray(args)) return "";
  return args
    .map((arg) => {
      if (arg === null || typeof arg !== "object") return "";
      const record = arg as Record<string, unknown>;
      if (typeof record.value === "string") return record.value;
      if (typeof record.description === "string") return record.description;
      return "";
    })
    .join(" ");
}

/**
 * Issue #85: confirms — rather than assumes — that Browserbase's managed
 * captcha solver actually engaged on a given run.
 *
 * `browserSettings.solveCaptchas` defaults to `true` already (confirmed in
 * the installed `@browserbasehq/sdk` types) and nothing here changes that.
 * What was missing was evidence: Browserbase's solver writes
 * `browserbase-solving-started` / `browserbase-solving-finished` to the
 * page's own console when it engages, so a console listener turns "maybe a
 * captcha ate the submit button" into a yes/no for future debugging, right
 * in the same log stream as the rest of a run's `logTag` narration (e.g.
 * `[act-007]`/`[act-008]`).
 *
 * Best effort, in the same shape as `blockUnroutableDomains` just above: a
 * `page` that does not implement `on()` at all — every mocked page in this
 * repo's test suite, and any future non-Browserbase provider — must not be
 * the reason a run fails over a piece of after-the-fact evidence.
 */
async function watchForCaptchaSolvingEvidence(page: Page, logTag: string): Promise<void> {
  try {
    await page.on("console", (event) => {
      const text = consoleEventArgsText(event.params);
      if (text.includes(CAPTCHA_SOLVING_STARTED_MARKER)) {
        console.log(`${logTag} captcha solving detected: started`);
      } else if (text.includes(CAPTCHA_SOLVING_FINISHED_MARKER)) {
        console.log(`${logTag} captcha solving detected: finished`);
      }
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${logTag} could not attach a console listener for captcha-solving evidence (ignored): ` +
        `${reason}. This does not change whether Browserbase's own captcha solver runs — only ` +
        `whether this process can see when it did.`
    );
  }
}

export async function openBrowserSession(
  options: OpenBrowserSessionOptions
): Promise<BrowserSession> {
  const usesFireworks = process.env[STAGEHAND_LLM_PROVIDER_ENV_VAR] === "fireworks";
  const apiKey = usesFireworks
    ? process.env.FIREWORKS_API_KEY || process.env.STAGEHAND_LLM_API_KEY
    : process.env.STAGEHAND_LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      usesFireworks
        ? `FIREWORKS_API_KEY env var is required (falls back to STAGEHAND_LLM_API_KEY) when ` +
          `${STAGEHAND_LLM_PROVIDER_ENV_VAR}=fireworks — see .env.example.`
        : "STAGEHAND_LLM_API_KEY env var is required (the LLM key Stagehand drives " +
          `${STAGEHAND_MODEL} with — see .env.example). This is a dedicated key for this ` +
          `pipeline; do not point it at another project's key.`
    );
  }

  // See `loadStagehandRuntime` above (JOB-029) for why this isn't a
  // top-level import.
  const { Stagehand, browserbase, localBrowser } = await loadStagehandRuntime();

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

  // Taken before the provider is asked for anything, and given back only once
  // `closeBrowserSession` has finished, so this session occupies a slot here
  // for as long as it occupies one there. See the limiter's header for the
  // production run that made the difference between the two matter.
  const slot = await acquireSessionSlot(options.logTag);
  let browser: StagehandBrowser;
  try {
    // Issue #88: attach a persistent Context when the feature flag is on and
    // the caller supplied a context ID. Falls back to ephemeral if not.
    const contextsEnabled =
      process.env[BROWSERBASE_CONTEXTS_ENABLED_ENV_VAR] === "1";
    const contextId = contextsEnabled ? options.contextId : undefined;

    browser =
      choice.provider === "browserbase"
        ? await browserbase.launch({
            apiKey: choice.apiKey,
            projectId: choice.projectId,
            // `options.headless` has no remote equivalent and is not silently
            // mapped to anything: a Browserbase session has no display either
            // way, and its live view is how a run gets watched.
            api_timeout: BROWSERBASE_SESSION_TIMEOUT_S,
            // JOB-046 (issue #80): see `BROWSERBASE_VIEWPORT`'s comment above
            // for why these are here and what is deliberately not (including
            // `os`, which was here too and broke every session on this plan).
            // `blockAds` (issue #85) is documented in that same comment.
            // Ashby's spam filter detects proxy IPs and rejects submissions;
            // `disableProxies` lets the caller opt out for boards known to flag them.
            proxies: options.disableProxies !== true,
            browserSettings: {
              viewport: BROWSERBASE_VIEWPORT,
              blockAds: true,
              ...(contextId !== undefined ? { context: { id: contextId, persist: true } } : {}),
            },
          })
        : await localBrowser.launch({ headless: options.headless });
  } catch (err) {
    // Nothing was created, or Stagehand already cleaned up what was. Either
    // way this process is holding no session, so the slot goes back before the
    // error does and the next caller in the queue gets it.
    logSessionOpenFailure(options.logTag, err);
    releaseSessionSlot(slot);
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
      model: usesFireworks ? createFireworksClientLLM(apiKey) : { modelName: STAGEHAND_MODEL, apiKey },
      domSettleTimeoutMs: DOM_SETTLE_TIMEOUT_MS,
      // Re-find a control whose cached selector no longer resolves rather than
      // failing the run. Only ever re-finds the control the instruction already
      // named; it cannot widen what a caller is willing to click.
      selfHeal: true,
      logging: { level: "error" },
    });

    const context = stagehand.browser.context;
    await blockUnroutableDomains(context, options.logTag);
    const page = (await context.activePage()) ?? (await context.newPage());
    // Issue #85: evidence that Browserbase's captcha solver did or did not
    // fire on this run, in the same log stream as the rest of it.
    await watchForCaptchaSolvingEvidence(page, options.logTag);
    const session: BrowserSession = { stagehand, browser, page, logTag: options.logTag };
    // The last statement before the return, so a session only ever becomes the
    // holder of a slot once it is a session the caller actually has and can
    // close. Everything above this line releases the slot on its own way out.
    slotForSession.set(session, slot);
    return session;
  } catch (err) {
    // The browser is ours and nothing else will ever close it. `close()` on the
    // remote provider is what releases the session, so this is also what keeps
    // a failed init from parking a slot on Browserbase for the full
    // `api_timeout`, and the local slot only goes back once it has run.
    await browser.close().catch(() => undefined);
    logSessionOpenFailure(options.logTag, err);
    releaseSessionSlot(slot);
    throw err;
  }
}

/**
 * Says what this process was holding when a session could not be opened.
 *
 * The error itself is rethrown untouched, because callers classify on it and
 * `skip_log` records its message. This is the context that message cannot
 * carry: Stagehand catches the provider's response with a bare `catch {}` and
 * throws the fixed string "Failed to create a Browserbase session", discarding
 * the cause, so nine of those in a row say nothing at all about whether the
 * project was at its cap. The counts do.
 */
function logSessionOpenFailure(logTag: string, err: unknown): void {
  const inUse = browserSessionSlotsInUse();
  const reason = err instanceof Error ? err.message : String(err);
  console.error(
    `${logTag} could not open a browser session: ${reason}. This process was holding ` +
      `${inUse.held} of its ${inUse.limit} session slots with ${inUse.waiting} caller(s) ` +
      `waiting. A refusal while that first number is below the limit means the sessions ` +
      `over the cap belong to another process or have not been reaped by the provider yet.`
  );
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
      // JOB-025 raised the remote half of this from a warning to an error, and
      // only the remote half. A local Chrome that will not die costs this
      // machine some memory. A Browserbase session that was never released goes
      // on holding one of the project's concurrency slots until `api_timeout`
      // expires, which is twenty minutes during which the limiter below thinks
      // the slot is free and the provider does not, and that is precisely the
      // disagreement this ticket exists to stop.
      const say = session.browser.provider === "browserbase" ? console.error : console.warn;
      say(
        `${session.logTag} closing the ${what} browser failed (ignored): ${reason}` +
          (session.browser.provider === "browserbase"
            ? `. The session may still be holding one of the project's concurrency slots ` +
              `until its ${BROWSERBASE_SESSION_TIMEOUT_S}s timeout expires, so a run that ` +
              `is refused a session shortly after this line has its reason here.`
            : "")
      );
    }
  } finally {
    // In the `finally` and after both closes, in that order and for one reason
    // each. After, because the slot stands for a session at the provider and
    // that session is only gone once `close()` has returned. In the `finally`,
    // because neither `close()` above can throw past this point but a future
    // edit to them must not be able to strand a slot either.
    const slot = slotForSession.get(session);
    if (slot !== undefined) {
      slotForSession.delete(session);
      releaseSessionSlot(slot);
    }
  }
}

// ───────────────────────────────────
// Browserbase Contexts (issue #88)
// ───────────────────────────────────

/**
 * In-memory table of per-user context-creation Promises.
 *
 * When two runs for the same user start simultaneously, only the first call to
 * `createBrowserbaseContext` for that user actually hits the Browserbase REST
 * API. Any subsequent call that arrives while the first is in flight awaits the
 * same Promise and gets the same result. This prevents duplicate context rows
 * in a single process; duplicate contexts across processes are not possible
 * because the second process reads from the database and finds the one the
 * first process already stored.
 */
const contextCreationInFlight: Map<string, Promise<string>> = new Map();

/**
 * Creates a new Browserbase Context for the given user, returning its ID.
 *
 * The returned ID should be stored in `profiles.browserbase_context_id` so
 * subsequent runs can reuse the same context. Call this at most once per user;
 * subsequent runs should pass the stored ID directly to `openBrowserSession`.
 *
 * Concurrency-safe within a single process: simultaneous calls for the same
 * userId share one in-flight Promise and receive the same context ID.
 */
export async function createBrowserbaseContext(
  userId: string,
  apiKey: string,
  projectId: string
): Promise<string> {
  const existing = contextCreationInFlight.get(userId);
  if (existing !== undefined) return existing;

  const creation = (async (): Promise<string> => {
    try {
      const response = await fetch("https://api.browserbase.com/v1/contexts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BB-API-Key": apiKey,
        },
        body: JSON.stringify({ projectId }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "(unreadable)");
        throw new Error(
          `Browserbase context creation failed with HTTP ${response.status}: ${body}`
        );
      }
      const data = (await response.json()) as { id: string };
      if (typeof data.id !== "string" || data.id.length === 0) {
        throw new Error(`Browserbase context creation returned an unexpected body: ${JSON.stringify(data)}`);
      }
      return data.id;
    } finally {
      contextCreationInFlight.delete(userId);
    }
  })();

  contextCreationInFlight.set(userId, creation);
  return creation;
}

/**
 * JOB-050 — the missing half of issue #88's Contexts work.
 *
 * `createBrowserbaseContext` above has existed and been correct since #88, and
 * `openBrowserSession` has known how to attach a context since then too. Between
 * the two there was nothing: no caller ever created a context, and no caller
 * ever passed `contextId`, so the feature was unreachable code behind a flag
 * nobody could usefully set. The `browserbase_context_id` column its own
 * migration adds was likewise never read or written.
 *
 * That mattered because a context is the one countermeasure aimed squarely at
 * what a cold session looks like: same fingerprint, same cookie jar, run after
 * run, which is a returning device rather than a new machine every time.
 *
 * Returns `undefined` rather than throwing on every failure path, and that is
 * deliberate. A context is a hardening measure, not a correctness requirement;
 * an application that would have gone out without one should still go out when
 * the contexts API is unreachable, the flag is off, or the column write loses a
 * race. The only cost of returning `undefined` is a session that looks as cold
 * as every session looked before this function existed.
 */
export async function resolveBrowserbaseContextId(input: {
  userId: string;
  /** Reads `profiles.browserbase_context_id` and writes it back when minted. */
  readStoredId: () => Promise<string | null>;
  persistId: (contextId: string) => Promise<void>;
  logTag: string;
  env?: EnvSource;
}): Promise<string | undefined> {
  const env = input.env ?? process.env;
  if (readEnv(env, BROWSERBASE_CONTEXTS_ENABLED_ENV_VAR) !== "1") return undefined;

  const choice = chooseBrowserProvider(env);
  if (choice.provider !== "browserbase") return undefined;

  try {
    const stored = await input.readStoredId();
    if (stored !== null && stored !== "") {
      console.log(`${input.logTag} reusing Browserbase context ${stored.slice(0, 8)}…`);
      return stored;
    }

    const created = await createBrowserbaseContext(input.userId, choice.apiKey, choice.projectId);
    // Persisted before it is returned, so the next run reuses this one instead
    // of minting another. A failure to persist is not a failure to browse: the
    // context still works for this run, it just will not be found again.
    try {
      await input.persistId(created);
    } catch (err) {
      console.log(
        `${input.logTag} Browserbase context ${created.slice(0, 8)}… was created but not stored ` +
          `(${err instanceof Error ? err.message : String(err)}), so the next run will mint a new one`
      );
    }
    console.log(`${input.logTag} created Browserbase context ${created.slice(0, 8)}…`);
    return created;
  } catch (err) {
    console.log(
      `${input.logTag} continuing without a Browserbase context: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
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
