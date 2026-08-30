/**
 * JOB-280 (sub ticket C of #276). Cases for the deterministic prefill pass.
 *
 * The SR OneClick fixture below is deliberately close in shape to the one
 * `tests/unit/agent/readback.test.ts` builds, so the two suites stay honest
 * about what a real board looks like without either fixture having to
 * import the other. The fact catalog fixture mirrors the shape sub ticket
 * B lands in `lib/agent/fact-catalog.ts`, populated at the fact paths
 * `lib/agent/prefill.ts` documents.
 */

import { describe, expect, it } from "vitest";

import {
  classifyPrefillSlot,
  deterministicPrefill,
  isExcludedLabel,
  type PrefillPage,
  type PrefillReport,
  type PrefillSlot,
} from "@/lib/agent/prefill";
import type {
  AgentSnapshotSource,
  RawAccessibilityNode,
} from "@/lib/agent/readback";
import type { FactCatalog, FactEntry } from "@/lib/agent/fact-catalog";

/**
 * A `PrefillPage` around a static a11y tree plus a call recording
 * `setFieldValue`. Both halves are deliberately in one object so a test can
 * assert the report and the recorded calls without threading a spy through
 * a second surface.
 */
function pageFromTree(
  url: string,
  title: string,
  tree: RawAccessibilityNode
): PrefillPage & { calls: Array<{ ref: string; value: string }> } {
  const calls: Array<{ ref: string; value: string }> = [];
  const base: AgentSnapshotSource = {
    url: () => url,
    title: () => title,
    captureAccessibilityTree: () => tree,
  };
  return {
    ...base,
    calls,
    async setFieldValue(ref: string, value: string) {
      calls.push({ ref, value });
    },
  };
}

/**
 * SR OneClick shaped fixture pared down to the identity block. Enough to
 * exercise every classifier branch and every fact path.
 */
function srIdentityFixture(): RawAccessibilityNode {
  return {
    role: "form",
    name: "Application",
    ref: "form_root",
    children: [
      { role: "textbox", name: "First name", required: true, ref: "field_first_name" },
      { role: "textbox", name: "Last name", required: true, ref: "field_last_name" },
      { role: "textbox", name: "Email address", required: true, ref: "field_email" },
      { role: "textbox", name: "Phone number", required: false, ref: "field_phone" },
      { role: "textbox", name: "City", required: false, ref: "field_city" },
      { role: "textbox", name: "State / Province", required: false, ref: "field_state" },
      { role: "textbox", name: "Country", required: false, ref: "field_country" },
      { role: "textbox", name: "Postal code", required: false, ref: "field_postal" },
      // A field with a label the classifier does not know. Should skip
      // with `no_label_match`.
      {
        role: "textbox",
        name: "How did you hear about us?",
        required: false,
        ref: "field_referral",
      },
      // A field whose label the classifier would match to `firstName` but
      // whose surrounding text names an employer. The exclusion list has
      // to refuse to write here.
      {
        role: "textbox",
        name: "First name of your previous employer contact",
        required: false,
        ref: "field_ref_first_name",
      },
      // A field whose label matches an employment date pattern.
      {
        role: "textbox",
        name: "Employment start date",
        required: false,
        ref: "field_start_date",
      },
      // A degree field. Excluded whether or not the classifier matches it.
      {
        role: "textbox",
        name: "Degree",
        required: false,
        ref: "field_degree",
      },
      // A school field. Same.
      {
        role: "textbox",
        name: "University",
        required: false,
        ref: "field_school",
      },
    ],
  };
}

/**
 * Build a fact catalog with entries at the paths `FACT_PATHS_FOR_SLOT`
 * lists as the first (canonical) path for each slot.
 */
function buildCatalog(): FactCatalog {
  const defaults: Record<string, string> = {
    "profile.first_name": "Ada",
    "profile.last_name": "Lovelace",
    "profile.email": "ada@example.test",
    "profile.phone": "+14155551212",
    "profile.current_city": "San Francisco",
    "profile.current_state": "CA",
    "profile.current_country": "United States",
    "profile.postal_code": "94103",
  };
  const entries: FactEntry[] = Object.entries(defaults).map(([path, value]) => ({
    path,
    label: path,
    value,
    source: "profile",
  }));
  return { userId: "user-fixture", entries };
}

