/**
 * JOB-113 — getting a consent banner out from in front of the submit button,
 * without agreeing to anything on the candidate's behalf.
 *
 * ── The run that caused this ────────────────────────────────────────────────
 * A Palantir listing on Lever filled completely (90 controls, zero unanswerable
 * fields), the submit control was clicked, and the result was
 * `submission_unconfirmed` with the form still on screen. No validation error
 * anywhere on a 12,137 pixel tall capture, and no mail to the candidate. What
 * the page did have was a cookie consent banner pinned across the bottom of the
 * viewport.
 *
 * Measured on the live page rather than assumed, and it is exact:
 *
 *   · the banner is `position: fixed`, `z-index: 9999`, `pointer-events: auto`,
 *     and occupies viewport y 996 to 1080 — the bottom 84 pixels, full width,
 *     at every scroll position;
 *   · `SUBMIT APPLICATION` sits at document y 11729 with the document 12137
 *     tall, so bringing it into view by the minimum scroll — which is what
 *     `scrollIntoView({ block: "nearest" })` does, and what an automation engine
 *     does before a click — leaves it at viewport y 1040 to 1081;
 *   · those overlap, and `document.elementFromPoint` at the button's own centre
 *     returns a `<p>` **inside the banner**. The button is not the top element
 *     at its own centre point.
 *
 * That is the whole "clicked, and nothing happened" signature. The click is
 * dispatched, the banner eats it, the form never posts, and so the board never
 * says anything was wrong — because as far as the board is concerned nothing was
 * ever submitted. A run reports "clicked" because a click really did go out.
 *
 * ── Why a model drives this and not a selector table ────────────────────────
 * Everywhere else in this pipeline the answer to "should a model decide this?"
 * is no, because the thing being decided is a claim about the candidate and a
 * wrong one is a fabricated attestation (HARD STOP 9). None of that applies
 * here. Dismissing page furniture asserts nothing about anybody, so the reason
 * to be deterministic is absent, and the reason to use a model is present:
 * consent banners, modals and interstitials are exactly the unpredictable
 * surface an enumeration of selectors is worst at and a model is best at.
 *
 * So discovery is a model call. Two things are deliberately **not** left to it.
 *
 * **1. It may never accept.** Accept is the visually prominent button on nearly
 * every one of these, and a model told "dismiss this banner" will reach for it.
 * Accepting agrees to cookie processing in the candidate's name, which is a
 * consent decision belonging to them — the same class of thing
 * `CONSENT_FIELD_RE` already routes away from being answered automatically —
 * and declining is the privacy preserving default besides. `readsAsRefusal`
 * below enforces that on the control's own DOM text, not on the model's account
 * of it, and it fails closed: anything ambiguous is left alone. A banner with no
 * refusal at all is left in place and recorded, never accepted quietly.
 *
 * **2. `act()` is not evidence.** `stagehand.act()` does not throw when it
 * changes nothing, and that exact property is what let PR #92's
 * `useUnstructuredAct` report a filled field the board showed as empty. It was
 * removed for it. So the banner is read back out of the DOM afterwards, and this
 * module reports what is actually true rather than that a call returned.
 */

import { type Page } from "@browserbasehq/stagehand";
import { inPageError, inPageExpression } from "@/lib/form-fields";
import { describeControl } from "@/lib/fill-application-form";
import { tryResolveAction, type BrowserSession } from "@/lib/stagehand-session";

const LOG = "[job-113]";

// ───────────────────────────────────
// The instructions — every one a constant
// ───────────────────────────────────

/**
 * The same discipline as `INSTRUCTIONS` in `fill-application-form.ts` and
 * `submit-application.ts`: every natural-language string this module hands a
 * model is a compile-time constant, so no page text can ever reach a model as an
 * instruction. A consent banner is attacker-controlled text like any other part
 * of a page, and it is read here only as data.
 */
