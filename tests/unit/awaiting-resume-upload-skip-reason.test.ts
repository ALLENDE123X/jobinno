// @vitest-environment node
/**
 * JOB-330. The `awaiting_resume_upload` skip reason is what the pipeline
 * writes when it refuses a listing on behalf of a profile that has
 * `linkedin_url_pending` set but no active `resumes` row yet — a person
 * who took the second lane on step 1 of onboarding and has not uploaded
 * a PDF from their laptop.
 *
 * Only lightweight assertions here: the value is on the closed
 * `SKIP_REASONS` set so the CHECK constraint accepts it, the dashboard
 * has a plain language sentence for it, and the sentence honestly names
 * the state (no PDF, nothing goes out) without inventing a fact HARD STOP
 * 9 forbids. The end to end pipeline behavior (fan out skipped in
 * `discoverListings`, claim step refused in `applyToJob`, skip_log row
 * written with this reason) is exercised through the real Inngest
 * handlers in production runs, not here.
 */
import { describe, expect, it } from "vitest";

import { SKIP_REASONS } from "@/lib/db/schema";
import {
  SKIP_REASON_TEXT,
  describeSkipReason,
} from "@/lib/dashboard/plain-language";

describe("awaiting_resume_upload skip reason", () => {
  it("is part of the closed SKIP_REASONS set the skip_log CHECK constraint enforces", () => {
    expect(SKIP_REASONS).toContain("awaiting_resume_upload");
  });

  it("has plain language wording on the dashboard for this reason", () => {
    const text = SKIP_REASON_TEXT.awaiting_resume_upload;
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(20);
  });

  it("names the honest state: no PDF, nothing goes out, no fabrication", () => {
    // HARD STOP 9 is the whole point of this reason existing; the
    // dashboard sentence has to say plainly that a URL does not become a
    // resume rather than paper over the state.
    const text = describeSkipReason("awaiting_resume_upload") ?? "";
    expect(text.toLowerCase()).toContain("resume");
    expect(text.toLowerCase()).toMatch(/linkedin|upload/);
    // Absolutely no promise that we invented anything from the URL.
    expect(text.toLowerCase()).not.toContain("filled in");
  });

  it("carries no em dash or prose hyphen in the dashboard sentence", () => {
    // HARD STOP 8. Same regex the sibling dashboard-plain-language test
    // runs over every existing reason, applied to the new one too.
    const text = SKIP_REASON_TEXT.awaiting_resume_upload;
    expect(text).not.toMatch(/[-—]/);
  });
});
