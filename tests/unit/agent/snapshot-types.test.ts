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
      "textarea",
      "email",
      "url",
      "tel",
      "number",
      "select",
      "multiselect",
      "checkbox",
      "radio",
      "file",
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
    expect(() =>
      AgentSnapshotDiffSchema.parse({
        url: "https://example.test/apply",
        title: "Apply",
        added: [validField],
        removed: ["field_removed"],
        updated: [
          {
            ref: validField.ref,
            before: { ...validField, value: null },
            after: validField,
          },
        ],
        sections: {
          added: [validSection],
          removed: ["section_removed"],
          changed: [{ ...validSection, hash: "1111111111111111" }],
        },
        capturedAt: 2,
      })
    ).not.toThrow();
  });
});
