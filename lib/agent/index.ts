/**
 * JOB-277 (sub ticket A of #276): scaffold for the Stagehand hybrid agent fill.
 *
 * This module is the entry point the pipeline reaches when a run has been
 * routed onto the agent path instead of the legacy widget fill. It is
 * deliberately empty of implementation. Every call throws
 * `AgentFillNotImplementedError` until the sub tickets B..H land, with one
 * exception: `buildFactCatalog`, hoisted into `lib/agent/fact-catalog.ts` by
 * JOB-296 and re-exported below, is real shared code and not a stub.
 *
 * The flag `USE_AGENT_FILL` defaults to false, and `USE_AGENT_FILL_ATS` is an
 * empty allowlist by default, so the routing helper answers `false` for every
 * ats until an operator turns both on. This is what keeps the scaffold zero
 * behavior change on the running pipeline. See `.env.example` for the full
 * shape of the flags and their defaults.
 */

import type {
  SubmitApplicationInput,
  SubmitApplicationResult,
} from "@/lib/submit-application";
import type { ApplicationStatus } from "@/lib/application-status";
import type { SkipReason } from "@/lib/db/schema";
import type { FactCatalog } from "@/lib/agent/fact-catalog";
import type {
  AgentSnapshotSource,
  SnapshotOptions,
} from "@/lib/agent/readback";
import type { PrefillPage, PrefillReport } from "@/lib/agent/prefill";
import type {
  PreSubmitVerifyPage,
  VerifyResult,
} from "@/lib/agent/verify";
import type {
  AgentLoopResult,
  RunAgentLoopOptions,
} from "@/lib/agent/router";
import { AgentBudgetExceededError } from "@/lib/agent/router";

/**
 * JOB-279 (sub ticket B): the snapshot type shapes and pure builders that
 * the eventual agent loop threads through every turn. Re-exported from the
 * package entry point so sub tickets C..H can `import { ... } from
 * "@/lib/agent"` without having to know which sibling file each name
 * originally lives in. The runtime behavior is still stubbed here (see
 * `runAgentFill` below); this only wires the shape.
 */
export type {
  AgentSnapshot,
  AgentSnapshotDiff,
  FieldKind,
  FieldNode,
  FieldValidationState,
  SectionHandle,
} from "@/lib/agent/snapshot-types";
export {
  buildDiffSnapshot,
  buildFullSnapshot,
  SNAPSHOT_MAX_BYTES,
  SnapshotBudgetExceededError,
} from "@/lib/agent/readback";
export type {
  AgentSnapshotSource,
  RawAccessibilityNode,
  SnapshotOptions,
} from "@/lib/agent/readback";

/**
 * JOB-280 (sub ticket C): the deterministic prefill pass. Exported a second time so
 * sub tickets D..H can `import { deterministicPrefill } from "@/lib/agent"`
 * without knowing the module layout. See `lib/agent/prefill.ts` for the
 * cost model and the HARD STOP 9 exclusion guard the walker enforces.
 */
export {
  classifyPrefillSlot,
  deterministicPrefill,
  isExcludedLabel,
} from "@/lib/agent/prefill";
export type {
  FilledField,
  PrefillError,
  PrefillOptions,
  PrefillPage,
  PrefillReport,
  PrefillSkipReason,
  PrefillSlot,
  SkippedField,
} from "@/lib/agent/prefill";

/**
 * JOB-296 (sub ticket G): the fact catalogue builder, moved from
 * `lib/fill-application-form.ts` into `lib/agent/fact-catalog.ts` so the fill
 * layer and the agent loop read one catalogue. Re-exported here so sub tickets
 * can `import { buildFactCatalog } from "@/lib/agent"` without knowing the
 * module layout. The stateful `buildAgentFactCatalog` sub ticket B promises is
 * still a throwing stub in the same file and is not exposed yet.
 */
export { buildFactCatalog } from "@/lib/agent/fact-catalog";

/**
 * Return type of `runAgentFill`. Kept as an alias of `SubmitApplicationResult`
 * so the pipeline can treat the agent path and the legacy path
 * interchangeably. The alias exists as its own name so sub tickets can widen
 * or narrow the shape without churning every call site.
 */
