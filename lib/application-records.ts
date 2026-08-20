/**
 * JOB-004 — the pipeline's writes to `applications` and `skip_log`, in one
 * place.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * `fill-application-form.ts` and `submit-application.ts` were ported from
 * actinno carrying a private, character for character identical copy of
 * `updateApplication` each. That was harmless while both wrote the same two
 * columns of the same table. It stops being harmless here, because JOB-004
 * turns one column update into two writes against two tables, and two copies of
 * that would be two chances to record a failure differently.
 *
 * This is the same lift JOB-002 did to `assertSupabaseProject()`, for the same
 * reason and with the same result: the ported modules keep their logic, and the
 * thing they both do is defined once.
 *
 * ── The shape change, and the product decision behind it ────────────────────
 * actinno's `job_applications` had an `error_message` column. Every stop the
 * pipeline could make wrote a sentence into it, and some of those stops were
 * not really stops at all: `awaiting_verification` meant "this run is parked,
 * waiting for an email that may or may not arrive", and a row could sit in that
 * state indefinitely.
 *
 * Jobinno decided otherwise, and the schema records the decision. There is no
 * `error_message` column. There is a `skip_log` table with a `reason` drawn
 * from a closed set, checked by Postgres, and a `raw_context` for the detail.
 * Skip and log, do not pause and wait: an application that cannot be finished
 * gets a terminal status and a row saying why, and something later reads the
 * log and decides what to do. Nothing is left parked.
 *
 * So `recordFailure` below does two writes where actinno did one, and the
 * reason taxonomy in `SKIP_REASONS` is what the free text used to carry.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * There is no way to move a row out of `submitted` or out of
 * `submission_unconfirmed`. `updateApplication` will happily write either one,
 * because something has to; what stops the reverse is that every caller checks
 * before it opens a browser, in two independent places (ACT-007's
 * `READY_STATUSES` and ACT-008's `preflight`). Adding a third guard here that
 * silently dropped a write would make those two harder to reason about, not
 * easier, and a silently dropped status write is the worst failure this file
 * could have.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApplicationStatus } from "@/lib/application-status";
import { SKIP_REASONS, type SkipReason } from "@/lib/db/schema";

const LOG = "[job-004]";

/**
 * How much of a failure message survives into `skip_log.raw_context`.
 *
 * Carried over from `fill-application-form.ts`, comment and all, because the
 * reasoning is unchanged by the column move. It was 2000, on the reasoning that
 * a full stack dump in a status table helps nobody. That is right for a stack
 * trace and badly wrong for the other thing that comes through here: the
 * `needsInput` questions, which are the whole mechanism by which a blocked
 * application reaches a human.
 *
 * A real SoFi form asked 49 required questions. The list was written out,
 * truncated at 2000 characters, and the caller saw four of them — so 45
 * questions the candidate had to answer were simply unreachable, and the
 * application could never be completed by anyone. `raw_context` is `jsonb` with
 * no width limit; the cap was protecting nothing.
 */
export const MAX_SKIP_DETAIL_CHARS = 16_000;

/**
 * The columns of `applications` the pipeline writes.
 *
 * Note what is absent and used to be here. `error_message` has no column, see
 * the header. `updated_at` has no column either: `applications` carries only
 * `created_at`, on the reasoning that a row's history is the skips logged
 * against it rather than one timestamp that each write overwrites.
 */
export type ApplicationPatch = {
  status?: ApplicationStatus;
  /** `applications.confirmation_text`: actinno spelled this `confirmation_ref`. */
  confirmationText?: string | null;
  /** ISO 8601. Set once, by the submit step, and never cleared. */
  submittedAt?: string | null;
  /** Where the board sent the browser after submit, when it sent it anywhere. */
  redirectUrl?: string | null;
};

/** `ApplicationPatch` → the row shape, dropping anything the caller left out. */
function patchColumns(patch: ApplicationPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.confirmationText !== undefined) row.confirmation_text = patch.confirmationText;
  if (patch.submittedAt !== undefined) row.submitted_at = patch.submittedAt;
  if (patch.redirectUrl !== undefined) row.redirect_url = patch.redirectUrl;
  return row;
}

/** Writes a patch onto one `applications` row. Throws if the write is refused. */
export async function updateApplication(
  supabase: SupabaseClient,
  applicationId: string,
  patch: ApplicationPatch
): Promise<void> {
  const columns = patchColumns(patch);
  if (Object.keys(columns).length === 0) return;

  const { error } = await supabase
    .from("applications")
    .update(columns)
    .eq("id", applicationId);
  if (error) {
    throw new Error(
      `Failed to update applications ${applicationId} ` +
        `(${JSON.stringify(Object.keys(columns))}): ${error.message}`
    );
  }
}

