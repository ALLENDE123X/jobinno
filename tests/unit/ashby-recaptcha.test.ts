// @vitest-environment node
/**
 * JOB-187. `mintAshbyRecaptchaToken` never touches the real harvester here —
 * `fetch` is stubbed on every case, the same way `tests/unit/ats-job-feeds.test.ts`
 * stubs it for the boards it reads.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HarvesterError, mintAshbyRecaptchaToken } from "@/lib/ashby-recaptcha";

const VALID_RESPONSE = {
  token: "03AGdBq27fake-token-value",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  solveTime: 41_203,
};

function mockFetchOnce(impl: (...args: unknown[]) => Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function networkFailure(code: string): Error {
  const err = new TypeError("fetch failed");
  Object.defineProperty(err, "cause", { value: { code }, enumerable: true });
  return err;
}

// Captures whatever HARVESTER_URL was set to before each test and restores
// exactly that value afterward, rather than unconditionally deleting it. An
// unconditional delete clobbers a value another suite (or a real
// environment) had set and never gives it back, which is its own bug
// independent of anything this test file is actually asserting.
let priorHarvesterUrl: string | undefined;
let priorHarvesterApiKey: string | undefined;

beforeEach(() => {
  priorHarvesterUrl = process.env.HARVESTER_URL;
  priorHarvesterApiKey = process.env.HARVESTER_API_KEY;
  delete process.env.HARVESTER_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (priorHarvesterUrl === undefined) {
    delete process.env.HARVESTER_URL;
  } else {
    process.env.HARVESTER_URL = priorHarvesterUrl;
  }
  if (priorHarvesterApiKey === undefined) {
    delete process.env.HARVESTER_API_KEY;
  } else {
    process.env.HARVESTER_API_KEY = priorHarvesterApiKey;
  }
});

describe("mintAshbyRecaptchaToken", () => {
  it("returns the token on a well formed response", async () => {
    mockFetchOnce(async () => jsonResponse(VALID_RESPONSE));

    const token = await mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123");

    expect(token).toBe(VALID_RESPONSE.token);
  });

  it("sends the expected body to the harvester's /solve endpoint", async () => {
    const fetchMock = mockFetchOnce(async () => jsonResponse(VALID_RESPONSE));
    process.env.HARVESTER_URL = "https://harvester.internal";

    await mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://harvester.internal/solve");
    expect(JSON.parse(String(init.body))).toEqual({
      websiteURL: "https://jobs.ashbyhq.com/ramp/abc123",
      websiteKey: "6LeFb_YUAAAAALUD5h-BiQEp8JaFChe0e0A6r49Y",
      pageAction: "submit",
      enterprise: false,
    });
    expect(init.headers as Record<string, string>).not.toHaveProperty("X-API-Key");
  });

  it("sends X-API-Key when HARVESTER_API_KEY is set", async () => {
    const fetchMock = mockFetchOnce(async () => jsonResponse(VALID_RESPONSE));
    process.env.HARVESTER_URL = "https://harvester.internal";
    process.env.HARVESTER_API_KEY = "sekret-harvester-key";

    await mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("sekret-harvester-key");
  });

  it("falls back to the localhost harvester when HARVESTER_URL is unset", async () => {
    // Explicit, rather than relying on the ambient value being unset: the
    // shared `beforeEach`/`afterEach` pair now restores whatever
    // HARVESTER_URL was set to before this test, so this case has to clear
    // it itself to exercise the fallback.
    delete process.env.HARVESTER_URL;
    const fetchMock = mockFetchOnce(async () => jsonResponse(VALID_RESPONSE));
    expect(process.env.HARVESTER_URL).toBeUndefined();

    await mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://127.0.0.1:3131/solve");
  });

  it("throws a typed HarvesterError on an HTTP 500", async () => {
    mockFetchOnce(async () => jsonResponse({ message: "internal error" }, 500));

    await expect(mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123")).rejects.toThrow(
      HarvesterError
    );
  });

  it("throws a typed HarvesterError on malformed JSON", async () => {
    mockFetchOnce(
      async () =>
        new Response("not json{{{", { status: 200, headers: { "content-type": "application/json" } })
    );

    await expect(mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123")).rejects.toThrow(
      HarvesterError
    );
  });

  it("throws a typed HarvesterError when the token field is missing", async () => {
    mockFetchOnce(async () =>
      jsonResponse({ userAgent: VALID_RESPONSE.userAgent, solveTime: VALID_RESPONSE.solveTime })
    );

    await expect(mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123")).rejects.toThrow(
      HarvesterError
    );
  });

  it("throws a typed HarvesterError when the harvester reports an errorCode", async () => {
    mockFetchOnce(async () => jsonResponse({ errorCode: "ERROR_CAPTCHA_UNSOLVABLE" }));

    await expect(mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123")).rejects.toThrow(
      /ERROR_CAPTCHA_UNSOLVABLE/
    );
  });

  it("does not retry on an HTTP 4xx", async () => {
    const fetchMock = mockFetchOnce(async () => jsonResponse({ message: "bad request" }, 400));

    await expect(mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123")).rejects.toThrow(
      HarvesterError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry on a well formed error response", async () => {
    const fetchMock = mockFetchOnce(async () => jsonResponse({ errorCode: "ERROR_TIMEOUT" }));

    await expect(mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123")).rejects.toThrow(
      HarvesterError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on ECONNREFUSED and succeeds on the second attempt", async () => {
    let calls = 0;
    mockFetchOnce(async () => {
      calls += 1;
      if (calls === 1) throw networkFailure("ECONNREFUSED");
      return jsonResponse(VALID_RESPONSE);
    });

    const token = await mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123");

    expect(token).toBe(VALID_RESPONSE.token);
    expect(calls).toBe(2);
  });

  it("does not retry a second time when the retry also fails", async () => {
    let calls = 0;
    mockFetchOnce(async () => {
      calls += 1;
      throw networkFailure("ECONNREFUSED");
    });

    await expect(mintAshbyRecaptchaToken("https://jobs.ashbyhq.com/ramp/abc123")).rejects.toThrow(
      HarvesterError
    );
    expect(calls).toBe(2);
  });
});

describe("HARVESTER_URL test isolation", () => {
  const SENTINEL_URL = "https://sentinel.harvester.test";

  beforeAll(() => {
    process.env.HARVESTER_URL = SENTINEL_URL;
  });

  afterAll(() => {
    delete process.env.HARVESTER_URL;
  });

  it("still holds the value set outside this test file's own suite, after the localhost fallback test ran and cleared it", () => {
    // Runs after "falls back to the localhost harvester when HARVESTER_URL
    // is unset" above, which deletes HARVESTER_URL for its own assertion.
    // Before this fix, the shared `afterEach` unconditionally deleted
    // HARVESTER_URL, so that test's cleanup would have permanently erased
    // this sentinel instead of restoring it. The shared `beforeEach` now
    // snapshots the prior value per test and `afterEach` puts it back, so
    // the sentinel this `beforeAll` set is still here.
    expect(process.env.HARVESTER_URL).toBe(SENTINEL_URL);
  });
});
