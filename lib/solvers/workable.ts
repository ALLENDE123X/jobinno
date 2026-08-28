/**
 * JOB-235 — the Workable dedicated solver.
 *
 * Phase 4 of the per-board solver architecture. Its shape is deliberately the
 * same as `domFallbackSolver`, `leverSolver` and `greenhouseSolver`: fill
 * with `fillApplicationFormRetainingSession` (ACT-007), then submit with
 * `runSubmitPhase` (ACT-008, still defined in `lib/submit-application.ts`),
 * on the same live Browserbase session, in the same order. Nothing about
 * either of those two functions changes here. See `dom-fallback.ts`'s header
 * for why that call order exists, and `lever.ts`'s and `greenhouse.ts`'s
 * headers for the two worked examples of a dedicated solver built on top of
 * it.
 *
 * ── The diagnosis (JOB-235) ─────────────────────────────────────────────────
 * Workable's inventory was six `jobs` rows and exactly one `applications`
 * row, `61287043-d354-4588-bbaf-55fea19c39fd` (Pony.ai, "Software Engineer,
 * Behavior", created 2026 08 25). It sits at `form_fill_blocked` with a
 * `blocked_redirect` skip_log row, message:
 *
 *   blocked_apply_url: the browser is at "https://apply.workable.com/oops"
 *   having opened the listing, and that page does not belong to the board
 *   this listing came from: the url names the workable board "oops", but the
 *   listing was read from the board "pony-ai". The listing pointed at
 *   "https://apply.workable.com/pony-ai/j/d29663c0-994f-4a09-912a-
 *   0ecfc8bb4542/", which passed this same rule before anything was opened...
 *
 * This is a pre-fill stop: `assertStillOnTheBoard` in
 * `lib/fill-application-form.ts` reads the browser's own URL right after the
 * listing opens, before any typing starts, and refuses to go on when it does
 * not belong to the board the listing was read from. `checkApplyUrl` (see
 * `lib/apply-url-guard.ts`) already runs the same rule at ingest and again
 * before every navigation, so nothing after this point is a fill or submit
 * bug: no session survives a `form_fill_blocked` row (see
 * `RetainedFillSession`'s own docstring — "null on every blocked path"), so
 * there is no live DOM left to read once this solver gets control back. That
 * is the one concrete way this file's shape has to depart from `lever.ts`'s
 * and `greenhouse.ts`'s: their probes read the live page after
 * `runSubmitPhase` returns; this one reads `fill.blockedReason`, the exact
 * string the block already wrote, because by the time a Workable listing
 * reaches this solver in that state the browser is already closed.
 *
 * ── What "apply.workable.com/oops" actually is ──────────────────────────────
 * Fetched directly (curl, 2026-08-27) rather than assumed:
 *
 *   $ curl -s https://apply.workable.com/pony-ai/j/d29663c0-994f-4a09-912a-0ecfc8bb4542/
 *   Redirecting to /oops.
 *
 * Workable's own server, not this pipeline's navigation, sends a request for
 * that specific job id to its own generic `/oops` path. `/oops` is Workable's
 * landing page for a direct job link it cannot currently resolve to a live
 * posting — this pipeline never typed, clicked, or requested anything that
 * produced that redirect. Nothing observable from here says *why* Workable
 * stopped serving this one job (removed, filled, or rehosted are all
 * consistent with the same server response), and this file does not guess
 * which. What it can say, and could not say before, is that the shape is
 * Workable's own named error path rather than an ordinary "board mismatch"
 * — the same kind of upgrade from a hedge to a fact that `describeLeverHcaptchaGate`
 * and `describeGreenhouseRequiredFieldsGate` make for their own boards.
 *
 * ── Why refuse, not follow ───────────────────────────────────────────────────
 * The ticket asks for "a Workable-specific redirect handler that either
 * follows or refuses the flagged redirect chain per what the diagnosis
 * revealed." The diagnosis is that `/oops` is Workable's own dead-link page,
 * not a real application form under a different path — so there is nothing
 * on it to follow, and the existing refusal (`assertStillOnTheBoard`,
 * unchanged by this file) is already the correct outcome. This solver adds a
 * confirming, named diagnosis on top of that refusal; it does not attempt to
 * make the redirect succeed.
 *
 * ── The other five listings are a different shape and are not blocked ──────
 * The five untried `jobs` rows (TMEIC ×3, Capula, HyperLight) all carry
 * Workable's account-free short link, `apply.workable.com/j/{code}/apply`
 * (`TENANT_FREE_LINK_HOSTS` in `lib/apply-url-guard.ts`), and a live fetch of
 * each (curl, 2026-08-27) confirms an ordinary HTTP 301 to the same board's
 * own tenant-qualified URL, e.g.:
 *
 *   $ curl -sD- -o /dev/null https://apply.workable.com/j/68E556E5CA/apply
 *   HTTP/2 301
 *   location: /tmeic-corporation-americas/j/68E556E5CA/apply
 *
 * `checkApplyUrl` accepts that landing: the redirected URL's board token
 * (`tmeic-corporation-americas`) matches the board the listing was read from,
 * so rule 5 in `lib/apply-url-guard.ts`'s header is satisfied on the ordinary
 * path, not the account-free exception. None of these five has ever been
 * attempted (`application_count: 0` on every row, queried 2026-08-27), so
 * there is no evidence of a mechanical redirect bug to fix for them — the
 * ticket's "the fill layer follows a Workable redirect it shouldn't, or vice
 * versa" framing does not hold for the one row that has actually run. What
 * this solver is for is registering Workable so these five get a real
 * attempt at all (they fell through to `domFallbackSolver` before this file
 * existed, which already runs the identical fill-then-submit flow — so this
 * changes nothing about whether they succeed, only adds a named diagnosis for
 * the one shape that is known to fail).
 *
 * ── Consent modals and the multi-page wizard ─────────────────────────────────
 * Both quirks the ticket calls out are already handled by shared code, board
 * agnostic, and neither needed a Workable-specific line here:
 *
 *   · Consent modal: `CONSENT_FIELD_RE` and `applyConsentPolicy` in
 *     `lib/fill-application-form.ts` (see the "Agreements, consents and
 *     certifications" block, and `isAttestationField`'s consent branch)
 *     already click through an "I agree" / consent checkbox on every board
 *     that renders one, Workable included.
 *   · Multi-page wizard: `advanceThroughWizard` (JOB-117, same file) already
 *     walks a multi-step form to its real submit control on every board,
 *     using `pageReadsAsFurtherStep` from `lib/application-wizard.ts` to tell
 *     "there is more of this form" apart from "this is done." Nothing about
 *     Workable's own wizard shape is different enough from the boards that
 *     exercised this code already to need a carve-out.
 *
 * ── The one real circular import ─────────────────────────────────────────────
 * Same cycle `lever.ts`'s and `greenhouse.ts`'s headers document in detail,
 * for the same reason: `submit-application.ts` imports `lookupSolver` from
 * `solvers/index.ts`, `index.ts` imports `workableSolver` from this file, and
 * this file imports the real (not type only) `gateName`/`runSubmitPhase` back
 * out of `submit-application.ts`. `workableSolver` is declared with
 * `function`, not a `const` arrow binding, for exactly the reason `lever.ts`,
 * `greenhouse.ts` and `dom-fallback.ts` already give: a `const` initializer
 * is not available until its own module finishes evaluating, and whichever of
 * the three modules a given entry point resolves first can otherwise reach
 * `index.ts`'s object literal before this file's own top level code has run,
 * throwing `ReferenceError: Cannot access 'workableSolver' before
 * initialization`. A function declaration is hoisted and bound before any
 * module's top level code runs at all, immune to that ordering question.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { recordSkipQuietly } from "@/lib/application-records";
import { type SkipReason } from "@/lib/db/schema";
import { fillApplicationFormRetainingSession } from "@/lib/fill-application-form";
import { closeBrowserSession } from "@/lib/stagehand-session";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";
import { gateName, runSubmitPhase } from "@/lib/submit-application";
import type { SolverContext, SolverInput, SolverResult } from "@/lib/solvers/types";

const LOG = "[job-235-workable]";

// Same shape as the private helper of the same name in
// `lib/submit-application.ts`, `lib/solvers/ashby-direct.ts`,
// `lib/solvers/dom-fallback.ts`, `lib/solvers/lever.ts` and
// `lib/solvers/greenhouse.ts` — each module that needs a Supabase client
// keeps its own copy rather than reaching across files for a private
// function.
function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required (see .env.example)"
    );
  }
  assertSupabaseProject(url);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ───────────────────────────────────
// The "/oops" redirect probe
// ───────────────────────────────────

/**
 * What the block's own message says about a Workable "/oops" redirect, read
 * as a plain value rather than as prose to keep matching — a shape, not a
 * sentence, so nothing here has to be kept in sync with a rewording of
 * `assertStillOnTheBoard`'s message elsewhere.
 */
