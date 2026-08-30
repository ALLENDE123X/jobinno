/**
 * JOB-279 (sub ticket B). Cases for the snapshot module. The fixtures below
 * stand in for the raw accessibility trees Stagehand hands to
 * `buildFullSnapshot` in production. They are shaped to exercise the moves
 * the diff has to handle turn to turn on real boards:
 *
 *   - a text field the agent typed into (one `updated` entry, no `added`,
 *     no `removed`)
 *   - a repeating section modal opening (a picker closes, a modal opens,
 *     with the corresponding field level `added` / `removed`)
 *   - the byte budget check the whole file exists to enforce
 */

import { describe, expect, it } from "vitest";

import {
  buildDiffSnapshot,
  buildFullSnapshot,
  SNAPSHOT_MAX_BYTES,
  SnapshotBudgetExceededError,
  type AgentSnapshotSource,
  type RawAccessibilityNode,
} from "@/lib/agent/readback";

/**
 * Minimal `AgentSnapshotSource` around a static a11y tree. Every call
 * returns the value at fixture construction time, so tests can assert both
 * a first snapshot and a diff against a later tree simply by swapping the
 * `tree` on a wrapper reference.
 */
function pageFromTree(
  url: string,
  title: string,
  tree: RawAccessibilityNode
): AgentSnapshotSource {
  return {
    url: () => url,
    title: () => title,
    captureAccessibilityTree: () => tree,
  };
}

/**
 * Fixture modeled on the SR OneClick apply page shape from JOB-SPIKE v9,
 * pared down to the field count a mid weight page carries. Enough to prove
 * the snapshot parses a realistic tree and fits under the byte budget,
 * without shipping a fake 83K node payload the test would have to load.
 */
function srOneClickFixture(): RawAccessibilityNode {
  const basics: RawAccessibilityNode = {
    role: "form",
    name: "Basics",
    ref: "section_basics",
    children: [
      {
        role: "textbox",
        name: "First name",
        required: true,
        ref: "field_first_name",
      },
      {
        role: "textbox",
        name: "Last name",
        required: true,
        ref: "field_last_name",
      },
      {
        role: "textbox",
        name: "Email address",
        required: true,
        ref: "field_email",
      },
      {
        role: "textbox",
        name: "Phone",
        required: false,
        ref: "field_phone",
      },
      {
        role: "combobox",
        name: "Country",
        required: true,
        options: Array.from({ length: 40 }, (_, i) => `Country ${i}`),
        ref: "field_country",
      },
      {
        role: "checkbox",
        name: "Willing to relocate",
        required: false,
        ref: "field_relocate",
      },
    ],
  };
  const experience: RawAccessibilityNode = {
    role: "group",
    name: "Experience",
    ref: "section_experience",
    children: [
      {
        role: "button",
        name: "Add experience",
        ref: "field_add_experience",
      },
    ],
  };
  return {
    role: "form",
    name: "Application",
    ref: "form_root",
    children: [
      { role: "heading", name: "Software Engineer, Intern" },
      { role: "paragraph", name: "About this role" },
      basics,
      experience,
    ],
  };
}

