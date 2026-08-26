/**
 * JOB-053. Which of a form's file inputs the candidate's resume is allowed to
 * go into.
 *
 * The bug this pins: a real Virtu Financial posting on Greenhouse
 * (`job-boards.greenhouse.io/embed/job_app?for=virtu&token=6120518002`) renders
 * its resume and its cover letter uploads as two identical "Attach" buttons,
 * `observe()` ranked the cover letter first, and `resolveAction` takes the
 * first. The upload guard caught it and refused — the control described itself
 * as `"cover_letter | Attach | Attach"` — but refusing is not applying, and
 * 87% of the Greenhouse listings in the `jobs` table carry two or more file
 * inputs.
 *
 * ── Why this runs in jsdom against real markup ──────────────────────────────
 * Every fact this feature rests on is a fact about a DOM: that Greenhouse gives
 * the two inputs different ids, that `describeControlInPage` therefore reads
 * back different haystacks for them, and that the scanner can address each one
 * again afterwards. A stub page returning canned strings would assert only that
 * this file agrees with itself.
 *
 * So `page.evaluate` here really evaluates. The string it is handed is the one
 * `inPageExpression` builds, which puts the serialisation path under test too —
 * and that path has already shipped one silent failure: ACT-015, where esbuild's
 * `__name` helper made `describeControl` throw on its first line in the page and
 * report every control as "probably inside an iframe" for the life of the bug.
 *
 * The markup below is copied from that posting's HTML, not invented.
 */
import { describe, expect, it } from "vitest";

import {
  confirmAttachment,
  FIELD_KEYWORDS,
  resumeUploadFromDom,
} from "@/lib/fill-application-form";

import type { Page } from "@browserbasehq/stagehand";

/**
 * A page that is this jsdom document. Indirect `eval`, so the expression runs in
 * global scope where jsdom's `document` and `window` live, exactly as it would
 * in a browser.
 */
const pageOverDocument = (): Page =>
  ({
    evaluate: async (script: unknown) => (0, eval)(String(script)),
  }) as unknown as Page;

const render = (html: string): void => {
  document.body.innerHTML = html;
};

/**
 * One Greenhouse upload group, verbatim in shape from the Virtu posting:
 *
 *   <div role="group" aria-labelledby="upload-label-resume" ...>
 *     <div id="upload-label-resume" class="label upload-label">Resume/CV<span class="required">*</span></div>
 *     ... <button>Attach</button>
 *         <label class="visually-hidden" for="resume">Attach</label>
 *         <input id="resume" class="visually-hidden" type="file" ...>
 *
 * The visible caption sits in a sibling `<div>` rather than in a `<label>`, so
 * it is *not* what identifies the control — the `id` and the
 * `<label for=…>Attach</label>` are, which is why the haystack comes out as
 * `"resume | Attach | Attach"` and not as anything containing "Resume/CV".
 */
const uploadGroup = (key: string, caption: string): string => `
  <div class="field-wrapper">
    <div role="group" aria-labelledby="upload-label-${key}" class="file-upload" data-allow-s3="false">
      <div id="upload-label-${key}" class="label upload-label">${caption}</div>
      <div class="file-upload__wrapper">
        <div class="button-container">
          <div class="secondary-button"><div>
            <button type="button" class="btn btn--pill">Attach</button>
            <label class="visually-hidden" for="${key}">Attach</label>
            <input id="${key}" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" />
          </div></div>
          <div class="secondary-button"><div>
            <button type="button" class="btn btn--pill" data-testid="${key}-text">Enter manually</button>
            <label class="visually-hidden" for="${key}_text">Enter manually</label>
          </div></div>
        </div>
      </div>
    </div>
  </div>`;

/** Both attach controls, in the order the real page emits them. */
const GREENHOUSE_FULL_TIME =
  uploadGroup("resume", 'Resume/CV<span class="required">*</span>') +
  uploadGroup("cover_letter", "Cover Letter");