export type AgentFillResult = SubmitApplicationResult;

/**
 * Thrown by every stub in `lib/agent/`. A distinct class so callers can tell
 * "the agent path was reached before it was ready" apart from a real runtime
 * error inside the eventual implementation.
 */
export class AgentFillNotImplementedError extends Error {
  constructor(surface: string) {
    super(
      `${surface} is not implemented yet. This is a JOB-277 scaffold; the ` +
        `agent fill lands across sub tickets B through H of epic #276.`
    );
    this.name = "AgentFillNotImplementedError";
  }
}

/**
 * Reads the two feature flags and answers whether a run for `ats` should take
 * the agent path. Pure, so tests can pass a synthetic env and cover every
 * matrix cell without having to poke `process.env`.
 *
 * The allowlist splits on comma, trims whitespace, and drops empty entries, so
 * that `USE_AGENT_FILL_ATS=greenhouse, lever` and `USE_AGENT_FILL_ATS=,,`
 * both behave the way an operator expects rather than admitting an empty
 * string as a matching ats.
 */
export function shouldUseAgentFillForAts(
  ats: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (env.USE_AGENT_FILL !== "true") return false;
  const allowlist = (env.USE_AGENT_FILL_ATS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return allowlist.includes(ats);
}

/**
 * The read/verify surface `runAgentFill` needs from a live page. Composes
 * the three narrow interfaces the sibling modules already carry so a caller
 * (or a test) hands one adapter in and every sub pass reads through it. Sub
 * ticket E owns the concrete Playwright adapter that satisfies this shape
 * over a Stagehand `Page`; tests here pass a fake that answers each method
 * from plain state.
 */
export interface AgentFillPage
  extends PrefillPage,
    AgentSnapshotSource,
    PreSubmitVerifyPage {}

/**
 * The one lever between the pre submit verify pass and the submit click.
 * `submit` clicks the real submit control and reads the page afterwards;
 * `report` describes what happened so `runAgentFill` can write the right
 * `status` on the row and the right `submitAttempted` on the result. Kept
 * as a small callback rather than a bespoke shape so the eventual
 * production wiring (which is `runSubmitPhase` from
 * `lib/submit-application.ts`) can be injected as one function, and tests
 * can drive the three outcomes by hand.
 */
export interface AgentSubmitOutcome {
  status: Extract<
    ApplicationStatus,
    "submitted" | "submission_unconfirmed" | "submission_blocked"
  >;
  submitted: boolean;
  submitAttempted: boolean;
  confirmationRef: string | null;
  submitControlLabel: string | null;
  blockedReason: string | null;
  unconfirmedReason: string | null;
  finalUrl: string;
  pageTitle: string;
}

/**
 * Everything `runAgentFill` composes, exposed as injectable functions so a
 * test can drive every branch without opening a Browserbase session and
 * without spending an LLM call. Production defaults land wired to the real
 * modules in a follow up (sub ticket E's Stagehand adapter), because the
 * agent tool handlers in `lib/agent/tools.ts` still throw
 * `AgentFillNotImplementedError` for the write side of the loop: a run
 * with the default deps would try to execute a stub the first time the
 * model asked for `setFieldValue`.
 *
 *  - `loadFactCatalog` returns the catalog for the user id on `input`.
 *    Defaults to the shared `buildAgentFactCatalog` reader so both the
 *    prefill pass and the agent loop see the same facts.
 *  - `openPage` opens a live browser session and returns an adapter that
 *    satisfies every sub pass's page interface, plus a `close` callback the
 *    orchestrator invokes on the way out. The default is a stub throw; the
 *    real adapter arrives in sub ticket E.
 *  - `prefill`, `readback`, `agentLoop`, `verify`, and `submit` map one to
 *    one onto the pipeline stages A..E named in
 *    `agent-loop-architecture.md`. Defaults resolve to the real module
 *    functions.
 *  - `writeSkip` records the terminal reason on `applications` and appends
 *    the paired `skip_log` row. Defaults to the shared writer.
 *  - `env` is the same env source the router and prefill read, so a test
 *    can pin `AGENT_MAX_STEPS`, `AGENT_MAX_COST_CENTS`, and the escalation
 *    model without touching `process.env`.
 */
export interface RunAgentFillDeps {
  loadFactCatalog?: (input: SubmitApplicationInput) => Promise<FactCatalog>;
  openPage?: (
    input: SubmitApplicationInput
  ) => Promise<{ page: AgentFillPage; close: () => Promise<void>; session: unknown }>;
  prefill?: (
    page: AgentFillPage,
    catalog: FactCatalog,
    snapshotOptions?: SnapshotOptions
  ) => Promise<PrefillReport>;
  readback?: (page: AgentFillPage, options?: SnapshotOptions) => Promise<unknown>;
  agentLoop?: (
    session: unknown,
    factCatalogText: string,
    task: string,
    opts: RunAgentLoopOptions
  ) => Promise<AgentLoopResult>;
  agentLoopOptions?: (
    input: SubmitApplicationInput,
    tier: "primary" | "escalation"
  ) => RunAgentLoopOptions;
  verify?: (page: AgentFillPage) => Promise<VerifyResult>;
  submit?: (
    session: unknown,
    page: AgentFillPage,
    input: SubmitApplicationInput
  ) => Promise<AgentSubmitOutcome>;
  writeSkip?: (input: {
    jobApplicationId: string;
    reason: SkipReason;
    message: string;
    fieldLabel?: string | null;
  }) => Promise<void>;
  env?: Record<string, string | undefined>;
}

/**
 * Wraps a `FactCatalog` into the text block the router hands the model on
 * every turn. One entry per line, tab separated, path first so a model
 * quoting a path back on a `setFieldValue` call can pattern match on the
 * leading token. Empty catalogs collapse to the placeholder string a run
 * can still safely be prompted with, rather than an empty prompt that a
 * cache marker would attach to.
 */
export function serializeFactCatalog(catalog: FactCatalog): string {
  if (catalog.entries.length === 0) {
    return `# fact catalog for ${catalog.userId}\n(no entries)`;
  }
  const lines: string[] = [`# fact catalog for ${catalog.userId}`];
  for (const entry of catalog.entries) {
    const value =
      entry.value === null
        ? "(null)"
        : typeof entry.value === "string"
          ? entry.value
          : String(entry.value);
    lines.push(`${entry.path}\t${entry.label}\t${value}\t${entry.source}`);
  }
  return lines.join("\n");
}

/**
 * Builds one human readable line naming a verify failure. Used both in the
 * agent loop's retry feedback (round 1 asks the same model to fix the
 * marked fields; round 2 escalates to Sonnet) and, on a final fail, in the
 * `skip_log.message` that surfaces the stop to a reviewer.
 */
function describeVerifyErrors(result: VerifyResult): string {
  if (result.status === "pass") return "";
  if (result.status === "captcha_blocked") {
    return "a captcha widget is on the page";
  }
  const lines = result.errors.map(
    (err) => `  - ${err.siblingLabel}: ${err.errorText}`
  );
  return `the form still has ${result.errors.length} unfilled required field(s):\n${lines.join("\n")}`;
}

/**
 * Builds a `SubmitApplicationResult` for a run that stopped before the
 * submit click. Every field the pipeline reads is populated; the ones the
 * agent path does not fill (the legacy `fill` report, the security code
 * report) are left null the same way the legacy blocked exit leaves them.
 */
function blockedResult(
  input: SubmitApplicationInput,
  detail: {
    status: ApplicationStatus;
    blockedReason: string;
    finalUrl: string;
    pageTitle: string;
  }
): SubmitApplicationResult {
  return {
    jobApplicationId: input.jobApplicationId,
    status: detail.status,
    submitted: false,
    submitAttempted: false,
    confirmationRef: null,
    confirmation: null,
    securityCode: null,
    approval: { approved: false, gate: "auto", detail: detail.blockedReason },
    submitControlLabel: null,
    fill: null,
    finalUrl: detail.finalUrl,
    pageTitle: detail.pageTitle,
    screenshotPath: null,
    blockedReason: detail.blockedReason,
    unconfirmedReason: null,
    rowUpdated: false,
  };
}

/**
 * Builds a `SubmitApplicationResult` from an `AgentSubmitOutcome`. Preserves
 * the "one logical submission" invariant `submit-application.ts` carries:
 * `submitAttempted` reflects whether the click was issued, and the terminal
 * status is one of the three the outcome enumerates.
 */
function resultFromSubmitOutcome(
  input: SubmitApplicationInput,
  outcome: AgentSubmitOutcome
): SubmitApplicationResult {
  return {
    jobApplicationId: input.jobApplicationId,
    status: outcome.status,
    submitted: outcome.submitted,
    submitAttempted: outcome.submitAttempted,
    confirmationRef: outcome.confirmationRef,
    confirmation: null,
    securityCode: null,
    approval: { approved: true, gate: "auto", detail: "agent fill" },
    submitControlLabel: outcome.submitControlLabel,
    fill: null,
    finalUrl: outcome.finalUrl,
    pageTitle: outcome.pageTitle,
    screenshotPath: null,
    blockedReason: outcome.blockedReason,
    unconfirmedReason: outcome.unconfirmedReason,
    rowUpdated: true,
  };
}

/**
 * The agent fill orchestrator. Composes the sub ticket A..E building blocks
 * into the AGENT FILL SUBFLOW named in `agent-loop-architecture.md`:
 *
 *   A. `deterministicPrefill` fills the identity fields the label map
 *      recognises straight from the fact catalog. HARD STOP 9 is enforced
 *      by the prefill's inverted guard; this orchestrator does not widen
 *      it.
 *   B. `readback` builds a structured snapshot of the form the agent loop
 *      threads through every turn. Kept as a call the loop can memoize
 *      rather than a value passed by hand so a sub ticket that adds
 *      cross turn snapshot caching has one seam.
 *   C. `agentLoop` drives the LLM through the remaining fields. Cost cap
 *      (`AGENT_MAX_COST_CENTS`) and step cap (`AGENT_MAX_STEPS`) are read
 *      inside `runAgentLoop` from the injected env, so this orchestrator
 *      only handles the terminal `AgentBudgetExceededError` a breach
 *      throws. Retry contract: round 1 same rung, round 2 escalation.
 *   D. `verify` reads the form's own validation state. On fail with
 *      structured field errors the agent loop retries once with feedback;
 *      a second fail after escalation stops the run with
 *      `unanswerable_required`. A captcha blocks the run outright with
 *      the `captcha` reason.
 *   E. `submit` clicks the submit control and detects the outcome. Never
 *      called on a fail or captcha verdict.
 *
 * Every stage is injectable so a test can drive one branch without opening
 * a real Browserbase session. Production defaults resolve to the real
 * modules; the ones a caller has not yet supplied (the Stagehand page
 * adapter, the LLM `modelCall`, the runTool dispatch) throw
 * `AgentFillNotImplementedError` when reached with the default, which is
 * the shape the pipeline routing tests already assert against.
 */
export async function runAgentFill(
  input: SubmitApplicationInput,
  deps: RunAgentFillDeps = {}
): Promise<AgentFillResult> {
  const openPage = deps.openPage ?? defaultOpenPage;
  const loadFactCatalog = deps.loadFactCatalog ?? defaultLoadFactCatalog;
  const prefill = deps.prefill ?? defaultPrefill;
  const agentLoop = deps.agentLoop ?? defaultAgentLoop;
  const agentLoopOptions = deps.agentLoopOptions ?? defaultAgentLoopOptions;
  const verify = deps.verify ?? defaultVerify;
  const submit = deps.submit ?? defaultSubmit;
  const writeSkip = deps.writeSkip ?? defaultWriteSkip;
  const env = deps.env ?? process.env;

  // Fact catalog is built BEFORE the browser opens, so a run whose intake
  // data is missing (`loadCandidate` throws) fails without ever consuming
  // a Browserbase slot. Same ordering the legacy fill uses at
  // `runBrowserFlow` in `lib/fill-application-form.ts`.
  const catalog = await loadFactCatalog(input);
  const catalogText = serializeFactCatalog(catalog);

  const opened = await openPage(input);
  const page = opened.page;
  const session = opened.session;

  try {
    // ── Stage A: deterministic prefill ────────────────────────────────
    // Never throws on a per field failure — a `setFieldValue` rejection is
    // captured on the report and the walk continues. The report is not
    // written anywhere yet; sub ticket F wires it into the trace table.
    await prefill(page, catalog);

    // ── Stages B and C: readback plus agent loop ──────────────────────
    // Round 1 runs the primary rung. If the verify pass in stage D comes
    // back with structured errors, round 2 re runs the loop with the
    // feedback and escalates to the Sonnet rung via the router's own
    // `retry` counter. The loop options factory is injectable so a test
    // can pin `modelCall` and `runTool` without patching env.
    const primaryOptions = agentLoopOptions(input, "primary");
    // Merge the env override into every loop invocation so
    // `AGENT_MAX_STEPS` / `AGENT_MAX_COST_CENTS` reach `runAgentLoop`
    // through the same seam a test would use.
    await agentLoop(session, catalogText, buildTaskPrompt(input, false), {
      ...primaryOptions,
      env: primaryOptions.env ?? env,
    });

    // ── Stage D: verify ───────────────────────────────────────────────
    let verdict = await verify(page);

    if (verdict.status === "captcha_blocked") {
      await writeSkip({
        jobApplicationId: input.jobApplicationId,
        reason: "captcha",
        message:
          "the agent fill pre submit verify pass found a captcha on the page; " +
          "nothing was submitted",
      });
      const url = await safeUrl(page);
      const title = await safeTitle(page);
      return blockedResult(input, {
        status: "form_fill_blocked",
        blockedReason: "captcha on the form, nothing submitted",
        finalUrl: url,
        pageTitle: title,
      });
    }

    if (verdict.status === "fail") {
      // Round 2: escalate. The router's `pickModel` reads its own retry
      // counter; the orchestrator surfaces that through the loop options
      // factory so a test can assert the second call ran on the
      // escalation rung. Structured field errors are the retry contract
      // the architecture doc names.
      const escalationOptions = agentLoopOptions(input, "escalation");
      const feedback = `The pre submit verify pass reported: ${describeVerifyErrors(verdict)}`;
      await agentLoop(
        session,
        catalogText,
        buildTaskPrompt(input, true) + "\n\n" + feedback,
        { ...escalationOptions, env: escalationOptions.env ?? env }
      );
      verdict = await verify(page);
    }

    if (verdict.status === "fail" || verdict.status === "captcha_blocked") {
      const reason: SkipReason =
        verdict.status === "captcha_blocked" ? "captcha" : "unanswerable_required";
      await writeSkip({
        jobApplicationId: input.jobApplicationId,
        reason,
        message:
          verdict.status === "captcha_blocked"
            ? "a captcha appeared during the agent fill retry; nothing was submitted"
            : `the agent fill could not clear pre submit verify after retry — ${describeVerifyErrors(verdict)}`,
        fieldLabel:
          verdict.status === "fail" && verdict.errors[0]
            ? verdict.errors[0].siblingLabel
            : null,
      });
      const url = await safeUrl(page);
      const title = await safeTitle(page);
      return blockedResult(input, {
        status: "form_fill_blocked",
        blockedReason:
          verdict.status === "captcha_blocked"
            ? "captcha appeared during retry, nothing submitted"
            : "pre submit verify failed after retry, nothing submitted",
        finalUrl: url,
        pageTitle: title,
      });
    }

    // ── Stage E: submit ───────────────────────────────────────────────
    // Only reached when verify said pass. The one call site that clicks
    // the real submit control; `runSubmitPhase` (once wired) enforces
    // the "one logical submission, ever" rule and the "never retry after
    // a real click" rule.
    const outcome = await submit(session, page, input);
    return resultFromSubmitOutcome(input, outcome);
  } catch (cause) {
    // A cost or step cap breach in the agent loop lands as
    // `AgentBudgetExceededError`. The pipeline reads that as `submission_blocked`
    // with a specific `blockedReason` so an operator can raise the cap
    // (or shorten the loop) without treating it as a form failure.
    if (cause instanceof AgentBudgetExceededError) {
      await writeSkip({
        jobApplicationId: input.jobApplicationId,
        reason: cause.reason === "max-cost" ? "internal_error" : "timeout",
        message: cause.message,
      });
      const url = await safeUrl(page);
      const title = await safeTitle(page);
      return blockedResult(input, {
        status: "submission_blocked",
        blockedReason: cause.message,
        finalUrl: url,
        pageTitle: title,
      });
    }
    throw cause;
  } finally {
    // Ours to close, whatever happened. The adapter's `close` never throws
    // itself (both defaults wrap the underlying teardown in a swallow) so
    // this cannot replace a real result or a real error with a teardown
    // failure.
    try {
      await opened.close();
    } catch {
      // Swallowed on purpose — see the invariant above and the same
      // pattern in `domFallbackSolver`.
    }
  }
}

/** The one line task string the loop sees. Verbatim per architecture doc. */
function buildTaskPrompt(
  input: SubmitApplicationInput,
  escalated: boolean
): string {
  const preamble = escalated
    ? "You are the escalation pass. The primary model could not clear the pre submit verify pass."
    : "You are the primary agent driving a job application form.";
  return (
    `${preamble} ` +
    "Fill every required field from the fact catalog. If a fact is missing, " +
    "call markFieldUnanswerable rather than fabricating a value. Never write to " +
    "a background check critical field except from a resolvable intakeFactPath. " +
    `Application id: ${input.jobApplicationId}.`
  );
}

async function safeUrl(page: AgentFillPage): Promise<string> {
  try {
    return await Promise.resolve(page.url());
  } catch {
    return "";
  }
}

async function safeTitle(page: AgentFillPage): Promise<string> {
  try {
    return await Promise.resolve(page.title());
  } catch {
    return "";
  }
}

async function defaultLoadFactCatalog(
  input: SubmitApplicationInput
): Promise<FactCatalog> {
  // The applications row carries the user id; the pipeline hands
  // `jobApplicationId` in on `SubmitApplicationInput`. `buildAgentFactCatalog`
  // (in `lib/agent/fact-catalog.ts`) needs the user id, so a real
  // production path resolves it from the row via a supabase read. The
  // scaffold refuses rather than reading the wrong table: sub ticket B
  // wires the real resolver, and until then any caller can inject
  // `deps.loadFactCatalog` to bypass this default.
  //
  // This does not currently reach the pipeline. The pipeline path is
  // gated behind `USE_AGENT_FILL=true` and `USE_AGENT_FILL_ATS` (both off
  // by default), so a run that gets here has been explicitly opted in.
  throw new AgentFillNotImplementedError(
    "defaultLoadFactCatalog: pass deps.loadFactCatalog with a resolver from " +
      `applicationId ${input.jobApplicationId} to userId, then call buildAgentFactCatalog(userId).`
  );
}

async function defaultOpenPage(
  input: SubmitApplicationInput
): Promise<{ page: AgentFillPage; close: () => Promise<void>; session: unknown }> {
  void input;
  throw new AgentFillNotImplementedError(
    "defaultOpenPage: sub ticket E owns the Stagehand page adapter that satisfies " +
      "AgentFillPage. Inject deps.openPage for now."
  );
}

async function defaultPrefill(
  page: AgentFillPage,
  catalog: FactCatalog,
  snapshotOptions?: SnapshotOptions
): Promise<PrefillReport> {
  const { deterministicPrefill } = await import("@/lib/agent/prefill");
  return deterministicPrefill(
    page,
    catalog,
    snapshotOptions === undefined ? {} : { snapshotOptions }
  );
}

async function defaultAgentLoop(
  session: unknown,
  factCatalogText: string,
  task: string,
  opts: RunAgentLoopOptions
): Promise<AgentLoopResult> {
  const { runAgentLoop } = await import("@/lib/agent/router");
  return runAgentLoop(session, factCatalogText, task, opts);
}

function defaultAgentLoopOptions(
  input: SubmitApplicationInput,
  tier: "primary" | "escalation"
): RunAgentLoopOptions {
  void input;
  void tier;
  return {
    modelCall: async () => {
      throw new AgentFillNotImplementedError(
        "defaultAgentLoopOptions.modelCall: agent tool handlers in lib/agent/tools.ts " +
          "still throw AgentFillNotImplementedError, so a real LLM turn cannot proceed. " +
          "Inject deps.agentLoopOptions to drive the loop from a test."
      );
    },
    runTool: async () => {
      throw new AgentFillNotImplementedError(
        "defaultAgentLoopOptions.runTool: the tool dispatch adapter is not wired yet."
      );
    },
  };
}

async function defaultVerify(page: AgentFillPage): Promise<VerifyResult> {
  const { preSubmitVerify } = await import("@/lib/agent/verify");
  return preSubmitVerify(page);
}

async function defaultSubmit(
  session: unknown,
  page: AgentFillPage,
  input: SubmitApplicationInput
): Promise<AgentSubmitOutcome> {
  void session;
  void page;
  void input;
  throw new AgentFillNotImplementedError(
    "defaultSubmit: sub ticket E wires runSubmitPhase from lib/submit-application.ts " +
      "into this seam. Inject deps.submit for now."
  );
}

async function defaultWriteSkip(input: {
  jobApplicationId: string;
  reason: SkipReason;
  message: string;
  fieldLabel?: string | null;
}): Promise<void> {
  const { createClient } = await import("@supabase/supabase-js");
  const { assertSupabaseProject } = await import("@/lib/supabase-project-guard");
  const { recordSkipQuietly } = await import("@/lib/application-records");

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      `[job-296] cannot write skip_log without SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY: ${input.reason}`
    );
    return;
  }
  assertSupabaseProject(url);
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Read the row for its job id and ats before writing the skip. A skip
  // written without either would fail the CHECK constraints on the log
  // table, so a missing row degrades to a log line rather than a throw.
  const { data, error } = await supabase
    .from("applications")
    .select("job_id, jobs(ats)")
    .eq("id", input.jobApplicationId)
    .maybeSingle();
  if (error || !data) {
    console.error(
      `[job-296] cannot resolve applications ${input.jobApplicationId} for skip_log ` +
        `write (${input.reason}): ${error?.message ?? "no row"}`
    );
    return;
  }

  const jobs = data.jobs as { ats?: unknown } | { ats?: unknown }[] | null;
  const ats = Array.isArray(jobs)
    ? String((jobs[0]?.ats ?? "") as string)
    : String((jobs?.ats ?? "") as string);
  const jobId = String(data.job_id ?? "");

  await recordSkipQuietly(supabase, {
    applicationId: input.jobApplicationId,
    jobId,
    ats,
    reason: input.reason,
    message: input.message,
    fieldLabel: input.fieldLabel ?? null,
  });
}