describe("buildFullSnapshot", () => {
  it("parses a realistic mid weight page under the byte budget", async () => {
    const page = pageFromTree(
      "https://example.test/apply/sr-1",
      "Apply",
      srOneClickFixture()
    );
    const snapshot = await buildFullSnapshot(page, { now: () => 1 });

    expect(snapshot.url).toBe("https://example.test/apply/sr-1");
    expect(snapshot.title).toBe("Apply");
    expect(snapshot.capturedAt).toBe(1);

    // Every field in the fixture is represented, plus the two containers.
    const refs = snapshot.fields.map((f) => f.ref);
    expect(refs).toContain("field_email");
    expect(refs).toContain("field_country");
    expect(refs).toContain("section_basics");
    expect(refs).toContain("section_experience");
    // Static heading and paragraph rows are dropped by the walk.
    expect(refs.find((r) => r.startsWith("synth_heading"))).toBeUndefined();

    // Byte budget: assert the encoded snapshot fits with real headroom.
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    expect(bytes).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
  });

  it("classifies textbox fields to a specific kind from the label", async () => {
    const page = pageFromTree(
      "https://example.test/apply/sr-1",
      "Apply",
      srOneClickFixture()
    );
    const snapshot = await buildFullSnapshot(page);
    const email = snapshot.fields.find((f) => f.ref === "field_email");
    const phone = snapshot.fields.find((f) => f.ref === "field_phone");
    const firstName = snapshot.fields.find((f) => f.ref === "field_first_name");
    expect(email?.kind).toBe("email");
    expect(phone?.kind).toBe("tel");
    // A plain first name textbox stays `text`, not misclassified.
    expect(firstName?.kind).toBe("text");
  });

  it("stores an option set hash rather than the raw option list", async () => {
    const page = pageFromTree(
      "https://example.test/apply/sr-1",
      "Apply",
      srOneClickFixture()
    );
    const snapshot = await buildFullSnapshot(page);
    const country = snapshot.fields.find((f) => f.ref === "field_country");
    expect(country?.optionSetHash).toMatch(/^[a-f0-9]{16}$/);
    // The 40 option strings themselves must not ride on the field.
    expect(JSON.stringify(country)).not.toContain("Country 0");
  });

  it("throws SnapshotBudgetExceededError when the snapshot exceeds the limit", async () => {
    // Build a tree with enough distinct textbox fields to blow a small
    // custom budget. Using a low `maxBytes` on a known good fixture proves
    // the guard fires, without needing to load a fake 83K node fixture.
    const fields: RawAccessibilityNode[] = Array.from(
      { length: 400 },
      (_, i) => ({
        role: "textbox",
        name: `Field with a rather verbose label number ${i}`,
        required: false,
        ref: `field_${i}`,
      })
    );
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Big",
      ref: "form_big",
      children: fields,
    };
    const page = pageFromTree("https://example.test/big", "Big", tree);
    await expect(
      buildFullSnapshot(page, { maxBytes: 2_000 })
    ).rejects.toBeInstanceOf(SnapshotBudgetExceededError);
  });

  it("real budget catches an over budget fixture even at production limits", async () => {
    // Same idea, but hits `SNAPSHOT_MAX_BYTES` itself rather than a scaled
    // down budget: 4 000 fields on a chatty label. Guards against a future
    // change to the budget silently making this test moot.
    const fields: RawAccessibilityNode[] = Array.from(
      { length: 4_000 },
      (_, i) => ({
        role: "textbox",
        name: `Very verbose label describing field number ${i}`,
        required: false,
        ref: `field_${i}`,
      })
    );
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Huge",
      ref: "form_huge",
      children: fields,
    };
    const page = pageFromTree("https://example.test/huge", "Huge", tree);
    await expect(buildFullSnapshot(page)).rejects.toBeInstanceOf(
      SnapshotBudgetExceededError
    );
  });
});