describe("the Greenhouse two-attach form", () => {
  it("picks the resume input and not the cover letter one", async () => {
    render(GREENHOUSE_FULL_TIME);

    const picked = await resumeUploadFromDom(pageOverDocument());

    expect(picked).not.toBeNull();
    expect(picked?.selector).toBe('input[type=file][id="resume"]');
    // The exact string the refusal in `attachResume` reported for the wrong
    // control, now read off the right one.
    expect(picked?.haystack).toBe("resume | Attach | Attach");
  });

  it("addresses the control it chose, and only that control", async () => {
    render(GREENHOUSE_FULL_TIME);

    const picked = await resumeUploadFromDom(pageOverDocument());
    const matches = document.querySelectorAll(picked!.selector);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(document.getElementById("resume"));
  });

  it("is the discrimination the first-match resolver did not make", async () => {
    // Both halves of the bug in one assertion: the two controls are visually
    // identical ("Attach" / "Attach"), and the DOM tells them apart anyway.
    render(GREENHOUSE_FULL_TIME);
    const resume = document.getElementById("resume")!;
    const cover = document.getElementById("cover_letter")!;

    expect(document.querySelector('label[for="resume"]')?.textContent?.trim()).toBe(
      document.querySelector('label[for="cover_letter"]')?.textContent?.trim()
    );
    expect(FIELD_KEYWORDS.resume.test(resume.id)).toBe(true);
    expect(FIELD_KEYWORDS.resume.test(cover.id)).toBe(false);
    expect(FIELD_KEYWORDS.coverLetter.test(cover.id)).toBe(true);
  });

  it("still picks the resume when the cover letter comes first", async () => {
    // Document order is not the signal. If it were, this test and the first one
    // could not both pass.
    render(
      uploadGroup("cover_letter", "Cover Letter") +
        uploadGroup("resume", 'Resume/CV<span class="required">*</span>')
    );

    const picked = await resumeUploadFromDom(pageOverDocument());

    expect(picked?.selector).toBe('input[type=file][id="resume"]');
  });

  it("ignores the extra uploads real postings carry alongside the resume", async () => {
    // Both seen in the sampled listings: SpaceX asks for a "Portfolio or Cover
    // Letter" and Appian for an unofficial transcript, each as a generated
    // `question_<id>` file input beside the resume.
    render(
      uploadGroup("resume", 'Resume/CV<span class="required">*</span>') +
        uploadGroup("question_35956410002", "Portfolio or Cover Letter") +
        uploadGroup("question_67916095", "Please upload a copy of an unofficial transcript.")
    );

    const picked = await resumeUploadFromDom(pageOverDocument());

    expect(picked?.selector).toBe('input[type=file][id="resume"]');
  });
});

describe("declining to answer", () => {
  it("says nothing when no upload names itself the resume", async () => {
    render(uploadGroup("cover_letter", "Cover Letter"));

    // Null rather than the cover letter. The caller falls through to
    // observe-and-corroborate, whose refusal is still in place.
    expect(await resumeUploadFromDom(pageOverDocument())).toBeNull();
  });

  it("says nothing about an unlabelled file input", async () => {
    render('<input type="file" />');

    expect(await resumeUploadFromDom(pageOverDocument())).toBeNull();
  });

  it("refuses a control that reads as the resume and the cover letter at once", async () => {
    render(`
      <div>
        <label for="attachment">Attach your resume or cover letter</label>
        <input id="attachment" type="file" />
      </div>`);

    expect(await resumeUploadFromDom(pageOverDocument())).toBeNull();
  });

  it("refuses to choose between two controls that both claim to be the resume", async () => {
    render(
      uploadGroup("resume", "Resume/CV") + uploadGroup("resume_backup", "Second resume")
    );

    expect(await resumeUploadFromDom(pageOverDocument())).toBeNull();
  });

  it("discards a selector that a duplicate id makes ambiguous", async () => {
    // Invalid HTML that boards ship anyway. `[id="resume"]` would resolve to the
    // first of the two, and setting a file on it would be an unverifiable guess
    // about which one the employer reads.
    render(
      '<div><label for="resume">Resume</label><input id="resume" type="file" /></div>' +
        '<div><label for="resume">Resume</label><input id="resume" type="file" /></div>'
    );

    expect(await resumeUploadFromDom(pageOverDocument())).toBeNull();
  });

  it("reports nothing on a page with no file inputs at all", async () => {
    render('<input type="text" id="resume" />');

    expect(await resumeUploadFromDom(pageOverDocument())).toBeNull();
  });

  it("never fails a run when the page cannot be read", async () => {
    render(GREENHOUSE_FULL_TIME);
    const broken = {
      evaluate: async () => {
        throw new Error("Execution context was destroyed");
      },
    } as unknown as Page;

    // A perception failure must not be able to stop an application the
    // model-driven path would have filled correctly.
    expect(await resumeUploadFromDom(broken)).toBeNull();
  });
});