const INSTRUCTIONS = Object.freeze({
  /**
   * Names the refusal directly. The model is being asked to find one specific
   * control, not to decide what to do about the banner — the decision was made
   * here, in source, and `readsAsRefusal` checks the answer against it.
   */
  DECLINE_CONSENT:
    "the button on the cookie or privacy consent banner that refuses, denies, rejects or " +
    "declines optional cookies",
  /**
   * Only reached when there is no refusal. Closing a banner is not consenting to
   * it, so this is preferred over leaving an overlay across the submit control —
   * but it is still checked against a vocabulary and still recorded separately
   * from a real refusal.
   */
  DISMISS_CONSENT:
    "the close or dismiss control on the cookie or privacy consent banner, the one that puts " +
    "the banner away without agreeing to anything",
});

// ───────────────────────────────────
// The vocabularies
// ───────────────────────────────────

/**
 * Words that make a control a refusal.
 *
 * Kept next to `CONSENT_ACCEPT_RE` on purpose: the pair is the whole safety
 * argument of this module and reading one without the other is how it would get
 * loosened by accident.
 */
export const CONSENT_REFUSE_RE =
  /\b(deny|denies|decline[sd]?|reject(s|ed)?|refuse[sd]?|opt[\s-]?out|necessary only|essential only|strictly necessary|only necessary|only essential|no,?\s*thanks?|disagree|do\s*not\s*(accept|agree|allow|consent|sell|share)|don'?t\s*(accept|agree|allow|consent))\b/i;

/** Words that make a control an acceptance. Never clicked by this module. */
export const CONSENT_ACCEPT_RE =
  /\b(accept|agree|allow|consent|approve|enable|got\s*it|understood|i\s*understand|okay|ok|yes|continue|confirm)\b/i;

/**
 * Words that make a control a neutral close rather than either answer.
 *
 * The symbols are matched as the control's whole text rather than as a word,
 * for two reasons. `\b` is a boundary between a word character and a non-word
 * one, so it never matches beside `×` at all — the alternation looked right and
 * was dead. And a lone glyph is only a close button when it is the entire label:
 * an `×` inside a sentence is punctuation.
 */
export const CONSENT_DISMISS_RE =
  /\b(close|dismiss|hide|not\s*now|later)\b|^\s*[x×✕✖✖⨯]\s*$/i;

/**
 * Words that make a fixed overlay a consent notice rather than some other piece
 * of page furniture. Shared with the in-page detector below, so there is one
 * list rather than two that drift.
 */
const CONSENT_TEXT_WORDS: readonly string[] = [
  "cookie",
  "cookies",
  "consent",
  "privacy notice",
  "privacy policy",
  "gdpr",
  "tracking",
  "your privacy",
];

/**
 * Is this control safe to click as a refusal?
 *
 * Fails closed, and the ambiguity rule is the point. A control has to read as a
 * refusal, and once the refusal wording is taken out of it, whatever is left
 * must not read as an acceptance. So "Deny" passes, "Do not accept" passes (the
 * refusal phrase swallows the word `accept`), "Accept" is refused for having no
 * refusal in it at all, and a container whose text is "Accept all Reject all" is
 * refused for being both — which is exactly the case where clicking the wrong
 * half is a consent the candidate never gave.
 */
export function readsAsRefusal(text: string): { ok: boolean; why: string } {
  const normalised = text.replace(/\s+/g, " ").trim();
  if (normalised === "") {
    return { ok: false, why: "the control has no text to check" };
  }
  if (!CONSENT_REFUSE_RE.test(normalised)) {
    return {
      ok: false,
      why: `${JSON.stringify(normalised.slice(0, 80))} does not read as a refusal`,
    };
  }
  const remainder = normalised.replace(new RegExp(CONSENT_REFUSE_RE.source, "gi"), " ");
  if (CONSENT_ACCEPT_RE.test(remainder)) {
    return {
      ok: false,
      why:
        `${JSON.stringify(normalised.slice(0, 80))} reads as both a refusal and an acceptance, ` +
        `so which half a click lands on is a guess`,
    };
  }
  return { ok: true, why: `${JSON.stringify(normalised.slice(0, 80))} reads as a refusal` };
}

/** The same test for a neutral close, which must not read as an acceptance either. */
export function readsAsNeutralDismissal(text: string): { ok: boolean; why: string } {
  const normalised = text.replace(/\s+/g, " ").trim();
  if (normalised === "") return { ok: false, why: "the control has no text to check" };
  if (!CONSENT_DISMISS_RE.test(normalised)) {
    return {
      ok: false,
      why: `${JSON.stringify(normalised.slice(0, 80))} does not read as a close control`,
    };
  }
  if (CONSENT_ACCEPT_RE.test(normalised)) {
    return {
      ok: false,
      why:
        `${JSON.stringify(normalised.slice(0, 80))} reads as an acceptance as well as a close, ` +
        `and this module never accepts on the candidate's behalf`,
    };
  }
  return { ok: true, why: `${JSON.stringify(normalised.slice(0, 80))} reads as a neutral close` };
}

// ───────────────────────────────────
// Reading the banner out of the DOM
// ───────────────────────────────────

export type ConsentOverlayFacts = {
  /** A visible, click-intercepting overlay whose text reads as a consent notice. */
  present: boolean;
  /** Its viewport rect, for the log. Null when there is none. */
  rect: { x: number; y: number; w: number; h: number } | null;
  /** A short excerpt of its text, sanitised for the log. Never an instruction. */
  excerpt: string;
  /** True when it carries controls that answer the consent question. */
  hasConsentControls: boolean;
};

const NO_OVERLAY: ConsentOverlayFacts = {
  present: false,
  rect: null,
  excerpt: "",
  hasConsentControls: false,
};

/** How much banner text is kept for the log. Enough to recognise it, no more. */
const MAX_BANNER_EXCERPT_CHARS = 160;

/**
 * The same treatment `sanitizePageText` gives every other piece of captured
 * board text in this pipeline. Kept as its own function rather than inlined so
 * the character class stays readable in source: written as literal control
 * characters it is invisible, and an invisible regex is one nobody can review.
 */
function sanitizeBannerText(text: string): string {
  const cleaned = text
    // C0 and C1 control characters, plus DEL.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_BANNER_EXCERPT_CHARS
    ? `${cleaned.slice(0, MAX_BANNER_EXCERPT_CHARS)}…`
    : cleaned;
}

/**
 * Serialised into the page, so it must be self-contained: no imports and no
 * closure over anything in this module. See `inPageExpression` for why it
 * travels as a string and why the `__name` shim matters.
 *
 * It looks for the property that actually causes the bug rather than for a known
 * banner: an element that is `fixed` or `sticky`, really visible, really taking
 * pointer events, and whose text reads as a consent notice. That is what can sit
 * on top of a button and swallow a click, whichever vendor shipped it.
 */
function findConsentOverlayInPage(words: readonly string[]): ConsentOverlayFacts {
  const empty: ConsentOverlayFacts = {
    present: false,
    rect: null,
    excerpt: "",
    hasConsentControls: false,
  };
  const accept = /\b(accept|agree|allow|consent|got it|ok|okay)\b/i;
  const refuse = /\b(deny|decline|reject|refuse|opt.?out|necessary|essential|no thanks)\b/i;

  const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));
  for (const el of all) {
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(el);
    } catch {
      continue;
    }
    if (style.position !== "fixed" && style.position !== "sticky") continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (style.pointerEvents === "none") continue;
    if (Number(style.opacity || "1") < 0.05) continue;

    const rect = el.getBoundingClientRect();
    // Too small to cover a button, or collapsed away by a close animation.
    if (rect.width < 80 || rect.height < 24) continue;

    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (text === "" || text.length > 3000) continue;
    const lower = text.toLowerCase();
    let matched = false;
    for (const word of words) {
      if (lower.indexOf(word) !== -1) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;

    // Prefer the outermost match: a child of an already-reported banner is the
    // same banner. Skip anything whose ancestor also qualifies.
    let ancestorQualifies = false;
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.position === "fixed" || parentStyle.position === "sticky") {
        const parentText = (parent.innerText || "").toLowerCase();
        for (const word of words) {
          if (parentText.indexOf(word) !== -1) {
            ancestorQualifies = true;
            break;
          }
        }
      }
      if (ancestorQualifies) break;
      parent = parent.parentElement;
    }
    if (ancestorQualifies) continue;

    const controls = Array.from(el.querySelectorAll("button, a, [role='button'], input[type='button']"));
    let hasConsentControls = false;
    for (const control of controls) {
      const label = ((control as HTMLElement).innerText || (control as HTMLInputElement).value || "").trim();
      if (accept.test(label) || refuse.test(label)) {
        hasConsentControls = true;
        break;
      }
    }

    return {
      present: true,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      excerpt: text.slice(0, 160),
      hasConsentControls,
    };
  }
  return empty;
}

