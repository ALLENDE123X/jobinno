// @vitest-environment node
/**
 * JOB-106 — what the page after the submit click is allowed to be evidence of.
 *
 * The fixture at the centre of this file is not invented. Application
 * `1748f995-f91c-4c5b-9062-7fd009d585b1` recorded `submitted` — terminal, never
 * retried — for a SmartRecruiters oneclick-ui form that had only advanced from
 * its fill step to its screening step, and the destination it recorded is still
 * in the row. Loading that exact URL back gives a page whose title is
 * "Preliminary questions - Software Engineer IV (Hybrid - Onsite 2x/week) -
 * Vestcom" and whose `document.body.innerText` is 2144 characters, both matching
 * the row character for character. `AVERY_DENNISON_SCREENING` below is that
 * page, so the case this test pins is the run that happened rather than a
 * reconstruction of it.
 *
 * Two things found on that live page decide the shape of the fix, and both are
 * worth stating here because they are easy to assume the other way round:
 *
 *   · **It carries no applicant identity fields at all.** Walking its open
 *     shadow roots finds eleven controls — an attachments dropzone, radios,
 *     comboboxes, and EEO fields — and not one name, email or phone box. So
 *     "does the new page still have applicant fields on it" does NOT catch this
 *     page, and a fix resting on that signal alone would have left the bug in
 *     place. What catches it is the destination naming itself: the path segment
 *     `/screening` and the title prefix "Preliminary questions".
 *
 *   · **Those names are the board's own.** SmartRecruiters ships a route to
 *     title map in its i18n bundle with exactly two entries,
 *     `page.title.prefix.form` = "Easy apply" and `page.title.prefix.screening`
 *     = "Preliminary questions". The matcher is pinned to a string the platform
 *     generates, not to one company's copy.
 *
 * The other half matters as much and is the one the ticket warns about twice. A
 * board that legitimately answers a submit by redirecting to a thank you page
 * must still be recognised, because a row that under reports a real submission
 * invites something upstream to submit again. SmartRecruiters' own success
 * wording is in the same bundle — `application-success-page.header` =
 * "Application submitted!" and `application-success-page.details` = "Your
 * application for [JOB_TITLE] at [BRAND_NAME] has been submitted successfully.
 * You'll receive a confirmation email shortly." — so the positive cases below
 * are quoted from the same source as the negative one.
 */
import { describe, expect, it } from "vitest";

import { judgeSubmission, readsAsFurtherStep, type ConfirmationCapture } from "@/lib/submit-application";

/** A capture with every signal negative, so each case states only what it changes. */
const capture = (over: Partial<ConfirmationCapture>): ConfirmationCapture => ({
  confirmationPresent: false,
  confirmationText: "",
  confirmationReference: "",
  emailConfirmationPromised: false,
  applicationFormStillPresent: false,
  validationErrorsShown: false,
  validationErrorText: "",
  securityCodeRequested: false,
  url: "https://example.com/apply",
  title: "Apply",
  textLength: 0,
  codePromptInText: false,
  automationRejection: null,
  identityFieldsPresent: false,
  ...over,
});

/** Where the filled form was when the submit control was clicked. */
const FILL_STEP =
  "https://jobs.smartrecruiters.com/oneclick-ui/company/AveryDennison/publication/" +
  "6902435e-3fe5-4558-9424-666f0ecddc5b/form?dcr_ci=AveryDennison";

/** The page the run actually landed on, read back off the live board. */
const AVERY_DENNISON_SCREENING = capture({
  // `confirmation page: false, form gone: false, navigated: true` — the three
  // signals the pipeline logged for itself before writing `submitted`.
  confirmationPresent: false,
  applicationFormStillPresent: true,
  url:
    "https://jobs.smartrecruiters.com/oneclick-ui/company/AveryDennison/publication/" +
    "6902435e-3fe5-4558-9424-666f0ecddc5b/screening?dcr_ci=AveryDennison",
  title: "Preliminary questions - Software Engineer IV (Hybrid - Onsite 2x/week) - Vestcom",
  textLength: 2144,
  // Verified against the live page: no name, email or phone control anywhere,
  // shadow roots included.
  identityFieldsPresent: false,
});

