/**
 * ACT-015 — perception and action for arbitrary application-form fields.
 *
 * ACT-007 could only fill fields somebody had enumerated in advance: its
 * `INSTRUCTIONS` object listed first name, last name, email, phone, LinkedIn,
 * website, resume and cover letter, and `buildFieldPlan` walked exactly that
 * list. Everything else on a real form — a country dropdown, "Why do you want to
 * work here?", three work-authorization questions, four EEO selects — was
 * structurally invisible, so a Discord Greenhouse form came out with nine
 * required fields blank and could not have passed the board's own validation.
 *
 * This module supplies the two halves of the fix that do **not** involve a
 * language model, and that is the whole point of it being a separate file:
 *
 *  1. **Perception** (`enumerateFormFields`, `harvestOptions`) — reads the DOM
 *     and reports every control on the page: its visible label, its kind, its
 *     required flag, whether it already holds a value, and for option-based
 *     controls the actual option strings a human would see. This is
 *     `document.querySelectorAll` and nothing else. There is no model in it, so
 *     there is nothing here for a hostile form label to influence.
 *
 *  2. **Action** (`applyFieldValue`) — puts one decided value into one control
 *     through Playwright-style locators derived from the perception pass, and
 *     reads it back. Typing a string, choosing a listed option and ticking a box
 *     are deterministic operations once you hold the element; none of them needs
 *     inference, and none of them is performed by handing page-derived text to
 *     something that can act on it.
 *
 * The **decision** half — which value belongs in which field — is deliberately
 * not here. It lives in `resume-parser.ts` (`decideFieldAnswers`), the module
 * that already owns the no-tools LLM path and `assertNoActionSurface()`. So the
 * three concerns that ACT-007 fused are three separate things again: reading a
 * page (this file, no model), deciding an answer (`resume-parser.ts`, a model
 * with no tools), and performing it (this file, no model).
 *
 * ── What "no natural-language instruction" means here ───────────────────────
 * `create-board-account.ts` builds one `act()` instruction from a page-derived
 * label, and earlier reviews flagged that as the residual injection risk in this
 * repo. Nothing in this file does that. Every write goes through
 * `page.locator(selector)` with a selector this module computed from the DOM
 * itself, and every value is passed as an argument to `fill` / `click` /
 * `selectOption`. A form label never becomes a sentence a model reads.
 */

import { type Page } from "@browserbasehq/stagehand";
import { matchAtsHost } from "@/lib/ats-boards";

/** What a control is, as far as filling it in is concerned. */
export type FormFieldKind =
  | "text"
  | "textarea"
  | "select"
  | "combobox"
  | "radio"
  | "checkbox"
  | "file"
  | "other";

/** One control on the page, as the DOM describes it. */
export type EnumeratedField = {
  /**
   * Stable, human-meaningful handle for this field: the visible label, folded to
   * lower case with runs of whitespace collapsed, disambiguated with a numeric
   * suffix when a form repeats a label.
   *
   * It is what `needsInput[].key` reports and what `additionalAnswers` is keyed
   * on, so it has to be something a person can type back without having seen a
   * selector. Derived from the label rather than minted, so the same form
   * produces the same keys on a later, stateless re-run — which is what makes
   * the ask/answer/resume loop work without storing anything.
   */
  key: string;
  /** The element holding the value. Where `fill`/`inputValue` are aimed. */
  selector: string;
  /**
   * What to click to open this control's menu, innermost first.
   *
   * A list rather than a guess, because guessing was wrong. A react-select
   * combobox's real `<input>` is a grid cell inside `.select__input-container`
   * inside `.select__value-container` inside `.select__control`, and *only the
   * outermost of those actually opens the menu* — verified on Discord's live
   * Greenhouse form, where clicking the container left `aria-expanded="false"`
   * and clicking the control set it to `"true"`. Rather than encode one
   * board's DOM, `openMenu` walks this ladder and stops at the first rung that
   * demonstrably opened something.
   */
  activateSelectors: string[];
  /** The visible label a sighted applicant reads, with any `*` marker stripped. */
  label: string;
  kind: FormFieldKind;
  required: boolean;
  /** What the control currently holds. `""` when empty. */
  currentValue: string;
  /** Option strings, when they are known. Empty when unknown or none. */
  options: string[];
  /** One selector per entry in `options`, when the options are individually addressable. */
  optionSelectors: string[];
  /**
   * For a native `<select>` only: each option's `value` attribute, aligned with
   * `options`.
   *
   * Kept apart from the visible text because they are different things and the
   * browser only accepts one of them: `<option value="1">Yes</option>` is chosen
   * by "1", while everything else in this module — the decision call, the policy
   * checks, the report — speaks in the words a human reads. This is the one
   * place the two are translated between.
   */
  optionValues: string[];
  /** False when the options exist but have not been read (an unopened menu). */
  optionsKnown: boolean;
  /** True when `options` is a prefix of a longer list. */
  optionsTruncated: boolean;
  /** `maxlength`, when the control declares one. */
  maxLength: number | null;
  /** Help/description text attached to the control, capped. */
  helpText: string;
};

/** Most option lists are yes/no or a dozen items; a country list is 250. */
const MAX_OPTIONS_REPORTED = 60;

/** A form with more controls than this is not a form, it is a page of tables. */
const MAX_FIELDS = 150;

/** How long one rung of the activation ladder gets before the next is tried. */
const MENU_ATTEMPT_TIMEOUT_MS = 1_500;
/** How long a search control gets to answer a typed query. */
const MENU_SEARCH_TIMEOUT_MS = 4_000;
/**
 * Above this many options, the list is narrowed by typing before anything is
 * clicked.
 *
 * Not a performance tweak — a correctness one, and it was earned. Clicking the
 * correctly-identified first entry of Greenhouse's 244-option phone-country menu
 * selected Afghanistan: a long menu is a scrolling viewport, and an option's
 * position in the document is not where it is painted. Typing the value first
 * collapses the list to a handful, which is short enough to be entirely on
 * screen. The read-back check is what caught it, and is still what backstops it.
 */
const MAX_UNFILTERED_MENU_OPTIONS = 25;
const MENU_POLL_MS = 150;
/** How long a control gets to render the selection after its option is clicked. */
const MENU_SETTLE_TIMEOUT_MS = 1_500;

// ───────────────────────────────────
// Policy patterns — deterministic, and applied outside the model
// ───────────────────────────────────

/**
 * Demographic self-identification questions.
 *
 * Matched against the field's own label, in TypeScript, *before and after* the
 * decision call — so the "never assert a demographic identity for a real person"
 * rule does not depend on a model having read its instructions properly. A field
 * matching this can only ever be declined, asked about, or left alone.
 *
 * `military` and `armed forces` are here because a board does not have to use
 * the word "veteran" to be asking veteran status: Point72's Greenhouse form
 * asks "Have you served in the military?", which this pattern used to miss
 * entirely, leaving a protected characteristic to be answered by a model and
 * transmitted to an employer. Veteran status is never inferred and never sent,
 * whatever a form calls it. A defense employer asking about experience with
 * military customers is caught by this too and is escalated rather than
 * answered, which is the safe direction to be wrong in and the same trade
 * `holdsSubmitControl` below makes.
 */
export const EEO_FIELD_RE =
  /\b(gender|sex|race|races|ethnicity|ethnic|hispanic|latino|latinx|veteran|militar\w*|armed forces|disabilit\w*|sexual orientation|lgbt\w*|queer|transgender|self[-\s]?identif\w*|demographic\w*)\b/i;

/**
 * An option that answers "I would rather not say" — which is a truthful answer
 * to a demographic question, and the only one this system will ever give.
 *
 * Wide on purpose: boards word it as "Decline to self identify", "I don't wish
 * to answer", "I do not want to answer", "Prefer not to say", "I choose not to
 * disclose". Every one of them means the same thing, and picking none of them
 * because the wording was unexpected would leave a required field blank.
 */
export const DECLINE_OPTION_RE =
  /(decline|prefer\s+not|don'?t\s+wish|do\s+not\s+wish|don'?t\s+want\s+to\s+answer|do\s+not\s+want\s+to\s+answer|rather\s+not|choose\s+not|not\s+to\s+(?:say|answer|disclose|identify)|no\s+answer|unspecified)/i;

/**
 * Boxes that record a legal agreement rather than a fact.
 *
 * Ticking one of these on somebody's behalf is making a commitment in their
 * name, which is a different act from reporting where they live. They are always
 * escalated to the user, never inferred.
 *
 * `acknowledg\w*` and `privacy polic\w*` carry the `\w*` because they are
 * stems: the trailing `\b` after the group otherwise demands the alternative
 * end at a word boundary, so the bare stems could never match the
 * "acknowledgement" or "privacy policy" a real form writes (found on issue
 * #94 when Lever's processing-consent card, whose only consent-flavoured
 * words are "candidate privacy policy", failed to match this).
 *
 * ── Issue #100: the wordings this used to miss ───────────────────────────────
 * A live Avery Dennison run ticked a box reading "By checking this box you
 * declare that you have read and understood the Privacy Notice" and reported
 * nothing, because this pattern matched no part of that sentence. Three near
 * misses, each one word away from a term already here:
 *
 *  · `declaration` was here, `declare` was not. A form writes the verb far more
 *    often than the noun, so the stem `declar\w*` replaces both.
 *  · `privacy polic\w*` was here, "Privacy Notice" was not. The same document
 *    under a different masthead, and boards use "notice" and "statement" as
 *    freely as "policy".
 *  · `i understand` was here, "read and understood" was not, because the
 *    sentence is written in the second person and puts "and" in the middle.
 *
 * The lesson generalises past those three strings, and it is why item 2 of that
 * issue does not rely on this pattern at all: a regex only ever holds the
 * wordings somebody thought of. This one is now wide enough for the agreements
 * seen in production, and it is still not the thing standing between a real
 * person and an assertion made in their name. See `fallbackRefusalReason` in
 * `fill-application-form.ts` for what is.
 *
 * Two deliberate narrowings, so that widening does not start catching ordinary
 * questions. `certify` stays spelled out rather than becoming `certif\w*`,
 * because "certificate" is a skills question ("Do you hold an AWS
 * certificate?") and not an agreement. And "have read" is bound to a pronoun,
 * so "I have read" and "you have read" match while "which of these have you
 * read" does not.
 */
export const CONSENT_FIELD_RE =
  /\b(agree|agreement|consent\w*|certify|certifies|certifying|certification|acknowledg\w*|attest\w*|authorize|terms|privacy\s+(?:polic\w*|notice\w*|statement\w*)|data\s+protection|gdpr|(?:i|you|we)\s+confirm|(?:i|you|we)\s+understand|(?:i|you|we)\s+have\s+read|read\s+and\s+(?:underst\w*|accept\w*|agree\w*)|declar\w*)\b/i;

/** Comparison form for labels, options and values. Never used for display. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The option in `options` that declines to answer, or null. */
export function findDeclineOption(options: readonly string[]): string | null {
  return options.find((option) => DECLINE_OPTION_RE.test(option)) ?? null;
}

/**
 * JOB-262. A wider set of decline shaped phrasings than `DECLINE_OPTION_RE`
 * matches, for the narrow SmartRecruiters and Breezy carve out described on
 * `resolveDecision`'s EEO branch in `fill-application-form.ts`.
 *
 * Adds "N/A" and "not applicable", the two honest adjacent phrasings a real
 * Bosch Group and Wabtec Engineering form on SmartRecruiters, and a real
 * VetsEZ Tampa Cloud Integration form on Breezy, each offered on a required
 * self identification question on 2026 08 28 without offering anything
 * `DECLINE_OPTION_RE` recognises. Neither phrase states a demographic
 * identity; both report that the candidate is not making a claim, which is
 * the same statement "prefer not to answer" makes in different words.
 *
 * Deliberately additive rather than a change to `DECLINE_OPTION_RE` itself.
 * That pattern also gates the legal attestation ladder (`declineOrAsk`) and
 * every other board's demographic questions, and widening it there was never
 * asked for and was never verified against a real form on those boards.
 *
 * The two new alternatives are anchored to the whole (trimmed) option with
 * `^` and `$`, not left as a bare word boundary match. A red team review of
 * this PR reproduced a compound option, "Not Applicable — I am not a
 * protected veteran", the exact OFCCP style phrasing a real Workday derived
 * veteran or disability question uses: "N/A" or "Not Applicable" prepended
 * to a full sentence that itself asserts a demographic identity. A bare
 * `\bnot\s+applicable\b` matches that whole string as a substring and
 * `.find()` then returns the entire sentence, including the identity claim,
 * to be typed into the form and recorded in `answer_provenance` verbatim —
 * exactly the fabrication this ticket exists to prevent. Anchoring each new
 * alternative to the full option (`\s*` absorbing incidental whitespace)
 * means the phrase has to be the whole answer, not merely present in it, so
 * a compound option like that one falls through to `null` instead.
 */
export const EEO_DECLINE_ANALOG_RE = new RegExp(
  `${DECLINE_OPTION_RE.source}|^\\s*n/a\\s*$|^\\s*not\\s+applicable\\s*$`,
  "i"
);

/**
 * The option in `options` that functions as a decline under the wider
 * JOB-262 pattern above, or null.
 *
 * Never a decision on its own about whether picking it is allowed. The `ats`
 * gate and the "only when the option itself is decline shaped" rule both
 * live in `resolveDecision`, so this stays a pure lookup, the same shape as
 * `findDeclineOption`.
 */
export function findDeclineAnalogOption(options: readonly string[]): string | null {
  return options.find((option) => EEO_DECLINE_ANALOG_RE.test(option)) ?? null;
}

// ───────────────────────────────────
// Perception — the DOM, and only the DOM
// ───────────────────────────────────

type RawField = {
  selector: string;
  activateSelectors: string[];
  label: string;
  kind: string;
  required: boolean;
  currentValue: string;
  options: string[];
  optionSelectors: string[];
  optionValues: string[];
  optionsKnown: boolean;
  optionsTruncated: boolean;
  maxLength: number | null;
  helpText: string;
};

/**
 * Serialised into the page, so it must be self-contained: no imports, no closure
 * over anything in this module, no TypeScript that does not survive `toString()`.
 * Written as a real function rather than a template string for the same reason
 * `describeControlInPage` is — so the compiler checks it.
 */