/**
 * Asks the DOM whether a consent overlay is currently in the way.
 *
 * Never throws. A page this cannot read is reported as having no banner, and the
 * caller carries on — a perception failure here must not be able to stop a run
 * that is otherwise ready to submit a correctly filled form.
 */
export async function readConsentOverlay(page: Page): Promise<ConsentOverlayFacts> {
  try {
    const result = await page.evaluate(
      inPageExpression(findConsentOverlayInPage, JSON.stringify(CONSENT_TEXT_WORDS))
    );
    const failure = inPageError(result);
    if (failure !== null) {
      console.warn(`${LOG} could not read the page for a consent banner: ${failure}`);
      return NO_OVERLAY;
    }
    const raw = result as Partial<ConsentOverlayFacts> | null;
    if (!raw || typeof raw !== "object") return NO_OVERLAY;
    return {
      present: raw.present === true,
      rect:
        raw.rect && typeof raw.rect === "object"
          ? {
              x: Number(raw.rect.x) || 0,
              y: Number(raw.rect.y) || 0,
              w: Number(raw.rect.w) || 0,
              h: Number(raw.rect.h) || 0,
            }
          : null,
      // Page text, so it is sanitised exactly the way `sanitizePageText` does
      // it in `submit-application.ts`: control characters out, whitespace
      // collapsed, length capped. A board is free to put an ANSI escape
      // sequence in its banner text; a terminal printing this back later is not
      // free to interpret one. It reaches a log and nothing else.
      excerpt: typeof raw.excerpt === "string" ? sanitizeBannerText(raw.excerpt) : "",
      hasConsentControls: raw.hasConsentControls === true,
    };
  } catch {
    return NO_OVERLAY;
  }
}

