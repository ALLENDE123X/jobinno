// @vitest-environment node
/**
 * JOB-329's email copy, pure and without a database.
 *
 * What each assertion is protecting
 *   The subject is quoted verbatim in the ticket, so a change to it is a
 *   deliberate copy edit and not an accidental one. The greeting and each
 *   submission line are the facts the body has to get right for the email
 *   to be useful at all: the wrong email in the greeting reads as a mail
 *   merge that leaked somebody else's address, and a submission line that
 *   omits company, role, or timestamp defeats the whole point of "here is
 *   what Jobinno did for you overnight".
 *
 *   The three plan branches are the only real logic in the template, so
 *   each one is exercised for a real shaped recipient rather than only in
 *   the summary line. The hyphen and em dash check is HARD STOP 8 in
 *   CLAUDE.md, checked here because this is the one file in the ticket
 *   whose whole output is prose a real person receives.
 */
import { describe, expect, it } from "vitest";

import {
  RECAP_DASHBOARD_URL,
  RECAP_PRICING_URL,
  buildRecapEmail,
  renderRecapCta,
  type RecapRecipient,
  type RecapSubmission,
} from "@/lib/recap/template";

/** A convenient recipient shape a test can override one field on. */
const baseRecipient = (over: Partial<RecapRecipient> = {}): RecapRecipient => ({
  email: "someone@example.test",
  plan: "free",
  applicationsUsed: 2,
  applicationsCap: 3,
  ...over,
});

const submission = (
  over: Partial<RecapSubmission> = {}
): RecapSubmission => ({
  company: "Acme",
  role: "Software Engineer Intern",
  submittedAt: new Date("2026-08-31T07:15:00Z"),
  ...over,
});

describe("buildRecapEmail", () => {
  it("uses the exact subject the ticket names, with the submission count", () => {
    const { subject } = buildRecapEmail(baseRecipient(), [submission(), submission()]);
    expect(subject).toBe("Jobinno submitted 2 applications for you overnight");
  });

  it("greets the person by the only fact intake has yet: their email", () => {
    const { text } = buildRecapEmail(baseRecipient(), [submission(), submission()]);
    expect(text.startsWith("Hi someone@example.test,")).toBe(true);
  });

  it("does not put one person's address in another person's email", () => {
    const first = buildRecapEmail(baseRecipient({ email: "first@example.test" }), [
      submission(),
      submission(),
    ]);
    const second = buildRecapEmail(baseRecipient({ email: "second@example.test" }), [
      submission(),
      submission(),
    ]);
    expect(first.text).toContain("first@example.test");
    expect(first.text).not.toContain("second@example.test");
    expect(second.text).toContain("second@example.test");
    expect(second.text).not.toContain("first@example.test");
  });

  it("lists every submission with company, role and timestamp", () => {
    const submissions = [
      submission({
        company: "Acme",
        role: "Backend Intern",
        submittedAt: new Date("2026-08-31T02:05:00Z"),
      }),
      submission({
        company: "Globex",
        role: "Frontend New Grad",
        submittedAt: new Date("2026-08-31T04:30:00Z"),
      }),
    ];
    const { text } = buildRecapEmail(baseRecipient(), submissions);
    expect(text).toContain("Acme");
    expect(text).toContain("Backend Intern");
    expect(text).toContain("02:05");
    expect(text).toContain("Globex");
    expect(text).toContain("Frontend New Grad");
    expect(text).toContain("04:30");
  });

  it("signs off as the founder, not as a system", () => {
    const { text } = buildRecapEmail(baseRecipient(), [submission(), submission()]);
    expect(text).toContain("Pranav");
    expect(text).toContain("I read every reply myself");
  });

  it("refuses to render an email with no submissions rather than saying 'zero'", () => {
    expect(() => buildRecapEmail(baseRecipient(), [])).toThrow(/at least 2/);
  });

  it("carries no em dash and no prose hyphen anywhere in the subject or body", () => {
    // HARD STOP 8 in CLAUDE.md. Same reasoning as
    // `tests/unit/reengagement/template.test.ts`: a hyphen inside the email
    // address itself would be a false positive, but the fixtures here do
    // not contain one, so the assertion holds as written. A future fixture
    // with a hyphenated local part or hyphenated company name would fail
    // loudly here rather than slip through.
    const { subject, text } = buildRecapEmail(baseRecipient(), [submission(), submission()]);
    const rendered = `${subject}\n${text}`;
    expect(rendered).not.toMatch(/—/);
    expect(rendered).not.toMatch(/[a-zA-Z]-[a-zA-Z]/);
  });
});

describe("renderRecapCta", () => {
  it("free tier at cap: pitches Starter with a pricing link", () => {
    const cta = renderRecapCta(
      baseRecipient({ plan: "free", applicationsUsed: 3, applicationsCap: 3 })
    );
    expect(cta).toContain("free trial");
    expect(cta).toContain("Starter");
    expect(cta).toContain("$29");
    expect(cta).toContain(RECAP_PRICING_URL);
    expect(cta).not.toContain("Cap:");
  });

  it("free tier with room left: names the count remaining and both paid options", () => {
    const cta = renderRecapCta(
      baseRecipient({ plan: "free", applicationsUsed: 2, applicationsCap: 3 })
    );
    expect(cta).toContain("2 of your 3 free applications");
    expect(cta).toContain("Starter");
    expect(cta).toContain("$29");
    expect(cta).toContain("Season Pass");
    expect(cta).toContain("$99");
    expect(cta).toContain(RECAP_PRICING_URL);
  });

  it("starter tier: names the plan and the used/cap ratio, not a pitch", () => {
    const cta = renderRecapCta(
      baseRecipient({ plan: "starter", applicationsUsed: 12, applicationsCap: 150 })
    );
    expect(cta).toContain("Starter");
    expect(cta).toContain("12 of 150");
    expect(cta).toContain(RECAP_DASHBOARD_URL);
    expect(cta).not.toContain(RECAP_PRICING_URL);
    expect(cta).not.toContain("$29");
  });

  it("season pass tier: names the plan and the used/cap ratio, not a pitch", () => {
    const cta = renderRecapCta(
      baseRecipient({ plan: "season_pass", applicationsUsed: 40, applicationsCap: 500 })
    );
    expect(cta).toContain("Season Pass");
    expect(cta).toContain("40 of 500");
    expect(cta).toContain(RECAP_DASHBOARD_URL);
    expect(cta).not.toContain(RECAP_PRICING_URL);
  });
});
