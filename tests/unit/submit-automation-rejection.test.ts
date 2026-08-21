// @vitest-environment node
/**
 * JOB-026 — `boardRejectedAsAutomated`, against the pages that produced it.
 *
 * The fixtures below are not written for this test. They are the exact strings
 * `readConfirmation` captured off five real boards on 2026 08 20 and 2026 08 21,
 * recovered from the Browserbase session replays for the five `applications`
 * rows that ended `submission_unconfirmed`, and pasted here unedited down to the
 * curly apostrophe in "it’s disabled". That provenance is the point of the file:
 * the matcher exists because those five pages said something the pipeline read,
 * tested for one unrelated thing, and threw away, so the regression test worth
 * having is the one that fails if any of those five stops being recognised.
 *
 * Five captures across three unrelated companies on one ATS, worded identically,
 * is also the evidence that this is Ashby's platform wide check rather than one
 * employer's configuration, which is what makes a shared reason code worth a
 * value of its own.
 *
 * The negative half matters as much and is easier to get wrong. A false positive
 * here files a validation error as bot detection and sends somebody off to
 * rebuild browser fingerprinting over a missing phone number, so the cases below
 * include the phrases that sit closest to the pattern without being it: a board
 * that could not submit for an ordinary reason, and a board showing an ordinary
 * robot check, which is `captcha` and a different stop entirely.
 */
import { describe, expect, it } from "vitest";

import { boardRejectedAsAutomated } from "@/lib/submit-application";

/** The Ashby refusal, verbatim. Three companies, five captures, one wording. */
const ashbyRejection = (heading: string) =>
  `${heading}\nLocation\n\nSan Francisco\n\nEmployment Type\n\nFull time\n\nLocation Type\n\n` +
  `On-site\n\nDepartment\n\nEngineering\n\nOverview\nApplication\n` +
  `We couldn't submit your application\n\n` +
  `Your application submission was flagged as possible spam. If you believe this was a ` +
  `mistake, please submit your application again.\n\nTry these steps\n\n` +
  `Legitimate applications are occasionally flagged by mistake. Try these in order:\n\n` +
  `Turn off your VPN or proxy\nUse your regular network connection instead.\n` +
  `Pause browser extensions\nTemporarily pause ad blockers and privacy tools.\n` +
  `Try another browser or device\nMake sure the browser is up to date.\n` +
  `Switch networks\nMobile data often works better than public Wi-Fi.\n` +
  `Still blocked?\nWait a few minutes and retry. As a last resort, enable JavaScript if ` +
  `it’s disabled, or clear this site’s cookies and cache in your browser settings.\n` +
  `Powered by \n\nPrivacy PolicySecurityVulnerability Disclosure`;

/** One per `submission_unconfirmed` row, keyed by the title on the page. */
const REAL_CAPTURES: ReadonlyArray<readonly [string, string]> = [
  ["Heliux, application be939590", "Software Engineer (Internship, Spring 2027)"],
  ["Heliux, application 18100e4a", "Software Engineer (Internship, Summer 2027)"],
  ["Pylon Labs, application 252a53d9", "Software Engineer, New Grad"],
  ["Netic, application a7cfbdb2", "Software Engineer (Agent Platform) - New Grad - 2026-2027"],
  ["Pylon Labs, application 10383d99", "Software Engineer, Intern"],
];

describe("boardRejectedAsAutomated", () => {
  it.each(REAL_CAPTURES)("recognises the page %s ended on", (_row, heading) => {
    const quote = boardRejectedAsAutomated(ashbyRejection(heading));
    expect(quote).not.toBeNull();
    // The accusation itself has to survive into the quote, because the quote is
    // what an operator reads in `skip_log.raw_context` and what tells them this
    // was the board's verdict rather than this pipeline's guess about it.
    expect(quote).toContain("flagged as possible spam");
  });

  it("quotes the board rather than paraphrasing it, and caps what it quotes", () => {
    const quote = boardRejectedAsAutomated(ashbyRejection("Software Engineer, Intern"));
    expect(quote).toBeTypeOf("string");
    // 300 characters plus a possible ellipsis. `skip_log.raw_context` has no
    // width limit, but a refusal page is mostly troubleshooting advice and none
    // of it is evidence about what happened.
    expect((quote as string).length).toBeLessThanOrEqual(301);
    // Collapsed to single spaces and stripped of control characters, like every
    // other piece of board text this module keeps.
    expect(quote).not.toMatch(/[\n\r\t]/);
  });

  it.each([
    // The other half of the same Ashby sentence. On its own it is not evidence
    // of anything: a board prints this for a rejected upload and for a missing
    // required field, and treating it as bot detection is the false positive
    // this pattern is deliberately narrow to avoid.
    ["We couldn't submit your application. Please check the fields marked below."],
    ["Unable to submit your application at this time. Please try again later."],
    // An ordinary robot check standing in front of the form. That is `captcha`,
    // found before anything is clicked, and a different stop with a different
    // fix. Filing it here would hide a solvable problem inside an unsolved one.
    ["Please complete the captcha to continue."],
    ["Verify you are human before submitting this application."],
    // Ordinary validation, and ordinary success.
    ["This field is required."],
    ["Thank you for applying! We have received your application."],
    ["Your application was submitted successfully. Reference ABC123."],
    [""],
  ])("does not read %j as the board calling this automated", (pageText) => {
    expect(boardRejectedAsAutomated(pageText)).toBeNull();
  });

  it.each([
    "Your submission was flagged as spam.",
    "This request was detected as a bot and blocked.",
    "We blocked this as automated traffic.",
    "Submission identified as automated.",
    "Blocked: suspected bot.",
  ])("recognises %j, so the next board to do this is not a silent regression", (pageText) => {
    // Ashby's exact wording is not the contract. The accusation is, because the
    // next ATS to reject a submission this way will phrase it its own way and
    // the failure mode of missing it is another run of unreadable
    // `submit_failed` rows.
    expect(boardRejectedAsAutomated(pageText)).not.toBeNull();
  });
});
