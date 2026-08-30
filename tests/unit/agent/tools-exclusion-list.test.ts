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
  UNRESOLVED_INTAKE_FACT,
  assertSetFieldValueAllowed,
  isBackgroundCheckCriticalLabel,
  setFieldValue,
  type ResolvedIntakeFactValue,
  type SetFieldValueInput,
  type ToolContext,
} from "@/lib/agent/tools";

/**
 * Context whose `resolveIntakeFactValue` echoes the input value back for any
 * non empty path. Simulates a catalog whose stored value matches whatever the
 * agent tried to write, which is the shape the wrapper accepts.
 */
const echoingContext: ToolContext = {
  resolveIntakeFactValue: (path) =>
    typeof path === "string" && path.length > 0
      ? "Acme Corp"
      : UNRESOLVED_INTAKE_FACT,
};

/**
 * Context whose `resolveIntakeFactValue` returns the specific value under
 * test, so the tests below can assert both the match and the mismatch case
 * against a real catalog value rather than a boolean stand in.
 */
function contextReturning(value: ResolvedIntakeFactValue): ToolContext {
  return { resolveIntakeFactValue: () => value };
}

const rejectingContext: ToolContext = {
  resolveIntakeFactValue: () => UNRESOLVED_INTAKE_FACT,
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
        assertSetFieldValueAllowed(input, echoingContext)
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
        echoingContext
      )
    ).toThrow(ExcludedFieldError);
  });

  it("throws when sourceHint=intake and the path resolves but its value does not match the input value", () => {
    // This is the gap CodeRabbit flagged at r3888875177. Without the value
    // equality check, a call could quote a real path such as
    // resume.experience[0].employer (whose value is "Acme Corp") and still
    // write "Some Other Company" to the field, laundering a fabricated fact
    // through a valid path. HARD STOP 9 fails if the wrapper accepts this.
    expect(() =>
      assertSetFieldValueAllowed(
        {
          fieldId: "prev_employer",
          label: "Previous Employer",
          value: "Some Other Company",
          sourceHint: "intake",
          intakeFactPath: "resume.experience[0].employer",
        },
        contextReturning("Acme Corp")
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

  it("also enforces value equality for benign labels when sourceHint is intake", () => {
    expect(() =>
      assertSetFieldValueAllowed(
        {
          fieldId: "first_name",
          label: "First name",
          value: "Ada",
          sourceHint: "intake",
          intakeFactPath: "profile.first_name",
        },
        contextReturning("Grace")
      )
    ).toThrow(ExcludedFieldError);
  });

  it("accepts a background check critical label when the intake path resolves and the value matches", () => {
    expect(() =>
      assertSetFieldValueAllowed(
        {
          fieldId: "prev_employer",
          label: "Previous Employer",
          value: "Acme Corp",
          sourceHint: "intake",
          intakeFactPath: "resume.experience[0].employer",
        },
        contextReturning("Acme Corp")
      )
    ).not.toThrow();
  });

  it("tolerates surrounding whitespace on the input value when comparing to the catalog value", () => {
    // Normalization trims strings so a leading space introduced by a form
    // control does not defeat the equality check.
    expect(() =>
      assertSetFieldValueAllowed(
        {
          fieldId: "prev_employer",
          label: "Previous Employer",
          value: "  Acme Corp  ",
          sourceHint: "intake",
          intakeFactPath: "resume.experience[0].employer",
        },
        contextReturning("Acme Corp")
      )
    ).not.toThrow();
  });

  it("accepts a numeric catalog value quoted as a string on the input", () => {
    // Numbers coerce to their canonical string form, so a graduation year
    // stored as a number matches when the agent writes "2024" into a text
    // field.
    expect(() =>
      assertSetFieldValueAllowed(
        {
          fieldId: "grad_year",
          label: "Graduation year",
          value: "2024",
          sourceHint: "intake",
          intakeFactPath: "resume.education[0].end_year",
        },
        contextReturning(2024)
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
        echoingContext
      )
    ).not.toThrow();
  });
});

describe("setFieldValue", () => {
  it("rejects a fabricated background check critical fill before reaching the handler stub", async () => {
    const spy = vi.spyOn(echoingContext, "resolveIntakeFactValue");
    await expect(
      setFieldValue(
        {
          fieldId: "prev_employer",
          label: "Previous Employer",
          value: "Acme Corp",
          sourceHint: "fabricated",
          intakeFactPath: null,
        },
        echoingContext
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
        contextReturning("Acme Corp")
      )
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
  });
});
