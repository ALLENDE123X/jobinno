// @vitest-environment node
/**
 * JOB-044 — the combobox mechanics `applyFieldValue` actually drives, exercised
 * against a fake `Page` rather than a real browser.
 *
 * `tests/unit/adaptive-form-fill.test.ts` covers the *policy* half of this
 * ticket: whether `resolveDecision` decides a school-labelled combobox with no
 * matching option should be typed as free text at all. It does that by mocking
 * `@/lib/form-fields` away entirely, which is the right level for a policy
 * question and the wrong level for "does the control actually end up holding
 * the right value" — nothing in this repo tested that for a combobox before
 * this file, because nothing needed to until video review of a real skipped
 * application showed exactly this mechanism failing:
 *
 *   the agent typed "San Francisco" into a Location field, a suggestion
 *   appeared, the agent clicked it, and the click did not register — the raw
 *   unmatched text was left sitting in the field.
 *
 * `chooseFromMenuOnce` used to commit a chosen option with
 * `page.locator(optionSelector).click()`, a mouse click dispatched at the
 * element's centroid over CDP with no confirmation it landed on the widget's
 * own hit target. It now commits by keyboard instead — arrow down to the
 * option's own position in the list, then enter — which does not depend on a
 * click landing anywhere. The same function is also where JOB-044's other
 * fix lives: a school-labelled combobox with no matching suggestion now keeps
 * whatever was typed rather than failing outright.
 *
 * The `Page` here is a plain object whose `evaluate` dispatches on which of
 * `form-fields.ts`'s own hand-rolled in-page scripts it was handed — matched
 * by a substring unique to that script, not by call order, so a change to how
 * many times any one of them is called does not make this fixture lie about
 * what ran. `Date.now` is stubbed to leap forward on every call so that the
 * real polling loops in `openMenu`/`chooseFromMenuOnce` (which wait on actual
 * wall-clock deadlines) resolve in this file's own time rather than in
 * `MENU_ATTEMPT_TIMEOUT_MS` plus `MENU_SEARCH_TIMEOUT_MS` of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyFieldValue, type EnumeratedField } from "@/lib/form-fields";

/** One control, with the boring parts of `EnumeratedField` filled in. */
function field(over: Partial<EnumeratedField> & { label: string; selector: string }): EnumeratedField {
  return {
    key: over.label.toLowerCase(),
    activateSelectors: [over.selector],
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
    ...over,
  };
}

type MenuState = { texts: string[]; selectors: string[]; count: number; expanded: boolean };

/**
 * How the fixture's menu behaves, beyond what is in it.
 *
 * `exposesHighlight` is the axis the 2026-08-22 Greenhouse fix turned on. A
 * menu that marks its highlighted option (react-select does, with a
 * `--is-focused` class) lets `highlightOption` steer by the difference between
 * where the highlight is and where it needs to be. One that marks nothing
 * leaves it walking blind on the WAI-ARIA convention, which is the older
 * behaviour and still has to work.
 *
 * `initialHighlight` is the other half: react-select opens with option 0
 * already highlighted, a pure ARIA combobox opens with nothing highlighted, and
 * assuming the second while driving the first is precisely what chose the
 * option after the right one on every dropdown of a real posting.
 */
type MenuBehaviour = {
  focusSucceeds?: boolean;
  exposesHighlight?: boolean;
  initialHighlight?: number;
  /** A widget whose highlight simply refuses to move, for the fail-closed path. */
  highlightStuck?: boolean;
};

/**
 * A fake `Page`. `menu` is mutable and read live by every `evaluate` call that
 * matches `readOpenMenuInPage`'s own script, so a test can change what the
 * "page" reports mid-flow the same way `.click()` or `.fill()` below do.
 *
 * `focusSucceeds` controls what `focusElement`'s own script reports back —
 * `applyFieldValue` now reads that return value rather than assuming it, so a
 * fixture that always answered `null` (falsy) would make every test exercise
 * the "focus did not land" failure path instead of the keyboard commit it
 * means to test. Defaults to `true` for that reason; the failure path gets its
 * own test below with this set to `false`.
 */
