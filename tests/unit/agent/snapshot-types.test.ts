/**
 * JOB-279 (sub ticket B). Zod validation of the snapshot type shapes. These
 * schemas are the single canonical validator for every downstream sub
 * ticket; a shape drift landing here silently would surface as a runtime
 * parse error deep in the agent loop, which is exactly the failure mode
 * this file exists to prevent.
 */

import { describe, expect, it } from "vitest";

import {
  AgentSnapshotDiffSchema,
  AgentSnapshotSchema,
  FieldKindSchema,
  FieldNodeSchema,
  FieldValidationStateSchema,
  SectionHandleSchema,
} from "@/lib/agent/snapshot-types";

const validField = {
  ref: "field_1",
  kind: "email" as const,
  label: "Email address",
  value: "person@example.test",
  required: true,
  validation: { kind: "valid" as const },
  sectionRef: null,
  optionSetHash: null,
};

const validSection = {
  ref: "section_1",
  label: "Basics",
  hash: "abcdef0123456789",
};

describe("FieldKindSchema", () => {
  it("accepts every kind the parser can emit", () => {
    for (const kind of [
      "text",
      "email",
      "url",
      "tel",
      "number",
      "select",
      "checkbox",
      "radio",
      "date",
      "button",
      "section",
      "modal",
      "unknown",
    ]) {
      expect(() => FieldKindSchema.parse(kind)).not.toThrow();
    }
  });

  it("rejects strings outside the closed set", () => {
    expect(() => FieldKindSchema.parse("banner")).toThrow();
  });

  it("rejects kinds the parser cannot emit today", () => {
    // `textarea`, `multiselect`, and `file` were removed from the closed
    // set in the JOB-279 iteration on PR #286: the walk had no attribute
    // to distinguish them from `text`, `select`, and `unknown`, so leaving
    // them in would lock a shape no producer emits. Sub ticket E grows the
    // set when it grows the parser.
    for (const kind of ["textarea", "multiselect", "file"]) {
      expect(() => FieldKindSchema.parse(kind)).toThrow();
    }
  });
});

describe("FieldValidationStateSchema", () => {
  it("accepts valid and unknown without a message", () => {
    expect(() => FieldValidationStateSchema.parse({ kind: "valid" })).not.toThrow();
    expect(() =>
      FieldValidationStateSchema.parse({ kind: "unknown" })
    ).not.toThrow();
  });

  it("requires a non empty message on invalid", () => {
    expect(() =>
      FieldValidationStateSchema.parse({ kind: "invalid", message: "required" })
    ).not.toThrow();
    expect(() =>
      FieldValidationStateSchema.parse({ kind: "invalid", message: "" })
    ).toThrow();
    expect(() =>
      FieldValidationStateSchema.parse({ kind: "invalid" })
    ).toThrow();
  });
});

describe("FieldNodeSchema", () => {
  it("accepts a well formed field", () => {
    expect(() => FieldNodeSchema.parse(validField)).not.toThrow();
  });

  it("rejects an empty ref", () => {
    expect(() =>
      FieldNodeSchema.parse({ ...validField, ref: "" })
    ).toThrow();
  });

  it("allows a null value and a null sectionRef", () => {
    expect(() =>
      FieldNodeSchema.parse({
        ...validField,
        value: null,
        sectionRef: null,
        optionSetHash: null,
      })
    ).not.toThrow();
  });
});

describe("SectionHandleSchema", () => {
  it("accepts a well formed section handle", () => {
    expect(() => SectionHandleSchema.parse(validSection)).not.toThrow();
  });

  it("rejects an empty hash", () => {
    expect(() =>
      SectionHandleSchema.parse({ ...validSection, hash: "" })
    ).toThrow();
  });
});

describe("AgentSnapshotSchema", () => {
  it("accepts an empty page snapshot", () => {
    expect(() =>
      AgentSnapshotSchema.parse({
        url: "https://example.test/apply",
        title: "Apply",
        fields: [],
        sections: [],
        capturedAt: 0,
      })
    ).not.toThrow();
  });

  it("requires a non empty url", () => {
    expect(() =>
      AgentSnapshotSchema.parse({
        url: "",
        title: "",
        fields: [],
        sections: [],
        capturedAt: 0,
      })
    ).toThrow();
  });

  it("requires an integer non negative capturedAt", () => {
    expect(() =>
      AgentSnapshotSchema.parse({
        url: "https://example.test",
        title: "",
        fields: [],
        sections: [],
        capturedAt: -1,
      })
    ).toThrow();
    expect(() =>
      AgentSnapshotSchema.parse({
        url: "https://example.test",
        title: "",
        fields: [],
        sections: [],
        capturedAt: 1.5,
      })
    ).toThrow();
  });

  it("rejects a field whose sectionRef names a section not in sections[]", () => {
    // A field pointing at a section that no `sections[]` entry names would
    // deserialize fine before the JOB-279 iteration on PR #286; the parse
    // boundary now catches it.
    expect(() =>
      AgentSnapshotSchema.parse({
        url: "https://example.test",
        title: "Apply",
        fields: [{ ...validField, sectionRef: "section_missing" }],
        sections: [],
        capturedAt: 0,
      })
    ).toThrow();
  });

  it("rejects two fields sharing the same ref", () => {
    // Two producers emitting one ref used to fold into a single entry by
    // the Map in `buildDiffSnapshot`, dropping the loser from every diff.
    // JOB-287 closes that at the schema boundary.
    const result = AgentSnapshotSchema.safeParse({
      url: "https://example.test",
      title: "Apply",
      fields: [
        validField,
        { ...validField, label: "Work email", value: "work@example.test" },
      ],
      sections: [],
      capturedAt: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "AgentSnapshot fields must have unique refs"
      );
    }
  });
});

