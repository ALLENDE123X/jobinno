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

import {
  applyFieldValue,
  pressAddEntry,
  pressCommitEntry,
  ADD_ENTRY_CONTROL_RE,
  AT_LEAST_ONE_ENTRY_RE,
  COMMIT_ENTRY_CONTROL_RE,
  findDeclineAnalogOption,
  findDeclineOption,
  type EnumeratedField,
  type RepeatingSection,
} from "@/lib/form-fields";

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

type MenuState = {
  texts: string[];
  selectors: string[];
  count: number;
  expanded: boolean;
  /**
   * JOB-266. Whether the fixture's open menu reports itself as an
   * `aria-multiselectable` listbox — see `chooseFromMenuOnce`'s
   * SmartRecruiters-scoped `Space`-versus-`Enter` branch. Defaults to
   * `false`, matching every menu this file tested before that ticket.
   */
  multiselectable?: boolean;
};

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
  /**
   * JOB-125. A widget that marks nothing until it has been arrowed at, which
   * reads as "unsteerable" on the first look and is not. The blind fallback used
   * to walk such a menu on the WAI-ARIA convention and press `Enter` without
   * ever looking again.
   */
  marksHighlightOnlyAfterArrow?: boolean;
  /**
   * JOB-266. The URL `isSmartRecruitersPage` reads to decide whether the
   * SR-scoped `Space` commit branch applies. Defaults to a Greenhouse URL —
   * a board this ticket must not change behaviour on — so every existing
   * test in this file, none of which set this, keeps exercising a
   * non-SmartRecruiters page exactly as before.
   */
  url?: string;
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
  const marksLate = options.marksHighlightOnlyAfterArrow ?? false;
  const exposesHighlight = options.exposesHighlight ?? false;
  const highlightStuck = options.highlightStuck ?? false;
  // JOB-266. A Greenhouse URL by default — `isSmartRecruitersPage` reads this
  // through the same `matchAtsHost` table the real board guard uses, and a
  // board this ticket must not touch stays a board this ticket must not touch
  // even in the fixture's own default.
  const url = options.url ?? "https://boards.greenhouse.io/example/jobs/1";
  let arrowed = false;
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
  // JOB-266. Every selector `dispatchOptionEvents` was asked to commit an
  // option through — the SmartRecruiters aria-multiselectable branch's own
  // mechanism, never a click or a key press.
  const dispatchCalls: string[] = [];

  const page = {
    url: vi.fn(async () => url),
    evaluate: vi.fn(async (script: string) => {
      // `readOpenMenuInPage` is a named function; `inPageExpression` splices its
      // own `.toString()` into the script, so its name survives verbatim.
      if (script.includes("readOpenMenuInPage")) {
        const marks = marksLate ? arrowed : exposesHighlight;
        const focused = marks ? highlighted : -1;
        return {
          ...menu,
          multiselectable: menu.multiselectable ?? false,
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
      // `dispatchOptionEvents`'s script — matched on `pointerdown`, unique to
      // it among everything else this file evaluates. Checked before
      // `.focus(` below: `dispatchOptionEvents` also calls `target.focus()`
      // as part of its own sequence, so that check would otherwise catch
      // this script first and never reach this branch. This fixture cannot
      // use `scriptSelector` here: `dispatchOptionEvents` addresses the
      // option directly (`optionSelector`, not a field's own selector), and
      // that is exactly what `dispatchCalls` below records, so a well-behaved
      // widget commits the option that selector names.
      if (script.includes("pointerdown")) {
        const called = scriptSelector(script);
        dispatchCalls.push(called);
        const optionIndex = menu.selectors.indexOf(called);
        if (optionIndex !== -1) fieldValue = menu.texts[optionIndex]!;
        return null;
      }
      // `focusElement`'s script — the only one of these three whose caller
      // reads the return value, since this fix. Matched on `.focus(`, which is
      // unique to this script among everything `form-fields.ts` evaluates,
      // apart from `dispatchOptionEvents` above, which is checked first.
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
        arrowed = true;
        if (!highlightStuck && menu.texts.length > 0) {
          highlighted = highlighted + 1 >= menu.texts.length ? 0 : highlighted + 1;
        }
      } else if (key === "Enter" && highlighted >= 0 && highlighted < menu.texts.length) {
        fieldValue = menu.texts[highlighted]!;
      }
    }),
    waitForTimeout: vi.fn(async () => {}),
  };

  return { page, menu, locatorClicks, locatorFills, keyPresses, dispatchCalls };
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

  it("looks again before believing a walk it made blind", async () => {
    // JOB-125. The blind fallback returned `ok: true` without ever re-reading,
    // so a widget that marks nothing on open and marks something once arrowed
    // at was walked on the WAI-ARIA convention and committed unchecked. Here
    // that convention is wrong — the menu was already on option 0 — and three
    // presses land back on "Atlanta, GA" through the wrap. The second look is
    // what turns that into a correction rather than a wrong value.
    const texts = ["Atlanta, GA", "Boston, MA", "Seattle, WA"];
    const { page } = fakePage(
      { texts, selectors: ["#opt-0", "#opt-1", "#opt-2"], count: 3, expanded: true },
      { initialHighlight: 0, marksHighlightOnlyAfterArrow: true }
    );

    const outcome = await applyFieldValue(
      page as never,
      field({ label: "Location (City)", selector: "#loc-input", options: texts, optionsKnown: true }),
      "Seattle, WA"
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("Seattle, WA");
    // And it is no longer reported as unverifiable, because it was verified.
    expect(outcome.detail).not.toContain("no highlight");
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

/**
 * JOB-266 — SmartRecruiters' "Preliminary questions" screening step draws a
 * "select one or more" question (its own examples: "Which, if any,
 * location(s) are you not willing to work in?", "Please select your area of
 * interest(s):") as an `aria-multiselectable="true"` listbox, a different
 * WAI-ARIA pattern from the single-select listbox every other test in this
 * file exercises. Live verification against AbbVie's screening step (see the
 * JOB-266 PR description) showed neither `Enter`, `Space`, `Locator.click()`,
 * nor a coordinate click on the option's own painted box — nor Stagehand's
 * own vision-guided `act()` — ever reached this widget's own toggle handler.
 * `dispatchOptionEvents` sends the fuller pointer/mouse/keyboard sequence a
 * real interaction produces, so this branch never steers a keyboard highlight
 * onto the option (no `ArrowDown`) and never calls `Locator.click()` either.
 */
describe("JOB-266: SmartRecruiters' aria-multiselectable listbox commits via dispatchOptionEvents", () => {
  it("dispatches to the option directly, without steering a keyboard highlight, for an aria-multiselectable listbox on a SmartRecruiters page", async () => {
    const { page, keyPresses, locatorClicks, dispatchCalls } = fakePage(
      {
        texts: ["Open to all locations"],
        selectors: ["#opt-0"],
        count: 1,
        expanded: true,
        multiselectable: true,
      },
      {
        url: "https://jobs.smartrecruiters.com/oneclick-ui/company/AbbVie/publication/ad7a31de-e00b-405f-8354-523ec83fa620/screening?dcr_ci=AbbVie",
      }
    );

    const outcome = await applyFieldValue(
      page as never,
      field({
        label: "Which, if any, location(s) are you not willing to work in?",
        selector: "#loc-input",
        options: ["Open to all locations"],
        optionsKnown: true,
      }),
      "Open to all locations"
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("Open to all locations");
    expect(dispatchCalls).toEqual(["#opt-0"]);
    expect(locatorClicks["#opt-0"]).toBeUndefined();
    expect(keyPresses).not.toContain("Enter");
    expect(keyPresses).not.toContain("Space");
    expect(keyPresses).not.toContain("ArrowDown");
  });

  it("still commits by keyboard for a SmartRecruiters listbox that is not aria-multiselectable", async () => {
    // A single-select SmartRecruiters dropdown ("What is your current degree
    // major or area of focus?" is one) must not change shape from this
    // ticket — only the `aria-multiselectable` listbox does.
    const { page, keyPresses, dispatchCalls } = fakePage(
      {
        texts: ["Computer Science"],
        selectors: ["#opt-0"],
        count: 1,
        expanded: true,
        multiselectable: false,
      },
      { url: "https://jobs.smartrecruiters.com/oneclick-ui/company/AbbVie/publication/abc/screening?dcr_ci=AbbVie" }
    );

    await applyFieldValue(
      page as never,
      field({
        label: "What is your current degree major or area of focus?",
        selector: "#major-input",
        options: ["Computer Science"],
        optionsKnown: true,
      }),
      "Computer Science"
    );

    expect(keyPresses).toContain("Enter");
    expect(dispatchCalls).toEqual([]);
  });

  it("still commits by keyboard for an aria-multiselectable listbox on a non-SmartRecruiters board", async () => {
    // The ticket's own non-goal: this branch must not change behaviour on any
    // other solver, even one whose menu happens to also be multiselectable.
    const { page, keyPresses, dispatchCalls } = fakePage(
      {
        texts: ["Remote"],
        selectors: ["#opt-0"],
        count: 1,
        expanded: true,
        multiselectable: true,
      },
      { url: "https://boards.greenhouse.io/example/jobs/1" }
    );

    await applyFieldValue(
      page as never,
      field({
        label: "Preferred work locations",
        selector: "#pref-input",
        options: ["Remote"],
        optionsKnown: true,
      }),
      "Remote"
    );

    expect(keyPresses).toContain("Enter");
    expect(dispatchCalls).toEqual([]);
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

/**
 * JOB-051. Every one of these six suggestions was read off the live Virtu
 * Greenhouse posting on 2026-08-22 by typing "San Francisco" into its
 * "Location (City)" control, in the order the board returned them. They are the
 * reason "exactly one option contains the query" was not a workable rule: all
 * six contain it, so the field stayed empty for a whole run and the board
 * answered the submit click with "Please enter your location".
 */
const SAN_FRANCISCO_SUGGESTIONS = [
  "San Francisco, California, United States",
  "San Francisco de Macorís, Duarte, Dominican Republic",
  "San Francisco, Agusan del Sur, Philippines",
  "San Francisco De Borja, Lima, Peru",
  "San Francisco, Cebu, Philippines",
  "South San Francisco, California, United States",
];

/** A menu whose options only exist once something has been typed, as a real one is. */
function searchMenu(texts: readonly string[]) {
  return fakePage(
    { texts: [...texts], selectors: texts.map((_, i) => `#opt-${i}`), count: texts.length, expanded: true },
    { exposesHighlight: true, initialHighlight: 0 }
  );
}

describe("a location search whose suggestions all contain the query", () => {
  const locationField = () =>
    field({
      label: "Location (City)",
      selector: '[id="candidate-location"]',
      options: [],
      optionsKnown: false,
    });

  it("resolves the city the candidate attested to, using the country they attested to", async () => {
    const { page } = searchMenu(SAN_FRANCISCO_SUGGESTIONS);

    const outcome = await applyFieldValue(page as never, locationField(), "San Francisco", {
      allowContains: true,
      contextTerms: ["United States"],
    });

    // The Californian one, not the Peruvian one and not South San Francisco.
    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("San Francisco, California, United States");
  });

  it("refuses when the country is not known, rather than taking the first suggestion", async () => {
    // Three of the six lead with exactly "San Francisco" (California,
    // Agusan del Sur, Cebu). Without a country to separate them this is a real
    // ambiguity, and the first suggestion being the right one on this
    // particular board is luck rather than a reason.
    const { page } = searchMenu(SAN_FRANCISCO_SUGGESTIONS);

    const outcome = await applyFieldValue(page as never, locationField(), "San Francisco", {
      allowContains: true,
    });

    expect(outcome.ok).toBe(false);
    // Nothing was committed. What the control holds is the query `narrow()`
    // typed into it, which is exactly the "looks filled, submits empty" state
    // the caller escalates on `ok: false` rather than trusting.
    expect(SAN_FRANCISCO_SUGGESTIONS).not.toContain(outcome.readBack);
  });

  it("does not let a short country abbreviation match inside an unrelated word", async () => {
    // JOB-246. `countryContextTerms` writes the US alternation as
    // "United States|USA|US|U.S.", and the bare two-letter spelling "US" is a
    // literal substring of "Agusan" in "San Francisco, Agusan del Sur,
    // Philippines" — so before this test's fix landed, providing the
    // candidate's own attested country term still left two survivors (the
    // real California suggestion and the Philippine one, matched by
    // accident) and the tie-break correctly, but wrongly, refused both.
    // Verified live against Freeform's Location (City) field on 2026-08-28:
    // supplying the attested country term alone did not fix the field until
    // the boundary check went in.
    const { page } = searchMenu(SAN_FRANCISCO_SUGGESTIONS);

    const outcome = await applyFieldValue(page as never, locationField(), "San Francisco", {
      allowContains: true,
      contextTerms: ["United States|USA|US|U.S."],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("San Francisco, California, United States");
  });

  it("recognises the attested country however the board abbreviates it", async () => {
    // JOB-047. SmartRecruiters' location service writes the same six-suggestion
    // answer as "San Francisco, CA, US". A context term of only "United States"
    // matches none of them, so the required City field stayed empty on every
    // run. One term carrying its equivalent spellings resolves it, and it is
    // still the one attested fact being required.
    const { page } = searchMenu([
      "San Francisco, CA, US",
      "San Francisco, Caraga, Philippines",
      "San Francisco, Cordoba, Argentina",
      "South San Francisco, CA, US",
    ]);

    const outcome = await applyFieldValue(page as never, locationField(), "San Francisco", {
      allowContains: true,
      contextTerms: ["United States|USA|US"],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("San Francisco, CA, US");
  });

  it("still requires the one attested fact when a term carries several spellings", async () => {
    // The alternation must not become "any of these is optional": none of these
    // suggestions is in the country the candidate attested to, so the answer is
    // still no.
    const { page } = searchMenu([
      "San Francisco, Caraga, Philippines",
      "San Francisco, Cordoba, Argentina",
    ]);

    const outcome = await applyFieldValue(page as never, locationField(), "San Francisco", {
      allowContains: true,
      contextTerms: ["United States|USA|US"],
    });

    expect(outcome.ok).toBe(false);
  });

  it("does not settle for a city whose name merely starts the same way", async () => {
    // "South San Francisco, California, United States" contains the query and
    // contains the country, so only the leading-segment rule excludes it. Here
    // it is the *sole* remaining candidate and the answer still has to be no:
    // South San Francisco is a different city.
    const { page } = searchMenu([
      "South San Francisco, California, United States",
      "San Francisco, Cebu, Philippines",
    ]);

    const outcome = await applyFieldValue(page as never, locationField(), "San Francisco", {
      allowContains: true,
      contextTerms: ["United States"],
    });

    expect(outcome.ok).toBe(false);
  });

  it("still takes a lone containing suggestion with no country to help", async () => {
    // The pre-existing rule, which this widens rather than replaces.
    const { page } = searchMenu(["Atlanta, Georgia, United States", "Boston, Massachusetts, United States"]);

    const outcome = await applyFieldValue(page as never, locationField(), "Atlanta", {
      allowContains: true,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("Atlanta, Georgia, United States");
  });

  it("never lets a context term introduce an answer of its own", async () => {
    // The country matches two suggestions and the city matches neither. A
    // context term is only ever a tie-break among options that already contain
    // the value, so this stays a refusal.
    const { page } = searchMenu([
      "Austin, Texas, United States",
      "Boston, Massachusetts, United States",
    ]);

    const outcome = await applyFieldValue(page as never, locationField(), "San Francisco", {
      allowContains: true,
      contextTerms: ["United States"],
    });

    expect(outcome.ok).toBe(false);
  });

  it("leaves a fixed-list dropdown alone, where a near match is still a wrong answer", async () => {
    // `allowContains` is off for any combobox that already offered options, so
    // the tie-break cannot reach a menu like this one. "Georgia Tech" is on the
    // live Virtu form's university list and "Georgia" is not, and picking the
    // former for the latter would be a guess.
    const { page } = searchMenu(["Georgia Tech", "Georgia State"]);

    const outcome = await applyFieldValue(
      page as never,
      field({
        label: "Which university are you currently attending?",
        selector: '[id="question_37228963002"]',
        options: ["Georgia Tech", "Georgia State"],
        optionsKnown: true,
      }),
      "Georgia",
      { contextTerms: ["United States"] }
    );

    expect(outcome.ok).toBe(false);
  });
});

/**
 * JOB-271. Read verbatim off Bertelsmann's live SmartRecruiters posting on
 * 2026-08-29: typing the candidate's own ZIP "94107" (San Francisco)
 * returned one match apiece in Vietnam, Mexico, Lithuania and Germany
 * alongside two in the United States — the plain city and a neighborhood
 * inside it. Every suggestion here starts with the postal code itself, so
 * `pick`'s leading-segment rule — built for a city field, where it does most
 * of the narrowing — passes all six, and the whole burden of separating them
 * falls on `contextTerms` and, for the two US ones, on `localityTerm`.
 */
const POSTAL_CODE_SUGGESTIONS = [
  "94107, San Francisco, CA, USA",
  "94107, Cái Khế, Cần Thơ, VNM",
  "94107, Huatusco, Veracruz de Ignacio de la Llave, MEX",
  "94107, Klaipėda, Klaipėdos apskritis, LTU",
  "94107, Untergriesbach, Bayern, DEU",
  "94107, Bayview, San Francisco, CA, USA",
];

describe("JOB-271: a SmartRecruiters postal code combobox with country-ambiguous suggestions", () => {
  const postalCodeField = () =>
    field({
      label: "Postal Code",
      selector: '[id="candidate-postal-code"]',
      options: [],
      optionsKnown: false,
    });

  it("narrows to the country attested, then to the city attested", async () => {
    const { page } = searchMenu(POSTAL_CODE_SUGGESTIONS);

    const outcome = await applyFieldValue(page as never, postalCodeField(), "94107", {
      allowContains: true,
      contextTerms: ["United States|USA|US|U.S."],
      localityTerm: "San Francisco",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("94107, San Francisco, CA, USA");
  });

  it("refuses to guess between the two US matches with no locality term", async () => {
    // The country term alone narrows seven candidates to two — the plain
    // city and the neighborhood inside it — and both survive on the
    // leading-segment rule, since every option here starts with the same
    // postal code. Without a locality to break that tie the field is left
    // unresolved, exactly as any other genuine ambiguity is, rather than
    // guessing between them.
    const { page } = searchMenu(POSTAL_CODE_SUGGESTIONS);

    const outcome = await applyFieldValue(page as never, postalCodeField(), "94107", {
      allowContains: true,
      contextTerms: ["United States|USA|US|U.S."],
    });

    expect(outcome.ok).toBe(false);
  });

  it("never lets the locality term pick a neighborhood over the city it sits inside", async () => {
    // Both surviving US suggestions contain "San Francisco" as a substring,
    // which is exactly why a plain `contextTerms` entry cannot separate
    // them — see `localityTerm`'s own header. Listed in the opposite order
    // from `POSTAL_CODE_SUGGESTIONS` so a pass here cannot be explained by
    // this always preferring whichever option came first.
    const { page } = searchMenu([
      "94107, Bayview, San Francisco, CA, USA",
      "94107, San Francisco, CA, USA",
    ]);

    const outcome = await applyFieldValue(page as never, postalCodeField(), "94107", {
      allowContains: true,
      contextTerms: ["United States|USA|US|U.S."],
      localityTerm: "San Francisco",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("94107, San Francisco, CA, USA");
  });

  it("still refuses when the locality term matches none of the survivors", async () => {
    const { page } = searchMenu(POSTAL_CODE_SUGGESTIONS);

    const outcome = await applyFieldValue(page as never, postalCodeField(), "94107", {
      allowContains: true,
      contextTerms: ["United States|USA|US|U.S."],
      localityTerm: "Oakland",
    });

    expect(outcome.ok).toBe(false);
  });

  it("never lets the locality term introduce an answer with no country context", async () => {
    // `localityTerm` only ever narrows what `contextTerms` already found —
    // see its own header — so with no country term at all this stays a
    // refusal even though a locality term is given.
    const { page } = searchMenu(POSTAL_CODE_SUGGESTIONS);

    const outcome = await applyFieldValue(page as never, postalCodeField(), "94107", {
      allowContains: true,
      localityTerm: "San Francisco",
    });

    expect(outcome.ok).toBe(false);
  });
});

/**
 * JOB-047 — the repeating-subform predicates and the guard on the one new click
 * this module learned.
 *
 * The DOM half (walking open shadow roots, finding the section box that holds
 * both the heading and the entry form) cannot be tested here and is not
 * pretended to be: it runs inside a real browser against a real board, and the
 * PR says which live listing it was proven against. What *is* testable in
 * isolation is the part that decides whether a control may be pressed at all,
 * and that is the part where being wrong sends somebody's application.
 */
describe("recognising a repeating section's own controls", () => {
  it("matches the add controls a board actually renders", () => {
    for (const words of [
      "Add",
      "+ Add",
      "Add another",
      "Add another entry",
      "add more",
      "Add a new row",
      "Add Add experience entry",
    ]) {
      expect(ADD_ENTRY_CONTROL_RE.test(words)).toBe(true);
    }
  });

  it("does not mistake other buttons for one", () => {
    // "Address" is the one that matters: it is a word this would have matched
    // on a bare `/add/` and it names a field, not a control.
    for (const words of [
      "Address",
      "Address line 2",
      "Upload",
      "Submit application",
      "Apply now",
      "Save",
      "Next",
    ]) {
      expect(ADD_ENTRY_CONTROL_RE.test(words)).toBe(false);
    }
  });

  it("matches a control that commits one entry, and nothing that advances the form", () => {
    for (const words of ["Save", "Save experience entry", "Done", "Add entry"]) {
      expect(COMMIT_ENTRY_CONTROL_RE.test(words)).toBe(true);
    }
    // None of these commits a subform. Two of them submit an application.
    for (const words of ["Next", "Continue", "Submit", "Submit application", "Finish", "Cancel"]) {
      expect(COMMIT_ENTRY_CONTROL_RE.test(words)).toBe(false);
    }
  });

  it("reads the board's own complaint that a section is empty", () => {
    for (const message of [
      "Please provide at least one work experience entry",
      "Please provide at least one education entry",
      "You must add at least one entry",
      "Add at least one position",
    ]) {
      expect(AT_LEAST_ONE_ENTRY_RE.test(message)).toBe(true);
    }
    // Not every sentence with "at least one" in it is this.
    for (const message of [
      "Password must contain at least one number",
      "Select at least one of the checkboxes below",
    ]) {
      expect(AT_LEAST_ONE_ENTRY_RE.test(message)).toBe(false);
    }
  });
});

/**
 * A `Page` that reports one control's words and records what was pressed.
 *
 * `commitSticks` models what a board does when Save works: the entry's edit form
 * (and with it the Save button) comes off the page, which is the only evidence
 * `pressCommitEntry` has that anything was committed. Set it false for the board
 * behaviour that made this read-back necessary — a press that is accepted,
 * reported, and changes nothing.
 */
function pressablePage(words: string, options: { found?: boolean; commitSticks?: boolean } = {}) {
  const found = options.found ?? true;
  const commitSticks = options.commitSticks ?? true;
  const clicked: string[] = [];
  const page = {
    evaluate: vi.fn(async (script: string) => {
      if (script.includes("findCommitControlInPage")) {
        const gone = commitSticks && clicked.length > 0;
        return {
          selector: gone ? "" : '[data-jobinno-section="c1"]',
          containerFound: true,
          considered: [words],
        };
      }
      if (script.includes("describePressableInPage")) {
        return {
          found,
          words,
          submitish: /\b(submit|send|apply|application|finish|complete)\w*\b/i.test(words),
        };
      }
      return null;
    }),
    locator: vi.fn((selector: string) => ({
      click: vi.fn(async () => {
        clicked.push(selector);
      }),
    })),
    keyPress: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
  };
  return { page, clicked };
}

const SECTION: RepeatingSection = {
  key: "experience",
  heading: "Experience",
  addSelector: '[data-jobinno-section="a1"]',
  containerSelector: '[data-jobinno-section="s2"]',
  message: "Please provide at least one work experience entry",
};

describe("the guard on pressing a repeating section's controls", () => {
  it("presses an add control that still reads like one", async () => {
    const { page, clicked } = pressablePage("Add Add experience entry");
    const outcome = await pressAddEntry(page as never, SECTION);
    expect(outcome.ok).toBe(true);
    expect(clicked).toEqual(['[data-jobinno-section="a1"]']);
  });

  it("refuses, without clicking, when the control now reads like a submit", async () => {
    // The whole reason the words are re-read at the moment of the press rather
    // than trusted from the enumeration pass: a form re-renders between the two,
    // and "the button that was called Add when we looked" is a different claim
    // from "the button that is called Add now".
    const { page, clicked } = pressablePage("Submit application");
    const outcome = await pressAddEntry(page as never, SECTION);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("could submit the application");
    expect(clicked).toEqual([]);
  });

  it("refuses, without clicking, when the control is not an add control at all", async () => {
    const { page, clicked } = pressablePage("Delete this entry");
    const outcome = await pressAddEntry(page as never, SECTION);
    expect(outcome.ok).toBe(false);
    expect(clicked).toEqual([]);
  });

  it("refuses, without clicking, when the control has gone", async () => {
    const { page, clicked } = pressablePage("Add", { found: false });
    const outcome = await pressAddEntry(page as never, SECTION);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("no longer on the page");
    expect(clicked).toEqual([]);
  });

  it("holds the commit control to the same rule", async () => {
    const { page, clicked } = pressablePage("Save Save experience entry");
    const outcome = await pressCommitEntry(page as never, SECTION);
    expect(outcome.ok).toBe(true);
    expect(clicked).toEqual(['[data-jobinno-section="c1"]']);
  });

  it("reports a commit that was pressed and changed nothing", async () => {
    // The read-back that a live SmartRecruiters run made necessary: the Save
    // button was found, pressed, and reported pressed, and the experience entry
    // was still sitting in edit mode at the end of the run. Two presses and the
    // form still there is the honest answer, not a success.
    const { page, clicked } = pressablePage("Save Save experience entry", { commitSticks: false });
    const outcome = await pressCommitEntry(page as never, SECTION);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("still on the page");
    expect(clicked).toHaveLength(2);
  });

  it("refuses to commit through a control that submits the application", async () => {
    const { page, clicked } = pressablePage("Save and submit application");
    const outcome = await pressCommitEntry(page as never, SECTION);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("could submit the application");
    expect(clicked).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * JOB-262. `findDeclineAnalogOption` is the pure lookup half of the
 * SmartRecruiters and Breezy EEO decline carve out — the ats gate and the
 * "only after `findDeclineOption` came back null" rule both live in
 * `resolveDecision` (see `tests/unit/adaptive-form-fill.test.ts`), so this
 * file only has to prove the wider pattern itself finds what it should and
 * nothing more.
 */
describe("findDeclineAnalogOption, the widened EEO decline lookup", () => {
  it("finds an \"N/A\" option DECLINE_OPTION_RE does not recognise", () => {
    const options = ["Hispanic or Latino", "White", "Black or African American", "N/A"];
    expect(findDeclineOption(options)).toBeNull();
    expect(findDeclineAnalogOption(options)).toBe("N/A");
  });

  it("finds a \"Not Applicable\" option the same way", () => {
    const options = ["Male", "Female", "Non-binary", "Not Applicable"];
    expect(findDeclineOption(options)).toBeNull();
    expect(findDeclineAnalogOption(options)).toBe("Not Applicable");
  });

  it("still finds an explicitly labelled decline option, unchanged", () => {
    const options = ["Male", "Female", "Decline to self identify"];
    expect(findDeclineAnalogOption(options)).toBe("Decline to self identify");
  });

  it("finds nothing when every option is a substantive identity claim", () => {
    // The VetsEZ Tampa Cloud Integration shape: a plain Yes/No offers nothing
    // honest adjacent at all, and the widened pattern must not invent one.
    expect(findDeclineAnalogOption(["Yes", "No"])).toBeNull();
    expect(findDeclineAnalogOption(["Male", "Female", "Non-binary"])).toBeNull();
  });

  it("does not match \"N/A\" or \"not applicable\" as a substring of an unrelated option", () => {
    // Guards against the widened pattern over-matching a word boundary. A
    // country or state list is exactly where a stray match would be costly.
    expect(findDeclineAnalogOption(["Nevada"])).toBeNull();
  });

  it("does not select a demographic identity claim disguised behind an \"N/A\" or \"Not Applicable\" prefix", () => {
    // Red team finding: a real OFCCP style Workday derived veteran or
    // disability question phrases its negative option as a full sentence,
    // and "N/A" or "Not Applicable" is commonly prepended to it. Before the
    // fix, the bare word boundary alternatives matched this as a substring
    // and `.find()` returned the whole sentence, an identity claim, to be
    // typed into the form and written to `answer_provenance` verbatim.
    const options = [
      "I am a protected veteran",
      "Not Applicable — I am not a protected veteran",
    ];
    expect(findDeclineAnalogOption(options)).toBeNull();

    const disabilityOptions = [
      "Yes, I have a disability",
      "No, I do not have a disability",
      "N/A — I choose to self identify as having no disability",
    ];
    expect(findDeclineAnalogOption(disabilityOptions)).toBeNull();
  });

  it("still matches a bare \"N/A\" or \"Not Applicable\" option, including with incidental whitespace", () => {
    // The anchoring fix above must not regress the safe cases it exists to
    // protect: the exact phrasings real SmartRecruiters and Breezy forms use.
    expect(findDeclineAnalogOption(["N/A"])).toBe("N/A");
    expect(findDeclineAnalogOption(["Not Applicable"])).toBe("Not Applicable");
    expect(findDeclineAnalogOption(["N/A "])).toBe("N/A ");
    expect(findDeclineAnalogOption([" Not Applicable"])).toBe(" Not Applicable");
  });
});
