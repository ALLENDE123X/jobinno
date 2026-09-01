// @vitest-environment node
/**
 * JOB-330's Resend caller. Same shape as
 * `tests/unit/reengagement/email.test.ts` for the sibling caller: assert
 * the never-throw failure posture, the idempotency key stability, and the
 * per-request headers, and stub `global.fetch` so nothing here actually
 * hits Resend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildResumeFollowupIdempotencyKey,
  redactEmail,
  sendResumeFollowupEmail,
} from "@/lib/resume-followup/email";

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_API_KEY = process.env.RESEND_API_KEY;
const ORIGINAL_FROM = process.env.RESEND_FROM_ADDRESS;

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_ADDRESS;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_API_KEY !== undefined) {
    process.env.RESEND_API_KEY = ORIGINAL_API_KEY;
  }
  if (ORIGINAL_FROM !== undefined) {
    process.env.RESEND_FROM_ADDRESS = ORIGINAL_FROM;
  }
});

describe("redactEmail", () => {
  it("keeps the first two characters of the local part and the whole domain", () => {
    expect(redactEmail("someone@example.com")).toBe("so***@example.com");
  });

  it("returns [invalid] for a value with no @ (defensive, not reachable in real callers)", () => {
    expect(redactEmail("no-at-sign")).toBe("[invalid]");
  });
});

describe("buildResumeFollowupIdempotencyKey", () => {
  it("is deterministic across calls with the same profile id", () => {
    const first = buildResumeFollowupIdempotencyKey(
      "11111111-2222-4333-8444-555555555555",
    );
    const second = buildResumeFollowupIdempotencyKey(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(first).toBe(second);
  });

  it("differs across different profile ids", () => {
    const a = buildResumeFollowupIdempotencyKey(
      "11111111-2222-4333-8444-555555555555",
    );
    const b = buildResumeFollowupIdempotencyKey(
      "99999999-8888-4777-8666-555555555555",
    );
    expect(a).not.toBe(b);
  });

  it("does not collide with the reengagement key for the same profile", async () => {
    // Both callers hash the same profile id under different suffixes so a
    // deferred lane follow-up and a 24h re-engagement email are never
    // deduplicated against each other on Resend's end.
    const { buildReEngagementIdempotencyKey } = await import(
      "@/lib/reengagement/email"
    );
    const followup = buildResumeFollowupIdempotencyKey(
      "11111111-2222-4333-8444-555555555555",
    );
    const reengagement = buildReEngagementIdempotencyKey(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(followup).not.toBe(reengagement);
  });
});

describe("sendResumeFollowupEmail", () => {
  it("returns { sent: false, reason: 'missing_api_key' } when RESEND_API_KEY is unset", async () => {
    const result = await sendResumeFollowupEmail({
      to: "someone@example.test",
      subject: "subject",
      text: "body",
    });
    expect(result).toEqual({ sent: false, reason: "missing_api_key" });
  });

  it("returns { sent: true } on a 2xx response, and passes the idempotency key through", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const fetchMock = vi.fn(async () =>
      new Response("{}", { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendResumeFollowupEmail({
      to: "someone@example.test",
      subject: "subject",
      text: "body",
      idempotencyKey: "deterministic-key",
    });

    expect(result).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("deterministic-key");
    expect(headers.authorization).toBe("Bearer test-key");
  });

  it("returns { sent: false, reason: 'rejected' } on a non-2xx response, without throwing", async () => {
    process.env.RESEND_API_KEY = "test-key";
    global.fetch = (async () =>
      new Response("bad", { status: 422 })) as unknown as typeof fetch;

    const result = await sendResumeFollowupEmail({
      to: "someone@example.test",
      subject: "subject",
      text: "body",
    });
    expect(result).toEqual({ sent: false, reason: "rejected" });
  });

  it("returns { sent: false, reason: 'threw' } when fetch throws, without throwing", async () => {
    process.env.RESEND_API_KEY = "test-key";
    global.fetch = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;

    const result = await sendResumeFollowupEmail({
      to: "someone@example.test",
      subject: "subject",
      text: "body",
    });
    expect(result).toEqual({ sent: false, reason: "threw" });
  });
});
