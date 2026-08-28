// @vitest-environment node
/**
 * JOB-233 — the Lever hCaptcha gate probe, against the shape recovered from
 * five real `applications` rows that ended `submission_unconfirmed`.
 *
 * `leverHcaptchaGateProbe` fixtures below reproduce, field for field, what
 * `LEVER_HCAPTCHA_GATE_SCRIPT` reads off the DOM captures in
 * `lib/.submission-screenshots/` for application rows `c32122c7-...`,
 * `30ffa54c-...`, `37d1c912-...` and `f56aaa24-...` — three different
 * employers (Palantir, Belvedere Trading), the same sitekey
 * (`e33f87f8-88ec-4e1a-9a13-df9bbb1d8120`) on every one of them, and an empty
 * `h-captcha-response` on every one. `leverHcaptchaGateBlocked` is the
 * predicate the diagnosis turned into code; these are the cases it has to
 * get right, plus the negative cases that keep it from firing on an
 * ordinary board that never had this gate at all.
 */
import { describe, expect, it } from "vitest";

import {
  describeLeverHcaptchaGate,
  leverHcaptchaGateBlocked,
  type LeverHcaptchaGateProbe,
} from "@/lib/solvers/lever";
import { lookupSolver } from "@/lib/solvers/index";
import { leverSolver } from "@/lib/solvers/lever";

/** The real sitekey, unchanged across every employer's Lever apply page seen so far. */
const LEVER_SITEKEY = "e33f87f8-88ec-4e1a-9a13-df9bbb1d8120";

/** The exact shape recovered from every one of the six unconfirmed rows. */
const withheldTokenProbe: LeverHcaptchaGateProbe = {
  hiddenSubmitPresent: true,
  hiddenSubmitType: "submit",
  responseTokenPresent: true,
  responseTokenValue: "",
  sitekey: LEVER_SITEKEY,
  visibleSubmitType: "button",
};

describe("leverHcaptchaGateBlocked", () => {
  it("fires on the exact shape recovered from the six unconfirmed rows", () => {
    expect(leverHcaptchaGateBlocked(withheldTokenProbe)).toBe(true);
  });

  it("still fires when the response value is only whitespace", () => {
    expect(
      leverHcaptchaGateBlocked({ ...withheldTokenProbe, responseTokenValue: "   " })
    ).toBe(true);
  });

  it("does not fire once hCaptcha has actually written a token", () => {
    expect(
      leverHcaptchaGateBlocked({
        ...withheldTokenProbe,
        responseTokenValue: "P1_eyJ0eXAiOiJKV1QifQ.some-real-token",
      })
    ).toBe(false);
  });

  it("does not fire on a board with no hidden submit control at all", () => {
    expect(
      leverHcaptchaGateBlocked({
        hiddenSubmitPresent: false,
        hiddenSubmitType: null,
        responseTokenPresent: false,
        responseTokenValue: null,
        sitekey: null,
        visibleSubmitType: "submit",
      })
    ).toBe(false);
  });

  it("does not fire when the id exists but is not the real Lever submit type", () => {
    // Guards against a coincidental id collision on an unrelated board: the
    // element has to actually be `type="submit"`, not merely share the id.
    expect(
      leverHcaptchaGateBlocked({
        ...withheldTokenProbe,
        hiddenSubmitType: "button",
      })
    ).toBe(false);
  });

  it("does not fire when the response token field is simply absent", () => {
    expect(
      leverHcaptchaGateBlocked({
        ...withheldTokenProbe,
        responseTokenPresent: false,
        responseTokenValue: null,
      })
    ).toBe(false);
  });
});

describe("describeLeverHcaptchaGate", () => {
  it("names the mechanism, the sitekey and the URL rather than repeating a hedge", () => {
    const message = describeLeverHcaptchaGate(
      withheldTokenProbe,
      "https://jobs.lever.co/palantir/4abf26b4-795c-420a-bf22-1ab98db268b4/apply"
    );
    expect(message).toContain("hCaptcha");
    expect(message).toContain(LEVER_SITEKEY);
    expect(message).toContain("#hcaptchaSubmitBtn");
    expect(message).toContain("h-captcha-response");
    expect(message).toContain(
      "https://jobs.lever.co/palantir/4abf26b4-795c-420a-bf22-1ab98db268b4/apply"
    );
    expect(message).toContain("#122");
    // The point of this row is that it replaces a guess with a fact — it
    // must never repeat the generic branch's own hedge.
    expect(message).not.toContain("most likely rejected");
  });

  it("degrades gracefully when the sitekey or hidden type could not be read", () => {
    const message = describeLeverHcaptchaGate(
      {
        hiddenSubmitPresent: true,
        hiddenSubmitType: null,
        responseTokenPresent: true,
        responseTokenValue: "",
        sitekey: null,
        visibleSubmitType: null,
      },
      "https://jobs.lever.co/basis/bb213682-6e49-48d4-bdfe-3b17aba79366/apply"
    );
    expect(message).toContain("unknown");
    expect(message).not.toContain("undefined");
    expect(message).not.toContain("null");
  });
});

describe("the solver registry", () => {
  it("routes lever through leverSolver", () => {
    expect(lookupSolver("lever")).toBe(leverSolver);
  });
});
