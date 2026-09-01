/**
 * JOB-329 — the morning recap cron.
 *
 * Every hour, on the hour, this looks for anybody whose overnight pipeline
 * quietly landed two or more real submissions in the last twelve hours and
 * has not been recap emailed inside the last twenty. Those people get one
 * founder personal email with a list of what was submitted and a plan
 * conditional call to action, from the same From address JOB-311 sends
 * from, with a reply routed straight to the founder's inbox.
 *
 * Depends on JOB-326 (merged as d9048233), which fires `requestJobSearch`
 * on attestation so that submissions actually happen overnight. Without it
 * there is nothing to recap.
 *
 * The two windows, and why they overlap on purpose
 *   The submission lookback is 12 hours. The rate limit stamp is 20. The
 *   two are not the same on purpose: the lookback decides who the
 *   candidate list is (people with fresh submissions to talk about), and
 *   the stamp decides whether we may talk to them again (nobody who
 *   received a recap in the last 20 hours). Twenty is comfortably longer
 *   than one overnight cycle plus a morning of drift, so a recap that went
 *   out at 07:00 UTC on Tuesday blocks another one at 09:00 UTC on Tuesday
 *   but does not block Wednesday's 07:00. That is what makes this "the
 *   morning recap" rather than "an hourly digest".
 *
 * The count threshold, and why it is two
 *   One submission on its own does not read as a burst of overnight work
 *   the way three or four do, and the whole conversion mechanic here is
 *   that the email lands the moment the reader has proof the product
 *   worked while they were asleep. Two is the floor at which "here is
 *   what Jobinno did for you overnight" is a truthful sentence.
 *
 * Batch size
 *   Up to 50 recipients a run, per the ticket. Sized as a rate limit on
 *   how many founder personal emails go out in one hour rather than as a
 *   performance concern, matching JOB-311.
 *
 * Dry run
 *   `RECAP_EMAIL_DRY_RUN=true` logs every candidate this run would have
 *   emailed and stops there: no Resend call, no stamp written. This is
 *   what the ticket's acceptance check runs against production with
 *   before the cron is ever allowed to actually send anything.
 *
 * Reachable from `app/api/inngest/route.ts`
 *   Same reasoning as the JOB-311 header: a cron unregistered there has
 *   no schedule at all, and this file exports the function this project's
 *   one serve route lists by name.
 */

// The pipeline's first import is `./load-env`, so importing the client
// from it keeps the ordering that file's header depends on. See
// `inngest/reengagement-cron.ts` for the same one line rationale.
import { inngest } from "./job-application-pipeline";

import { and, count, desc, eq, gte, isNull, or, sql } from "drizzle-orm";

import { APPLICATION_STATUS, type ApplicationStatus } from "@/lib/application-status";
import { db } from "@/lib/db/client";
import { applications, boards, jobs, profiles } from "@/lib/db/schema";
import type { PlanSlug } from "@/lib/billing/plans";
import {
  buildRecapIdempotencyKey,
  redactEmail,
  sendRecapEmail,
  utcDayStamp,
} from "@/lib/recap/email";
import { buildRecapEmail, type RecapSubmission } from "@/lib/recap/template";

// Every hour, on the hour. Described in words here rather than in a block
// comment: HARD STOP 4 in CLAUDE.md is exactly a cron expression closing a
// block comment early.
const RECAP_CRON = "0 * * * *";

/** How far back the count query looks for `submitted` rows. */
export const RECAP_SUBMISSION_WINDOW_HOURS = 12;
/** How recently a recap must have gone out to block another one now. */
export const RECAP_RATE_LIMIT_HOURS = 20;
/** The count threshold that lets one person show up on this list at all. */
export const RECAP_MIN_SUBMISSIONS = 2;
/** At most this many sends per run. */
export const RECAP_BATCH_LIMIT = 50;

/** The one status a row has to be in to count toward the threshold. */
const SUBMITTED_STATUS: ApplicationStatus = APPLICATION_STATUS.SUBMITTED;

export type RecapDatabase = ReturnType<typeof db>;

export type RecapCandidate = {
  id: string;
  email: string;
  plan: PlanSlug;
  applicationsUsed: number;
  applicationsCap: number;
  submissionCount: number;
};

/**
 * Everybody due for a recap right now.
 *
 * The two properties that decide eligibility are baked into the WHERE
 * clause and the HAVING count together, rather than into two separate
 * queries, so that a person who is inside the submission window but
 * inside the rate limit window too is excluded in the same trip as a
 * person who is outside the submission window entirely. Splitting them
 * would leave a tiny window in which a concurrent run could send twice.
 *
 * `limit` defaults to `RECAP_BATCH_LIMIT` and exists as its own parameter,
 * rather than only as the hardcoded default, so a test can pin the cap to
 * something small and prove the LIMIT clause is really there without
 * inserting fifty live fixture rows to do it. The cron itself never
 * overrides it.
 */
