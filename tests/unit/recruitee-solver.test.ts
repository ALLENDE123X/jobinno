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
  recruiteePhoneNeedsRewrite,
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

  // JOB-255 review: this table used to fall back to United States ("1") for
  // any null or unrecognised country. Review found that fallback was itself
  // a corruption path (see `lib/solvers/recruitee.ts`'s own JOB-255 review
  // section for the live shape it produced), so `dialCodeForCountry` now
  // signals "unresolved" with `null` instead of guessing. Mentally revert
  // this function to the old `?? "1"` default and every case below fails.
  it("returns null rather than guessing for a null country", () => {
    expect(dialCodeForCountry(null)).toBeNull();
  });

  it("returns null rather than guessing for an empty string country", () => {
    expect(dialCodeForCountry("")).toBeNull();
    expect(dialCodeForCountry("   ")).toBeNull();
  });

  it("returns null rather than guessing for a country not in the lookup table", () => {
    expect(dialCodeForCountry("Wakanda")).toBeNull();
    expect(dialCodeForCountry("Ukraine")).toBeNull();
    expect(dialCodeForCountry("some-random-string")).toBeNull();
  });

  it("regression: a known country still resolves its real dial code", () => {
    expect(dialCodeForCountry("United States")).toBe("1");
  });
});