describe("buildDiffSnapshot", () => {
  it("returns exactly one updated entry when a text field gains a value", async () => {
    const before = srOneClickFixture();
    const page1 = pageFromTree("https://example.test/apply/sr-1", "Apply", before);
    const prev = await buildFullSnapshot(page1, { now: () => 10 });

    // Simulate the agent having typed into the email field.
    const after = srOneClickFixture();
    const email = (after.children ?? [])
      .find((c) => c.ref === "section_basics")!
      .children!.find((c) => c.ref === "field_email")!;
    email.value = "person@example.test";

    const page2 = pageFromTree("https://example.test/apply/sr-1", "Apply", after);
    const diff = await buildDiffSnapshot(prev, page2, { now: () => 20 });

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.updated).toHaveLength(1);
    expect(diff.updated[0].ref).toBe("field_email");
    expect(diff.updated[0].before.value).toBeNull();
    expect(diff.updated[0].after.value).toBe("person@example.test");
    expect(diff.capturedAt).toBe(20);
    // Regression: before the JOB-279 iteration on PR #286, the section
    // hash folded in every descendant `value`, so typing into one field
    // flipped every ancestor section's hash and pushed those sections
    // back into `sections.changed`. The hash now covers only the static
    // subtree shape, so a value change does not flap the section list.
    expect(diff.sections.added).toHaveLength(0);
    expect(diff.sections.removed).toHaveLength(0);
    expect(diff.sections.changed).toHaveLength(0);
  });

  it("returns added for a new modal and removed for a closed picker", async () => {
    // Before: an "Add experience" button is visible (a picker style trigger).
    const before = srOneClickFixture();
    const page1 = pageFromTree("https://example.test/apply/sr-1", "Apply", before);
    const prev = await buildFullSnapshot(page1);

    // After: the picker button is gone and a modal has opened with two
    // fields inside. This is the exact shape a click on Add on Experience
    // takes on Greenhouse and SR OneClick.
    const after: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        (before.children ?? [])[2], // basics section, unchanged
        {
          role: "group",
          name: "Experience",
          ref: "section_experience",
          // Add experience button removed.
          children: [],
        },
        {
          role: "dialog",
          name: "New experience",
          ref: "section_experience_modal",
          children: [
            {
              role: "textbox",
              name: "Company",
              required: true,
              ref: "field_exp_company",
            },
            {
              role: "textbox",
              name: "Title",
              required: true,
              ref: "field_exp_title",
            },
          ],
        },
      ],
    };
    const page2 = pageFromTree("https://example.test/apply/sr-1", "Apply", after);
    const diff = await buildDiffSnapshot(prev, page2);

    const addedRefs = diff.added.map((f) => f.ref);
    expect(addedRefs).toContain("section_experience_modal");
    expect(addedRefs).toContain("field_exp_company");
    expect(addedRefs).toContain("field_exp_title");
    expect(diff.removed).toContain("field_add_experience");
    // Section level moves also visible.
    const sectionAddedRefs = diff.sections.added.map((s) => s.ref);
    expect(sectionAddedRefs).toContain("section_experience_modal");
  });

  it("does not surface a field whose only change is optionSetHash noise", async () => {
    const before = srOneClickFixture();
    const page1 = pageFromTree("https://example.test/apply/sr-1", "Apply", before);
    const prev = await buildFullSnapshot(page1);

    const after = srOneClickFixture();
    const country = (after.children ?? [])
      .find((c) => c.ref === "section_basics")!
      .children!.find((c) => c.ref === "field_country")!;
    // Options list rewritten (order shuffled) but the value is unchanged.
    country.options = Array.from({ length: 40 }, (_, i) => `Country ${39 - i}`);

    const page2 = pageFromTree("https://example.test/apply/sr-1", "Apply", after);
    const diff = await buildDiffSnapshot(prev, page2);

    // Value equality gate prevents an optionSetHash change from flapping
    // the diff turn to turn. The section walk still hashes the region, so
    // an interested caller can find the change through `diff.sections.changed`.
    expect(diff.updated.find((u) => u.ref === "field_country")).toBeUndefined();
  });

  it("mounting a refless node earlier does not renumber unrelated refless siblings", async () => {
    // Regression for B3 in the PR #286 red team pass: the previous synth
    // formula used one monotonic counter for the whole walk, so a refless
    // node mounting earlier in the tree shifted every later synthesized
    // ref by one. That surfaced as spurious `added` + `removed` pairs for
    // fields that had not changed, inflating the exact payload the diff
    // exists to shrink. Under the per parent (role, label) index scheme
    // the fix installs, only the sibling group that actually gained a
    // node sees an index change.
    const before: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        {
          role: "textbox",
          name: "Free response A",
          required: false,
          // no ref: forces the synth path
        },
        {
          role: "textbox",
          name: "Free response B",
          required: false,
          // no ref: forces the synth path
        },
      ],
    };
    const page1 = pageFromTree("https://example.test/apply/sr-1", "Apply", before);
    const prev = await buildFullSnapshot(page1);
    const beforeRefs = prev.fields
      .filter((f) => f.label.startsWith("Free response"))
      .map((f) => f.ref);
    expect(beforeRefs).toHaveLength(2);

    // Insert a refless button earlier in the same parent. Under the old
    // monotonic counter this would renumber the two textboxes; under the
    // per (role, label) index scheme, only the (button, ...) sibling
    // group gets a fresh index, and the two textboxes keep their refs.
    const after: RawAccessibilityNode = {
      role: "form",
      name: "Application",
      ref: "form_root",
      children: [
        {
          role: "button",
          name: "Click me",
          // no ref: this is the newly mounted refless node
        },
        ...(before.children ?? []),
      ],
    };
    const page2 = pageFromTree("https://example.test/apply/sr-1", "Apply", after);
    const diff = await buildDiffSnapshot(prev, page2);

    // The two textboxes must not appear as either `added` or `removed`;
    // that is the exact failure mode of the old formula.
    const addedLabels = diff.added.map((f) => f.label);
    expect(addedLabels).not.toContain("Free response A");
    expect(addedLabels).not.toContain("Free response B");
    // The `removed` list carries synth refs, so assert by looking up the
    // previous ref set instead of matching against labels.
    for (const ref of beforeRefs) {
      expect(diff.removed).not.toContain(ref);
    }
    // The refless button legitimately appears as added, and there is no
    // corresponding removal to pair it with.
    expect(diff.added.some((f) => f.label === "Click me")).toBe(true);
    expect(diff.updated).toHaveLength(0);
  });

  it("does not misclassify plain word labels as date, tel, or url", async () => {
    // Regression for M1 in the PR #286 red team pass: the previous
    // refine regexes were unanchored substrings, so labels like
    // "Candidate name" landed as `date`, "Automobile insurance" as
    // `tel`, and "Hyperlink" as `url`. Word boundaries pin each match
    // to whole vocabulary.
    const tree: RawAccessibilityNode = {
      role: "form",
      name: "Regressions",
      ref: "form_regressions",
      children: [
        { role: "textbox", name: "Candidate name", ref: "field_candidate_name" },
        { role: "textbox", name: "Mandate reference", ref: "field_mandate_reference" },
        { role: "textbox", name: "Update your profile", ref: "field_update_profile" },
        { role: "textbox", name: "Hyperlink description", ref: "field_hyperlink" },
        { role: "textbox", name: "Automobile insurance", ref: "field_automobile" },
      ],
    };
    const page = pageFromTree("https://example.test/regress", "Regress", tree);
    const snapshot = await buildFullSnapshot(page);
    const kindOf = (ref: string) =>
      snapshot.fields.find((f) => f.ref === ref)?.kind;
    expect(kindOf("field_candidate_name")).toBe("text");
    expect(kindOf("field_mandate_reference")).toBe("text");
    expect(kindOf("field_update_profile")).toBe("text");
    expect(kindOf("field_hyperlink")).toBe("text");
    expect(kindOf("field_automobile")).toBe("text");
  });

  it("surfaces a section hash change through sections.changed", async () => {
    const before = srOneClickFixture();
    const page1 = pageFromTree("https://example.test/apply/sr-1", "Apply", before);
    const prev = await buildFullSnapshot(page1);

    // Rename a static text node inside the Basics section so the section
    // hash flips while the field list stays the same shape.
    const after = srOneClickFixture();
    const basics = (after.children ?? []).find(
      (c) => c.ref === "section_basics"
    )!;
    basics.children = [
      ...(basics.children ?? []),
      { role: "paragraph", name: "New helper text under Basics" },
    ];

    const page2 = pageFromTree("https://example.test/apply/sr-1", "Apply", after);
    const diff = await buildDiffSnapshot(prev, page2);

    const changedRefs = diff.sections.changed.map((s) => s.ref);
    expect(changedRefs).toContain("section_basics");
  });
});
