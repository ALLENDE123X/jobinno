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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyFieldValue,
  enumerateFormFields,
  harvestOptions,
  readFieldValue,
  type EnumeratedField,
} from "@/lib/form-fields";
import {
  assertStepFullyRead,
  countRequiredQuestions,
  FormFillBlockedError,
} from "@/lib/fill-application-form";
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

describe("JOB-052: one dropdown's open menu is never read as another's", () => {
  /**
   * Virtu's Greenhouse form, reduced to the two controls that collided.
   *
   * Every react-select on that page draws the same way: a real `<input
   * role="combobox">` buried under three wrapper divs, `aria-expanded` on the
   * input, and — only while the menu is open — an `aria-controls` pointing at
   * the listbox it rendered. A closed one names no listbox at all, which is
   * what left the document-wide sweep with nothing to tell one menu from
   * another.
   *
   * Verified against the live board on 2026-08-22: with the "ready for
   * full-time employment in 2028" menu open, harvesting the graduation-year
   * control returned `Yes / No / Undecided` and never opened the real menu.
   */
  function reactSelect(id: string, label: string, open: { options: string[] } | null): string {
    const menu =
      open === null
        ? ""
        : `<div class="select__menu"><div class="select__menu-list" role="listbox" id="react-select-${id}-listbox">${open.options
            .map(
              (text, i) =>
                `<div role="option" id="react-select-${id}-option-${i}" class="select__option">${text}</div>`
            )
            .join("")}</div></div>`;
    return `
      <div class="field-wrapper"><div class="select"><div class="select__container">
        <label id="${id}-label" for="${id}">${label}<span aria-hidden="true">*</span></label>
        <div class="select-shell"><div><div class="select__control"><div class="select__value-container">
          <div class="select__input-container">
            <input id="${id}" type="text" role="combobox" aria-labelledby="${id}-label"
                   aria-required="true" aria-autocomplete="list" value=""
                   aria-expanded="${open === null ? "false" : "true"}"
                   ${open === null ? "" : `aria-controls="react-select-${id}-listbox"`} />
          </div>
        </div></div></div>${menu}</div>
      </div></div></div>`;
  }

  function comboboxField(id: string, label: string): EnumeratedField {
    return {
      key: label.toLowerCase(),
      selector: `[id="${id}"]`,
      activateSelectors: [`[id="${id}"]`, `.select__control`],
      label,
      kind: "combobox",
      required: true,
      currentValue: "",
      options: [],
      optionSelectors: [],
      optionValues: [],
      optionsKnown: false,
      optionsTruncated: false,
      maxLength: null,
      helpText: "",
    };
  }

  /**
   * A `Page` over this jsdom that models the two react-select behaviours the
   * code under test depends on: typing filters the open menu down to what
   * matches, and Escape clears the search box. Clicking is deliberately inert,
   * so a test that ends up with options in hand got them from a menu that was
   * already open rather than from one this fixture opened for it.
   */
  function menuPage(): Page {
    const filter = (query: string): void => {
      const wanted = query.trim().toLowerCase();
      for (const option of Array.from(document.querySelectorAll('[role="option"]'))) {
        const text = (option.textContent ?? "").trim().toLowerCase();
        option.setAttribute("data-test-zero-size", text.includes(wanted) ? "false" : "true");
      }
      // react-select replaces a list that matched nothing with a notice row —
      // a plain child of the `role="listbox"` menu list, carrying no role of
      // its own. Modelled because that row is what the reader used to report
      // as this control's one and only option.
      for (const list of Array.from(document.querySelectorAll('[role="listbox"]'))) {
        const matches = Array.from(list.querySelectorAll('[role="option"]')).filter(
          (option) => option.getAttribute("data-test-zero-size") !== "true"
        );
        const existing = list.querySelector(".select__menu-notice--no-options");
        if (matches.length === 0 && existing === null) {
          const notice = document.createElement("div");
          notice.className = "select__menu-notice select__menu-notice--no-options";
          notice.textContent = "No options";
          list.append(notice);
        } else if (matches.length > 0 && existing !== null) {
          existing.remove();
        }
      }
    };
    return {
      evaluate: async (script: string) => eval(script),
      locator: (selector: string) => ({
        click: async () => {},
        fill: async (value: string) => {
          const el = document.querySelector(selector) as HTMLInputElement | null;
          if (el !== null) el.value = value;
          filter(value);
        },
      }),
      keyPress: async (key: string) => {
        if (key !== "Escape") return;
        // Escape empties the search box and puts the whole list back, which is
        // what react-select does and what makes the retry in `chooseFromMenu`
        // see the same menu the first attempt saw.
        for (const el of Array.from(document.querySelectorAll('input[role="combobox"]'))) {
          (el as HTMLInputElement).value = "";
        }
        filter("");
      },
      waitForTimeout: async () => {},
    } as unknown as Page;
  }

  beforeEach(() => {
    // `openMenu` and `chooseFromMenuOnce` poll real wall-clock deadlines
    // (1.5s per activation rung, 4s for a typed search). Leaping `Date.now`
    // collapses those to a couple of iterations, the same device
    // `tests/unit/form-fields.test.ts` uses for the same reason.
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 10_000;
      return now;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads nothing for a closed control while another control's menu is open", async () => {
    document.body.innerHTML =
      reactSelect("question_36551313002", "What is your expected graduation year?", null) +
      reactSelect("question_36551314002", "Will you be ready for full-time employment in 2028?", {
        options: ["Yes", "No", "Undecided"],
      });

    const harvested = await harvestOptions(
      menuPage(),
      comboboxField("question_36551313002", "What is your expected graduation year?")
    );

    expect(harvested.options).toEqual([]);
    expect(harvested.opened).toBe(false);
  });

  it("still reads its own open menu when a second menu is open too", async () => {
    document.body.innerHTML =
      reactSelect("question_36551313002", "What is your expected graduation year?", {
        options: ["2026", "2027", "2028", "2029", "2030"],
      }) +
      reactSelect("question_36551314002", "Will you be ready for full-time employment in 2028?", {
        options: ["Yes", "No", "Undecided"],
      });

    const harvested = await harvestOptions(
      menuPage(),
      comboboxField("question_36551313002", "What is your expected graduation year?")
    );

    expect(harvested.options).toEqual(["2026", "2027", "2028", "2029", "2030"]);
  });

  it("still reads a portal menu from a widget that declares no expanded state", async () => {
    // The case the document-wide sweep exists for, and the one the fence must
    // not take away: a menu rendered at the end of `<body>`, by a control that
    // never sets `aria-expanded` and claims nothing through `aria-controls`.
    document.body.innerHTML = `
      <label id="tt-label" for="tt">Country</label>
      <div><input id="tt" type="text" role="combobox" aria-labelledby="tt-label" value="" /></div>
      <div class="portal-menu">
        <div role="option">Ireland</div><div role="option">United States</div>
      </div>`;

    const harvested = await harvestOptions(menuPage(), comboboxField("tt", "Country"));

    expect(harvested.options).toEqual(["Ireland", "United States"]);
  });

  it("still reads a menu its own outer wrapper declares on its behalf", async () => {
    // One control written across two elements: the popup is declared on the
    // painted span, the value lives on the input the field addresses. The
    // wrapper is not a stranger and the fence must not treat it as one.
    document.body.innerHTML = `
      <label id="ss-label" for="ss">Name of School</label>
      <div class="opener" role="combobox" aria-controls="ss-listbox" aria-expanded="true">
        <input id="ss" type="text" role="combobox" aria-labelledby="ss-label" value="" />
      </div>
      <div id="ss-listbox" role="listbox">
        <div role="option">Georgia Institute of Technology</div>
        <div role="option">Georgia State University</div>
      </div>`;

    const harvested = await harvestOptions(menuPage(), comboboxField("ss", "Name of School"));

    expect(harvested.options).toEqual([
      "Georgia Institute of Technology",
      "Georgia State University",
    ]);
  });

  it("names the options the control offered, not the empty list a search left", async () => {
    // The graduation-year failure end to end. 2025 is the candidate's real
    // graduation year and is genuinely not on this menu, so the value cannot
    // be applied — the point of the test is that the report says which five
    // years the form does offer, rather than "offered no options", which is
    // what a search for a year that is not there leaves behind.
    document.body.innerHTML = reactSelect(
      "question_36551313002",
      "What is your expected graduation year?",
      { options: ["2026", "2027", "2028", "2029", "2030"] }
    );

    const outcome = await applyFieldValue(
      menuPage(),
      comboboxField("question_36551313002", "What is your expected graduation year?"),
      "2025"
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain(`"2025" is not one of this dropdown's options`);
    expect(outcome.detail).toContain(`"2026"`);
    expect(outcome.detail).toContain(`"2030"`);
    expect(outcome.detail).not.toContain("offered no options");
    // And the notice react-select leaves behind is not one of them.
    expect(outcome.detail).not.toContain("No options");
  });

  it("never reports react-select's own no-options notice as an option", async () => {
    // The listbox fallback reports a menu's rows when they carry no ARIA role,
    // which is what SmartRecruiters needs and what react-select's "No options"
    // row looks exactly like. Read as an option it becomes a choice nobody
    // offered.
    document.body.innerHTML = reactSelect(
      "question_36551313002",
      "What is your expected graduation year?",
      { options: ["2026", "2027"] }
    );
    const list = document.querySelector('[role="listbox"]') as HTMLElement;
    for (const option of Array.from(list.querySelectorAll('[role="option"]'))) option.remove();
    const notice = document.createElement("div");
    notice.className = "select__menu-notice select__menu-notice--no-options";
    notice.textContent = "No options";
    list.append(notice);

    const harvested = await harvestOptions(
      menuPage(),
      comboboxField("question_36551313002", "What is your expected graduation year?")
    );

    expect(harvested.options).toEqual([]);
  });

  it("still says a menu offered nothing when it really offered nothing", async () => {
    document.body.innerHTML = reactSelect(
      "question_36551313002",
      "What is your expected graduation year?",
      { options: [] }
    );

    const outcome = await applyFieldValue(
      menuPage(),
      comboboxField("question_36551313002", "What is your expected graduation year?"),
      "2025"
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("offered no options");
  });
});

/**
 * JOB-107 — reading a web component select's committed selection.
 *
 * The shape below is SmartRecruiters' phone country picker, copied off the live
 * Western Digital form on 2026-08-22 rather than imagined. Three things about it
 * are load bearing and all three are reproduced here:
 *
 *  · the control the enumeration addresses is the *search box*
 *    (`input[role="combobox"]`, "Search by country/region or code"), and it sits
 *    inside `spl-dropdown-search`'s own shadow root,
 *  · the committed selection is painted one level further out, inside the
 *    `spl-select`'s shadow root, on a node classed `…-selected-value`, and
 *  · the search box empties itself the moment a selection commits, because
 *    emptying is what a search box does.
 *
 * So the read back that guards every fill saw `""` on a control that had just
 * been set correctly, and a required field the board validates ("Please provide
 * a valid phone number") blocked every run. The guard is unchanged. Only the
 * question it asks the page is.
 */
describe("SmartRecruiters phone country: the selection is not on the control", () => {
  /**
   * Builds the picker. `selected` is the caption the widget paints, "" for
   * untouched.
   *
   * The 245 country options are here rather than trimmed to two, and they are in
   * the light DOM *before* the caption, because that ordering is the bug. On the
   * live board the caption is element 1229 of the 1230 under `spl-select`, so
   * any reader that walks a bounded number of elements looking for it stops a
   * thousand short and reports the control as empty. A fixture with two options
   * would pass against the broken reader.
   */
  function phoneCountryPicker(selected: string): void {
    const select = document.createElement("spl-select");
    select.setAttribute("value", selected === "" ? "" : "US");
    // The shadow root holds the widget's chrome; the caption is NOT in here.
    select.attachShadow({ mode: "open" }).innerHTML =
      `<spl-internal-form-field></spl-internal-form-field><spl-dropdown></spl-dropdown>`;

    // The search box: a light DOM child of the select, with its own shadow root.
    const search = document.createElement("spl-dropdown-search");
    search.setAttribute("slot", "search");
    const searchRoot = search.attachShadow({ mode: "open" });
    searchRoot.innerHTML =
      `<div><input type="text" role="combobox" ` +
      `aria-label="Search by country/region or code" data-jobinno-field="f7" /></div>`;
    select.append(search);

    for (let i = 0; i < 245; i++) {
      const option = document.createElement("spl-select-option");
      option.setAttribute("value", `C${i}`);
      option.innerHTML = `<div><span>Country ${i}</span><span>+${i}</span></div>`;
      select.append(option);
    }

    // The trigger caption, last, exactly where the board puts it.
    if (selected !== "") {
      const trigger = document.createElement("div");
      trigger.setAttribute("slot", "triggerPrefix");
      trigger.className = "c-spl-phone-field-selected-value-container";
      trigger.innerHTML =
        `<div class="c-spl-phone-field-selected-value-wrapper">` +
        `<spl-typography-body class="c-spl-phone-field-selected-value">${selected}` +
        `</spl-typography-body></div>`;
      select.append(trigger);
    }

    document.body.append(select);
  }

  function searchBoxField(): EnumeratedField {
    return {
      key: "search by country/region or code",
      selector: `[data-jobinno-field="f7"]`,
      activateSelectors: [`[data-jobinno-field="f7"]`],
      label: "Search by country/region or code",
      kind: "combobox",
      required: true,
      currentValue: "",
      options: [],
      optionSelectors: [],
      optionValues: [],
      optionsKnown: false,
      optionsTruncated: false,
      maxLength: null,
      helpText: "",
    };
  }

  it("reads the caption the widget paints, not the search box it cleared", async () => {
    phoneCountryPicker("+1");
    // The search box really is empty. This is the state the old read saw, and
    // reporting it was not wrong so much as it was the wrong element.
    const box = (
      document.querySelector("spl-dropdown-search") as HTMLElement
    ).shadowRoot?.querySelector("input") as HTMLInputElement;
    expect(box.value).toBe("");

    expect(await readFieldValue(domPage(), searchBoxField())).toBe("+1");
  });

  it("still reads empty when nothing has been chosen", async () => {
    phoneCountryPicker("");
    expect(await readFieldValue(domPage(), searchBoxField())).toBe("");
  });

  it("does not answer with the country code no applicant sees", async () => {
    // The `spl-select` carries `value="US"` while the option chosen reads
    // "United States +1". Answering with the code would turn a correct
    // selection into a reported mismatch, so the painted caption is what counts.
    phoneCountryPicker("+1");
    expect(await readFieldValue(domPage(), searchBoxField())).not.toBe("US");
  });

  it("reports the picker the board already set as answered, not as empty", async () => {
    // The consequence of the old read, and the reason this matters more than a
    // tidier report: `currentValue === ""` is what the fill uses to decide a
    // control still needs answering. SmartRecruiters ships this picker already
    // set to the applicant's country, so reading it as empty made the run open a
    // dropdown that did not need opening and type into a form that was correct.
    phoneCountryPicker("+1");

    const fields = await enumerateFormFields(domPage());
    const picker = fields.find((f) => f.label.includes("Search by country"));
    expect(picker?.currentValue).toBe("+1");
  });

  it("survives a custom element whose value is not a string", async () => {
    // `spl-phone-field` holds the object `{"country":"US"}` on its own `value`.
    // Calling `.replace` on that threw out of the whole script, which reads
    // downstream as an empty control rather than as the bug it is.
    const host = document.createElement("spl-phone-field");
    host.setAttribute("data-jobinno-field", "f8");
    (host as unknown as { value: unknown }).value = { country: "US" };
    document.body.append(host);

    const field = { ...searchBoxField(), selector: `[data-jobinno-field="f8"]` };
    expect(await readFieldValue(domPage(), field)).toBe("");
  });
});

/**
 * JOB-121 — SmartRecruiters' screening step, in the shape a live capture of
 * 2026-08-22 showed it in.
 *
 * `oneclick-ui` builds every question out of `spl-*` web components, and two
 * properties of that build were between this pipeline and a filled screening
 * form:
 *
 *  1. **The caption is slotted.** Each label is
 *     `<label><span><slot name="label-content"></slot><span aria-hidden>*</span></span></label>`
 *     inside a shadow root, with the question itself outside it in the host's
 *     light DOM as `<span slot="label-content">…</span>`. `textContent` on that
 *     label returns `"*"`, so five required questions on the captured step were
 *     enumerated with an empty label and reported as `field-6` … `field-10` —
 *     and `fillRemainingFields` drops any control whose label is `""`, so they
 *     were read and then silently skipped.
 *
 *  2. **The radios are painted.** A yes/no question is `<spl-radio-group>`
 *     holding `<spl-radio role="radio" aria-checked="false">`, with no
 *     `<input type="radio">` anywhere inside it. Three required questions on the
 *     captured step were built this way and could not be enumerated at all.
 *
 * The fixtures below are that markup, reduced to the parts that decide the
 * outcome and with the same nesting: the id, the shadow boundaries, the slot,
 * the `required` on the component and the `aria-required` on what it renders.
 */
function splLabel(id: string): string {
  return (
    `<label class="c-spl-form-field-label" for="${id}" id="${id}-label">` +
    `<span class="c-spl-form-field-label-required-group">` +
    `<slot name="label-content"></slot>` +
    `<span class="c-spl-form-field-required-mark" aria-hidden="true">*</span>` +
    `</span></label>`
  );
}

/** `<spl-input required>` — a shadow root, an inner component, a slotted caption. */
function splInput(id: string, question: string): HTMLElement {
  const host = document.createElement("spl-input");
  host.setAttribute("required", "");
  host.setAttribute("id", id);
  host.setAttribute("name", id);
  host.setAttribute("type", "text");
  const outer = host.attachShadow({ mode: "open" });
  const inner = document.createElement("spl-internal-form-field");
  const innerRoot = inner.attachShadow({ mode: "open" });
  innerRoot.innerHTML = `<div class="c-spl-form-field"><slot name="label"></slot><slot></slot></div>`;
  inner.innerHTML =
    splLabel(id) +
    `<div class="c-spl-input-grid"><div class="c-spl-input-wrapper">` +
    `<input class="c-spl-input" id="${id}" type="text" aria-required="true" />` +
    `</div></div>`;
  outer.append(inner);
  host.innerHTML = `<span slot="label-content"> ${question} </span>`;
  return host;
}

/** `<spl-radio-group required>` — painted radios, no native input in sight. */
function splRadioGroup(id: string, question: string, answers: string[]): HTMLElement {
  const host = document.createElement("spl-radio-group");
  host.setAttribute("required", "");
  host.setAttribute("id", id);
  const outer = host.attachShadow({ mode: "open" });
  const inner = document.createElement("spl-internal-form-field");
  const innerRoot = inner.attachShadow({ mode: "open" });
  innerRoot.innerHTML = `<div><slot name="label"></slot><slot></slot></div>`;
  inner.innerHTML =
    splLabel(id) +
    `<fieldset role="radiogroup" class="c-spl-radio-group" aria-labelledby="${id}-label" ` +
    `aria-required="true"><slot></slot></fieldset>`;
  outer.append(inner);
  host.innerHTML = `<span slot="label-content"> ${question} </span>`;
  answers.forEach((answer, index) => {
    const radio = document.createElement("spl-radio");
    radio.setAttribute("role", "radio");
    radio.setAttribute("aria-checked", "false");
    radio.setAttribute("label", answer);
    radio.setAttribute("value", String(index));
    radio.setAttribute("id", `${id}-answer-${index}`);
    radio.attachShadow({ mode: "open" }).innerHTML =
      `<label class="c-spl-form-field-label"><span>${answer}</span></label>` +
      `<div class="c-spl-radio"><div class="c-spl-radio__ring"></div></div>`;
    host.append(radio);
  });
  return host;
}

describe("SmartRecruiters screening step: the questions behind a <slot>", () => {
  it("reads a slotted caption instead of the lone asterisk beside it", async () => {
    document.body.append(
      splInput(
        "question_f4d61863",
        "What are your Annual Base Salary expectations (please include currency)?"
      )
    );

    const fields = await enumerateFormFields(domPage());
    const salary = fields.find((field) => field.kind === "text");
    expect(salary?.label).toBe(
      "What are your Annual Base Salary expectations (please include currency)?"
    );
    // The `*` beside the slot is still what marks the question required, and it
    // must not survive into the label a person is shown.
    expect(salary?.required).toBe(true);
    expect(salary?.label).not.toContain("*");
    // The key is what `needsInput` reports and what `--answer` is keyed on. An
    // empty label produced `field-6`, which nobody can answer.
    expect(salary?.key).not.toMatch(/^field-\d+$/);
  });
});

describe("SmartRecruiters screening step: radios with no <input> in them", () => {
  it("enumerates a painted radio group as one required question", async () => {
    document.body.append(
      splRadioGroup("spl-form-element_1", "Are you 18 years of age or older?", ["Yes", "No"])
    );

    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.kind).toBe("radio");
    expect(fields[0]?.label).toBe("Are you 18 years of age or older?");
    // `required` lives on the component and on the fieldset it renders, never on
    // any individual radio. Read as optional, the question is left blank on a
    // form the board will not accept without it.
    expect(fields[0]?.required).toBe(true);
    expect(fields[0]?.options).toEqual(["Yes", "No"]);
    expect(fields[0]?.optionSelectors).toHaveLength(2);
    expect(fields[0]?.currentValue).toBe("");
  });

  it("reports the group's question, never one of its own answers", async () => {
    document.body.append(
      splRadioGroup(
        "spl-form-element_4",
        "Will you now or in the future require sponsorship for an employment visa?",
        ["Yes", "No"]
      )
    );

    const fields = await enumerateFormFields(domPage());
    expect(fields[0]?.label).not.toBe("Yes");
    expect(fields[0]?.label).toContain("sponsorship");
  });

  it("reads the answer the board already selected", async () => {
    const group = splRadioGroup("spl-form-element_9", "Are you 18 years of age or older?", [
      "Yes",
      "No",
    ]);
    document.body.append(group);
    group.querySelectorAll("spl-radio")[0]?.setAttribute("aria-checked", "true");

    const fields = await enumerateFormFields(domPage());
    expect(fields[0]?.currentValue).toBe("Yes");
  });

  it("does not report a second copy of a native group that only wears the role", async () => {
    // A wrapper carrying `role="radio"` over a real `<input type="radio">` is
    // decoration, and reporting it would produce an undrivable duplicate of a
    // question that is already read correctly — the same trap `shadowsNativeSelect`
    // was written for on issue #94.
    document.body.innerHTML = `
      <fieldset><legend>Do you have a driving licence?</legend>
        <div role="radio"><label><input type="radio" name="licence" value="Yes" required /> Yes</label></div>
        <div role="radio"><label><input type="radio" name="licence" value="No" required /> No</label></div>
      </fieldset>`;

    const fields = await enumerateFormFields(domPage());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.label).toBe("Do you have a driving licence?");
    expect(fields[0]?.options).toEqual(["Yes", "No"]);
  });
});

