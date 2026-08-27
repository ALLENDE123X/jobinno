// @vitest-environment node
/**
 * JOB-207 — the corroboration read after the submit click may not overrule the
 * board's own rejection words.
 *
 * The 2026 08 27 Ramp / Ashby run is the case this exists for.
 * `applications.2280c73c-54b9-4035-b368-3507cda937ed` went to `submitted` —
 * terminal, never revisited — because Ashby's rejection page replaced the form
 * itself with its "flagged as possible spam" message. That collapsed
 * `applicationFormStillPresent` to false, `judgeSubmission` read the missing
 * form as a confirmation whose wording the model had failed to name, and
 * `succeed()` fired against a row the employer had refused. `capture.
 * automationRejection` had already extracted the accusation from the same page,
 * and it was consulted only inside a downstream branch that this outcome could
 * not reach.
 *
 * The regression this test writes down is the invariant that fixes it, at the
 * only layer this file can exercise from a unit test: the board's own accusation
 * outranks every positive signal `judgeSubmission` reads from the page.
 *
 * `runSubmitPhase` itself opens a Browserbase browser, calls out to Stagehand
 * and writes to Supabase, none of which a unit test can drive without a fleet
 * of mocks whose fidelity would decide whether the test is actually pinning
 * production behaviour. `judgeSubmission` is the pure-function seam that
 * decides `submitted` vs anything else, and pinning its behaviour here is what
 * makes the fix regressable rather than a coincidence.
 */
import { describe, expect, it } from "vitest";

import {
  REJECTED_CONFIRMATION_TEXT_PREFIX,
  boardRejectedAsAutomated,
  buildRejectedConfirmationText,
  judgeSubmission,
  type ConfirmationCapture,
} from "@/lib/submit-application";

/** A capture with every signal negative — same shape as `submit-evidence.test`. */
const capture = (over: Partial<ConfirmationCapture>): ConfirmationCapture => ({
  confirmationPresent: false,
  confirmationText: "",
  confirmationReference: "",
  emailConfirmationPromised: false,
  applicationFormStillPresent: false,
  validationErrorsShown: false,
  validationErrorText: "",
  securityCodeRequested: false,
  url: "https://jobs.ashbyhq.com/ramp/apply",
  title: "Apply — Ramp",
  textLength: 0,
  codePromptInText: false,
  automationRejection: null,
  identityFieldsPresent: false,
  ...over,
});

/** Where the filled form was when the submit control was clicked. */
const FILL_STEP = "https://jobs.ashbyhq.com/ramp/apply";

/**
 * The shape the 2026 08 27 Ramp / Ashby capture actually took: the form was
 * replaced by the rejection page in place, so `applicationFormStillPresent`
 * read as false, the URL did not change (Ashby renders the rejection under the
 * same route), and no further-step marker fires. Before JOB-207 this ended at
 * `succeed()` — the exact bug — because the "form has gone and no further step"
 * branch of `judgeSubmission` fired.
 */
const ASHBY_REJECTION = capture({
  applicationFormStillPresent: false,
  identityFieldsPresent: false,
  automationRejection:
    "We couldn't submit your application. Your application submission was flagged as " +
    "possible spam. If you believe this was a mistake, please submit your application again.",
});

describe("JOB-207: the corroboration read cannot overrule the board's own rejection", () => {
  it("does not read the Ashby rejection page as a submission", () => {
    const verdict = judgeSubmission(ASHBY_REJECTION, FILL_STEP);
    expect(verdict.submitted).toBe(false);
  });

  it("would have read the same capture as a submission without the rejection quote", () => {
    // Sanity: this is the exact bug. With `automationRejection` cleared, the
    // capture reaches `!formStillPresent && !continuedToFurtherStep` and the
    // verdict flips to `submitted`. That is the shape production wrote
    // `submitted` on, and this pin makes that failure mode explicit.
    const withoutQuote = { ...ASHBY_REJECTION, automationRejection: null };
    const verdict = judgeSubmission(withoutQuote, FILL_STEP);
    expect(verdict.submitted).toBe(true);
  });

  it("vetoes `submitted` even when the model called the page a confirmation", () => {
    // A false positive on `confirmationPresent` — e.g. the model hallucinated a
    // receipt off the rejection page's own heading — must not be enough to
    // reach `succeed()` when the board's own words say the opposite.
    const confused = capture({
      confirmationPresent: true,
      confirmationText: "Thank you for applying",
      automationRejection:
        "We couldn't submit your application. Your application submission was flagged as " +
        "possible spam.",
    });
    expect(judgeSubmission(confused, FILL_STEP).submitted).toBe(false);
  });

  it("still recognises a genuine confirmation on a page with no rejection text", () => {
    // The veto is scoped to the case the board itself makes: a page with no
    // rejection quote still resolves in the normal way, so this does not
    // regress the receipt path.
    const legit = capture({
      confirmationPresent: true,
      confirmationText: "Your application has been submitted",
      url: "https://jobs.ashbyhq.com/ramp/apply/success",
      title: "Application submitted",
    });
    expect(judgeSubmission(legit, FILL_STEP).submitted).toBe(true);
  });
});