/**
 * The one function the pipeline calls. Encapsulates the routing decision so
 * that the pipeline itself does not have to read env vars, and so that tests
 * can inject fakes for both the agent and the legacy path and assert exactly
 * which one was reached.
 *
 * Both `legacy` and `agent` default to the real implementations. The `env`
 * override is there for the same reason `shouldUseAgentFillForAts` accepts
 * one: it lets a test assert every routing branch without mutating global
 * state.
 */
export interface DispatchApplicationFillOptions {
  legacy?: (input: SubmitApplicationInput) => Promise<SubmitApplicationResult>;
  agent?: (input: SubmitApplicationInput) => Promise<SubmitApplicationResult>;
  env?: Record<string, string | undefined>;
}

export async function dispatchApplicationFill(
  input: SubmitApplicationInput,
  ats: string,
  options: DispatchApplicationFillOptions = {}
): Promise<SubmitApplicationResult> {
  const legacy = options.legacy ?? defaultLegacy;
  const agent = options.agent ?? runAgentFill;
  const env = options.env ?? process.env;
  return shouldUseAgentFillForAts(ats, env)
    ? await agent(input)
    : await legacy(input);
}

/**
 * Indirection through a function rather than an eager `import { submitApplication }`
 * so that the module graph does not pull `lib/submit-application.ts` (and its
 * Browserbase/Stagehand imports) into every test that only touches routing.
 * The real production path still resolves through this and calls the same
 * `submitApplication` it always has.
 */
async function defaultLegacy(
  input: SubmitApplicationInput
): Promise<SubmitApplicationResult> {
  const { submitApplication } = await import("@/lib/submit-application");
  return submitApplication(input);
}
