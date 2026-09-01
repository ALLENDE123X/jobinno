/**
 * JOB-329 — the copy for the morning recap email.
 *
 * A pure function on purpose, with no database and no network in it. The
 * body has to read as one real person writing to another about a real
 * outcome that just happened, which is a property of the words themselves
 * and not of anything the cron does around them, so it is worth being able
 * to check the words with nothing else involved.
 *
 * Why the greeting is an email address
 *   Same reasoning as `lib/reengagement/template.ts`: intake does not yet
 *   collect a first name (see JOB-324), so `profiles.email` is the only
 *   thing this cron has to greet the person by. "Hi there" reads like a
 *   mail merge that failed; the address at least proves a real person is
 *   on the other end of this, sent to the exact inbox that will receive
 *   it.
 *
 * Why the CTA is plan conditional
 *   The whole point of this email is that it lands at the moment a person
 *   has proof the product works, and the ask depends on which shelf that
 *   proof puts them on. A free trial that just hit its cap has one question
 *   in front of it (buy or stop), a free trial with room left has two
 *   (keep going now, or wait), and a paying customer has none. Sending the
 *   same generic "upgrade" line to all three is worse than sending three
 *   different ones, since the paying customer reading an upgrade pitch to
 *   the plan they are already on reads as a system that does not know who
 *   they are.
 *
 * Subject wording
 *   JOB-329 names the subject line exactly: "Jobinno submitted N
 *   applications for you overnight", with N interpolated from the count.
 *   Kept out of any config or env var: a copy change is a code review of
 *   prose that reaches real people, not a runtime toggle.
 *
 * No em dashes and no prose hyphens anywhere below, per HARD STOP 8 in
 * CLAUDE.md. "new grad" and "real time", not the hyphenated forms.
 */

import {
  FREE_PLAN_APPLICATIONS_CAP,
  PAID_PLANS,
  type PlanSlug,
} from "@/lib/billing/plans";

/**
 * Where the CTA in the free tier variants links to. The pricing anchor on
 * the marketing page, matching the two dashboard surfaces (see
 * `app/dashboard/quota-meter.tsx` and `app/dashboard/upgrade-cards.tsx`)
 * that also send people there.
 */
export const RECAP_PRICING_URL = "https://jobinno.app/#pricing";

/** Where a paying customer's CTA copy points them: their own dashboard. */
export const RECAP_DASHBOARD_URL = "https://jobinno.app/dashboard";

/**
 * One overnight submission that showed up in the recap window.
 *
 * `submittedAt` is the moment the pipeline flipped the row to
 * `submitted`. Rendered as HH:MM in the body so the reader can see at a
 * glance that these all happened while they were asleep.
 */
export interface RecapSubmission {
  readonly company: string;
  readonly role: string;
  readonly submittedAt: Date;
}

/**
 * Everything about the recipient the copy needs. Kept narrow on purpose:
 * this template has no business reading anything else on the profile row.
 *
 * `applicationsUsed` and `applicationsCap` decide the free tier variant
 * split; `plan` decides the paid variant.
 */
export interface RecapRecipient {
  readonly email: string;
  readonly plan: PlanSlug;
  readonly applicationsUsed: number;
  readonly applicationsCap: number;
}

export interface RecapEmailContent {
  readonly subject: string;
  readonly text: string;
}

/**
 * Renders one submission line as `Company | Role | submitted at HH:MM`.
 * A vertical bar and no hyphens, per HARD STOP 8.
 */
function renderSubmissionLine(submission: RecapSubmission): string {
  const hours = String(submission.submittedAt.getUTCHours()).padStart(2, "0");
  const minutes = String(submission.submittedAt.getUTCMinutes()).padStart(2, "0");
  return `${submission.company} | ${submission.role} | submitted at ${hours}:${minutes} UTC`;
}

/**
 * The CTA paragraph, picked per plan and per cap position.
 *
 * Exported for tests: the three branches are the whole plan conditional
 * behaviour this ticket adds, and every branch has to render for a real
 * shaped recipient rather than only inside a rendered subject line.
 */
export function renderRecapCta(recipient: RecapRecipient): string {
  if (recipient.plan === "starter" || recipient.plan === "season_pass") {
    const plan = PAID_PLANS[recipient.plan];
    return [
      `You are on ${plan.label}. Cap: ${recipient.applicationsUsed} of ${recipient.applicationsCap} this month.`,
      `Dashboard: ${RECAP_DASHBOARD_URL}`,
    ].join("\n");
  }

  // Free tier from here down. Two branches on whether the person has room
  // left inside their trial.
  const trialSize = FREE_PLAN_APPLICATIONS_CAP;
  const usedAll = recipient.applicationsUsed >= trialSize;

  if (usedAll) {
    return [
      "That was your free trial. On Starter, we keep this pace up every day.",
      `${PAID_PLANS.starter.label} is $29 a month: ${RECAP_PRICING_URL}`,
    ].join("\n");
  }

  return [
    `That is ${recipient.applicationsUsed} of your ${trialSize} free applications.`,
    "Want to keep going?",
    `${PAID_PLANS.starter.label} at $29 a month or the ${PAID_PLANS.season_pass.label} at $99 up front: ${RECAP_PRICING_URL}`,
  ].join("\n");
}

/**
 * Builds the subject and plain text body for one recap send.
 *
 * `submissions` is the list of overnight rows the query surfaced, and the
 * ticket promises the caller will only invoke this when the list has two
 * or more entries. A defensive check throws on an empty list rather than
 * rendering "Jobinno submitted 0 applications for you overnight", which
 * would be a bug worse than a runtime error since it would land in a real
 * inbox.
 */
export function buildRecapEmail(
  recipient: RecapRecipient,
  submissions: readonly RecapSubmission[]
): RecapEmailContent {
  if (submissions.length === 0) {
    throw new Error(
      "buildRecapEmail called with no submissions. The cron must only call " +
        "this for recipients whose overnight submission count is at least 2."
    );
  }

  const n = submissions.length;
  const subject = `Jobinno submitted ${n} applications for you overnight`;

  const lines = [
    `Hi ${recipient.email},`,
    "",
    "I am Pranav, the person building Jobinno. Here is what Jobinno did for " +
      "you overnight:",
    "",
    ...submissions.map(renderSubmissionLine),
    "",
    `You just watched Jobinno do ${n} in one night.`,
    "",
    renderRecapCta(recipient),
    "",
    "If anything on that list looks wrong, just reply to this email and " +
      "tell me. I read every reply myself.",
    "",
    "Pranav",
  ];

  return { subject, text: lines.join("\n") };
}