function enumerateFieldsInPage(
  maxFields: number,
  maxOptions: number,
  handleAttr: string,
  // Passed in rather than closed over: this function is serialised with
  // `toString()` and sent to a browser that has never heard of this module, so a
  // module constant referenced here would be a `ReferenceError` in the page.
  // Threading them keeps one definition shared with `readFieldValue`, which is
  // the whole point — see `SELECTED_VALUE_SELECTOR`.
  SELECTED_VALUE_SEL: string,
  VALUE_MIRROR_SEL: string
): RawField[] {
  const out: RawField[] = [];
  let handleCount = 0;

  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  /**
   * JOB-047. The element above this one, crossing out of an open shadow root
   * when there is nothing left inside it.
   *
   * Every ancestor walk in this function used to be `node.parentElement`, which
   * returns null at the top of a shadow root and therefore stopped dead one
   * element inside a web component. On a board built out of custom elements that
   * is the very first step, so visibility, labelling and the activation ladder
   * all gave up before they had seen anything real.
   */
  const parentOf = (node: Element): Element | null => {
    if (node.parentElement !== null) return node.parentElement;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };

  /**
   * Every element in the document **and** in every open shadow root under it.
   *
   * `document.querySelectorAll` stops at a shadow boundary, and on a board whose
   * form is web components that means it reports nothing at all: SmartRecruiters
   * renders every input inside an `spl-input` / `spl-autocomplete` /
   * `spl-date-picker` shadow root, so a live read of a real RRS Group listing
   * enumerated **zero** controls while the form on screen had ten. Closed shadow
   * roots stay invisible, which is correct — a closed root is not scriptable by
   * anyone, including a real assistive technology.
   */
  const deepAll = (): Element[] => {
    const found: Element[] = [];
    const stack: (Document | ShadowRoot)[] = [document];
    const seen = new Set<Document | ShadowRoot>();
    while (stack.length > 0) {
      const root = stack.pop();
      if (root === undefined || seen.has(root)) continue;
      seen.add(root);
      for (const element of Array.from(root.querySelectorAll("*"))) {
        found.push(element);
        const inner = (element as HTMLElement).shadowRoot;
        if (inner !== null && inner !== undefined) stack.push(inner);
      }
    }
    return found;
  };

  const everything = deepAll();
  /**
   * Handles are stable across passes, and that is deliberate.
   *
   * This form gets enumerated several times in one run — before a repeating
   * section's `Add`, after it, and again once the answers are in — and the
   * caller tells "a control I have already seen" from "a control that has just
   * mounted" by comparing selectors. Reissuing handles on every pass renumbered
   * every control in document order, so inserting one subform made *every*
   * field on the page look new. Keeping the handle an element already carries
   * makes that comparison mean what it says, and costs nothing: the selector
   * still resolves to the same element, which is all a selector has to do.
   */
  for (const element of everything) {
    const existing = element.getAttribute(handleAttr);
    if (existing === null) continue;
    const already = Number(existing.replace(/^f/, ""));
    if (Number.isFinite(already) && already > handleCount) handleCount = already;
  }

  const xpathOf = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node !== null && node.nodeType === 1) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling !== null) {
        if (sibling.tagName === node.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      node = node.parentElement;
    }
    return `xpath=/${parts.join("/")}`;
  };

  /**
   * An id-based selector when the id is unique and quotable, an absolute XPath
   * otherwise. Ids survive a React re-render that reorders siblings; XPath does
   * not, which matters because a decision is made between reading the page and
   * writing to it.
   *
   * JOB-047 adds a third form and tightens the first.
   *
   * The tightening: uniqueness is now counted across the shadow roots too. A
   * SmartRecruiters `spl-input` carries the *same* id as the real `<input>`
   * inside its shadow root, so `[id="first-name-input"]` matches two elements
   * once a selector engine can see both — and Playwright's can. Counting only
   * the light document would have reported that as unique and handed the action
   * layer a selector that resolves to two nodes, which is a strict-mode failure
   * rather than a wrong field, but a failure all the same.
   *
   * The third form: an element inside an open shadow root has no XPath anybody
   * can use — Playwright's XPath engine does not cross a shadow boundary — so it
   * is stamped with a handle attribute and addressed by that. The stamp is an
   * attribute on a control this module is about to read and write anyway; it
   * carries no meaning to the page, and every handle is reassigned from scratch
   * on each pass (see `clearHandles` below) so a stale one from an earlier read
   * can never be resolved by accident.
   */
  const selectorOf = (element: Element): string => {
    const id = element.getAttribute("id");
    if (id !== null && id !== "" && !/["\\\n\r]/.test(id)) {
      try {
        const selector = `[id="${id}"]`;
        let matches = 0;
        for (const candidate of everything) {
          if (candidate.matches(selector)) matches++;
          if (matches > 1) break;
        }
        if (matches === 1) return selector;
      } catch {
        // A malformed id that breaks the selector parser. Fall through.
      }
    }
    if (element.getRootNode() !== document) {
      // Idempotent within a pass, and that is load bearing rather than tidy.
      // `activationLadder` asks for the control's own selector a second time,
      // and a second *fresh* stamp overwrote the first: the field was reported
      // under the handle it no longer carried, so every combobox on a web
      // component board resolved to nothing. Caught by a live run against
      // SmartRecruiters, where the City control could not be found by the
      // selector this module had just minted for it.
      const existing = element.getAttribute(handleAttr);
      if (existing !== null && existing !== "") return `[${handleAttr}="${existing}"]`;
      handleCount++;
      const handle = `f${handleCount}`;
      element.setAttribute(handleAttr, handle);
      return `[${handleAttr}="${handle}"]`;
    }
    return xpathOf(element);
  };

  const rectOf = (element: Element): { w: number; h: number } => {
    const box = element.getBoundingClientRect();
    return { w: box.width, h: box.height };
  };

  /**
   * Is this control on screen for a human?
   *
   * The size test is applied to the element *or* to a near ancestor, because a
   * react-select combobox's real `<input>` is a two-pixel grid cell inside a
   * full-width control box. Rejecting it on its own dimensions would make every
   * dropdown on a modern ATS invisible to this pass.
   *
   * One carve-out (issue #94): a styled radio or checkbox hides its native
   * input from the accessibility tree (`aria-hidden="true"`, opacity 0) and
   * paints its own control inside the same wrapping `<label>` — Workable
   * renders every yes/no radio group this way, which made whole *required*
   * groups invisible to this pass, so nothing filled them and every submit
   * click failed the board's own validation with the form still on screen.
   * The native input is still what a click toggles and what the form reads,
   * so when its wrapping label is really on screen, the control is visible in
   * every sense that matters here. Deliberately narrow: only radio/checkbox
   * inputs, only through a visible wrapping label — a combobox's hidden
   * mirror input carries no type and stays invisible, as it should.
   *
   * A second carve-out of the same shape, for a select2-style widget: the
   * real `<select>` is marked `aria-hidden="true"` and `tabindex="-1"` while
   * a `<span role="combobox">` is painted over it. Lever's `university` field
   * type is built exactly this way, and the consequence was a required
   * dropdown holding 2,965 real schools that this pass never saw at all — it
   * saw only the undrivable span, so the control sat on its empty
   * placeholder (which Lever words "Other", so it even *looked* answered)
   * and the board refused every submit. A `<select>` carrying real options is
   * the control the form reads whatever the accessibility tree says, so it is
   * visible here when its own widget box is on screen. The decorative span is
   * dropped instead; see `shadowsNativeSelect`.
   */
  const isVisible = (element: Element): boolean => {
    if (element.getAttribute("aria-hidden") === "true") {
      if (element.tagName.toLowerCase() === "select") {
        if ((element as HTMLSelectElement).options.length === 0) return false;
        // Bounded to the widget's own wrapper, and explicitly never `body` or
        // `html`: those always have a real box, so walking into them would
        // make EVERY aria-hidden select on the page count as visible, which
        // is the opposite of a test.
        let node: Element | null = element.parentElement;
        for (let depth = 0; node !== null && depth < 3; depth++) {
          const tag = node.tagName.toLowerCase();
          if (tag === "body" || tag === "html") return false;
          const box = rectOf(node);
          if (box.w >= 8 && box.h >= 8) {
            const style = window.getComputedStyle(node);
            return style.display !== "none" && style.visibility !== "hidden";
          }
          node = node.parentElement;
        }
        return false;
      }
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      if (type !== "radio" && type !== "checkbox") return false;
      const wrap = element.closest("label");
      if (wrap === null || wrap.getAttribute("aria-hidden") === "true") return false;
      const wrapStyle = window.getComputedStyle(wrap);
      if (wrapStyle.display === "none" || wrapStyle.visibility === "hidden") return false;
      const box = rectOf(wrap);
      return box.w >= 8 && box.h >= 8;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    let node: Element | null = element;
    for (let depth = 0; node !== null && depth < 4; depth++) {
      const { w, h } = rectOf(node);
      if (w >= 8 && h >= 8) return true;
      node = parentOf(node);
    }
    return false;
  };

  /**
   * JOB-121. `textContent`, except that a `<slot>` contributes what is actually
   * slotted into it.
   *
   * `textContent` walks the DOM tree, and a `<slot>` element has no children in
   * that tree — the nodes it displays live in the *host's* light DOM and are
   * pulled in only when the browser flattens the two. So on a board that builds
   * its labels out of web components, every label read by `textContent` comes
   * back empty. SmartRecruiters' screening step is exactly that: each question
   * renders as
   *
   *   <label for="…"><span class="…-required-group">
   *     <slot name="label-content"></slot><span aria-hidden="true">*</span>
   *   </span></label>
   *
   * with the question itself sitting outside, in the host's light DOM, as
   * `<span slot="label-content">What are your Annual Base Salary expectations?</span>`.
   * `textContent` on that label returns `"*"` and nothing else, which is why a
   * live capture of the step showed five required questions enumerated with an
   * empty `label` and reported as `field-6` … `field-10`. `fillRemainingFields`
   * drops any control whose label is `""`, so those five were read and then
   * silently skipped — enumerated, never asked, never answered.
   *
   * Strictly additive: with no `<slot>` anywhere under `root` this returns
   * exactly what `textContent` returns, so no board that works today reads
   * differently. In particular it keeps `aria-hidden` text, unlike `visibleText`
   * below, because the `*` a form puts in an `aria-hidden` span is often the
   * only signal that the question is required and `requiredOf` reads it off the
   * raw label.
   *
   * `skip` lets one caller exclude a subtree: see `groupQuestionText`, which
   * needs a radio group's question without its own answers mixed into it.
   */
  const flatText = (
    root: Element | ShadowRoot,
    skip?: (element: Element) => boolean
  ): string => {
    const parts: string[] = [];
    let budget = 500;
    const walk = (node: Node): void => {
      if (budget <= 0) return;
      budget--;
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent !== null) parts.push(node.textContent);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (skip !== undefined && skip(element)) return;
      if (element.tagName.toLowerCase() === "slot") {
        // `flatten` resolves a slot assigned into another slot, and falls back
        // to the slot's own default content when nothing is assigned — which is
        // what the browser paints, so it is what a person reads.
        for (const assigned of (element as HTMLSlotElement).assignedNodes({ flatten: true })) {
          walk(assigned);
        }
        return;
      }
      for (const child of Array.from(node.childNodes)) walk(child);
    };
    for (const child of Array.from(root.childNodes)) walk(child);
    return parts.join(" ");
  };

  /**
   * The text a sighted applicant would actually see inside `root`, skipping
   * any subtree hidden via `display:none`, `visibility:hidden` or
   * `aria-hidden`.
   *
   * `root.textContent` does not draw this line, and a label lookup that reads
   * a whole wrapping `<label>` (or block) can pull in more than the caption:
   * a combobox widget's own status chrome — a "No results" panel, a loading
   * spinner's caption — lives right inside that same label/block and stays in
   * the DOM the entire time, only ever toggled with `display`. Lever's
   * location autocomplete is built exactly this way: the visible caption
   * ("Current location") and the dropdown's hidden "No location found..."
   * and "Loading" panels all share one `<label>`, so `textContent` on it
   * reads as one run-on sentence (issue #81). This walk stops descending the
   * moment it hits a hidden node, so that chrome never contributes text.
   */
  const visibleText = (root: Element): string => {
    if (root.getAttribute("aria-hidden") === "true") return "";
    const rootStyle = window.getComputedStyle(root);
    if (rootStyle.display === "none" || rootStyle.visibility === "hidden") return "";
    const parts: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent !== null) parts.push(node.textContent);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (element.getAttribute("aria-hidden") === "true") return;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return;
      // JOB-121. A `<slot>` shows the host's light DOM, not its own children, so
      // walking `childNodes` here reads a caption as empty on any board built out
      // of web components. See `flatText` for the capture that made this matter.
      if (element.tagName.toLowerCase() === "slot") {
        for (const assigned of (element as HTMLSlotElement).assignedNodes({ flatten: true })) {
          walk(assigned);
        }
        return;
      }
      for (const child of Array.from(node.childNodes)) walk(child);
    };
    for (const child of Array.from(root.childNodes)) walk(child);
    return parts.join(" ");
  };

  /** The words that mean a control sends the application. See `holdsSubmitControl`. */
  const SUBMITTISH = /\b(submit|send|apply|application|finish|complete)\w*\b/i;

  /**
   * Everything under `node`, shadow roots included. Bounded, because this runs
   * once per rung of every control's activation ladder.
   */
  const deepUnder = (node: Element, limit: number): Element[] => {
    const found: Element[] = [];
    const stack: (Element | ShadowRoot)[] = [node];
    // The node's own shadow root counts as "under" it. See `deepQueryAll`.
    const own = (node as HTMLElement).shadowRoot;
    if (own !== null && own !== undefined) stack.push(own);
    const seen = new Set<Element | ShadowRoot>();
    while (stack.length > 0 && found.length < limit) {
      const root = stack.pop();
      if (root === undefined || seen.has(root)) continue;
      seen.add(root);
      let children: Element[];
      try {
        children = Array.from(root.querySelectorAll("*"));
      } catch {
        continue;
      }
      for (const child of children) {
        found.push(child);
        const inner = (child as HTMLElement).shadowRoot;
        if (inner !== null && inner !== undefined) stack.push(inner);
        if (found.length >= limit) break;
      }
    }
    return found;
  };

  /**
   * The words a person would use to name this control, including the ones its
   * host element carries.
   *
   * A web component button is an empty `<button>` in a shadow root with a
   * `<slot>` in it; the caption ("Add", "Save", "Next") lives on the light-DOM
   * host, and so does the `aria-label`. Reading only the element itself sees an
   * unnamed button on every such board, which for `holdsSubmitControl` means
   * failing to recognise a submit control — the one direction this must never
   * be wrong in.
   */
  const controlWords = (element: Element): string => {
    const bits = [
      element.textContent ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("value") ?? "",
    ];
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) {
      const host = root.host;
      bits.push(host.textContent ?? "", host.getAttribute("aria-label") ?? "");
    }
    return clean(bits.join(" ")).slice(0, 300);
  };

  /**
   * Does this element contain something that would submit the application?
   *
   * The activation ladder climbs ancestors to find the box that opens a
   * dropdown, and a click on a container lands wherever that container's centre
   * happens to be. On a tightly-laid-out form that centre could fall on a
   * button. This module must never be able to submit an application — the same
   * absolute rule `fill-application-form.ts` states — so any ancestor holding a
   * plausible submit control is simply not a rung anybody may click, whatever
   * its size.
   *
   * Deliberately over-broad: it refuses on *any* submit-typed control and on any
   * button whose words read like sending an application. The cost of being wrong
   * in this direction is one dropdown that has to be escalated to the user; the
   * cost of being wrong in the other is an application sent by accident.
   *
   * JOB-047 makes it see through open shadow roots, in both directions. It now
   * finds a `<button type="submit">` that a web component keeps inside its own
   * shadow root, and it reads a shadow button's caption off the light-DOM host
   * that slots it in. Both were invisible before, which means on a board like
   * SmartRecruiters this guard was reporting "no submit control here" about a
   * section that had one. Strictly more refusals than the previous version, and
   * that is the safe direction.
   */
  const holdsSubmitControl = (node: Element): boolean => {
    for (const candidate of deepUnder(node, 400)) {
      const tag = candidate.tagName.toLowerCase();
      const type = (candidate.getAttribute("type") ?? "").toLowerCase();
      if (type === "submit" && (tag === "input" || tag === "button")) return true;
      const isButtonish =
        tag === "button" ||
        (candidate.getAttribute("role") ?? "").toLowerCase() === "button" ||
        (tag === "input" && type === "button") ||
        /(^|-)button$/.test(tag);
      if (!isButtonish) continue;
      if (SUBMITTISH.test(controlWords(candidate))) return true;
    }
    return false;
  };

  /**
   * Everything worth clicking to open this control's menu, innermost first.
   *
   * Bounded at both ends: too small to be a control box, and too large to be
   * anything but a section of the page. Clicking a page-wide container to open
   * a dropdown is how a run ends up clicking something else entirely — and
   * `holdsSubmitControl` is what makes "something else" not be Submit.
   */
  const activationLadder = (element: Element): string[] => {
    const out: string[] = [selectorOf(element)];
    let node: Element | null = parentOf(element);
    for (let depth = 0; node !== null && depth < 6 && out.length < 5; depth++) {
      const box = rectOf(node);
      if (
        box.w >= 40 &&
        box.h >= 16 &&
        box.w <= 1200 &&
        box.h <= 240 &&
        !holdsSubmitControl(node)
      ) {
        const selector = selectorOf(node);
        if (!out.includes(selector)) out.push(selector);
      }
      node = parentOf(node);
    }
    return out;
  };

  /**
   * The visible caption block preceding a control that has no label of its
   * own.
   *
   * Lever's custom "additional questions" cards draw the question as a plain
   * `<div class="application-label"><div class="text">…</div></div>` followed
   * by a sibling `<div class="application-field">` holding the control — no
   * `label[for]`, no wrapping label, no legend anywhere (issue #94). Those
   * fields fell all the way through to their `name` attribute and were
   * reported as "cards[uuid][field0]", which no model or person can answer.
   *
   * This climbs a few ancestors and reads the nearest preceding sibling that
   * shows text and holds no form control of its own. A caption never holds a
   * control, and a preceding sibling that does hold one is a *different*
   * question's block — everything before it belongs to that question, so the
   * walk stops rather than skipping past it and attributing someone else's
   * caption to this control.
   */
  const questionBlockText = (element: Element): string => {
    const FORM_CONTROLS = "input,select,textarea,button";
    const WIDGET_CHROME = '[role="combobox"],[role="listbox"]';
    /** A different question's block. Everything before it belongs to it. */
    const holdsFormControl = (node: Element): boolean =>
      node.matches(FORM_CONTROLS) || node.querySelector(FORM_CONTROLS) !== null;
    /**
     * This widget's own painted decoration: a `role` that says "combobox"
     * with no real form control anywhere inside it. select2 puts one of these
     * immediately before the `<select>` it decorates, showing the current
     * selection, and Lever words the empty one "Other" — so reading it as a
     * caption made a school dropdown's question the single word "Other"
     * (issue #94). Skipped rather than stopped at: the real caption is
     * further back, past the chrome, and it is still this control's own.
     */
    const isWidgetChrome = (node: Element): boolean =>
      (node.matches(WIDGET_CHROME) || node.querySelector(WIDGET_CHROME) !== null) &&
      !holdsFormControl(node);

    let node: Element | null = element;
    for (let depth = 0; node !== null && depth < 5; depth++) {
      let sibling: Element | null = node.previousElementSibling;
      while (sibling !== null) {
        if (holdsFormControl(sibling)) return "";
        if (!isWidgetChrome(sibling)) {
          const text = clean(visibleText(sibling));
          if (text !== "") return text;
        }
        sibling = sibling.previousElementSibling;
      }
      node = parentOf(node);
    }
    return "";
  };

  /**
   * JOB-047. A label lives in the same root as the thing it labels.
   *
   * `document.getElementById` and `document.querySelector` only ever search the
   * light document, so for a control inside a shadow root they answer about the
   * wrong tree entirely — they find nothing, or worse, they find a same-id
   * element belonging to a different component. Scoped to the control's own root
   * these are byte-identical for a light-DOM control (its root *is* the
   * document) and correct for a shadow one, where SmartRecruiters keeps a real
   * `<label for="first-name-input">First name*</label>` right beside the input.
   */
  const rootOf = (element: Element): Document | ShadowRoot => {
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root : document;
  };

  const labelOf = (element: Element): string => {
    const bits: string[] = [];
    const push = (value: string | null | undefined): void => {
      const text = clean(value);
      // Deduplicated, because several of the fallbacks below are read together
      // and a control whose `aria-label` and `placeholder` say the same thing
      // came back with its caption twice: "Search by country/region or code
      // Search by country/region or code". That string becomes the field's key
      // and the question a person gets asked, so the repetition is not cosmetic.
      if (text !== "" && !bits.includes(text)) bits.push(text);
    };
    const root = rootOf(element);

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      for (const id of labelledBy.split(/\s+/)) {
        const escaped = id.replace(/["\\]/g, "\\$&");
        // `flatText` rather than `textContent` (JOB-121): the caption is usually
        // slotted in from the host's light DOM, and `textContent` cannot see it.
        const target = root.querySelector(`[id="${escaped}"]`);
        if (target !== null) push(flatText(target));
      }
    }
    const ownId = element.getAttribute("id");
    if (bits.length === 0 && ownId !== null && ownId !== "") {
      const escaped = ownId.replace(/["\\]/g, "\\$&");
      const explicit = root.querySelector(`label[for="${escaped}"]`);
      if (explicit !== null) push(flatText(explicit));
    }
    if (bits.length === 0) {
      const wrapping = element.closest("label");
      if (wrapping !== null) push(visibleText(wrapping));
    }
    if (bits.length === 0) {
      const block = element.closest("div,fieldset,li,section,td");
      if (block !== null) {
        const blockLabel = block.querySelector("label,legend");
        if (blockLabel !== null) push(visibleText(blockLabel));
      }
    }
    if (bits.length === 0) {
      push(element.getAttribute("aria-label"));
    }
    // Before surrendering to a placeholder or a raw name attribute: the
    // question may be drawn as a plain block of text above the control
    // rather than as anything label-shaped. See `questionBlockText`.
    if (bits.length === 0) {
      push(questionBlockText(element));
    }
    if (bits.length === 0) {
      push(element.getAttribute("placeholder"));
      push(element.getAttribute("name"));
    }
    // The host of a web component is where its caption is declared — an
    // `spl-input` carries `label="Company"` and slots it into its own shadow
    // root. Read last, so a real `<label>` always wins.
    if (bits.length === 0) {
      let node: Element | null = element;
      for (let depth = 0; node !== null && bits.length === 0 && depth < 3; depth++) {
        const holder = node.getRootNode();
        if (!(holder instanceof ShadowRoot)) break;
        node = holder.host;
        push(node.getAttribute("label"));
        push(node.getAttribute("aria-label"));
      }
    }
    return bits.join(" ").slice(0, 300);
  };

  /**
   * Whether the control says it must be answered, asking its host too.
   *
   * A web component takes `required` on the custom element and does not always
   * mirror it onto the real input inside — SmartRecruiters mirrors it as
   * `aria-required` on some controls and as nothing at all on its date pickers.
   * A required field read as optional is a blank box on a submitted
   * application, so this asks every level that could be carrying the flag.
   */
  const requiredOf = (element: Element, rawLabel: string): boolean => {
    if ((element as HTMLInputElement).required === true) return true;
    if (element.getAttribute("aria-required") === "true") return true;
    if (/[*✱]\s*$/.test(rawLabel) || /\(required\)/i.test(rawLabel)) return true;
    let node: Element | null = element;
    for (let depth = 0; node !== null && depth < 3; depth++) {
      const holder = node.getRootNode();
      if (!(holder instanceof ShadowRoot)) break;
      node = holder.host;
      if (node.hasAttribute("required") || node.getAttribute("aria-required") === "true") {
        return true;
      }
    }
    return false;
  };

  const helpOf = (element: Element): string => {
    const describedBy = element.getAttribute("aria-describedby");
    if (describedBy === null) return "";
    const bits: string[] = [];
    for (const id of describedBy.split(/\s+/)) {
      // Placeholder and error nodes are described-by targets too, and both are
      // noise: one says "Select...", the other is empty until validation runs.
      if (/-(placeholder|error)$/.test(id)) continue;
      const target = document.getElementById(id);
      if (target === null) continue;
      const text = clean(target.textContent);
      if (text !== "") bits.push(text);
    }
    return bits.join(" ").slice(0, 300);
  };

  /**
   * What a react-select-style combobox currently holds.
   *
   * Its `<input>.value` is the *search* text and is empty even when something is
   * selected — the selection is a rendered `div`. Both are checked, plus the
   * hidden mirror input these widgets keep for native form validation, which is
   * the most reliable of the three when it exists.
   */
  /**
   * The nearest thing matching `css` at one level of the walk: this element's
   * own subtree, then its own shadow root.
   *
   * Two `querySelector` calls rather than a walk over everything underneath, and
   * that is a correctness decision as much as a speed one. The enumerate-then-
   * filter version of this had to be bounded to stay affordable, and the bound
   * is what hid the answer: SmartRecruiters' `spl-select` holds 245 country
   * options in its light DOM and paints its trigger caption *after* all of them,
   * at element 1229 of 1230. Any budget small enough to be safe to run per
   * control per pass stopped a thousand elements short of it. `querySelector`
   * has no such problem — the engine finds the one match at any depth — so the
   * only thing this has to add is the shadow root, which `querySelector` alone
   * will not enter.
   */
  const nearestMatch = (root: Element, css: string): Element | null => {
    try {
      const light = root.querySelector(css);
      if (light !== null) return light;
    } catch {
      return null;
    }
    const inner = (root as HTMLElement).shadowRoot;
    if (inner === null || inner === undefined) return null;
    try {
      return inner.querySelector(css);
    } catch {
      return null;
    }
  };

  /**
   * What a scripted dropdown currently holds, which is what decides whether the
   * fill treats it as an empty control that still needs answering.
   *
   * JOB-107 makes it see through open shadow roots, in both directions, and
   * teaches it the second spelling of "the selection". It has to give the same
   * answer as `readFieldValue` — see `SELECTED_VALUE_SELECTOR` for what happened
   * when it did not — and the two blind spots were the same in both:
   * `querySelector` does not descend into a shadow root and `parentElement` does
   * not climb out of one, so on a board where every control is a web component
   * this used to look only at the search box a person types into. A search box
   * is empty by design once a selection commits, so every such control read as
   * unanswered no matter what the board had already put in it.
   */
  const comboboxValue = (element: Element): string => {
    // Defensive about the type: a custom element's `value` is often not a string
    // (SmartRecruiters' phone field holds `{"country":"US"}`), and `clean` on one
    // would throw out of the whole enumeration.
    const raw = (element as HTMLInputElement).value;
    const own = clean(typeof raw === "string" ? raw : "");
    if (own !== "") return own;
    let shell: Element | null = element;
    for (let depth = 0; shell !== null && depth < 7; depth++) {
      const rendered = nearestMatch(shell, SELECTED_VALUE_SEL);
      if (rendered !== null) {
        const text = clean(rendered.textContent);
        if (text !== "") return text;
      }
      const mirror = nearestMatch(shell, VALUE_MIRROR_SEL);
      if (mirror !== null) {
        const mirrored = (mirror as HTMLInputElement).value;
        const value = clean(typeof mirrored === "string" ? mirrored : "");
        if (value !== "") return value;
      }
      shell = parentOf(shell);
    }
    return "";
  };

  const kindOf = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    if (tag === "textarea") return "textarea";
    if (tag === "select") return "select";
    const role = (element.getAttribute("role") ?? "").toLowerCase();
    if (role === "combobox") return "combobox";
    // JOB-121. A painted radio is a radio. Checked before the `input` bail-out
    // below, because on a web component board there is no input to bail out to.
    if (role === "radio") return "radio";
    if (tag !== "input") return "other";
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "file") return "file";
    if (type === "radio") return "radio";
    if (type === "checkbox") return "checkbox";
    if (
      element.getAttribute("aria-autocomplete") === "list" ||
      element.getAttribute("aria-haspopup") === "listbox"
    ) {
      return "combobox";
    }
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) return "skip";
    return "text";
  };

  /**
   * Is this `[role="combobox"]` element mere chrome painted over a real
   * `<select>` that this pass is going to read anyway?
   *
   * select2 and Lever's own `bb-customSelect` both wrap one native `<select>`
   * in one or more spans carrying `role="combobox"`. Those spans hold no
   * options, cannot be filled and cannot be `selectOption`ed; the `<select>`
   * beside them is the actual control. Reporting them as fields produced two
   * or three phantom duplicates of one question, each unanswerable, and the
   * real dropdown was the one thing missing (issue #94).
   *
   * Only ever drops a NON form control: a real `<input role="combobox">`,
   * which is what Workable and react-select use and what `chooseFromMenu`
   * drives by typing, is never touched by this.
   */
  const shadowsNativeSelect = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return false;
    if (element.querySelector("select") !== null) return true;
    let node: Element | null = element.parentElement;
    for (let depth = 0; node !== null && depth < 3; depth++) {
      const select = node.querySelector("select");
      if (select !== null) return true;
      node = node.parentElement;
    }
    return false;
  };

  /** A radio, whether the browser built it or a component painted it. */
  const isRadioElement = (element: Element): boolean => {
    if ((element.getAttribute("role") ?? "").toLowerCase() === "radio") return true;
    return (
      element.tagName.toLowerCase() === "input" &&
      (element.getAttribute("type") ?? "").toLowerCase() === "radio"
    );
  };

  /**
   * Is this `[role="radio"]` element decoration painted over a real
   * `<input type="radio">` this pass is going to read anyway?
   *
   * The same idea as `shadowsNativeSelect`, for the same reason: a wrapper that
   * carries the role while the native input carries the value would otherwise be
   * reported as a second, undrivable copy of a question that is already read
   * correctly. Never touches a native input, so a board whose radios are real
   * inputs is unaffected by this whole branch.
   */
  const wrapsNativeRadio = (element: Element): boolean => {
    if (element.tagName.toLowerCase() === "input") return false;
    for (const candidate of deepUnder(element, 80)) {
      if (
        candidate.tagName.toLowerCase() === "input" &&
        (candidate.getAttribute("type") ?? "").toLowerCase() === "radio"
      ) {
        return true;
      }
    }
    return false;
  };

  /** Every painted radio inside `container`, in document order. */
  const ariaRadiosIn = (container: Element): Element[] =>
    deepUnder(container, 400).filter(
      (element) =>
        (element.getAttribute("role") ?? "").toLowerCase() === "radio" &&
        element.tagName.toLowerCase() !== "input"
    );

  /**
   * JOB-121. The element that owns a painted radio's group.
   *
   * A native group is found by its shared `name` attribute. A painted one has no
   * `name` to share — SmartRecruiters' `spl-radio` carries `role="radio"`,
   * `aria-checked` and a `value`, and nothing else — so the group is whatever
   * ancestor holds all of them. Preferring a declared `role="radiogroup"` and
   * falling back to "the nearest ancestor holding more than one radio" means a
   * board that labels its group properly is read from its own markup, and one
   * that does not is still read correctly from its shape.
   */
  const radioGroupContainer = (element: Element): Element | null => {
    let node: Element | null = parentOf(element);
    for (let depth = 0; node !== null && depth < 5; depth++) {
      if ((node.getAttribute("role") ?? "").toLowerCase() === "radiogroup") return node;
      if (ariaRadiosIn(node).length > 1) return node;
      node = parentOf(node);
    }
    return parentOf(element);
  };

  /**
   * What one painted radio's answer says, as a person reads it.
   *
   * Not `labelOf`: that ladder ends at `questionBlockText`, which for the first
   * radio in a group returns the *question* sitting above it. Reporting a
   * group's question as one of its own answers is how issue #94's Lever consent
   * group came to ask "Yes, I consent" as its question, in the other direction.
   */
  const radioOptionName = (element: Element): string => {
    const bits = [
      element.getAttribute("aria-label"),
      element.getAttribute("label"),
      flatText(element),
      element.shadowRoot === null ? "" : flatText(element.shadowRoot),
      element.getAttribute("value"),
    ];
    for (const bit of bits) {
      const text = clean(bit);
      if (text !== "") return text.slice(0, 120);
    }
    return "";
  };

  /**
   * A radio group's question, without its own answers folded into it.
   *
   * The whole group is one element on this kind of board, so the question and
   * every option live under the same container and a plain text read returns
   * "Are you 18 years of age or older? Yes No".
   */
  const groupQuestionText = (container: Element): string =>
    clean(flatText(container, isRadioElement)).slice(0, 300);

  // Deliberately no `[role="listbox"]`: that is the *popup* a combobox opens,
  // not a control anybody fills in, and Greenhouse keeps one permanently in the
  // DOM for its phone-country picker. Including it produced a phantom field
  // called "List of countries" on every read of a Discord form.
  //
  // `[role="radio"]` is here as of JOB-121. SmartRecruiters' screening step
  // draws every yes/no question as `<spl-radio-group>` holding `<spl-radio>`
  // elements, and there is no `<input>`, `<select>` or `<textarea>` anywhere
  // inside one — so three required questions on the captured step ("Are you 18
  // years of age or older?", the visa sponsorship question, and the disability
  // self-identification) were not merely mislabelled, they were structurally
  // absent from this filter and could never have been enumerated.
  const nodes = everything.filter((element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return true;
    const role = (element.getAttribute("role") ?? "").toLowerCase();
    return role === "combobox" || role === "radio";
  });
  const seen = new Set<Element>();
  const seenRadioGroups = new Set<string>();

  for (const element of nodes) {
    if (out.length >= maxFields) break;
    if (seen.has(element)) continue;
    seen.add(element);

    const kind = kindOf(element);
    if (kind === "skip") continue;
    if (kind === "combobox" && shadowsNativeSelect(element)) continue;
    if (kind === "radio" && wrapsNativeRadio(element)) continue;
    if (!isVisible(element)) continue;

    const rawLabel = labelOf(element);
    // `let`, because the Workable and Lever passes below refine both (issue #94).
    // `requiredOf` is the same four tests this used to inline, plus a walk up
    // the host chain for a web component that takes `required` on the custom
    // element and does not mirror it inward (JOB-047).
    let label = clean(rawLabel.replace(/[*✱]+\s*$/, "").replace(/\(required\)\s*$/i, ""));
    let required = requiredOf(element, rawLabel);

    let options: string[] = [];
    let optionSelectors: string[] = [];
    let optionValues: string[] = [];
    let optionsKnown = false;
    let optionsTruncated = false;
    let currentValue = "";
    let selector = selectorOf(element);
    let activateSelectors = [selector];

    if (kind === "select") {
      const select = element as HTMLSelectElement;
      const all = Array.from(select.options);
      // A first option with an empty value is a placeholder ("Select…"), not an
      // answer anybody would choose.
      const real = all.filter((option) => option.value !== "" && clean(option.textContent) !== "");
      options = real.slice(0, maxOptions).map((option) => clean(option.textContent));
      optionValues = real.slice(0, maxOptions).map((option) => option.value);
      optionsKnown = true;
      optionsTruncated = real.length > options.length;
      currentValue =
        select.selectedIndex >= 0 && select.value !== ""
          ? clean(all[select.selectedIndex]?.textContent)
          : "";
    } else if (kind === "radio") {
      // JOB-121. Two shapes of the same control. A native group is the set of
      // `<input type="radio">` sharing a `name`; a painted one has no name to
      // share and is the set of `[role="radio"]` under a common container.
      const native = element.tagName.toLowerCase() === "input";
      const name = native ? (element as HTMLInputElement).name : "";
      let container: Element | null = null;
      let group: Element[];
      if (native) {
        if (name !== "") {
          if (seenRadioGroups.has(name)) continue;
          seenRadioGroups.add(name);
        }
        // Scoped to the radio's own root: a shadow-hosted group is not in the
        // light document, and two components can each hold a group of the same
        // name without being one group.
        group =
          name === ""
            ? [element]
            : Array.from(
                rootOf(element).querySelectorAll(
                  `input[type="radio"][name="${name.replace(/["\\]/g, "\\$&")}"]`
                )
              );
      } else {
        container = radioGroupContainer(element);
        const painted = container === null ? [] : ariaRadiosIn(container);
        group = painted.length > 0 ? painted : [element];
      }
      for (const radio of group) seen.add(radio);
      options = group
        .slice(0, maxOptions)
        .map((radio) =>
          native
            ? labelOf(radio) || (radio as HTMLInputElement).value
            : radioOptionName(radio)
        );
      optionSelectors = group.slice(0, maxOptions).map((radio) => selectorOf(radio));
      optionsKnown = true;
      optionsTruncated = group.length > options.length;
      const checked = group.find((radio) =>
        native
          ? (radio as HTMLInputElement).checked
          : radio.getAttribute("aria-checked") === "true"
      );
      currentValue =
        checked === undefined
          ? ""
          : native
            ? labelOf(checked) || (checked as HTMLInputElement).value
            : radioOptionName(checked);
      // A painted group carries its own `required`, and the `[role="radiogroup"]`
      // it renders into carries `aria-required`. Neither is on any individual
      // radio, so without this every SmartRecruiters yes/no question would be
      // read as optional and left blank on a form that refuses to submit without
      // it — the same failure issue #94 found on Workable's hidden mirrors.
      if (!native && container !== null) {
        if (
          container.hasAttribute("required") ||
          container.getAttribute("aria-required") === "true"
        ) {
          required = true;
        }
        if (!required) {
          for (const node of deepUnder(container, 200)) {
            if (
              (node.getAttribute("role") ?? "").toLowerCase() === "radiogroup" &&
              node.getAttribute("aria-required") === "true"
            ) {
              required = true;
              break;
            }
          }
        }
      }
      // The group's question is not any single radio's own label — that is
      // one of its ANSWERS. Three places boards actually put the question,
      // tried in order (issue #94): a fieldset legend; the element the
      // fieldset is aria-labelledby (Workable's yes/no questions); the
      // caption block preceding the group's container (Lever's
      // multiple-choice cards). Before this, a Lever consent group reported
      // its own first option, "Yes, I consent", as the question it asked.
      const fieldset = element.closest("fieldset");
      let groupLabel = clean(fieldset?.querySelector("legend")?.textContent);
      if (groupLabel === "" && fieldset !== null) {
        const labelledBy = fieldset.getAttribute("aria-labelledby");
        for (const id of (labelledBy ?? "").split(/\s+/)) {
          if (groupLabel !== "" || id === "") continue;
          // Scoped to the fieldset's own root and read with `flatText`, for the
          // two reasons JOB-047 and JOB-121 each found the hard way: an id
          // inside a shadow root is not in `document`, and a caption made of a
          // `<slot>` is empty to `textContent`.
          const target = rootOf(fieldset).querySelector(`[id="${id.replace(/["\\]/g, "\\$&")}"]`);
          if (target !== null) groupLabel = clean(flatText(target));
        }
      }
      // JOB-121. A painted group's question is written on the container, either
      // as a name it declares or as the only text under it that is not one of
      // its own answers.
      if (groupLabel === "" && container !== null) {
        for (const candidate of [
          container.getAttribute("aria-label"),
          container.getAttribute("label"),
          groupQuestionText(container),
        ]) {
          const text = clean(candidate);
          if (text !== "") {
            groupLabel = text;
            break;
          }
        }
      }
      if (groupLabel === "") {
        const first = group[0];
        groupLabel = questionBlockText(first === undefined ? element : first);
      }
      if (groupLabel !== "") {
        required =
          required || /[*✱]\s*$/.test(groupLabel) || /\(required\)/i.test(groupLabel);
        label = clean(groupLabel.replace(/[*✱]+\s*$/, "").replace(/\(required\)\s*$/i, ""));
        const first = group[0];
        selector = first === undefined ? selector : selectorOf(first);
        activateSelectors = [selector];
      }
    } else if (kind === "checkbox") {
      currentValue = (element as HTMLInputElement).checked ? "checked" : "";
      optionsKnown = true;
      // A card checkbox's wrapping label often holds only the box's own
      // caption ("I Understand", "English (ENG)") while the actual question
      // sits in the caption block above the group (Lever cards, issue #94).
      // When the label is exactly that wrapping caption, prefix the question,
      // so the report says what is being agreed to or selected rather than
      // just the tick's own word. Only the wrapping-label case: a checkbox
      // with a real label[for] or aria-labelledby already says what it means.
      {
        const wrap = element.closest("label");
        if (wrap !== null && clean(visibleText(wrap)) === rawLabel) {
          const block = questionBlockText(wrap);
          if (block !== "") {
            required =
              required || /[*✱]\s*$/.test(block) || /\(required\)/i.test(block);
            label = clean(
              `${block} ${label}`.replace(/[*✱]+/g, " ").replace(/\(required\)/gi, " ")
            );
          }
        }
      }
    } else if (kind === "combobox") {
      currentValue = comboboxValue(element);
      // Left unknown on purpose: the option list of a scripted dropdown is not
      // in the DOM until the menu is opened, and opening every menu on a page
      // costs a click and a repaint each. `harvestOptions` does it for the
      // fields that actually need it.
      optionsKnown = false;
      activateSelectors = activationLadder(element);
      // A scripted dropdown's requiredness often lives on the hidden mirror
      // input the widget keeps for native form validation, not on the search
      // input a person types into — Workable marks only the mirror, so every
      // required Workable dropdown read as optional and was left blank
      // (issue #94). `comboboxValue` already trusts that same mirror for the
      // control's current value; trust it for `required` the same way.
      if (!required) {
        let shell: Element | null = element;
        for (let depth = 0; shell !== null && depth < 5; depth++) {
          const mirror = shell.querySelector('input[aria-hidden="true"][tabindex="-1"]');
          if (mirror !== null) {
            required =
              (mirror as HTMLInputElement).required === true ||
              mirror.getAttribute("aria-required") === "true";
            break;
          }
          shell = shell.parentElement;
        }
      }
    } else if (kind === "file") {
      const input = element as HTMLInputElement;
      currentValue = input.files !== null && input.files.length > 0 ? `${input.files.length} file(s)` : "";
    } else {
      currentValue = clean((element as HTMLInputElement).value);
    }

    const declaredMax = Number((element as HTMLInputElement).maxLength);
    out.push({
      selector,
      activateSelectors,
      label,
      kind,
      required,
      currentValue,
      options,
      optionSelectors,
      optionValues,
      optionsKnown,
      optionsTruncated,
      maxLength: Number.isFinite(declaredMax) && declaredMax > 0 ? declaredMax : null,
      helpText: helpOf(element),
    });
  }

  return out;
}

