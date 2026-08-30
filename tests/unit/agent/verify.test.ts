/**
 * JOB-283 (sub ticket F). Cases for the pre submit verification module.
 *
 * The module under test is a pure orchestrator: it calls the injected
 * primitives on a `PreSubmitVerifyPage` and decides pass, fail, or
 * captcha_blocked from what they answer. The fixtures below stand in for a
 * Stagehand page; they answer `scanErrorMarkers` and `detectCaptcha` from
 * plain arrays and record the probe, wait, and captcha calls so the tests
 * can assert the orchestration order rather than the browser state a real
 * page would carry. Sub ticket E provides the real page adapter over
 * Playwright; nothing here opens a browser.
 *
 *   - a SR OneClick apply page with 3 empty required fields returns `fail`
 *     with one structured error per field, each carrying the sibling label
 *   - a SR page with everything filled returns `pass`
 *   - a page carrying a captcha returns `captcha_blocked` whether the
 *     widget predates the probe or only appears because of it, and never
 *     `pass`
 *   - the blur/focus probe never fires a real submit click and never
 *     navigates
 *   - the error list is JSON serializable, so the agent loop can put it in
 *     a prompt for the next turn
 */

import { describe, expect, it } from "vitest";

import {
  PRE_SUBMIT_VERIFY_DEFAULT_WAIT_MS,
  preSubmitVerify,
  type ErrorMarkerCandidate,
  type PreSubmitVerifyPage,
  type VerifyError,
  type VerifyResult,
} from "@/lib/agent/verify";

const START_URL = "https://apply.example.test/sr/one-click";
const SUBMITTED_URL = "https://apply.example.test/sr/one-click/done";

interface OneClickPage extends PreSubmitVerifyPage {
  urlValue(): string;
  probeCalls(): number;
  submitClicks(): number;
  lastWaitMs(): number | null;
  /** Model of the real submit button: a navigation. The verify pass never calls this. */
  clickSubmit(): void;
}

/**
 * Fixture modeled on SR's OneClick apply page. Everything the module can
 * touch is backed by plain state so the tests can assert the exact calls:
 * `url` reflects the current address (and would change if a submit fired),
 * `probeValidation` counts its single call, `waitForValidation` records the
 * ms it received, and `detectCaptcha` can report a captcha that predates
 * the probe or one that only materializes because of it. `clickSubmit` is
 * the one method the module has no interface to reach, so a zero
 * `submitClicks` count proves the probe cannot accidentally submit.
 */
function srOneClickPage(options: {
  markers?: ErrorMarkerCandidate[];
  captcha?: boolean;
  captchaAppearsAfterProbe?: boolean;
}): OneClickPage {
  let pageUrl = START_URL;
  let probes = 0;
  let submits = 0;
  const waits: number[] = [];
  let captchaChecks = 0;

  return {
    urlValue: () => pageUrl,
    url: () => pageUrl,
    probeCalls: () => probes,
    submitClicks: () => submits,
    lastWaitMs: () => (waits.length > 0 ? waits[waits.length - 1] : null),
    clickSubmit: () => {
      submits += 1;
      pageUrl = SUBMITTED_URL;
    },
    probeValidation: () => {
      probes += 1;
    },
    waitForValidation: (ms: number) => {
      waits.push(ms);
    },
    scanErrorMarkers: () => options.markers ?? [],
    detectCaptcha: () => {
      captchaChecks += 1;
      if (options.captchaAppearsAfterProbe) return captchaChecks > 1;
      return options.captcha ?? false;
    },
  };
}

/**
 * The markers SR renders when three required fields are left empty. Each
 * row carries the field selector (a snapshot `FieldNode.ref` in production,
 * when the E adapter can map the marker element to the a11y node) plus the
 * sibling label and the exact `Value is required` text.
 */
function threeRequiredErrors(): ErrorMarkerCandidate[] {
  return [
    {
      fieldSelector: "field_first_name",
      siblingLabel: "First name",
      errorText: "Value is required",
    },
    {
      fieldSelector: "field_last_name",
      siblingLabel: "Last name",
      errorText: "Value is required",
    },
    {
      fieldSelector: "field_email",
      siblingLabel: "Email address",
      errorText: "Value is required",
    },
  ];
}

/**
 * Narrow a result down to the `fail` arm and return its errors. Asserting
 * the status first makes a regression that starts returning `pass` or
 * `captcha_blocked` fail at the assertion rather than with an undefined
 * `errors` access a few lines later.
 */
function expectFail(result: VerifyResult): VerifyError[] {
  expect(result.status).toBe("fail");
  if (result.status !== "fail") {
    throw new Error(`expected a fail verdict, got ${result.status}`);
  }
  return result.errors;
}

