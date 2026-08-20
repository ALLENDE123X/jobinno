/**
 * ACT-009 — the orchestration layer. Two Inngest functions, wired to the real
 * ACT-002 through ACT-008 modules and, since JOB-004, to Jobinno's own schema.
 *
 *   1. discoverListings — ONE match against the synced `jobs` table per
 *                         request, runs once. Since JOB-008 it selects rather
 *                         than searches; see its own header.
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
 * It also does not decide *which* listings a person should apply to on its own
 * any more. JOB-008 moved that into `lib/job-matching.ts`, and what is left
 * here is the orchestration: ask that module what matched, fan out one event
 * per answer. The ported live search this used to call, and the URL
 * reconciliation that bridged it onto `jobs`, are both gone — that code called
 * itself a stopgap and this is the ticket it named.
 *
 * ── What sends the events ───────────────────────────────────────────────────
 * `lib/job-search-trigger.ts` and, on a schedule,
 * `inngest/job-search-schedule.ts`. Before JOB-008 nothing sent
 * `job-search/requested` at all, anywhere, which is a failure mode worth naming
 * because it is silent: a registered Inngest function with no trigger type
 * checks, lints, tests, deploys and never runs.
 */

// FIRST, and it has to stay first: the Inngest client below reads `INNGEST_DEV`
// at construction time. See `load-env.ts`.
import "./load-env";

import { Inngest, NonRetriableError, eventType, staticSchema } from "inngest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  releaseApplicationSlot,
  reserveApplicationSlot,
} from "@/lib/application-quota";
import { claimApplicationRow } from "@/lib/application-records";
import { APPLICATION_STATUS } from "@/lib/application-status";
import { FormFillBlockedError } from "@/lib/fill-application-form";
import {
  fanOutLimit,
  loadMatchProfile,
  matchJobsForUser,
  remainingAllowance,
  searchBlockedReason,
  type MatchPreferences,
} from "@/lib/job-matching";
import { InjectionSuspectedError } from "@/lib/resume-parser";
import { requiresCoverLetterFromQuestions } from "@/lib/search-job-listings";
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
   * Optional, and every field inside it optional too (JOB-008).
   *
   * ── What this used to be, and why it shrank ───────────────────────────────
   * It was `Partial<JobSearchPreferences> & { companies: string[] }`: the live
   * ATS search's own preference type, because the handler used to run that
   * search. It no longer does. Matching selects from `jobs`, so the event may
   * only carry things `jobs` can actually be matched on, and the type is that
   * list rather than a wider one whose extra fields would be quietly dropped.
   *
   * Three changes fall out of that:
   *
   *  · `companies` is optional now, and an event with none means every active
   *    board rather than no boards. The old required array made sense when each
   *    entry was a board API about to be read live; against a synced registry
   *    the useful default is "all of it".
   *  · `payMin` is gone. There is no compensation column on `jobs` and no
   *    reliable compensation field across the platforms that fill it — see
   *    `lib/job-matching.ts` and `JobSearchPreferences`'s own note. It is
   *    removed rather than accepted and ignored, so that nothing can send a pay
   *    floor and believe it was applied.
   *  · `maxPerCompany` is gone with it, for a plainer reason: it was a cap on
   *    how many listings one live board read could contribute, and there is no
   *    per board read any more. The fan out is capped by the person's remaining
   *    allowance instead.
   *
   * `title` survives as a substring filter over `jobs.title` and nothing more.
   * `locations` overrides `profiles.target_locations` for one search.
   */
  preferences?: MatchPreferences;
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
// 1. Discovery — match against `jobs`, then fan out
// ───────────────────────────────────

