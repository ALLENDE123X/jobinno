// @vitest-environment node
/**
 * Issue #172: the read-back comparator rejected values that a board's own
 * JavaScript had reformatted underneath us, and five real submissions were
 * aborted because of it on the founder run of 2026 08 26.
 *
 * The evidence rows this file is built from, verbatim from `skip_log`:
 *
 *  · "us dollar ($) reads '120000'" — Breezy stripped the comma from the
 *    intake value "120,000" (Atlas Technica, DS2).
 *  · "desired salary csalary reads '120000'" — same board, same strip
 *    (Kastech).
 *  · "phone number reads '404 444 6018'" — SmartRecruiters reformats phone
 *    separators (CapTech).
 *  · "\"US Dollar ($)\" could not be set to \"$\"" — a bare currency symbol
 *    typed into a numeric input cleared it to empty (DS2 AI & Applications).
 *
 * Two pure functions carry the fix and are tested directly:
 * `canonicalizeTypedValue`, which runs before anything is typed, and
 * `normalizeForComparison`, which is the second chance a failed strict
 * read-back gets. The wrapper that ties them together,
 * `applyWithReadBackTolerance`, is exercised against a mocked
 * `applyFieldValue` so the before-typing canonicalization and the
 * tolerance-on-failure behaviour are both pinned without a browser.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const applyFieldValueMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/form-fields", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyFieldValue: applyFieldValueMock,
}));

import {
  applyWithReadBackTolerance,
  canonicalizeTypedValue,
  normalizeForComparison,
} from "@/lib/fill-application-form";
import type { EnumeratedField } from "@/lib/form-fields";

function fieldOf(kind: EnumeratedField["kind"], label: string): EnumeratedField {
  return {
    key: label.toLowerCase(),
    selector: `#${label.replace(/\s+/g, "-").toLowerCase()}`,
    activateSelectors: [],
    label,
    kind,
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

afterEach(() => {
  applyFieldValueMock.mockReset();
});

describe("normalizeForComparison — issue #172 regression cases", () => {
  it("treats a comma-grouped salary as the number that was typed", () => {
    expect(normalizeForComparison("120000", "currency")).toBe(normalizeForComparison("120,000", "currency"));
  });

  it("treats a currency-marked salary as the number that was typed", () => {
    expect(normalizeForComparison("120000", "currency")).toBe(normalizeForComparison("$120,000", "currency"));
  });

  it("treats reformatted phone separators as the same phone number", () => {
    expect(normalizeForComparison("404 444 6018", "phone")).toBe(
      normalizeForComparison("(404) 444-6018", "phone")
    );
  });

  it("still catches a genuinely different number", () => {
    expect(normalizeForComparison("120000", "currency")).not.toBe(normalizeForComparison("110000", "currency"));
  });

  it("folds invisible space variants boards emit", () => {
    expect(normalizeForComparison("404\u00a0444\u00a06018")).toBe(normalizeForComparison("4044446018"));
  });

  it("leaves prose meaningfully different from other prose", () => {
    expect(normalizeForComparison("Bachelor of Science")).not.toBe(normalizeForComparison("Master of Science"));
  });
});

describe("canonicalizeTypedValue — what goes into a text control", () => {
  it("strips the dollar marker and grouping comma from an intake salary", () => {
    expect(canonicalizeTypedValue("$120,000")).toEqual({ value: "120000", unusable: false });
  });

  it("strips only the comma when no symbol is present", () => {
    expect(canonicalizeTypedValue("120,000")).toEqual({ value: "120000", unusable: false });
  });

  it("leaves an already-bare number alone", () => {
    expect(canonicalizeTypedValue("120000")).toEqual({ value: "120000", unusable: false });
  });

  it("refuses a bare currency symbol, the DS2 AI failure shape", () => {
    expect(canonicalizeTypedValue("$")).toEqual({ value: "", unusable: true });
  });

  it("refuses whitespace around a bare currency symbol too", () => {
    expect(canonicalizeTypedValue(" $ ")).toEqual({ value: "", unusable: true });
  });

  it("keeps a formatted phone number exactly as given for typing", () => {
    expect(canonicalizeTypedValue("(404) 444-6018")).toEqual({ value: "(404) 444-6018", unusable: false });
  });

  it("never touches a date range", () => {
    expect(canonicalizeTypedValue("2022-2024")).toEqual({ value: "2022-2024", unusable: false });
  });

  it("never touches prose", () => {
    expect(canonicalizeTypedValue("San Francisco, CA")).toEqual({
      value: "San Francisco, CA",
      unusable: false,
    });
  });
});

describe("applyWithReadBackTolerance — issue #172 regression cases", () => {
  it("types the stripped number into a numeric text input, not the raw '$120,000'", async () => {
    applyFieldValueMock.mockResolvedValue({ ok: true, readBack: "120000", detail: "typed and read back identical" });
    const outcome = await applyWithReadBackTolerance(
      {} as never,
      fieldOf("text", "US Dollar ($)"),
      "$120,000",
      {}
    );
    expect(applyFieldValueMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), "120000", {});
    expect(outcome.ok).toBe(true);
    expect(outcome.typedValue).toBe("120000");
  });

  it("refuses to type a bare '$' into a numeric input and reports nothing typed", async () => {
    const outcome = await applyWithReadBackTolerance(
      {} as never,
      fieldOf("text", "US Dollar ($)"),
      "$",
      {}
    );
    expect(applyFieldValueMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.readBack).toBe("");
  });

  it("accepts a failed strict compare once formatting is ignored, the CapTech phone shape", async () => {
    applyFieldValueMock.mockResolvedValue({
      ok: false,
      readBack: "404 444 6018",
      detail: 'the control now reads "404 444 6018", which is not what was typed',
    });
    const outcome = await applyWithReadBackTolerance(
      {} as never,
      fieldOf("text", "Phone Number"),
      "(404) 444-6018",
      {}
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.readBack).toBe("404 444 6018");
  });

  it("accepts the Breezy salary shape: typed '120,000', control holds '120000'", async () => {
    applyFieldValueMock.mockResolvedValue({
      ok: false,
      readBack: "120000",
      detail: 'the control now reads "120000", which is not what was typed',
    });
    const outcome = await applyWithReadBackTolerance(
      {} as never,
      fieldOf("text", "Desired Salary"),
      "120000",
      {}
    );
    expect(outcome.ok).toBe(true);
  });

  it("still reports a real mismatch as a mismatch", async () => {
    applyFieldValueMock.mockResolvedValue({
      ok: false,
      readBack: "110000",
      detail: 'the control now reads "110000", which is not what was typed',
    });
    const outcome = await applyWithReadBackTolerance(
      {} as never,
      fieldOf("text", "Desired Salary"),
      "120000",
      {}
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.typedValue).toBe("120000");
  });

  it("passes a menu answer through untouched, symbols included", async () => {
    applyFieldValueMock.mockResolvedValue({ ok: true, readBack: "US Dollar ($)", detail: "chosen" });
    const outcome = await applyWithReadBackTolerance(
      {} as never,
      fieldOf("select", "Currency"),
      "US Dollar ($)",
      {}
    );
    expect(applyFieldValueMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "US Dollar ($)",
      {}
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.typedValue).toBe("US Dollar ($)");
  });
});