describe("JOB-106: the run that wrote `submitted` for a wizard step", () => {
  it("does not read the Avery Dennison screening page as a submission", () => {
    const verdict = judgeSubmission(AVERY_DENNISON_SCREENING, FILL_STEP);
    expect(verdict.submitted).toBe(false);
  });

  it("says which of the two things happened, so the row can explain itself", () => {
    const verdict = judgeSubmission(AVERY_DENNISON_SCREENING, FILL_STEP);
    expect(verdict.navigated).toBe(true);
    expect(verdict.continuedToFurtherStep).toBe(true);
    // The evidence string is what reaches the log and the skip row. It has to
    // name the signal that used to carry this on its own.
    expect(verdict.evidence).toContain("navigated: true");
    expect(verdict.evidence).toContain("destination reads as a further step: true");
  });

  it("catches the page by its path and by its title independently", () => {
    // Either alone has to be enough. The title is the board's own
    // `page.title.prefix.screening`; the path is its own route. A board that
    // renamed one of them would still be caught by the other.
    const titleOnly = capture({
      ...AVERY_DENNISON_SCREENING,
      url: "https://jobs.smartrecruiters.com/oneclick-ui/company/AveryDennison/publication/x/next",
    });
    const pathOnly = capture({
      ...AVERY_DENNISON_SCREENING,
      title: "Software Engineer IV (Hybrid - Onsite 2x/week) - Vestcom",
    });
    expect(readsAsFurtherStep(titleOnly, FILL_STEP)).toBe(true);
    expect(readsAsFurtherStep(pathOnly, FILL_STEP)).toBe(true);
  });

  it("still refuses it when the model reports the form as gone", () => {
    // The model happened to say the form was still present on the real run. On
    // a screening step that answer could easily go the other way, because the
    // page genuinely holds no applicant identity fields — which is exactly why
    // "the form has gone" is not allowed to carry a submission by itself when
    // the destination names itself a step.
    const formReportedGone = capture({
      ...AVERY_DENNISON_SCREENING,
      applicationFormStillPresent: false,
    });
    expect(judgeSubmission(formReportedGone, FILL_STEP).submitted).toBe(false);
  });

  it("refuses bare navigation on its own, whatever the destination is called", () => {
    // The general form of the bug, with every step-shaped name removed from the
    // destination. Nothing here says a submission happened except that the URL
    // changed, and that is not what it means.
    const onlyTheUrlChanged = capture({
      applicationFormStillPresent: true,
      url: "https://boards.example.com/apply/two",
      title: "Apply",
    });
    expect(
      judgeSubmission(onlyTheUrlChanged, "https://boards.example.com/apply/one").submitted
    ).toBe(false);
  });
});

describe("JOB-106: a board that genuinely confirms is still recognised", () => {
  it("accepts SmartRecruiters' own success page", () => {
    // `application-success-page.header` and `.details`, verbatim from the
    // board's i18n bundle. This is what the run should have reached.
    const success = capture({
      confirmationPresent: true,
      confirmationText:
        "Application submitted! Your application for Software Engineer IV at Avery Dennison has " +
        "been submitted successfully. You’ll receive a confirmation email shortly.",
      emailConfirmationPromised: true,
      applicationFormStillPresent: false,
      url:
        "https://jobs.smartrecruiters.com/oneclick-ui/company/AveryDennison/publication/" +
        "6902435e-3fe5-4558-9424-666f0ecddc5b/success",
      title: "Application submitted! - Software Engineer IV",
    });
    expect(judgeSubmission(success, FILL_STEP).submitted).toBe(true);
  });

  it("accepts a redirect to a thank you page whose wording the model missed", () => {
    // The second, independent route to `submitted`, and the one that keeps this
    // change from costing a real submission when `confirmationPresent` comes
    // back false on a page that plainly is a receipt. The form is gone and the
    // destination does not name itself a step.
    const thankYou = capture({
      confirmationPresent: false,
      applicationFormStillPresent: false,
      url: "https://boards.greenhouse.io/acme/jobs/123/thank-you",
      title: "Thank you for applying",
    });
    expect(judgeSubmission(thankYou, "https://boards.greenhouse.io/acme/jobs/123").submitted).toBe(
      true
    );
  });

  it("accepts a board that confirms in place without navigating", () => {
    // Same URL, form replaced by a confirmation. `samePage` is true here, so the
    // path check is meaningless and is deliberately not applied: the path under
    // examination would be the form's own.
    const inPlace = capture({
      confirmationPresent: false,
      applicationFormStillPresent: false,
      url: "https://apply.workable.com/j/A15A62A8BE/apply",
      title: "Apply",
    });
    expect(
      judgeSubmission(inPlace, "https://apply.workable.com/j/A15A62A8BE/apply").submitted
    ).toBe(true);
  });

  it("is not fooled by a step-shaped URL on a page that announces the submission", () => {
    // The over-correction this guards against. A board free to host its receipt
    // at a URL containing a step word must not have it read as a step, so the
    // destination announcing a completed submission vetoes the further-step
    // reading before any path matching happens.
    const receiptAtAStepUrl = capture({
      confirmationPresent: false,
      applicationFormStillPresent: false,
      url: "https://boards.example.com/application/questions/confirmation",
      title: "Application received",
    });
    expect(readsAsFurtherStep(receiptAtAStepUrl, "https://boards.example.com/application")).toBe(
      false
    );
    expect(
      judgeSubmission(receiptAtAStepUrl, "https://boards.example.com/application").submitted
    ).toBe(true);
  });

  it("lets the board's own words carry a submission even from a step-shaped page", () => {
    // `confirmationPresent` stays sufficient on its own. That is deliberate: it
    // is the strongest signal available, and weakening it is the direction that
    // gets a real submission recorded as a failure and possibly submitted twice.
    const confirmedOnAStepUrl = capture({
      ...AVERY_DENNISON_SCREENING,
      confirmationPresent: true,
      confirmationText: "Your application has been submitted.",
    });
    expect(judgeSubmission(confirmedOnAStepUrl, FILL_STEP).submitted).toBe(true);
  });
});

