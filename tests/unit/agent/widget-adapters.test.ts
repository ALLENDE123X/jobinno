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
  SRSplStateCommitAdapter,
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

/**
 * Two SR screening field groups plus a form level CSRF token. The
 * commit-on-group-1 test asserts that no state on group 2 or on the CSRF
 * token changes and that no `change` listener elsewhere in the form fires,
 * which is the regression surface the JOB-281 red team BLOCKING finding
 * called out.
 */
function mountTwoScreeningGroupsWithCsrfFixture(): void {
  document.body.innerHTML = `
    <form>
      <input id="csrf" type="hidden" name="csrf_token" value="ORIGINAL_CSRF_TOKEN" />
      <div class="sr-field" id="group1">
        <div id="q1" role="combobox" aria-expanded="false" aria-haspopup="listbox">
          <span class="sr-field__label">Question one</span>
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
      <div class="sr-field" id="group2">
        <div id="q2" role="combobox" aria-expanded="false" aria-haspopup="listbox">
          <span class="sr-field__label">Question two</span>
          <ul role="listbox" id="q2-listbox">
            <li role="option" data-value="yes">Yes</li>
            <li role="option" data-value="no">No</li>
          </ul>
        </div>
        <select id="q2-hidden" name="q2_hidden" style="display:none">
          <option value="">--</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>
    </form>
  `;
}

/**
 * A SR combobox that is NOT wrapped in an `.sr-field` and does not name a
 * labelled by target that is. Stands in for SR's country picker, state
 * picker, autocomplete, and share widget - the false positive surface the
 * M-1 finding flagged. The adapter must NOT match this.
 */