/** A JS string literal for `value`, safe to splice into an expression. */
function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * JOB-047. The attribute this module stamps on a control it can only address by
 * a stamp.
 *
 * An element inside an open shadow root has no XPath a driver can follow \u2014
 * Playwright's XPath engine does not cross a shadow boundary, while its CSS
 * engine does \u2014 so `enumerateFieldsInPage` marks such a control and reports
 * `[data-jobinno-field="fN"]` as its selector. Exported because the tests pin
 * the shape, and because a reader grepping for this attribute in a page dump
 * should be able to find where it comes from.
 */
export const FIELD_HANDLE_ATTR = "data-jobinno-field";

/** The same idea for one option inside an open dropdown. See `readOpenMenuInPage`. */
export const OPTION_HANDLE_ATTR = "data-jobinno-option";

/**
 * Where a scripted dropdown paints the selection it has committed.
 *
 * One definition, spliced into both readers, because there are exactly two
 * places that ask "what does this control hold" and they are required to give
 * the same answer. `comboboxValue` inside `enumerateFieldsInPage` decides
 * whether a control counts as already filled, and `readFieldValue` decides
 * whether a fill stuck. When they disagree the run does something incoherent:
 * JOB-107 caught the pair of them with the same two blind spots, so a phone
 * country picker that the board had already set to United States read as empty,
 * was "filled" anyway, and the typing landed in a neighbouring Website box that
 * the board then rejected. Neither reader was individually wrong about the
 * element it was looking at. They were both looking at the wrong element.
 *
 * react-select spells it `single-value`; SmartRecruiters' `spl-select` spells it
 * `selected-value`. Matching on the substring rather than the whole class name
 * is what makes the same probe work on both, and both spellings of "one" and
 * "many" are here because a multi-select that has committed one value is still
 * a control that is not empty.
 */
const SELECTED_VALUE_SELECTOR =
  '[class*="single-value"],[class*="singleValue"],[class*="multi-value"],' +
  '[class*="multiValue"],[class*="selected-value"],[class*="selectedValue"]';

/** The hidden input a scripted dropdown keeps so native form validation can see its value. */
const VALUE_MIRROR_SELECTOR = 'input[aria-hidden="true"][tabindex="-1"]';

/** And for the control that adds an entry to a repeating section. See `enumerateRepeatingSectionsInPage`. */
export const SECTION_HANDLE_ATTR = "data-jobinno-section";

/**
 * The element lookup every evaluated script in this file shares, as source text.
 *
 * Spliced in rather than imported, because these scripts are strings sent to a
 * browser that has never heard of this module. It was six near-identical copies
 * before JOB-047 and each one would have needed the same shadow-root fix.
 *
 * Three selector shapes, in the order they are tried:
 *
 *  \u00b7 An XPath, which addresses the light document only. Unchanged, and still
 *    the fallback `selectorOf` reaches for on an ordinary board.
 *  \u00b7 A CSS selector that matches in the light document. Unchanged.
 *  \u00b7 A CSS selector that matches nothing in the light document, which is then
 *    looked for inside every open shadow root, deepest last. That is the branch
 *    a stamped handle takes, and the branch that makes a web-component board
 *    readable at all.
 */
const RESOLVE_IN_PAGE_SRC = `((sel) => {
  const path = sel.startsWith("xpath=") ? sel.slice(6) : sel;
  if (path.startsWith("/") || path.startsWith("(")) {
    try { return document.evaluate(path, document, null, 9, null).singleNodeValue; }
    catch { return null; }
  }
  try {
    const light = document.querySelector(sel);
    if (light) return light;
  } catch { return null; }
  const stack = [document];
  const seen = new Set();
  while (stack.length) {
    const root = stack.pop();
    if (seen.has(root)) continue;
    seen.add(root);
    let hosts;
    try { hosts = root.querySelectorAll("*"); } catch { continue; }
    for (const host of hosts) {
      const inner = host.shadowRoot;
      if (!inner) continue;
      try { const hit = inner.querySelector(sel); if (hit) return hit; } catch { return null; }
      stack.push(inner);
    }
  }
  return null;
})`;

/**
 * Wraps a local function's source into an expression the browser can evaluate.
 *
 * Two things it fixes, both of which cost this repo a silent failure:
 *
 *  1. **`__name is not defined`.** These modules run under `tsx`, whose esbuild
 *     transform emits `var f = __name((x) => \u2026, "f")` around every function it
 *     keeps a name for. That helper is defined in the *module*, so it travels
 *     into the page inside `toString()` and is not defined there \u2014 the function
 *     throws on its first line, every time, on every page. `describeControl()`
 *     in `fill-application-form.ts` had been failing this way since it was
 *     written: it returned `found: false` for every control, which reads exactly
 *     like "the form is inside an iframe" and was reported as such. A local
 *     identity `__name` in the evaluated scope makes the helper a no-op.
 *
 *  2. **"Uncaught".** A throw inside a CDP `Runtime.evaluate` reaches the SDK as
 *     the bare word "Uncaught" with no message and no stack, which is
 *     indistinguishable from a transport failure. Catching in the page and
 *     returning the stack as data is the only way to see what actually broke.
 */
export function inPageExpression(fn: (...args: never[]) => unknown, args: string): string {
  return (
    `(() => { const __name = (f) => f; try { return (${fn.toString()})(${args}); } ` +
    `catch (e) { return { __error: String((e && e.stack) || e) }; } })()`
  );
}

/** The `{ __error }` an `inPageExpression` returns instead of throwing, if it did. */
export function inPageError(result: unknown): string | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const error = (result as { __error?: unknown }).__error;
  return typeof error === "string" ? error : null;
}

