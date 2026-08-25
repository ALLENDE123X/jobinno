/**
 * JOB-009 — the internal vocabulary, translated once, for people.
 *
 * `applications.status` and `skip_log.reason` are written by the pipeline for
 * the pipeline. `form_fill_blocked` and `unanswerable_required` are exactly the
 * right words for a log line and exactly the wrong ones for the person whose
 * application stopped, so the dashboard never renders either of them raw.
 *
 * ── Why a Record and not a switch ───────────────────────────────────────────
 * `Record<ApplicationStatus, ...>` is what makes adding a fourteenth status a
 * type error here rather than a snake case string leaking onto a page. The same
 * goes for `Record<SkipReason, ...>`. Both sets are closed and both live
 * somewhere else, so this file has no opinion on what they are, only on how
 * each one reads. `tests/unit/dashboard-plain-language.test.ts` asserts the
 * same thing at run time, because a `Record` cannot catch a value the free text
 * status column receives from outside the enum.
 *
 * ── The four statuses that all read "needs your attention" ──────────────────
 * `form_fill_blocked`, `account_gate_blocked`, `submission_blocked` and `error`
 * are four different failures with one thing in common: nothing was sent and
 * nobody can move them along but a person. The label they share is the answer
 * to "what do I do", and the sentence under it is the answer to "why", which is
 * where the four stay distinguishable.
 *
 * `submission_unconfirmed` is deliberately not one of them. Its whole meaning
 * is that a submit control was pressed and the outcome is unknown, so telling
 * somebody it was not sent would be a lie in one direction and telling them it
 * was would be a lie in the other.
 */

import { APPLICATION_STATUS, type ApplicationStatus } from "@/lib/application-status";
import type { SkipReason } from "@/lib/db/schema";

/** Which visual family a status belongs to. Styling only; never rendered. */
export type StatusTone = "waiting" | "working" | "sent" | "attention";

export type StatusPresentation = {
  /** The words on the pill. Never the enum value. */
  label: string;
  /** One sentence saying what that means for this person, right now. */
  description: string;
  tone: StatusTone;
  /**
   * True when the row is stuck, or finished in a way nobody can confirm, and
   * only a person can take it further. The dashboard reads this to decide
   * whether to go and look for the `skip_log` reason behind the row.
   */
  needsHuman: boolean;
};

export const STATUS_PRESENTATION: Record<ApplicationStatus, StatusPresentation> = {
  [APPLICATION_STATUS.DISCOVERED]: {
    label: "queued",
    description: "We found this opening and have not started on it yet.",
    tone: "waiting",
    needsHuman: false,
  },
  [APPLICATION_STATUS.CREATING_ACCOUNT]: {
    label: "signing up",
    description: "This board wants an account first, and we are making one.",
    tone: "working",
    needsHuman: false,
  },
  [APPLICATION_STATUS.NO_ACCOUNT_REQUIRED]: {
    label: "ready to apply",
    description: "This board applies straight from the form, so there is no signup to get through.",
    tone: "waiting",
    needsHuman: false,
  },
  [APPLICATION_STATUS.AWAITING_VERIFICATION]: {
    label: "waiting on an email",
    description: "The board sent a confirmation email and we are waiting for it to arrive.",
    tone: "working",
    needsHuman: false,
  },
  [APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED]: {
    label: "needs your attention",
    description:
      "This board will not show its form without an account we could not create safely. Nothing was sent.",
    tone: "attention",
    needsHuman: true,
  },
  [APPLICATION_STATUS.ERROR]: {
    label: "needs your attention",
    description: "The run stopped before it got to the end. Nothing was sent.",
    tone: "attention",
    needsHuman: true,
  },
  [APPLICATION_STATUS.EMAIL_VERIFIED]: {
    label: "email confirmed",
    description: "The board's confirmation is done and the form is next.",
    tone: "working",
    needsHuman: false,
  },
  [APPLICATION_STATUS.FILLING_FORM]: {
    label: "filling the form",
    description: "A browser is working through this application now.",
    tone: "working",
    needsHuman: false,
  },
  [APPLICATION_STATUS.FORM_FILLED]: {
    label: "filled, not sent yet",
    description: "Your answers are in the form and the submit step is next.",
    tone: "working",
    needsHuman: false,
  },
  [APPLICATION_STATUS.FORM_FILL_BLOCKED]: {
    label: "needs your attention",
    description: "We could not finish this form safely, so we stopped. Nothing was sent.",
    tone: "attention",
    needsHuman: true,
  },
  [APPLICATION_STATUS.SUBMITTED]: {
    label: "sent",
    description: "This application is in with the employer.",
    tone: "sent",
    needsHuman: false,
  },
  [APPLICATION_STATUS.SUBMISSION_BLOCKED]: {
    label: "needs your attention",
    description:
      "The form was filled, but no control on the page could be identified as the submit button. Nothing was sent.",
    tone: "attention",
    needsHuman: true,
  },
  [APPLICATION_STATUS.SUBMISSION_UNCONFIRMED]: {
    label: "sent, not confirmed",
    description:
      "We pressed submit and could not read what happened next. Check with the employer before you apply to this one by hand.",
    tone: "attention",
    needsHuman: true,
  },
  // v1-C (#143). Same wording family as `form_fill_blocked` — a person has to
  // act — but the tone is `attention` rather than terminal: the pipeline will
  // pick this row up again the moment they answer on the dashboard.
  [APPLICATION_STATUS.PENDING_USER_INPUT]: {
    label: "waiting on your answer",
    description:
      "There were a couple of questions on the form we could not answer for you. Answer them in your dashboard and we will finish the application.",
    tone: "attention",
    needsHuman: true,
  },
};