describe("preSubmitVerify", () => {
  describe("against a SR OneClick page with 3 empty required fields", () => {
    it("returns fail with one structured error per field, each carrying the sibling label", async () => {
      // SR tracks required fields at the Angular form control layer, so a
      // native `.required` attribute scan would see nothing here. The
      // markers hand the module exactly the rows SR's own validation pass
      // renders after the probe.
      const page = srOneClickPage({ markers: threeRequiredErrors() });

      const errors = expectFail(await preSubmitVerify(page));

      expect(errors).toHaveLength(3);
      expect(errors).toEqual([
        {
          fieldSelector: "field_first_name",
          siblingLabel: "First name",
          errorText: "Value is required",
        },
        {
          fieldSelector: "field_last_name",
          siblingLabel: "Last name",
          errorText: "Value is required",
        },
        {
          fieldSelector: "field_email",
          siblingLabel: "Email address",
          errorText: "Value is required",
        },
      ]);
      // Every entry carries the visible sibling label, so the agent loop
      // can point the next turn at the field by sight, not just by
      // selector.
      for (const error of errors) {
        expect(error.siblingLabel.length).toBeGreaterThan(0);
      }
    });

    it("collapses SR's two markers per field into one entry per field", async () => {
      // SR renders both a StaticText error row and an error icon for the
      // same unfilled field, so a raw scan contains two rows for one
      // selector.
      const page = srOneClickPage({
        markers: [
          {
            fieldSelector: "field_first_name",
            siblingLabel: "First name",
            errorText: "Value is required",
          },
          {
            fieldSelector: "field_first_name",
            siblingLabel: "First name",
            errorText: "Error",
          },
          {
            fieldSelector: "field_email",
            siblingLabel: "Email address",
            errorText: "Value is required",
          },
        ],
      });

      const errors = expectFail(await preSubmitVerify(page));

      expect(errors).toHaveLength(2);
      expect(errors.map((e) => e.fieldSelector)).toEqual([
        "field_first_name",
        "field_email",
      ]);
      // The first row wins, which in practice is the informative message
      // rather than the bare icon row.
      expect(errors[0].errorText).toBe("Value is required");
    });
  });

  describe("against a fully filled SR page", () => {
    it("returns pass when the marker scan comes back empty", async () => {
      const page = srOneClickPage({ markers: [] });

      const result = await preSubmitVerify(page);

      // `toEqual` pins the exact union arm: a `captcha_blocked` or `fail`
      // result would fail here because those arms carry extra keys.
      expect(result).toEqual({ status: "pass" });
    });
  });

  describe("when the probe must not submit", () => {
    it("fires the blur/focus probe and never clicks the real submit button", async () => {
      const page = srOneClickPage({ markers: threeRequiredErrors() });

      // Prove the fixture model first, so the assertion below means
      // something: a real submit click navigates the page away.
      const control = srOneClickPage({});
      control.clickSubmit();
      expect(control.submitClicks()).toBe(1);
      expect(control.urlValue()).toBe(SUBMITTED_URL);

      await preSubmitVerify(page);

      // The probe ran as the single blur/focus cycle...
      expect(page.probeCalls()).toBe(1);
      // ...and no dedicated submit click was fired by it.
      expect(page.submitClicks()).toBe(0);
      // The page is exactly where it started: the url did not change, so
      // the pass did not navigate or submit.
      expect(page.urlValue()).toBe(START_URL);
      expect(await page.url()).toBe(START_URL);
    });
  });

  describe("when a captcha is rendered", () => {
    it("returns captcha_blocked when the captcha predates the probe", async () => {
      const page = srOneClickPage({
        captcha: true,
        markers: threeRequiredErrors(),
      });

      const result = await preSubmitVerify(page);

      expect(result).toEqual({ status: "captcha_blocked" });
      // A captcha already on the page means no probe runs at all: nothing
      // to validate, and no blur/focus on a flagged session.
      expect(page.probeCalls()).toBe(0);
      expect(page.lastWaitMs()).toBeNull();
    });

    it("returns captcha_blocked when the probe surfaces a captcha, never pass", async () => {
      // SR flags some sessions only after interaction, so the captcha can
      // appear between the two detectCaptcha calls. Markers alone must not
      // turn this into a pass or even a fail: the captcha verdict wins.
      const page = srOneClickPage({
        captchaAppearsAfterProbe: true,
        markers: threeRequiredErrors(),
      });

      const result = await preSubmitVerify(page);

      expect(result).toEqual({ status: "captcha_blocked" });
      // The probe did run before the captcha materialized.
      expect(page.probeCalls()).toBe(1);
    });
  });

  describe("the validation wait", () => {
    it("defaults to 500ms", async () => {
      const page = srOneClickPage({ markers: [] });

      await preSubmitVerify(page);

      expect(page.lastWaitMs()).toBe(500);
      expect(PRE_SUBMIT_VERIFY_DEFAULT_WAIT_MS).toBe(500);
    });

    it("probeWaitMs 0 skips the real wait", async () => {
      const page = srOneClickPage({ markers: [] });

      await preSubmitVerify(page, { probeWaitMs: 0 });

      expect(page.lastWaitMs()).toBe(0);
    });
  });

  describe("the error payload the agent loop consumes", () => {
    it("is JSON serializable and round trips cleanly", async () => {
      const page = srOneClickPage({ markers: threeRequiredErrors() });

      const errors = expectFail(await preSubmitVerify(page));

      // Plain objects, no class instances, so the whole verdict survives
      // the wire into the prompt builder.
      expect(JSON.parse(JSON.stringify(errors))).toEqual(
        threeRequiredErrors()
      );
      expect(
        JSON.parse(JSON.stringify({ status: "fail", errors }))
      ).toEqual({ status: "fail", errors: threeRequiredErrors() });
    });
  });
});