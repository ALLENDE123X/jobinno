// @vitest-environment jsdom
/**
 * Issue #94 — the perception fixes, exercised against the real DOM shapes that
 * broke on production runs of 2026-08-22.
 *
 * `enumerateFormFields` serialises its in-page reader into the browser with
 * `inPageExpression`; here the "browser" is this file's own jsdom document and
 * a fake `Page` whose `evaluate` runs the serialised script with `eval`. That
 * executes the exact code a real run injects, not a re-implementation of it.
 *
 * The fixtures are stripped-down copies of the two real forms this issue is
 * about, keeping the structure that mattered:
 *
 *  · Lever (jobs.lever.co/palantir) draws each custom-card question as a plain
 *    `<div class="application-label"><div class="text">…</div></div>` block
 *    followed by a sibling `<div class="application-field">` holding the
 *    control. No label[for], no wrapping label, no legend. Fields there used
 *    to report their `name` attribute — "cards[uuid][field0]" — as the label.
 *
 *  · Workable (apply.workable.com) hides every radio input from the
 *    accessibility tree (`aria-hidden="true"`, opacity 0) inside a visible
 *    wrapping label, with the question on the `<fieldset>`'s aria-labelledby.
 *    Whole required groups used to be invisible to the enumeration. Its
 *    dropdowns carry `required` only on a hidden mirror input.
 *
 * jsdom reports every rect as 0x0, which would make every control invisible to
 * the size checks, so `getBoundingClientRect` is stubbed to a laptop-plausible
 * size for everything except elements marked `data-test-zero-size`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyFieldValue,
  enumerateFormFields,
  type EnumeratedField,
} from "@/lib/form-fields";
import { type Page } from "@browserbasehq/stagehand";

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
    locator: (selector: string) => ({
      selectOption: async (values: string[]) => {
        const el = document.querySelector(selector) as HTMLSelectElement | null;
        if (el === null) throw new Error(`no element for ${selector}`);
        el.value = values[0] ?? "";
      },
    }),
  } as unknown as Page;
}

describe("Lever custom cards: the question block becomes the label", () => {
  it("reads a textarea card's caption instead of its name attribute", async () => {
    document.body.innerHTML = `
      <ul><li class="application-question custom-question"><div>
        <div class="application-label full-width textarea">
          <div class="text">High School Name<span class="required">✱</span></div>
        </div>
        <div class="application-field full-width required-field">
          <textarea class="card-field-input" name="cards[d54adf7b][field0]" required></textarea>
        </div>
      </div></li></ul>`;

    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.label).toBe("High School Name");
    expect(fields[0]?.kind).toBe("textarea");
    expect(fields[0]?.required).toBe(true);
  });

  it("reads a dropdown card's caption, and reports its long list as truncated", async () => {
    const options = Array.from({ length: 70 }, (_, i) => `University ${String(i).padStart(2, "0")}`);
    document.body.innerHTML = `
      <ul><li class="application-question custom-question"><div>
        <div class="application-label full-width dropdown">
          <div class="text">Which university are you currently attending?<span class="required">✱</span></div>
        </div>
        <div class="application-field full-width required-field"><div class="application-dropdown">
          <select name="cards[3da58b41][field0]" required>
            <option value="">Select...</option>
            ${options.map((o) => `<option value="${o}">${o}</option>`).join("")}
          </select>
        </div></div>
      </div></li></ul>`;

    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.label).toBe("Which university are you currently attending?");
    expect(fields[0]?.kind).toBe("select");
    expect(fields[0]?.required).toBe(true);
    expect(fields[0]?.options).toHaveLength(60);
    expect(fields[0]?.optionsTruncated).toBe(true);
  });

  it("reads a radio card's question, not its first answer, as the group label", async () => {
    document.body.innerHTML = `
      <ul><li class="application-question custom-question"><div>
        <div class="application-label full-width multiple-choice">
          <div class="text">We may use AI notetakers to transcribe conversations. Your decision will not impact your candidacy.<span class="required">✱</span></div>
        </div>
        <div class="application-field full-width required-field"><ul data-qa="multiple-choice">
          <li><label><input type="radio" name="cards[73796cde][field0]" value="Yes, I consent" required />
            <span class="application-answer-alternative">Yes, I consent</span></label></li>
          <li><label><input type="radio" name="cards[73796cde][field0]" value="No, I do not consent" required />
            <span class="application-answer-alternative">No, I do not consent</span></label></li>
        </ul></div>
      </div></li></ul>`;

    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.kind).toBe("radio");
    expect(fields[0]?.label).toContain("AI notetakers");
    expect(fields[0]?.label).not.toMatch(/^Yes, I consent/);
    expect(fields[0]?.required).toBe(true);
    expect(fields[0]?.options).toEqual(["Yes, I consent", "No, I do not consent"]);
  });

  it("prefixes a lone card checkbox's caption with the question above it", async () => {
    // Belvedere's Lever form: the question lives in the caption block, the
    // wrapping label says only "I Understand". Reported bare, the box reads
    // as an unanswerable mystery; prefixed, it is a procedural
    // acknowledgement the policy layer can recognise.
    document.body.innerHTML = `
      <ul><li class="application-question custom-question"><div>
        <div class="application-label">
          <div class="text">Your application will be reviewed for one position at a time.<span class="required">✱</span></div>
        </div>
        <div class="application-field"><ul>
          <li><label><input type="checkbox" name="cards[b1][field0]" value="I Understand" required />
            <span>I Understand</span></label></li>
        </ul></div>
      </div></li></ul>`;

    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.kind).toBe("checkbox");
    expect(fields[0]?.label).toBe(
      "Your application will be reviewed for one position at a time. I Understand"
    );
    expect(fields[0]?.required).toBe(true);
  });

  it("does not borrow the previous question's caption across a control boundary", async () => {
    // Two adjacent questions. The second control's walk meets the first
    // question's block (which holds a control) before any caption of its own,
    // and must stop rather than report "First question" for the second field.
    document.body.innerHTML = `
      <div>
        <div>
          <div class="application-label"><div class="text">First question</div></div>
          <div class="application-field"><textarea name="cards[a][field0]"></textarea></div>
        </div>
        <div>
          <div class="application-field"><textarea name="cards[b][field0]"></textarea></div>
        </div>
      </div>`;

    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(2);
    expect(fields[0]?.label).toBe("First question");
    expect(fields[1]?.label).toBe("cards[b][field0]");
  });
});

describe("Workable styled radios: aria-hidden inputs in visible labels", () => {
  const WORKABLE_GROUP = `
    <span id="q1_label"><strong>Do you have a High school diploma?</strong></span>
    <fieldset aria-labelledby="q1_label">
      <div>
        <label><input aria-required="true" required tabindex="-1" aria-hidden="true"
          type="radio" name="QA_1" value="true" /><span>YES</span></label>
        <label><input aria-required="true" required tabindex="-1" aria-hidden="true"
          type="radio" name="QA_1" value="false" /><span>NO</span></label>
      </div>
    </fieldset>`;

  it("enumerates the group, with the fieldset's labelledby text as the question", async () => {
    document.body.innerHTML = WORKABLE_GROUP;
    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.kind).toBe("radio");
    expect(fields[0]?.label).toBe("Do you have a High school diploma?");
    expect(fields[0]?.required).toBe(true);
    expect(fields[0]?.options).toEqual(["YES", "NO"]);
  });

  it("still skips an aria-hidden radio whose wrapping label is not really shown", async () => {
    document.body.innerHTML = WORKABLE_GROUP.replace(
      /<label>/g,
      '<label data-test-zero-size="true">'
    );
    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(0);
  });
});

describe("Workable dropdowns: required lives on the hidden mirror input", () => {
  it("marks the combobox required from its mirror, and does not report the mirror", async () => {
    document.body.innerHTML = `
      <span id="CA_1_label"><strong>Are you legally eligible to work in the United States?</strong></span>
      <div data-ui="CA_1" data-input-type="select"><label>
        <div><div>
          <input role="combobox" aria-haspopup="listbox" aria-labelledby="CA_1_label"
            id="input_CA_1_input" type="text" readonly />
        </div></div>
        <input name="CA_1" required tabindex="-1" aria-hidden="true" data-test-zero-size="true" />
      </label></div>`;

    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.kind).toBe("combobox");
    expect(fields[0]?.label).toBe("Are you legally eligible to work in the United States?");
    expect(fields[0]?.required).toBe(true);
  });
});

describe("a truncated native select falls back to its full live list", () => {
  /** The field as enumeration reports it: the first 60 of many options. */
  function truncatedSelect(reported: string[]): EnumeratedField {
    return {
      key: "which university are you currently attending?",
      selector: '[id="school"]',
      activateSelectors: ['[id="school"]'],
      label: "Which university are you currently attending?",
      kind: "select",
      required: true,
      currentValue: "",
      options: reported,
      optionSelectors: [],
      optionValues: reported,
      optionsKnown: true,
      optionsTruncated: true,
      maxLength: null,
      helpText: "",
    };
  }

  function mountSelect(extra: string): string[] {
    const reported = Array.from({ length: 60 }, (_, i) => `University ${String(i).padStart(2, "0")}`);
    document.body.innerHTML = `
      <select id="school" required>
        <option value="">Select...</option>
        ${reported.map((o) => `<option value="${o}">${o}</option>`).join("")}
        ${extra}
      </select>`;
    return reported;
  }

  it("chooses an option past the reported prefix by exact text", async () => {
    const reported = mountSelect(
      `<option value="Georgia Institute of Technology">Georgia Institute of Technology</option>`
    );
    const outcome = await applyFieldValue(
      domPage(),
      truncatedSelect(reported),
      "Georgia Institute of Technology"
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("Georgia Institute of Technology");
    const select = document.getElementById("school") as HTMLSelectElement;
    expect(select.value).toBe("Georgia Institute of Technology");
  });

  it("still refuses a value the full live list does not offer", async () => {
    const reported = mountSelect("");
    const outcome = await applyFieldValue(
      domPage(),
      truncatedSelect(reported),
      "Georgia Institute of Technology"
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("not one of this dropdown's options");
    const select = document.getElementById("school") as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("refuses an ambiguous match rather than picking between duplicates", async () => {
    const reported = mountSelect(
      `<option value="gt-1">Georgia Institute of Technology</option>` +
        `<option value="gt-2">Georgia Institute of Technology</option>`
    );
    const outcome = await applyFieldValue(
      domPage(),
      truncatedSelect(reported),
      "Georgia Institute of Technology"
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("too ambiguous");
    const select = document.getElementById("school") as HTMLSelectElement;
    expect(select.value).toBe("");
  });
});

describe("a select2 widget: the real select is aria-hidden under painted chrome", () => {
  /**
   * Lever's `university` field type, as the failure capture of application
   * c32122c7 shows it: the native `<select>` carrying every school is
   * `aria-hidden="true" tabindex="-1"`, and two spans with role="combobox"
   * are painted over it. The placeholder Lever uses is the word "Other", so
   * an unanswered control even looks answered on a screenshot.
   */
  const SELECT2 = `
    <li class="application-question custom-question"><div>
      <div class="application-label full-width university">
        <div class="text">Name of School<span class="required">✱</span></div>
      </div>
      <div class="application-field full-width required-field"><div class="application-university">
        <div class="bb-custom-select-container bb-customSelect">
          <span class="bb-custom-select-opener" role="combobox" aria-expanded="false" tabindex="0"><span>Other</span></span>
          <select data-qa="university-dropdown" name="cards[6d127747][field9]" id="university-picker"
                  data-placeholder="Other" required tabindex="-1"
                  class="select2-hidden-accessible" aria-hidden="true">
            <option value="">Other</option>
            <option value="Aalborg University">Aalborg University</option>
            <option value="Georgia Institute of Technology">Georgia Institute of Technology</option>
          </select>
          <span class="select2 select2-container"><span class="selection">
            <span class="select2-selection select2-selection--single" role="combobox" aria-expanded="false" tabindex="0">
              <span class="select2-selection__rendered"><span class="select2-selection__placeholder">Other</span></span>
            </span>
          </span></span>
        </div>
      </div></div>
    </div></li>`;

  it("reports the native select once, required, and not the painted spans", async () => {
    document.body.innerHTML = `<ul>${SELECT2}</ul>`;
    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.kind).toBe("select");
    expect(fields[0]?.label).toBe("Name of School");
    expect(fields[0]?.required).toBe(true);
    expect(fields[0]?.options).toContain("Georgia Institute of Technology");
  });

  it("selects the school on the native control the form actually posts", async () => {
    document.body.innerHTML = `<ul>${SELECT2}</ul>`;
    const fields = await enumerateFormFields(domPage());
    const school = fields[0];
    if (school === undefined) throw new Error("no field enumerated");
    const outcome = await applyFieldValue(domPage(), school, "Georgia Institute of Technology");
    expect(outcome.ok).toBe(true);
    const native = document.getElementById("university-picker") as HTMLSelectElement;
    expect(native.value).toBe("Georgia Institute of Technology");
  });

  it("still reports a real input[role=combobox], which is not chrome", async () => {
    // Workable and react-select drive a genuine input; only non form control
    // spans shadowing a select are dropped.
    document.body.innerHTML = `
      <span id="CA_9_label"><strong>How did you hear about us?</strong></span>
      <div><input role="combobox" aria-labelledby="CA_9_label" id="input_CA_9" type="text" /></div>`;
    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.kind).toBe("combobox");
  });

  it("still skips a select that is genuinely hidden rather than merely painted over", async () => {
    document.body.innerHTML = `
      <div data-test-zero-size="true">
        <select name="ghost" aria-hidden="true" data-test-zero-size="true">
          <option value="a">A</option>
        </select>
      </div>`;
    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(0);
  });
});
