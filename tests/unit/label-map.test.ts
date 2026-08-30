/**
 * JOB-280 (sub ticket C of #276). Coverage for the hoisted label map.
 *
 * The regexes in `lib/label-map.ts` are shared between the legacy fill
 * path's DOM safety conflict check and the agent path's deterministic
 * prefill classifier, and the two readings have to agree about what a
 * label means. `tests/unit/form-action-cache.test.ts` already runs a
 * shared corpus over both `classifyCoreSlot` and `FIELD_KEYWORDS`, so the
 * cases below are the pin holes the extraction itself introduces: the
 * constants survived the move, and every legacy key still exists.
 */

import { describe, expect, it } from "vitest";

import { FIELD_KEYWORDS as FIELD_KEYWORDS_LEGACY } from "@/lib/fill-application-form";
import { FIELD_KEYWORDS, type FieldKey } from "@/lib/label-map";

describe("FIELD_KEYWORDS", () => {
  it("shares the same object reference with the legacy module", () => {
    // Identity, not deep equality: a second constant would be a duplicate
    // table, which is exactly what the hoist is meant to prevent.
    expect(FIELD_KEYWORDS_LEGACY).toBe(FIELD_KEYWORDS);
  });

  it("carries every legacy field key", () => {
    const expected: FieldKey[] = [
      "firstName",
      "lastName",
      "fullName",
      "email",
      "confirmEmail",
      "city",
      "phone",
      "linkedin",
      "website",
      "coverLetter",
      "resume",
    ];
    for (const key of expected) {
      expect(FIELD_KEYWORDS[key], key).toBeInstanceOf(RegExp);
    }
  });

  it("matches the labels the legacy conflict check relied on", () => {
    // A few of the labels the legacy tests read back through
    // `corroborate()`. These are the shortest smoke that the regexes
    // themselves did not silently change on the hoist.
    expect(FIELD_KEYWORDS.firstName.test("First Name")).toBe(true);
    expect(FIELD_KEYWORDS.lastName.test("Last Name")).toBe(true);
    expect(FIELD_KEYWORDS.email.test("Email")).toBe(true);
    expect(FIELD_KEYWORDS.confirmEmail.test("Confirm email")).toBe(true);
    expect(FIELD_KEYWORDS.phone.test("Phone")).toBe(true);
    expect(FIELD_KEYWORDS.linkedin.test("LinkedIn URL")).toBe(true);
    expect(FIELD_KEYWORDS.website.test("Portfolio")).toBe(true);
    expect(FIELD_KEYWORDS.resume.test("Resume")).toBe(true);
  });
});