describe("the region the read-back falls back to", () => {
  it("is the upload's own labelled block, not the whole form", async () => {
    render(GREENHOUSE_FULL_TIME);

    const picked = await resumeUploadFromDom(pageOverDocument());

    expect(picked?.region).toBe('[aria-labelledby="upload-label-resume"]');
    const region = document.querySelector(picked!.region!)!;
    // The cover letter's own upload lives outside it, which is the whole point:
    // a file name found in here is a file name on the resume row.
    expect(region.contains(document.getElementById("cover_letter"))).toBe(false);
    expect(region.contains(document.getElementById("resume"))).toBe(true);
  });

  it("survives the control being taken away, which is what Greenhouse does", async () => {
    // Verified against the live Virtu form: setting a file unmounts the
    // `<input type="file">` entirely and renders a chip naming the file in its
    // place, so the old read-back had nothing left to ask.
    render(GREENHOUSE_FULL_TIME);
    const picked = await resumeUploadFromDom(pageOverDocument());
    const region = picked!.region!;

    document.getElementById("resume")!.remove();
    document
      .querySelector(`${region} .file-upload__wrapper`)!
      .replaceChildren(
        Object.assign(document.createElement("p"), { textContent: "PRANAV-LENDE-Resume.pdf" })
      );

    expect(document.querySelector(picked!.selector)).toBeNull();
    expect(document.querySelector(region)?.textContent).toContain("PRANAV-LENDE-Resume.pdf");
  });

  it("never widens to a block holding another upload", async () => {
    // The wrapper carries an id and would otherwise be addressable, but it
    // holds both uploads — so "the resume is in here" could be satisfied by the
    // cover letter's own chip. Exactly the confusion this ticket is about.
    render(`<div id="uploads">${GREENHOUSE_FULL_TIME}</div>`);

    const picked = await resumeUploadFromDom(pageOverDocument());

    expect(picked?.region).toBe('[aria-labelledby="upload-label-resume"]');
  });

  it("never widens to the form itself", async () => {
    render(
      '<form id="application"><label for="resume">Resume</label>' +
        '<input id="resume" type="file" /></form>'
    );

    const picked = await resumeUploadFromDom(pageOverDocument());

    expect(picked?.selector).toBe('input[type=file][id="resume"]');
    expect(picked?.region).toBeNull();
  });

  it("is null when nothing around the control is addressable", async () => {
    render('<div><label for="cv">Resume</label><input id="cv" type="file" /></div>');

    const picked = await resumeUploadFromDom(pageOverDocument());

    expect(picked?.selector).toBe('input[type=file][id="cv"]');
    expect(picked?.region).toBeNull();
  });
});

