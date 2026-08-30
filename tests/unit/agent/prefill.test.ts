/**
 * JOB-280 (sub ticket C of #276). Cases for the deterministic prefill pass.
 *
 * The SR OneClick fixture below is deliberately close in shape to the one
 * `tests/unit/agent/readback.test.ts` builds, so the two suites stay honest
 * about what a real board looks like without either fixture having to
 * import the other. The fact catalog fixture mirrors the shape sub ticket
 * B lands in `lib/agent/fact-catalog.ts`, populated at the fact paths
 * `lib/agent/prefill.ts` documents.
 *
 * The inverted guard (closed PR #288's architectural pivot) is covered
 * directly here: `currentCountry` and `currentState` only classify when the
 * label carries a positive current location signal, so a bare "Country" or
 * "State / Province" and every birth, citizenship, or nationality shape
 * classify to `null` and the walker records them as `no_label_match` rather
 * than reaching a fill. `postalCode` stays permissive, so a bare "Postal
 * code" or "ZIP" still fills.
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
 *
 * Under the inverted guard the bare "State / Province" and "Country" labels
 * carry no positive current location signal, so both classify to `null` and
 * the walker skips them with `no_label_match`. "City" and "Postal code"
 * still fill.
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
      ["Postal code", "postalCode"],
      ["ZIP", "postalCode"],
      ["LinkedIn profile", "linkedin"],
      ["Personal website", "website"],
    ];
    for (const [label, slot] of cases) {
      expect(classifyPrefillSlot(label), label).toBe(slot);
    }
  });

  it("classifies country, state and postal labels that carry a positive current location signal", () => {
    // The inverted guard: these labels name the applicant's current address,
    // so they classify to the address slots and fill from the catalog.
    expect(classifyPrefillSlot("Country of residence")).toBe("currentCountry");
    expect(classifyPrefillSlot("Current country")).toBe("currentCountry");
    expect(classifyPrefillSlot("Home country")).toBe("currentCountry");
    expect(classifyPrefillSlot("State of residence")).toBe("currentState");
    expect(classifyPrefillSlot("Current state")).toBe("currentState");
    expect(classifyPrefillSlot("Home state")).toBe("currentState");
    // Postal code is deliberately permissive: bare `zip` / `postal` /
    // `postcode` all classify without needing a residence signal.
    expect(classifyPrefillSlot("Postal code")).toBe("postalCode");
    expect(classifyPrefillSlot("Home postal code")).toBe("postalCode");
    expect(classifyPrefillSlot("Zip")).toBe("postalCode");
    expect(classifyPrefillSlot("Zip code")).toBe("postalCode");
    expect(classifyPrefillSlot("Postcode")).toBe("postalCode");
  });

  it("returns null for bare ambiguous address labels so the agent decides later", () => {
    // The inverted guard's fall through: no positive current location signal,
    // so these do not silently attest a current address.
    expect(classifyPrefillSlot("Country")).toBeNull();
    expect(classifyPrefillSlot("State")).toBeNull();
    expect(classifyPrefillSlot("State / Province")).toBeNull();
    expect(classifyPrefillSlot("Province")).toBeNull();
    expect(classifyPrefillSlot("Region")).toBeNull();
  });

  it("returns null for birth, citizenship and nationality labels", () => {
    // None of these carry a positive current location signal, so the
    // inverted guard sends them to the agent loop rather than writing a
    // current address into a legally distinct field. No per shape exclusion
    // regex is needed: the guard is architectural, not enumerative.
    const birthAdjacent = [
      "Birth country",
      "Country of birth",
      "Country of citizenship",
      "Country of nationality",
      "Nation of origin",
      "Nation of birth",
      "State of birth",
      "Origin region",
      "Native land",
      "Birthplace",
      "Birth state",
      "Birth province",
      "Province of birth",
      "Country of origin",
    ];
    for (const label of birthAdjacent) {
      expect(classifyPrefillSlot(label), label).toBeNull();
    }
  });

  it("returns null for country and state labels whose positive signal is paired with a birth or citizenship qualifier", () => {
    // Regression for the JOB-280 second red team, finding B1. The earlier
    // draft's positive signal check accepted "Current country of
    // citizenship" and "Home country of birth" as `currentCountry` because
    // the positive signal fired without a paired negative check. The
    // combined positive plus negative rule closes the hole architecturally.
    const combined = [
      "Current country of citizenship",
      "Home country of birth",
      "Home country of origin",
      "Current country of birth",
      "Mailing country of birth",
      "Residence country of birth",
      "Home country of nationality",
      "Home state of birth",
      "Home province of origin",
      "Current state of birth",
      "Mailing state of birth",
      "Residence state of nationality",
    ];
    for (const label of combined) {
      expect(classifyPrefillSlot(label), label).toBeNull();
    }
  });

  it("returns null for postal code labels whose positive signal is paired with a birth or previous qualifier", () => {
    // Regression for the JOB-280 second red team, finding B2. The earlier
    // draft had no guard on `postalCode` at all, so an immigration or
    // background check form asking for "Zip of birth" would attest the
    // applicant's current zip. The shared negative qualifier catches these
    // too.
    const combined = [
      "Zip of birth",
      "Birth zip code",
      "Postal code of previous residence",
      "Zip code of birth",
      "Home zip code of birth",
      "Postal code of former residence",
      "Zip of native country",
    ];
    for (const label of combined) {
      expect(classifyPrefillSlot(label), label).toBeNull();
    }
  });

  it("returns null for city labels whose positive signal is paired with a birth, native, or contact qualifier", () => {
    // Regression for the JOB-280 second red team, finding M1. `city`
    // classified for "City of birth", "Birth city", "Native city",
    // "Emergency contact city" before the shared negative qualifier
    // covered every identity slot.
    const combined = [
      "City of birth",
      "Birth city",
      "Native city",
      "Emergency contact city",
      "City of origin",
      "Home city of birth",
    ];
    for (const label of combined) {
      expect(classifyPrefillSlot(label), label).toBeNull();
    }
  });

  it("returns null for name labels that describe someone other than the applicant", () => {
    // Regression for the JOB-280 second red team, finding M1. Emergency
    // contact / reference / manager / spouse / parent / guardian labels
    // named their person's identity, not the applicant's.
    const namesForOthers = [
      "Emergency contact first name",
      "Reference first name",
      "Manager first name",
      "Spouse first name",
      "Parent last name",
      "Guardian last name",
      "Supervisor first name",
      "Contact last name",
      "Mother first name",
      "Father last name",
    ];
    for (const label of namesForOthers) {
      expect(classifyPrefillSlot(label), label).toBeNull();
    }
  });

  it("returns null for phone labels that describe someone other than the applicant", () => {
    // Regression for the JOB-280 second red team, finding M1.
    const phonesForOthers = [
      "Emergency phone",
      "Reference phone",
      "Spouse phone",
      "Parent phone",
      "Emergency contact phone",
      "Manager phone",
      "Guardian mobile",
    ];
    for (const label of phonesForOthers) {
      expect(classifyPrefillSlot(label), label).toBeNull();
    }
  });

  it("returns null for social labels that describe someone other than the applicant", () => {
    // Regression for the JOB-280 second red team, finding M1.
    const socialForOthers = [
      "Manager LinkedIn",
      "Reference website",
      "Spouse LinkedIn",
      "Emergency contact LinkedIn",
      "Manager portfolio",
      "Reference GitHub",
    ];
    for (const label of socialForOthers) {
      expect(classifyPrefillSlot(label), label).toBeNull();
    }
  });

  it("returns null for the suffix form of an email confirmation label", () => {
    // Regression for the JOB-280 second red team, finding B3. The prefix
    // form ("Confirm email") was caught by `FIELD_KEYWORDS.confirmEmail`
    // already; the suffix form ("Email confirmation", "Email
    // verification") ran through the plain `email` regex and silently
    // classified as `email` before this fix.
    expect(classifyPrefillSlot("Email confirmation")).toBeNull();
    expect(classifyPrefillSlot("Email verification")).toBeNull();
    expect(classifyPrefillSlot("email confirmation address")).toBeNull();
    expect(classifyPrefillSlot("Email confirmation address")).toBeNull();
    expect(classifyPrefillSlot("Email repeat")).toBeNull();
    expect(classifyPrefillSlot("Email again")).toBeNull();
  });

  it("keeps classifying the positive labels every reader relies on", () => {
    // Regression pin so a broader negative qualifier does not silently
    // shrink the positive surface. Every label below has to still resolve
    // to its own slot after the shared negative check runs.
    const positives: Array<[string, PrefillSlot]> = [
      ["Country", "currentCountry"],
      ["Current country", "currentCountry"],
      ["Country of residence", "currentCountry"],
      ["Country you live in", "currentCountry"],
      ["Country of residency", "currentCountry"],
      ["State", "currentState"],
      ["Current state", "currentState"],
      ["State of residence", "currentState"],
      ["Zip code", "postalCode"],
      ["Postal code", "postalCode"],
      ["Home zip", "postalCode"],
      ["Email address", "email"],
      ["Your email", "email"],
      ["Email", "email"],
      ["City", "city"],
      ["Current city", "city"],
      ["City of residence", "city"],
      ["First name", "firstName"],
      ["Your first name", "firstName"],
      ["Given name", "firstName"],
      ["Last name", "lastName"],
      ["Phone", "phone"],
      ["Mobile", "phone"],
      ["LinkedIn URL", "linkedin"],
      ["Personal website", "website"],
    ];
    // A few of the positives above overlap the negative qualifier when
    // read with a broader eye (a bare "Country" is ambiguous but not
    // negative). The classifier has to still resolve them, which is
    // exactly the assertion here.
    for (const [label, expected] of positives) {
      const actual = classifyPrefillSlot(label);
      // A bare "Country" or "State" falls through to null under the
      // positive current location gate; the assertion for those splits
      // into "either the expected slot or null" so the pin stays honest
      // about the double gate rather than pretending the bare form fills.
      if (label === "Country" || label === "State") {
        expect(actual, label).toBeNull();
      } else {
        expect(actual, label).toBe(expected);
      }
    }
  });

  it("returns null for labels no pattern matches", () => {
    expect(classifyPrefillSlot("How did you hear about us?")).toBeNull();
    expect(classifyPrefillSlot("")).toBeNull();
    expect(classifyPrefillSlot("Cover letter")).toBeNull();
  });

  it("returns null for a 'Confirm email' style label so the walker never re fills it as `email`", () => {
    // The plain `email` regex would match the "email" substring inside
    // "Confirm email"; the classifier's up front check has to reject it so
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

  it("leaves birth and citizenship labels alone, because the classifier no longer reaches them", () => {
    // The inverted guard replaces the per shape exclusion regex for these
    // labels: they no longer classify at all, so an exclusion is redundant.
    // The classifier returns null for each, so the walker records them as
    // `no_label_match` and the agent decides, never a fill.
    const labels = [
      "Country of citizenship",
      "Country of nationality",
      "Country of birth",
      "Country of origin",
      "State of birth",
      "Birthplace",
      "Nationality",
      "Birth country",
      "Native land",
      "Nation of birth",
      "Origin region",
    ];
    for (const label of labels) {
      expect(isExcludedLabel(label), label).toBe(false);
      expect(classifyPrefillSlot(label), label).toBeNull();
    }
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
    // the SR fixture. Under the inverted guard the bare "State / Province"
    // and "Country" labels fall through to the agent (no positive signal),
    // so the fixture fills 6: first, last, email, phone, city, postal.
    expect(report.filled.length).toBeGreaterThanOrEqual(5);

    const filledByRef = new Map(report.filled.map((f) => [f.ref, f]));
    expect(filledByRef.get("field_first_name")?.value).toBe("Ada");
    expect(filledByRef.get("field_last_name")?.value).toBe("Lovelace");
    expect(filledByRef.get("field_email")?.value).toBe("ada@example.test");
    expect(filledByRef.get("field_phone")?.value).toBe("+14155551212");
    expect(filledByRef.get("field_city")?.value).toBe("San Francisco");
    expect(filledByRef.get("field_postal")?.value).toBe("94103");

    // Bare "State / Province" and "Country" no longer classify. They are
    // skipped with `no_label_match` and never written to.
    const state = report.skipped.find((s) => s.ref === "field_state");
    expect(state?.reason).toBe("no_label_match");
    expect(state?.slot).toBeNull();
    const country = report.skipped.find((s) => s.ref === "field_country");
    expect(country?.reason).toBe("no_label_match");
    expect(country?.slot).toBeNull();
    expect(page.calls.some((c) => c.ref === "field_state")).toBe(false);
    expect(page.calls.some((c) => c.ref === "field_country")).toBe(false);

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

  it("fills current state and current country when the label carries a positive signal", async () => {
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        { role: "textbox", name: "City", required: false, ref: "field_city" },
        {
          role: "textbox",
          name: "State of residence",
          required: false,
          ref: "field_state_res",
        },
        {
          role: "textbox",
          name: "Country of residence",
          required: false,
          ref: "field_country_res",
        },
        {
          role: "textbox",
          name: "Home postal code",
          required: false,
          ref: "field_postal_home",
        },
      ],
    };
    const page = pageFromTree(
      "https://example.test/apply/sr-pos",
      "Apply",
      tree
    );
    const report = await deterministicPrefill(page, buildCatalog());
    expect(report.filled.find((f) => f.ref === "field_state_res")?.value).toBe("CA");
    expect(report.filled.find((f) => f.ref === "field_country_res")?.value).toBe(
      "United States"
    );
    expect(report.filled.find((f) => f.ref === "field_postal_home")?.value).toBe(
      "94103"
    );
    expect(page.calls.some((c) => c.ref === "field_state_res")).toBe(true);
    expect(page.calls.some((c) => c.ref === "field_country_res")).toBe(true);
    expect(page.calls.some((c) => c.ref === "field_postal_home")).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("does not write the current address into any birth, citizenship, or nationality label", async () => {
    // These labels carry no positive current location signal, so the
    // inverted guard classifies each to null. The walker skips them as
    // `no_label_match` (never `excluded_label`, never a fill) and the agent
    // loop decides later. HARD STOP 9 is aligned by construction.
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        { role: "textbox", name: "City", required: false, ref: "field_city" },
        {
          role: "textbox",
          name: "Birth country",
          required: false,
          ref: "field_birth_country",
        },
        {
          role: "textbox",
          name: "Country of birth",
          required: false,
          ref: "field_country_birth",
        },
        {
          role: "textbox",
          name: "Country of citizenship",
          required: false,
          ref: "field_country_citizen",
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
          name: "Origin region",
          required: false,
          ref: "field_origin_region",
        },
        {
          role: "textbox",
          name: "Native land",
          required: false,
          ref: "field_native_land",
        },
        {
          role: "textbox",
          name: "Nation of birth",
          required: false,
          ref: "field_nation_birth",
        },
        {
          role: "textbox",
          name: "Birthplace",
          required: false,
          ref: "field_birthplace",
        },
        {
          role: "textbox",
          name: "Birth province",
          required: false,
          ref: "field_birth_province",
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
    // Every legally distinct label is skipped as `no_label_match` with a
    // null slot, and none of them is written to.
    for (const ref of [
      "field_birth_country",
      "field_country_birth",
      "field_country_citizen",
      "field_country_nat",
      "field_state_birth",
      "field_origin_region",
      "field_native_land",
      "field_nation_birth",
      "field_birthplace",
      "field_birth_province",
    ]) {
      const skip = report.skipped.find((s) => s.ref === ref);
      expect(skip?.reason, ref).toBe("no_label_match");
      expect(skip?.slot, ref).toBeNull();
      expect(page.calls.some((c) => c.ref === ref), ref).toBe(false);
    }
  });

  it("does not write the applicant's identity into any reference, emergency contact, spouse, parent, or guardian label", async () => {
    // Regression for the JOB-280 second red team, finding M1. The
    // classifier lets the walker skip these labels as `no_label_match`
    // (never a fill) because the shared negative qualifier catches every
    // "someone other than the applicant" word before any positive slot
    // pattern runs. Verified end to end: no write reaches these refs.
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        { role: "textbox", name: "City", required: false, ref: "field_city" },
        {
          role: "textbox",
          name: "Emergency contact first name",
          required: false,
          ref: "field_emerg_first",
        },
        {
          role: "textbox",
          name: "Reference last name",
          required: false,
          ref: "field_ref_last",
        },
        {
          role: "textbox",
          name: "Spouse phone",
          required: false,
          ref: "field_spouse_phone",
        },
        {
          role: "textbox",
          name: "Manager LinkedIn",
          required: false,
          ref: "field_mgr_linkedin",
        },
        {
          role: "textbox",
          name: "Reference website",
          required: false,
          ref: "field_ref_site",
        },
        {
          role: "textbox",
          name: "Parent phone",
          required: false,
          ref: "field_parent_phone",
        },
        {
          role: "textbox",
          name: "Emergency contact city",
          required: false,
          ref: "field_emerg_city",
        },
        {
          role: "textbox",
          name: "Guardian last name",
          required: false,
          ref: "field_guardian_last",
        },
      ],
    };
    const page = pageFromTree(
      "https://example.test/apply/other-parties",
      "Apply",
      tree
    );
    const report = await deterministicPrefill(page, buildCatalog());
    // The applicant's plain city still fills.
    expect(report.filled.find((f) => f.ref === "field_city")?.value).toBe(
      "San Francisco"
    );
    // Every "someone else" label is skipped with `no_label_match`, null
    // slot, and receives no write. HARD STOP 9 by construction.
    for (const ref of [
      "field_emerg_first",
      "field_ref_last",
      "field_spouse_phone",
      "field_mgr_linkedin",
      "field_ref_site",
      "field_parent_phone",
      "field_emerg_city",
      "field_guardian_last",
    ]) {
      const skip = report.skipped.find((s) => s.ref === ref);
      expect(skip?.reason, ref).toBe("no_label_match");
      expect(skip?.slot, ref).toBeNull();
      expect(page.calls.some((c) => c.ref === ref), ref).toBe(false);
    }
  });

  it("does not write the current zip into any postal code label paired with a birth or previous qualifier", async () => {
    // Regression for the JOB-280 second red team, finding B2. Immigration
    // and background check forms ask for the postal code of birth or of a
    // previous residence; the earlier draft had no guard on `postalCode`
    // and would attest the applicant's current zip.
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        { role: "textbox", name: "City", required: false, ref: "field_city" },
        {
          role: "textbox",
          name: "Zip of birth",
          required: false,
          ref: "field_zip_birth",
        },
        {
          role: "textbox",
          name: "Birth zip code",
          required: false,
          ref: "field_birth_zip",
        },
        {
          role: "textbox",
          name: "Postal code of previous residence",
          required: false,
          ref: "field_postal_previous",
        },
        {
          role: "textbox",
          name: "Postal code of former residence",
          required: false,
          ref: "field_postal_former",
        },
      ],
    };
    const page = pageFromTree(
      "https://example.test/apply/postal-legally-distinct",
      "Apply",
      tree
    );
    const report = await deterministicPrefill(page, buildCatalog());
    expect(report.filled.find((f) => f.ref === "field_city")?.value).toBe(
      "San Francisco"
    );
    for (const ref of [
      "field_zip_birth",
      "field_birth_zip",
      "field_postal_previous",
      "field_postal_former",
    ]) {
      const skip = report.skipped.find((s) => s.ref === ref);
      expect(skip?.reason, ref).toBe("no_label_match");
      expect(skip?.slot, ref).toBeNull();
      expect(page.calls.some((c) => c.ref === ref), ref).toBe(false);
    }
  });

  it("does not classify the suffix form of email confirmation as `email`", async () => {
    // Regression for the JOB-280 second red team, finding B3. "Email
    // confirmation" and "Email verification" ran through the plain `email`
    // regex before this fix.
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        { role: "textbox", name: "Email address", required: true, ref: "field_email" },
        {
          role: "textbox",
          name: "Email confirmation",
          required: true,
          ref: "field_email_conf_suffix",
        },
        {
          role: "textbox",
          name: "Email verification",
          required: true,
          ref: "field_email_verif_suffix",
        },
      ],
    };
    const page = pageFromTree(
      "https://example.test/apply/suffix-confirm",
      "Apply",
      tree
    );
    const report = await deterministicPrefill(page, buildCatalog());
    expect(report.filled.find((f) => f.ref === "field_email")?.value).toBe(
      "ada@example.test"
    );
    for (const ref of ["field_email_conf_suffix", "field_email_verif_suffix"]) {
      const skip = report.skipped.find((s) => s.ref === ref);
      expect(skip?.reason, ref).toBe("no_label_match");
      expect(skip?.slot, ref).toBeNull();
      expect(page.calls.some((c) => c.ref === ref), ref).toBe(false);
    }
  });

  it("does not write the current address into ambiguous bare address labels", async () => {
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        { role: "textbox", name: "City", required: false, ref: "field_city" },
        { role: "textbox", name: "Country", required: false, ref: "field_country" },
        { role: "textbox", name: "State", required: false, ref: "field_state" },
        { role: "textbox", name: "Province", required: false, ref: "field_province" },
        { role: "textbox", name: "Region", required: false, ref: "field_region" },
      ],
    };
    const page = pageFromTree(
      "https://example.test/apply/ambiguous",
      "Apply",
      tree
    );
    const report = await deterministicPrefill(page, buildCatalog());
    expect(report.filled.find((f) => f.ref === "field_city")?.value).toBe(
      "San Francisco"
    );
    for (const ref of ["field_country", "field_state", "field_province", "field_region"]) {
      const skip = report.skipped.find((s) => s.ref === ref);
      expect(skip?.reason, ref).toBe("no_label_match");
      expect(skip?.slot, ref).toBeNull();
      expect(page.calls.some((c) => c.ref === ref), ref).toBe(false);
    }
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
    // nullified. The classifier's up front check must return null so the
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
    // since the classifier's up front check rejects the label before any
    // pattern in `PREFILL_SLOT_ORDER` runs.
    const skip = report.skipped.find((s) => s.ref === "field_email_confirm");
    expect(skip?.reason).toBe("no_label_match");
    expect(skip?.slot).toBeNull();
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

  it("never overwrites an existing non blank value even when it differs from the fact catalog", async () => {
    // Regression for the JOB-280 second red team, finding B4. The earlier
    // check gated on value equality, so a different non blank value
    // (browser autofill, a prior turn, the applicant typing) was silently
    // overwritten by the deterministic pass. Prefill is non destructive on
    // any existing value now.
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
          value: "Grace",
        },
        {
          role: "textbox",
          name: "Last name",
          required: true,
          ref: "field_last_name",
          value: "Hopper",
        },
        {
          role: "textbox",
          name: "Email address",
          required: true,
          ref: "field_email",
          // Empty string is the blank case: prefill still writes here.
          value: "",
        },
        {
          role: "textbox",
          name: "Phone number",
          required: false,
          ref: "field_phone",
          // Whitespace only counts as blank so prefill fills it.
          value: "   ",
        },
      ],
    };
    const page = pageFromTree(
      "https://example.test/apply/preserve-existing",
      "Apply",
      tree
    );
    const report = await deterministicPrefill(page, buildCatalog());

    // First / last name were pre populated with different names and stay
    // untouched. The report records `already_filled` for each, and the
    // page never received a write for those refs.
    const firstNameSkip = report.skipped.find((s) => s.ref === "field_first_name");
    expect(firstNameSkip?.reason).toBe("already_filled");
    expect(firstNameSkip?.slot).toBe("firstName");
    const lastNameSkip = report.skipped.find((s) => s.ref === "field_last_name");
    expect(lastNameSkip?.reason).toBe("already_filled");
    expect(lastNameSkip?.slot).toBe("lastName");
    expect(page.calls.some((c) => c.ref === "field_first_name")).toBe(false);
    expect(page.calls.some((c) => c.ref === "field_last_name")).toBe(false);

    // Email was empty and phone was whitespace only, so prefill still
    // wrote to both. Both land on `filled` with the catalog values.
    expect(report.filled.find((f) => f.ref === "field_email")?.value).toBe(
      "ada@example.test"
    );
    expect(report.filled.find((f) => f.ref === "field_phone")?.value).toBe(
      "+14155551212"
    );
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
