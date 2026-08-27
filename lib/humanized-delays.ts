// ─────────────────────────────────────────────────────────────────────────────
// JOB-212: humanized dwell times around a real submit.
//
// A real applicant does not land on an application form and start typing in the
// same tick, and a real applicant does not click Submit the instant the last
// character of the last answer is typed. Anti-spam layers on the boards we
// drive key on that gap. On 2026-08-27 a Ramp Ashby submission was flagged
// despite a 0.9 reCAPTCHA v3 score minted by the Fly harvester, and the
// timing shape of the session was the leading suspect: form reached, fields
// filled, submit clicked, all inside a couple of seconds.
//
// This module supplies the three dwell types the ticket names. Every call goes
// through `humanizedSleep()`.
//
// ── Default is OFF ────────────────────────────────────────────────────────────
// The delays are opt-in via `JOBINNO_HUMANIZE_TIMINGS=on` (or `=1`, or `=true`).
// Anything else — unset, empty, `off`, `false`, `0` — is a no-op. Main
// auto-deploys to prod, and shipping a default-on humanization would add ~30 to
// 60 seconds per run for every real user before we have measured whether it
// actually moves the anti-spam signal. The flip in prod will follow a live
// submit that validates that impact, not this merge.
//
// When the flag is off, the helper returns immediately AND logs nothing — a
// no-op has to be silent so a session with humanization off does not carry a
// misleading "waiting 0ms" line in its log.
//
// Nothing here changes *what* gets filled, only *when* — see HARD STOP 9. The
// randomness is on the clock, not on the answers.
//
// ── Where the three dwells fire ──────────────────────────────────────────────
//
//   1. `readthrough` fires once, right after ACT-007's "application form
//      reached at ..." log line in `lib/fill-application-form.ts`, before any
//      field is filled. 20–45 seconds, a person reading the page.
//   2. `field_jitter` fires between each field-fill action, both the cache
//      replayed path and the observed path. 800–3000 ms. This replaces the
//      older 300–1200 ms `randomInteractionDelayMs()` that lived in
//      `fill-application-form.ts` — same intent, wider window, single
//      configuration point. Per-character typing speed is not touched.
//   3. `presubmit_review` fires once in `lib/submit-application.ts`, right
//      before the `if (row.ats === "ashby")` block in `runSubmitPhase`. It sits
//      strictly BEFORE the point-of-no-return comment, so nothing about the
//      submit-once contract changes. 5–12 seconds.
//
// The ranges are collected here as `HUMANIZE_TIMINGS` so a follow-up ticket can
// tune them without a rename of every call site.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which of the three dwells is running. Used by the log line so a real run's
 * output makes the three phases visible without any other instrumentation.
 */
export type DwellReason = "readthrough" | "field_jitter" | "presubmit_review";

/**
 * The min/max windows for each dwell reason, in milliseconds.
 *
 * `as const` on the tuples so a typo on either bound is a compile-time error
 * rather than a silent runtime one, and so the values can be tuned without
 * widening any call site's typing.
 */
export const HUMANIZE_TIMINGS = {
  readthroughMs: [20_000, 45_000] as const,
  fieldJitterMs: [800, 3_000] as const,
  presubmitReviewMs: [5_000, 12_000] as const,
} as const;

/**
 * Whether `JOBINNO_HUMANIZE_TIMINGS` is set to an enabling value. Kept private
 * to this module because the whole point of the flag is that the call sites
 * don't have to know about it — `humanizedSleep` gates internally.
 *
 * The accepted enable values are `on`, `1`, and `true` (case-insensitive,
 * whitespace-tolerant). Anything else is off — including unset, empty, and
 * the explicit disables (`off`, `0`, `false`) — so a mis-spelled value fails
 * safe to the default rather than silently enabling humanization in prod.
 */
function humanizationEnabled(): boolean {
  const raw = process.env.JOBINNO_HUMANIZE_TIMINGS;
  if (raw === undefined) return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "on" || trimmed === "1" || trimmed === "true";
}

/**
 * Wait a random amount of time in `[minMs, maxMs]` inclusive when
 * `JOBINNO_HUMANIZE_TIMINGS=on` is set. Otherwise return immediately and log
 * nothing.
 *
 * The log line, when it fires, is deliberately loud — a real run's log is how
 * JOB-213 will later corroborate that a session's timing shape looked
 * plausible, and how a human debugging a slow run can tell paint from wait.
 */
export async function humanizedSleep(
  reason: DwellReason,
  minMs: number,
  maxMs: number
): Promise<void> {
  if (!humanizationEnabled()) return;
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  const ms = Math.floor(Math.random() * (hi - lo + 1)) + lo;
  console.log(`[humanize] dwell for ${reason}: waiting ${ms}ms`);
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