describe("JOB-106: the DOM floor under the model's `form has gone`", () => {
  it("refuses `form gone` when the DOM still shows applicant identity fields", () => {
    // JOB-052's floor, reused rather than re-implemented, and applied on the far
    // side of the click. "The form has gone" is the only route to a terminal
    // `submitted` that does not go through the board's own words, so it does not
    // get to rest on a model's reading when `querySelectorAll` disagrees.
    const modelSaysGoneDomSaysNo = capture({
      confirmationPresent: false,
      applicationFormStillPresent: false,
      identityFieldsPresent: true,
      url: "https://boards.example.com/apply/step-two",
      title: "Apply",
    });
    const verdict = judgeSubmission(modelSaysGoneDomSaysNo, "https://boards.example.com/apply");
    expect(verdict.submitted).toBe(false);
    expect(verdict.evidence).toContain("form gone: false");
  });

  it("does not let the floor block a real confirmation", () => {
    // The floor only ever withholds a `submitted` reached through "the form has
    // gone". A board saying so in words is unaffected.
    const confirmedWithFieldsAround = capture({
      confirmationPresent: true,
      identityFieldsPresent: true,
      url: "https://boards.example.com/apply/thank-you",
      title: "Thank you",
    });
    expect(judgeSubmission(confirmedWithFieldsAround, "https://boards.example.com/apply").submitted).toBe(
      true
    );
  });
});

describe("JOB-106: further-step names, and the ones deliberately left out", () => {
  const from = "https://boards.example.com/apply";
  const at = (url: string, title = "Apply") =>
    readsAsFurtherStep(capture({ url, title }), from);

  it.each([
    ["https://boards.example.com/apply/screening"],
    ["https://boards.example.com/apply/questions"],
    ["https://boards.example.com/apply/additional-information"],
    ["https://boards.example.com/apply/additional-info"],
    ["https://boards.example.com/apply/assessment"],
    ["https://boards.example.com/apply/eeo"],
    ["https://boards.example.com/apply/voluntary-self-identification"],
    ["https://boards.example.com/apply/step-2"],
  ])("reads %s as a further step", (url) => {
    expect(at(url)).toBe(true);
  });

  it.each([
    ["Preliminary questions - Software Engineer"],
    ["Additional questions"],
    ["Screening questions"],
    ["Additional information"],
    ["Step 2 of 3 - Apply"],
  ])("reads the title %j as a further step", (title) => {
    expect(at("https://boards.example.com/next", title)).toBe(true);
  });

  it.each([
    // These name the form's own page as often as they name a step, and a board
    // that answers a submit in place would be wrongly refused if they were in
    // the path list. Their absence is the deliberate half of the design.
    ["https://boards.example.com/apply/apply"],
    ["https://boards.example.com/apply/form"],
    ["https://boards.example.com/apply/application"],
    ["https://boards.example.com/apply/review"],
  ])("does not read %s as a further step", (url) => {
    expect(at(url)).toBe(false);
  });

  it.each([
    // The job's own title rides in the page title and, slugged, in the path.
    // A confirmation lexicon built from bare words would read every one of
    // these as a receipt and switch this whole guard off for the listing —
    // restoring the original bug for a common class of role while still looking
    // like it worked. None of the 966 rows in `jobs` collides today, which is
    // exactly why this would go unnoticed until one did.
    ["Preliminary questions - Customer Success Engineer - Acme"],
    ["Preliminary questions - Director of Customer Success - Success Academy"],
  ])("is not talked out of %j by a job title", (title) => {
    expect(at("https://boards.example.com/apply/screening", title)).toBe(true);
  });

  it("is not talked out of a step by a job title in the path slug", () => {
    expect(
      at("https://boards.example.com/jobs/customer-success-engineer/screening", "Apply")
    ).toBe(true);
  });

  it("does not read the page it started on as a further step", () => {
    // A board that confirms in place has not moved, so its path is the form's
    // own and asking whether it looks like a step is asking about where we
    // already were. "Easy apply" is deliberately not a further-step title for
    // the same reason.
    expect(
      readsAsFurtherStep(
        capture({ url: `${from}/questions`, title: "Easy apply" }),
        `${from}/questions`
      )
    ).toBe(false);
  });
});