export async function listRecapCandidates(
  database: RecapDatabase = db(),
  now: Date = new Date(),
  limit: number = RECAP_BATCH_LIMIT
): Promise<RecapCandidate[]> {
  const submissionWindowStart = new Date(
    now.getTime() - RECAP_SUBMISSION_WINDOW_HOURS * 60 * 60 * 1000
  );
  const rateLimitStart = new Date(
    now.getTime() - RECAP_RATE_LIMIT_HOURS * 60 * 60 * 1000
  );

  const rows = await database
    .select({
      id: profiles.id,
      email: profiles.email,
      plan: profiles.plan,
      applicationsUsed: profiles.applicationsUsed,
      applicationsCap: profiles.applicationsCap,
      submissionCount: count(applications.id).as("submission_count"),
    })
    .from(profiles)
    .innerJoin(applications, eq(applications.userId, profiles.id))
    .where(
      and(
        eq(applications.status, SUBMITTED_STATUS),
        gte(applications.submittedAt, submissionWindowStart),
        or(
          isNull(profiles.recapEmailLastSentAt),
          sql`${profiles.recapEmailLastSentAt} < ${rateLimitStart.toISOString()}`
        )
      )
    )
    .groupBy(
      profiles.id,
      profiles.email,
      profiles.plan,
      profiles.applicationsUsed,
      profiles.applicationsCap
    )
    .having(sql`count(${applications.id}) >= ${RECAP_MIN_SUBMISSIONS}`)
    .orderBy(profiles.id)
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    plan: (row.plan ?? "free") as PlanSlug,
    applicationsUsed: row.applicationsUsed,
    applicationsCap: row.applicationsCap,
    submissionCount: Number(row.submissionCount),
  }));
}

/**
 * The overnight submissions for one candidate, most recent last so the
 * email body reads bottom heavy the way a real timeline does.
 *
 * A second read rather than folded into `listRecapCandidates` because the
 * candidate query is `count(*) GROUP BY profile`, which cannot also
 * project the individual rows without either a distinct on trick or a
 * lateral join. Two small clean queries beat one clever one, and the
 * candidate list is capped at 50 so this is at most 50 short reads.
 */
export async function listRecapSubmissions(
  database: RecapDatabase,
  userId: string,
  now: Date = new Date()
): Promise<RecapSubmission[]> {
  const submissionWindowStart = new Date(
    now.getTime() - RECAP_SUBMISSION_WINDOW_HOURS * 60 * 60 * 1000
  );

  const rows = await database
    .select({
      company: boards.company,
      role: jobs.title,
      submittedAt: applications.submittedAt,
    })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(boards, eq(boards.id, jobs.boardId))
    .where(
      and(
        eq(applications.userId, userId),
        eq(applications.status, SUBMITTED_STATUS),
        gte(applications.submittedAt, submissionWindowStart)
      )
    )
    .orderBy(desc(applications.submittedAt));

  // `applications.submittedAt` is nullable in the schema but the WHERE
  // clause above filtered out any row where it is null, since `gte` on a
  // null timestamp is never true. The map below reasserts non null to
  // keep the return type honest.
  return rows
    .filter((row): row is { company: string; role: string; submittedAt: Date } =>
      row.submittedAt instanceof Date
    )
    .map((row) => ({
      company: row.company,
      role: row.role,
      submittedAt: row.submittedAt,
    }));
}

/** `RECAP_EMAIL_DRY_RUN=true`, case and whitespace tolerant. Anything else, including unset, is a real run. */
function isDryRun(): boolean {
  return (process.env.RECAP_EMAIL_DRY_RUN ?? "").trim().toLowerCase() === "true";
}

/**
 * Attempts to claim one profile for sending, atomically. Stamps
 * `recap_email_last_sent_at` only if the profile is still eligible under
 * the same rate limit window `listRecapCandidates` filters on, exactly the
 * same conditional update shape `claimReEngagementSend` in
 * `inngest/reengagement-cron.ts` uses for the same reason: a plain read
 * followed by a separate write can always go stale between the two, and a
 * single `UPDATE ... WHERE ... RETURNING` cannot, since Postgres
 * evaluates the WHERE clause and performs the write in one atomic step.
 *
 * Exported, rather than kept inline in the send step below, so this
 * statement can be tested directly against a real database without also
 * standing up an Inngest step around it.
 *
 * Returns the claimed row's key fields on success, or `null` when the
 * claim raced a concurrent stamp. A `null` result means nothing should
 * be sent.
 */
