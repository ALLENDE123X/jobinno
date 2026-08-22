// @vitest-environment node
/**
 * JOB-113 — which consent control this pipeline is allowed to press.
 *
 * The banner these are written against is not invented. Application
 * `30ffa54c-d0f4-47d0-a40b-06f0d341a5b5` filled a Palantir listing on Lever
 * completely, clicked submit, and reported `submission_unconfirmed` with the
 * form still on screen and no validation error anywhere on a 12,137 pixel tall
 * capture. Measured on that live page afterwards: the banner is `position:
 * fixed`, `z-index: 9999`, `pointer-events: auto`, occupying viewport y 996 to
 * 1080; `SUBMIT APPLICATION` after the minimum scroll that brings it into view
 * sits at y 1040 to 1081; and `document.elementFromPoint` at the button's own
 * centre returns a `<p>` inside the banner. The click had nowhere to land.
 *
 * The banner's own two buttons read exactly `Deny` and `Accept`, so those are
 * the first two cases below.
 *
 * What these tests actually defend is the half of that module a model does not
 * get to decide. Discovery of the control is a model call, deliberately, because
 * page furniture is the one thing on a job board that a model handles better
 * than a selector table. Whether the control it found may be **clicked** is not
 * a model call, because accepting cookies is a consent decision belonging to the
 * candidate — the same class of thing `CONSENT_FIELD_RE` already routes away
 * from being answered automatically. So the rule is: press it only if its own
 * DOM text reads as a refusal and does not also read as an acceptance, and leave
 * anything ambiguous alone.
 *
 * A loosened regex here is a silent consent given in someone else's name, which
 * is why the accept cases below are spelled out one at a time rather than
 * summarised.
 */
import { describe, expect, it } from "vitest";

import {
  CONSENT_ACCEPT_RE,
  CONSENT_REFUSE_RE,
  readsAsNeutralDismissal,
  readsAsRefusal,
} from "@/lib/consent-banner";

describe("readsAsRefusal", () => {
  it("accepts the wording on the banner that caused this ticket", () => {
    // Lever renders this button with the literal text "Deny".
    expect(readsAsRefusal("Deny").ok).toBe(true);
  });

  it.each([
    "Deny",
    "Decline",
    "Decline all",
    "Reject",
    "Reject all",
    "Reject All Cookies",
    "Refuse",
    "Opt out",
    "Opt-out",
    "Only necessary",
    "Necessary only",
    "Essential only",
    "Strictly necessary cookies only",
    "No thanks",
    "No, thanks",
    "Do not accept",
    "Do not sell my personal information",
    "Disagree",
  ])("treats %j as a refusal", (label) => {
    expect(readsAsRefusal(label).ok).toBe(true);
  });

  it.each([
    "Accept",
    "Accept all",
    "Accept All Cookies",
    "I agree",
    "Agree and continue",
    "Allow all",
    "Allow cookies",
    "Got it",
    "OK",
    "Okay",
    "I understand",
    "Continue",
    "Yes",
    "Consent",
    "Enable all",
  ])("refuses to click %j", (label) => {
    const verdict = readsAsRefusal(label);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("does not read as a refusal");
  });

  it("refuses a control that reads as both, because which half a click lands on is a guess", () => {
    // A container rather than a button: this is the text of the whole button
    // row on a great many banners, and pressing "it" would press whichever of
    // the two the engine picked.
    const verdict = readsAsRefusal("Accept all Reject all");
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("both");
  });

  it("refuses a control with no text at all rather than guessing", () => {
    expect(readsAsRefusal("").ok).toBe(false);
    expect(readsAsRefusal("   ").ok).toBe(false);
  });

  it("does not let the word inside a refusal phrase count as an acceptance", () => {
    // "Do not accept" contains the word `accept`; the refusal phrase has to
    // swallow it, or the ambiguity check would reject a perfectly good refusal.
    expect(readsAsRefusal("Do not accept").ok).toBe(true);
    expect(readsAsRefusal("Don't agree").ok).toBe(true);
  });

  it("ignores surrounding whitespace and casing the way a DOM read produces it", () => {
    expect(readsAsRefusal("\n   REJECT ALL  \t").ok).toBe(true);
  });
});

describe("readsAsNeutralDismissal", () => {
  it.each(["Close", "Dismiss", "×", "✕", "x", "Not now"])(
    "treats %j as a neutral close",
    (label) => {
      expect(readsAsNeutralDismissal(label).ok).toBe(true);
    }
  );

  it.each(["Accept", "OK", "Got it", "I agree", "Continue"])(
    "refuses %j even though a banner may call it a dismissal",
    (label) => {
      expect(readsAsNeutralDismissal(label).ok).toBe(false);
    }
  );

  it("refuses a close control that also accepts", () => {
    // Some banners label the X "Close and accept". Closing is fine; the second
    // half is not, and this module has no path that accepts.
    const verdict = readsAsNeutralDismissal("Close and accept");
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("never accepts");
  });
});

describe("the two vocabularies", () => {
  it("never lets a bare acceptance satisfy the refusal pattern", () => {
    for (const label of ["Accept", "Accept all", "Agree", "Allow all", "Got it"]) {
      expect(CONSENT_REFUSE_RE.test(label)).toBe(false);
    }
  });

  it("recognises the acceptances it exists to keep out", () => {
    for (const label of ["Accept all", "I agree", "Allow cookies", "Got it", "OK"]) {
      expect(CONSENT_ACCEPT_RE.test(label)).toBe(true);
    }
  });
});
