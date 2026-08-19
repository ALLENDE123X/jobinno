/**
 * ACT-009 — the orchestration layer. Two Inngest functions, wired to the real
 * ACT-002 through ACT-008 modules and, since JOB-004, to Jobinno's own schema.
 *
 *   1. discoverListings — ONE bulk search per request, runs once.
 *   2. applyToJob       — fans out from that single list. N listings = N
 *                         independent runs, with `concurrency` capping how many
 *                         are in flight at the active browser provider's limit.
 *                         Each run is its own sequential chain internally
 *                         (claim the row, then fill and submit) because those
 *                         are causally dependent; every listing's chain runs in
 *                         parallel with every other listing's.
 *
 * ── Four things the original stub got wrong, and what replaced them ──────────
 *
 * **1. A live browser cannot be handed between steps.** The stub did
 * `const account = await step.run("create-account", …)` and then passed
 * `account.session` into a later `fill-application` step. Inngest's durable
 * execution can run those two steps in different invocations of this process —
 * that is the whole point of it — so `account.session` would arrive as a JSON
 * corpse of a Playwright page. This is exactly why ACT-007 and ACT-008 were
 * each built as self-contained, re-entrant calls keyed only by an application
 * row id: `submitApplication` takes a row id and returns plain data, and has no
 * session in its signature at all. Nothing crosses a step boundary here but ids
 * and strings.
 *
 * **2. Filling and submitting are ONE step, not two.** `submitApplication()`
 * (ACT-008) already calls ACT-007's `fillApplicationFormRetainingSession()` and
 * submits in *the same browser* — see its "Why this calls ACT-007 rather than
 * resuming it" header. A separate `fill-application` step followed by a
 * `submit-application` step would open two browsers, fill the form in the first,
 * throw it away, and then ask the second to submit a form it never filled. So
 * there is one `fill-and-submit-application` step and it calls ACT-008 alone.
 *
 * **3. There is no verification wait at all any more (JOB-004).** The stub
 * always waited for `email/verification-received`; the port narrowed that to
 * the one status that meant a signup had really been submitted. Jobinno removes
 * it outright, and the reason is a product decision rather than a simplification.
 *
 * Jobinno creates no accounts on employers' boards. `lib/future-gmail/README.md`
 * explains why that is a V2 question, and there is no `board_password` column
 * in `lib/db/schema.ts` to hold what a signup would produce. With no signup
 * there is no signup mail, so a wait for one could only ever time out.
 *
 * The `create-account` step is gone with it, and so is
 * `lib/account-creation-placeholder.ts`, the compile time stub JOB-001 pointed
 * it at. That file's own TODO asked to be deleted in the same change that
 * removed the step, and this is that change: the step could never have run,
 * because the stub threw unconditionally, so registering this function with
 * Inngest while it was still in the chain would have registered a function
 * guaranteed to fail on its first step.
 *
 * Underneath that is the rule the whole schema is shaped around: **skip and log,
 * do not pause and wait.** actinno parked a run at `awaiting_verification` and
 * left the row sitting there. Jobinno gives a run that cannot finish a terminal
 * status and a `skip_log` row saying why, and moves on. A listing behind a login
 * wall is not a run to keep alive; it is a listing this version cannot apply to,
 * recorded as `verification_required` and left for a human to read.
 *
 * **4. Events carry ids, not raw resume/LinkedIn/email strings.** A resume is a
 * bucket-qualified path into a *private* bucket, not a fetchable URL, and ACT-007
 * reads the object itself with the service-role client rather than being handed
 * a link. So the events carry `userId` and `jobId` and the steps that need
 * anything else look it up.
 *
 * The field is spelled `userId` and not the port's `candidateId`, which is
 * JOB-004 renaming a thing to what it already was. actinno minted its own
 * `candidates.id`; Jobinno has no such id. `profiles.id` is a foreign key onto
 * `auth.users.id`, the auth callback writes the row straight off the verified
 * session, and `applications.user_id` points back at it. The ported code's own
 * guard already described this value as "the same identity as ... the userId",
 * so the two names were one thing and now have one name.
 *
 * ── What this file does NOT do ──────────────────────────────────────────────
 * It never writes a *status*. It creates the `applications` row, because
 * something has to and the module that used to is not ported, and after that
 * every module in the chain writes its own status as it goes (`discovered` →
 * `filling_form` → `form_filled` → `submitted`). That row is the tracker; a
 * second writer would only ever disagree with it.
 *
 * It also does not decide *which* listings a person should apply to. JOB-008
 * owns matching. `discoverListings` below is the ported search, bridged onto
 * the `jobs` table so its fan-out produces rows that exist; it is a stopgap
 * that JOB-008 should replace rather than build on.
 */