describe("JOB-207 review round 2: bot-adjacent success copy must not downgrade a real submit", () => {
  // Before JOB-207 tightened `AUTOMATION_REJECTION_RE`, the regex matched bare
  // noun phrases like "bot traffic", "bot activity", "automated submissions" and
  // "flagged as spam" without any subject naming the current attempt. That was
  // safe when a match only relabelled an already-negative outcome. It stopped
  // being safe when `judgeSubmission` started using it to VETO `submitted`, at
  // which point the same match on a real thank-you page would DOWNGRADE a
  // genuine successful submission to `submission_unconfirmed` (terminal, never
  // revisited). Adversarial review of PR #220 identified four legitimate-looking
  // success-page phrases the old regex would have matched. Each case below
  // builds a capture that reads as a real confirmation from the board's URL and
  // wording, layers the reviewer's phrase into the page text, and confirms the
  // verdict stays `submitted`.
  const legitConfirmation = (bodyPhrase: string): ConfirmationCapture =>
    capture({
      confirmationPresent: true,
      confirmationText: `Your application has been submitted. ${bodyPhrase}`,
      applicationFormStillPresent: false,
      identityFieldsPresent: false,
      url: "https://jobs.ashbyhq.com/ramp/apply/success",
      title: "Application submitted — Ramp",
      // The rejection regex runs off the page's own rendered text, which is
      // captured into `automationRejection` before `judgeSubmission` ever sees
      // the capture. Simulating that here directly is what pins the ordering
      // failure the reviewer described.
      automationRejection: boardRejectedAsAutomated(
        `Your application has been submitted. ${bodyPhrase}`
      ),
    });

  it.each([
    ["we monitor bot traffic on this site"],
    ["Our system helps prevent automated submissions in general."],
    ["This message may be flagged as spam by our filters — please add us to your allow list."],
    ["Bot activity prevention is enabled for this account."],
  ])(
    "reads a real confirmation carrying %j as `submitted`, not as a rejection",
    (bodyPhrase) => {
      const cap = legitConfirmation(bodyPhrase);
      // The regex itself must not flag the phrase as a rejection.
      expect(cap.automationRejection).toBeNull();
      // And the verdict has to stay `submitted: true`, because a false positive
      // here writes a terminal `submission_unconfirmed` over a real submit.
      expect(judgeSubmission(cap, FILL_STEP).submitted).toBe(true);
    }
  );

  it.each([
    // The four reviewer phrases in isolation, so a regression here is obvious.
    ["we monitor bot traffic on this site"],
    ["Our platform prevents automated submissions in general."],
    ["This message may be flagged as spam by our filters."],
    ["Bot activity prevention is enabled."],
    // Two more shapes the tightened regex was written to reject: help copy
    // that lists what the board watches for, and legal boilerplate.
    ["We use bot detection to keep our systems secure."],
    ["The site monitors bot activity to protect your account."],
    ["Applications flagged as spam by our filters are reviewed by our team."],
  ])("does not read %j as a rejection accusation on its own", (pageText) => {
    expect(boardRejectedAsAutomated(pageText)).toBeNull();
  });
});

describe("JOB-207: buildRejectedConfirmationText", () => {
  it("prefixes the quote with `rejected: ` so a row can identify itself", () => {
    // A human reading only `applications.confirmation_text` — not the skip log,
    // not the reason string — has to be able to tell a rejection apart from a
    // real receipt. The prefix is the whole point.
    const quote = boardRejectedAsAutomated(
      "We couldn't submit your application. Your application submission was flagged as " +
        "possible spam."
    );
    expect(quote).not.toBeNull();
    const text = buildRejectedConfirmationText(quote as string);
    expect(text.startsWith(REJECTED_CONFIRMATION_TEXT_PREFIX)).toBe(true);
    expect(text).toContain("flagged as possible spam");
  });

  it("caps the field at a size the downstream renderers can carry", () => {
    // No hard bound at the column level — the cap here is a UI concern — but
    // an unbounded rejection could still push past a truncating dashboard, so
    // the prefix is preserved and the quote is trimmed rather than the other
    // way round.
    const long = "flagged as possible spam ".repeat(200);
    const text = buildRejectedConfirmationText(long);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.startsWith(REJECTED_CONFIRMATION_TEXT_PREFIX)).toBe(true);
  });
});
