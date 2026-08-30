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