// FIRST, and it has to stay first: the Inngest client below reads `INNGEST_DEV`
// at construction time. See `load-env.ts`.
import "./load-env";

import { Inngest, NonRetriableError, eventType, staticSchema } from "inngest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { claimApplicationRow } from "@/lib/application-records";
import { APPLICATION_STATUS } from "@/lib/application-status";
import { loadCandidate } from "@/lib/candidate-intake";
import { FormFillBlockedError } from "@/lib/fill-application-form";
import { InjectionSuspectedError } from "@/lib/resume-parser";
import {
  requiresCoverLetterFromQuestions,
  searchJobListings,
  type JobSearchPreferences,
} from "@/lib/search-job-listings";
import { browserConcurrencyLimit } from "@/lib/stagehand-session";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";
import { SubmissionBlockedError, submitApplication } from "@/lib/submit-application";

/**
 * The app id every function in this repository registers under.
 *
 * Still `actinno-job-agent`, and deliberately not renamed by JOB-004. Changing
 * an Inngest app id is not cosmetic: functions registered under a different id
 * are a different app, with their own dashboard, their own concurrency budget
 * and their own signing key, and any run in flight under the old id is orphaned
 * at the moment of the change. Renaming it is a deployment operation and wants
 * its own ticket rather than a line in a schema change.
 */
export const inngest = new Inngest({ id: "actinno-job-agent" });

const LOG = "[act-009]";

// ───────────────────────────────────
// Supabase
// ───────────────────────────────────

/**
 * Service-role client, matching every ported module in `lib/`. The guard is the
 * shared one JOB-002 lifted out of the four private copies.
 */
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
// Events
// ───────────────────────────────────

export const JOB_SEARCH_REQUESTED = "job-search/requested";
export const JOB_APPLICATION_REQUESTED = "job-application/requested";

/**
 * What starts a search.
 *
 * `userId` is `profiles.id`, which is `auth.users.id`. See the header.
 */
export type JobSearchRequestedData = {
  userId: string;
  /**
   * Optional, but less optional than it was.
   *
   * actinno fell back to `candidates.target_title`, `pay_min` and `locations`
   * when the event left them out. Jobinno's `profiles` has a column for exactly
   * one of those three: `target_locations`. So `title` and `payMin` now have no
   * stored fallback at all and must be supplied here if they are wanted, and a
   * search sent without a title searches every relevant listing on the named
   * boards. `CandidateRecord` in `lib/candidate-intake.ts` records that gap and
   * what closing it would take.
   */
  preferences: Partial<JobSearchPreferences> & { companies: string[] };
};

/**
 * One listing, one run.
 *
 * `jobId` is a `jobs.id`, not a listing object, and that is JOB-004's other
 * contract change. `applications.job_id` is a NOT NULL foreign key onto `jobs`,
 * so an application cannot exist for a listing the database has never seen —
 * which means an event carrying a hand-written listing could not be honoured
 * even in principle. The board sync (JOB-003) is what puts listings there, and
 * the matching ticket (JOB-008) is what will choose among them.
 */
export type JobApplicationRequestedData = {
  userId: string;
  jobId: string;
  /**
   * ACT-015. The candidate's own answers to questions a previous attempt could
   * not answer truthfully — work authorization, current country, and whatever
   * else a particular board asks that no stored fact covers.
   *
   * Optional, and additive on purpose: an event sent without it behaves exactly
   * as it did before. Its presence is what turns a run that stopped at
   * `form_fill_blocked` into one that finishes, without any state having been
   * kept in between — the caller asked the person, and re-sends the same event
   * with the answers attached.
   */
  additionalAnswers?: Record<string, string>;
};

// `staticSchema` gives the handlers real types without a runtime validation
// dependency. It is a passthrough at runtime, so the guards below are what
// actually reject a malformed event, and they do it with a message that names
// the contract that was broken rather than a schema path.
export const jobSearchRequested = eventType(JOB_SEARCH_REQUESTED, {
  schema: staticSchema<JobSearchRequestedData>(),
});
export const jobApplicationRequested = eventType(JOB_APPLICATION_REQUESTED, {
  schema: staticSchema<JobApplicationRequestedData>(),
});