/**
 * JOB-008 replaced the body of this function outright.
 *
 * It used to call `searchJobListings`, read the ATS platforms live, and then
 * reconcile what came back to `jobs` rows by apply URL, dropping every listing
 * the board sync had not written yet and logging the count as "unmatched". The
 * comment on that code called it a stopgap and named this ticket as the fix.
 *
 * It now selects from `jobs` joined to `boards`, which is the table JOB-003's
 * sync exists to fill. Three consequences worth stating, because each was a
 * real defect in the old shape rather than an inefficiency:
 *
 *  · **A search no longer reads sixty three employers' APIs to answer one
 *    person.** The sync reads them four times a day for everybody.
 *  · **A repeated search is idempotent.** The match excludes any listing this
 *    person already has an `applications` row for, so running it twice does not
 *    fan out a second run at a listing already in flight, already blocked, or
 *    already submitted. The old path had no such exclusion at all: it would
 *    re-dispatch everything it found, every time.
 *  · **The fan out is bounded by what the person can actually spend.** See
 *    `fanOutLimit`.
 */
export const discoverListings = inngest.createFunction(
  {
    id: "discover-listings",
    triggers: [{ event: jobSearchRequested }],
    // One discovery run per person at a time, keyed on the person.
    //
    // Two `job-search/requested` events for the same user — a double click on a
    // "Find Jobs Now" button, a retry racing the original, the cron overlapping
    // a manual trigger — both reach the anti join below before either has
    // written an `applications` row. Both therefore match the same listings,
    // and both fan out. `(user_id, job_id)` has no unique index, as the fan-out
    // comment further down says, so the second run's `claimApplicationRow`
    // inserts a second row rather than reusing the first, and the employer
    // receives two real applications for one listing.
    //
    // The key is what makes this a guard rather than a bottleneck: `limit: 1`
    // alone would serialize every user in the system behind one run. Inngest
    // queues the second event rather than dropping it, which is the behaviour
    // wanted — by the time it runs, the first run's rows exist and the anti
    // join excludes exactly the listings already in flight.
    //
    // `scheduleJobSearches` keeps its own six hour in-flight window and the two
    // do not conflict: that window decides who is dispatched at all, a whole
    // cron run ahead of this, and cannot see a run whose rows do not exist yet.
    // This closes the gap it structurally cannot.
    concurrency: { limit: 1, key: "event.data.userId" },
  },
  async ({ event, step }) => {
    const userId = requireUuid(event.data.userId, "userId", "a profiles.id UUID");
    const preferences = event.data.preferences;

    // One step, and everything it needs read inside it. The allowance in
    // particular has to be read here rather than passed in or remembered: it
    // moves under this function from two directions at once — every `applyToJob`
    // run reserves and settles against it, and JOB-010's Stripe webhook resets
    // it the moment somebody pays.
    //
    // Only the ids and the counts come back out. A step's return value is
    // durable state that outlives the run, and there is no reason for a list of
    // job titles to be stored twice.
    const matched = await step.run("match-jobs", async () => {
      const profile = await loadMatchProfile(userId);
      if (!profile) {
        // A well formed UUID that names nobody. This is also the existence
        // check the old `load-candidate` step did, and it is worth doing here
        // for the same reason: without it the failure happens N times over, in
        // N fanned out runs, instead of once.
        throw new NonRetriableError(
          `No profiles row with id ${userId}. A profile is created by signing in; see ` +
            `app/auth/callback/route.ts.`
        );
      }

      // Attestation and a resume, checked once here rather than N times in N
      // fanned out runs. The live search this replaced had the same property by
      // accident: it called `loadCandidate`, which threw on either. Neither
      // improves by being retried, so neither is retried.
      const blocked = searchBlockedReason(profile);
      if (blocked !== null) {
        throw new NonRetriableError(`No search for ${userId}: ${blocked}`);
      }

      const remaining = remainingAllowance(profile);
      if (remaining <= 0) {
        return {
          jobIds: [] as string[],
          remaining,
          limit: 0,
          cap: profile.applicationsCap,
          used: profile.applicationsUsed,
        };
      }

      const limit = fanOutLimit(remaining);
      const matches = await matchJobsForUser({ userId, profile, preferences, limit });

      // Logged in here, where the titles are already in memory, rather than
      // returned so the caller can log them.
      for (const match of matches) {
        console.log(
          `${LOG} match for ${userId}: ${match.company} / ${match.title}` +
            (match.location === null ? "" : ` (${match.location})`)
        );
      }

      return {
        jobIds: matches.map((match) => match.jobId),
        remaining,
        limit,
        cap: profile.applicationsCap,
        used: profile.applicationsUsed,
      };
    });

    if (matched.remaining <= 0) {
      console.warn(
        `${LOG} no search for ${userId}: ${matched.used} of ${matched.cap} applications used. ` +
          `A cap of zero is the default and means this account has not been provisioned to ` +
          `apply yet.`
      );
      return { userId, remaining: 0, matched: 0, dispatched: 0 };
    }

    if (matched.jobIds.length === 0) {
      console.warn(
        `${LOG} nothing matched for ${userId} ` +
          `(boards: ${JSON.stringify(preferences?.companies ?? "(any)")}, ` +
          `title: ${JSON.stringify(preferences?.title ?? "(any)")}, ` +
          `locations: ${JSON.stringify(preferences?.locations ?? "(from profile)")}). ` +
          `Either the board sync has not run (try npm run sync-boards) or every listing ` +
          `that matched already has an applications row for this person.`
      );
      return { userId, remaining: matched.remaining, matched: 0, dispatched: 0 };
    }

    console.log(
      `${LOG} ${matched.jobIds.length} listing(s) for ${userId} → ` +
        `${matched.jobIds.length} concurrent apply-to-job run(s), ` +
        `${browserConcurrencyLimit()} at a time ` +
        `(${matched.remaining} application(s) left, ceiling ${matched.limit})`
    );

    // The fan-out. One event per listing; Inngest starts one run of `applyToJob`
    // per event and its `concurrency.limit` does the batching. The ids are
    // distinct by construction — they are primary keys off one select — and that
    // matters: `claimApplicationRow` reuses the row for a (user, job) pair,
    // which is what makes its own retries safe, but `(user_id, job_id)` has no
    // unique index, so two *concurrent* runs on the same listing would both
    // insert and the tracker would show one listing twice.
    await step.sendEvent(
      "fan-out-applications",
      matched.jobIds.map((jobId) => ({
        name: JOB_APPLICATION_REQUESTED,
        data: { userId, jobId } satisfies JobApplicationRequestedData,
      }))
    );

    return {
      userId,
      remaining: matched.remaining,
      matched: matched.jobIds.length,
      dispatched: matched.jobIds.length,
      limit: matched.limit,
    };
  }
);

