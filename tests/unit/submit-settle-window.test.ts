// @vitest-environment node
/**
 * JOB-133 — when the page after the submit click is read.
 *
 * The run at the centre of this file is not invented either. Application
 * `634828a1-35a3-4453-8ded-0a9e35878825` is this project's first genuinely
 * confirmed submission: Avery Dennison / Vestcom on SmartRecruiters, verified
 * afterwards by the board's own `/success` page and by the employer's
 * confirmation email 54 seconds later. It was recorded as
 * `submission_unconfirmed`, `submitted: false`, and the payload it wrote
 * disagrees with itself:
 *
 *   · the reason string cites the form still on screen at `.../screening`;
 *   · `finalUrl`, re-read moments later off the same browser, is `.../success`;
 *   · the employer's own confirmation email arrived 54 seconds later.
 *
 * Every signal was read correctly. The page they were read off was the wrong
 * one, and not by much: the no-confirmation artifact stamped `03:51:44.553` is
 * already the success page, DOM dump and all, and its screenshot is
 * byte-for-byte identical to the final one stamped `03:51:47`. That capture
 * runs immediately after the reading, so the board landed within a few hundred
 * milliseconds of being asked what it showed.
 *
 * `tests/unit/submit-evidence.test.ts` pins what a page means once it has been
 * read, and none of that moves here. What this pins is the half JOB-133 adds:
 * that the reading is taken after the board has stopped moving, that a board
 * which is genuinely finished still costs one look, and that a genuine failure
 * is still reported as one rather than waited into a success.
 */
import { describe, expect, it } from "vitest";
import { type Page } from "@browserbasehq/stagehand";

import {
  describeStaleJudgement,
  judgeSubmission,
  readSettledConfirmation,
  waitForPostClickSettle,
  type ConfirmationCapture,
  type SettleBounds,
  type SettleWindow,
} from "@/lib/submit-application";
import { type BrowserSession } from "@/lib/stagehand-session";

/**
 * A window small enough to run in a test, standing in for the eight second one
 * the pipeline uses. The loop under test is the same loop either way; what the
 * production numbers are is a judgement about boards, and it is recorded in the
 * evidence string on every run rather than pinned here.
 */
const FAST: SettleBounds = { budgetMs: 600, pollMs: 100 };

type Look = { url: string; title: string };

/**
 * A page that reads back a scripted sequence of URL and title pairs, one pair
 * per look, holding on the last entry once the script runs out.
 *
 * `waitForPostClickSettle` reads the two together, so both counters advance and
 * the look index is the pair index. Written that way rather than counting
 * `url()` alone so the fake does not depend on which of the two the helper
 * happens to ask for first.
 */
function scriptedPage(script: Look[]): { page: Page; looks: () => number } {
  let calls = 0;
  const at = (): Look => script[Math.min(Math.floor(calls / 2), script.length - 1)]!;
  const page = {
    url: () => {
      const value = at().url;
      calls += 1;
      return Promise.resolve(value);
    },
    title: () => {
      const value = at().title;
      calls += 1;
      return Promise.resolve(value);
    },
  };
  return { page: page as unknown as Page, looks: () => Math.floor(calls / 2) };
}

/** Repeats a look, so a script reads as "this, until that". */
const held = (look: Look, times: number): Look[] => Array.from({ length: times }, () => look);

// ── The Avery Dennison run, as the board actually rendered it ────────────────

const CLICKED_AT =
  "https://jobs.smartrecruiters.com/oneclick-ui/company/AveryDennison/publication/" +
  "6902435e-3fe5-4558-9424-666f0ecddc5b/screening?dcr_ci=AveryDennison";

/** What the browser still showed when the run read it, three seconds too early. */
const SCREENING: Look = {
  url: CLICKED_AT,
  title: "Preliminary questions - Software Engineer IV (Hybrid - Onsite 2x/week) - Vestcom",
};

/**
 * Where the board was going, taken from the row's own `finalUrl` and
 * `pageTitle` rather than from the board's i18n bundle.
 *
 * Worth noting which of the two this is: the title the run recorded carries no
 * confirmation wording at all, only the loss of the "Preliminary questions"
 * prefix. So this fixture is the harder one, and it is the real one.
 */
const SUCCESS: Look = {
  url:
    "https://jobs.smartrecruiters.com/oneclick-ui/company/AveryDennison/publication/" +
    "6902435e-3fe5-4558-9424-666f0ecddc5b/success?dcr_ci=AveryDennison",
  title: "Software Engineer IV (Hybrid - Onsite 2x/week) - Vestcom",
};

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

