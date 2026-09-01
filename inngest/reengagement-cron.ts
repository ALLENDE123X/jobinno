/**
 * JOB-311 — the 24h re engagement email cron.
 *
 * Aryareed, the first real cold traffic Meta ad signup, bounced out of intake
 * before attesting and never came back. Nothing in the product noticed or did
 * anything about it: a profile can sit unattested forever and nobody hears
 * from Jobinno again. This is the fix, one hour at a time: find every profile
 * that signed up between a day and a week ago, is still unattested, and has
 * never been sent this email, then send it, from the founder, with a real
 * reply address behind it.
 *
 * ── The window, and why it has two ends ──────────────────────────────────
 * `attested_at IS NULL` is the whole of "did not finish", the same signal
 * `lib/job-matching.ts` reads for a different purpose. The two sided window
 * on `created_at` is what keeps this from firing at the wrong times: the
 * lower bound (24h) gives a person who is mid intake right now, or asleep and
 * finishing it in the morning, the length of a full day before Jobinno starts
 * emailing them about having stepped away; the upper bound (7 days) is a
 * quiet cutoff rather than a second, colder email, because a signup that is a
 * week old and still unattested is not "about to finish" and this cron does
 * not send a second message chasing them further.
 *
 * `re_engagement_sent_at IS NULL` is the idempotency guard, and it is a
 * column rather than a rolling counter for the same reason
 * `escalation_notified_at` is in `lib/notifier.ts`: two overlapping runs
 * reading the same row both see the stamp once either of them has written it,
 * so at most one send survives even without a lock.
 *
 * ── Batch size ────────────────────────────────────────────────────────────
 * At most 50 profiles a run, per the ticket. Sized as a rate limit on how
 * many founder personal emails go out in one hour rather than as a
 * performance concern: this table is nowhere near large enough for the query
 * itself to need a limit.
 *
 * ── Dry run ───────────────────────────────────────────────────────────────
 * `RE_ENGAGEMENT_DRY_RUN=true` logs every candidate this run would have
 * emailed and stops there: no Resend call, no stamp written. This is what the
 * ticket's acceptance check runs against production with before the cron is
 * ever allowed to actually send anything.
 *
 * ── Reachable from `app/api/inngest/route.ts` ────────────────────────────
 * The ticket names `inngest/index.ts` as the file that registers this
 * function; that file does not exist in this repository; every other cron
 * here (`sync-job-boards`, `schedule-job-searches`) is registered in
 * `app/api/inngest/route.ts` instead, which is where this one is registered
 * too. See that file's own header for why a cron unregistered there has no
 * schedule at all.
 */

// The pipeline's first import is `./load-env`, so importing the client from it
// keeps the ordering that file's header depends on.
import { inngest } from "./job-application-pipeline";