// ───────────────────────────────────
// Event-payload guards
// ───────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A bad event never becomes a good event, so every rejection here is
 * `NonRetriableError`. Retrying a malformed payload just fills the dashboard
 * with identical failures and buries the one that explains them.
 */
function requireUuid(raw: unknown, field: string, what: string): string {
  const id = String(raw ?? "").trim();
  if (!UUID_RE.test(id)) {
    throw new NonRetriableError(
      `${field} must be ${what}, got ${JSON.stringify(raw)}.`
    );
  }
  return id;
}

/**
 * ACT-015 — the candidate's answers off the wire, shaped and bounded.
 *
 * An event can be hand-written, from the Inngest dev dashboard today and from
 * whatever fires these in anger later, so this is checked rather than trusted.
 * Bounded rather than validated: whether a key names a real field and whether a
 * value is a real option are questions only the live form can answer, and
 * ACT-007 asks them there. What this rules out is the shapes that are not
 * answers at all — non-strings, blanks, and a payload large enough to be
 * something other than a few replies.
 */
function normalizeAdditionalAnswers(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const trimmedKey = key.trim().slice(0, 200);
    const trimmedValue = value.trim().slice(0, 2_000);
    if (trimmedKey === "" || trimmedValue === "") continue;
    out[trimmedKey] = trimmedValue;
    if (Object.keys(out).length >= 40) break;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Failures that a retry cannot fix, re-thrown so Inngest stops instead of
 * launching three more browsers to be told the same thing.
 *
 * All three mean "a human has to look at this", and all three are raised *before
 * anything irreversible happens*: `FormFillBlockedError` and
 * `InjectionSuspectedError` come from ACT-007, which never submits anything at
 * all, and `SubmissionBlockedError` comes from ACT-008's pre-flight, which runs
 * before a browser is opened. The skip is already logged.
 *
 * Everything else propagates unchanged and stays retryable — which is safe for
 * the reason ACT-008 documents at the top of `submitApplication`: a rejected
 * promise from it *always* means nothing was clicked. A submission whose outcome
 * is unknown does not throw; it returns `submission_unconfirmed`.
 */
function rethrowTerminal(err: unknown): never {
  if (
    err instanceof SubmissionBlockedError ||
    err instanceof FormFillBlockedError ||
    err instanceof InjectionSuspectedError
  ) {
    throw new NonRetriableError(`${err.name}: ${err.message}`, { cause: err });
  }
  throw err;
}

// ───────────────────────────────────
// The listing, read back out of `jobs`
// ───────────────────────────────────

/** What a run needs about a listing that its own modules do not read for it. */
type ListingBrief = {
  jobId: string;
  company: string;
  title: string;
  applyUrl: string;
  requiresCoverLetter: boolean;
};

/**
 * One `jobs` row, with the employer name from the `boards` row behind it.
 *
 * `description` is not read. It is the largest column on the table and the only
 * consumer of it is the cover letter, which ACT-008 writes after reading the
 * same row itself. Reading it here would put kilobytes of scraped job text into
 * this run's durable step state to no end.
 *
 * `requiresCoverLetter` is derived here rather than stored, because there is no
 * column for it and adding one would be a migration that only Greenhouse could
 * ever populate. `jobs.raw` keeps the vendor's payload for exactly this kind of
 * question — a field the parse of the day did not extract — and
 * `requiresCoverLetterFromQuestions` is the same predicate the live search
 * applies, imported rather than copied. Every other platform reports false,
 * which is what it reported through the search path too: neither Lever's nor
 * Ashby's public API describes the application form at all.
 */
async function loadListing(supabase: SupabaseClient, jobId: string): Promise<ListingBrief> {
  const { data, error } = await supabase
    .from("jobs")
    .select("id,title,url,raw,boards!inner(company)")
    .eq("id", jobId)
    .limit(1);
  if (error) throw new Error(`jobs lookup failed: ${error.message}`);

  const row = data?.[0];
  if (!row) {
    throw new NonRetriableError(
      `No jobs row with id ${jobId}. Listings are written by the board sync (JOB-003); a ` +
        `job-application/requested event has to name one that exists.`
    );
  }

  const board = Array.isArray(row.boards) ? row.boards[0] : row.boards;
  const raw = (row.raw ?? {}) as Record<string, unknown>;

  const applyUrl = String(row.url ?? "").trim();
  try {
    // The https rule is inherited from ACT-005 and applied here so a bad URL
    // fails before a browser is launched.
    if (new URL(applyUrl).protocol !== "https:") {
      throw new NonRetriableError(`jobs ${jobId} has a non https url: ${applyUrl}`);
    }
  } catch (err) {
    if (err instanceof NonRetriableError) throw err;
    throw new NonRetriableError(`jobs ${jobId} has an unusable url: ${JSON.stringify(row.url)}`);
  }

  return {
    jobId,
    company: String((board as Record<string, unknown> | undefined)?.company ?? "").trim(),
    title: String(row.title ?? "").trim(),
    applyUrl,
    requiresCoverLetter: requiresCoverLetterFromQuestions(raw.questions),
  };
}

// ───────────────────────────────────
// 1. Discovery — one search, then fan out
// ───────────────────────────────────

export const discoverListings = inngest.createFunction(
  { id: "discover-listings", triggers: [{ event: jobSearchRequested }] },
  async ({ event, step }) => {
    const userId = requireUuid(event.data.userId, "userId", "a profiles.id UUID");
    const requested = event.data.preferences ?? { companies: [] };

    // Also the existence check. A `userId` that is a well-formed UUID but not a
    // real profile would otherwise survive discovery and fail N times over in N
    // fanned-out runs.
    //
    // Only the search preference comes back out of the step. The rest of the
    // record — the email, the resume path — is not needed here, and a step's
    // return value is durable state that outlives the run: there is no reason
    // for a person's details to exist in two systems when one of them was not
    // asked to hold them.
    const stored = await step.run("load-candidate", async () => ({
      locations: (await loadCandidate(userId)).locations,
    }));

    // `||` rather than `??` on purpose: an empty string or an empty array in the
    // event means "I did not specify this", and should fall through to the
    // person's own stored preference rather than override it with nothing.
    //
    // `title` and `payMin` have no stored fallback left to reach for. See
    // `JobSearchRequestedData`.
    const preferences: JobSearchPreferences = {
      companies: requested.companies ?? [],
      title: requested.title?.trim() || undefined,
      payMin: requested.payMin ?? undefined,
      locations: requested.locations?.length ? requested.locations : stored.locations ?? undefined,
      ...(requested.maxPerCompany === undefined ? {} : { maxPerCompany: requested.maxPerCompany }),
    };

    const listings = await step.run("bulk-search-job-boards", () =>
      searchJobListings(preferences)
    );

    // ── The bridge, and why it is a bridge (JOB-004) ────────────────────────
    //
    // `searchJobListings` reads the ATS platforms live and returns listing
    // objects. `applications.job_id` is a foreign key onto `jobs`, so a listing
    // that has no row there cannot be applied to, however real it is. The two
    // discovery paths in this repository are independent: the board sync writes
    // `jobs` from the same platforms on a schedule, and this reads them
    // directly, right now.
    //
    // So each listing is matched back to a `jobs` row by its apply URL, and the
    // ones with no match are counted and reported rather than dropped silently.
    // A high `unmatched` count is the signal that the sync has not run recently,
    // and it is far more useful surfaced than swallowed.
    //
    // This is a stopgap. Two independent discovery mechanisms is one too many,
    // and the right shape is for the matching ticket to select from `jobs`
    // rather than for this to reconcile against it.
    const resolved = await step.run("resolve-listings-to-jobs", async () => {
      const urls = [...new Set(listings.map((listing) => listing.applyUrl))];
      if (urls.length === 0) return { jobIds: [] as string[], unmatched: 0 };

      const supabase = getSupabaseClient();
      const { data, error } = await supabase.from("jobs").select("id,url").in("url", urls);
      if (error) throw new Error(`jobs lookup failed: ${error.message}`);

      const byUrl = new Map((data ?? []).map((row) => [String(row.url), String(row.id)]));
      const jobIds = urls.map((url) => byUrl.get(url)).filter((id): id is string => id !== undefined);
      return { jobIds, unmatched: urls.length - jobIds.length };
    });

    if (resolved.jobIds.length === 0) {
      console.warn(
        `${LOG} no known listings matched for ${userId} ` +
          `(boards: ${JSON.stringify(preferences.companies)}, ` +
          `title: ${JSON.stringify(preferences.title ?? "(any)")}) — ` +
          `${listings.length} found live, ${resolved.unmatched} of them absent from jobs. ` +
          `Run the board sync (npm run sync-boards) and try again.`
      );
      return { userId, discovered: listings.length, dispatched: 0, unmatched: resolved.unmatched };
    }

    console.log(
      `${LOG} ${resolved.jobIds.length} listing(s) for ${userId} → ` +
        `${resolved.jobIds.length} concurrent apply-to-job run(s), ` +
        `${browserConcurrencyLimit()} at a time` +
        (resolved.unmatched === 0 ? "" : ` (${resolved.unmatched} not in jobs, skipped)`)
    );

    // The fan-out. One event per listing; Inngest starts one run of `applyToJob`
    // per event and its `concurrency.limit` does the batching. The ids are
    // already distinct — `resolve-listings-to-jobs` de-duplicated the URLs — and
    // that matters: `claimApplicationRow` reuses the row for a (user, job) pair,
    // which is what makes its own retries safe, but `(user_id, job_id)` has no
    // unique index, so two *concurrent* runs on the same listing would both
    // insert and the tracker would show one listing twice.
    await step.sendEvent(
      "fan-out-applications",
      resolved.jobIds.map((jobId) => ({
        name: JOB_APPLICATION_REQUESTED,
        data: { userId, jobId } satisfies JobApplicationRequestedData,
      }))
    );

    return {
      userId,
      discovered: listings.length,
      dispatched: resolved.jobIds.length,
      unmatched: resolved.unmatched,
      companies: preferences.companies,
    };
  }
);

// ───────────────────────────────────
// 2. Apply — one listing, one run
// ───────────────────────────────────

export const applyToJob = inngest.createFunction(
  {
    id: "apply-to-job",
    triggers: [{ event: jobApplicationRequested }],
    // Listings in flight = browsers.
    //
    // ── Why this was 2, and why it is no longer a literal (JOB-005) ──────────
    //
    // The 2 was memory rather than taste. A 5-wide fan-out on an 8 GB machine
    // put the load average at 32 on 8 cores and pushed swap to 5 GB of 6 GB, at
    // which point Chrome does not fail cleanly — it stops answering CDP ("RPC
    // response timed out: page.title") or dies outright ("connect
    // ECONNREFUSED"). Four real applications were lost that way in one run,
    // none of them for any reason to do with the application itself. A headless
    // Chrome on a heavy ATS page is roughly 700 MB, and it shared that machine
    // with the Inngest processes, Claude Desktop and the user's own browser.
    // Two fit. Five did not.
    //
    // Every sentence of that is about one 8 GB laptop's RAM. JOB-005 moved the
    // browsers to Browserbase when its credentials are set, and a remote
    // session uses none of this machine's memory, so the binding constraint
    // stops being the host and becomes the Browserbase plan's own cap on
    // concurrent sessions. `browserConcurrencyLimit()` reports whichever of the
    // two is actually in force, which is why the number is read rather than
    // written: the same code has to be correct on the laptop and on the remote
    // fleet, and the incident above says what happens when it is not.
    //
    // Remote, that comes out at 3 today. Not an estimate:
    // `GET /v1/projects/{id}` on the live Jobinno project answers
    // `"concurrency": 3`, and asking for a fourth session gets a refusal rather
    // than a queue slot. `BROWSERBASE_CONCURRENCY` raises it without a code
    // change on the day the plan does, and it should be revisited against real
    // usage once there is some: 3 is the ceiling the plan imposes, not
    // necessarily the width this pipeline wants to run at.
    //
    // The launch semaphore in `stagehand-session.ts` reads the same number but
    // solves a different problem — simultaneous cold starts — and does not help
    // once the browsers are all resident. This is the limit that holds the line.
    concurrency: { limit: browserConcurrencyLimit() },
    // Below Inngest's default of 4, because a retry here is not free: each one
    // relaunches a browser against a real employer's site. Two is enough for the
    // failures retrying actually fixes (a flaky navigation, a Supabase blip) and
    // stops well short of hammering a board that is simply refusing us.
    retries: 2,
  },
  async ({ event, step }) => {
    const userId = requireUuid(event.data.userId, "userId", "a profiles.id UUID");
    const jobId = requireUuid(event.data.jobId, "jobId", "a jobs.id UUID");
    // ACT-015. Passed through untouched: these are the candidate's own words,
    // and every check that matters — does this key name a field on the form, is
    // this value one of that control's options — can only be made against the
    // live page, which is ACT-007's job and not this file's.
    const additionalAnswers = normalizeAdditionalAnswers(event.data.additionalAnswers);

    // ── Claim the row ────────────────────────────────────────────────────────
    // Safe to retry: `claimApplicationRow` reuses the row for this (user, job)
    // pair instead of inserting a second one, and refuses outright to hand back
    // a row that has already had a submit click issued against it.
    //
    // This is also where the two guards that gate a real application live — the
    // person has attested to their intake, and they have applications left on
    // their plan. See that function for why both are checked there rather than
    // here.
    const claim = await step.run("claim-application-row", async () => {
      const supabase = getSupabaseClient();
      const listing = await loadListing(supabase, jobId);
      const claimed = await claimApplicationRow(supabase, { userId, jobId });
      // Only ids and strings cross the boundary, and the description is left
      // behind: `jobs.description` runs to kilobytes, ACT-008 re-reads it from
      // the row a moment later, and a step's return value is durable state that
      // Inngest stores and replays on every subsequent step of this run.
      return {
        applicationId: claimed.applicationId,
        created: claimed.created,
        company: listing.company,
        title: listing.title,
        applyUrl: listing.applyUrl,
        requiresCoverLetter: listing.requiresCoverLetter,
      };
    });

    const applicationId = claim.applicationId;
    const summary = { company: claim.company, title: claim.title, applyUrl: claim.applyUrl };

    console.log(
      `${LOG} applications ${applicationId} — ${claim.company} / ${claim.title} ` +
        `(${claim.created ? "new" : "reusing existing row"})`
    );

    // ── ACT-008, which calls ACT-007 inside it. ONE step, one browser ────────
    // See correction 2 in the header: `submitApplication` fills the form via
    // `fillApplicationFormRetainingSession` and submits in that same session.
    // Splitting this in two would fill a form in a browser that is then closed.
    const submission = await step.run("fill-and-submit-application", async () => {
      try {
        const result = await submitApplication({
          jobApplicationId: applicationId,
          requiresCoverLetter: claim.requiresCoverLetter,
          // Deliberately not passed. ACT-008's `preflight` reads
          // `jobs.description` off the row it already loads, which keeps up to
          // 8KB of scraped job text out of this run's durable step state. The
          // claim step drops it for the same reason.
          ...(additionalAnswers === undefined ? {} : { additionalAnswers }),
        });
        // Trimmed for the same reason as the claim: the full result nests
        // ACT-007's entire field-by-field report and the parsed resume profile —
        // a candidate's real personal data, which has no business being copied
        // into durable step state that outlives the run.
        return {
          status: result.status,
          submitted: result.submitted,
          submitAttempted: result.submitAttempted,
          confirmationRef: result.confirmationRef,
          submitControlLabel: result.submitControlLabel,
          blockedReason: result.blockedReason,
          unconfirmedReason: result.unconfirmedReason,
          screenshotPath: result.screenshotPath,
          rowUpdated: result.rowUpdated,
          finalUrl: result.finalUrl,
        };
      } catch (err) {
        rethrowTerminal(err);
      }
    });

    if (submission.status === APPLICATION_STATUS.SUBMISSION_UNCONFIRMED) {
      // The loudest thing this pipeline can say. ACT-008 has already recorded it
      // and refused to retry; this makes it visible in the run list too.
      console.error(
        `${LOG} ══ ${claim.company} / ${claim.title}: SUBMIT CLICKED, OUTCOME UNKNOWN ══\n` +
          `${LOG} applications ${applicationId} — do NOT re-run this listing until a human ` +
          `has checked the employer's side. ${submission.unconfirmedReason ?? ""}`
      );
    } else {
      console.log(
        `${LOG} ${claim.company} / ${claim.title} → ${submission.status}` +
          (submission.confirmationRef === null ? "" : ` (${submission.confirmationRef})`)
      );
    }

    return {
      applicationId,
      jobId,
      status: submission.status,
      submitted: submission.submitted,
      confirmationRef: submission.confirmationRef,
      listing: summary,
      needsHuman:
        submission.status !== APPLICATION_STATUS.SUBMITTED || submission.rowUpdated === false,
    };
  }
);

/**
 * The functions this module contributes to the serve route.
 *
 * The board sync is deliberately not in this list. It lives in `board-sync.ts`,
 * imports the client from here, and adding it here as well would be a circular
 * import. `app/api/inngest/route.ts` is the one place that knows about both.
 */
export const functions = [discoverListings, applyToJob];
