// @vitest-environment node
/**
 * JOB-236 — the Recruitee phone box probe and the #140 country code fix,
 * against the shape recovered from the one real `applications` row that ever
 * hit it, `549305dd-2c66-411d-98ee-3c4bc8a3ce58` (TransPerfect, Junior
 * Frontend Engineer).
 *
 * The captured DOM for that row shows exactly one control the board marked
 * invalid: `<input type="tel" ... class="... PhoneInputInput" value="+40
 * 44446018">`, next to a validation message reading "This phone number is
 * invalid. Please enter a valid phone number, including the country calling
 * code." Issue #140 traced this to the fill typing the candidate's raw
 * digits with no leading calling code of their own. The fixtures below
 * reproduce that shape, plus the negative cases that keep the fix from
 * firing on a phone box that already carries its own calling code.
 */
import { describe, expect, it } from "vitest";

import {
  describeRecruiteePhoneStillBlocked,
  dialCodeForCountry,
  formatRecruiteePhoneE164,
  recruiteePhoneMissingCountryCode,
  recruiteePhoneValidationStillBlocked,
  type RecruiteePhoneProbe,
} from "@/lib/solvers/recruitee";
import { lookupSolver } from "@/lib/solvers/index";
import { recruiteeSolver } from "@/lib/solvers/recruitee";

/** The exact shape recovered from application row 549305dd-2c66-411d-98ee-3c4bc8a3ce58. */
const MISSING_CODE_PROBE: RecruiteePhoneProbe = {
  present: true,
  value: "4044446018",
  invalid: false,
  errorText: null,
};

/** What the same box read as after the board's own client side check ran. */
const STILL_BLOCKED_PROBE: RecruiteePhoneProbe = {
  present: true,
  value: "+40 44446018",
  invalid: true,
  errorText: "This phone number is invalid. Please enter a valid phone number, including the country calling code.",
};

/** A phone box that already carries its own calling code — nothing to fix. */
const ALREADY_PREFIXED_PROBE: RecruiteePhoneProbe = {
  present: true,
  value: "+14044446018",
  invalid: false,
  errorText: null,
};

const NO_FIELD_PROBE: RecruiteePhoneProbe = {
  present: false,
  value: null,
  invalid: false,
  errorText: null,
};

describe("recruiteePhoneMissingCountryCode", () => {
  it("fires on the raw digit shape recovered from 549305dd", () => {
    expect(recruiteePhoneMissingCountryCode(MISSING_CODE_PROBE)).toBe(true);
  });

  it("does not fire when the value already carries a plus prefix", () => {
    expect(recruiteePhoneMissingCountryCode(ALREADY_PREFIXED_PROBE)).toBe(false);
    expect(recruiteePhoneMissingCountryCode(STILL_BLOCKED_PROBE)).toBe(false);
  });

  it("does not fire when there is no phone box on the page", () => {
    expect(recruiteePhoneMissingCountryCode(NO_FIELD_PROBE)).toBe(false);
  });

  it("does not fire on an empty value — nothing to sensibly rewrite", () => {
    expect(
      recruiteePhoneMissingCountryCode({ present: true, value: "", invalid: false, errorText: null })
    ).toBe(false);
    expect(
      recruiteePhoneMissingCountryCode({ present: true, value: "   ", invalid: false, errorText: null })
    ).toBe(false);
  });
});

describe("recruiteePhoneValidationStillBlocked", () => {
  it("fires on the exact validation text recovered from 549305dd", () => {
    expect(recruiteePhoneValidationStillBlocked(STILL_BLOCKED_PROBE)).toBe(true);
  });

  it("does not fire on a field that was never marked invalid", () => {
    expect(recruiteePhoneValidationStillBlocked(MISSING_CODE_PROBE)).toBe(false);
  });

  it("does not fire when the field is invalid for an unrelated reason", () => {
    expect(
      recruiteePhoneValidationStillBlocked({
        present: true,
        value: "123",
        invalid: true,
        errorText: "This field is required.",
      })
    ).toBe(false);
  });

  it("does not fire when there is no phone box on the page", () => {
    expect(recruiteePhoneValidationStillBlocked(NO_FIELD_PROBE)).toBe(false);
  });
});

describe("dialCodeForCountry", () => {
  it("maps the one candidate on record's stated country", () => {
    expect(dialCodeForCountry("United States")).toBe("1");
  });

  it("is case insensitive and tolerates surrounding whitespace", () => {
    expect(dialCodeForCountry("  united states  ")).toBe("1");
    expect(dialCodeForCountry("INDIA")).toBe("91");
  });

  it("maps a handful of other common countries", () => {
    expect(dialCodeForCountry("United Kingdom")).toBe("44");
    expect(dialCodeForCountry("Canada")).toBe("1");
    expect(dialCodeForCountry("Germany")).toBe("49");
  });

  it("falls back to United States for a null or unrecognised country", () => {
    expect(dialCodeForCountry(null)).toBe("1");
    expect(dialCodeForCountry("Wakanda")).toBe("1");
  });
});

