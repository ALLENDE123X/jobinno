// @vitest-environment jsdom
/**
 * JOB-261 red team, M1 and M2 — `findVisibleApplyIntentControlInPage`'s real,
 * serialised script, run against a real jsdom document rather than through
 * `tests/unit/fill-application-form-flow.test.ts`'s `page.evaluate` stub.
 *
 * That flow test's stub answers `state.applyIntentButtonVisible` directly
 * (see its own header comment near `findVisibleApplyIntentControlInPage`),
 * which pins the *consequence* of the DOM finding a control but cannot tell
 * a shadow-root-aware scan apart from a flat one, or a visibility-aware one
 * from a bounding-box-only one — both of these were the exact defects the
 * review found. Only running the actual script against a real DOM can catch
 * either.
 *
 * Modeled on `tests/unit/form-fields-enumeration.test.ts`'s own pattern: a
 * fake `Page` whose `evaluate` runs the serialised script with `eval` against
 * this file's own jsdom document, which is what `inPageExpression` ships into
 * a real browser too. `getBoundingClientRect` is stubbed to a plausible size,
 * because jsdom reports every rect as 0x0 by default, which would make every
 * control invisible to the box check regardless of the fix under test.
 *
 * M1's fixture mirrors the SmartRecruiters `oneclick-ui` shape JOB-052 already
 * found and fixed for the structural floor and `pageShowsFileNameInPage`: the
 * real "I'm Interested" control lives inside a custom element's shadow root,
 * invisible to a plain `document.querySelectorAll`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pageHasVisibleApplyIntentControl } from "@/lib/fill-application-form";
import type { Page } from "@browserbasehq/stagehand";

const realGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const zero = this.getAttribute("data-test-zero-size") === "true";
    const width = zero ? 0 : 200;
    const height = zero ? 0 : 20;
    return {
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
  document.body.innerHTML = "";
});

/** A `Page` whose `evaluate` runs the serialised script against this jsdom. */
function domPage(): Page {
  return {
    evaluate: async (script: string) => eval(script),
  } as unknown as Page;
}

describe("M1: a shadow-root-hosted Apply control, the SmartRecruiters oneclick-ui shape", () => {
  it("finds an Apply-intent control document.querySelectorAll cannot reach", () => {
    const host = document.createElement("oneclick-apply-widget");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<button type="button">I'm Interested</button>`;

    // Sanity check on the fixture itself: this is the exact undercount JOB-052
    // found on this same board's page — a flat query sees nothing at all.
    expect(document.querySelectorAll("button")).toHaveLength(0);

    return pageHasVisibleApplyIntentControl(domPage()).then((found) => {
      expect(found).toBe(true);
    });
  });

  it("still finds it two shadow roots deep", () => {
    const outerHost = document.createElement("job-listing-app");
    document.body.appendChild(outerHost);
    const outerShadow = outerHost.attachShadow({ mode: "open" });
    const innerHost = document.createElement("apply-cta");
    outerShadow.appendChild(innerHost);
    const innerShadow = innerHost.attachShadow({ mode: "open" });
    innerShadow.innerHTML = `<a href="#">Apply Now</a>`;

    return pageHasVisibleApplyIntentControl(domPage()).then((found) => {
      expect(found).toBe(true);
    });
  });

  it("still refuses a page with no Apply-ish control anywhere, shadow root included", () => {
    const host = document.createElement("job-listing-app");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<button type="button">Learn more about our benefits</button>`;

    return pageHasVisibleApplyIntentControl(domPage()).then((found) => {
      expect(found).toBe(false);
    });
  });
});

describe("M2: a control with a nonzero bounding box that is not actually painted", () => {
  it("rejects visibility: hidden", () => {
    document.body.innerHTML = `<button type="button" style="visibility: hidden">Apply Now</button>`;

    return pageHasVisibleApplyIntentControl(domPage()).then((found) => {
      expect(found).toBe(false);
    });
  });

  it("rejects opacity: 0", () => {
    document.body.innerHTML = `<button type="button" style="opacity: 0">Apply Now</button>`;

    return pageHasVisibleApplyIntentControl(domPage()).then((found) => {
      expect(found).toBe(false);
    });
  });

  it("rejects display: none", () => {
    document.body.innerHTML = `<button type="button" style="display: none">Apply Now</button>`;

    return pageHasVisibleApplyIntentControl(domPage()).then((found) => {
      expect(found).toBe(false);
    });
  });

  it("still accepts an ordinary, actually visible control", () => {
    // The control for the three cases above: without it, a bug that made this
    // scan reject everything would pass them just as well as the real fix.
    document.body.innerHTML = `<button type="button">Apply Now</button>`;

    return pageHasVisibleApplyIntentControl(domPage()).then((found) => {
      expect(found).toBe(true);
    });
  });

  it("rejects visibility: hidden even inside a shadow root", () => {
    const host = document.createElement("oneclick-apply-widget");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<button type="button" style="visibility: hidden">I'm Interested</button>`;

    return pageHasVisibleApplyIntentControl(domPage()).then((found) => {
      expect(found).toBe(false);
    });
  });
});