export type WorkableOopsRedirectProbe = {
  /** The exact `https://apply.workable.com/oops...` URL quoted in the block message. */
  landedUrl: string;
};

// The exact shape `assertStillOnTheBoard` in `lib/fill-application-form.ts`
// writes: the `blocked_apply_url:` tag `lib/application-records.ts` classifies
// as `blocked_redirect`, followed by the landed URL in quotes. Anchored on
// the tag so an unrelated message that merely mentions this URL somewhere
// does not match, and scoped to `apply.workable.com/oops` specifically so a
// board mismatch that landed anywhere else on Workable's own domain — a real
// tenant page that is simply the wrong tenant, say — is left to the generic
// message rather than misreported as this named mechanism.
const WORKABLE_OOPS_REDIRECT_RE =
  /^blocked_apply_url: the browser is at "(https:\/\/apply\.workable\.com\/oops(?:[/?][^"]*)?)"/;

/**
 * Reads the block's own message for the Workable "/oops" shape. Never
 * throws — a message that does not match this exact shape, including `null`
 * (no block occurred, or the fill never reached `blockedReason` at all),
 * reads as `null`, the same "nothing to see here" outcome as a page that was
 * never gated in the first place. Pure and exported so this is pinned by
 * fixtures rather than only by a live board — the same reason
 * `probeLeverHcaptchaGate` and `probeGreenhouseRequiredFieldGate` are.
 *
 * Reads a string, not a live page, unlike its two counterparts in `lever.ts`
 * and `greenhouse.ts` — see this module's own header for why: no session
 * survives a `form_fill_blocked` row, so there is no DOM left here to read.
 */