describe("formatRecruiteePhoneE164", () => {
  it("prepends the dial code to the raw digits recovered from 549305dd", () => {
    expect(formatRecruiteePhoneE164("4044446018", "1")).toBe("+14044446018");
  });

  it("leaves a value that already starts with a plus sign unchanged", () => {
    expect(formatRecruiteePhoneE164("+14044446018", "1")).toBe("+14044446018");
    expect(formatRecruiteePhoneE164("+40 44446018", "1")).toBe("+40 44446018");
  });

  it("strips separators and parentheses down to digits before prepending", () => {
    expect(formatRecruiteePhoneE164("(404) 444-6018", "1")).toBe("+14044446018");
  });

  it("does not double up a North American trunk digit already present", () => {
    expect(formatRecruiteePhoneE164("14044446018", "1")).toBe("+14044446018");
  });

  it("uses a non United States dial code as given, without the trunk digit special case", () => {
    expect(formatRecruiteePhoneE164("9876543210", "91")).toBe("+919876543210");
  });

  it("returns the trimmed original when there are no digits at all", () => {
    expect(formatRecruiteePhoneE164("  ", "1")).toBe("");
  });

  // A national trunk prefix ("0" in front of a local number) is how most
  // countries outside the North American Numbering Plan write their own
  // numbers, and it has to be stripped before a calling code is prepended,
  // or the result carries the wrong shape and the wrong digit count for the
  // country it names. Seven of `COUNTRY_DIAL_CODES`'s entries use this
  // convention; the United Kingdom, Germany and France below are three of
  // them, reproducing the exact mechanism CodeRabbit's own review flagged
  // against this function's earlier version.
  describe("a national trunk prefix on a non NANP number", () => {
    it("strips the leading zero for a United Kingdom number", () => {
      expect(formatRecruiteePhoneE164("07911123456", "44")).toBe("+447911123456");
    });

    it("strips the leading zero for a Germany number", () => {
      expect(formatRecruiteePhoneE164("030 12345678", "49")).toBe("+493012345678");
    });

    it("strips the leading zero for a France number", () => {
      expect(formatRecruiteePhoneE164("06 12 34 56 78", "33")).toBe("+33612345678");
    });
  });

  // NANP numbers (dial code "1") never lead with a trunk zero, so the strip
  // above must never run for them — the guard is `dialCode !== "1"`, not a
  // list of countries kept in step with `COUNTRY_DIAL_CODES` by hand. This
  // pins that a leading zero on a "1" dial code number is left exactly as
  // given rather than silently dropped.
  it("does not strip a leading zero for a North American Numbering Plan dial code", () => {
    expect(formatRecruiteePhoneE164("0212345678", "1")).toBe("+10212345678");
  });
});

describe("describeRecruiteePhoneStillBlocked", () => {
  it("names that this solver's own patch already ran when it did, without embedding the raw digits", () => {
    const message = describeRecruiteePhoneStillBlocked(
      STILL_BLOCKED_PROBE,
      { outcome: "attempted", correctedValue: "+14044446018" },
      "https://transperfect.recruitee.com/o/junior-frontend-engineer-4/c/new"
    );
    // The candidate's own phone digits never reach this message — see
    // `redactPhoneForLog` in `lib/solvers/recruitee.ts`. Only the last four
    // digits, behind a redaction marker, are allowed to show.
    expect(message).not.toContain("+14044446018");
    expect(message).toContain("...6018");
    expect(message).toContain("already rewritten");
    expect(message).toContain("#140");
    expect(message).toContain("country calling code");
    expect(message).toContain("retried automatically");
  });

  it("names that nothing was rewritten when the patch never fired", () => {
    const message = describeRecruiteePhoneStillBlocked(
      STILL_BLOCKED_PROBE,
      { outcome: "skipped", correctedValue: null },
      "https://transperfect.recruitee.com/o/junior-frontend-engineer-4/c/new"
    );
    expect(message).toContain("found nothing to rewrite");
    expect(message).not.toContain("already rewritten");
    expect(message).not.toContain("rewrite itself failed");
  });

  // The BLOCKING gap this test closes: an earlier version of this file
  // reported a failed rewrite attempt with the exact same "found nothing to
  // rewrite" sentence the skipped case uses, which is false on the failed
  // path — a rewrite plainly was attempted, it just did not complete. See
  // `RecruiteePhonePatchOutcome` in `lib/solvers/recruitee.ts`.
  it("names that a rewrite was attempted and failed, distinctly from nothing needing fixing", () => {
    const message = describeRecruiteePhoneStillBlocked(
      STILL_BLOCKED_PROBE,
      { outcome: "failed", correctedValue: null, failureReason: "selector no longer resolves" },
      "https://transperfect.recruitee.com/o/junior-frontend-engineer-4/c/new"
    );
    expect(message).toContain("rewrite itself failed");
    expect(message).toContain("selector no longer resolves");
    expect(message).toContain("did not complete");
    expect(message).not.toContain("found nothing to rewrite");
    expect(message).not.toContain("already rewritten");
  });

  it("includes the board's own error text when the probe carried one", () => {
    const message = describeRecruiteePhoneStillBlocked(
      STILL_BLOCKED_PROBE,
      { outcome: "skipped", correctedValue: null },
      "https://transperfect.recruitee.com/o/junior-frontend-engineer-4/c/new"
    );
    expect(message).toContain(STILL_BLOCKED_PROBE.errorText!);
  });
});

describe("redactPhoneForLog behavior surfaced through describeRecruiteePhoneStillBlocked", () => {
  it("reports an unreadable value as such rather than as a redacted number", () => {
    const message = describeRecruiteePhoneStillBlocked(
      { present: true, value: null, invalid: true, errorText: STILL_BLOCKED_PROBE.errorText },
      { outcome: "skipped", correctedValue: null },
      "https://transperfect.recruitee.com/o/junior-frontend-engineer-4/c/new"
    );
    expect(message).toContain("could not be read");
  });
});

describe("the solver registry", () => {
  it("routes recruitee through recruiteeSolver", () => {
    expect(lookupSolver("recruitee")).toBe(recruiteeSolver);
  });
});