/**
 * The tags the ported modules already write into their failure messages, and
 * the `skip_log.reason` each one means.
 *
 * Matching on a tag rather than on the status is deliberate. A status says how
 * far the run got; the tag says what actually stopped it, and those are
 * different questions. `form_fill_blocked` is the status for a captcha, for an
 * unanswerable required question and for a form whose fields could not be
 * identified — three genuinely different bugs that a single reason would blur
 * into one unfixable heap.
 *
 * The tags themselves are not invented here. `needs_candidate_input:` is
 * written by `blockedForAnswers`, `captcha_present:` by the captcha check, and
 * `submit_clicked_outcome_unknown` / `submission_blocked` by ACT-008. Keeping
 * them as the join between the two files is what makes each stop greppable in
 * the logs and classifiable in the database from the same string.
 */
const REASON_TAGS: ReadonlyArray<readonly [RegExp, SkipReason]> = [
  // `blocked_apply_url:` is written by `fill-application-form.ts` when the
  // browser has ended up somewhere the listing's own board does not own, and it
  // is first in this list on purpose. That message quotes the URL the browser
  // landed on, and the URL is chosen by whoever sent the browser there. A path
  // spelling `/verify-captcha/` would otherwise file the stop under somebody
  // else's reason and hide it from anyone reading the log for this one.
  // `dom_changed` matches what the pre navigation refusal names explicitly, and
  // for the same stated reason: a listing pointing somewhere the board does not
  // own is a page that is not what the automation expected.
  [/blocked_apply_url/i, "dom_changed"],
  [/needs_candidate_input|cannot be answered truthfully/i, "unanswerable_required"],
  [/captcha_present|\bcaptcha\b|hcaptcha|turnstile|recaptcha/i, "captcha"],
  [/submit_clicked_outcome_unknown|submission_blocked/i, "submit_failed"],
  // "holds no account" is the sign-in wall in `fill-application-form.ts`. A
  // board that will not show its application form without an account is asking
  // for the same thing a verification mail asks for, one step earlier, and it
  // belongs under the same reason: the fix for both is the account creation
  // work, not a retry.
  [/verification|verify your email|account gate|account_gate|holds no account/i,
    "verification_required"],
  [/\btimed? ?out\b|timeout|etimedout/i, "timeout"],
];

/**
 * Which `skip_log.reason` a stop belongs under.
 *
 * The message is consulted first and the status second, on the reasoning above.
 * The fallback is `dom_changed` rather than a general purpose "other", because
 * `SKIP_REASONS` has no "other" and should not grow one: every value in that
 * set names something a person could go and fix, and a bucket that names
 * nothing is where unfixed bugs accumulate quietly. A run that failed for a
 * reason none of the tags recognise, against a page the automation expected to
 * look different, is a page that changed until proven otherwise.
 */
export function skipReasonFor(status: ApplicationStatus, message: string): SkipReason {
  for (const [pattern, reason] of REASON_TAGS) {
    if (pattern.test(message)) return reason;
  }
  // `submission_unconfirmed` and `submission_blocked` both mean the submit leg
  // is where this died, whatever the message says about it.
  if (status === "submission_unconfirmed" || status === "submission_blocked") {
    return "submit_failed";
  }
  if (status === "account_gate_blocked" || status === "awaiting_verification") {
    return "verification_required";
  }
  return "dom_changed";
}

export type SkipInput = {
  /** Null when the listing was abandoned before an `applications` row existed. */
  applicationId: string | null;
  jobId: string;
  ats: string;
  reason: SkipReason;
  /** The sentence a human reads. Lands in `raw_context.message`. */
  message: string;
  /** The label as it appeared on the page, verbatim, when one control caused this. */
  fieldLabel?: string | null;
  fieldKind?: string | null;
  required?: boolean | null;
};

/**
 * Appends one row to `skip_log`.
 *
 * Appends rather than replaces, and there is no update path. An application can
 * be attempted more than once and each attempt's reason is a fact about that
 * attempt; overwriting the previous one would erase the history that makes a
 * flaky board distinguishable from a broken one.
 *
 * Throws. `recordFailure` is the best-effort wrapper — this one is separate so
 * that a caller who genuinely needs to know the log was written can find out.
 */