function mountSrNonScreeningComboboxFixture(): void {
  document.body.innerHTML = `
    <form>
      <div class="autocomplete-widget">
        <div id="country-picker" role="combobox" aria-expanded="false" aria-haspopup="listbox">
          <ul role="listbox">
            <li role="option" data-value="us">United States</li>
            <li role="option" data-value="ca">Canada</li>
          </ul>
        </div>
      </div>
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

  it("returns false for an SR combobox that is not a screening question", async () => {
    // JOB-281 M-1: without the .sr-field discriminator the adapter matches
    // every combobox on a smartrecruiters.com host, including the country
    // picker, state picker, autocomplete, and share widget. This case
    // guards that the discriminator is enforced.
    mountSrNonScreeningComboboxFixture();
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.matches(fakePage(SR_URL), "#country-picker");
    expect(result).toBe(false);
  });

  it("rejects a lookalike host on a path that mentions smartrecruiters.com", async () => {
    // JOB-281 N-1: substring match false positives on
    // https://evil.example/redirect?to=smartrecruiters.com. The hostname
    // parse must reject this.
    mountSrScreeningFixture();
    const adapter = new SRScreeningDropdownAdapter();
    const spoofUrl = "https://evil.example/redirect?to=smartrecruiters.com";
    const result = await adapter.matches(fakePage(spoofUrl), "#q1");
    expect(result).toBe(false);
  });

  it("accepts a company subdomain of smartrecruiters.com", async () => {
    mountSrScreeningFixture();
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.matches(
      fakePage("https://careers.acme.smartrecruiters.com/apply/12345"),
      "#q1"
    );
    expect(result).toBe(true);
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

  /**
   * JOB-281 M-2. U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH
   * SEPARATOR) are valid inside a JS string value but illegal inside a JS
   * string literal in source. If `jsLiteral` did not escape them, the
   * injected script would fail to parse and the adapter would return
   * `adapter_failed`. This case asserts the escape lets the commit run.
   */
  it("commit does not throw when the option value contains U+2028 or U+2029", async () => {
    mountSrScreeningFixture();
    const target = `Yes extra line`;
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.commit(fakePage(SR_URL), "#q1", target);
    // No option matches, but the script itself has to run without a
    // parse error. `ok: true` is what tells us the escape worked.
    expect(result.status).toBe("committed");
  });

  /**
   * The JOB-281 red team BLOCKING regression. The prior ancestor walk
   * reached the surrounding `<form>` and its `querySelectorAll` at that
   * level returned every hidden input and every `<select>` in the form,
   * so calling commit on group 1 clobbered the CSRF token AND silently
   * answered group 2. This case pins the fix in place.
   */
  it("commit on group 1 does not touch group 2 or the CSRF token", async () => {
    mountTwoScreeningGroupsWithCsrfFixture();

    const changeSpy: Array<{ type: string; targetId: string }> = [];
    const capture = (event: Event): void => {
      const target = event.target as HTMLElement | null;
      changeSpy.push({ type: event.type, targetId: target?.id ?? "" });
    };
    document.addEventListener("input", capture, true);
    document.addEventListener("change", capture, true);

    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.commit(fakePage(SR_URL), "#q1", "Yes");

    document.removeEventListener("input", capture, true);
    document.removeEventListener("change", capture, true);

    expect(result.status).toBe("committed");

    const csrf = document.querySelector<HTMLInputElement>("#csrf");
    expect(csrf?.value).toBe("ORIGINAL_CSRF_TOKEN");

    const q1Hidden = document.querySelector<HTMLSelectElement>("#q1-hidden");
    expect(q1Hidden?.value).toBe("yes");

    // The critical assertions: group 2's hidden select is untouched, and
    // no change or input event has fired on it or on the CSRF input.
    const q2Hidden = document.querySelector<HTMLSelectElement>("#q2-hidden");
    expect(q2Hidden?.value).toBe("");

    const foreignEvents = changeSpy.filter(
      (e) => e.targetId === "q2-hidden" || e.targetId === "csrf" || e.targetId === "q2"
    );
    expect(foreignEvents).toEqual([]);
  });

  /**
   * JOB-281 round two MAJOR-1. A caller that passes a descendant
   * selector (a class on a non widget child, or a role=option row
   * inside the listbox) must still see events dispatched on the
   * widget itself, not on the descendant, so any delegated handler
   * listening for `event.target === widget` receives them. The
   * hidden `<select>` sibling of the widget must still be committed
   * even though the raw selector lands elsewhere.
   */
  it("descendant selector still fires events on the widget with .sr-field wrapper", async () => {
    mountSrScreeningFixture();
    const events: Array<{ type: string; targetId: string; tag: string; className: string }> = [];
    const capture = (event: Event): void => {
      const target = event.target as HTMLElement | null;
      events.push({
        type: event.type,
        targetId: target?.id ?? "",
        tag: target?.tagName ?? "",
        className: target?.className ?? "",
      });
    };
    document.addEventListener("input", capture, true);
    document.addEventListener("change", capture, true);

    // Selector points at the label span inside the widget (a non widget
    // descendant). commitScript must walk up to the combobox before
    // dispatching, so the visible event lands on #q1, not on the span.
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.commit(fakePage(SR_URL), ".sr-field__label", "Yes");

    document.removeEventListener("input", capture, true);
    document.removeEventListener("change", capture, true);

    expect(result.status).toBe("committed");

    // The widget (id=q1) received both events; the descendant span
    // did NOT, because commitScript resolved the widget from the
    // descendant before dispatching.
    const widgetEvents = events.filter((e) => e.targetId === "q1");
    const labelEvents = events.filter((e) => e.className === "sr-field__label");
    expect(widgetEvents.map((e) => e.type)).toEqual(["input", "change"]);
    expect(labelEvents).toEqual([]);

    // The hidden `<select>` sibling of the widget was still committed.
    const hidden = document.querySelector<HTMLSelectElement>("#q1-hidden");
    expect(hidden?.value).toBe("yes");
    const hiddenEvents = events.filter((e) => e.targetId === "q1-hidden");
    expect(hiddenEvents.map((e) => e.type)).toEqual(["input", "change"]);
  });

  /**
   * JOB-281 round two MAJOR-1, fallback branch. Without an .sr-field
   * or [data-field] wrapper the sibling scope must anchor at the
   * WIDGET's parent (not the descendant's parent), so a hidden
   * `<select>` sibling of the widget is still reached and unrelated
   * hidden inputs elsewhere are not.
   */
  it("descendant selector anchors fallback scope at the widget's parent", async () => {
    document.body.innerHTML = `
      <form>
        <input id="csrf" type="hidden" name="csrf_token" value="ORIGINAL_CSRF_TOKEN" />
        <div id="row">
          <div id="q1" role="combobox" aria-haspopup="listbox">
            <span id="q1-label" class="widget-label">Label</span>
            <ul role="listbox">
              <li role="option" data-value="yes">Yes</li>
            </ul>
          </div>
          <select id="q1-hidden" name="q1_hidden" style="display:none">
            <option value="">--</option>
            <option value="yes">Yes</option>
          </select>
        </div>
      </form>
    `;

    // Selector names the label span (a non widget descendant of the
    // combobox). Without widget resolution the fallback anchor would
    // be `#q1` (the span's parent) and its only children are the span
    // and the `<ul>`, so `#q1-hidden` would be missed. With widget
    // resolution the anchor becomes `#q1` the combobox, whose parent
    // `#row` has `#q1-hidden` as a direct child.
    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.commit(fakePage(SR_URL), "#q1-label", "Yes");

    expect(result.status).toBe("committed");

    const hidden = document.querySelector<HTMLSelectElement>("#q1-hidden");
    expect(hidden?.value).toBe("yes");

    const csrf = document.querySelector<HTMLInputElement>("#csrf");
    expect(csrf?.value).toBe("ORIGINAL_CSRF_TOKEN");
  });

  /**
   * JOB-281 round two MINOR-1. A form level `<fieldset>` that groups
   * a CSRF token, the widget, its hidden mirror, and another
   * question's hidden mirror. With `fieldset` in the semantic scope
   * list (the round one shape), `closest('fieldset')` would land on
   * this form level wrapper and the descendant query would return
   * every hidden control including the CSRF token and the sibling
   * question's mirror. Round two dropped `fieldset` from the list,
   * which forces the fallback branch to the widget's direct parent's
   * children only.
   */
  it("commit does not treat a form level fieldset as a per question scope", async () => {
    document.body.innerHTML = `
      <form>
        <fieldset id="form-level-set">
          <input id="csrf" type="hidden" name="csrf_token" value="ORIGINAL_CSRF_TOKEN" />
          <div id="q1-row">
            <div id="q1" role="combobox" aria-haspopup="listbox">
              <ul role="listbox">
                <li role="option" data-value="yes">Yes</li>
              </ul>
            </div>
            <select id="q1-hidden" name="q1_hidden" style="display:none">
              <option value="">--</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          <select id="q2-hidden" name="q2_hidden" style="display:none">
            <option value="">--</option>
            <option value="yes">Yes</option>
          </select>
        </fieldset>
      </form>
    `;

    const adapter = new SRScreeningDropdownAdapter();
    const result = await adapter.commit(fakePage(SR_URL), "#q1", "Yes");

    expect(result.status).toBe("committed");

    // q1-hidden is a direct sibling of q1 inside #q1-row and is committed.
    const q1Hidden = document.querySelector<HTMLSelectElement>("#q1-hidden");
    expect(q1Hidden?.value).toBe("yes");

    // The CSRF token and the sibling question's hidden mirror both live
    // higher up in the same `<fieldset>` and must NOT be touched.
    const csrf = document.querySelector<HTMLInputElement>("#csrf");
    expect(csrf?.value).toBe("ORIGINAL_CSRF_TOKEN");
    const q2Hidden = document.querySelector<HTMLSelectElement>("#q2-hidden");
    expect(q2Hidden?.value).toBe("");
  });

  /**
   * The option (a) fallback: when no `.sr-field` or `[data-field]`
   * wraps the widget, the scope collapses to the widget's direct
   * parent's direct children only. A hidden input two ancestor levels
   * up must not be scooped in.
   */
  it("fallback scope stays at the widget's direct parent's children", async () => {
    document.body.innerHTML = `
      <form>
        <input id="csrf" type="hidden" name="csrf_token" value="ORIGINAL_CSRF_TOKEN" />
        <div id="wrapper">
          <div id="row">
            <div id="q1" role="combobox" aria-haspopup="listbox" aria-labelledby="lbl">
              <ul role="listbox">
                <li role="option" data-value="yes">Yes</li>
              </ul>
            </div>
            <select id="q1-hidden" name="q1_hidden" style="display:none">
              <option value="">--</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          <input id="unrelated-hidden" type="hidden" value="LEAVE_ME_ALONE" />
        </div>
      </form>
    `;

    const commitScriptResult = await new SRScreeningDropdownAdapter().commit(
      fakePage(SR_URL),
      "#q1",
      "Yes"
    );
    // The .sr-field discriminator is not present, so `matches` would say
    // false; but `commit` never consults `matches` (that is the registry's
    // job), so this case reaches the commit path and exercises the option
    // (a) fallback directly. That is what we want to pin.
    expect(commitScriptResult.status).toBe("committed");

    // q1-hidden is a direct sibling of q1 inside #row and must be committed.
    const q1Hidden = document.querySelector<HTMLSelectElement>("#q1-hidden");
    expect(q1Hidden?.value).toBe("yes");

    // csrf and #unrelated-hidden are not direct siblings of #q1; they must
    // not be touched.
    const csrf = document.querySelector<HTMLInputElement>("#csrf");
    expect(csrf?.value).toBe("ORIGINAL_CSRF_TOKEN");
    const unrelated = document.querySelector<HTMLInputElement>("#unrelated-hidden");
    expect(unrelated?.value).toBe("LEAVE_ME_ALONE");
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
    // commit script hits it. JOB-317 note: the registry now consults the
    // state commit adapter first, whose `matches` evaluate (call 1)
    // declines this ARIA only fixture, so the event dispatch adapter's
    // `matches` is call 2 and its commit is call 3.
    mountSrScreeningFixture();
    let call = 0;
    const flaky = {
      url: () => SR_URL,
      evaluate: async (fn: string) => {
        call += 1;
        if (call <= 2) {
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

/**
 * JOB-317. Cases for the spl component state commit adapter. The fixture
 * below reproduces, method for method, the commit pipeline the 2026-08-31
 * live recon decompiled out of SmartRecruiters' production OneClick bundle
 * (see the block comments in lib/agent/widget-adapters.ts): an element
 * whose public handleOptionSelect flips selectedOptionsDictionary, derives
 * the value through optionsDictionary, assigns the reactive value backing
 * field, and dispatches the spl-change CustomEvent Angular subscribes to.
 * jsdom creates unknown dashed tags as plain HTMLElements, so the fixture
 * attaches the pipeline as instance methods, which is exactly the surface
 * the adapter feature detects.
 */

interface SplFixtureOption {
  id?: string;
  value: string;
  label: string;
}

interface SplHostConfig {
  options?: SplFixtureOption[];
  allowCustomValues?: boolean;
  optionFactory?: (value: string) => SplFixtureOption;
  preselectedIds?: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mountSplMultiselectFixture(config: SplHostConfig = {}): HTMLElement {
  document.body.innerHTML = `
    <form>
      <div class="sr-field" id="wrap"></div>
    </form>
  `;
  const wrap = document.querySelector("#wrap") as HTMLElement;
  const host = document.createElement("spl-multiselect-autocomplete") as any;
  host.id = "ms1";
  host.__value = [];
  Object.defineProperty(host, "value", {
    get() {
      return this.__value;
    },
    set(v) {
      this.__value = v;
    },
    configurable: true,
  });
  host.options = config.options ?? [];
  host.optionsDictionary = {};
  host.selectedOptionsDictionary = {};
  host.tags = [];
  host.touchedState = false;
  if (config.allowCustomValues) host.allowCustomValues = true;
  if (config.optionFactory) host.optionFactory = config.optionFactory;
  for (const id of config.preselectedIds ?? []) {
    host.selectedOptionsDictionary[id] = true;
    const opt = (config.options ?? []).find((o) => o.id === id);
    if (opt) host.optionsDictionary[id] = opt;
  }
  host.updateSelection = function (id: string, on: boolean) {
    this.selectedOptionsDictionary[id] = on;
  };
  host.getValue = function () {
    return Object.keys(this.selectedOptionsDictionary)
      .filter(
        (id) =>
          this.selectedOptionsDictionary[id] === true &&
          this.optionsDictionary[id]
      )
      .map((id) => this.optionsDictionary[id].value);
  };
  host.emitChangeEvent = function () {
    this.dispatchEvent(
      new CustomEvent("spl-change", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      })
    );
  };
  host.handleChange = function (v: unknown) {
    this.value = v;
    this.emitChangeEvent();
  };
  host.handleOptionSelect = function (ev: CustomEvent) {
    const id = ev.detail && ev.detail.value;
    const selected = ev.detail && ev.detail.selected;
    this.updateSelection(id, !selected);
    this.handleChange(this.getValue());
  };
  host.markAsTouched = function () {
    this.touchedState = true;
    this.dispatchEvent(
      new CustomEvent("spl-touched", { bubbles: true, composed: true })
    );
  };
  wrap.appendChild(host);
  return host as HTMLElement;
}

/**
 * The base field shape (spl-select, spl-checkbox and friends share the
 * form field base class): handleChange plus emitChangeEvent, but no
 * handleOptionSelect and no selection dictionary.
 */
function mountSplBaseFieldFixture(): HTMLElement {
  document.body.innerHTML = `
    <form>
      <div class="sr-field" id="wrap"></div>
    </form>
  `;
  const wrap = document.querySelector("#wrap") as HTMLElement;
  const host = document.createElement("spl-select") as any;
  host.id = "sel1";
  host.__value = "";
  Object.defineProperty(host, "value", {
    get() {
      return this.__value;
    },
    set(v) {
      this.__value = v;
    },
    configurable: true,
  });
  host.touchedState = false;
  host.emitChangeEvent = function () {
    this.dispatchEvent(
      new CustomEvent("spl-change", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      })
    );
  };
  host.handleChange = function (v: unknown) {
    this.value = v;
    this.emitChangeEvent();
  };
  host.markAsTouched = function () {
    this.touchedState = true;
  };
  wrap.appendChild(host);
  return host as HTMLElement;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const US_OPTIONS: SplFixtureOption[] = [
  { id: "o1", value: "United States", label: "United States" },
  { id: "o2", value: "Canada", label: "Canada" },
];

describe("SRSplStateCommitAdapter.matches", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("matches a spl multiselect host on a SR URL, addressed directly", async () => {
    mountSplMultiselectFixture({ options: US_OPTIONS });
    const adapter = new SRSplStateCommitAdapter();
    expect(await adapter.matches(fakePage(SR_URL), "#ms1")).toBe(true);
  });

  it("matches when the selector lands on a wrapper above the host", async () => {
    mountSplMultiselectFixture({ options: US_OPTIONS });
    const adapter = new SRSplStateCommitAdapter();
    expect(await adapter.matches(fakePage(SR_URL), "#wrap")).toBe(true);
  });

  it("does not match outside a SmartRecruiters host", async () => {
    mountSplMultiselectFixture({ options: US_OPTIONS });
    const adapter = new SRSplStateCommitAdapter();
    expect(await adapter.matches(fakePage(GH_URL), "#ms1")).toBe(false);
  });

  it("does not match the ARIA only screening fixture", async () => {
    // The narrower match is what lets this adapter sit ahead of the event
    // dispatch adapter in the registry without stealing its inputs.
    mountSrScreeningFixture();
    const adapter = new SRSplStateCommitAdapter();
    expect(await adapter.matches(fakePage(SR_URL), "#q1")).toBe(false);
  });

  it("does not match a plain native select", async () => {
    mountPlainSelectFixture();
    const adapter = new SRSplStateCommitAdapter();
    expect(await adapter.matches(fakePage(SR_URL), "#s1")).toBe(false);
  });
});

describe("SRSplStateCommitAdapter.commit", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("commits through handleOptionSelect and verifies the reactive state", async () => {
    const host = mountSplMultiselectFixture({ options: US_OPTIONS }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const changes: unknown[] = [];
    host.addEventListener("spl-change", (ev: CustomEvent) =>
      changes.push(ev.detail.value)
    );

    const adapter = new SRSplStateCommitAdapter();
    const result = await adapter.commit(
      fakePage(SR_URL),
      "#ms1",
      "United States"
    );

    expect(result.status).toBe("committed");
    expect(result.adapterName).toBe("SRSplStateCommitAdapter");
    expect(result.stateVerified).toBe(true);
    expect(result.detail).toContain("handleOptionSelect via options");
    // The exact internals JOB-266 found empty after all six mechanisms.
    expect(host.__value).toEqual(["United States"]);
    expect(host.selectedOptionsDictionary).toEqual({ o1: true });
    expect(host.optionsDictionary.o1).toEqual(US_OPTIONS[0]);
    // The spl-change CustomEvent is what Angular's form binding hears.
    expect(changes).toEqual([["United States"]]);
  });

  it("marks the field touched after the commit", async () => {
    const host = mountSplMultiselectFixture({ options: US_OPTIONS }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const adapter = new SRSplStateCommitAdapter();
    await adapter.commit(fakePage(SR_URL), "#ms1", "United States");
    expect(host.touchedState).toBe(true);
  });

  it("matches the option label case insensitively and trims whitespace", async () => {
    const host = mountSplMultiselectFixture({ options: US_OPTIONS }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const adapter = new SRSplStateCommitAdapter();
    const result = await adapter.commit(
      fakePage(SR_URL),
      "#ms1",
      "  united states "
    );
    expect(result.status).toBe("committed");
    expect(result.stateVerified).toBe(true);
    expect(host.__value).toEqual(["United States"]);
  });

  it("resolves the host from a wrapper selector", async () => {
    const host = mountSplMultiselectFixture({ options: US_OPTIONS }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const adapter = new SRSplStateCommitAdapter();
    const result = await adapter.commit(fakePage(SR_URL), "#wrap", "Canada");
    expect(result.status).toBe("committed");
    expect(result.stateVerified).toBe(true);
    expect(host.__value).toEqual(["Canada"]);
  });

  it("is idempotent when the option is already selected", async () => {
    const host = mountSplMultiselectFixture({
      options: US_OPTIONS,
      preselectedIds: ["o1"],
    }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    host.__value = ["United States"];
    const adapter = new SRSplStateCommitAdapter();
    const result = await adapter.commit(
      fakePage(SR_URL),
      "#ms1",
      "United States"
    );
    expect(result.status).toBe("committed");
    expect(result.stateVerified).toBe(true);
    expect(result.detail).toContain("already selected");
    // Selecting an already selected option must not toggle it back off.
    expect(host.selectedOptionsDictionary.o1).toBe(true);
  });

  it("builds a custom value through the component's own optionFactory", async () => {
    const host = mountSplMultiselectFixture({
      options: [],
      allowCustomValues: true,
      optionFactory: (v: string) => ({ id: `custom_${v}`, value: v, label: v }),
    }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const adapter = new SRSplStateCommitAdapter();
    const result = await adapter.commit(fakePage(SR_URL), "#ms1", "Remote only");
    expect(result.status).toBe("committed");
    expect(result.stateVerified).toBe(true);
    expect(result.detail).toContain("optionFactory custom value");
    expect(host.__value).toEqual(["Remote only"]);
  });

  it("uses the value array path when a matched option has no id", async () => {
    const host = mountSplMultiselectFixture({
      options: [{ value: "United States", label: "United States" }],
    }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const adapter = new SRSplStateCommitAdapter();
    const result = await adapter.commit(
      fakePage(SR_URL),
      "#ms1",
      "United States"
    );
    expect(result.status).toBe("committed");
    expect(result.stateVerified).toBe(true);
    expect(result.detail).toContain("value array");
    expect(host.__value).toEqual(["United States"]);
  });

  it("commits the base field shape through handleChange", async () => {
    const host = mountSplBaseFieldFixture() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const changes: unknown[] = [];
    host.addEventListener("spl-change", (ev: CustomEvent) =>
      changes.push(ev.detail.value)
    );
    const adapter = new SRSplStateCommitAdapter();
    const result = await adapter.commit(fakePage(SR_URL), "#sel1", "Yes");
    expect(result.status).toBe("committed");
    expect(result.stateVerified).toBe(true);
    expect(result.detail).toContain("handleChange");
    expect(host.__value).toBe("Yes");
    expect(changes).toEqual(["Yes"]);
    expect(host.touchedState).toBe(true);
  });

  it("never selects a different option than the one asked for", async () => {
    // HARD STOP 9 applied to widget plumbing: a target no option store can
    // supply, on an instance without custom values, must fail rather than
    // land the closest available option. The fallback event dispatch still
    // runs (production parity), but the state verdict is false and the
    // component's selection state is untouched.
    const host = mountSplMultiselectFixture({ options: US_OPTIONS }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const adapter = new SRSplStateCommitAdapter();
    const result = await adapter.commit(fakePage(SR_URL), "#ms1", "Mexico");
    expect(result.adapterName).toBe("SRSplStateCommitAdapter");
    expect(result.stateVerified).toBe(false);
    expect(result.detail).toContain("no option matched the target");
    expect(result.detail).toContain("fell back to event dispatch");
    expect(host.__value).toEqual([]);
    expect(host.selectedOptionsDictionary).toEqual({});
  });

  it("reports the instance probe in the detail", async () => {
    mountSplMultiselectFixture({ options: US_OPTIONS });
    const adapter = new SRSplStateCommitAdapter();
    const result = await adapter.commit(
      fakePage(SR_URL),
      "#ms1",
      "United States"
    );
    expect(result.detail).toContain("spl-multiselect-autocomplete");
    expect(result.detail).toContain("shape=multiselect");
  });
});

describe("commitFrameworkState with the JOB-317 registry order", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("routes a spl component instance to the state commit adapter", async () => {
    const host = mountSplMultiselectFixture({ options: US_OPTIONS }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const result = await commitFrameworkState(
      fakePage(SR_URL),
      "#ms1",
      "United States"
    );
    expect(result.adapterName).toBe("SRSplStateCommitAdapter");
    expect(result.status).toBe("committed");
    expect(result.stateVerified).toBe(true);
    expect(host.__value).toEqual(["United States"]);
  });

  it("still routes the ARIA only fixture to the event dispatch adapter", async () => {
    mountSrScreeningFixture();
    const result = await commitFrameworkState(fakePage(SR_URL), "#q1", "Yes");
    expect(result.adapterName).toBe("SRScreeningDropdownAdapter");
    expect(result.status).toBe("committed");
  });
});