/**
 * What a status column value that is not in the enum reads as.
 *
 * `applications.status` is free text by design, so this is reachable, and it
 * errs toward asking a person to look. A value nothing here recognises is
 * either a status added without updating this file or a write from somewhere
 * that should not be writing, and both are worth a human noticing.
 */
export const UNRECOGNISED_STATUS: StatusPresentation = {
  label: "needs a look",
  description: "This one is in a state we have no wording for yet. Get in touch and we will check it.",
  tone: "attention",
  needsHuman: true,
};

/** How one `applications.status` value reads on the dashboard. */
export function describeStatus(status: string): StatusPresentation {
  return STATUS_PRESENTATION[status as ApplicationStatus] ?? UNRECOGNISED_STATUS;
}

/**
 * Why a run stopped, as a sentence rather than as a reason code.
 *
 * These say what happened and, where there is one, what the person can do. They
 * deliberately do not promise a retry: nothing on this page can resume a
 * blocked application yet, and the PR that ships this says so.
 */
export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  unanswerable_required:
    "The form had a required field we could not fill in from anything we know about you.",
  verification_required:
    "The board wanted an account or an emailed confirmation before it would show the application form.",
  captcha: "The board put a robot check in the way, which we are not allowed to work around.",
  dom_changed:
    "The page did not look the way we expected, so we stopped rather than click something we could not identify.",
  timeout: "The board stopped responding while we were working through it.",
  submit_failed: "Something went wrong at the submit step, so the outcome could not be confirmed.",
  blocked_redirect:
    "This listing sent us to a page that does not belong to the company's own job board, so we stopped before typing anything.",
  needs_attestation:
    "The form required an answer about work authorization, citizenship, a security clearance or a similar legal question, your intake does not answer it, and the form offered no way to skip it. We will never guess at one of those for you.",
  internal_error: "Something on our side went wrong. This one is on us and we are looking at it.",
  bot_detected:
    "We filled this application in and pressed submit, and the job board turned it down because it thought a robot was filling it in. That is about us and how we reach the board, not about you or anything you wrote. Nothing you can do at your end will change it, and we are working on it. If you want this job, the surest fix today is to apply once yourself.",
};

/** Why a run stopped, or null when the reason code is not one we know. */
export function describeSkipReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return SKIP_REASON_TEXT[reason as SkipReason] ?? null;
}
