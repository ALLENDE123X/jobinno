/**
 * JOB-117 — what counts as "another step of the same application", in one place.
 *
 * These three patterns and the predicate over them were written by JOB-106 and
 * lived inside `submit-application.ts`, where the only question being asked was
 * "did the click I just made land on a receipt or on more form?". JOB-117 asks
 * the same question from the other side of the pipeline — `fill-application-form.ts`
 * presses Next and needs to know whether the board actually advanced a step — and
 * the answer has to be the same answer, not a second opinion that can drift away
 * from the first one.
 *
 * So they moved here rather than being copied. `submit-application.ts` still
 * exports `readsAsFurtherStep` with its original signature and its original
 * meaning; it delegates. The regression test that pins that function against the
 * real Avery Dennison capture is untouched and still passes, which is the point:
 * this is a move, not a rewrite.
 *
 * Nothing in this module reads page text as an instruction. It matches two
 * strings the browser reports about itself — a URL and a tab title — against
 * compile-time patterns, and returns a boolean.
 */

import { samePage } from "@/lib/stagehand-session";

/**
 * A destination that announces a completed submission.
 *
 * Written by JOB-106, and its warning is worth keeping in front of anyone who
 * edits it: these patterns are tested against a URL *path*, and job titles are
 * routinely slugged into paths. A bare `success` here would read "Customer
 * Success Engineer" as a receipt, a bare `received` or `submitted` would do the
 * same to any title containing them, and the effect would be this whole guard
 * switching itself off for a common class of role. Every entry below is
 * therefore either a phrase no job title contains, or a word no job title
 * contains.
 */
export const CONFIRMATION_DESTINATION_RE =
  /thank[-\s_]?you|\bthanks\b|\bconfirmation\b|application[-\s_]+(?:submitted|received|complete)|submitted[-\s_]+successfully|(?:has|have)[-\s_]+been[-\s_]+(?:submitted|received)|submission[-\s_]+received|received[-\s_]+your[-\s_]+application/i;

/**
 * A path segment that names a further step of an application.
 *
 * Grounded rather than guessed. SmartRecruiters' oneclick-ui ships its own route
 * to title map in its i18n bundle, and it has exactly two entries:
 * `page.title.prefix.form` = "Easy apply" and `page.title.prefix.screening` =
 * "Preliminary questions". `/screening` below is that route, read off the board
 * rather than imagined, and it is the one the failing run landed on.
 *
 * The rest are its close cousins across boards, kept to segments that can only
 * be a step. Deliberately **absent**: `apply`, `form`, `application` and
 * `review`. Those name the form's own page as often as a step, and this
 * predicate must never fire on a board that answers a submit in place.
 */
export const FURTHER_STEP_PATH_RE =
  /(?:^|\/)(?:screening|screening[-_]questions|questions|additional[-_]?info(?:rmation)?|additional[-_]questions|assessment|eeo|demographics?|voluntary[-_]?(?:self[-_]?identification|disclosures?)|step[-_]?\d*)(?:\/|$)/i;

/**
 * A page title that names a further step of an application.
 *
 * "Preliminary questions" is SmartRecruiters' own string for the screening step,
 * not a phrase inferred from one capture: it is the value of
 * `oneclick-ui.page.title.prefix.screening` in the board's shipped i18n bundle,
 * and the board prefixes the tab title with it on every screening page.
 *
 * Checked whether or not the board navigated, because a single page wizard can
 * advance a step without changing its URL and will still retitle itself. Kept to
 * names that can only be a further step: "Easy apply" is **not** here, because a
 * board that confirms in place keeps its original title and would be wrongly
 * vetoed by it.
 */
export const FURTHER_STEP_TITLE_RE =
  /\bpreliminary\s+questions\b|\badditional\s+questions\b|\bscreening\s+questions\b|\badditional\s+information\b|\bstep\s+\d+\s+of\s+\d+\b/i;

/** The path of a URL, or the whole string when it will not parse as one. */
export function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Whether the page now on screen reads as another step of the same application
 * rather than as a receipt. `wasAt` is the URL the page was on immediately
 * before whatever action is being judged.
 *
 * The ordering inside is deliberate rather than incidental, and JOB-106's
 * reasoning for it transfers unchanged to JOB-117's use of it: the two ways of
 * being wrong here are not equally bad. Reading a step as a receipt writes
 * `submitted`, which is terminal and never revisited; reading a receipt as a
 * step writes `submission_unconfirmed`, which a human then looks at. Where the
 * signals disagree, this yields to the reading whose failure is recoverable.
 */
export function pageReadsAsFurtherStep(title: string, url: string, wasAt: string): boolean {
  // A board's own name for the step it has put on screen is the most specific
  // thing either half of this can say, so it is checked first and it wins.
  if (FURTHER_STEP_TITLE_RE.test(title)) return true;
  const path = urlPath(url);
  // A destination that announces a completed submission is not a further step,
  // however step-shaped its URL is. Checked against both halves, so that a thank
  // you page at `/application/questions/confirmation` is not read as a step by
  // its own path.
  if (CONFIRMATION_DESTINATION_RE.test(path) || CONFIRMATION_DESTINATION_RE.test(title)) {
    return false;
  }
  // The path is only meaningful when the board actually went somewhere. When it
  // stayed put, the path under examination is the form's own, and asking whether
  // it looks like a step is asking about the page we started on.
  if (samePage(url, wasAt)) return false;
  return FURTHER_STEP_PATH_RE.test(path);
}