describe("AgentSnapshotDiffSchema", () => {
  it("accepts an empty diff", () => {
    expect(() =>
      AgentSnapshotDiffSchema.parse({
        url: "https://example.test/apply",
        title: "Apply",
        added: [],
        removed: [],
        updated: [],
        sections: { added: [], removed: [], changed: [] },
        capturedAt: 1,
      })
    ).not.toThrow();
  });

  it("accepts a fully populated diff with all three field level moves", () => {
    // The refs across `added`, `removed`, and `updated` must be disjoint
    // (and likewise the section refs), which the JOB-287 uniqueness refine
    // enforces; each move below names its own field and section.
    expect(() =>
      AgentSnapshotDiffSchema.parse({
        url: "https://example.test/apply",
        title: "Apply",
        added: [{ ...validField, ref: "field_added" }],
        removed: ["field_removed"],
        updated: [
          {
            ref: validField.ref,
            before: { ...validField, value: null },
            after: validField,
          },
        ],
        sections: {
          added: [{ ...validSection, ref: "section_added" }],
          removed: ["section_removed"],
          changed: [{ ...validSection, hash: "1111111111111111" }],
        },
        capturedAt: 2,
      })
    ).not.toThrow();
  });

  it("rejects an updated entry whose before and after are structurally equal", () => {
    // The builder filters no op updates via `fieldValueEqual`, but the
    // schema itself accepted an entry with equal before and after before
    // the JOB-279 iteration on PR #286. A hand rolled diff can no longer
    // slip a stale entry past the parse boundary.
    expect(() =>
      AgentSnapshotDiffSchema.parse({
        url: "https://example.test/apply",
        title: "Apply",
        added: [],
        removed: [],
        updated: [
          {
            ref: validField.ref,
            before: validField,
            after: validField,
          },
        ],
        sections: { added: [], removed: [], changed: [] },
        capturedAt: 2,
      })
    ).toThrow();
  });

  it("rejects two added entries sharing the same ref", () => {
    const result = AgentSnapshotDiffSchema.safeParse({
      url: "https://example.test/apply",
      title: "Apply",
      added: [validField, { ...validField, label: "Work email" }],
      removed: [],
      updated: [],
      sections: { added: [], removed: [], changed: [] },
      capturedAt: 2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "diff field refs must be unique across added, removed, and updated"
      );
    }
  });

  it("rejects the same ref appearing in both added and updated", () => {
    // A field cannot be added and updated in the same diff; a builder or
    // hand rolled diff that says so is contradicting itself.
    const result = AgentSnapshotDiffSchema.safeParse({
      url: "https://example.test/apply",
      title: "Apply",
      added: [validField],
      removed: [],
      updated: [
        {
          ref: validField.ref,
          before: { ...validField, value: null },
          after: validField,
        },
      ],
      sections: { added: [], removed: [], changed: [] },
      capturedAt: 2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "diff field refs must be unique across added, removed, and updated"
      );
    }
  });

  it("rejects the same ref appearing in both added and removed", () => {
    const result = AgentSnapshotDiffSchema.safeParse({
      url: "https://example.test/apply",
      title: "Apply",
      added: [validField],
      removed: [validField.ref],
      updated: [],
      sections: { added: [], removed: [], changed: [] },
      capturedAt: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate refs across sections.added", () => {
    const result = AgentSnapshotDiffSchema.safeParse({
      url: "https://example.test/apply",
      title: "Apply",
      added: [],
      removed: [],
      updated: [],
      sections: {
        added: [
          validSection,
          { ...validSection, label: "Education", hash: "2222222222222222" },
        ],
        removed: [],
        changed: [],
      },
      capturedAt: 2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "diff section refs must be unique across sections.added, sections.removed, and sections.changed"
      );
    }
  });
});