export async function claimRecapSend(
  database: RecapDatabase,
  candidateId: string,
  now: Date = new Date()
): Promise<{ id: string; email: string } | null> {
  const rateLimitStart = new Date(
    now.getTime() - RECAP_RATE_LIMIT_HOURS * 60 * 60 * 1000
  );

  const [claimed] = await database
    .update(profiles)
    .set({ recapEmailLastSentAt: now })
    .where(
      and(
        eq(profiles.id, candidateId),
        or(
          isNull(profiles.recapEmailLastSentAt),
          sql`${profiles.recapEmailLastSentAt} < ${rateLimitStart.toISOString()}`
        )
      )
    )
    .returning({ id: profiles.id, email: profiles.email });

  return claimed ?? null;
}

export const recapCron = inngest.createFunction(
  {
    id: "recap-cron",
    triggers: [{ cron: RECAP_CRON }],
    // One run at a time. Two overlapping runs would both read the same
    // candidates before either had written a stamp, and both would send.
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    // Only cross the step boundary with primitive fields, matching every
    // other cron in this directory. The send step below re verifies
    // eligibility itself with a conditional claim rather than trusting
    // this list to still be accurate by the time the send actually runs.
    const candidates = await step.run("list-candidates", () => listRecapCandidates());

    if (candidates.length === 0) {
      console.log("[job-329] nobody due for a morning recap email this hour.");
      return { due: 0, sent: 0 };
    }

    const dryRun = isDryRun();
    let sentCount = 0;

    for (const candidate of candidates) {
      const outcome = await step.run(`send-${candidate.id}`, async () => {
        if (dryRun) {
          console.log(
            `[job-329] dry run: would send to ${redactEmail(candidate.email)} ` +
              `(${candidate.id}, ${candidate.submissionCount} submissions, plan=${candidate.plan}).`
          );
          return { sent: false };
        }

        // Conditional atomic claim before any send, matching JOB-311. A
        // candidate whose stamp was written by a concurrent run between
        // `list-candidates` and here no longer matches `claimRecapSend`'s
        // WHERE clause, so it returns `null` and nothing is sent. See
        // `inngest/reengagement-cron.ts`'s header for the full rationale
        // on claiming before sending rather than after.
        const now = new Date();
        const claimed = await claimRecapSend(db(), candidate.id, now);

        if (claimed === null) {
          console.log(
            `[job-329] skipped ${candidate.id}: no longer eligible, raced by another run.`
          );
          return { sent: false, reason: "raced" as const };
        }

        const submissions = await listRecapSubmissions(db(), candidate.id, now);

        // Race guard on the recap window itself: a candidate whose
        // submissions all fell out of the 12 hour window between
        // `list-candidates` and this read no longer has enough overnight
        // rows to justify the "overnight" subject line. The row is
        // already stamped (see below for why not rolled back); log and
        // skip.
        if (submissions.length < RECAP_MIN_SUBMISSIONS) {
          console.warn(
            `[job-329] skipped ${claimed.id}: only ${submissions.length} submissions in window ` +
              "at send time; row stays stamped and will not retry automatically."
          );
          return { sent: false, reason: "no_longer_qualifying" as const };
        }

        const recipient = {
          email: claimed.email,
          plan: candidate.plan,
          applicationsUsed: candidate.applicationsUsed,
          applicationsCap: candidate.applicationsCap,
        };
        const { subject, text } = buildRecapEmail(recipient, submissions);
        const result = await sendRecapEmail({
          to: claimed.email,
          subject,
          text,
          idempotencyKey: buildRecapIdempotencyKey(claimed.id, utcDayStamp(now)),
        });

        if (!result.sent) {
          // Same policy as JOB-311's send step: the row is already
          // stamped from the claim above and this cron does not undo
          // that. Rolling the stamp back would reopen the same race the
          // claim exists to close, since the reason this specific send
          // failed is not guaranteed to be gone by the next run either.
          // Logged loudly so a real failure here is something a human
          // finds and can retry by hand, matching the reasoning
          // `buildRecapIdempotencyKey` documents.
          console.warn(
            `[job-329] send to ${claimed.id} failed after claiming the row: ${result.reason}. ` +
              "Row stays stamped; this candidate will not be retried automatically."
          );
          return { sent: false, reason: result.reason };
        }

        return { sent: true };
      });

      if (outcome.sent) sentCount += 1;
    }

    console.log(
      `[job-329] ${dryRun ? "dry run: " : ""}${sentCount}/${candidates.length} recap ` +
        "emails sent."
    );
    return { due: candidates.length, sent: sentCount };
  }
);
