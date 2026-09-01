// @vitest-environment node
/**
 * JOB-330's follow-up email copy. Same shape and same rules as
 * `tests/unit/reengagement/template.test.ts`: this email reaches a real
 * person's inbox and the copy has to hold up on its own without any
 * database or network in the loop.
 *
 * Each assertion is protecting one property the ticket names explicitly:
 * the deep link must go to `/onboarding/step/1?resumeUpload=1` so the
 * upload UI shows on the return visit, the person is only ever greeted by
 * their own email address (no facts we did not collect), and no em dash
 * or prose hyphen slips into the subject or body (HARD STOP 8).
 */
import { describe, expect, it } from "vitest";

import {
  RESUME_FOLLOWUP_DEEP_LINK,
  buildResumeFollowupEmail,
} from "@/lib/resume-followup/template";

describe("buildResumeFollowupEmail", () => {
  it("uses the exact subject the ticket names", () => {
    const { subject } = buildResumeFollowupEmail("someone@example.com");
    expect(subject).toBe("finish your Jobinno signup from your laptop");
  });

  it("greets the person by the only fact it has: their email address", () => {
    const { text } = buildResumeFollowupEmail("someone@example.com");
    expect(text.startsWith("Hi someone@example.com,")).toBe(true);
  });

  it("does not put one person's address in another person's email", () => {
    // `.test` is the RFC 2606 reserved TLD, matching the pattern in
    // `tests/unit/reengagement/template.test.ts` — no real inbox can
    // resolve to it, so a leaked fixture is safe.
    const first = buildResumeFollowupEmail("first@example.test");
    const second = buildResumeFollowupEmail("second@example.test");
    expect(first.text).toContain("first@example.test");
    expect(first.text).not.toContain("second@example.test");
    expect(second.text).toContain("second@example.test");
    expect(second.text).not.toContain("first@example.test");
  });

  it("links to the exact resume upload deep link the ticket names", () => {
    const { text } = buildResumeFollowupEmail("someone@example.com");
    expect(RESUME_FOLLOWUP_DEEP_LINK).toBe(
      "https://jobinno.app/onboarding/step/1?resumeUpload=1",
    );
    expect(text).toContain(RESUME_FOLLOWUP_DEEP_LINK);
  });

  it("signs off as the founder, not as a system", () => {
    const { text } = buildResumeFollowupEmail("someone@example.com");
    expect(text.trimEnd().endsWith("Pranav")).toBe(true);
  });

  it("does not echo the person's LinkedIn URL back into the body", () => {
    // A Resend delivery bounce log would otherwise carry two personally
    // identifying strings for one person; the deep link is enough for
    // the recipient to know which signup this is about.
    const { text } = buildResumeFollowupEmail("someone@example.com");
    expect(text.toLowerCase()).not.toContain("linkedin.com/in/");
  });

  it("carries no em dash and no prose hyphen anywhere in the subject or body", () => {
    // HARD STOP 8 in CLAUDE.md. The regex ignores hyphens inside the deep
    // link (a URL is not prose) by stripping it first, and ignores
    // hyphens inside the email address the same way.
    const { subject, text } = buildResumeFollowupEmail("someone@example.com");
    const rendered = `${subject}\n${text}`
      .replace(RESUME_FOLLOWUP_DEEP_LINK, "")
      .replace(/someone@example\.com/g, "");
    expect(rendered).not.toMatch(/—/);
    expect(rendered).not.toMatch(/[a-zA-Z]-[a-zA-Z]/);
  });
});