export async function recordSkip(supabase: SupabaseClient, input: SkipInput): Promise<void> {
  if (!SKIP_REASONS.includes(input.reason)) {
    // The column has a CHECK constraint built from the same array, so this
    // would fail in Postgres anyway. Failing here names the array instead of
    // naming the constraint.
    throw new Error(
      `skip_log.reason must be one of ${SKIP_REASONS.join(", ")}, got ` +
        `${JSON.stringify(input.reason)}.`
    );
  }

  const message =
    input.message.length > MAX_SKIP_DETAIL_CHARS
      ? `${input.message.slice(0, MAX_SKIP_DETAIL_CHARS)}…`
      : input.message;

  const { error } = await supabase.from("skip_log").insert({
    application_id: input.applicationId,
    job_id: input.jobId,
    ats: input.ats,
    reason: input.reason,
    field_label: input.fieldLabel ?? null,
    field_kind: input.fieldKind ?? null,
    required: input.required ?? null,
    // Never a screenshot and never resume text, per the schema's own note on
    // this column. The message is the pipeline's own prose about its own stop.
    raw_context: { message },
  });

  if (error) {
    throw new Error(`Failed to insert skip_log for application ${input.applicationId}: ${error.message}`);
  }
}

/**
 * `recordSkip`, downgraded from a throw to a very loud log.
 *
 * For the one caller that genuinely cannot be allowed to reject:
 * `submit-application.ts` after the submit control has been clicked. Everything
 * on that path resolves rather than throws, because any error path anywhere
 * upstream is a path that something can decide to retry, and a retry after a
 * real click is the single worst thing this system can do. A failed insert into
 * a log table is not worth risking a duplicate application under a real
 * person's name.
 */
export async function recordSkipQuietly(
  supabase: SupabaseClient,
  input: SkipInput,
  log: string = LOG
): Promise<void> {
  try {
    await recordSkip(supabase, input);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(
      `${log} could not write skip_log (${input.reason}) for job ${input.jobId}: ${why}. ` +
        `The reason for this stop now exists only in this log line.`
    );
  }
}

export type FailureInput = Omit<SkipInput, "reason"> & {
  status: ApplicationStatus;
  /** Overrides the reason `skipReasonFor` would have derived. Rarely needed. */
  reason?: SkipReason;
  /** Log prefix of the calling module, e.g. `[act-007]`. */
  log?: string;
};

/**
 * Records a terminal failure: the status on the row, the reason in the log.
 *
 * Best-effort, and never throws over the original error. That property is
 * carried over verbatim from actinno's `recordFailure` and is worth restating,
 * because it now has two ways to fail rather than one: a run that is already
 * dying must not have its real cause replaced by a complaint about the
 * bookkeeping, and that stays true whether the status write or the skip insert
 * is the thing that broke.
 *
 * The status is written first. If only one of the two writes lands, the more
 * useful survivor is the one that stops the row being picked up again.
 */
export async function recordFailure(
  supabase: SupabaseClient,
  input: FailureInput
): Promise<void> {
  const log = input.log ?? LOG;
  const reason = input.reason ?? skipReasonFor(input.status, input.message);

  if (input.applicationId !== null) {
    try {
      await updateApplication(supabase, input.applicationId, { status: input.status });
      console.error(
        `${log} applications ${input.applicationId} → ${input.status} (${reason}): ${input.message}`
      );
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(
        `${log} could not record ${input.status} on applications ${input.applicationId}: ${why}`
      );
    }
  }

  await recordSkipQuietly(supabase, { ...input, reason }, log);
}

// ───────────────────────────────────
// Claiming the row
// ───────────────────────────────────

/**
 * What `claimApplicationRow` found or created.
 *
 * `created` distinguishes a fresh claim from a re-entry, which is the whole
 * reason the function returns anything beyond an id: a retry of the same
 * listing must reuse the row rather than file a second application against it.
 */
export type ClaimedApplication = {
  applicationId: string;
  status: string;
  created: boolean;
};

/** Statuses a listing may never be re-claimed from. Both mean a click happened. */
const UNCLAIMABLE: ReadonlySet<string> = new Set(["submitted", "submission_unconfirmed"]);

