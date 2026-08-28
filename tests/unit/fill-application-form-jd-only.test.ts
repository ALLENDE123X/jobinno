// @vitest-environment node
/**
 * JOB-261 — the two pure judgements behind the SR + Breezy job-description-page
 * fix: what counts as a job description page rather than a form
 * (`isJdOnlyPageShape`), and where Breezy's own `/apply` convention puts the
 * form relative to it (`deriveBreezyApplyUrl`).
 *
 * The DOM scan and the navigation retry that use these are exercised through
 * the full flow in `tests/unit/fill-application-form-flow.test.ts`, the same
 * split that file's own header describes for `deriveWarmUpUrl` and the other
 * pure helpers underneath `reachApplicationForm`. Pinned here against the
 * exact numbers the three incident rows' skip_log messages recorded:
 *
 *  - Renesas Electronics (SR): password fields 0, file inputs 0, applicant
 *    fields the DOM could see: none.
 *  - Sports Reference (Breezy): the same three numbers, landed on
 *    ".../p/79e583d55a8f-software-engineer".
 *  - VetsEZ Dallas (Breezy): the same three numbers again.
 */
import { describe, expect, it } from "vitest";

import { deriveBreezyApplyUrl, isJdOnlyPageShape } from "@/lib/fill-application-form";
import type { FormSignals } from "@/lib/fill-application-form";

/** The three incident rows' skip_log numbers, as a base every test overrides from. */
const jdPageSignals = (overrides: Partial<FormSignals> = {}): FormSignals =>
  ({
    applicationFormPresent: false,
    applyControlPresent: false,
    signInFormPresent: false,
    verificationCodeFieldPresent: false,
    firstNameFieldPresent: false,
    lastNameFieldPresent: false,
    fullNameFieldPresent: false,
    emailFieldPresent: false,
    phoneFieldPresent: false,
    linkedinFieldPresent: false,
    websiteFieldPresent: false,
    resumeUploadPresent: false,
    coverLetterTextAreaPresent: false,
    coverLetterUploadPresent: false,
    coverLetterManualEntryControlPresent: false,
    passwordFieldCount: 0,
    fileInputCount: 0,
    submitApplicationControlLabels: [],
    captchaPresent: false,
    captchaEvidence: "",
    applicationLikelySubmitted: false,
    applicationLikelySubmittedEvidence: "",
    url: "https://jobs.smartrecruiters.com/RenesasElectronics/744000145339679",
    title: "Renesas Electronics Software Engineer | SmartRecruiters",
    textLength: 347,
    textAreaCount: 0,
    iframeCount: 1,
    domFileInputCount: 0,
    domCoreSlots: [],
    ...overrides,
  }) as FormSignals;

describe("isJdOnlyPageShape", () => {
  it("reads the Renesas (SR) skip_log numbers as a job description page", () => {
    expect(isJdOnlyPageShape(jdPageSignals())).toBe(true);
  });

  it("reads the Sports Reference and VetsEZ Dallas (Breezy) skip_log numbers the same way", () => {
    expect(
      isJdOnlyPageShape(
        jdPageSignals({
          url: "https://sports-reference-llc.breezy.hr/p/79e583d55a8f-software-engineer",
          iframeCount: 1,
        })
      )
    ).toBe(true);
    expect(
      isJdOnlyPageShape(
        jdPageSignals({
          url: "https://vetsez.breezy.hr/p/c492d2abf56301-junior-software-engineer-security-release-engineering-secrel",
          iframeCount: 2,
        })
      )
    ).toBe(true);
  });

  it("is false the moment the reader or the DOM finds a form", () => {
    expect(isJdOnlyPageShape(jdPageSignals({ applicationFormPresent: true }))).toBe(false);
    expect(isJdOnlyPageShape(jdPageSignals({ domCoreSlots: ["email"] }))).toBe(false);
  });

  it("is false in front of a sign-in wall or a genuine file upload", () => {
    // Both would otherwise pass the three positive checks; a job description
    // page has neither a password box nor a resume dropzone on it.
    expect(isJdOnlyPageShape(jdPageSignals({ passwordFieldCount: 1 }))).toBe(false);
    expect(isJdOnlyPageShape(jdPageSignals({ fileInputCount: 1 }))).toBe(false);
  });
});

describe("deriveBreezyApplyUrl", () => {
  it("appends /apply to the Sports Reference listing, matching tonight's working Breezy shape", () => {
    expect(deriveBreezyApplyUrl("https://sports-reference-llc.breezy.hr/p/79e583d55a8f-software-engineer")).toBe(
      "https://sports-reference-llc.breezy.hr/p/79e583d55a8f-software-engineer/apply"
    );
  });

  it("does the same for the VetsEZ Dallas listing", () => {
    expect(
      deriveBreezyApplyUrl(
        "https://vetsez.breezy.hr/p/c492d2abf56301-junior-software-engineer-security-release-engineering-secrel"
      )
    ).toBe(
      "https://vetsez.breezy.hr/p/c492d2abf56301-junior-software-engineer-security-release-engineering-secrel/apply"
    );
  });

  it("returns null rather than doubling up a URL that already ends in /apply", () => {
    expect(
      deriveBreezyApplyUrl("https://sports-reference-llc.breezy.hr/p/79e583d55a8f-software-engineer/apply")
    ).toBeNull();
  });

  it("returns null for a URL it cannot parse", () => {
    expect(deriveBreezyApplyUrl("not a url")).toBeNull();
  });

  it("keeps a query string on the /apply URL rather than dropping it", () => {
    expect(deriveBreezyApplyUrl("https://acme.breezy.hr/p/abc123?ref=simplify")).toBe(
      "https://acme.breezy.hr/p/abc123/apply?ref=simplify"
    );
  });
});
