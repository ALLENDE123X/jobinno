/**
 * JOB-277. Covers the exclusion list wrapper around `setFieldValue`. The
 * wrapper is what enforces HARD STOP 9 (no fabricated facts on the fields an
 * employer's background check verifies) at the tool boundary rather than as
 * a review after the fact.
 */

import { describe, expect, it, vi } from "vitest";

import { AgentFillNotImplementedError } from "@/lib/agent";
import {
  ExcludedFieldError,
  assertSetFieldValueAllowed,
  isBackgroundCheckCriticalLabel,
  setFieldValue,
  type SetFieldValueInput,
  type ToolContext,
} from "@/lib/agent/tools";

const acceptingContext: ToolContext = {
  resolveIntakeFactPath: (path) => typeof path === "string" && path.length > 0,
};

const rejectingContext: ToolContext = {
  resolveIntakeFactPath: () => false,
};

function excludedLabelCases(): SetFieldValueInput[] {
  return [
    {
      fieldId: "prev_employer",
      label: "Previous Employer",
      value: "Acme Corp",
      sourceHint: "fabricated",
      intakeFactPath: null,
    },
    {
      fieldId: "start_date",
      label: "Employment Start Date",
      value: "2024-01-15",
      sourceHint: "inferred",
      intakeFactPath: null,
    },
    {
      fieldId: "school",
      label: "University Name",
      value: "State University",
      sourceHint: "fabricated",
      intakeFactPath: null,
    },
    {
      fieldId: "major",
      label: "Degree / Field of Study",
      value: "Computer Science",
      sourceHint: "fabricated",
      intakeFactPath: null,
    },
  ];
}

describe("isBackgroundCheckCriticalLabel", () => {
  it("flags labels that name an employer, employment dates, education institution, or degree field", () => {
    for (const label of [
      "Previous Employer",
      "Company Name",
      "Employment Start Date",
      "Employment End Date",
      "University",
      "College Name",
      "Institution",
      "Degree",
      "Major",
      "Field of Study",
    ]) {
      expect(isBackgroundCheckCriticalLabel(label)).toBe(true);
    }
  });

  it("leaves benign labels alone", () => {
    for (const label of [
      "First name",
      "LinkedIn URL",
      "Phone number",
      "Are you eligible to work in the United States?",
      "How did you hear about us?",
    ]) {
      expect(isBackgroundCheckCriticalLabel(label)).toBe(false);
    }
  });
});

describe("assertSetFieldValueAllowed", () => {
  it("throws ExcludedFieldError for every background check critical label without an intake source", () => {
    for (const input of excludedLabelCases()) {
      expect(() =>
        assertSetFieldValueAllowed(input, acceptingContext)
      ).toThrow(ExcludedFieldError);
    }
  });

  it("throws when a background check critical label declares intake but the path does not resolve", () => {
    expect(() =>
      assertSetFieldValueAllowed(
        {
          fieldId: "prev_employer",
          label: "Previous Employer",
          value: "Acme Corp",
          sourceHint: "intake",
          intakeFactPath: "resume.experience[0].employer",
        },
        rejectingContext
      )
    ).toThrow(ExcludedFieldError);
  });

  it("throws when a background check critical label declares intake but no path is supplied", () => {
    expect(() =>
      assertSetFieldValueAllowed(
        {
          fieldId: "prev_employer",
          label: "Previous Employer",
          value: "Acme Corp",
          sourceHint: "intake",
          intakeFactPath: null,
        },
        acceptingContext
      )
    ).toThrow(ExcludedFieldError);
  });

  it("also enforces intakeFactPath resolvability for benign labels when sourceHint is intake", () => {
    // A hint that claims a source without pointing at one is a bug, not a
    // value; the wrapper rejects it regardless of what the field's label is.
    expect(() =>
      assertSetFieldValueAllowed(
        {
          fieldId: "first_name",
          label: "First name",
          value: "Ada",
          sourceHint: "intake",
          intakeFactPath: "profile.first_name",
        },
        rejectingContext
      )
    ).toThrow(ExcludedFieldError);
  });

  it("accepts a background check critical label when the intake path resolves", () => {
    expect(() =>
      assertSetFieldValueAllowed(
        {
          fieldId: "prev_employer",
          label: "Previous Employer",
          value: "Acme Corp",
          sourceHint: "intake",
          intakeFactPath: "resume.experience[0].employer",
        },
        acceptingContext
      )
    ).not.toThrow();
  });

  it("accepts a benign label with any source hint", () => {
    expect(() =>
      assertSetFieldValueAllowed(
        {
          fieldId: "how_did_you_hear",
          label: "How did you hear about us?",
          value: "LinkedIn",
          sourceHint: "fabricated",
          intakeFactPath: null,
        },
        acceptingContext
      )
    ).not.toThrow();
  });
});

describe("setFieldValue", () => {
  it("rejects a fabricated background check critical fill before reaching the handler stub", async () => {
    const spy = vi.spyOn(acceptingContext, "resolveIntakeFactPath");
    await expect(
      setFieldValue(
        {
          fieldId: "prev_employer",
          label: "Previous Employer",
          value: "Acme Corp",
          sourceHint: "fabricated",
          intakeFactPath: null,
        },
        acceptingContext
      )
    ).rejects.toBeInstanceOf(ExcludedFieldError);
    // No path resolution attempted for a fabricated hint on an excluded label.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects a background check critical fill whose intakeFactPath does not resolve", async () => {
    await expect(
      setFieldValue(
        {
          fieldId: "prev_employer",
          label: "Previous Employer",
          value: "Acme Corp",
          sourceHint: "intake",
          intakeFactPath: "resume.experience[0].employer",
        },
        rejectingContext
      )
    ).rejects.toBeInstanceOf(ExcludedFieldError);
  });

  it("passes through to the not implemented handler once the exclusion list allows the fill", async () => {
    await expect(
      setFieldValue(
        {
          fieldId: "prev_employer",
          label: "Previous Employer",
          value: "Acme Corp",
          sourceHint: "intake",
          intakeFactPath: "resume.experience[0].employer",
        },
        acceptingContext
      )
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
  });
});
