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
 * A fake `Page`. `menu` is mutable and read live by every `evaluate` call that
 * matches `readOpenMenuInPage`'s own script, so a test can change what the
 * "page" reports mid-flow the same way `.click()` or `.fill()` below do.
 */
function fakePage(initialMenu: MenuState) {
  const menu: MenuState = { ...initialMenu };
  let fieldValue = "";
  // WAI-ARIA's combobox pattern starts with nothing highlighted, which is the
  // convention `chooseFromMenuOnce` now relies on: the (index + 1)th
  // `ArrowDown` lands on option `index`, and `Enter` commits whatever is
  // highlighted at that point. This fixture's own keyboard handling mirrors
  // that convention rather than the production code, so a real widget that
  // disagreed with it would show up here as a wrong `readBack`, not a green
  // test that proves nothing.
  let highlighted = -1;
  const locatorClicks: Record<string, number> = {};
  const locatorFills: string[] = [];
  const keyPresses: string[] = [];

  const page = {
    evaluate: vi.fn(async (script: string) => {
      // `readOpenMenuInPage` is a named function; `inPageExpression` splices its
      // own `.toString()` into the script, so its name survives verbatim.
      if (script.includes("readOpenMenuInPage")) return { ...menu };
      // `readFieldValue`'s own script, unique among these for reading the
      // react-select mirror input pattern.
      if (script.includes("aria-hidden")) return fieldValue;
      // `readElementText`'s script — confirms the option at a selector still
      // reads what the menu said it did, right before it would be committed.
      if (script.includes("textContent")) {
        const index = menu.selectors.indexOf(scriptSelector(script));
        return index === -1 ? "" : menu.texts[index];
      }
      // `focusElement`, `scrollIntoView`, `scrollIfOffscreen` — none of their
      // return values are read by any caller.
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
        highlighted = Math.min(highlighted + 1, menu.texts.length - 1);
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

    expect(outcome).toEqual({ ok: true, readBack: "Seattle, WA", detail: 'chose "Seattle, WA" and read it back' });
    // Index 2, so three ArrowDown presses (WAI-ARIA's combobox pattern starts
    // with nothing highlighted) and then one Enter.
    expect(keyPresses).toEqual(["ArrowDown", "ArrowDown", "ArrowDown", "Enter"]);
    // Never a click on anything — the whole point of this fix, and the menu
    // here starts already expanded so not even the activation click ran.
    expect(locatorClicks).toEqual({});
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
