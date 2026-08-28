// @vitest-environment node
/**
 * JOB-234 — the Greenhouse required field validation gate probe, against
 * the shape recovered from two real `applications` rows that ended
 * `submission_unconfirmed`.
 *
 * `greenhouseRequiredFieldGateProbe` fixtures below reproduce, field for
 * field, what `GREENHOUSE_REQUIRED_FIELD_GATE_SCRIPT` reads off the DOM
 * captures in `lib/.submission-screenshots/` for application rows
 * `6e735684-a8bb-4f79-ad99-08c21f74d20f` (one empty field, "What is your
 * expected graduation year?") and `959f884e-9320-470d-9a05-cea041173e8a`
 * (two empty fields, "Location (City)" and a university picker) — both
 * Virtu Financial listings. `greenhouseRequiredFieldsGateBlocked` is the
 * predicate the diagnosis turned into code; these are the cases it has to
 * get right, plus the negative case that keeps it from firing on an
 * ordinary board that never had this gate at all.
 */
import { describe, expect, it } from "vitest";

import {
  describeGreenhouseRequiredFieldsGate,
  greenhouseRequiredFieldsGateBlocked,
  type GreenhouseRequiredFieldGateProbe,
} from "@/lib/solvers/greenhouse";
import { lookupSolver } from "@/lib/solvers/index";
import { greenhouseSolver } from "@/lib/solvers/greenhouse";

/** The exact shape recovered from application row 959f884e-9320-470d-9a05-cea041173e8a. */
const twoEmptyFieldsProbe: GreenhouseRequiredFieldGateProbe = {
  emptyRequiredFields: [
    { label: "Location (City)", controlId: "candidate-location" },
    {
      label: 'Which university are you currently attending? Select "Other" if not listed',
      controlId: "question_37228963002",
    },
  ],
};

/** The exact shape recovered from application row 6e735684-a8bb-4f79-ad99-08c21f74d20f. */
const oneEmptyFieldProbe: GreenhouseRequiredFieldGateProbe = {
  emptyRequiredFields: [
    { label: "What is your expected graduation year?", controlId: "question_36551313002" },
  ],
};

/** The shape an ordinary, unvalidated board reads as — the probe finds nothing. */
const noGateProbe: GreenhouseRequiredFieldGateProbe = { emptyRequiredFields: [] };

describe("greenhouseRequiredFieldsGateBlocked", () => {
  it("fires on the two-field shape recovered from 959f884e", () => {
    expect(greenhouseRequiredFieldsGateBlocked(twoEmptyFieldsProbe)).toBe(true);
  });

  it("fires on the one-field shape recovered from 6e735684", () => {
    expect(greenhouseRequiredFieldsGateBlocked(oneEmptyFieldProbe)).toBe(true);
  });

  it("does not fire when the probe found no empty required fields", () => {
    expect(greenhouseRequiredFieldsGateBlocked(noGateProbe)).toBe(false);
  });
});

describe("describeGreenhouseRequiredFieldsGate", () => {
  it("names every field label and the URL, pluralised, rather than repeating a hedge", () => {
    const message = describeGreenhouseRequiredFieldsGate(
      twoEmptyFieldsProbe,
      "https://job-boards.greenhouse.io/embed/job_app?for=virtu&token=8624410002"
    );
    expect(message).toContain("Location (City)");
    expect(message).toContain("university");
    expect(message).toContain(
      "https://job-boards.greenhouse.io/embed/job_app?for=virtu&token=8624410002"
    );
    expect(message).toContain("2 required fields");
    expect(message).toContain("#93");
    // The point of this row is that it replaces a guess with a fact — it
    // must never repeat the generic branch's own hedge.
    expect(message).not.toContain("most likely rejected");
  });

  it("uses the singular field wording for exactly one empty field", () => {
    const message = describeGreenhouseRequiredFieldsGate(
      oneEmptyFieldProbe,
      "https://job-boards.greenhouse.io/embed/job_app?for=virtu&token=8551566002"
    );
    expect(message).toContain("1 required field");
    expect(message).not.toContain("1 required fields");
    expect(message).toContain("What is your expected graduation year?");
  });

  it("falls back to a readable placeholder for a field the probe could not label", () => {
    const message = describeGreenhouseRequiredFieldsGate(
      { emptyRequiredFields: [{ label: "", controlId: null }] },
      "https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1"
    );
    expect(message).toContain("an unlabeled field");
    expect(message).not.toContain("undefined");
  });
});

describe("the solver registry", () => {
  it("routes greenhouse through greenhouseSolver", () => {
    expect(lookupSolver("greenhouse")).toBe(greenhouseSolver);
  });
});