/**
 * JOB-121 — the other half of the same page, and the reason the guard could
 * never have passed on it.
 *
 * `countRequiredQuestions` lives in `fill-application-form.ts` and is exercised
 * here because this is where the real markup is. It is perception in every sense
 * that matters: a `page.evaluate` over the DOM with no model anywhere near it,
 * and `assertStepFullyRead` compares its answer against what
 * `enumerateFormFields` read. The two have to be counting the same thing, and on
 * the captured SmartRecruiters step they were not: 29 against 8, on a page
 * holding eleven required questions.
 */
describe("counting required questions rather than required elements", () => {
  it("counts one nested web component question once, not three times", async () => {
    // `<spl-autocomplete required>` → `<spl-input required>` → `<input
    // aria-required>` is one question and three required elements. The old count
    // returned 3 for it and no amount of correct perception could match that.
    document.body.append(splInput("question_f4d61863", "What are your salary expectations?"));

    expect(await countRequiredQuestions(domPage())).toBe(1);
    const fields = await enumerateFormFields(domPage());
    expect(fields.filter((field) => field.required)).toHaveLength(1);
  });

  it("counts a painted radio group once, and agrees with what perception reads", async () => {
    document.body.append(
      splRadioGroup("spl-form-element_1", "Are you 18 years of age or older?", ["Yes", "No"])
    );
    document.body.append(
      splRadioGroup("spl-form-element_4", "Will you require visa sponsorship?", ["Yes", "No"])
    );
    document.body.append(splInput("question_f4d61863", "What are your salary expectations?"));

    const pageRequired = await countRequiredQuestions(domPage());
    const readRequired = (await enumerateFormFields(domPage())).filter(
      (field) => field.required
    ).length;
    expect(pageRequired).toBe(3);
    expect(readRequired).toBe(3);
    // The whole point: the guard is quiet because the page is read, not because
    // it was told to be quiet.
    expect(() => assertStepFullyRead(pageRequired, readRequired, 2, "https://example.test")).not
      .toThrow();
  });

  it("still stops when a required question is genuinely unread", async () => {
    // A question drawn as something this pass has no branch for at all. The
    // count sees it, perception does not, and the run must stop.
    document.body.append(splInput("question_f4d61863", "What are your salary expectations?"));
    const opaque = document.createElement("sr-question-field-signature");
    opaque.setAttribute("required", "");
    opaque.setAttribute("name", "question_signature");
    document.body.append(opaque);

    const pageRequired = await countRequiredQuestions(domPage());
    const readRequired = (await enumerateFormFields(domPage())).filter(
      (field) => field.required
    ).length;
    expect(pageRequired).toBe(2);
    expect(readRequired).toBe(1);
    expect(() =>
      assertStepFullyRead(pageRequired, readRequired, 2, "https://example.test")
    ).toThrow(FormFillBlockedError);
  });

  it("still folds a native radio group into one question", async () => {
    document.body.innerHTML = `
      <fieldset><legend>Do you have a driving licence?</legend>
        <label><input type="radio" name="licence" value="Yes" required /> Yes</label>
        <label><input type="radio" name="licence" value="No" required /> No</label>
      </fieldset>`;

    expect(await countRequiredQuestions(domPage())).toBe(1);
  });
});