export function probeWorkableOopsRedirect(
  blockedReason: string | null
): WorkableOopsRedirectProbe | null {
  if (blockedReason === null) return null;
  const match = WORKABLE_OOPS_REDIRECT_RE.exec(blockedReason);
  if (match === null) return null;
  return { landedUrl: match[1] };
}

/**
 * The sentence a human reads in `skip_log.raw_context.message`. Names the
 * mechanism — Workable's own generic dead-link landing page — rather than
 * repeating the generic "does not belong to the board" reading the block
 * already wrote, because this row exists specifically to replace a hedge
 * with a fact once one is available. Stops exactly where the evidence stops:
 * it names what `/oops` is on Workable's platform in general (confirmed by a
 * direct fetch during JOB-235's diagnosis, cited in this module's header) and
 * does not claim a specific cause — removed, filled, expired, or rehosted are
 * all consistent with the same server response, and nothing observable from
 * here tells those apart.
 */
export function describeWorkableOopsRedirect(
  probe: WorkableOopsRedirectProbe,
  applyUrl: string
): string {
  return (
    `Workable's own server sent this browser to "${probe.landedUrl}", Workable's generic ` +
    `landing page for a direct job link it cannot currently resolve to a live posting, not a ` +
    `page this pipeline's own navigation or redirect handling produced. The listing pointed at ` +
    `"${applyUrl}"; nothing was typed into the page Workable actually served, and no resume was ` +
    `uploaded to it. Nothing observable here says why Workable stopped serving this one job: ` +
    `removed, filled and temporarily unavailable would all read this same way, so this row ` +
    `does not guess which. A person should check the listing directly on Workable before ` +
    `deciding whether to retry it or drop it from the board registry. Nothing here is retried ` +
    `automatically.`
  );
}