/**
 * How long to keep asking whether the banner has gone, after clicking it away.
 *
 * This is not padding. These banners close on a CSS transition, and reading the
 * DOM once immediately after the click catches the banner mid-fade: measured on
 * the live Lever page, a `Deny` click that genuinely worked — the page ended up
 * with `cookieconsent_status=deny` and the submit button reachable — still read
 * as present on the first look and only went away about a second later. A
 * verification that reads too early is exactly as wrong as one that never reads
 * at all, and this one would have reported a working dismissal as a failure and
 * then spent a second model call trying to fix it.
 */
const BANNER_GONE_TIMEOUT_MS = 6_000;
const BANNER_GONE_POLL_MS = 400;

/**
 * Polls `readConsentOverlay` until the banner is gone, or time runs out.
 *
 * Returns the last reading either way, so the caller reports what the page
 * finally said rather than what it said first.
 */
async function waitForConsentOverlayGone(page: Page): Promise<ConsentOverlayFacts> {
  const deadline = Date.now() + BANNER_GONE_TIMEOUT_MS;
  let facts = await readConsentOverlay(page);
  while (facts.present && Date.now() < deadline) {
    try {
      await page.waitForTimeout(BANNER_GONE_POLL_MS);
    } catch {
      // A page that will not wait is a page that will not be read again either.
      break;
    }
    facts = await readConsentOverlay(page);
  }
  return facts;
}

// ───────────────────────────────────
// Getting it out of the way
// ───────────────────────────────────

export type ConsentBannerAction =
  /** No consent overlay was in the way. No model was called. */
  | "none"
  /** A refusal control was found, clicked, and the banner is gone. */
  | "declined"
  /** No refusal existed; a neutral close was clicked and the banner is gone. */
  | "dismissed"
  /**
   * A banner is present and still is. Either nothing safe to click was found, or
   * something was clicked and the read-back says it did not work. Never means
   * "accepted": this module has no path that accepts.
   */
  | "left-in-place";

export type ConsentBannerOutcome = {
  /** Whether a consent overlay was in the way when this ran. */
  present: boolean;
  action: ConsentBannerAction;
  /** One line for the run log, naming what was seen and what was done about it. */
  detail: string;
};