// ───────────────────────────────────
// The plan allowance
// ───────────────────────────────────

/**
 * Gives the reserved slot back, unless the row says an application really was
 * sent. See `lib/application-quota.ts` for why the decision is one statement.
 *
 * Never throws, and that is the whole point of it existing here rather than
 * being called inline. It runs on two paths — after a run that finished and
 * after one that failed — and on both, an accounting problem is the less
 * important of the two things happening. Throwing on the failure path would
 * replace the error that explains the run with one about a counter, and
 * throwing on the success path would fail a run whose application is already
 * with an employer. So it reports and returns.
 */
async function settleApplicationSlot(userId: string, applicationId: string) {
  try {
    const settled = await releaseApplicationSlot({ userId, applicationId });

    if (settled.outcome === "released") {
      console.log(
        `${LOG} applications ${applicationId} — nothing was submitted, allowance ` +
          `returned (${settled.used} used)`
      );
    } else if (settled.outcome === "kept") {
      console.log(
        `${LOG} applications ${applicationId} — ${settled.status}, allowance spent`
      );
    }

    return settled;
  } catch (err) {
    // A leaked slot costs this person one application off their allowance and
    // nothing else. Loud, because nothing else will ever notice it.
    console.error(
      `${LOG} applications ${applicationId} — COULD NOT SETTLE THE ALLOWANCE for ${userId}. ` +
        `A reserved application slot has leaked and profiles.applications_used is one too ` +
        `high. ${err instanceof Error ? err.message : String(err)}`
    );
    return { outcome: "settle_failed" as const };
  }
}

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
    // This is also where the attestation guard lives — nothing may be submitted
    // on behalf of somebody who has never confirmed their intake is true — plus
    // a cheap look at the allowance so that a person with nothing left is
    // refused before a browser is launched. The allowance is not *enforced*
    // there; `reserve-application-slot` below is what enforces it, for the
    // reason given on that step.
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

    // ── Take the application off the plan's allowance ───────────────────────
    // This is the cap, and it is enforced here rather than in the claim above
    // because a cap can only be enforced while refusing is still possible —
    // which is to say before a browser opens, not after a submit control has
    // been pressed. `reserveApplicationSlot` is one conditional UPDATE, so the
    // `browserConcurrencyLimit()` runs this person has in flight at once cannot
    // between them take a 150th and a 151st slot: the second statement finds no
    // row to update and comes back refused.
    //
    // Its own step, so that Inngest memoizes it. A retry of the submit below
    // replays this from state instead of re-running it, which is what stops one
    // listing spending two applications.
    //
    // The claim step's check reads the same two columns and is deliberately not
    // this. It is there to refuse a person with nothing left before any of the
    // above costs anything; this is what the product's promise actually rests
    // on.
    const reservation = await step.run("reserve-application-slot", async () => {
      const outcome = await reserveApplicationSlot(userId);

      if (outcome.reserved) return { used: outcome.used, cap: outcome.cap };

      // Neither refusal improves by being retried. The cap moves when somebody
      // pays, which is a Stripe webhook and not this run, and a missing profile
      // is a broken event rather than a slow one.
      if (outcome.reason === "no_profile") {
        throw new NonRetriableError(
          `No profiles row with id ${userId}, so there is no allowance to apply against.`
        );
      }

      throw new NonRetriableError(
        `Profile ${userId} has used ${outcome.used} of ${outcome.cap} applications, so ` +
          `${claim.company} / ${claim.title} was not opened. A cap of zero is the default and ` +
          `means this account has not been provisioned to apply yet, not that it may apply ` +
          `without limit.`
      );
    });

    console.log(
      `${LOG} applications ${applicationId} — allowance ${reservation.used} of ` +
        `${reservation.cap} reserved`
    );

    // ── ACT-008, which calls ACT-007 inside it. ONE step, one browser ────────
    // See correction 2 in the header: `submitApplication` fills the form via
    // `fillApplicationFormRetainingSession` and submits in that same session.
    // Splitting this in two would fill a form in a browser that is then closed.
    const fillAndSubmit = () =>
      step.run("fill-and-submit-application", async () => {
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

    // ── Settle the allowance, whichever way the run went ─────────────────────
    // A reservation that did not turn into an application goes back, and that
    // is what makes a blocked form, a dead board and a captcha free — which the
    // old lifetime row count, with no status filter on it, did not.
    //
    // `settleApplicationSlot` decides from the `applications` row: `submitted`
    // and `submission_unconfirmed` keep the slot, everything else gives it back.
    // Both mean a submit control was pressed, and an unknown outcome has to be
    // charged for, because the alternative is refunding an application that may
    // be sitting in an employer's inbox.
    //
    // The `catch` runs after the submit step has exhausted the function's
    // retries — Inngest throws a `StepError` into the body at that point — so a
    // run that ends in an exception still settles before the error propagates.
    // Its own step name so that the two paths cannot both be memoized.
    let submission: Awaited<ReturnType<typeof fillAndSubmit>>;
    try {
      submission = await fillAndSubmit();
    } catch (error) {
      await step.run("settle-application-slot-after-failure", () =>
        settleApplicationSlot(userId, applicationId)
      );
      throw error;
    }

    // On this path the run knows one thing the row may not. `rowUpdated: false`
    // means ACT-008 pressed the control and then could not write the status
    // down, so the row can still say `form_filled` while an application really
    // is with the employer — and a refund decided from the row alone would hand
    // the allowance back for it. Any sign of a click from this run keeps the
    // slot, and the row is only consulted when there was none.
    const clicked =
      submission.submitAttempted ||
      submission.submitted ||
      submission.status === APPLICATION_STATUS.SUBMITTED ||
      submission.status === APPLICATION_STATUS.SUBMISSION_UNCONFIRMED;

    if (clicked) {
      console.log(
        `${LOG} applications ${applicationId} — submit control pressed, allowance spent`
      );
    } else {
      await step.run("settle-application-slot", () =>
        settleApplicationSlot(userId, applicationId)
      );
    }

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