describe("classifyPrefillSlot", () => {
  it("routes each SR identity label to the expected slot", () => {
    const cases: Array<[string, PrefillSlot]> = [
      ["First name", "firstName"],
      ["Last name", "lastName"],
      ["Email address", "email"],
      ["Phone number", "phone"],
      ["City", "city"],
      ["State / Province", "currentState"],
      ["Country", "currentCountry"],
      ["Postal code", "postalCode"],
      ["ZIP", "postalCode"],
      ["LinkedIn profile", "linkedin"],
      ["Personal website", "website"],
    ];
    for (const [label, slot] of cases) {
      expect(classifyPrefillSlot(label), label).toBe(slot);
    }
  });

  it("returns null for labels no pattern matches", () => {
    expect(classifyPrefillSlot("How did you hear about us?")).toBeNull();
    expect(classifyPrefillSlot("")).toBeNull();
    expect(classifyPrefillSlot("Cover letter")).toBeNull();
  });

  it("returns null for a 'Confirm email' style label so the walker never re fills it as `email`", () => {
    // The plain `email` regex would match the "email" substring inside
    // "Confirm email"; the classifier's pre-filter has to reject it so
    // prefill's deliberate exclusion of `confirmEmail` from
    // `PREFILL_SLOT_ORDER` actually holds on the page.
    expect(classifyPrefillSlot("Confirm email")).toBeNull();
    expect(classifyPrefillSlot("Confirm your email")).toBeNull();
    expect(classifyPrefillSlot("Re-enter email")).toBeNull();
    expect(classifyPrefillSlot("Repeat email address")).toBeNull();
    expect(classifyPrefillSlot("Verify email")).toBeNull();
  });
});

describe("isExcludedLabel", () => {
  it("refuses employer, employment date, education institution, and degree labels", () => {
    expect(isExcludedLabel("Previous employer")).toBe(true);
    expect(isExcludedLabel("Company name")).toBe(true);
    expect(isExcludedLabel("Employment start date")).toBe(true);
    expect(isExcludedLabel("End date")).toBe(true);
    expect(isExcludedLabel("University")).toBe(true);
    expect(isExcludedLabel("School")).toBe(true);
    expect(isExcludedLabel("Degree")).toBe(true);
    expect(isExcludedLabel("Field of study")).toBe(true);
  });

  it("leaves identity labels alone", () => {
    expect(isExcludedLabel("First name")).toBe(false);
    expect(isExcludedLabel("City")).toBe(false);
    expect(isExcludedLabel("Postal code")).toBe(false);
  });

  it("refuses citizenship, nationality, country of birth and state of birth labels", () => {
    // These labels naively match the `\bcountry\b` and `\bstate\b`
    // patterns for the applicant's current address, but they collect
    // legally distinct facts. HARD STOP 9 makes the guard reject them
    // before the classifier can route them to `currentCountry` /
    // `currentState`.
    expect(isExcludedLabel("Country of citizenship")).toBe(true);
    expect(isExcludedLabel("Country of nationality")).toBe(true);
    expect(isExcludedLabel("Country of birth")).toBe(true);
    expect(isExcludedLabel("Country of origin")).toBe(true);
    expect(isExcludedLabel("State of birth")).toBe(true);
    expect(isExcludedLabel("State of origin")).toBe(true);
    expect(isExcludedLabel("Birthplace")).toBe(true);
    expect(isExcludedLabel("Nationality")).toBe(true);
  });
});

