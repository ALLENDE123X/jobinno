/**
 * JOB-281. Cases for the widget adapter module. The SR screening adapter
 * ships a framework agnostic first pass at the framework state commit that
 * prior spikes (JOB-266 in particular) never landed: dispatching `input`
 * and `change` on any form control the visible click leaves without one.
 *
 * These tests run under jsdom (the default vitest environment for this
 * project), so `document` is a real DOM the adapter's `page.evaluate`
 * scripts can query. The fake page's `evaluate` runs its argument through
 * `eval` in this file's own scope, which is close enough to Stagehand's
 * real "run this in the page" contract to exercise the adapter without a
 * browser at hand.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  SRScreeningDropdownAdapter,
  commitFrameworkState,
} from "@/lib/agent/widget-adapters";

interface FakePage {
  url: () => string;
  evaluate: (fn: string) => Promise<unknown>;
}

function fakePage(url: string): FakePage {
  return {
    url: () => url,
    evaluate: async (fn: string) => {
      return eval(fn);
    },
  };
}

function fakeThrowingPage(url: string): FakePage {
  return {
    url: () => url,
    evaluate: async () => {
      throw new Error("boom");
    },
  };
}

const SR_URL = "https://jobs.smartrecruiters.com/Bertelsmann-Jobs/744000144803439";
const GH_URL = "https://boards.greenhouse.io/example/jobs/1234";

/**
 * Fixture close to what the JOB-SPIKE v7 recon reported for one SR
 * screening dropdown: an ARIA combobox wrapping a listbox of option rows,
 * with a hidden native `<select>` sibling inside the same field group.
 * Enough to exercise both branches the adapter is trying to cover (the
 * visible widget path and the hidden control path).
 */
function mountSrScreeningFixture(): void {
  document.body.innerHTML = `
    <form>
      <div class="sr-field">
        <div id="q1" role="combobox" aria-expanded="false" aria-haspopup="listbox">
          <span class="sr-field__label">Select an option</span>
          <ul role="listbox" id="q1-listbox">
            <li role="option" data-value="yes">Yes</li>
            <li role="option" data-value="no">No</li>
          </ul>
        </div>
        <select id="q1-hidden" name="q1_hidden" style="display:none">
          <option value="">--</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>
    </form>
  `;
}

function mountPlainSelectFixture(): void {
  document.body.innerHTML = `
    <form>
      <select id="s1" name="s1">
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
    </form>
  `;
}

describe("SRScreeningDropdownAdapter.matches", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns true for the SR screening widget fixture on a SR URL", async () => {
    mountSrScreeningFixture();
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.matches(fakePage(SR_URL), "#q1");
    expect(result).toBe(true);
  });

  it("returns false for a plain select even on a SR URL", async () => {
    mountPlainSelectFixture();
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.matches(fakePage(SR_URL), "#s1");
    expect(result).toBe(false);
  });

  it("returns false when the URL is not a SmartRecruiters host", async () => {
    mountSrScreeningFixture();
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.matches(fakePage(GH_URL), "#q1");
    expect(result).toBe(false);
  });

  it("returns false when page.evaluate throws", async () => {
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.matches(fakeThrowingPage(SR_URL), "#q1");
    expect(result).toBe(false);
  });

  it("returns false when the fieldSelector does not resolve", async () => {
    document.body.innerHTML = "<div></div>";
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.matches(fakePage(SR_URL), "#missing");
    expect(result).toBe(false);
  });

  it("returns false when the page handle exposes no evaluate", async () => {
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.matches({}, "#q1");
    expect(result).toBe(false);
  });
});

describe("SRScreeningDropdownAdapter.commit", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("dispatches input and change on the visible widget and hidden select", async () => {
    mountSrScreeningFixture();
    const events: Array<{ type: string; targetId: string; tag: string }> = [];
    const capture = (event: Event): void => {
      const target = event.target as HTMLElement | null;
      events.push({
        type: event.type,
        targetId: target?.id ?? "",
        tag: target?.tagName ?? "",
      });
    };
    document.addEventListener("input", capture, true);
    document.addEventListener("change", capture, true);

    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.commit(fakePage(SR_URL), "#q1", "Yes");

    document.removeEventListener("input", capture, true);
    document.removeEventListener("change", capture, true);

    expect(result.status).toBe("committed");
    expect(result.adapterName).toBe("SRScreeningDropdownAdapter");
    expect(result.detail).not.toBeNull();

    const widgetEvents = events.filter((e) => e.targetId === "q1");
    const hiddenEvents = events.filter((e) => e.targetId === "q1-hidden");
    expect(widgetEvents.map((e) => e.type)).toEqual(["input", "change"]);
    expect(hiddenEvents.map((e) => e.type)).toEqual(["input", "change"]);
  });

  it("sets the hidden select value when a matching option exists", async () => {
    mountSrScreeningFixture();
    const adapter = new SRScreeningDropdownAdapter();
    await adapter.commit(fakePage(SR_URL), "#q1", "No");
    const hidden = document.querySelector<HTMLSelectElement>("#q1-hidden");
    expect(hidden?.value).toBe("no");
  });

  it("matches an option by its value string, not only by display text", async () => {
    mountSrScreeningFixture();
    const adapter = new SRScreeningDropdownAdapter();
    await adapter.commit(fakePage(SR_URL), "#q1", "yes");
    const hidden = document.querySelector<HTMLSelectElement>("#q1-hidden");
    expect(hidden?.value).toBe("yes");
  });

  it("returns adapter_failed when the fieldSelector does not resolve", async () => {
    document.body.innerHTML = "<div></div>";
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.commit(fakePage(SR_URL), "#missing", "Yes");
    expect(result.status).toBe("adapter_failed");
    expect(result.adapterName).toBe("SRScreeningDropdownAdapter");
    expect(result.detail).toContain("did not resolve");
  });

  it("returns adapter_failed when page.evaluate throws", async () => {
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.commit(fakeThrowingPage(SR_URL), "#q1", "Yes");
    expect(result.status).toBe("adapter_failed");
    expect(result.detail).toBe("boom");
  });
});

describe("commitFrameworkState", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("delegates to the SR adapter when the widget and URL both match", async () => {
    mountSrScreeningFixture();
    const result = await commitFrameworkState(fakePage(SR_URL), "#q1", "Yes");
    expect(result.status).toBe("committed");
    expect(result.adapterName).toBe("SRScreeningDropdownAdapter");
  });

  it("returns no_adapter_matched when nothing in the registry matches", async () => {
    mountSrScreeningFixture();
    const result = await commitFrameworkState(fakePage(GH_URL), "#q1", "Yes");
    expect(result.status).toBe("no_adapter_matched");
    expect(result.adapterName).toBeNull();
    expect(result.detail).toBeNull();
  });

  it("returns adapter_failed when the adapter commit throws", async () => {
    // The SR adapter's `matches` runs a URL substring check first, so a
    // throwing evaluate only reaches `commit` when the fixture also passes
    // matches; the simplest way to force that is a page whose URL matches
    // and whose evaluate answers true for `matches` but throws once the
    // commit script hits it.
    mountSrScreeningFixture();
    let call = 0;
    const flaky = {
      url: () => SR_URL,
      evaluate: async (fn: string) => {
        call += 1;
        if (call === 1) {
          return eval(fn);
        }
        throw new Error("commit exploded");
      },
    };
    const result = await commitFrameworkState(flaky, "#q1", "Yes");
    expect(result.status).toBe("adapter_failed");
    expect(result.adapterName).toBe("SRScreeningDropdownAdapter");
    expect(result.detail).toBe("commit exploded");
  });
});