describe("JOB-133: the run that read the page three seconds too early", () => {
  it("keeps looking while the board is still on the step it was clicked from", async () => {
    // The whole bug in one assertion. The page holds at `/screening` for three
    // looks and then lands on `/success`; a single read would have taken the
    // first of those, which is what the run did.
    const { page, looks } = scriptedPage([...held(SCREENING, 3), SUCCESS]);
    const settle = await waitForPostClickSettle(page, CLICKED_AT, FAST);
    expect(settle.exit).toBe("landed");
    expect(settle.looks).toBe(4);
    expect(looks()).toBe(4);
    expect(settle.waitedMs).toBeLessThan(FAST.budgetMs);
  });

  it("reaches the opposite verdict on the two pages, which is why the timing decides it", () => {
    // Neither of these is a new rule; both come straight from JOB-106/JOB-124's
    // `judgeSubmission`. What this states is that the two pages disagree about
    // the outcome, so which one gets read is the whole answer.
    const early = capture({
      applicationFormStillPresent: true,
      url: SCREENING.url,
      title: SCREENING.title,
    });
    const late = capture({
      confirmationPresent: true,
      confirmationText: "Application submitted!",
      emailConfirmationPromised: true,
      url: SUCCESS.url,
      title: SUCCESS.title,
    });
    expect(judgeSubmission(early, CLICKED_AT).submitted).toBe(false);
    expect(judgeSubmission(late, CLICKED_AT).submitted).toBe(true);
  });

  it("does not treat the screening step it was clicked from as somewhere to stop", async () => {
    // `/screening` is where the click happened, so there is no navigation here
    // at all. The window has to run out rather than read a page the board never
    // left, which is the same thing said from the other side.
    const { page } = scriptedPage(held(SCREENING, 1));
    const settle = await waitForPostClickSettle(page, CLICKED_AT, FAST);
    expect(settle.exit).toBe("budget");
    expect(settle.looks).toBeGreaterThan(1);
  });
});

describe("JOB-133: what the window stops for and what it does not", () => {
  it("stops on the first look when the board has already landed", async () => {
    // The cost of this on a board that redirects immediately has to be one
    // look and no sleep, or the fix pays for itself on every application.
    const { page } = scriptedPage([
      { url: "https://boards.greenhouse.io/acme/jobs/123/thank-you", title: "Thank you for applying" },
    ]);
    const settle = await waitForPostClickSettle(
      page,
      "https://boards.greenhouse.io/acme/jobs/123",
      FAST
    );
    expect(settle.exit).toBe("landed");
    expect(settle.looks).toBe(1);
    expect(settle.waitedMs).toBeLessThan(FAST.pollMs);
  });

  it("keeps waiting on a wizard advance, because a step is not a landing", async () => {
    // JOB-106's case, and the premise of the Avery Dennison one: the board
    // moved, and where it moved to names itself another step of the same
    // application. Stopping here is what would have read `/screening` and
    // called it the answer.
    const { page } = scriptedPage(
      held(
        {
          url: "https://jobs.smartrecruiters.com/oneclick-ui/company/X/publication/y/screening",
          title: "Preliminary questions - Engineer - X",
        },
        1
      )
    );
    const settle = await waitForPostClickSettle(
      page,
      "https://jobs.smartrecruiters.com/oneclick-ui/company/X/publication/y/form",
      FAST
    );
    expect(settle.exit).toBe("budget");
    expect(settle.looks).toBeGreaterThan(1);
  });

  it("waits out the window on a form that never moves, and reports it as a failure", async () => {
    // The direction this must not break. A board that rejected the submission
    // leaves the form exactly where it was; waiting longer must not turn that
    // into anything, and the verdict on what is finally read is unchanged.
    const stuck: Look = {
      url: "https://boards.example.com/acme/apply",
      title: "Apply to Acme",
    };
    const { page } = scriptedPage(held(stuck, 1));
    const settle = await waitForPostClickSettle(page, stuck.url, FAST);
    expect(settle.exit).toBe("budget");
    expect(settle.waitedMs).toBeGreaterThanOrEqual(FAST.budgetMs - FAST.pollMs);

    const stillOnTheForm = capture({
      applicationFormStillPresent: true,
      identityFieldsPresent: true,
      validationErrorsShown: true,
      validationErrorText: "Please complete all required fields.",
      url: stuck.url,
      title: stuck.title,
      settle: { ...settle, reads: 1 },
    });
    expect(judgeSubmission(stillOnTheForm, stuck.url).submitted).toBe(false);
  });

  it("does not invent a landing when the board goes somewhere unrelated", async () => {
    // Waiting only decides when to look. What is looked at is still judged by
    // `judgeSubmission`, and a page that confirms nothing and still holds the
    // applicant's fields is not a submission however long it took to arrive.
    const { page } = scriptedPage([
      ...held(SCREENING, 2),
      { url: "https://jobs.smartrecruiters.com/oneclick-ui/company/AveryDennison/error", title: "Error" },
    ]);
    const settle = await waitForPostClickSettle(page, CLICKED_AT, FAST);
    expect(settle.exit).toBe("landed");

    const errorPage = capture({
      applicationFormStillPresent: true,
      identityFieldsPresent: true,
      url: "https://jobs.smartrecruiters.com/oneclick-ui/company/AveryDennison/error",
      title: "Error",
      settle: { ...settle, reads: 1 },
    });
    expect(judgeSubmission(errorPage, CLICKED_AT).submitted).toBe(false);
  });

  it("ends without throwing when the page cannot be read at all", async () => {
    // Every caller of this is past the point of no return, where an exception
    // is the one outcome that must not happen: it leaves through an error path,
    // and an error path is something that can decide to retry. An unreadable
    // page ends the wait and lets `readConfirmation` be the call that reports
    // it, since the caller already knows how to describe that failure.
    const dead = {
      url: () => Promise.reject(new Error("Target page, context or browser has been closed")),
      title: () => Promise.reject(new Error("Target page, context or browser has been closed")),
    } as unknown as Page;
    const settle = await waitForPostClickSettle(dead, CLICKED_AT, FAST);
    expect(settle.exit).toBe("unreadable");
    expect(settle.looks).toBe(0);
  });
});

