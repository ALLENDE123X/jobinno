// @vitest-environment node
/**
 * JOB-330. The URL validator behind the second lane on step 1.
 *
 * The regex is a shape check, not an existence check (LinkedIn's TOS bars
 * scraping the profile page). What matters here is what the schema
 * accepts and what it refuses, since a mistyped URL becomes a stored
 * fact on `profiles.linkedin_url_pending` and rides into a follow-up
 * email at that shape.
 */
import { describe, expect, it } from "vitest";

import { linkedinPendingUrlSchema } from "@/lib/onboarding/intake-schema";

describe("linkedinPendingUrlSchema", () => {
  it.each([
    "https://linkedin.com/in/pranavlende",
    "https://www.linkedin.com/in/pranavlende",
    "https://www.linkedin.com/in/pranavlende/",
    "http://linkedin.com/in/pranavlende",
    "https://m.linkedin.com/in/pranavlende",
    "linkedin.com/in/pranavlende",
    "https://linkedin.com/in/pranav-lende-1a2b3c4d",
    "https://linkedin.com/in/pat_example",
    "https://linkedin.com/in/handle?utm_source=x",
  ])("accepts %s", (input) => {
    const result = linkedinPendingUrlSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("normalizes a bare linkedin.com/in/handle to an https URL", () => {
    const result = linkedinPendingUrlSchema.safeParse(
      "linkedin.com/in/pranavlende",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toBe("https://linkedin.com/in/pranavlende");
  });

  it.each([
    "",
    "   ",
    "not a url",
    "https://github.com/pranavlende",
    "https://example.com/in/handle",
    "https://linkedin.com/pub/handle",
    "https://linkedin.com/in/",
    "javascript:alert(1)",
  ])("rejects %s", (input) => {
    const result = linkedinPendingUrlSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("refuses a URL longer than the 300 character cap", () => {
    const tooLong = `https://linkedin.com/in/${"a".repeat(400)}`;
    const result = linkedinPendingUrlSchema.safeParse(tooLong);
    expect(result.success).toBe(false);
  });
});