function fakePage(initialMenu: MenuState, options: MenuBehaviour = {}) {
  const focusSucceeds = options.focusSucceeds ?? true;
  const exposesHighlight = options.exposesHighlight ?? false;
  const highlightStuck = options.highlightStuck ?? false;
  const menu: MenuState = { ...initialMenu };
  let fieldValue = "";
  // Which option the widget itself has highlighted — the one its `Enter` would
  // commit. This fixture's own keyboard handling models the widget rather than
  // the production code, so a real widget that disagreed with what
  // `highlightOption` assumes shows up here as a wrong `readBack` rather than
  // as a green test that proves nothing. It wraps at the end of the list
  // because every menu this has been run against does.
  let highlighted = options.initialHighlight ?? -1;
  const locatorClicks: Record<string, number> = {};
  const locatorFills: string[] = [];
  const keyPresses: string[] = [];

  const page = {
    evaluate: vi.fn(async (script: string) => {
      // `readOpenMenuInPage` is a named function; `inPageExpression` splices its
      // own `.toString()` into the script, so its name survives verbatim.
      if (script.includes("readOpenMenuInPage")) {
        const focused = exposesHighlight ? highlighted : -1;
        return {
          ...menu,
          focused,
          focusedText: focused === -1 ? "" : (menu.texts[focused] ?? ""),
        };
      }
      // `readFieldValue`'s own script, unique among these for reading the
      // react-select mirror input pattern.
      if (script.includes("aria-hidden")) return fieldValue;
      // `readElementText`'s script — confirms the option at a selector still
      // reads what the menu said it did, right before it would be committed.
      if (script.includes("textContent")) {
        const index = menu.selectors.indexOf(scriptSelector(script));
        return index === -1 ? "" : menu.texts[index];
      }
      // `focusElement`'s script — the only one of these three whose caller
      // reads the return value, since this fix. Matched on `.focus(`, which is
      // unique to this script among everything `form-fields.ts` evaluates.
      if (script.includes(".focus(")) return focusSucceeds;
      // `scrollIntoView`, `scrollIfOffscreen` — neither return value is read
      // by any caller.
      return null;
    }),
    locator: vi.fn((selector: string) => ({
      click: vi.fn(async () => {
        locatorClicks[selector] = (locatorClicks[selector] ?? 0) + 1;
        // Opening the menu. A real search-style control (Location, School)
        // stays empty of options until something is typed into it.
        menu.expanded = true;
      }),
      fill: vi.fn(async (value: string) => {
        locatorFills.push(value);
        fieldValue = value;
      }),
      isChecked: vi.fn(async () => false),
      inputValue: vi.fn(async () => fieldValue),
    })),
    keyPress: vi.fn(async (key: string) => {
      keyPresses.push(key);
      if (key === "ArrowDown") {
        if (!highlightStuck && menu.texts.length > 0) {
          highlighted = highlighted + 1 >= menu.texts.length ? 0 : highlighted + 1;
        }
      } else if (key === "Enter" && highlighted >= 0 && highlighted < menu.texts.length) {
        fieldValue = menu.texts[highlighted]!;
      }
    }),
    waitForTimeout: vi.fn(async () => {}),
  };

  return { page, menu, locatorClicks, locatorFills, keyPresses };
}

/** Pulls the JSON-encoded selector back out of one of this file's own scripts. */
function scriptSelector(script: string): string {
  const match = /const sel = (".*?");/.exec(script);
  return match ? (JSON.parse(match[1]!) as string) : "";
}

