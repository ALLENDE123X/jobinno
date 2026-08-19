/**
 * The feedback widget's insert, checked at the payload boundary (JOB-016).
 *
 * The widget itself is presentational and not worth a render test. What is
 * worth a test is that the object handed to Postgres matches the columns the
 * table actually has, because RLS and a CHECK constraint will both reject a
 * near miss and the failure surfaces as a shrug in the browser.
 */

import { describe, expect, it, vi } from "vitest";

import { FEEDBACK_CATEGORIES } from "@/lib/db/schema";
import {
  buildFeedbackRow,
  captureFeedbackContext,
  submitFeedback,
  FEEDBACK_CATEGORY_OPTIONS,
  FEEDBACK_TABLE,
  type FeedbackInsertClient,
  type FeedbackRow,
} from "@/lib/feedback";

/** Records the table and row it was handed, and reports no error. */
function recordingClient() {
  const insert = vi.fn(async () => ({ error: null }));
  const from = vi.fn(() => ({ insert }));
  return { client: { from } as unknown as FeedbackInsertClient, from, insert };
}

const CONTEXT = {
  page_url: "https://jobinno.com/pricing",
  user_agent: "Mozilla/5.0 (Macintosh)",
  submitted_at: "2026-08-19T04:05:06.000Z",
};

describe("feedback categories", () => {
  it("offers exactly the categories the table's CHECK constraint allows", () => {
    expect(FEEDBACK_CATEGORY_OPTIONS.map((option) => option.value)).toEqual([
      ...FEEDBACK_CATEGORIES,
    ]);
  });
});

describe("captureFeedbackContext", () => {
  it("captures page url, user agent and a timestamp and nothing else", () => {
    const context = captureFeedbackContext(
      {
        location: { href: CONTEXT.page_url } as Location,
        navigator: { userAgent: CONTEXT.user_agent } as Navigator,
      },
      new Date(CONTEXT.submitted_at)
    );

    expect(context).toEqual(CONTEXT);
  });
});

describe("buildFeedbackRow", () => {
  it("uses the table's own column names and trims the body", () => {
    const row = buildFeedbackRow({
      category: "bug",
      body: "  The submit button did nothing.  ",
      userId: "8b1a9953-0000-4000-8000-000000000001",
      context: CONTEXT,
    });

    const expected: FeedbackRow = {
      user_id: "8b1a9953-0000-4000-8000-000000000001",
      category: "bug",
      body: "The submit button did nothing.",
      context: CONTEXT,
    };

    expect(row).toEqual(expected);
    expect(Object.keys(row).sort()).toEqual([
      "body",
      "category",
      "context",
      "user_id",
    ]);
  });

  it("leaves user_id null for an anonymous submitter, which RLS requires", () => {
    const row = buildFeedbackRow({
      category: "other",
      body: "Nice landing page.",
      context: CONTEXT,
    });

    expect(row.user_id).toBeNull();
  });
});

describe("submitFeedback", () => {
  it("inserts one row into the feedback table", async () => {
    const { client, from, insert } = recordingClient();

    const result = await submitFeedback(client, {
      category: "feature",
      body: "Let me pause a run.",
      userId: null,
      context: CONTEXT,
    });

    expect(result).toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith(FEEDBACK_TABLE);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({
      user_id: null,
      category: "feature",
      body: "Let me pause a run.",
      context: CONTEXT,
    });
  });

  it("refuses an empty body without touching the database", async () => {
    const { client, from } = recordingClient();

    const result = await submitFeedback(client, {
      category: "bug",
      body: "   ",
      context: CONTEXT,
    });

    expect(result.ok).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it("returns the failure rather than throwing it at the widget", async () => {
    const insert = vi.fn(async () => ({
      error: { message: "new row violates row level security policy" },
    }));
    const client = {
      from: vi.fn(() => ({ insert })),
    } as unknown as FeedbackInsertClient;

    const result = await submitFeedback(client, {
      category: "bug",
      body: "Something broke.",
      userId: "not-my-id",
      context: CONTEXT,
    });

    expect(result).toEqual({
      ok: false,
      message: "new row violates row level security policy",
    });
  });
});