const KINDS: ReadonlySet<string> = new Set([
  "text",
  "textarea",
  "select",
  "combobox",
  "radio",
  "checkbox",
  "file",
  "other",
]);

/**
 * Every control on the page, with a stable key per field.
 *
 * Never throws: a page this cannot read is reported as having no fields, and the
 * caller decides what that means. A perception failure must not be able to fail
 * a run that has already typed real data into a real employer's form.
 */
export async function enumerateFormFields(page: Page): Promise<EnumeratedField[]> {
  let raw: RawField[];
  try {
    const result = await page.evaluate(
      inPageExpression(
        enumerateFieldsInPage,
        `${MAX_FIELDS}, ${MAX_OPTIONS_REPORTED}, ${jsLiteral(FIELD_HANDLE_ATTR)}, ` +
          `${jsLiteral(SELECTED_VALUE_SELECTOR)}, ${jsLiteral(VALUE_MIRROR_SELECTOR)}`
      )
    );
    const failure = inPageError(result);
    if (failure !== null) throw new Error(failure);
    raw = Array.isArray(result) ? (result as RawField[]) : [];
  } catch (err) {
    // Reported rather than swallowed. "The form has no fields" and "the page
    // could not be read" produce the same empty list and completely different
    // conclusions, and the second one is a bug in this file that would
    // otherwise present as a form that mysteriously needs no filling.
    console.warn(
      `[form-fields] could not read the form's controls (treating the page as having none): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }

  const used = new Map<string, number>();
  const fields: EnumeratedField[] = [];
  for (const entry of raw) {
    if (typeof entry?.selector !== "string" || entry.selector === "") continue;
    const label = typeof entry.label === "string" ? entry.label.slice(0, 300) : "";
    const base = normalizeText(label).slice(0, 80) || `field-${fields.length + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);

    fields.push({
      key: seen === 0 ? base : `${base} #${seen + 1}`,
      selector: entry.selector,
      activateSelectors:
        Array.isArray(entry.activateSelectors) && entry.activateSelectors.length > 0
          ? entry.activateSelectors.map(String)
          : [entry.selector],
      label,
      kind: (KINDS.has(entry.kind) ? entry.kind : "other") as FormFieldKind,
      required: entry.required === true,
      currentValue: typeof entry.currentValue === "string" ? entry.currentValue : "",
      options: Array.isArray(entry.options) ? entry.options.map(String) : [],
      optionSelectors: Array.isArray(entry.optionSelectors)
        ? entry.optionSelectors.map(String)
        : [],
      optionValues: Array.isArray(entry.optionValues) ? entry.optionValues.map(String) : [],
      optionsKnown: entry.optionsKnown === true,
      optionsTruncated: entry.optionsTruncated === true,
      maxLength: typeof entry.maxLength === "number" ? entry.maxLength : null,
      helpText: typeof entry.helpText === "string" ? entry.helpText.slice(0, 300) : "",
    });
  }
  return fields;
}

// ───────────────────────────────────
// Opening a scripted dropdown to see what is in it
// ───────────────────────────────────

/** What one open dropdown looks like from the outside. */
type OpenMenu = {
  texts: string[];
  selectors: string[];
  /** How many options the menu holds in total, before the report cap. */
  count: number;
  /** The control's own `aria-expanded`. True with no options = an async search box. */
  expanded: boolean;
  /**
   * Where the widget's own highlight sits, as an index into the full option
   * list rather than into the capped `texts`, or -1 when the menu marks no
   * option as highlighted (or marks it in a way this cannot read).
   */
  focused: number;
  /** The highlighted option's own text, so a caller can see what Enter would commit. */
  focusedText: string;
  /**
   * Whether the listbox holding these options declares `aria-multiselectable`.
   *
   * JOB-266. Every other reading in this type is about *which* option is
   * highlighted; this one is about what committing it takes. A single-select
   * listbox's `Enter` both highlights-confirms and closes in one press, which
   * is the convention every other call site in this file was built against.
   * SmartRecruiters' `aria-multiselectable="true"` listbox answers to neither
   * `Enter` nor `Space` — see `chooseFromMenuOnce`'s SmartRecruiters-scoped
   * branch, the only place this is read, and `dispatchOptionEvents`, which it
   * calls instead of pressing a key.
   */
  multiselectable: boolean;
};

const NO_MENU: OpenMenu = {
  texts: [],
  selectors: [],
  count: 0,
  expanded: false,
  focused: -1,
  focusedText: "",
  multiselectable: false,
};

/**
 * Reads the options of the menu belonging to **this** control.
 *
 * The scoping is not tidiness. Discord's Greenhouse form keeps 244
 * `[role="option"]` nodes in the document at all times — the phone-country
 * list, rendered up-front and hidden — so a document-wide read would hand every
 * dropdown on the page a list of countries to choose from. Three strategies,
 * narrowest first: what the control says it controls, then the nearest ancestor
 * that actually holds visible options, then (for a menu rendered into a portal
 * at the end of `<body>`) whatever is visible anywhere.
 *
 * ── Why the last two are fenced (JOB-052) ───────────────────────────────────
 * That third strategy used to be justified by "only one menu is ever open at a
 * time". It is not true, and the day it was not cost a real application. On
 * Virtu's Greenhouse form a menu belonging to "Will you be ready for full-time
 * employment in 2028?" was still open when "What is your expected graduation
 * year?" was read, and the document-wide sweep handed the graduation-year
 * control that other question's `Yes / No / Undecided` — verified live, the
 * read returns exactly those three. Worse, the caller takes options-in-hand as
 * proof the menu is open, so it never clicked, and the real menu never opened
 * at all. That is how one run's log came to say the field "offers 3 option(s)"
 * and then that it "offered no options to choose from": both readings were of
 * somebody else's menu, or of nothing.
 *
 * So the two loose strategies are now fenced twice over. A control whose own
 * `aria-expanded` says `"false"` has nothing open and reads as empty, whatever
 * else is on screen; and an option living inside an element some *other*
 * control claims through `aria-controls`/`aria-owns` is that control's, never
 * this one's. Both fences only ever remove options that were never this
 * control's, so the worst they can do is report an empty menu — which the
 * decision layer already treats as a reason to ask rather than to guess.
 */
function readOpenMenuInPage(
  controlSelector: string,
  maxOptions: number,
  optionAttr: string
): OpenMenu {
  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const parentOf = (node: Element): Element | null => {
    if (node.parentElement !== null) return node.parentElement;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };

  const xpathOf = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node !== null && node.nodeType === 1) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling !== null) {
        if (sibling.tagName === node.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      node = node.parentElement;
    }
    return `xpath=/${parts.join("/")}`;
  };

  /**
   * How to address one option again in a moment, when it is time to click it.
   *
   * An XPath for a light-DOM option, exactly as before. A stamped handle for one
   * inside a shadow root, because no XPath reaches there — see
   * `FIELD_HANDLE_ATTR`. Stamps are cleared and reissued on every read, so the
   * "did the option under this selector move?" check in `chooseFromMenuOnce`
   * still compares against a freshly resolved element rather than a stale mark.
   */
  let stamped = 0;
  const addressOf = (element: Element): string => {
    if (element.getRootNode() === document) return xpathOf(element);
    stamped++;
    const handle = `o${stamped}`;
    element.setAttribute(optionAttr, handle);
    return `[${optionAttr}="${handle}"]`;
  };
  /**
   * Every stamp from the previous menu is cleared before this menu is read.
   *
   * Handles are positional (`o1`, `o2`, …) and a page holds more than one
   * dropdown, so without this an option left marked `o3` by the job-title menu
   * was still carrying that mark when the institution menu stamped its own
   * `o3`. The re-read in `chooseFromMenuOnce` then resolved the *other* one, and
   * reported that "the option to click moved" — the guard did its job and the
   * required Institution field was left empty for a reason that was entirely
   * this function's fault. Seen on a live SmartRecruiters run, where the
   * position that should have read "Georgia Institute of Technology" read
   * "AI Engineer".
   */
  const clearStaleStamps = (): void => {
    for (const marked of deepQueryAll(document, `[${optionAttr}]`)) {
      marked.removeAttribute(optionAttr);
    }
  };

  /**
   * `root.querySelectorAll(sel)` plus everything in every open shadow root at or
   * under it.
   *
   * "At or under" is load bearing and was the bug. This used to enter the shadow
   * root of every *descendant* it walked past but never the shadow root of the
   * element it was handed — so an ancestor walk that arrived at
   * `spl-autocomplete` and asked it for its options got nothing, because the
   * menu is inside that element's own shadow root and the walk had already
   * decided to look only below it. City was unfillable for this one reason: the
   * suggestions were rendered, visible and correct, and this function was
   * standing on top of them looking down.
   */
  const deepQueryAll = (root: Document | ShadowRoot | Element, sel: string): Element[] => {
    const found: Element[] = [];
    let budget = 12_000;
    const visit = (node: Element): void => {
      if (budget-- <= 0) return;
      try {
        if (node.matches(sel)) found.push(node);
      } catch {
        return;
      }
      const inner = (node as HTMLElement).shadowRoot;
      if (inner !== null && inner !== undefined) {
        for (const kid of Array.from(inner.children)) visit(kid);
      }
      for (const kid of Array.from(node.children)) visit(kid);
    };
    if (root instanceof Element) visit(root);
    else for (const kid of Array.from(root.children)) visit(kid);
    return found;
  };

  const resolveDeep = (sel: string): Element | null => {
    const path = sel.startsWith("xpath=") ? sel.slice("xpath=".length) : sel;
    if (path.startsWith("/") || path.startsWith("(")) {
      try {
        return document.evaluate(path, document, null, 9, null).singleNodeValue as Element | null;
      } catch {
        return null;
      }
    }
    try {
      const light = document.querySelector(sel);
      if (light !== null) return light;
    } catch {
      return null;
    }
    const hits = deepQueryAll(document, sel);
    return hits[0] ?? null;
  };

  /**
   * On screen, counting what is rendered *inside* the element too.
   *
   * A web component option is frequently a zero-box wrapper whose caption is
   * slotted or drawn a shadow root further down — SmartRecruiters nests
   * `spl-select-option` → `spl-dropdown-item` → `div[role="option"]` and paints
   * the words at the bottom, so the node carrying the ARIA role measures
   * nothing at all. Rejecting it on its own box hid every option on the page.
   */
  const visible = (node: Element): boolean => {
    const box = node.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return true;
    for (const inner of deepQueryAll(node, "*").slice(0, 40)) {
      const innerBox = inner.getBoundingClientRect();
      if (innerBox.width > 0 && innerBox.height > 0) return true;
    }
    return false;
  };

  /**
   * The words an applicant reads on this option, wherever they are declared.
   *
   * `textContent` stops at a shadow boundary, so on a component-built menu it
   * returns "" for every row. This walks into the open roots as well, which is
   * what makes an option matchable by the value the decision layer chose.
   */
  const deepText = (node: Element): string => {
    const own = clean(node.textContent);
    if (own !== "") return own;
    const parts: string[] = [];
    for (const inner of deepQueryAll(node, "*").slice(0, 60)) {
      if (inner.children.length > 0) continue;
      const text = clean(inner.textContent);
      if (text !== "") parts.push(text);
    }
    return clean(parts.join(" "));
  };

  const control = resolveDeep(controlSelector);

  const expanded = control !== null && control.getAttribute("aria-expanded") === "true";
  // Only an explicit "false" counts as a denial. A widget that declares nothing
  // at all is still searched for, because plenty of them never set the
  // attribute and reading their menu is the whole job.
  const declaredShut = control !== null && control.getAttribute("aria-expanded") === "false";

  let nodes: Element[] = [];

  // `[role="option"]` is the ARIA spelling; `option` covers a web component
  // that renders a real `<option>`-shaped list inside its own shadow root,
  // which is how SmartRecruiters draws its country picker.
  const OPTION_SEL = '[role="option"]';

  // Every element that some *other* control has claimed as its own popup.
  const claimed = new Set<string>();
  for (const owner of deepQueryAll(document, "[aria-controls],[aria-owns]")) {
    if (owner === control) continue;
    // Not another control when it wraps this one or sits inside it. A widget
    // that declares its popup on an outer span while the value lives on the
    // input this addresses is one control written across two elements, and
    // treating the outer one as a stranger would fence a control off from its
    // own menu.
    if (control !== null && (owner.contains(control) || control.contains(owner))) continue;
    const ids = `${owner.getAttribute("aria-controls") ?? ""} ${owner.getAttribute("aria-owns") ?? ""}`;
    for (const id of ids.split(/\s+/)) {
      if (id !== "") claimed.add(id);
    }
  }
  /** Is this option inside a popup another control has put its name to? */
  const someoneElses = (node: Element): boolean => {
    let walk: Element | null = node;
    while (walk !== null) {
      if (walk.id !== "" && claimed.has(walk.id)) return true;
      walk = parentOf(walk);
    }
    return false;
  };
  const mine = (node: Element): boolean => visible(node) && !someoneElses(node);

  const owned = control?.getAttribute("aria-controls") ?? control?.getAttribute("aria-owns") ?? null;
  if (owned !== null && owned !== "" && control !== null) {
    const root = control.getRootNode();
    const scope = root instanceof ShadowRoot ? root : document;
    const escaped = owned.replace(/["\\]/g, "\\$&");
    const box = scope.querySelector(`[id="${escaped}"]`);
    if (box !== null) {
      nodes = deepQueryAll(box, OPTION_SEL).filter(visible);
    }
  }
  if (nodes.length === 0 && control !== null && !declaredShut) {
    let node: Element | null = parentOf(control);
    for (let depth = 0; node !== null && depth < 7 && nodes.length === 0; depth++) {
      nodes = deepQueryAll(node, OPTION_SEL).filter(mine);
      node = parentOf(node);
    }
  }
  if (nodes.length === 0 && !declaredShut) {
    nodes = deepQueryAll(document, OPTION_SEL).filter(mine);
  }

  /**
   * The element that actually *is* this option, when the ARIA role is on an
   * inner node and the caption is on an outer one.
   *
   * A web component menu row is often `spl-select-option` (light DOM, holding
   * the words) wrapping `spl-dropdown-item` whose shadow root holds the
   * `div[role="option"]` with nothing in it but a `<slot>`. Slotted content
   * lives at the host, not at the slot, so reading down from the role finds an
   * empty string however deep it walks — SmartRecruiters' phone-country picker
   * reported 244 nameless options for exactly this reason, and a menu whose
   * options cannot be read is a menu nothing can be chosen from. Walking *up*
   * to the nearest ancestor that carries the words is the only direction the
   * caption is in.
   *
   * Bounded, and refuses any ancestor that covers more than this one option, so
   * it can never promote a whole menu into a single row.
   */
  const namedOption = (node: Element): Element | null => {
    if (deepText(node) !== "") return node;
    let up: Element | null = parentOf(node);
    for (let depth = 0; up !== null && depth < 4; depth++) {
      const text = deepText(up);
      if (text !== "" && text.length <= 200 && deepQueryAll(up, OPTION_SEL).length <= 1) return up;
      up = parentOf(up);
    }
    return null;
  };

  // An option nobody can read is not an option this can choose. Dropping the
  // blank ones here rather than downstream is what lets the listbox fallback
  // below know that the ARIA pass genuinely found nothing usable.
  let named = nodes
    .map((node) => namedOption(node))
    .filter((node): node is Element => node !== null);

  /**
   * The fallback for a menu that names its rows without `role="option"`.
   *
   * SmartRecruiters' location and job-title autocompletes render a visible
   * `[role="listbox"]` whose children are the suggestions, and put the ARIA
   * role on an inner node that is neither painted nor named. The rows are
   * plainly there and plainly clickable; only the attribute this used to key
   * on is in the wrong place. Tried second, so a board that does label its
   * options properly — every react-select one does — is matched exactly as
   * before and never reaches this.
   */
  /**
   * A row that is a message about the menu rather than a choice in it.
   *
   * JOB-052. react-select draws "No options" and "Loading..." as plain
   * children of its `role="listbox"` menu list with no role of their own —
   * exactly the shape the fallback below reports as a row. Verified live on
   * Virtu's Greenhouse form: typing a year that is not on the list left the
   * graduation-year control reporting one option called "No options", so a
   * value that is simply not offered read as a value the form offers strangely.
   *
   * Matched on the widget's own class naming, and it only ever removes a row.
   * A menu left with nothing is reported as offering nothing, which the
   * decision layer already treats as a reason to ask.
   */
  const isNotice = (node: Element): boolean =>
    /(?:^|[-_ ])(?:menu[-_]notice|no[-_]?options|no[-_]?results|loading)(?:[-_ ]|$)/i.test(
      typeof node.className === "string" ? node.className : ""
    );

  if (named.length === 0 && !declaredShut) {
    const boxes: Element[] = [];
    if (control !== null) {
      let node: Element | null = parentOf(control);
      for (let depth = 0; node !== null && depth < 7 && boxes.length === 0; depth++) {
        for (const box of deepQueryAll(node, '[role="listbox"]')) {
          // JOB-052. Fenced exactly as the option searches above are, and for
          // the same reason: this walk climbs well past its own control's
          // wrapper, so a neighbouring question whose menu happens to be open
          // is within its reach. A listbox another control has claimed is that
          // control's, and a control that says its own menu is shut has none.
          if (visible(box) && !someoneElses(box)) boxes.push(box);
        }
        node = parentOf(node);
      }
    }
    for (const box of boxes) {
      const rows = Array.from(box.children).filter(
        (row) => visible(row) && deepText(row) !== "" && !isNotice(row)
      );
      if (rows.length > 0) {
        named = rows;
        break;
      }
    }
  }

  /**
   * JOB-266. Whether the listbox these options live in declares itself
   * `aria-multiselectable`, read off the nearest `[role="listbox"]` ancestor
   * of the first option rather than off any one of the search paths above —
   * `named` can arrive from three different walks (the control's own
   * `aria-controls`/`aria-owns`, a climb from the control, or a
   * document-wide sweep) and the listbox is the one node all three agree an
   * option sits inside, so reading it here covers every path with one check
   * instead of three.
   */
  let multiselectable = false;
  {
    let node: Element | null = named.length > 0 ? parentOf(named[0] as Element) : null;
    for (let depth = 0; node !== null && depth < 8; depth++) {
      if ((node.getAttribute("role") ?? "").toLowerCase() === "listbox") {
        multiselectable = node.getAttribute("aria-multiselectable") === "true";
        break;
      }
      node = parentOf(node);
    }
  }

  /**
   * Which option the widget itself considers highlighted — the one its own
   * `Enter` would commit.
   *
   * Four readings, most authoritative first, because no single one of them is
   * present on every widget: Greenhouse's react-select leaves
   * `aria-activedescendant` empty and marks the option with a `--is-focused`
   * class instead, while a hand-rolled ARIA combobox does the opposite. -1 when
   * none of the four says anything, which the caller treats as "unsteerable"
   * rather than as "option 0".
   *
   * ── JOB-125: -1 is the dangerous answer, not the safe one ──────────────────
   * `highlightOption` falls back to the WAI-ARIA convention when this reads -1,
   * and that convention — "the menu opened with nothing highlighted, so option
   * N is N+1 presses away" — is unverifiable and wrong on any widget that opens
   * pre-highlighted. It is the whole of issue #97 and it recurred verbatim on
   * SmartRecruiters, whose `spl-autocomplete` sets no `aria-activedescendant`,
   * leaves `aria-selected="false"` on every option, and marks its highlight
   * with the one word this did not know: `active`. Captured live on Avery
   * Dennison's screening step on 2026-08-22, where the four education options
   * render as
   *
   *   0  High School Diploma/GED   class="c-spl-dropdown-item active" tabindex="0"
   *   1  Associates Degree         class=" c-spl-dropdown-item "      tabindex="-1"
   *   2  Bachelors Degree          class=" c-spl-dropdown-item "      tabindex="-1"
   *   3  Masters/Ph.D +            class=" c-spl-dropdown-item "      tabindex="-1"
   *
   * so a chosen "Bachelors Degree" at index 2 was walked three presses from an
   * already-highlighted option 0 and committed "Masters/Ph.D +" — the option
   * one past it, on a real employer's form.
   *
   * Hence the two readings added below. `active` and `current` join the class
   * vocabulary, and a roving-tabindex listbox is recognised structurally rather
   * than by any spelling at all. Both only ever turn a -1 into an index, and an
   * index this gets wrong costs nothing: `highlightOption` re-reads the
   * highlight after moving it and refuses to press `Enter` on an option it
   * could not confirm. A -1 is what has no such check behind it.
   *
   * ── JOB-047: read against the list that is actually reported ───────────────
   * The marker sits on the node carrying `role="option"`, and that node is not
   * always the one this reports as the option. `namedOption` promotes a role
   * node whose caption lives on an outer element, and the listbox fallback
   * reports rows that carry no role at all. So the marked element is found
   * first and *then* mapped onto `named` by walking up from it — which is a
   * no-op on every widget where the two are the same element, and is what keeps
   * `focused` an index into the same array `texts` and `selectors` come from.
   *
   * That agreement is the whole point. `highlightOption` walks the difference
   * between this index and the target index, so an index measured against a
   * different list than the one the target came from would move the highlight
   * by a wrong amount — the same class of error as the off-by-one it was
   * written to fix, arriving from the other side.
   */
  const namedIndex = new Map<Element, number>();
  named.forEach((node, at) => namedIndex.set(node, at));

  /** The reported option that this marked element belongs to, or -1. */
  const indexOfNamed = (marked: Element | null): number => {
    let node: Element | null = marked;
    for (let depth = 0; node !== null && depth < 6; depth++) {
      const at = namedIndex.get(node);
      if (at !== undefined) return at;
      node = parentOf(node);
    }
    return -1;
  };

  // `active` and `current` are the other two words a menu uses for the row its
  // own `Enter` would take (JOB-125). Deliberately not `selected`: on
  // react-select `--is-selected` marks the option already *chosen*, which is a
  // different thing from the one highlighted, and confusing the two would move
  // the walk by a wrong amount on every Greenhouse dropdown.
  const markedClass = (node: Element): boolean =>
    /(?:^|[-_ ])(?:is[-_])?(?:focused|highlighted|active|current)(?:$|[-_ ])/i.test(
      typeof node.className === "string" ? node.className : ""
    );

  // Searched over the role nodes and the reported rows together: the marker can
  // be on either, depending on which of the two paths above produced `named`.
  const markable = nodes.concat(named);

  let marked: Element | null = null;
  const activeId = control?.getAttribute("aria-activedescendant") ?? "";
  if (activeId !== "") {
    const escaped = activeId.replace(/["\\]/g, "\\$&");
    const root = control === null ? document : control.getRootNode();
    const scope = root instanceof ShadowRoot ? root : document;
    marked = scope.querySelector(`[id="${escaped}"]`) ?? deepQueryAll(document, `[id="${escaped}"]`)[0] ?? null;
  }
  if (marked === null) marked = markable.find((node) => markedClass(node)) ?? null;
  if (marked === null) {
    // A row whose marker is on something inside it rather than on itself.
    for (const row of named) {
      if (deepQueryAll(row, "*").slice(0, 40).some((inner) => markedClass(inner))) {
        marked = row;
        break;
      }
    }
  }
  if (marked === null) {
    marked = markable.find((node) => node.getAttribute("aria-selected") === "true") ?? null;
  }
  /**
   * JOB-125. A roving tabindex: one option holds `tabindex="0"` and every other
   * one holds a negative tabindex, which is how a listbox that moves real DOM
   * focus between its rows says which row currently has it.
   *
   * Structural rather than a fourth guess at a class name, which is the point —
   * this is the reading that does not go stale the next time a board invents a
   * word for "highlighted". Both halves are required: without a parked sibling
   * a lone `tabindex="0"` is just an ordinary focusable element and means
   * nothing about a highlight, so a menu that does not use a roving tabindex
   * still reads -1 here and is treated exactly as it was before.
   */
  if (marked === null) {
    const tabbable = markable.filter((node) => node.getAttribute("tabindex") === "0");
    const parked = markable.some((node) => {
      const stop = node.getAttribute("tabindex");
      return stop !== null && Number(stop) < 0;
    });
    if (tabbable.length === 1 && parked) marked = tabbable[0] ?? null;
  }
  const focused = indexOfNamed(marked);

  // `maxOptions` of 0 is the deliberate cheap read: the highlight without the
  // per-option address walk, for the polling that steers it onto a chosen
  // option. Stamps are left alone on that read for the same reason — the caller
  // is mid-choice and still holding the selectors from the full read.
  const kept = named.slice(0, Math.max(0, maxOptions));
  if (maxOptions > 0) clearStaleStamps();
  return {
    texts: kept.map((node) => deepText(node)),
    selectors: kept.map((node) => addressOf(node)),
    count: named.length,
    expanded,
    focused,
    // `deepText`, not `textContent`: on a web component menu the highlighted
    // row's own text node is empty and the caption is a shadow root or two
    // away. `highlightOption` steers by comparing this against the chosen
    // option's text, so measuring it differently from the way `texts` above is
    // measured would make every such option unconfirmable and therefore
    // unchoosable.
    focusedText: focused === -1 ? "" : deepText(named[focused] as Element),
    multiselectable,
  };
}

async function readOpenMenu(
  page: Page,
  field: EnumeratedField,
  maxOptions: number = MAX_OPTIONS_REPORTED
): Promise<OpenMenu> {
  try {
    const raw = await page.evaluate(
      // `maxOptions` is the caller's, not the constant: `highlightOption` polls
      // with 0 to read the highlight without paying for the address walk.
      inPageExpression(
        readOpenMenuInPage,
        `${jsLiteral(field.selector)}, ${maxOptions}, ${jsLiteral(OPTION_HANDLE_ATTR)}`
      )
    );
    const failure = inPageError(raw);
    if (failure !== null) {
      console.warn(`[form-fields] could not read an open dropdown's options: ${failure}`);
      return NO_MENU;
    }
    const result = raw as OpenMenu | null;
    if (result === null || !Array.isArray(result.texts)) return NO_MENU;
    return {
      texts: result.texts.map(String),
      selectors: Array.isArray(result.selectors) ? result.selectors.map(String) : [],
      count: typeof result.count === "number" ? result.count : result.texts.length,
      expanded: result.expanded === true,
      focused: typeof result.focused === "number" ? result.focused : -1,
      focusedText: typeof result.focusedText === "string" ? result.focusedText : "",
      multiselectable: result.multiselectable === true,
    };
  } catch {
    return NO_MENU;
  }
}

/**
 * Gets one dropdown's menu open, by trying each rung of its activation ladder
 * until something happens.
 *
 * "Something happened" is two different observations and both count. Options
 * appearing is the obvious one. `aria-expanded="true"` with no options is the
 * other, and it is not a failure: it is a *search* control — Greenhouse's
 * "Location (City)" is one — whose list is a server's answer to a query nobody
 * has typed yet. Treating that as "this control will not open" and clicking
 * further up the ladder would close the thing that had just opened.
 */
async function openMenu(page: Page, field: EnumeratedField): Promise<OpenMenu> {
  let menu = NO_MENU;
  for (const target of field.activateSelectors) {
    menu = await readOpenMenu(page, field);
    if (!menu.expanded && menu.texts.length === 0) {
      await scrollIntoView(page, target);
      try {
        await page.locator(target).click();
      } catch {
        continue;
      }
    }

    const deadline = Date.now() + MENU_ATTEMPT_TIMEOUT_MS;
    menu = await readOpenMenu(page, field);
    while (menu.texts.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(MENU_POLL_MS);
      menu = await readOpenMenu(page, field);
    }
    if (menu.texts.length > 0 || menu.expanded) return menu;
  }
  return menu;
}

/**
 * Brings an element into view before it is clicked.
 *
 * Stagehand's `locator.click()` dispatches at the element's centroid over CDP
 * and does not scroll first, so a control below the fold is a click into the
 * void. Never fatal — a scroll that fails leaves the click to succeed or fail on
 * its own merits.
 */
async function scrollIntoView(page: Page, selector: string): Promise<void> {
  const script = `(() => {
    const sel = ${jsLiteral(selector)};
    const el = ${RESOLVE_IN_PAGE_SRC}(sel);
    if (!el || !el.scrollIntoView) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  })()`;
  try {
    await page.evaluate(script);
  } catch {
    // Not worth a line in any report.
  }
}

/**
 * Focuses an element directly, without a click.
 *
 * JOB-044. `chooseFromMenuOnce` used to click the option it wanted; committing
 * one by keyboard instead needs the control itself focused first, and there is
 * no `Locator.focus()` on Stagehand's `Page` to ask for that with — see the
 * class's own type. In practice the control is already focused by the time
 * this runs, either from typing into it (`narrow()`'s `.fill()`) or from the
 * click that opened its menu in the first place (`openMenu`'s own
 * `activateSelectors` click), but neither of those is guaranteed for every
 * path that reaches here, so this makes it true rather than assuming it.
 *
 * Returns whether focus actually landed, so a caller that is about to fire
 * keystrokes at "whatever has focus" can find out first — see the caller in
 * `chooseFromMenuOnce`, which used to await this without checking and send
 * `ArrowDown`/`Enter` blind.
 */
async function focusElement(page: Page, selector: string): Promise<boolean> {
  const script = `(() => {
    const sel = ${jsLiteral(selector)};
    const el = ${RESOLVE_IN_PAGE_SRC}(sel);
    if (!el || !el.focus) return false;
    el.focus();
    return true;
  })()`;
  try {
    const focused = await page.evaluate(script);
    return focused === true;
  } catch {
    return false;
  }
}

/**
 * Scrolls an element into view **only if it is not already there**.
 *
 * Used for menu options, where the unconditional `scrollIntoView` above is
 * actively harmful: scrolling a three-option menu that was already fully on
 * screen moved the page under an open react-select and the following click
 * selected nothing at all — Gender and Race and Ethnicity both came back empty
 * on a run where the value was correct and the option was correctly identified.
 * `block: "nearest"` for the same reason: the least movement that puts the
 * element on screen is the least that can disturb the widget.
 */
async function scrollIfOffscreen(page: Page, selector: string): Promise<void> {
  const script = `(() => {
    const sel = ${jsLiteral(selector)};
    const el = ${RESOLVE_IN_PAGE_SRC}(sel);
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const h = window.innerHeight || document.documentElement.clientHeight;
    const w = window.innerWidth || document.documentElement.clientWidth;
    if (r.top >= 0 && r.left >= 0 && r.bottom <= h && r.right <= w) return true;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  })()`;
  try {
    await page.evaluate(script);
  } catch {
    // Not worth a line in any report.
  }
}

/**
 * Moves a menu's own highlight onto the option at `index`, and reports whether
 * it actually got there.
 *
 * ── Why this is not just "press ArrowDown index + 1 times" ──────────────────
 * That is what it used to be, on the reasoning quoted at the call site: the
 * WAI-ARIA combobox pattern opens with nothing highlighted, so the first
 * ArrowDown lands on option 0. The pattern says so and the comment was right
 * about the pattern. It is wrong about react-select, which is what Greenhouse
 * draws every one of its dropdowns with, and which opens with **option 0
 * already highlighted**. One ArrowDown there moves to option 1, so every
 * choice this made on a Greenhouse form was the option one past the right one.
 *
 * That is not a hypothetical. It is the whole of the 2026-08-22 read-back
 * failure, verified against the live DOM of a real posting: the degree chosen
 * one past "Bachelor's Degree" is "Certification", the ACT score chosen one
 * past "Did not take" is "36 out of 36", and a "Yes" one past on a two-option
 * question is "No" — which is exactly what those six fields read back as.
 *
 * So the position is no longer assumed. It is read off the widget, the walk is
 * the difference between where the highlight is and where it needs to be, and
 * the highlight is read again afterwards to confirm it arrived. A widget that
 * exposes no highlight at all falls back to the old convention, since that is
 * still the right guess for the pattern it was written from, and the read-back
 * after `Enter` is still there to catch it being wrong.
 *
 * The one thing this will not do is press `Enter` on an option it could not
 * confirm is the chosen one. Committing the wrong option is the failure being
 * fixed, and doing it silently is worse than reporting that nothing was chosen.
 *
 * ── JOB-125: the blind fallback is looked at again before it is believed ────
 * The sentence above was not quite true, because the fallback below had no
 * confirmation behind it at all: when the menu marked no highlight this pressed
 * `index + 1` times on the old convention and returned `ok: true` without ever
 * looking. That is exactly how the same off-by-one arrived a second time, on
 * SmartRecruiters rather than Greenhouse — see `readOpenMenuInPage`'s note on
 * the `active` class it could not read.
 *
 * So the blind walk now reads the highlight once more when it is finished. A
 * widget that still marks nothing is reported blind exactly as before, since
 * there is genuinely nothing else to go on and the read back after `Enter`
 * remains the check. A widget that turns out to mark something after all is no
 * longer blind, and drops into the same verified steering every other menu
 * gets — which either confirms the walk landed, corrects it, or refuses to
 * commit.
 */
async function highlightOption(
  page: Page,
  field: EnumeratedField,
  index: number,
  chosen: string
): Promise<{ ok: boolean; blind: boolean; detail: string }> {
  const wanted = normalizeText(chosen);

  /**
   * Polls the highlight briefly, because a keystroke and a re-render race.
   *
   * The budget is a parameter because the two callers below want different
   * ones: the walk that should have landed it is worth waiting on, while each
   * step of the one-at-a-time fallback is not — sixty steps each waiting out a
   * full settle budget would be a minute and a half of nothing happening.
   */
  const settledOn = async (budgetMs: number): Promise<OpenMenu> => {
    let seen = await readOpenMenu(page, field, 0);
    const deadline = Date.now() + budgetMs;
    while (normalizeText(seen.focusedText) !== wanted && Date.now() < deadline) {
      await page.waitForTimeout(MENU_POLL_MS);
      seen = await readOpenMenu(page, field, 0);
    }
    return seen;
  };

  let start = await readOpenMenu(page, field, 0);
  if (start.focused === -1) {
    for (let step = 0; step <= index; step++) await page.keyPress("ArrowDown");
    // Then look, rather than assume. See this function's JOB-125 note: some
    // widgets mark nothing until they have been arrowed at, and this is the one
    // moment where the difference between "unsteerable" and "not asked yet" is
    // visible.
    const after = await settledOn(MENU_SETTLE_TIMEOUT_MS);
    if (after.focused === -1) {
      return {
        ok: true,
        blind: true,
        detail: "this menu marks no highlighted option, so the arrow walk could not be verified",
      };
    }
    if (normalizeText(after.focusedText) === wanted) {
      return { ok: true, blind: false, detail: `highlighted "${chosen}"` };
    }
    // It marks one, and it is not the chosen option. Fall through and steer it
    // the verified way from where the highlight actually is.
    start = after;
  }

  // Forward only, and modulo the real option count, because every menu this has
  // been run against wraps from the last option back to the first. A menu that
  // does not wrap simply stalls on its last option and is caught below.
  const total = start.count > 0 ? start.count : start.texts.length + 1;
  const forward = (((index - start.focused) % total) + total) % total;
  for (let step = 0; step < forward; step++) await page.keyPress("ArrowDown");

  let now = await settledOn(MENU_SETTLE_TIMEOUT_MS);
  if (normalizeText(now.focusedText) === wanted) {
    return { ok: true, blind: false, detail: `highlighted "${chosen}"` };
  }

  // The arithmetic did not land it. Rather than give up on a widget whose
  // ordering this does not model, walk it one option at a time and stop the
  // moment the highlight reads what was chosen. Bounded by the option count, so
  // a menu that never highlights it is a report rather than a spin.
  for (let step = 0; step < total; step++) {
    await page.keyPress("ArrowDown");
    now = await settledOn(MENU_POLL_MS);
    if (normalizeText(now.focusedText) === wanted) {
      return {
        ok: true,
        blind: false,
        detail: `highlighted "${chosen}" after stepping through the menu`,
      };
    }
  }

  return {
    ok: false,
    blind: false,
    detail:
      `the menu's highlight could not be moved onto ${JSON.stringify(chosen.slice(0, 80))} — ` +
      `it reads ${JSON.stringify(now.focusedText.slice(0, 80))} instead. Nothing was chosen.`,
  };
}

/** Closes whatever menu is open, without pressing anything that could submit. */
async function closeMenu(page: Page): Promise<void> {
  try {
    await page.keyPress("Escape");
  } catch {
    // A menu that will not close costs the next `harvestOptions` an extra read.
  }
}

/**
 * Opens one scripted dropdown and reads what a human would see in it.
 *
 * Deliberately cheap and deliberately fallible: every failure mode — a control
 * that will not open, a menu that never renders, a widget that fetches its
 * options from a server as you type — comes back as "no options known", which
 * the decision layer treats as a reason to ask rather than a reason to guess.
 */
export async function harvestOptions(
  page: Page,
  field: EnumeratedField
): Promise<{ options: string[]; truncated: boolean; opened: boolean }> {
  const menu = await openMenu(page, field);
  await closeMenu(page);
  return {
    options: menu.texts.filter((text) => text !== ""),
    truncated: menu.count > menu.texts.length,
    opened: menu.expanded || menu.texts.length > 0,
  };
}

// ───────────────────────────────────
// Repeating subforms — a required section whose fields do not exist yet
// ───────────────────────────────────

/**
 * JOB-047. A required section that holds a list of entries and starts empty.
 *
 * ── Why this needed anything new ────────────────────────────────────────────
 * Everything else in this module rests on one assumption: the control is on the
 * page, so it can be read and then written to. A repeating subform breaks it.
 * SmartRecruiters' "Experience *" and "Education *" are a heading, an `Add`
 * button and a validation message reading "Please provide at least one work
 * experience entry" — and no inputs whatsoever until `Add` is pressed. There is
 * nothing for `enumerateFormFields` to find, nothing for `decideFieldAnswers`
 * to answer, and nothing for `applyFieldValue` to write to, so a form with two
 * of these could never be completed however good the rest of the pipeline was.
 *
 * The fix keeps the three concerns apart rather than fusing them. This file
 * *finds* such a section (DOM only, no model) and *presses* its add control
 * (a deterministic click, no model). The fields that then mount are ordinary
 * fields: they go through `enumerateFormFields`, `decideFieldAnswers` and
 * `applyFieldValue` exactly as any other control on the page would, which is
 * why there is no second decision mechanism here and no page text ever becomes
 * an instruction.
 */
export type RepeatingSection = {
  /** Normalised heading, e.g. `"experience"`. Stable across reads of the same form. */
  key: string;
  /** The heading a sighted applicant reads, with any required marker stripped. */
  heading: string;
  /** The control that mounts one more entry. Guarded — see `pressAddEntry`. */
  addSelector: string;
  /** The section's own box, for scoping the commit control and the re-read. */
  containerSelector: string;
  /** The board's own words for why this section is not satisfied yet, if it is showing them. */
  message: string;
};

/** More than this many repeating sections on one form is not a form this fills. */
const MAX_REPEATING_SECTIONS = 6;

/**
 * A control that adds another entry, by the words on it.
 *
 * Anchored at the start so that "Add" and "+ Add another" match while "Address"
 * does not, and so that a button whose caption merely *contains* the word (for
 * instance "Upload and add to application") cannot claim to be one — that one
 * would be refused by the submit guard anyway, and it is better to be refused
 * twice than once.
 */
export const ADD_ENTRY_CONTROL_RE =
  /^\+?\s*add\b(?!\s*ress)(\s+(another|more|an|a|new|entry|item|row))?\b/i;

/**
 * A control that commits the entry currently being edited.
 *
 * Deliberately narrow, and deliberately does not include "continue", "next",
 * "done and submit" or anything else that could plausibly move the whole
 * application forward rather than the one subform. Everything matched here is
 * additionally required to sit inside a section that `holdsSubmitControl` has
 * already cleared, and is re-checked against the submit words immediately
 * before it is pressed.
 */
export const COMMIT_ENTRY_CONTROL_RE = /^(save|done|add)\b/i;

/**
 * The board saying, in its own words, that this section needs at least one entry.
 *
 * Matched only to decide that a section is required and unsatisfied. The text is
 * never handed to anything that can act on it, and never reaches a model.
 */
export const AT_LEAST_ONE_ENTRY_RE =
  /\bat\s+least\s+one\b[^.!?]{0,40}\b(entry|entries|item|record|position|role|job|school|degree)\b/i;

type RawSection = {
  heading: string;
  addSelector: string;
  containerSelector: string;
  message: string;
};

/**
 * Serialised into the page, so it must be self-contained. Same rules as
 * `enumerateFieldsInPage`, and the same shadow-root walk, for the same reason:
 * on the board this was written for, the add control's caption lives on a light
 * DOM host and its real `<button>` lives in a shadow root.
 */
function enumerateRepeatingSectionsInPage(
  maxSections: number,
  handleAttr: string
): RawSection[] {
  const out: RawSection[] = [];
  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const parentOf = (node: Element): Element | null => {
    if (node.parentElement !== null) return node.parentElement;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };

  const deepUnder = (node: Element | Document, limit: number): Element[] => {
    const found: Element[] = [];
    const stack: (Element | Document | ShadowRoot)[] = [node];
    // The node's own shadow root counts as "under" it. See `deepQueryAll`.
    const own = (node as HTMLElement).shadowRoot;
    if (own !== null && own !== undefined) stack.push(own);
    const seen = new Set<Element | Document | ShadowRoot>();
    while (stack.length > 0 && found.length < limit) {
      const root = stack.pop();
      if (root === undefined || seen.has(root)) continue;
      seen.add(root);
      let children: Element[];
      try {
        children = Array.from(root.querySelectorAll("*"));
      } catch {
        continue;
      }
      for (const child of children) {
        found.push(child);
        const inner = (child as HTMLElement).shadowRoot;
        if (inner !== null && inner !== undefined) stack.push(inner);
        if (found.length >= limit) break;
      }
    }
    return found;
  };

  const controlWords = (element: Element): string => {
    const bits = [
      element.textContent ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("value") ?? "",
      element.getAttribute("title") ?? "",
    ];
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) {
      bits.push(root.host.textContent ?? "", root.host.getAttribute("aria-label") ?? "");
    }
    return clean(bits.join(" ")).slice(0, 200);
  };

  const SUBMITTISH = /\b(submit|send|apply|application|finish|complete)\w*\b/i;
  const ADDISH = /^\+?\s*add\b(?!\s*ress)(\s+(another|more|an|a|new|entry|item|row))?\b/i;
  const AT_LEAST_ONE =
    /\bat\s+least\s+one\b[^.!?]{0,40}\b(entry|entries|item|record|position|role|job|school|degree)\b/i;

  const isButtonish = (element: Element): boolean => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    return (
      tag === "button" ||
      tag === "a" ||
      (element.getAttribute("role") ?? "").toLowerCase() === "button" ||
      (tag === "input" && (type === "button" || type === "submit")) ||
      /(^|-)button$/.test(tag)
    );
  };

  /** Identical in intent to `enumerateFieldsInPage`'s guard of the same name. */
  const holdsSubmitControl = (node: Element): boolean => {
    for (const candidate of deepUnder(node, 400)) {
      const tag = candidate.tagName.toLowerCase();
      const type = (candidate.getAttribute("type") ?? "").toLowerCase();
      if (type === "submit" && (tag === "input" || tag === "button")) return true;
      if (!isButtonish(candidate)) continue;
      if (SUBMITTISH.test(controlWords(candidate))) return true;
    }
    return false;
  };

  const visible = (element: Element): boolean => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return true;
    for (const inner of deepUnder(element, 30)) {
      const innerBox = inner.getBoundingClientRect();
      if (innerBox.width > 0 && innerBox.height > 0) return true;
    }
    return false;
  };

  const HEADING_SEL = 'h1,h2,h3,h4,h5,h6,legend,[role="heading"],[data-test*="title" i]';
  const headingIn = (node: Element): string => {
    for (const candidate of deepUnder(node, 200)) {
      if (!candidate.matches(HEADING_SEL)) continue;
      const text = clean(candidate.textContent);
      if (text !== "" && text.length <= 80) return text;
    }
    return "";
  };

  let stamped = 0;
  const stamp = (element: Element, prefix: string): string => {
    const existing = element.getAttribute(handleAttr);
    if (existing !== null && existing !== "") return `[${handleAttr}="${existing}"]`;
    stamped++;
    const handle = `${prefix}${stamped}`;
    element.setAttribute(handleAttr, handle);
    return `[${handleAttr}="${handle}"]`;
  };

  const everything = deepUnder(document, 8000);
  for (const element of everything) {
    if (element.hasAttribute(handleAttr)) element.removeAttribute(handleAttr);
  }

  /**
   * The add controls in `node`, counted the way a person would count them.
   *
   * A web component add button is two or three nested button-ish elements
   * wrapped around one real `<button>` — `oc-button` around `spl-button` around
   * `button` — and all three match. Only the outermost is a control; the rest
   * are its packaging. Counting elements instead of controls made every section
   * look as if it held three add buttons, which is the number this uses to
   * decide it has climbed out of one section and into the whole form.
   */
  const addControlsIn = (node: Element | Document): Element[] => {
    const matches = deepUnder(node, 1500).filter(
      (element) => isButtonish(element) && visible(element) && ADDISH.test(controlWords(element))
    );
    const inner = new Set<Element>();
    for (const match of matches) {
      for (const descendant of deepUnder(match, 50)) inner.add(descendant);
    }
    return matches.filter((match) => !inner.has(match));
  };

  // An add control is the anchor: it is the one thing a repeating section
  // always has and an ordinary section never does.
  for (const adder of addControlsIn(document)) {
    if (out.length >= maxSections) break;

    // Never a control that submits, however it is worded, and never one whose
    // words say both "add" and something that sends the application.
    if (SUBMITTISH.test(controlWords(adder))) continue;
    if (holdsSubmitControl(adder)) continue;

    // Climb to the first ancestor that carries a heading. On this board that is
    // the header *row* — the flex box holding the title beside the Add button —
    // which is emphatically not the section: the entries mount in a sibling
    // below it, so stopping here left the commit control outside the container
    // and `pressCommitEntry` reported a section whose only buttons were Add.
    let container: Element | null = parentOf(adder);
    let heading = "";
    for (let depth = 0; container !== null && depth < 8; depth++) {
      heading = headingIn(container);
      if (heading !== "") break;
      container = parentOf(container);
    }
    if (container === null || heading === "") continue;

    // Then keep climbing for as long as the ancestor is still *this* section:
    // same heading, still exactly one add control, still no submit control. The
    // first ancestor that fails is the one that has swallowed the next section
    // or the form itself, and the last one that passed is the section's own box.
    for (let depth = 0; depth < 8; depth++) {
      const next = parentOf(container);
      if (next === null) break;
      if (headingIn(next) !== heading) break;
      if (addControlsIn(next).length !== 1) break;
      if (holdsSubmitControl(next)) break;
      container = next;
    }

    const text = clean(container.textContent).slice(0, 1200);
    const message = AT_LEAST_ONE.test(text) ? clean((text.match(AT_LEAST_ONE) ?? [""])[0]) : "";
    const markedRequired = /[*✱]/.test(heading) || /\(required\)/i.test(heading);
    // A section is one this must fill only if the board says so: either it is
    // showing its own "at least one entry" complaint, or its heading carries a
    // required marker. An optional "Add a reference" section is left alone.
    if ((message === "" && !markedRequired) || holdsSubmitControl(container)) continue;

    out.push({
      heading: clean(heading.replace(/[*✱]+/g, "").replace(/\(required\)/i, "")),
      addSelector: stamp(adder, "a"),
      containerSelector: stamp(container, "s"),
      message,
    });
  }

  return out;
}

