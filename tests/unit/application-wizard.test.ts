// @vitest-environment node
/**
 * JOB-117 — advancing a multi step application without ever submitting one.
 *
 * Two things are pinned here, and they are the two that decide whether pressing
 * Next on a real employer's form is safe.
 *
 * The first is that the rule for "this page is another step of the same
 * application" is now one rule rather than two. JOB-106 wrote it to judge the
 * page *after* the submit click; JOB-117 asks the same question *before*
 * pressing Next, and a second copy would be free to drift into the state where a
 * receipt reads as a step on one side of the click and a step reads as a receipt
 * on the other. `tests/unit/submit-evidence.test.ts` still pins
 * `readsAsFurtherStep` against the real Avery Dennison capture; this file pins
 * the shared predicate underneath it, so a change that breaks the sharing breaks
 * a test rather than a live application.
 *
 * The second is the pair of gates in front of the Next click.
 * `assertNotAnApplicationSubmit` refuses anything whose own description reads as
 * the control that submits the application, and `NEXT_STEP_ACCEPT_RE` then has
 * to agree, independently, that what was found reads as a next step control. The
 * cases below are written as the descriptions `observe()` actually returns —
 * prose, not labels — because that is what both gates see.
 */
import { describe, expect, it } from "vitest";

import { pageReadsAsFurtherStep } from "@/lib/application-wizard";
import {
  assertNotAnApplicationSubmit,
  assertStepFullyRead,
  FormFillBlockedError,
  NEXT_STEP_ACCEPT_RE,
} from "@/lib/fill-application-form";

/** The page a filled SmartRecruiters `oneclick-ui` first step sits on. */
const EASY_APPLY = "https://jobs.smartrecruiters.com/AveryDennison/744000000000000-software-engineer-iv";

describe("pageReadsAsFurtherStep — the rule, shared with the submit side", () => {
  it("reads SmartRecruiters' own screening step as a further step", () => {
    // Both halves of the board's shipped i18n bundle, as they appear live:
    // `page.title.prefix.screening` in the title, `/screening` in the path.
    expect(
      pageReadsAsFurtherStep(
        "Preliminary questions - Software Engineer IV (Hybrid - Onsite 2x/week) - Vestcom",
        `${EASY_APPLY}/screening`,
        EASY_APPLY
      )
    ).toBe(true);
  });

  it("reads the board's own success page as a receipt and not as a step", () => {
    // `application-success-page.header` from the same bundle. A board that
    // genuinely confirms must never be mistaken for a step, because a row that
    // under reports a real submission invites something upstream to submit again.
    expect(
      pageReadsAsFurtherStep(
        "Application submitted! - Software Engineer IV - Vestcom",
        `${EASY_APPLY}/thank-you`,
        EASY_APPLY
      )
    ).toBe(false);
  });

  it("lets a confirmation at a step-shaped URL still read as a confirmation", () => {
    expect(
      pageReadsAsFurtherStep(
        "Thank you for applying",
        "https://boards.example.com/application/questions/confirmation",
        "https://boards.example.com/application"
      )
    ).toBe(false);
  });

  it("does not read the form's own page as a step when nothing navigated", () => {
    // The path under examination is the form's own here, so asking whether it
    // looks like a step is asking about the page we started on.
    expect(
      pageReadsAsFurtherStep("Easy apply", `${EASY_APPLY}/questions`, `${EASY_APPLY}/questions`)
    ).toBe(false);
  });

  it("does not fire on a job title that happens to contain a step-ish word", () => {
    // The guard's own warning, kept live: titles are slugged into paths, and a
    // pattern that matched a common word would switch this off for a whole class
    // of role while looking like it still worked.
    expect(
      pageReadsAsFurtherStep(
        "Easy apply - Customer Success Engineer - Acme",
        "https://jobs.smartrecruiters.com/Acme/123-customer-success-engineer",
        "https://jobs.smartrecruiters.com/Acme"
      )
    ).toBe(false);
  });
});