describe("confirming that the file actually landed", () => {
  const RESUME_REGION = '[aria-labelledby="upload-label-resume"]';
  const SELECTOR = 'input[type=file][id="resume"]';
  const FILE = "PRANAV-LENDE-Resume.pdf";

  /** Replaces the attach controls with the chip Greenhouse renders instead. */
  const showChip = (name: string): void => {
    document.getElementById("resume")?.remove();
    document
      .querySelector(`${RESUME_REGION} .file-upload__wrapper`)!
      .replaceChildren(Object.assign(document.createElement("p"), { textContent: name }));
  };

  it("reads the file name out of the block when the board took the control away", async () => {
    render(GREENHOUSE_FULL_TIME);
    showChip(FILE);

    const result = await confirmAttachment(pageOverDocument(), SELECTOR, RESUME_REGION, FILE);

    expect(result.confirmed).toBe(true);
    expect(result).toMatchObject({ how: expect.stringContaining(FILE) });
  });

  it("waits for a chip that does not render straight away", async () => {
    // On the live Virtu form the block still read "Resume/CV*" at +500ms and
    // only named the file by +2000ms. Reading once reported "could not confirm"
    // for a file that had landed.
    render(GREENHOUSE_FULL_TIME);
    document.getElementById("resume")!.remove();
    setTimeout(() => showChip(FILE), 700);

    const result = await confirmAttachment(pageOverDocument(), SELECTOR, RESUME_REGION, FILE);

    expect(result.confirmed).toBe(true);
  });

  it("confirms without waiting when the control still holds the file", async () => {
    render(GREENHOUSE_FULL_TIME);
    // jsdom gives no `files` list, so stand one in. This is the path that must
    // never reach the polling loop.
    Object.defineProperty(document.getElementById("resume")!, "files", { value: [{}] });
    const started = Date.now();

    const result = await confirmAttachment(pageOverDocument(), SELECTOR, RESUME_REGION, FILE);

    expect(result).toMatchObject({ confirmed: true });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("still blocks when the control is there and nothing names the file", async () => {
    // JOB-047's hard stop, preserved: a control reporting zero files on a page
    // that never shows the name did not take the upload.
    render(GREENHOUSE_FULL_TIME);

    const result = await confirmAttachment(pageOverDocument(), SELECTOR, RESUME_REGION, FILE);

    expect(result).toMatchObject({ confirmed: false, blocking: true });
    expect((result as { why: string }).why).toContain(FILE);
  });

  it("clears JOB-047's zero-files control once its own block names the file", async () => {
    // SmartRecruiters' shape: the component reads the File, uploads it itself,
    // resets the input, then renders a chip. The input honestly says zero.
    render(GREENHOUSE_FULL_TIME);
    document
      .querySelector(`${RESUME_REGION} .file-upload__wrapper`)!
      .append(Object.assign(document.createElement("p"), { textContent: FILE }));

    const result = await confirmAttachment(pageOverDocument(), SELECTOR, RESUME_REGION, FILE);

    expect(result).toMatchObject({ confirmed: true });
    expect((result as { how: string }).how).toContain(FILE);
  });

  it("does not confirm on a chip naming some other file", async () => {
    render(GREENHOUSE_FULL_TIME);
    showChip("cover-letter.pdf");

    const result = await confirmAttachment(pageOverDocument(), SELECTOR, RESUME_REGION, FILE);

    expect(result.confirmed).toBe(false);
  });

  it("reports rather than blocks when nothing can be confirmed", async () => {
    // A board that shows a tick, a spinner, or nothing at all. Turning an
    // unrecognised confirmation into a stopped application would be a worse bug
    // than the one this ticket is about.
    render(GREENHOUSE_FULL_TIME);
    document.getElementById("resume")!.remove();

    const result = await confirmAttachment(pageOverDocument(), SELECTOR, null, FILE);

    expect(result).toMatchObject({ confirmed: false, blocking: false });
  });
});

describe("addressing a control without an id", () => {
  it("falls back to the name attribute", async () => {
    render(
      '<div><label for="x">Resume</label><input id="x" name="resume_file" type="file" /></div>'
    );

    const picked = await resumeUploadFromDom(pageOverDocument());

    // `[id="x"]` is unique and tried first, and the label makes it identifiable,
    // so the id wins here. The name path is what covers an input with no id.
    expect(picked?.selector).toBe('input[type=file][id="x"]');
  });

  it("uses the name when there is no id", async () => {
    render('<div><label>Resume/CV<input name="resume" type="file" /></label></div>');

    const picked = await resumeUploadFromDom(pageOverDocument());

    expect(picked?.selector).toBe('input[type=file][name="resume"]');
  });

  it("quotes an attribute value that would otherwise break the selector", async () => {
    // A generated id containing a CSS combinator. `#a.b:c` would parse as a
    // class and a pseudo-class; `[id="a.b:c"]` is a string and cannot.
    render('<div><label for="a.b:c">Resume</label><input id="a.b:c" type="file" /></div>');

    const picked = await resumeUploadFromDom(pageOverDocument());

    expect(picked?.selector).toBe('input[type=file][id="a.b:c"]');
    expect(document.querySelectorAll(picked!.selector)).toHaveLength(1);
  });
});