/**
 * The `applications` row for one person against one listing, created if it does
 * not exist yet.
 *
 * ── What this replaced (JOB-004) ────────────────────────────────────────────
 * actinno created the row inside `createBoardAccount`, as a side effect of its
 * first browser step, and called it `claimApplicationRow`. That module was
 * deliberately not ported — signing a real person up for an account on an
 * employer's board is a V2 question — so the row creation had to come out of it
 * and stand on its own. This is that, and nothing else: no browser, no network,
 * one read and at most one insert.
 *
 * ── The guards, and why they are here and not upstream ──────────────────────
 * Three things are checked before a row is created, and all three are checked
 * here rather than in the caller because this is the last place before a real
 * application exists in the database.
 *
 *  · **The person attested.** `profiles.attested_at` is null until someone
 *    finishes intake and confirms their answers are true. HARD STOP 9 says
 *    every generated answer stands on that attestation, so a run for a profile
 *    that has never made it is a run with nothing behind what it will submit.
 *
 *  · **They have applications left.** `profiles.applications_used` is compared
 *    against `profiles.applications_cap`, both straight off the profile row.
 *    The cap defaults to zero and the schema is explicit that zero means
 *    "cannot apply yet" rather than "no limit" — the failure of the other
 *    reading is billable work done for free on someone else's job board.
 *
 *    This used to be a live `count(*)` of the person's `applications` rows,
 *    because nothing wrote the counter. `lib/application-quota.ts` writes it
 *    now, and the count had two bugs the counter does not have: it was a
 *    lifetime total, so JOB-010 resetting it to zero on a genuine plan change
 *    bought somebody 150 applications and handed them 150 minus whatever they
 *    had already done; and it had no status filter, so a `discovered` row and
 *    every failed or skipped attempt spent allowance nobody applied with.
 *
 *    This check is the cheap one, and it is deliberately not the enforcement.
 *    It exists so that a person with nothing left is refused before a browser
 *    is launched. What actually enforces the cap is the conditional UPDATE in
 *    `reserveApplicationSlot`, which the pipeline runs between this and the
 *    submit — see that module for the race this check cannot close on its own.
 *
 *  · **The listing has not already been submitted to.** Re-claiming a row at
 *    `submitted` or `submission_unconfirmed` would hand a live row id to a
 *    module that is about to open a browser at it. Both of those modules refuse
 *    such a row themselves; this is the guard that means they never see one.
 *
 * ── The race it does not close ──────────────────────────────────────────────
 * `(user_id, job_id)` has no unique index, so two concurrent claims for the
 * same pair both insert and the person sees one listing twice. Inherited from
 * actinno along with its mitigation: the caller de-duplicates before it fans
 * out. A unique index would close it properly and is a migration rather than a
 * line, so it is named here and left to the ticket that adds it.
 */
export async function claimApplicationRow(
  supabase: SupabaseClient,
  input: { userId: string; jobId: string }
): Promise<ClaimedApplication> {
  const { userId, jobId } = input;

  const { data: existing, error: existingError } = await supabase
    .from("applications")
    .select("id,status")
    .eq("user_id", userId)
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (existingError) throw new Error(`applications lookup failed: ${existingError.message}`);

  const found = existing?.[0];
  if (found) {
    const status = String(found.status ?? "");
    if (UNCLAIMABLE.has(status)) {
      throw new Error(
        `applications ${found.id} is already at "${status}" for job ${jobId}. A submit ` +
          `control has been clicked against this listing once already, and nothing may open ` +
          `a browser at it again without a human checking the employer's side first.`
      );
    }
    return { applicationId: String(found.id), status, created: false };
  }

  const { data: profileRows, error: profileError } = await supabase
    .from("profiles")
    .select("id,attested_at,applications_used,applications_cap")
    .eq("id", userId)
    .limit(1);
  if (profileError) throw new Error(`profiles lookup failed: ${profileError.message}`);

  const profile = profileRows?.[0];
  if (!profile) {
    throw new Error(
      `No profiles row with id ${userId}. A profile is created by signing in — see ` +
        `app/auth/callback/route.ts.`
    );
  }
  if (!profile.attested_at) {
    throw new Error(
      `Profile ${userId} has never attested to its intake. Nothing may be submitted on this ` +
        `person's behalf until they have confirmed their answers at /onboarding: every free ` +
        `text answer a run generates is their statement to an employer, and there is nothing ` +
        `behind it until they say so.`
    );
  }

  const cap = typeof profile.applications_cap === "number" ? profile.applications_cap : 0;
  const used = typeof profile.applications_used === "number" ? profile.applications_used : 0;
  if (used >= cap) {
    throw new Error(
      `Profile ${userId} has used ${used} of ${cap} applications. A cap of zero is the default ` +
        `and means this account has not been provisioned to apply yet, not that it may apply ` +
        `without limit.`
    );
  }

  const { data: inserted, error: insertError } = await supabase
    .from("applications")
    .insert({ user_id: userId, job_id: jobId, status: "discovered" })
    // Round-trips the id so a silently filtered insert surfaces as an error
    // rather than as a false success, the same way intake does.
    .select("id,status")
    .single();
  if (insertError) throw new Error(`applications insert failed: ${insertError.message}`);
  if (typeof inserted?.id !== "string") {
    throw new Error(`applications insert returned no id (got ${JSON.stringify(inserted?.id)}).`);
  }

  return {
    applicationId: inserted.id,
    status: String(inserted.status ?? "discovered"),
    created: true,
  };
}
