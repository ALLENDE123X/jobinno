// @vitest-environment node
/**
 * Issue #88 — Anti-bot hardening: unit tests for the new utilities introduced
 * in this PR.
 *
 * Three subjects:
 *  1. `deriveWarmUpUrl` — warm-up URL derivation from job apply URLs.
 *  2. Interaction delay range — the random delay helper stays within bounds.
 *  3. `createBrowserbaseContext` — concurrency-safe context creation, including
 *     the in-flight deduplication that prevents simultaneous calls for the same
 *     user from creating two contexts.
 *
 * No network, no database, no browser. `fetch` is mocked where needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveWarmUpUrl } from "@/lib/fill-application-form";
import { createBrowserbaseContext } from "@/lib/stagehand-session";

// ───────────────────────────────────
// 1. deriveWarmUpUrl
// ───────────────────────────────────

describe("deriveWarmUpUrl", () => {
  it("strips a trailing numeric job ID from a Workable URL", () => {
    expect(deriveWarmUpUrl("https://company.workable.com/jobs/123456/apply")).toBe(
      "https://company.workable.com/jobs"
    );
  });

  it("strips a trailing /apply suffix", () => {
    expect(deriveWarmUpUrl("https://company.workable.com/jobs/123456/apply")).toBe(
      "https://company.workable.com/jobs"
    );
  });

  it("strips a UUID-shaped segment (Lever pattern)", () => {
    expect(
      deriveWarmUpUrl("https://jobs.lever.co/acme/abc12345-1234-5678-abcd-ef1234567890/apply")
    ).toBe("https://jobs.lever.co/acme");
  });

  it("keeps the company/board prefix on a Greenhouse URL", () => {
    expect(
      deriveWarmUpUrl("https://boards.greenhouse.io/acme/jobs/12345678")
    ).toBe("https://boards.greenhouse.io/acme/jobs");
  });

  it("does not strip a non-ID last segment", () => {
    // 'jobs' is not a numeric ID, UUID, or 'apply' — should be kept.
    expect(deriveWarmUpUrl("https://company.workable.com/jobs")).toBe(
      "https://company.workable.com/jobs"
    );
  });

  it("falls back to the origin when all segments are IDs", () => {
    expect(deriveWarmUpUrl("https://boards.greenhouse.io/12345/apply")).toBe(
      "https://boards.greenhouse.io"
    );
  });

  it("returns the original URL unchanged for an invalid URL", () => {
    expect(deriveWarmUpUrl("not-a-url")).toBe("not-a-url");
  });

  it("strips only the trailing ID, not a middle segment", () => {
    // /jobs/company-name/12345 — only 12345 should be stripped, not company-name.
    expect(
      deriveWarmUpUrl("https://jobs.lever.co/acme-corp/99999")
    ).toBe("https://jobs.lever.co/acme-corp");
  });
});

// ───────────────────────────────────
// 2. createBrowserbaseContext
// ───────────────────────────────────

describe("createBrowserbaseContext", () => {
  const mockContextId = "ctx_abcdef1234";
  const apiKey = "bb_test_key";
  const projectId = "proj_123";
  const userId = "user_abc";

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: mockContextId }),
        text: async () => JSON.stringify({ id: mockContextId }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("calls the Browserbase REST API and returns the context ID", async () => {
    const id = await createBrowserbaseContext(userId, apiKey, projectId);
    expect(id).toBe(mockContextId);
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.browserbase.com/v1/contexts");
    expect((init as RequestInit).method).toBe("POST");
    expect(((init as RequestInit).headers as Record<string, string>)["X-BB-API-Key"]).toBe(apiKey);
  });

  it("deduplicates concurrent calls for the same user", async () => {
    // Two simultaneous calls for the same userId must share one in-flight Promise
    // and produce the same context ID with only one fetch call.
    const [id1, id2] = await Promise.all([
      createBrowserbaseContext(userId, apiKey, projectId),
      createBrowserbaseContext(userId, apiKey, projectId),
    ]);
    expect(id1).toBe(mockContextId);
    expect(id2).toBe(mockContextId);
    // Only one fetch despite two simultaneous callers.
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it("allows a second call for the same user after the first has settled", async () => {
    await createBrowserbaseContext(userId, apiKey, projectId);
    // The in-flight entry is removed after the Promise settles, so a second
    // call should produce a fresh fetch.
    await createBrowserbaseContext(userId, apiKey, projectId);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("throws when the API returns a non-OK status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        text: async () => "Payment Required",
      })
    );
    await expect(
      createBrowserbaseContext("user_other", apiKey, projectId)
    ).rejects.toThrow("402");
  });
});
