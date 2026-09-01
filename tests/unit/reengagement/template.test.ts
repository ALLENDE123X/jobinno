// @vitest-environment node
/**
 * JOB-311's email copy, pure and without a database.
 *
 * ── What each assertion is actually protecting ───────────────────────────
 * The subject is quoted verbatim in the ticket, so a change to it is a
 * deliberate copy edit and not an accidental one. The greeting and the link
 * are the two facts the body has to get right for the email to do its job at
 * all: the wrong email in the greeting reads as a mail merge that leaked
 * somebody else's address, and a broken or wrong onboarding link is a dead
 * end for the one person who opened the email and clicked through. The
 * hyphen and em dash check is HARD STOP 8 in CLAUDE.md, checked here because
 * this is the one file in the ticket whose whole output is prose a real
 * person receives.
 */
import { describe, expect, it } from "vitest";

import { REENGAGEMENT_ONBOARDING_URL, buildReEngagementEmail } from "@/lib/reengagement/template";

describe("buildReEngagementEmail", () => {
  it("uses the exact subject the ticket names", () => {
    const { subject } = buildReEngagementEmail("someone@example.com");
    expect(subject).toBe("the signup was too much all at once, that is on me");
  });

  it("greets the person by the only fact it has: their email address", () => {
    const { text } = buildReEngagementEmail("someone@example.com");
    expect(text.startsWith("Hi someone@example.com,")).toBe(true);
  });

  it("does not put one person's address in another person's email", () => {
    // `.test` is the RFC 2606 reserved TLD for exactly this: fixtures that
    // are guaranteed not to resolve to a real recipient, unlike the two real
    // looking Gmail addresses this test used to carry.
    const first = buildReEngagementEmail("first@example.test");
    const second = buildReEngagementEmail("second@example.test");
    expect(first.text).toContain("first@example.test");
    expect(first.text).not.toContain("second@example.test");
    expect(second.text).toContain("second@example.test");
    expect(second.text).not.toContain("first@example.test");
  });

  it("links back to the exact onboarding step the ticket names", () => {
    const { text } = buildReEngagementEmail("someone@example.com");
    expect(REENGAGEMENT_ONBOARDING_URL).toBe("https://jobinno.app/onboarding/step/1");
    expect(text).toContain(REENGAGEMENT_ONBOARDING_URL);
  });

  it("signs off as the founder, not as a system", () => {
    const { text } = buildReEngagementEmail("someone@example.com");
    expect(text).toContain("Pranav");
    expect(text).toContain("I read every reply myself");
  });

  it("carries no em dash and no prose hyphen anywhere in the subject or body", () => {
    // HARD STOP 8 in CLAUDE.md. A hyphen inside the email address itself
    // would be a false positive nothing here can produce, since none of the
    // three test addresses used in this file contain one; asserted directly
    // against the rendered strings rather than guarded further, so a future
    // fixture with a hyphenated local part fails loudly here rather than
    // slipping through.
    const { subject, text } = buildReEngagementEmail("someone@example.com");
    const rendered = `${subject}\n${text}`;
    expect(rendered).not.toMatch(/—/);
    expect(rendered).not.toMatch(/[a-zA-Z]-[a-zA-Z]/);
  });
});