import { and, between, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";
import {
  buildReEngagementIdempotencyKey,
  redactEmail,
  sendReEngagementEmail,
} from "@/lib/reengagement/email";
import { buildReEngagementEmail } from "@/lib/reengagement/template";

// Every hour, on the hour. Described in words here rather than in a block
// comment: HARD STOP 4 in CLAUDE.md is exactly a cron expression closing a
// block comment early.
const REENGAGEMENT_CRON = "0 * * * *";

/** How recently a profile must have signed up to still be worth emailing. */
export const REENGAGEMENT_WINDOW_MIN_HOURS = 24;
/** How long ago is too long ago to bother; see the header for why this is a cutoff and not a second email. */
export const REENGAGEMENT_WINDOW_MAX_DAYS = 7;
/** At most this many sends per run. */
export const REENGAGEMENT_BATCH_LIMIT = 50;
/**
 * JOB-321. The upper bound on how many times a candidate's row will cycle
 * back through this cron after a Resend rejection before the stamp is left
 * on the row terminally, taking it out of the query for good.
 *
 * Three, on the reasoning three failures across three hours is long enough
 * to distinguish a transient Resend blip (rate limit, one 5xx, a network
 * flake) from a permanent condition (rotated key, bounced address) that
 * no amount of automatic retrying is going to move. Beyond that a human
 * has to look, and the row goes on sitting `re_engagement_sent_at` stamped
 * with `re_engagement_send_failures >= 3` to say why.
 */
export const REENGAGEMENT_MAX_SEND_FAILURES = 3;

export type ReEngagementDatabase = ReturnType<typeof db>;

export type ReEngagementCandidate = {
  id: string;
  email: string;
};

/**
 * Everyone due for the 24h re engagement email right now. See the module
 * header for what each condition excludes and why.
 *
 * `limit` defaults to `REENGAGEMENT_BATCH_LIMIT` and exists as its own
 * parameter, rather than only as the hardcoded default, so a test can pin the
 * cap to something small and prove the LIMIT clause is really there without
 * inserting fifty live fixture rows to do it. The cron itself never overrides
 * it.
 */
export async function listReEngagementCandidates(
  database: ReEngagementDatabase = db(),
  now: Date = new Date(),
  limit: number = REENGAGEMENT_BATCH_LIMIT
): Promise<ReEngagementCandidate[]> {
  const windowStart = new Date(
    now.getTime() - REENGAGEMENT_WINDOW_MAX_DAYS * 24 * 60 * 60 * 1000
  );
  const windowEnd = new Date(now.getTime() - REENGAGEMENT_WINDOW_MIN_HOURS * 60 * 60 * 1000);

  const rows = await database
    .select({ id: profiles.id, email: profiles.email })
    .from(profiles)
    .where(
      and(
        isNull(profiles.attestedAt),
        isNull(profiles.reEngagementSentAt),
        between(profiles.createdAt, windowStart, windowEnd)
      )
    )
    .orderBy(profiles.createdAt)
    .limit(limit);

  return rows;
}

/** `RE_ENGAGEMENT_DRY_RUN=true`, case and whitespace tolerant. Anything else, including unset, is a real run. */
function isDryRun(): boolean {
  return (process.env.RE_ENGAGEMENT_DRY_RUN ?? "").trim().toLowerCase() === "true";
}

/**
 * Attempts to claim one profile for sending, atomically. Stamps
 * `re_engagement_sent_at` only if the profile is still unattested and not
 * already stamped at the moment this statement runs, exactly the same
 * conditional update shape `claimSearchSlot` in `lib/search-cooldown.ts`
 * uses for the same reason: a plain read followed by a separate write can
 * always go stale between the two, and a single `UPDATE ... WHERE ...
 * RETURNING` cannot, since Postgres evaluates the WHERE clause and performs
 * the write in one atomic step.
 *
 * Exported, rather than kept inline in the send step below, so this
 * statement can be tested directly against a real database without also
 * standing up an Inngest step around it, the same reasoning
 * `listReEngagementCandidates` above gives for its own `limit` parameter.
 *
 * Returns the claimed row's id and current email on success, or `null` when
 * the claim raced a concurrent stamp or an attestation that landed since the
 * candidate was selected in `list-candidates`. A `null` result means nothing
 * should be sent.
 */
export async function claimReEngagementSend(
  database: ReEngagementDatabase,
  candidateId: string,
  now: Date = new Date()
): Promise<ReEngagementCandidate | null> {
  const [claimed] = await database
    .update(profiles)
    .set({ reEngagementSentAt: now })
    .where(
      and(
        eq(profiles.id, candidateId),
        isNull(profiles.attestedAt),
        isNull(profiles.reEngagementSentAt)
      )
    )
    .returning({ id: profiles.id, email: profiles.email });

  return claimed ?? null;
}

/**
 * JOB-321. The compensating half of `claimReEngagementSend`.
 *
 * A send that failed after a successful claim left the row stamped and
 * unemailed before this function existed, and the next hour's cron would
 * refuse to pick it up again because the WHERE clause on `re_engagement_sent_at
 * IS NULL` excluded it. That was the whole of the gap the JOB-311 red team
 * flagged: a rotated Resend key, a bounced address, a network blip, all
 * looked identical to a successful send at the database level, and every
 * one of them silently lost the candidate.
 *
 * The shape of this UPDATE follows `reserveApplicationSlot` and
 * `releaseApplicationSlot` in `lib/application-quota.ts`, and for the same
 * reason: a plain read of the failure counter followed by a separate write
 * has a window in it that two overlapping runs can both walk through and
 * both write "one more failure", so this is one statement — Postgres
 * evaluates the CASE against the new incremented value and either unstamps
 * the row (retry on the next hour) or leaves the stamp in place (terminal
 * fail), atomically, on the row lock. `claimReEngagementSend` re acquires
 * the row the ordinary way on the next hour if this call unstamped it, so
 * no follow up state has to survive across the boundary.
 *
 * The CASE expression takes the new value (`re_engagement_send_failures +
 * 1`, evaluated against the OLD row per Postgres UPDATE semantics) and
 * compares it to `REENGAGEMENT_MAX_SEND_FAILURES`. Below the cap the
 * stamp is cleared and the row becomes eligible again; at or above the
 * cap the stamp is preserved so the WHERE clause on
 * `listReEngagementCandidates` refuses it forever, and the failure counter
 * on the row records why. `authenticated` can never hit either path
 * regardless of what happens here: the two columns are UPDATE-locked to
 * `service_role` in
 * `drizzle/0030_profiles_re_engagement_sent_at_privileges.sql` and
 * `drizzle/0032_profiles_re_engagement_send_failures_privileges.sql`.
 *
 * Exported for the same reason `claimReEngagementSend` above is: a live
 * test can hit it directly against a real database without also standing
 * up an Inngest step around it.
 *
 * Returns which outcome landed so the caller's log line can tell a
 * transient failure from a terminal one, and returns `null` when the row
 * did not exist to be released (which would be a bug in the cron rather
 * than an operating condition; logged loudly and moved past regardless).
 */
export type ReleaseOutcome =
  | { released: true; failures: number; terminal: false }
  | { released: false; failures: number; terminal: true }
  | { released: false; failures: 0; terminal: false; reason: "no_profile" };

export async function releaseReEngagementSlot(
  database: ReEngagementDatabase,
  candidateId: string,
  maxFailures: number = REENGAGEMENT_MAX_SEND_FAILURES
): Promise<ReleaseOutcome> {
  const [row] = await database
    .update(profiles)
    .set({
      reEngagementSendFailures: sql`${profiles.reEngagementSendFailures} + 1`,
      // `re_engagement_sent_at` clears on the same statement when the
      // incremented counter is still under the cap. Above the cap the
      // stamp stays, which is what turns the WHERE clause on
      // `listReEngagementCandidates` into the terminal state; see the
      // function docstring above for why this is one UPDATE rather than a
      // read then a write.
      reEngagementSentAt: sql`case when ${profiles.reEngagementSendFailures} + 1 >= ${maxFailures} then ${profiles.reEngagementSentAt} else null end`,
      updatedAt: new Date(),
    })
    .where(eq(profiles.id, candidateId))
    .returning({
      failures: profiles.reEngagementSendFailures,
      stamp: profiles.reEngagementSentAt,
    });

  if (!row) {
    // The candidate id came from `list-candidates` in the same run, so this
    // is a bug rather than an operating condition. Reported so the outer
    // log line can say what happened, and moved past.
    return { released: false, failures: 0, terminal: false, reason: "no_profile" };
  }

  const terminal = row.failures >= maxFailures;
  return terminal
    ? { released: false, failures: row.failures, terminal: true }
    : { released: true, failures: row.failures, terminal: false };
}

export const reengagementCron = inngest.createFunction(
  {
    id: "reengagement-cron",
    triggers: [{ cron: REENGAGEMENT_CRON }],
    // One run at a time. Two overlapping runs would both read the same
    // candidates before either had written a stamp, and both would send.
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    // Only the id and email cross the step boundary. Neither is trusted as
    // still eligible by the time the send step below runs: a candidate here
    // can attest, or get claimed by a concurrent run, in the gap between this
    // step and that one. The send step re checks eligibility itself with a
    // conditional claim rather than assuming this list is still accurate.
    const candidates = await step.run("list-candidates", () => listReEngagementCandidates());

    if (candidates.length === 0) {
      console.log("[job-311] nobody due for a re engagement email this hour.");
      return { due: 0, sent: 0 };
    }

    const dryRun = isDryRun();
    let sentCount = 0;

    for (const candidate of candidates) {
      const outcome = await step.run(`send-${candidate.id}`, async () => {
        if (dryRun) {
          console.log(`[job-311] dry run: would send to ${redactEmail(candidate.email)} (${candidate.id})`);
          return { sent: false };
        }

        // Conditional atomic claim, done before any send. A candidate who
        // attested, or who a concurrent run already stamped, between
        // `list-candidates` and here no longer matches `claimReEngagementSend`'s
        // WHERE clause, so it returns `null` and nothing is sent: this is
        // what closes the stale eligibility race the plain re read approach
        // in the list step above cannot close on its own, since a plain read
        // can still go stale again before the send that follows it.
        //
        // Claiming before sending, rather than after, also means a send that
        // fails partway through never leaves a profile stamped but unemailed
        // with no way to tell them apart from one that is stamped and really
        // was sent: this cron does not retry a claimed row automatically
        // (see the warning below), so `buildReEngagementIdempotencyKey` gives
        // any deliberate, ops driven retry against Resend a safe key to
        // replay with instead.
        const claimedCandidate = await claimReEngagementSend(db(), candidate.id);

        if (claimedCandidate === null) {
          console.log(`[job-311] skipped ${candidate.id}: no longer eligible, raced by attestation or another run.`);
          return { sent: false, reason: "raced" as const };
        }

        const { subject, text } = buildReEngagementEmail(claimedCandidate.email);
        const result = await sendReEngagementEmail({
          to: claimedCandidate.email,
          subject,
          text,
          idempotencyKey: buildReEngagementIdempotencyKey(claimedCandidate.id),
        });

        if (!result.sent) {
          // JOB-321. The row was stamped by the claim above, and pre JOB-321
          // it stayed stamped and this cron never touched the candidate
          // again: the WHERE clause on `re_engagement_sent_at IS NULL`
          // excluded them, a rotated Resend key or a transient 5xx read the
          // same as a real send at the database level, and the candidate
          // silently never got the email. `releaseReEngagementSlot` closes
          // that gap by unstamping the row on the same UPDATE that
          // increments `re_engagement_send_failures`, so the next hourly
          // run picks them up again — up to `REENGAGEMENT_MAX_SEND_FAILURES`.
          // Beyond the cap the stamp stays and the failure counter records
          // why, matching the "logged loudly, human retries by hand"
          // posture the earlier comment described but now with a bounded
          // automatic retry ahead of that hand off. `Idempotency-Key`
          // (see `buildReEngagementIdempotencyKey`) still guards against
          // the "Resend accepted the request but the response got lost"
          // corner: a replay of the same profile inside Resend's 24 hour
          // retention window is deduplicated on their end.
          const release = await releaseReEngagementSlot(db(), claimedCandidate.id);
          if (release.terminal) {
            console.error(
              `[job-321] send to ${claimedCandidate.id} failed after claiming the row: ${result.reason}. ` +
                `Failure count is ${release.failures}, at or above the cap of ${REENGAGEMENT_MAX_SEND_FAILURES}; ` +
                "the row stays stamped and this cron will not retry it. A human should look."
            );
          } else if (release.released) {
            console.warn(
              `[job-321] send to ${claimedCandidate.id} failed after claiming the row: ${result.reason}. ` +
                `Failure count is ${release.failures}; row was unstamped and the next hourly run will retry.`
            );
          } else {
            // `no_profile`: the candidate id came from `list-candidates` in
            // the same run, so this is a bug rather than an operating
            // condition. Logged so the next reader can see it happened.
            console.error(
              `[job-321] send to ${claimedCandidate.id} failed after claiming the row: ${result.reason}. ` +
                "Release could not find the profile to unstamp; the row stays as the claim left it."
            );
          }
          return { sent: false, reason: result.reason };
        }

        return { sent: true };
      });

      if (outcome.sent) sentCount += 1;
    }

    console.log(
      `[job-311] ${dryRun ? "dry run: " : ""}${sentCount}/${candidates.length} re engagement ` +
        "emails sent."
    );
    return { due: candidates.length, sent: sentCount };
  }
);