/**
 * A board that finishes navigating while the page is being read.
 *
 * This is the shape the recording says the real run had. The failure-point
 * artifacts stamped `03:51:44.553` are already the success page — the DOM dump
 * holds `<oc-success-page>` and its screenshot is byte-for-byte identical to
 * the final one taken three seconds later — and they were written immediately
 * after `readConfirmation` returned `/screening`. So the board landed while the
 * reading was in flight, which is the one case a window alone cannot be sized
 * against.
 *
 * `at` advances one step each time the page is read, so a board given two
 * destinations moves once and then stays.
 */
function boardThatMovesUnderTheReading(script: Look[]): {
  session: BrowserSession;
  read: (session: BrowserSession) => Promise<ConfirmationCapture>;
  readCount: () => number;
} {
  let index = 0;
  const at = (): Look => script[Math.min(index, script.length - 1)]!;
  const page = {
    url: () => Promise.resolve(at().url),
    title: () => Promise.resolve(at().title),
  } as unknown as Page;
  let readCount = 0;
  const read = (): Promise<ConfirmationCapture> => {
    const describing = at();
    readCount += 1;
    index += 1;
    const isReceipt = describing.url.includes("/success");
    return Promise.resolve(
      capture({
        confirmationPresent: isReceipt,
        confirmationText: isReceipt ? "Application submitted!" : "",
        applicationFormStillPresent: !isReceipt,
        url: describing.url,
        title: describing.title,
      })
    );
  };
  return { session: { page } as unknown as BrowserSession, read, readCount: () => readCount };
}