/**
 * Every required repeating section on the page, or none.
 *
 * Never throws, for the same reason `enumerateFormFields` does not: a page this
 * cannot read is a page with no repeating sections, and the caller decides what
 * that means. Reporting a section that is not one costs a click on a control
 * this has already refused to believe is a submit button; missing one costs an
 * application that cannot be completed.
 */
export async function enumerateRepeatingSections(page: Page): Promise<RepeatingSection[]> {
  let raw: RawSection[];
  try {
    const result = await page.evaluate(
      inPageExpression(
        enumerateRepeatingSectionsInPage,
        `${MAX_REPEATING_SECTIONS}, ${jsLiteral(SECTION_HANDLE_ATTR)}`
      )
    );
    const failure = inPageError(result);
    if (failure !== null) throw new Error(failure);
    raw = Array.isArray(result) ? (result as RawSection[]) : [];
  } catch (err) {
    console.warn(
      `[form-fields] could not read the form's repeating sections (treating it as having none): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }

  const used = new Map<string, number>();
  const sections: RepeatingSection[] = [];
  for (const entry of raw) {
    if (typeof entry?.addSelector !== "string" || entry.addSelector === "") continue;
    const heading = typeof entry.heading === "string" ? entry.heading.slice(0, 120) : "";
    const base = normalizeText(heading).slice(0, 60) || `section-${sections.length + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    sections.push({
      key: seen === 0 ? base : `${base} #${seen + 1}`,
      heading,
      addSelector: entry.addSelector,
      containerSelector:
        typeof entry.containerSelector === "string" ? entry.containerSelector : entry.addSelector,
      message: typeof entry.message === "string" ? entry.message.slice(0, 200) : "",
    });
  }
  return sections;
}

/** What one control looks like at the moment somebody is about to press it. */
type PressCandidate = { found: boolean; words: string; submitish: boolean };

/**
 * Reads a control's own words back out of the page, right before it is clicked.
 *
 * This is the guard, and it is deliberately taken *at the last moment* rather
 * than trusted from the enumeration pass. A form re-renders between a read and a
 * click — that is the premise of half the comments in this file — and "the
 * button that was called Add when we looked" is not the same claim as "the
 * button that is called Add now". `assertNotAnApplicationSubmit` in
 * `fill-application-form.ts` applies the identical rule to the controls that
 * module presses.
 */
function describePressableInPage(selector: string): PressCandidate {
  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const resolveDeep = (sel: string): Element | null => {
    try {
      const light = document.querySelector(sel);
      if (light !== null) return light;
    } catch {
      return null;
    }
    const stack: (Document | ShadowRoot)[] = [document];
    const seen = new Set<Document | ShadowRoot>();
    while (stack.length > 0) {
      const root = stack.pop();
      if (root === undefined || seen.has(root)) continue;
      seen.add(root);
      let hosts: Element[];
      try {
        hosts = Array.from(root.querySelectorAll("*"));
      } catch {
        continue;
      }
      for (const host of hosts) {
        const inner = (host as HTMLElement).shadowRoot;
        if (inner === null || inner === undefined) continue;
        try {
          const hit = inner.querySelector(sel);
          if (hit !== null) return hit;
        } catch {
          return null;
        }
        stack.push(inner);
      }
    }
    return null;
  };

  const element = resolveDeep(selector);
  if (element === null) return { found: false, words: "", submitish: false };

  const bits = [
    element.textContent ?? "",
    element.getAttribute("aria-label") ?? "",
    element.getAttribute("value") ?? "",
    element.getAttribute("title") ?? "",
  ];
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
    bits.push(root.host.textContent ?? "", root.host.getAttribute("aria-label") ?? "");
  }
  const words = clean(bits.join(" ")).slice(0, 200);
  const submitish = /\b(submit|send|apply|application|finish|complete)\w*\b/i.test(words);
  // A `type="submit"` anywhere under it, whatever it says on the outside.
  let typedSubmit = false;
  try {
    typedSubmit =
      element.matches('input[type="submit"],button[type="submit"]') ||
      element.querySelector('input[type="submit"],button[type="submit"]') !== null;
  } catch {
    typedSubmit = true;
  }
  return { found: true, words, submitish: submitish || typedSubmit };
}

async function pressGuarded(
  page: Page,
  selector: string,
  allowed: RegExp,
  what: string
): Promise<ApplyOutcome> {
  let described: PressCandidate;
  try {
    const raw = await page.evaluate(
      inPageExpression(describePressableInPage, jsLiteral(selector))
    );
    const failure = inPageError(raw);
    if (failure !== null) throw new Error(failure);
    described = raw as PressCandidate;
  } catch (err) {
    return {
      ok: false,
      readBack: "",
      detail: `could not re-read the ${what} control before pressing it: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!described.found) {
    return { ok: false, readBack: "", detail: `the ${what} control is no longer on the page` };
  }
  // Fail closed, loudly. Refusing here leaves a required section unfilled and
  // the run escalates; not refusing here could send somebody's application.
  if (described.submitish) {
    return {
      ok: false,
      readBack: described.words,
      detail:
        `refused to press the ${what} control: it now reads ` +
        `${JSON.stringify(described.words.slice(0, 80))}, which could submit the application`,
    };
  }
  if (!allowed.test(described.words)) {
    return {
      ok: false,
      readBack: described.words,
      detail:
        `refused to press the ${what} control: it reads ` +
        `${JSON.stringify(described.words.slice(0, 80))}, which is not a ${what} control`,
    };
  }

  await scrollIntoView(page, selector);
  try {
    await page.locator(selector).click();
  } catch (err) {
    return {
      ok: false,
      readBack: described.words,
      detail: `could not press the ${what} control: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return { ok: true, readBack: described.words, detail: `pressed ${JSON.stringify(described.words.slice(0, 40))}` };
}

/**
 * Presses one repeating section's add control, so its entry's fields mount.
 *
 * The only new click this module has learned, and it is the narrowest one that
 * could work: a control the perception pass already matched against
 * `ADD_ENTRY_CONTROL_RE` and cleared through the same submit guard the
 * activation ladder uses, re-read and re-checked at the instant of the press.
 */
export async function pressAddEntry(page: Page, section: RepeatingSection): Promise<ApplyOutcome> {
  return await pressGuarded(page, section.addSelector, ADD_ENTRY_CONTROL_RE, "add entry");
}

/**
 * Presses the control that commits the entry that is currently being edited.
 *
 * Scoped to the section's own container, so the only candidates are controls
 * that belong to the subform. SmartRecruiters will not count an experience entry
 * at all until its "Save experience entry" button is pressed — the fields can be
 * filled perfectly and the section still reports itself empty — so this is the
 * step that turns a filled subform into an entry the board acknowledges.
 *
 * Returns `ok: false` with a reason when there is nothing to press, which is the
 * correct answer for a board that commits an entry as it is typed.
 */
export async function pressCommitEntry(
  page: Page,
  section: RepeatingSection
): Promise<ApplyOutcome> {
  // Any suggestion list still hanging open is shut first. A click lands on
  // whatever is *painted* at the control's centre, and the last field in one of
  // these subforms is routinely a location autocomplete whose open menu covers
  // the Save button directly below it. This is also the one moment where Escape
  // is unambiguously safe: every field in the entry has already been written and
  // read back.
  await closeMenu(page);
  await page.waitForTimeout(MENU_POLL_MS);

  const first = await pressCommitEntryOnce(page, section);
  if (!first.ok) return first;

  // The read-back. A committed entry takes its edit form off the page and leaves
  // a summary in its place, so a commit control still standing there means the
  // press changed nothing — which is exactly what a live run did, silently,
  // while reporting that it had pressed Save. One retry, because committing the
  // same entry twice is the same entry, and because the first press sometimes
  // lands while the widget is still settling from the last field written into
  // it. Then it is reported honestly either way.
  await page.waitForTimeout(MENU_SETTLE_TIMEOUT_MS);
  const stillThere = await findCommitControl(page, section);
  if (stillThere === null || stillThere.selector === "") return first;

  const second = await pressCommitEntryOnce(page, section);
  if (!second.ok) return second;
  await page.waitForTimeout(MENU_SETTLE_TIMEOUT_MS);
  const stillThereAgain = await findCommitControl(page, section);
  if (stillThereAgain === null || stillThereAgain.selector === "") return second;
  return {
    ok: false,
    readBack: second.readBack,
    detail:
      `pressed ${JSON.stringify(second.readBack.slice(0, 40))} twice and the entry's own form is ` +
      `still on the page, so nothing was committed`,
  };
}

/** The commit control lookup, or null when the page could not be read. */
async function findCommitControl(
  page: Page,
  section: RepeatingSection
): Promise<CommitLookup | null> {
  try {
    const raw = await page.evaluate(
      inPageExpression(
        findCommitControlInPage,
        `${jsLiteral(section.containerSelector)}, ${jsLiteral(SECTION_HANDLE_ATTR)}`
      )
    );
    const failure = inPageError(raw);
    if (failure !== null) throw new Error(failure);
    return raw as CommitLookup;
  } catch {
    return null;
  }
}

async function pressCommitEntryOnce(
  page: Page,
  section: RepeatingSection
): Promise<ApplyOutcome> {
  let lookup: CommitLookup;
  try {
    const raw = await page.evaluate(
      inPageExpression(
        findCommitControlInPage,
        `${jsLiteral(section.containerSelector)}, ${jsLiteral(SECTION_HANDLE_ATTR)}`
      )
    );
    const failure = inPageError(raw);
    if (failure !== null) throw new Error(failure);
    lookup = raw as CommitLookup;
  } catch (err) {
    return {
      ok: false,
      readBack: "",
      detail: `could not look for a control that commits the entry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!lookup.containerFound) {
    return {
      ok: false,
      readBack: "",
      detail: `the "${section.heading}" section is no longer on the page`,
    };
  }
  if (lookup.selector === "") {
    // Said with the evidence, because "no Save button" and "a Save button this
    // refused to press" are different facts and only one of them is a bug here.
    return {
      ok: false,
      readBack: "",
      detail:
        `this section has no control that commits an entry` +
        (lookup.considered.length === 0
          ? " (it holds no pressable controls at all)"
          : ` (its controls read: ${lookup.considered
              .map((text) => JSON.stringify(text))
              .join(", ")})`),
    };
  }
  return await pressGuarded(page, lookup.selector, COMMIT_ENTRY_CONTROL_RE, "commit entry");
}

/** What the search for a commit control found, and what it had to look at. */
type CommitLookup = { selector: string; containerFound: boolean; considered: string[] };

/** Finds the save/done control inside one section, and stamps it. Self-contained. */
function findCommitControlInPage(containerSelector: string, handleAttr: string): CommitLookup {
  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const deepUnder = (node: Element | Document, limit: number): Element[] => {
    const found: Element[] = [];
    const stack: (Element | Document | ShadowRoot)[] = [node];
    // The node's own shadow root counts as "under" it. See `deepQueryAll`.
    const own = (node as HTMLElement).shadowRoot;
    if (own !== null && own !== undefined) stack.push(own);
    const seen = new Set<Element | Document | ShadowRoot>();
    while (stack.length > 0 && found.length < limit) {
      const root = stack.pop();
      if (root === undefined || seen.has(root)) continue;
      seen.add(root);
      let children: Element[];
      try {
        children = Array.from(root.querySelectorAll("*"));
      } catch {
        continue;
      }
      for (const child of children) {
        found.push(child);
        const inner = (child as HTMLElement).shadowRoot;
        if (inner !== null && inner !== undefined) stack.push(inner);
        if (found.length >= limit) break;
      }
    }
    return found;
  };

  const resolveDeep = (sel: string): Element | null => {
    try {
      const light = document.querySelector(sel);
      if (light !== null) return light;
    } catch {
      return null;
    }
    for (const candidate of deepUnder(document, 8000)) {
      const inner = (candidate as HTMLElement).shadowRoot;
      if (inner === null || inner === undefined) continue;
      try {
        const hit = inner.querySelector(sel);
        if (hit !== null) return hit;
      } catch {
        return null;
      }
    }
    return null;
  };

  const considered: string[] = [];
  const container = resolveDeep(containerSelector);
  if (container === null) return { selector: "", containerFound: false, considered };

  const words = (element: Element): string => {
    const bits = [
      element.textContent ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("value") ?? "",
    ];
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) {
      bits.push(root.host.textContent ?? "", root.host.getAttribute("aria-label") ?? "");
    }
    return clean(bits.join(" ")).slice(0, 200);
  };

  const SUBMITTISH = /\b(submit|send|apply|application|finish|complete)\w*\b/i;
  const COMMITISH = /^(save|done|add)\b/i;
  const ADDISH = /^\+?\s*add\b(?!\s*ress)(\s+(another|more|an|a|new|entry|item|row))?\b/i;

  const visible = (element: Element): boolean => {
    if (element.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return true;
    for (const inner of deepUnder(element, 20)) {
      const innerBox = inner.getBoundingClientRect();
      if (innerBox.width > 0 && innerBox.height > 0) return true;
    }
    return false;
  };

  let best: Element | null = null;
  for (const candidate of deepUnder(container, 600)) {
    const tag = candidate.tagName.toLowerCase();
    const type = (candidate.getAttribute("type") ?? "").toLowerCase();
    const buttonish =
      tag === "button" ||
      (candidate.getAttribute("role") ?? "").toLowerCase() === "button" ||
      (tag === "input" && type === "button") ||
      /(^|-)button$/.test(tag);
    if (!buttonish || type === "submit") continue;
    if (!visible(candidate)) continue;
    const text = words(candidate);
    if (considered.length < 12 && text !== "") considered.push(text.slice(0, 40));
    if (SUBMITTISH.test(text)) continue;
    // The add control also starts with "Add", and pressing it again would open
    // a second blank entry rather than commit the one being edited.
    if (ADDISH.test(text)) continue;
    if (!COMMITISH.test(text)) continue;
    // The outermost match wins: it is the one whose box a click lands inside.
    if (best === null || best.contains(candidate)) best = candidate;
  }
  if (best === null) return { selector: "", containerFound: true, considered };

  // Every previous commit stamp is cleared before this one is issued.
  //
  // The stamp used to be the fixed string "c1", which collided the moment a
  // form had two of these sections: Education's commit lookup marked its own
  // Save button "c1" while Experience's Save was already carrying "c1", and the
  // selector then resolved to whichever came first in the document. A live run
  // pressed "Save experience entry" twice and never saved the education entry
  // at all — and the log said "pressed Save Save experience entry" under the
  // Education heading, which is exactly the kind of quietly wrong thing this
  // file's read-backs exist to make visible.
  //
  // Only commit stamps are cleared: the add control and the section container
  // carry values under the same attribute and are still in use.
  for (const marked of deepUnder(document, 8000)) {
    const value = marked.getAttribute(handleAttr);
    if (value !== null && value.startsWith("c")) marked.removeAttribute(handleAttr);
  }
  best.setAttribute(handleAttr, "c1");
  return { selector: `[${handleAttr}="c1"]`, containerFound: true, considered };
}

/**
 * Whether the section is still complaining that it has no entries.
 *
 * The read-back for adding an entry, and the same idea as `readFieldValue`: the
 * board's own validation is the only authority on whether what was typed counted.
 */
export async function sectionStillUnsatisfied(
  page: Page,
  section: RepeatingSection
): Promise<boolean> {
  const script = `(() => {
    const sel = ${jsLiteral(section.containerSelector)};
    const el = ${RESOLVE_IN_PAGE_SRC}(sel);
    if (!el) return false;
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    return ${AT_LEAST_ONE_ENTRY_RE.toString()}.test(text);
  })()`;
  try {
    return (await page.evaluate(script)) === true;
  } catch {
    return false;
  }
}

// ───────────────────────────────────
// Action — one decided value into one control
// ───────────────────────────────────

export type ApplyOutcome = {
  ok: boolean;
  /** What the control reads back afterwards. */
  readBack: string;
  detail: string;
};

/**
 * Reads one control's current value back out of the page.
 *
 * ── Why the search box is not where the answer is (JOB-107) ─────────────────
 * A web component select does not keep its committed selection on the element
 * this addresses. SmartRecruiters' phone-country picker is the case that forced
 * this: the focusable control is an `input[role="combobox"]` labelled "Search by
 * country/region or code", and a search box is *supposed* to clear itself once a
 * selection commits. So the read below found `""` on a control that had just
 * been set correctly, `applyFieldValue` reported "the value could not be
 * applied", and a required field the board validates ("Please provide a valid
 * phone number") blocked every run.
 *
 * The read back guard was right to refuse — an empty control is an empty
 * control, and loosening it would have let a genuinely unset picker through.
 * What was wrong was the question. Read off the live board, the committed
 * selection renders one shadow root up, on the `spl-select` that owns the search
 * box, as `<spl-typography-body class="c-spl-phone-field-selected-value">+1`.
 * That is the same *kind* of node react-select calls `single-value`, spelled
 * differently, and it was unreachable for two independent reasons: the class
 * probe did not know the word "selected", and neither `querySelector` nor
 * `parentElement` crosses a shadow boundary, so the walk up died at the first
 * one and never reached the owner at all.
 *
 * Both are fixed here and nothing else is. The value still has to be *rendered*
 * somewhere an applicant would read it; a component that shows nothing still
 * reads `""` and is still escalated. In particular the owning element's own
 * committed `value` property is deliberately **not** consulted as a fallback:
 * on this very picker it holds `"US"` while the option chosen is
 * "United States +1", and answering with a code no applicant sees would turn a
 * correct selection into a reported mismatch. The caption is what the person
 * sees, so the caption is what is checked.
 */
export async function readFieldValue(page: Page, field: EnumeratedField): Promise<string> {
  const script = `(() => {
    const sel = ${jsLiteral(field.selector)};
    const el = ${RESOLVE_IN_PAGE_SRC}(sel);
    if (!el) return "";
    // Defensive about the type as well as the whitespace: a custom element's
    // \`value\` is frequently not a string at all (this board's phone field holds
    // the object \`{"country":"US"}\`), and calling \`.replace\` on one throws out
    // of the whole script, which reads downstream as an empty control.
    const clean = (v) => (typeof v === "string" ? v : "").replace(/\\s+/g, " ").trim();
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const opt = el.options[el.selectedIndex];
      return el.value === "" ? "" : clean(opt && opt.textContent);
    }
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "radio" || type === "checkbox") return el.checked ? "checked" : "";
    const role = (el.getAttribute("role") || "").toLowerCase();
    const isCombo = role === "combobox" || el.getAttribute("aria-autocomplete") === "list";
    if (isCombo) {
      // One level of the walk: this element's own subtree, then its own shadow
      // root. Two \`querySelector\` calls rather than a bounded walk over
      // everything underneath — see \`nearestMatch\` in \`enumerateFieldsInPage\`
      // for why a budget is the wrong tool here, and why these two have to stay
      // the same shape as each other.
      const nearestMatch = (root, css) => {
        try { const light = root.querySelector(css); if (light) return light; }
        catch (e) { return null; }
        const inner = root.shadowRoot;
        if (!inner) return null;
        try { return inner.querySelector(css); } catch (e) { return null; }
      };
      // The nearest level that renders something wins, exactly as before. Only
      // the reach of each level, and the number of levels, has changed.
      let shell = el;
      for (let d = 0; shell && d < 7; d++) {
        const rendered = nearestMatch(shell, ${jsLiteral(SELECTED_VALUE_SELECTOR)});
        if (rendered) { const t = clean(rendered.textContent); if (t) return t; }
        const mirror = nearestMatch(shell, ${jsLiteral(VALUE_MIRROR_SELECTOR)});
        if (mirror) { const v = clean(mirror.value); if (v) return v; }
        // \`parentElement\` is null at the top of a shadow root; the way out is
        // the root's host. Without this the walk stops inside the widget that
        // holds the search box and never reaches the one holding the answer.
        let up = shell.parentElement;
        if (!up) {
          const root = shell.getRootNode && shell.getRootNode();
          up = root && root.host ? root.host : null;
        }
        shell = up;
      }
    }
    return clean(el.value);
  })()`;
  try {
    const value = await page.evaluate(script);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/**
 * One element's own visible text, for confirming what is about to be clicked.
 *
 * JOB-047 makes it walk open shadow roots when the element itself reads empty,
 * which is the same definition of "an option's words" that the menu read used
 * (`deepText`, inside the enumeration script). The two have to agree: this read
 * is what confirms the option at a position is still the one that was chosen,
 * so measuring text differently from the read that chose it reports every web
 * component menu row as having silently turned into an empty string. That is
 * exactly what a live run said about SmartRecruiters' country picker — "that
 * position now reads "" rather than "United States"" — for a menu that was
 * sitting there perfectly readable.
 *
 * The explanation lives here rather than inside the evaluated string on
 * purpose. `tests/unit/form-fields.test.ts` decides which of this file's
 * scripts it was handed by looking for a substring unique to that script, and a
 * comment that names another one of them makes the fixture answer as the wrong
 * script. Which it duly did.
 */
async function readElementText(page: Page, selector: string): Promise<string> {
  const script = `(() => {
    const sel = ${jsLiteral(selector)};
    const el = ${RESOLVE_IN_PAGE_SRC}(sel);
    if (!el) return "";
    const clean = (v) => (v || "").replace(/\\s+/g, " ").trim();
    const own = clean(el.textContent);
    if (own) return own;
    const parts = [];
    const stack = [el];
    const seen = new Set();
    let budget = 200;
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      let kids = [];
      try { kids = Array.from(node.children || []); } catch { kids = []; }
      const inner = node.shadowRoot;
      if (inner) { try { kids = kids.concat(Array.from(inner.children || [])); } catch {} }
      if (kids.length === 0) {
        const text = clean(node.textContent);
        if (text) parts.push(text);
        continue;
      }
      for (const kid of kids) stack.push(kid);
    }
    return clean(parts.reverse().join(" "));
  })()`;
  try {
    const text = await page.evaluate(script);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

/**
 * JOB-266. Commits a SmartRecruiters `aria-multiselectable` listbox option by
 * dispatching the full pointer/mouse/keyboard event sequence a real
 * interaction produces (focus, pointerdown, mousedown, pointerup, mouseup,
 * click, the native `.click()` activation behaviour, and an Enter and a
 * Space keydown/keyup pair) directly at the deepest `[role="option"]`
 * descendant of `selector` — in one `evaluate` round trip, so there is no
 * gap between finding the element and interacting with it for a re-render to
 * land in.
 *
 * Every other commit mechanism this file knows how to send — a bare `Enter`,
 * a bare `Space`, `Locator.click()` on the option's own light-DOM wrapper,
 * and a coordinate click on the painted row's own box — was tried live
 * against AbbVie's "location(s) not willing to work in" question and left
 * the control reading empty every time, so this sends everything a widget of
 * this shape could plausibly be listening for in one pass rather than
 * guessing at a single one. See the JOB-266 PR description for the live
 * verification history.
 *
 * NOTE: this sends click, the native `.click()` activation behaviour, Enter,
 * and Space in sequence, all in one call. On a widget that toggles per
 * activation rather than committing on the first one, that sequence could
 * net cancel (select, then deselect, then reselect) instead of landing in a
 * single committed state. This is currently inert because no mechanism this
 * file has tried causes any observable state change on the target widget at
 * all, so the net cancel risk has never actually been exercised. See
 * JOB-266.
 *
 * NEXT INVESTIGATOR: the `PointerEvent`s below are constructed without
 * `pointerType`, `pointerId`, or `isPrimary`, so they default to `""`,
 * `0`/unset, and `false`. Some Lit based widgets gate their handlers on
 * `event.pointerType === "mouse"` or `event.isPrimary === true`, which would
 * make a synthetic `PointerEvent` silently no op even though
 * `dispatchEvent()` reports success. Try adding explicit
 * `pointerType: "mouse"`, `pointerId: 1`, `isPrimary: true` to `opts` before
 * ruling out the pointer events entirely.
 *
 * NOT CONFIRMED WORKING. Live testing against AbbVie's SmartRecruiters
 * screening question left the control reading empty after this dispatch
 * too. Shipped anyway because it is provably zero cost when it does not
 * help (the existing mechanisms still run first and this is additive), and
 * the exploration record above narrows what the next attempt should try.
 * See JOB-266.
 */
// NOT CONFIRMED WORKING, see JOB-266.
async function dispatchOptionEvents(page: Page, selector: string): Promise<void> {
  const script = `(() => {
    const sel = ${jsLiteral(selector)};
    const el = ${RESOLVE_IN_PAGE_SRC}(sel);
    if (!el) return;
    let deepest = null;
    let budget = 200;
    const stack = [el];
    const seen = new Set();
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if ((node.getAttribute && node.getAttribute("role")) === "option") deepest = node;
      let kids = [];
      try { kids = Array.from(node.children || []); } catch { kids = []; }
      const inner = node.shadowRoot;
      if (inner) { try { kids = kids.concat(Array.from(inner.children || [])); } catch {} }
      for (const kid of kids) stack.push(kid);
    }
    const target = deepest || el;
    const rect = target.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, view: window, button: 0 };
    try { if (target.focus) target.focus(); } catch (e) {}
    try {
      target.dispatchEvent(new PointerEvent("pointerdown", opts));
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      target.dispatchEvent(new PointerEvent("pointerup", opts));
      target.dispatchEvent(new MouseEvent("mouseup", opts));
      target.dispatchEvent(new MouseEvent("click", opts));
      if (target.click) target.click();
      const keyOpts = { bubbles: true, cancelable: true, composed: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
      target.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
      target.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
      const spaceOpts = { bubbles: true, cancelable: true, composed: true, key: " ", code: "Space", keyCode: 32, which: 32 };
      target.dispatchEvent(new KeyboardEvent("keydown", spaceOpts));
      target.dispatchEvent(new KeyboardEvent("keyup", spaceOpts));
    } catch (e) {}
  })()`;
  try {
    await page.evaluate(script);
  } catch {
    // The read-back this feeds into is what decides success or failure; a
    // dispatch that could not even run reads back exactly like one that ran
    // and changed nothing.
  }
}

/** `checked` for a radio group means "one of its radios is checked". */
async function readRadioGroupValue(page: Page, field: EnumeratedField): Promise<string> {
  for (const [index, selector] of field.optionSelectors.entries()) {
    try {
      if (await page.locator(selector).isChecked()) return field.options[index] ?? "checked";
    } catch {
      // A radio that cannot be read is not a radio that is checked.
    }
  }
  return "";
}

/**
 * Types a value into a single- or multi-line text control and confirms it.
 *
 * `locator.fill` is a structured call carrying the value as an argument — the
 * same property `typeInto` relies on in `stagehand-session.ts`, reached more
 * directly because there is no observation to cache here: the selector came out
 * of the DOM, not out of a model.
 */
async function fillText(page: Page, field: EnumeratedField, value: string): Promise<ApplyOutcome> {
  await scrollIntoView(page, field.selector);
  try {
    await page.locator(field.selector).fill(value);
  } catch (err) {
    return {
      ok: false,
      readBack: "",
      detail: `could not type into the control: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const readBack = await readFieldValue(page, field);
  const matches = normalizeText(readBack) === normalizeText(value);
  return {
    ok: matches,
    readBack,
    detail: matches
      ? "typed and read back identical"
      : `the control now reads ${JSON.stringify(readBack.slice(0, 120))}, which is not what was typed`,
  };
}

/**
 * Finds the one option of a native `<select>` whose visible text says `wanted`,
 * against the select's **full live list** rather than the truncated prefix the
 * enumeration reported.
 *
 * Exists for issue #94: Lever's university dropdown holds 3,302 options, the
 * enumeration reports the first 60, and a school anywhere past "B" could never
 * be chosen even when the decision layer proposed its exact wording. Matching
 * here is the same normalized equality `selectNative` already applies — an
 * option that is not literally on the live list still cannot be chosen, and an
 * ambiguous match (two options with the same normalized text) is refused
 * rather than resolved.
 *
 * Serialised into the page (see `enumerateFieldsInPage`), so it is
 * self-contained on purpose.
 */
function matchSelectOptionInPage(
  controlSelector: string,
  wanted: string
): { matches: number; value: string; text: string } {
  const norm = (value: string): string =>
    value
      .normalize("NFC")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  let control: Element | null = null;
  try {
    const path = controlSelector.startsWith("xpath=")
      ? controlSelector.slice("xpath=".length)
      : controlSelector;
    control =
      path.startsWith("/") || path.startsWith("(")
        ? (document.evaluate(path, document, null, 9, null).singleNodeValue as Element | null)
        : document.querySelector(controlSelector);
  } catch {
    control = null;
  }
  if (control === null || control.tagName.toLowerCase() !== "select") {
    return { matches: 0, value: "", text: "" };
  }

  const target = norm(wanted);
  const hits: { value: string; text: string }[] = [];
  for (const option of Array.from((control as HTMLSelectElement).options)) {
    const text = (option.textContent ?? "").replace(/\s+/g, " ").trim();
    if (option.value !== "" && text !== "" && norm(text) === target) {
      hits.push({ value: option.value, text });
    }
  }
  const first = hits[0];
  return {
    matches: hits.length,
    value: first === undefined ? "" : first.value,
    text: first === undefined ? "" : first.text,
  };
}

/**
 * A native `<select>`: one structured call, one read-back.
 *
 * The visible text is translated to the option's `value` attribute first,
 * because that is what the browser's own selection API takes — and the
 * translation is a lookup in a list read off this same page, not a guess. When
 * the reported list is a truncated prefix of a longer one, the lookup falls
 * back to the select's full live list (`matchSelectOptionInPage`) before
 * giving up — still an exact normalized match against options the DOM itself
 * offers, never an invention.
 */
async function selectNative(page: Page, field: EnumeratedField, value: string): Promise<ApplyOutcome> {
  const index = field.options.findIndex((option) => normalizeText(option) === normalizeText(value));
  let optionValue = index === -1 ? "" : field.optionValues[index] ?? "";
  if (index === -1 && field.optionsTruncated) {
    let live: { matches: number; value: string; text: string } | null = null;
    try {
      const raw = await page.evaluate(
        inPageExpression(
          matchSelectOptionInPage,
          `${jsLiteral(field.selector)}, ${jsLiteral(value)}`
        )
      );
      if (inPageError(raw) === null && raw !== null && typeof raw === "object") {
        live = raw as { matches: number; value: string; text: string };
      }
    } catch {
      live = null;
    }
    if (live !== null && live.matches === 1 && live.value !== "") {
      optionValue = live.value;
    } else if (live !== null && live.matches > 1) {
      return {
        ok: false,
        readBack: await readFieldValue(page, field),
        detail:
          `too ambiguous to choose between: ${live.matches} of this dropdown's options ` +
          `read "${value}"`,
      };
    }
  }
  if (index === -1 && optionValue === "") {
    return {
      ok: false,
      readBack: await readFieldValue(page, field),
      detail:
        `"${value}" is not one of this dropdown's options` +
        (field.optionsTruncated ? " (checked against the full live list, not only the reported prefix)" : ""),
    };
  }
  if (optionValue === "") {
    return {
      ok: false,
      readBack: await readFieldValue(page, field),
      detail: `the option "${value}" carries no value attribute to select it by`,
    };
  }

  await scrollIntoView(page, field.selector);
  try {
    await page.locator(field.selector).selectOption([optionValue]);
  } catch (err) {
    return {
      ok: false,
      readBack: "",
      detail: `could not choose "${value}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const readBack = await readFieldValue(page, field);
  const matches = normalizeText(readBack) === normalizeText(value);
  return {
    ok: matches,
    readBack,
    detail: matches ? `chose "${value}" and read it back` : `the control reads "${readBack}" instead`,
  };
}

/**
 * A scripted dropdown: open it, find the option whose visible text *is* the
 * decided value, click that element.
 *
 * Three things this deliberately does not do. It does not accept a near match —
 * `allowContains` is off by default, and a value that is not on the menu comes
 * back as a failure the caller escalates rather than a best guess clicked into a
 * real employer's form. It does not describe the option to a model to have it
 * found; the option's own DOM node is clicked. And it does not fall back to
 * leaving the typed text in the box, which on a react-select control looks
 * filled and submits empty.
 *
 * `allowContains` is the one exception, for the async "Location (City)" style of
 * control that has no options at all until you type: there the menu is a
 * server's answer to our own query, so accepting an option that *contains* what
 * we asked for ("San Francisco, CA, USA" for "San Francisco") is matching, not
 * guessing — and only when one option survives the narrowing below.
 *
 * ── Why "exactly one option contains it" was not enough (JOB-051) ────────────
 * That rule is right about the danger and wrong about how often a real city
 * name is unique. Greenhouse's location service, asked for "San Francisco",
 * answers with six suggestions, and *every one of them* contains the query:
 *
 *   San Francisco, California, United States
 *   San Francisco de Macorís, Duarte, Dominican Republic
 *   San Francisco, Agusan del Sur, Philippines
 *   San Francisco De Borja, Lima, Peru
 *   San Francisco, Cebu, Philippines
 *   South San Francisco, California, United States
 *
 * Six matches is not one, so this refused, and the field stayed empty through a
 * whole run that then failed the board's own validation with "Please enter your
 * location". Read off the live Virtu posting on 2026-08-22, not imagined.
 *
 * So the tie is broken with more of what the candidate actually attested rather
 * than by taking the first suggestion. `contextTerms` carries those extra
 * attested strings (the country they told us they live in), and a suggestion
 * has to earn its place twice over:
 *
 *   · its *leading* comma segment must equal the query exactly, which is what
 *     separates "San Francisco" from "South San Francisco" and from
 *     "San Francisco de Macorís" — a different city whose name merely starts
 *     the same way, and
 *   · every context term must appear somewhere in it, which is what separates
 *     the California one from the Philippine and Peruvian ones.
 *
 * One survivor is a match on two independently attested facts. Anything else is
 * still -1 and still escalated, so the guard this widens is a guard that now
 * has more evidence, not a guard that now guesses. Nothing here invents a
 * location: every term compared came from the candidate's own intake.
 */

/**
 * JOB-266. True when the page currently open is a SmartRecruiters listing.
 *
 * A local twin of `isSmartRecruitersPage` in `lib/fill-application-form.ts`
 * (added by JOB-260 for the same reason: a phone-field read-back tolerance
 * scoped to this one board), rather than an import of it. `fill-application-
 * form.ts` already imports from this file, so the other direction would be a
 * circular import; JOB-246 hit the identical shape of problem with
 * `containsAtWordBoundary` and duplicated rather than restructured for it, and
 * this follows that precedent. Both twins read off `page.url()` through the
 * same `matchAtsHost` table in `lib/ats-boards.ts`, so they can never disagree
 * about what counts as a SmartRecruiters page.
 */
async function isSmartRecruitersPage(page: Page): Promise<boolean> {
  try {
    const current = await page.url();
    const hostname = new URL(String(current)).hostname;
    return matchAtsHost(hostname)?.ats === "smartrecruiters";
  } catch {
    return false;
  }
}

async function chooseFromMenu(
  page: Page,
  field: EnumeratedField,
  value: string,
  allowContains: boolean,
  allowFreeText: boolean,
  contextTerms: readonly string[] = []
): Promise<ApplyOutcome> {
  // Choosing an option is idempotent — the same option chosen twice is the same
  // form — so one retry is free, and it is worth having: on a live Greenhouse
  // form the click occasionally lands while the widget is still re-rendering
  // from the *previous* field and selects nothing at all. A retry is allowed
  // only when the control came back **empty**; a control holding a *different*
  // value is a real mismatch and is escalated, never clicked at again.
  let outcome = await chooseFromMenuOnce(
    page,
    field,
    value,
    allowContains,
    allowFreeText,
    contextTerms
  );
  if (!outcome.ok && outcome.readBack === "") {
    await closeMenu(page);
    await page.waitForTimeout(400);
    outcome = await chooseFromMenuOnce(
      page,
      field,
      value,
      allowContains,
      allowFreeText,
      contextTerms
    );
  }
  return outcome;
}

/**
 * JOB-246. Whether `needle` appears in `haystack` bounded by non-word
 * characters on both sides, rather than anywhere at all.
 *
 * `chooseFromMenuOnce`'s own tie-break used to test a context term with plain
 * `.includes()`, which is exactly wrong for the short country abbreviations
 * `countryContextTerms` writes: the term "us" is a real substring of "San
 * Francisco, **Agusan** del Sur, Philippines", so a candidate typed with no
 * attested country and a resume reading "United States" still had that
 * suggestion survive the tie-break alongside the correct one — two survivors,
 * which `chooseFromMenuOnce` correctly refuses to choose between. Verified
 * live against Freeform's Location (City) field on 2026 08 28: providing the
 * attested country term alone did not fix the field, because "us" kept
 * matching Agusan del Sur too, until this boundary check went in.
 *
 * A private copy of `fill-application-form.ts`'s `containsAtWordBoundary`
 * rather than a shared import: that module already imports from this one, so
 * the reverse import would be circular, and the function itself is small
 * enough that keeping two copies in sync costs less than restructuring the
 * module boundary to avoid it.
 */
function containsAtWordBoundary(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : haystack[at - 1]!;
    const afterAt = at + needle.length;
    const after = afterAt >= haystack.length ? "" : haystack[afterAt]!;
    const boundedLeft = before === "" || !/[a-z0-9]/i.test(before);
    const boundedRight = after === "" || !/[a-z0-9]/i.test(after);
    if (boundedLeft && boundedRight) return true;
    from = at + 1;
  }
}

async function chooseFromMenuOnce(
  page: Page,
  field: EnumeratedField,
  value: string,
  allowContains: boolean,
  allowFreeText: boolean,
  contextTerms: readonly string[] = []
): Promise<ApplyOutcome> {
  const wanted = normalizeText(value);
  /**
   * The attested terms, each already split into the spellings that count as it.
   *
   * JOB-047. `contextTerms` is ANDed — every term has to appear — which is what
   * makes one survivor mean "matched on two independently attested facts". That
   * is right, and it is also why a second spelling of the *same* fact cannot
   * simply be added to the list: "United States" and "US" are one fact, and
   * requiring both would reject every option that spells it either way.
   *
   * So a term may carry its equivalent spellings separated by `|`, and is
   * satisfied when any one of them appears. A term with no `|` in it behaves
   * exactly as it did. This is not a widening of what counts as evidence — the
   * same one fact is still required — it is the difference between recognising
   * that fact on a board that writes "San Francisco, California, United States"
   * and on one that writes "San Francisco, CA, US". SmartRecruiters writes the
   * second, and the country term never matched it.
   */
  const terms = contextTerms
    .map((term) =>
      term
        .split("|")
        .map((spelling) => normalizeText(spelling))
        .filter((spelling) => spelling !== "" && spelling !== wanted)
    )
    .filter((spellings) => spellings.length > 0);

  const pick = (menu: OpenMenu): number => {
    const exact = menu.texts.findIndex((text) => normalizeText(text) === wanted);
    if (exact !== -1) return exact;
    if (!allowContains) return -1;
    const matches = menu.texts
      .map((text, index) => ({ text: normalizeText(text), index }))
      .filter((entry) => entry.text.includes(wanted));
    // One option containing the query needs no tie-break: there is nothing to
    // confuse it with.
    if (matches.length === 1) return matches[0]?.index ?? -1;
    if (matches.length === 0) return -1;
    // Several did. See this function's header: narrowed by the query being the
    // whole of the suggestion's leading segment AND by every attested context
    // term appearing in it. Still -1 unless exactly one survives, because two
    // survivors is exactly the case where a wrong pick is invisible on a
    // screenshot.
    const narrowed = matches.filter(
      (entry) =>
        normalizeText(entry.text.split(",")[0] ?? "") === wanted &&
        terms.every((spellings) =>
          spellings.some((spelling) => containsAtWordBoundary(entry.text, spelling))
        )
    );
    return narrowed.length === 1 ? (narrowed[0]?.index ?? -1) : -1;
  };

  let menu: OpenMenu = NO_MENU;

  /**
   * The fullest list this control has shown at any point in this attempt.
   *
   * JOB-052. `menu` below holds the *latest* reading, and `narrow()` replaces
   * it with whatever survived a typed search — which, for a value that is not
   * on the list, is nothing at all. Reporting that residue made a control that
   * had just offered five options read as "the dropdown offered no options to
   * choose from", and that sentence sent a real investigation after a widget
   * bug when the truth was that the form does not offer this candidate's
   * answer: Virtu's "expected graduation year" lists 2026 through 2030 and the
   * candidate graduates in 2025. Kept so the report below can name the options
   * a human needs in order to tell those two situations apart.
   */
  let offered: OpenMenu = NO_MENU;
  const remember = (seen: OpenMenu): OpenMenu => {
    if (seen.texts.length > offered.texts.length) offered = seen;
    return seen;
  };

  /**
   * Narrows the menu by typing the value into it, then waits for the list to
   * settle. The string typed here is one this system decided on — an option it
   * read off this page, or a fact about the candidate — so nothing untrusted is
   * being fed anywhere; it is a search query, and the answer is still only ever
   * chosen from the options that come back.
   */
  const narrow = async (): Promise<number> => {
    try {
      await page.locator(field.selector).fill(value);
    } catch {
      // Not every combobox accepts typing. The menu read below still stands.
      return pick(menu);
    }
    const deadline = Date.now() + MENU_SEARCH_TIMEOUT_MS;
    menu = remember(await readOpenMenu(page, field));
    let found = pick(menu);
    while (found === -1 && Date.now() < deadline) {
      await page.waitForTimeout(MENU_POLL_MS);
      menu = remember(await readOpenMenu(page, field));
      found = pick(menu);
    }
    return found;
  };

  /**
   * JOB-047. A search control is asked its question before it is poked.
   *
   * `openMenu` clicks its way up the activation ladder and then reads. For a
   * menu with a fixed list that is the only thing that can work, and it is
   * unchanged below. For a control whose list *is* a server's answer to a
   * query, clicking first is at best a wasted round trip and at worst the thing
   * that breaks it: SmartRecruiters' location autocomplete declares
   * `minquerylength="3"`, so a click leaves it collapsed and empty, and five
   * clicks up the ladder leave it collapsed, empty, and no longer where the
   * first click found it. The required City field came back "the dropdown could
   * not be opened" on every live run, while typing into that same control by
   * hand produced eight suggestions every time.
   *
   * So: if this control's options were not known in advance, type the value and
   * see what comes back. If nothing does, the click ladder still runs exactly as
   * it did, and a control that genuinely needs a click to open is filled the way
   * it always was. Nothing is skipped; one thing is tried first.
   */
  const isSearchControl = !field.optionsKnown || field.options.length === 0;
  let index = isSearchControl ? await narrow() : -1;

  let openedOnClick = menu.expanded || menu.texts.length > 0;
  if (index === -1) {
    menu = remember(await openMenu(page, field));
    openedOnClick = openedOnClick || menu.expanded || menu.texts.length > 0;
    index = menu.count > MAX_UNFILTERED_MENU_OPTIONS ? await narrow() : pick(menu);
    // Either the list was short and the value is not on it, or it is a search
    // control that had nothing in it until it was asked a question.
    if (index === -1) index = await narrow();
  }

  if (index === -1) {
    /**
     * The fullest reading available right now, worded for a report: whatever a
     * search left behind if it left anything, and otherwise the fullest list
     * this control showed at any point. See `offered` above for why the
     * difference matters. A function rather than a value because the two
     * reports below are written either side of one more attempt to see the
     * list.
     */
    const describe = (): { empty: boolean; listed: string } => {
      const shown = menu.texts.length > 0 ? menu : offered;
      return {
        empty: shown.texts.length === 0,
        listed: `${shown.texts
          .slice(0, 8)
          .map((text) => JSON.stringify(text))
          .join(", ")}${shown.count > 8 ? ", …" : ""}`,
      };
    };
    // JOB-044. `allowFreeText` is only ever true for a control the caller has
    // already decided accepts typed text as an answer in its own right —
    // Greenhouse's "School" combobox is the one this was written for, see
    // `SCHOOL_FIELD_LABEL_RE` in `lib/fill-application-form.ts`. `narrow()`
    // above has already typed `value` into the field with `.fill()`; the read
    // back here is what confirms that stuck rather than assuming it did,
    // because a control that does NOT actually accept free text clears an
    // unmatched search back to empty on its own; leaving that as a false
    // "filled" would be worse than asking.
    if (allowFreeText) {
      const typed = await readFieldValue(page, field);
      if (normalizeText(typed) === wanted) {
        const asked = describe();
        await closeMenu(page);
        return {
          ok: true,
          readBack: typed,
          detail:
            `no dropdown option matched "${value}"` +
            (asked.empty ? " (the dropdown offered none)" : ` (offered: ${asked.listed})`) +
            `; left as typed free text, which this control accepts`,
        };
      }
    }

    // JOB-052. A search that matched nothing leaves an empty menu behind, and
    // for a control whose options were never harvested that empty menu is the
    // only reading there is — which is how "2025" against a list running 2026
    // to 2030 was reported as a dropdown that offered nothing at all. So when
    // nothing has been seen, the query is taken back out and the control asked
    // once more, purely so this report can name what it does offer. Nothing is
    // chosen here and the outcome is a failure either way; only the wording of
    // it changes, and the person reading it is the one deciding whether this
    // posting fits them.
    if (offered.texts.length === 0) {
      try {
        await page.locator(field.selector).fill("");
      } catch {
        // A control that will not take an empty string has nothing more to say.
      }
      menu = remember(await openMenu(page, field));
    }

    const asked = describe();
    await closeMenu(page);
    return {
      ok: false,
      readBack: await readFieldValue(page, field),
      detail: asked.empty
        ? openedOnClick
          ? "the dropdown offered no options to choose from"
          : `the dropdown could not be opened, and typing "${value}" into it produced no options`
        : `"${value}" is not one of this dropdown's options (${asked.listed})`,
    };
  }

  const optionSelector = menu.selectors[index];
  const chosen = menu.texts[index] ?? value;
  if (optionSelector === undefined) {
    await closeMenu(page);
    return { ok: false, readBack: "", detail: "the matched option had no addressable element" };
  }

  // Brought on screen if it is not already, then re-read, then clicked — in
  // that order. A click lands where the option is *painted*, so an option
  // scrolled out of view is a click on something else; and menus re-render
  // (react-select rebuilds its whole list on every keystroke), so "the option
  // at position 4" is only the right thing to click while position 4 is still
  // the option that was chosen. The re-read is what proves both.
  await scrollIfOffscreen(page, optionSelector);
  const stillReads = await readElementText(page, optionSelector);
  if (normalizeText(stillReads) !== normalizeText(chosen)) {
    await closeMenu(page);
    return {
      ok: false,
      readBack: await readFieldValue(page, field),
      detail:
        `the option to click moved between reading the menu and clicking it — that position ` +
        `now reads ${JSON.stringify(stillReads.slice(0, 80))} rather than ` +
        `${JSON.stringify(chosen.slice(0, 80))}. Nothing was chosen.`,
    };
  }

  // ── JOB-266 ──────────────────────────────────────────────────────────────
  // SmartRecruiters' "Preliminary questions" screening step draws its "select
  // one or more" questions ("Which, if any, location(s) are you not willing
  // to work in?", "Please select your area of interest(s):", "Select your
  // desired work locations in the U.S.:", "In what country/countries are you
  // currently authorized to work?") as `[role="listbox"
  // aria-multiselectable="true"]`, holding `<spl-select-option>` rows whose
  // committed answer is rendered as a tag in a sibling `<spl-tags-list>`, not
  // as the single-value caption `readFieldValue`'s combobox branch already
  // knows how to find.
  //
  // Six commit mechanisms were tried live against AbbVie's "location(s) not
  // willing to work in" question and every one of them left the control
  // reading empty: a bare `Enter`, a bare `Space` (the WAI ARIA convention
  // for toggling a multiselect listbox row), `Locator.click()` on the
  // resolved `optionSelector` element, a coordinate click on the deepest
  // `[role="option"]` node's own painted box, `dispatchOptionEvents` below
  // (the full pointer, mouse, and keyboard sequence), and that same dispatch
  // followed by a `Tab` press on the search input on the theory the widget
  // commits on blur. A live read of the widget's own internal Lit state
  // (`__value`, `__tags`, `__selectedOptionsDictionary` on the custom
  // element, none of it reflected to an HTML attribute) confirmed this is
  // not a read back gap either: the internal state genuinely never changes
  // under any of the six. See the JOB-266 PR description for the full
  // verification history, including a rerun against a second employer on a
  // freshly created Browserbase context that reproduced the same failure
  // with no captcha in play, which rules out the repeated live testing
  // itself as the explanation.
  //
  // `dispatchOptionEvents` ships anyway, as the most thorough of the six
  // rather than the simplest: it is a strict superset of every other
  // mechanism tried, it is unreachable from every other board and from
  // SmartRecruiters' own single-select dropdowns, and it leaves a documented
  // starting point for whoever picks this back up rather than nothing at
  // all. It is not a confirmed fix.
  //
  // Scoped twice, so no other board's commit changes shape from this ticket:
  // the open menu has to declare itself `aria-multiselectable`, and the page
  // has to be a SmartRecruiters host. Every other listbox on every other
  // board — including SmartRecruiters' own single-select dropdowns — still
  // commits by keyboard, exactly as it did before this ticket.
  let blindWalk = false;
  if (menu.multiselectable && (await isSmartRecruitersPage(page))) {
    await dispatchOptionEvents(page, optionSelector);
  } else {
    // JOB-044. Committed by keyboard rather than by clicking `optionSelector`.
    // Video review of a real skipped application (Greenhouse's "Location"
    // combobox) showed the agent typing a city, a suggestion appearing, the
    // click on it not registering, and the raw unmatched text left sitting in
    // the field — a mouse click dispatches at the element's centroid over CDP
    // with no confirmation it landed on the widget's own hit target, and a
    // freshly re-rendered suggestion list is exactly where that gap shows up.
    // The `stillReads` check just above already proves the option at `index`
    // is still the one this chose; walking there by arrow key uses that same
    // index against the widget's own list order instead of a screen position,
    // which is what a real keyboard user does and what this control was built
    // to answer to.
    //
    // How far to walk is asked of the widget rather than assumed from the
    // ARIA pattern — see `highlightOption`, which is where the off-by-one
    // that chose the option after the right one on every Greenhouse dropdown
    // was fixed.
    //
    // Failing closed on `focusElement` itself, rather than firing the arrow
    // keys regardless: an `ArrowDown`/`Enter` sequence goes to whatever
    // element the page happens to have focused, and with nothing focused (or
    // focus left on the wrong control) that is exactly the "click didn't
    // register" failure mode this whole keyboard path exists to avoid, just
    // relocated one step earlier and left unreported.
    const focused = await focusElement(page, field.selector);
    if (!focused) {
      await closeMenu(page);
      return {
        ok: false,
        readBack: "",
        detail: "could not focus the control before selecting the option with the keyboard",
      };
    }
    try {
      const walk = await highlightOption(page, field, index, chosen);
      blindWalk = walk.blind;
      if (!walk.ok) {
        await closeMenu(page);
        return { ok: false, readBack: await readFieldValue(page, field), detail: walk.detail };
      }
      await page.keyPress("Enter");
    } catch (err) {
      await closeMenu(page);
      return {
        ok: false,
        readBack: "",
        detail: `could not select the option with the keyboard: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // A widget that re-renders its selection asynchronously reads empty for a
  // moment after the click. Polled rather than slept on, so the common case
  // costs one read.
  let readBack = await readFieldValue(page, field);
  const settleBy = Date.now() + MENU_SETTLE_TIMEOUT_MS;
  while (readBack === "" && Date.now() < settleBy) {
    await page.waitForTimeout(MENU_POLL_MS);
    readBack = await readFieldValue(page, field);
  }
  const shown = normalizeText(readBack);
  const wantedOption = normalizeText(chosen);
  if (shown === wantedOption) {
    return {
      ok: true,
      readBack,
      detail:
        `chose "${chosen}" and read it back` +
        (blindWalk ? " (the menu exposed no highlight, so only the read back confirms it)" : ""),
    };
  }
  // Some widgets display an abbreviation of what was chosen rather than the
  // option's own words — Greenhouse's phone-country picker shows a flag and
  // "+1" for an option labelled "United States +1". The control went from empty
  // to showing part of the option whose element we had just re-read and
  // clicked, which is as much as this can honestly confirm, and it is said out
  // loud in the report rather than reported as an exact match.
  if (shown !== "" && (wantedOption.includes(shown) || shown.includes(wantedOption))) {
    return {
      ok: true,
      readBack,
      detail:
        `chose "${chosen}"; the control displays ${JSON.stringify(readBack.slice(0, 60))}, which ` +
        `is the abbreviated form of that option rather than its full wording`,
    };
  }
  return {
    ok: false,
    readBack,
    detail: `clicked "${chosen}" but the control reads ${JSON.stringify(readBack.slice(0, 120))}`,
  };
}

/** One radio out of its group, chosen by the option text the caller decided on. */
async function chooseRadio(page: Page, field: EnumeratedField, value: string): Promise<ApplyOutcome> {
  const wanted = normalizeText(value);
  const index = field.options.findIndex((option) => normalizeText(option) === wanted);
  const selector = index === -1 ? undefined : field.optionSelectors[index];
  if (selector === undefined) {
    return {
      ok: false,
      readBack: await readRadioGroupValue(page, field),
      detail: `"${value}" is not one of this group's choices`,
    };
  }
  await scrollIntoView(page, selector);
  try {
    await page.locator(selector).click();
  } catch (err) {
    return {
      ok: false,
      readBack: "",
      detail: `could not click the choice: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const readBack = await readRadioGroupValue(page, field);
  const matches = normalizeText(readBack) === wanted;
  return {
    ok: matches,
    readBack,
    detail: matches ? `chose "${value}"` : `the group now reads "${readBack}"`,
  };
}

/** A single checkbox. `value` is read as a yes/no; anything else is a refusal. */
async function setCheckbox(page: Page, field: EnumeratedField, value: string): Promise<ApplyOutcome> {
  const wanted = normalizeText(value);
  const yes = ["yes", "true", "checked", "check", "on", "1", "agree", "i agree"].includes(wanted);
  const no = ["no", "false", "unchecked", "uncheck", "off", "0"].includes(wanted);
  if (!yes && !no) {
    return { ok: false, readBack: "", detail: `"${value}" is not a yes or a no for a checkbox` };
  }

  await scrollIntoView(page, field.selector);
  let checked: boolean;
  try {
    checked = await page.locator(field.selector).isChecked();
    if (checked !== yes) await page.locator(field.selector).click();
    checked = await page.locator(field.selector).isChecked();
  } catch (err) {
    return {
      ok: false,
      readBack: "",
      detail: `could not set the checkbox: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: checked === yes,
    readBack: checked ? "checked" : "",
    detail: checked === yes ? `set to ${yes ? "checked" : "unchecked"}` : "the checkbox did not change",
  };
}

/**
 * Puts one value into one control, by the only mechanism that control has.
 *
 * There is no model on this path and no natural-language instruction anywhere in
 * it: the selector came from `enumerateFormFields`, the value came from the
 * decision layer, and what happens between them is a `fill`, a `selectOption` or
 * a `click` on an element addressed by selector.
 */
export async function applyFieldValue(
  page: Page,
  field: EnumeratedField,
  value: string,
  options: {
    allowContains?: boolean;
    allowFreeText?: boolean;
    /**
     * JOB-051. Further strings the candidate attested to, used *only* to break a
     * tie between several suggestions that all contain `value` — see
     * `chooseFromMenu`. Never a source of a value in its own right, so a term
     * that matches nothing changes no outcome.
     */
    contextTerms?: readonly string[];
  } = {}
): Promise<ApplyOutcome> {
  switch (field.kind) {
    case "text":
      return await fillText(page, field, value);
    case "textarea":
      return await fillText(page, field, value);
    case "select":
      return await selectNative(page, field, value);
    case "combobox":
      return await chooseFromMenu(
        page,
        field,
        value,
        options.allowContains === true,
        options.allowFreeText === true,
        options.contextTerms ?? []
      );
    case "radio":
      return await chooseRadio(page, field, value);
    case "checkbox":
      return await setCheckbox(page, field, value);
    default:
      return {
        ok: false,
        readBack: "",
        detail: `a ${field.kind} control is not something this fills`,
      };
  }
}