/**
 * Takes a consent banner out of the way of the page, refusing rather than
 * accepting, and reports what actually happened.
 *
 * Never throws. Every failure mode returns `left-in-place` with a reason,
 * because the caller's next move is a submit click that is worth attempting
 * either way — a banner that could not be dismissed makes a click less likely to
 * land, not unsafe to try, and the outcome is read from the page afterwards
 * regardless.
 *
 * The `detail` is written into the run log by the caller on purpose, so that a
 * future "submit clicked, nothing happened" can be told apart from this cause
 * instead of being investigated from scratch a second time.
 */
export async function dismissConsentBanner(
  session: BrowserSession,
  url: string
): Promise<ConsentBannerOutcome> {
  const before = await readConsentOverlay(session.page);
  if (!before.present) {
    return { present: false, action: "none", detail: "no consent banner was in the way" };
  }

  const seen =
    `a consent banner is on the page at ${before.rect?.w ?? 0}x${before.rect?.h ?? 0} ` +
    `(viewport y ${before.rect?.y ?? 0}), reading ${JSON.stringify(before.excerpt)}`;
  console.log(`${LOG} ${seen}`);

  // Refusal first, and only then a neutral close. Never an acceptance: there is
  // no third attempt and no vocabulary here that would allow one.
  const attempts: readonly {
    instruction: string;
    check: (text: string) => { ok: boolean; why: string };
    action: ConsentBannerAction;
    what: string;
  }[] = [
    {
      instruction: INSTRUCTIONS.DECLINE_CONSENT,
      check: readsAsRefusal,
      action: "declined",
      what: "refuse",
    },
    {
      instruction: INSTRUCTIONS.DISMISS_CONSENT,
      check: readsAsNeutralDismissal,
      action: "dismissed",
      what: "close",
    },
  ];

  const refusals: string[] = [];
  for (const attempt of attempts) {
    let resolved;
    try {
      resolved = await tryResolveAction(session, url, attempt.instruction);
    } catch (err) {
      refusals.push(
        `looking for a control to ${attempt.what} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    if (resolved === null) {
      refusals.push(`no control to ${attempt.what} was found on the banner`);
      continue;
    }

    // The model's own `description` is its account of the page and cannot check
    // itself — `describeControl`'s header makes this argument at length. So the
    // accept/refuse decision is taken on the control's real DOM text, and the
    // description is only used when the DOM will not give one up.
    const descriptor = await describeControl(session.page, resolved.action.selector);
    const domText = descriptor.found ? `${descriptor.text} ${descriptor.haystack}`.trim() : "";
    const subject = domText !== "" ? domText : resolved.action.description;
    const source = domText !== "" ? "its DOM text" : "the reader's description only";
    const verdict = attempt.check(subject);
    if (!verdict.ok) {
      refusals.push(
        `the control offered to ${attempt.what} was not clicked — ${verdict.why} (${source})`
      );
      continue;
    }

    console.log(`${LOG} clicking the banner's ${attempt.what} control — ${verdict.why}`);
    try {
      await session.stagehand.act(
        { selector: resolved.action.selector, description: attempt.instruction, method: "click" },
        { page: session.page }
      );
    } catch (err) {
      refusals.push(
        `clicking the ${attempt.what} control threw: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    // `act()` returning is not evidence of anything. Read the page back — and
    // keep reading for a moment, because these things close on a transition.
    const after = await waitForConsentOverlayGone(session.page);
    if (!after.present) {
      const detail = `${seen}; its ${attempt.what} control was clicked and the banner is gone`;
      console.log(`${LOG} ${detail}`);
      return { present: true, action: attempt.action, detail };
    }
    refusals.push(
      `the ${attempt.what} control was clicked but the banner is still on the page ` +
        `(${JSON.stringify(after.excerpt)})`
    );
  }

  const detail =
    `${seen}; it was NOT dismissed and nothing was accepted — ${refusals.join("; ")}. ` +
    `A banner pinned to the bottom of the viewport can sit on top of a submit control and ` +
    `swallow the click, so a submission that reports no confirmation after this may have this ` +
    `as its cause.`;
  console.warn(`${LOG} ${detail}`);
  return { present: true, action: "left-in-place", detail };
}