describe("JOB-133: a reading the board moved out from under is taken again", () => {
  it("re-reads the Avery Dennison page and reaches the verdict its own board supports", async () => {
    // End to end on the run this ticket is named for, with the window expiring
    // rather than catching it — the case the artifacts leave open, because how
    // long that board took to land cannot be recovered from them. The reading
    // still ends up describing `/success`, which is what the employer's own
    // confirmation email said 54 seconds later.
    const { session, read, readCount } = boardThatMovesUnderTheReading([SCREENING, SUCCESS]);
    const settled = await readSettledConfirmation(session, CLICKED_AT, "the submit click", {
      read,
      bounds: FAST,
    });
    expect(readCount()).toBe(2);
    expect(settled.url).toBe(SUCCESS.url);
    expect(settled.settle?.reads).toBe(2);
    expect(judgeSubmission(settled, CLICKED_AT).submitted).toBe(true);
  });

  it("reads a page that stays put exactly once, whatever it said", async () => {
    // The trigger is the board moving, not the answer being unwelcome. A form
    // still sitting there after a rejected submission is read once and filed as
    // what it is; nothing here gets a second look at a verdict it disliked.
    const stuck: Look = { url: "https://boards.example.com/acme/apply", title: "Apply to Acme" };
    const { session, read, readCount } = boardThatMovesUnderTheReading([stuck]);
    const settled = await readSettledConfirmation(session, stuck.url, "the submit click", {
      read,
      bounds: FAST,
    });
    expect(readCount()).toBe(1);
    expect(settled.settle?.reads).toBe(1);
    expect(judgeSubmission(settled, stuck.url).submitted).toBe(false);
  });

  it("stops at two readings even on a board that keeps moving", async () => {
    // The ceiling, stated as a test rather than as a comment. Two is the cap in
    // the same spirit as the two click maximum this file is built around: a
    // check that keeps re-running until it likes what it sees is not a check,
    // and `describeStalePage` is what reports anything past it instead.
    const onward: Look = {
      url: "https://jobs.smartrecruiters.com/oneclick-ui/company/AveryDennison/somewhere-else",
      title: "Somewhere else",
    };
    const { session, read, readCount } = boardThatMovesUnderTheReading([SCREENING, SUCCESS, onward]);
    const settled = await readSettledConfirmation(session, CLICKED_AT, "the submit click", {
      read,
      bounds: FAST,
    });
    expect(readCount()).toBe(2);
    expect(settled.url).toBe(SUCCESS.url);
    expect(settled.settle?.reads).toBe(2);
  });
});

describe("JOB-133: the window is written down where the next occurrence will be read", () => {
  it("puts the wait, the bound and how it ended into the evidence string", () => {
    // The four signals in this string were all correct on the run that caused
    // this ticket, and none of them said when they were read. That is the fact
    // that would have made it diagnosable rather than mysterious, so it is now
    // recorded next to them on every outcome.
    const settle: SettleWindow = {
      waitedMs: 3_250,
      budgetMs: 8_000,
      looks: 14,
      exit: "landed",
      reads: 1,
    };
    const { evidence } = judgeSubmission(
      capture({ confirmationPresent: true, url: SUCCESS.url, title: SUCCESS.title, settle }),
      CLICKED_AT
    );
    expect(evidence).toContain("confirmation page: true");
    expect(evidence).toContain("destination reads as a further step: false");
    expect(evidence).toContain("3250ms");
    expect(evidence).toContain("8000ms");
    expect(evidence).toContain("14 look(s)");
    expect(evidence).toContain("ended: landed");
  });

  it("leaves the string exactly as it was for a capture taken without a window", () => {
    // Every capture a unit test builds by hand has no window on it, and the
    // strings those pin are the strings a human has learned to read. Nothing is
    // appended when there is nothing to append.
    const { evidence } = judgeSubmission(capture({ url: SUCCESS.url, title: SUCCESS.title }), CLICKED_AT);
    expect(evidence).not.toContain("window");
    expect(evidence).toBe(
      "confirmation page: false, form gone: true, navigated: true, " +
        "destination reads as a further step: false"
    );
  });
});

describe("JOB-133: the payload that disagrees with itself now says so", () => {
  it("annotates a reason string describing a page the browser has left", () => {
    // The exact pair from the row: the reason cites `/screening`, the browser
    // is on `/success`. That disagreement sat inside one payload and told
    // nobody. It is now a sentence in the reason a human reads.
    const note = describeStaleJudgement(CLICKED_AT, SUCCESS.url);
    expect(note).toContain("JOB-133");
    expect(note).toContain("/success");
    expect(note).toContain("/screening");
    expect(note).toContain("stale");
  });

  it("says nothing when the reason describes the page the browser is on", () => {
    // Which is every normal outcome, so this must not decorate them.
    expect(describeStaleJudgement(CLICKED_AT, CLICKED_AT)).toBe("");
    // Query churn is not a different page, by `samePage`'s own rule.
    expect(describeStaleJudgement(CLICKED_AT, `${CLICKED_AT}&foo=bar`)).toBe("");
  });

  it("says nothing when there is nothing to compare", () => {
    // No reading was taken, or the browser has gone away. Neither is evidence
    // that the page moved, and this runs ahead of the write that records an
    // irreversible click, so silence is the only safe answer.
    expect(describeStaleJudgement(null, SUCCESS.url)).toBe("");
    expect(describeStaleJudgement(CLICKED_AT, null)).toBe("");
    expect(describeStaleJudgement(null, null)).toBe("");
  });
});