describe("formatRecruiteePhoneE164", () => {
  it("prepends the dial code to the raw digits recovered from 549305dd", () => {
    expect(formatRecruiteePhoneE164("4044446018", "1")).toBe("+14044446018");
  });

  it("leaves a value already carrying the candidate's own dial code unchanged", () => {
    expect(formatRecruiteePhoneE164("+14044446018", "1")).toBe("+14044446018");
  });

  // JOB-255 — the live verify reproducer. A plus sign alone does not mean
  // the digits behind it name the right calling code: this is the exact
  // value Recruitee's own `react-phone-number-input` widget left behind when
  // its country selector defaulted to Romania for a United States candidate
  // (see this file's own header, and `lib/solvers/recruitee.ts`'s JOB-255
  // section). Before this fix, this exact input returned unchanged — that
  // was the bug.
  it("JOB-255: recovers the correct number when the widget prepended the wrong calling code", () => {
    expect(formatRecruiteePhoneE164("+40 44446018", "1")).toBe("+14044446018");
  });

  // A calling code can also be wrong in a way that adds digits rather than
  // just relabeling them — a country selector default that glues its own
  // dial code onto the full raw string rather than absorbing part of it.
  it("JOB-255: recovers the correct number when a wrong calling code was prepended onto the whole raw string", () => {
    expect(formatRecruiteePhoneE164("+404044446018", "1")).toBe("+14044446018");
  });

  it("JOB-255: leaves a non NANP value that already carries its own correct dial code unchanged in substance", () => {
    const corrected = formatRecruiteePhoneE164("+380 442 30 30 30", "380");
    expect(corrected.replace(/\D/g, "")).toBe("380442303030");
  });

  it("strips separators and parentheses down to digits before prepending", () => {
    expect(formatRecruiteePhoneE164("(404) 444-6018", "1")).toBe("+14044446018");
  });

  it("strips a dash formatted value down to digits before prepending", () => {
    expect(formatRecruiteePhoneE164("404-444-6018", "1")).toBe("+14044446018");
  });

  it("does not double up a North American trunk digit already present", () => {
    expect(formatRecruiteePhoneE164("14044446018", "1")).toBe("+14044446018");
  });

  // Red team minor: a sub ten digit NANP input has fewer digits than a real
  // national number can have. `formatRecruiteePhoneE164`'s own NANP branch
  // (see its doc comment) takes "the last ten digits, or the whole string
  // when there are ten or fewer" — for a nine digit string that is the whole
  // string, so this documents current behavior rather than adding a length
  // check: the function still prepends "+1" and produces a plausible looking
  // but wrong length result. This is deliberately left as is rather than
  // rejected up front, because Recruitee's own client side validation
  // already rejects a malformed number loudly (see this file's own header,
  // the exact "including the country calling code" complaint this solver was
  // built to react to) — a loud downstream failure is an acceptable outcome
  // for a shape this solver has no real production evidence for, unlike the
  // silent wrong country corruption `dialCodeForCountry` used to allow.
  it("documents current behavior for a sub ten digit NANP input: prepends +1 without a length check", () => {
    expect(formatRecruiteePhoneE164("404444601", "1")).toBe("+1404444601");
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
  // country it names. Six of `COUNTRY_DIAL_CODES`'s entries use this
  // convention; the United Kingdom, Germany and France below are three of
  // them, reproducing the exact mechanism CodeRabbit's own review flagged
  // against this function's earlier version. Italy is the one entry that
  // does not, covered separately below.
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

  // Italy is the well known real world exception to the trunk zero rule
  // above: an Italian subscriber number keeps its leading zero even once the
  // "+39" calling code is in front of it. Stripping it the way this function
  // does for the United Kingdom or Germany would silently produce a number
  // one digit short of a real Italian one. Two independently reported
  // counter examples from an earlier round of review pinned this and the
  // "00" prefix case just below.
  it("keeps the leading zero for an Italy number rather than stripping it", () => {
    expect(formatRecruiteePhoneE164("0612345678", "39")).toBe("+390612345678");
  });

  // A resume parsed number can also arrive already written for international
  // dialing, a leading "00" in place of a "+". The digits after it are
  // already a complete international number, own calling code included, so
  // this function has to strip the "00" and add a "+" directly rather than
  // prepending this call's own dial code on top of it, which would double up
  // the calling code the value already carries.
  describe("an international dial out prefix", () => {
    it("strips a leading 00 and does not double up the dial code that follows it", () => {
      expect(formatRecruiteePhoneE164("00447911123456", "44")).toBe("+447911123456");
    });

    it("still strips 00 even when the resolved dial code names a different country", () => {
      // The value already names its own country via the digits after "00";
      // whatever `dialCodeForCountry` resolved for this candidate is beside
      // the point once an explicit "00" prefix is present.
      expect(formatRecruiteePhoneE164("003312345678", "1")).toBe("+3312345678");
    });
  });
});

// JOB-255 — the broadened gate `patchRecruiteePhoneCountryCode` actually uses
// now, in place of `recruiteePhoneMissingCountryCode`'s narrower "no leading
// plus" question. Every case here mentally breaks the old implementation: a
// pre JOB-255 `recruiteePhoneMissingCountryCode(probe)` reads `false` for
// every value that already carries a plus sign, which is exactly how the
// live "+40 44446018" value slipped through and reached Recruitee's own
// validation unfixed. `recruiteePhoneNeedsRewrite` has to read `true` for
// that shape for this regression to actually be caught.
describe("recruiteePhoneNeedsRewrite", () => {
  it("JOB-255: the real production case — a plausible looking but wrong calling code needs a rewrite", () => {
    expect(recruiteePhoneNeedsRewrite("+40 44446018", "1")).toBe(true);
  });

  it("a value already carrying the candidate's own correct dial code needs no rewrite", () => {
    expect(recruiteePhoneNeedsRewrite("+14044446018", "1")).toBe(false);
  });

  it("raw digits with no calling code at all need a rewrite", () => {
    expect(recruiteePhoneNeedsRewrite("4044446018", "1")).toBe(true);
  });

  it("a dash formatted value with no calling code needs a rewrite", () => {
    expect(recruiteePhoneNeedsRewrite("404-444-6018", "1")).toBe(true);
  });

  it("a different country's already correct value needs no rewrite", () => {
    expect(recruiteePhoneNeedsRewrite("+380 442 30 30 30", "380")).toBe(false);
  });

  it("an empty or whitespace only value needs no rewrite — nothing to sensibly change it to", () => {
    expect(recruiteePhoneNeedsRewrite("", "1")).toBe(false);
    expect(recruiteePhoneNeedsRewrite("   ", "1")).toBe(false);
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

  it("names that nothing was rewritten when the value already carried the right dial code", () => {
    const message = describeRecruiteePhoneStillBlocked(
      STILL_BLOCKED_PROBE,
      { outcome: "skipped", correctedValue: null, skipReason: "already_correct" },
      "https://transperfect.recruitee.com/o/junior-frontend-engineer-4/c/new"
    );
    expect(message).toContain("found nothing to rewrite");
    expect(message).not.toContain("already rewritten");
    expect(message).not.toContain("rewrite itself failed");
    expect(message).not.toContain("could not resolve");
  });

  // JOB-255 review — the corruption fix's own regression coverage. A skip
  // caused by an unresolved country has to read differently from a skip
  // caused by the value already being correct: the first never checked the
  // value at all, the second checked it and found nothing wrong. Folding
  // them into the same sentence would tell a reader "this was verified fine"
  // when it was actually "this was never verified." Mentally revert
  // `describeRecruiteePhoneStillBlocked` to ignore `skipReason` and this test
  // fails, since both skip reasons would render the same "found nothing to
  // rewrite" sentence this test explicitly rejects.
  it("names that this solver declined to guess a dial code, distinctly from nothing needing fixing", () => {
    const message = describeRecruiteePhoneStillBlocked(
      STILL_BLOCKED_PROBE,
      { outcome: "skipped", correctedValue: null, skipReason: "country_unresolved" },
      "https://transperfect.recruitee.com/o/junior-frontend-engineer-4/c/new"
    );
    expect(message).toContain("could not resolve");
    expect(message).toContain("deliberately left");
    expect(message).not.toContain("found nothing to rewrite");
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
      { outcome: "skipped", correctedValue: null, skipReason: "already_correct" },
      "https://transperfect.recruitee.com/o/junior-frontend-engineer-4/c/new"
    );
    expect(message).toContain(STILL_BLOCKED_PROBE.errorText!);
  });
});

describe("redactPhoneForLog behavior surfaced through describeRecruiteePhoneStillBlocked", () => {
  it("reports an unreadable value as such rather than as a redacted number", () => {
    const message = describeRecruiteePhoneStillBlocked(
      { present: true, value: null, invalid: true, errorText: STILL_BLOCKED_PROBE.errorText },
      { outcome: "skipped", correctedValue: null, skipReason: "unreadable" },
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