const WORKABLE_OOPS_REDIRECT_REASON: SkipReason = "blocked_redirect";

// A `function` declaration, not a `const` arrow binding assigned `: SolverFn`
// — see this module's own header for the full account of why.
export async function workableSolver(
  input: SolverInput,
  row: SolverContext
): Promise<SolverResult> {
  const jobApplicationId = input.jobApplicationId.trim();
  const supabase = getSupabaseClient();

  // ── Phase 1: fill. Unchanged from `domFallbackSolver` — see that file's
  // header for why ACT-007 owns every guard and status write here.
  const { result: fill, session } = await fillApplicationFormRetainingSession({
    jobApplicationId,
    requiresCoverLetter: input.requiresCoverLetter,
    jobDescription: input.jobDescription ?? row.jobDescription,
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.additionalAnswers === undefined
      ? {}
      : { additionalAnswers: input.additionalAnswers }),
    ...(input.headless === undefined ? {} : { headless: input.headless }),
    ...(input.fillScreenshotDir === undefined
      ? {}
      : { screenshotDir: input.fillScreenshotDir }),
  });

  if (fill.blockedReason !== null || session === null) {
    // No live browser survives this path — see this module's header for why
    // that rules out a DOM read here the way `lever.ts` and `greenhouse.ts`
    // do theirs. `session` is still defensively checked and closed: the
    // contract says it is always null here, but closing whatever is handed
    // back costs nothing and does not depend on that contract holding.
    if (session !== null) await closeBrowserSession(session);
    console.warn(`${LOG} the fill did not complete — nothing to submit. Not clicking anything.`);

    let blockedReason =
      fill.blockedReason ??
      "the form fill returned no live browser session, so there was nothing to submit";

    const probe = probeWorkableOopsRedirect(fill.blockedReason);
    if (probe !== null) {
      const message = describeWorkableOopsRedirect(probe, row.applyUrl);
      console.warn(
        `${LOG} Workable's own "/oops" redirect blocked ${jobApplicationId} — writing a ` +
          `supplementary blocked_redirect skip_log row alongside the generic one the fill ` +
          `already wrote.`
      );
      await recordSkipQuietly(
        supabase,
        {
          applicationId: jobApplicationId,
          jobId: row.jobId,
          ats: row.ats,
          reason: WORKABLE_OOPS_REDIRECT_REASON,
          message,
          browserbaseSessionId: fill.browserbaseSessionId ?? null,
        },
        LOG
      );
      blockedReason = `${blockedReason} Workable's own redirect handling also confirmed: ${message}`;
    }

    return {
      jobApplicationId,
      status: fill.status,
      submitted: false,
      submitAttempted: false,
      confirmationRef: null,
      confirmation: null,
      securityCode: null,
      approval: { approved: false, gate: gateName(input), detail: "never reached — the fill stopped first" },
      submitControlLabel: null,
      fill,
      finalUrl: fill.finalUrl,
      pageTitle: fill.pageTitle,
      screenshotPath: fill.screenshotPath,
      blockedReason,
      unconfirmedReason: null,
      rowUpdated: false,
    };
  }

  // ── Phase 2: submit. The browser is live and on the filled form from here.
  // No Workable-specific post-submit gate is known — the one confirmed
  // failure mode is the pre-fill redirect handled above, and no live data
  // supports inventing a second one. See this module's header.
  try {
    return await runSubmitPhase(supabase, session, input, jobApplicationId, row, fill);
  } finally {
    await closeBrowserSession(session);
  }
}