describe("deterministicPrefill", () => {
  it("fills every identity field the label map identifies from the fact catalog", async () => {
    const page = pageFromTree(
      "https://example.test/apply/sr-1",
      "Apply",
      srIdentityFixture()
    );
    const catalog = buildCatalog();
    const report = await deterministicPrefill(page, catalog);

    // Acceptance from the ticket body: at least 5 identity fields fill on
    // the SR fixture. In practice the fixture writes 8 (first, last, email,
    // phone, city, state, country, postal).
    expect(report.filled.length).toBeGreaterThanOrEqual(5);

    const filledByRef = new Map(report.filled.map((f) => [f.ref, f]));
    expect(filledByRef.get("field_first_name")?.value).toBe("Ada");
    expect(filledByRef.get("field_last_name")?.value).toBe("Lovelace");
    expect(filledByRef.get("field_email")?.value).toBe("ada@example.test");
    expect(filledByRef.get("field_phone")?.value).toBe("+14155551212");
    expect(filledByRef.get("field_city")?.value).toBe("San Francisco");
    expect(filledByRef.get("field_state")?.value).toBe("CA");
    expect(filledByRef.get("field_country")?.value).toBe("United States");
    expect(filledByRef.get("field_postal")?.value).toBe("94103");

    // Every filled field was actually written to the page.
    expect(page.calls).toHaveLength(report.filled.length);
    const callRefs = new Set(page.calls.map((c) => c.ref));
    for (const filled of report.filled) {
      expect(callRefs.has(filled.ref)).toBe(true);
    }

    // `factPath` on every filled entry names the exact path the catalog was
    // seeded at. Preserving this shape is what lets the trace log audit a
    // fill back to a real answer without a second lookup.
    for (const filled of report.filled) {
      expect(filled.factPath.startsWith("profile.")).toBe(true);
    }

    // No errors on a happy path fixture.
    expect(report.errors).toEqual([]);
  });

  it("skips labels no pattern matches with a specific reason", async () => {
    const page = pageFromTree(
      "https://example.test/apply/sr-1",
      "Apply",
      srIdentityFixture()
    );
    const catalog = buildCatalog();
    const report = await deterministicPrefill(page, catalog);
    const referral = report.skipped.find((s) => s.ref === "field_referral");
    expect(referral?.reason).toBe("no_label_match");
    expect(referral?.slot).toBeNull();
  });

  it("skips excluded labels even when they classify to a known slot", async () => {
    const page = pageFromTree(
      "https://example.test/apply/sr-1",
      "Apply",
      srIdentityFixture()
    );
    const catalog = buildCatalog();
    const report = await deterministicPrefill(page, catalog);

    for (const ref of [
      "field_ref_first_name",
      "field_start_date",
      "field_school",
      "field_degree",
    ]) {
      const skipped = report.skipped.find((s) => s.ref === ref);
      expect(skipped?.reason, ref).toBe("excluded_label");
    }

    // And critically, none of the excluded refs were actually written.
    const callRefs = new Set(page.calls.map((c) => c.ref));
    expect(callRefs.has("field_ref_first_name")).toBe(false);
    expect(callRefs.has("field_start_date")).toBe(false);
    expect(callRefs.has("field_school")).toBe(false);
    expect(callRefs.has("field_degree")).toBe(false);
  });

  it("refuses to fill a 'Confirm email' box even when the classifier would have written the same address", async () => {
    // Regression for the MAJOR from the JOB-280 red team: the plain `email`
    // regex matched the "email" substring inside "Confirm email", the
    // walker classified it as `email`, and the module's stated reason for
    // excluding `confirmEmail` from `PREFILL_SLOT_ORDER` was silently
    // nullified. The classifier's pre-filter must return null so the
    // walker skips with `no_label_match` and never writes to the ref.
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        { role: "textbox", name: "Email address", required: true, ref: "field_email" },
        {
          role: "textbox",
          name: "Confirm email",
          required: true,
          ref: "field_email_confirm",
        },
      ],
    };
    const page = pageFromTree("https://example.test/apply/confirm-email", "Apply", tree);
    const report = await deterministicPrefill(page, buildCatalog());
    // Primary email still fills.
    expect(report.filled.find((f) => f.ref === "field_email")?.value).toBe(
      "ada@example.test"
    );
    // Confirm email is never written to.
    expect(page.calls.some((c) => c.ref === "field_email_confirm")).toBe(false);
    // And the report records the skip with the "no label match" reason,
    // since the classifier's pre-filter rejects the label before any
    // pattern in `PREFILL_SLOT_ORDER` runs.
    const skip = report.skipped.find((s) => s.ref === "field_email_confirm");
    expect(skip?.reason).toBe("no_label_match");
    expect(skip?.slot).toBeNull();
  });

  it("refuses to fill 'Country of citizenship' and 'State of birth' with the applicant's current address", async () => {
    // Regression for the MAJOR from the JOB-280 red team: the plain
    // `\bcountry\b` and `\bstate\b` patterns for the applicant's current
    // address happily matched these labels, and prefill wrote
    // `profile.current_country` and `profile.current_state` into legally
    // distinct fields. HARD STOP 9 makes that a refusal, not a best guess.
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        { role: "textbox", name: "City", required: false, ref: "field_city" },
        {
          role: "textbox",
          name: "Country of citizenship",
          required: false,
          ref: "field_country_citizen",
        },
        {
          role: "textbox",
          name: "Country of birth",
          required: false,
          ref: "field_country_birth",
        },
        {
          role: "textbox",
          name: "Country of nationality",
          required: false,
          ref: "field_country_nat",
        },
        {
          role: "textbox",
          name: "State of birth",
          required: false,
          ref: "field_state_birth",
        },
        {
          role: "textbox",
          name: "Birthplace",
          required: false,
          ref: "field_birthplace",
        },
      ],
    };
    const page = pageFromTree(
      "https://example.test/apply/legally-distinct",
      "Apply",
      tree
    );
    const report = await deterministicPrefill(page, buildCatalog());
    // The applicant's plain city still fills.
    expect(report.filled.find((f) => f.ref === "field_city")?.value).toBe(
      "San Francisco"
    );
    // Every legally distinct country / state / birthplace field is skipped
    // as `excluded_label`, and none of them is written to.
    for (const ref of [
      "field_country_citizen",
      "field_country_birth",
      "field_country_nat",
      "field_state_birth",
      "field_birthplace",
    ]) {
      const skip = report.skipped.find((s) => s.ref === ref);
      expect(skip?.reason, ref).toBe("excluded_label");
      expect(page.calls.some((c) => c.ref === ref), ref).toBe(false);
    }
  });

  it("skips a field whose slot has no fact catalog entry", async () => {
    // Seed a catalog that is missing the phone number.
    const page = pageFromTree(
      "https://example.test/apply/sr-1",
      "Apply",
      srIdentityFixture()
    );
    const partial = buildCatalog();
    const withoutPhone: FactCatalog = {
      userId: partial.userId,
      entries: partial.entries.filter((e) => e.path !== "profile.phone"),
    };
    const report = await deterministicPrefill(page, withoutPhone);
    const phone = report.skipped.find((s) => s.ref === "field_phone");
    expect(phone?.reason).toBe("no_fact_for_slot");
    expect(phone?.slot).toBe("phone");
  });

  it("emits `empty_fact_value` when the fact catalog knows the slot but holds a blank answer", async () => {
    // Regression for the MINOR from the JOB-280 red team: the
    // `empty_fact_value` reason was in the closed union but nothing emitted
    // it, since `resolveSlotValue` collapsed a blank entry into the same
    // return shape as a missing one. Splitting the two lets the trace log
    // distinguish "the person did not answer the intake question" (a
    // chance to prompt intake for the answer) from "no fact catalog path
    // for this slot resolved at all" (a chance to revisit the path list).
    const page = pageFromTree(
      "https://example.test/apply/sr-1",
      "Apply",
      srIdentityFixture()
    );
    const catalogWithBlankPhone: FactCatalog = {
      userId: "user-fixture",
      entries: [
        { path: "profile.first_name", label: "profile.first_name", value: "Ada", source: "profile" },
        { path: "profile.last_name", label: "profile.last_name", value: "Lovelace", source: "profile" },
        { path: "profile.email", label: "profile.email", value: "ada@example.test", source: "profile" },
        // Phone: catalog holds the path but the answer is a whitespace only string.
        { path: "profile.phone", label: "profile.phone", value: "   ", source: "profile" },
      ],
    };
    const report = await deterministicPrefill(page, catalogWithBlankPhone);
    const phone = report.skipped.find((s) => s.ref === "field_phone");
    expect(phone?.reason).toBe("empty_fact_value");
    expect(phone?.slot).toBe("phone");
    // Phone was not written to the page.
    expect(page.calls.some((c) => c.ref === "field_phone")).toBe(false);
  });

  it("skips a field the page already carries the same value on", async () => {
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        {
          role: "textbox",
          name: "First name",
          required: true,
          ref: "field_first_name",
          value: "Ada",
        },
      ],
    };
    const page = pageFromTree("https://example.test/apply/sr-1", "Apply", tree);
    const report = await deterministicPrefill(page, buildCatalog());
    expect(report.filled).toEqual([]);
    const skipped = report.skipped.find((s) => s.ref === "field_first_name");
    expect(skipped?.reason).toBe("already_filled");
    expect(page.calls).toEqual([]);
  });

  it("captures a per field write failure on the report and continues", async () => {
    const tree = srIdentityFixture();
    const base = pageFromTree("https://example.test/apply/sr-1", "Apply", tree);
    const rejectingPage: PrefillPage & typeof base = {
      ...base,
      async setFieldValue(ref: string, value: string) {
        if (ref === "field_email") {
          throw new Error("simulated rejection");
        }
        base.calls.push({ ref, value });
      },
    };
    const report: PrefillReport = await deterministicPrefill(
      rejectingPage,
      buildCatalog()
    );
    // Email is on `errors`, everything else still filled.
    const emailError = report.errors.find((e) => e.ref === "field_email");
    expect(emailError?.message).toBe("simulated rejection");
    expect(emailError?.slot).toBe("email");
    expect(emailError?.factPath).toBe("profile.email");
    // A rejected write does not appear on `filled`.
    expect(report.filled.find((f) => f.ref === "field_email")).toBeUndefined();
    // And the other identity fields did land, so the loop still starts from
    // a shrunken surface rather than none at all.
    expect(report.filled.length).toBeGreaterThanOrEqual(5);
  });

  it("accepts a pre built snapshot rather than walking the a11y tree twice", async () => {
    const page = pageFromTree(
      "https://example.test/apply/sr-1",
      "Apply",
      srIdentityFixture()
    );
    // Import lazily so this test does not pull `readback` on module load.
    const { buildFullSnapshot } = await import("@/lib/agent/readback");
    const snapshot = await buildFullSnapshot(page);
    const report = await deterministicPrefill(page, buildCatalog(), { snapshot });
    expect(report.filled.length).toBeGreaterThanOrEqual(5);
  });
});