beforeEach(() => {
  // `openMenu` and `chooseFromMenuOnce` poll against `Date.now()` deadlines
  // (1.5s and 4s respectively) when a menu or a match never appears. Real time
  // has to pass 1500ms/4000ms of wall clock for those loops to give up on
  // their own; jumping `Date.now()` forward on every call collapses that to a
  // couple of fast, deterministic iterations instead.
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => {
    now += 10_000;
    return now;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a combobox suggestion is committed with the keyboard, not a click", () => {
  it("arrows down to the chosen option's own position and presses enter", async () => {
    // Three options, already rendered — the short-list path (`pick`, not
    // `narrow`), so this isolates the commit mechanism from the typed search.
    // "Seattle, WA" is deliberately not first: the number of ArrowDown presses
    // has to track its real position (index 2), not just prove a single press
    // works.
    const { page, locatorClicks, keyPresses } = fakePage({
      texts: ["Atlanta, GA", "Boston, MA", "Seattle, WA"],
      selectors: ["#opt-0", "#opt-1", "#opt-2"],
      count: 3,
      expanded: true,
    });

    const outcome = await applyFieldValue(
      page as never,
      field({ label: "Location (City)", selector: "#loc-input", options: ["Atlanta, GA", "Boston, MA", "Seattle, WA"], optionsKnown: true }),
      "Seattle, WA"
    );

    expect(outcome).toEqual({
      ok: true,
      readBack: "Seattle, WA",
      detail:
        'chose "Seattle, WA" and read it back ' +
        "(the menu exposed no highlight, so only the read back confirms it)",
    });
    // Index 2, so three ArrowDown presses (WAI-ARIA's combobox pattern starts
    // with nothing highlighted) and then one Enter.
    expect(keyPresses).toEqual(["ArrowDown", "ArrowDown", "ArrowDown", "Enter"]);
    // Never a click on anything — the whole point of this fix, and the menu
    // here starts already expanded so not even the activation click ran.
    expect(locatorClicks).toEqual({});
  });

  it("walks the difference when the menu opens with an option already highlighted", async () => {
    // The 2026-08-22 Greenhouse bug, at its own level. react-select — which is
    // what Greenhouse draws every dropdown with — opens with option 0 already
    // highlighted, so the (index + 1) presses above land one option PAST the
    // one that was chosen. Here that would have committed a value nobody chose;
    // steering by the menu's own highlight walks the difference instead.
    const texts = ["Atlanta, GA", "Boston, MA", "Seattle, WA"];
    const { page, keyPresses } = fakePage(
      { texts, selectors: ["#opt-0", "#opt-1", "#opt-2"], count: 3, expanded: true },
      { exposesHighlight: true, initialHighlight: 0 }
    );

    const outcome = await applyFieldValue(
      page as never,
      field({ label: "Location (City)", selector: "#loc-input", options: texts, optionsKnown: true }),
      "Seattle, WA"
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("Seattle, WA");
    // Two presses, not three: the highlight was already on option 0.
    expect(keyPresses).toEqual(["ArrowDown", "ArrowDown", "Enter"]);
  });

  it("chooses the degree that was decided on, not the option after it", async () => {
    // The production symptom this fix exists for, in the wording it was
    // reported in: on four separate runs against a real Greenhouse posting the
    // read back found `degree` holding "Certification" when the decision layer
    // had chosen "Bachelor's Degree" — the option immediately after it in that
    // form's own list. Same shape produced "36 out of 36" for a chosen "Did not
    // take" and "No" for a chosen "Yes".
    const texts = ["Associate's Degree", "Bachelor's Degree", "Certification", "High School"];
    const { page } = fakePage(
      { texts, selectors: ["#d-0", "#d-1", "#d-2", "#d-3"], count: 4, expanded: true },
      { exposesHighlight: true, initialHighlight: 0 }
    );

    const outcome = await applyFieldValue(
      page as never,
      field({ label: "Degree", selector: "#degree--0", options: texts, optionsKnown: true }),
      "Bachelor's Degree"
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("Bachelor's Degree");
    expect(outcome.readBack).not.toBe("Certification");
  });

  it("chooses nothing at all when the highlight will not move onto the option", async () => {
    // Fail closed. A widget whose highlight this cannot steer is a widget whose
    // `Enter` would commit some other option, and committing the wrong option
    // silently is the failure being fixed — so nothing is committed and the
    // caller is told, which routes the field to the ordinary escalation path.
    const texts = ["Atlanta, GA", "Boston, MA", "Seattle, WA"];
    const { page, keyPresses } = fakePage(
      { texts, selectors: ["#opt-0", "#opt-1", "#opt-2"], count: 3, expanded: true },
      { exposesHighlight: true, initialHighlight: 0, highlightStuck: true }
    );

    const outcome = await applyFieldValue(
      page as never,
      field({ label: "Location (City)", selector: "#loc-input", options: texts, optionsKnown: true }),
      "Seattle, WA"
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("could not be moved onto");
    expect(keyPresses).not.toContain("Enter");
  });

  it("fails closed, with no keystrokes sent, when focus never lands on the control", async () => {
    // A code-review fix on this same ticket: `focusElement` used to be awaited
    // without checking what it returned, so a focus that silently failed to
    // land still let `ArrowDown`/`Enter` fire at whatever the page happened to
    // have focused instead — the same "click didn't register" failure mode
    // this whole keyboard path exists to avoid, just moved one step earlier.
    const { page, keyPresses } = fakePage(
      {
        texts: ["Atlanta, GA", "Boston, MA", "Seattle, WA"],
        selectors: ["#opt-0", "#opt-1", "#opt-2"],
        count: 3,
        expanded: true,
      },
      { focusSucceeds: false }
    );

    const outcome = await applyFieldValue(
      page as never,
      field({ label: "Location (City)", selector: "#loc-input", options: ["Atlanta, GA", "Boston, MA", "Seattle, WA"], optionsKnown: true }),
      "Seattle, WA"
    );

    expect(outcome).toEqual({
      ok: false,
      readBack: "",
      detail: "could not focus the control before selecting the option with the keyboard",
    });
    // No ArrowDown, no Enter — nothing was sent to whatever had focus instead.
    // `chooseFromMenu`'s own retry (a fresh attempt when the first comes back
    // both not-ok and empty, which this does) means `closeMenu`'s "Escape" is
    // legitimately in here more than once; that retry is not what this test is
    // about; the keyboard selection itself never firing is.
    expect(keyPresses).not.toContain("ArrowDown");
    expect(keyPresses).not.toContain("Enter");
  });
});

describe("a search combobox with no matching suggestion", () => {
  it("keeps the typed value when the caller allows free text", async () => {
    const { page, locatorFills } = fakePage({ texts: [], selectors: [], count: 0, expanded: false });

    const outcome = await applyFieldValue(
      page as never,
      field({ label: "School", selector: "#school-input", options: [], optionsKnown: false }),
      "Foo Bar University",
      { allowContains: true, allowFreeText: true }
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("Foo Bar University");
    expect(outcome.detail).toContain("left as typed free text");
    expect(locatorFills).toContain("Foo Bar University");
  });

  it("still fails when the caller does not allow free text", async () => {
    // The default, and the behaviour every combobox that is not
    // school-shaped keeps: `lib/fill-application-form.ts` only passes
    // `allowFreeText: true` for a field whose label matches
    // `SCHOOL_FIELD_LABEL_RE`, so a Location or Country combobox with no
    // matching suggestion has to still refuse rather than leave a half-typed,
    // unselected value on the form.
    const { page } = fakePage({ texts: [], selectors: [], count: 0, expanded: false });

    const outcome = await applyFieldValue(
      page as never,
      field({ label: "Location (City)", selector: "#loc-input", options: [], optionsKnown: false }),
      "Nowhere in Particular",
      { allowContains: true }
    );

    expect(outcome.ok).toBe(false);
  });
});