describe("the two gates in front of a Next click", () => {
  /** Both gates, in the order `clickControl` applies them. */
  const wouldPress = (description: string): boolean => {
    try {
      assertNotAnApplicationSubmit("the next-step control", description);
    } catch (err) {
      if (err instanceof FormFillBlockedError) return false;
      throw err;
    }
    return NEXT_STEP_ACCEPT_RE.test(description);
  };

  it("presses a wizard's next control", () => {
    expect(wouldPress('the "Next" button at the bottom of the application form')).toBe(true);
    expect(wouldPress("the Continue button that moves to the next section")).toBe(true);
    expect(wouldPress('the "Next step" primary button')).toBe(true);
  });

  it("refuses the control that submits the application", () => {
    // Refused by the first gate: an application control that is also a submit.
    expect(wouldPress('the "Submit Application" button')).toBe(false);
    expect(wouldPress("the button that sends the application to the employer")).toBe(false);
    expect(wouldPress("the button that completes your application")).toBe(false);
  });

  it("refuses a control that neither gate can positively identify", () => {
    // Not refused by the first gate, but not accepted by the second either. An
    // unlabelled or position-described control does not get pressed on a real
    // employer's site just because nothing forbade it.
    expect(wouldPress("the blue button in the bottom right corner")).toBe(false);
    expect(wouldPress("the primary button")).toBe(false);
  });

  it("refuses a Next-labelled control that also describes itself as submitting", () => {
    // The dangerous shape: a board whose advance control genuinely does submit,
    // and says so. The first gate has to win over the second's agreement.
    expect(wouldPress('the "Next" button that submits your application')).toBe(false);
  });

  it("presses the control the live Avery Dennison form actually reports", () => {
    // Quoted from the run of 2026-08-22 against
    // jobs.smartrecruiters.com/AveryDennison/744000143371069, which advanced to
    // the screening step on it.
    expect(
      wouldPress("Next button that advances the multi-step application form to the next step.")
    ).toBe(true);
  });

  it("still refuses the description the first version of the instruction produced", () => {
    // The regression this file exists for. `INSTRUCTIONS.NEXT_STEP` originally
    // said "without submitting it", `observe()` answered in the instruction's own
    // vocabulary, and the description below came back — carrying "application"
    // and "submitting" and tripping a guard that has no notion of negation. The
    // fix was to reword the instruction; the guard was left exactly as strong,
    // and this pins that it still refuses this string.
    expect(
      wouldPress(
        "Next button that advances the job application to the next step without submitting it."
      )
    ).toBe(false);
  });
});

describe("assertStepFullyRead — a step is not filled just because we ran out of fields", () => {
  const AT = "https://jobs.smartrecruiters.com/oneclick-ui/company/AveryDennison/x/screening";

  it("stops on the real Avery Dennison screening step", () => {
    // The live numbers from the run of 2026-08-22: the page marks 29 required
    // questions and perception reads 8 of them as fillable controls. Twenty one
    // required questions — age, visa sponsorship, highest education, prior
    // employment, non-compete, salary expectations, the privacy declaration —
    // were never offered to the candidate and were still blank when the run
    // called the form filled.
    expect(() => assertStepFullyRead(29, 8, 2, AT)).toThrow(FormFillBlockedError);
    expect(() => assertStepFullyRead(29, 8, 2, AT)).toThrow(/29 required question/);
  });

  it("passes when perception read everything the page marks required", () => {
    expect(() => assertStepFullyRead(8, 8, 2, AT)).not.toThrow();
    expect(() => assertStepFullyRead(0, 0, 2, AT)).not.toThrow();
  });

  it("passes when perception read more than the page marks required", () => {
    // Perception counts a question the markup does not mark. Not a gap.
    expect(() => assertStepFullyRead(3, 9, 2, AT)).not.toThrow();
  });

  it("stays quiet when the sweep could not run rather than reporting a clean page", () => {
    // `null` is "no evidence", and a guard that reads a failed measurement as a
    // clean bill of health is not a guard — but it is also not licence to block
    // every run on a page it could not measure.
    expect(() => assertStepFullyRead(null, 0, 2, AT)).not.toThrow();
  });
});
