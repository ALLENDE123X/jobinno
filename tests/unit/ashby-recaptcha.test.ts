// @vitest-environment node
/**
 * JOB-187. `mintAshbyRecaptchaToken` never touches the real harvester here —
 * `fetch` is stubbed on every case, the same way `tests/unit/ats-job-feeds.test.ts`
 * stubs it for the boards it reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HARVESTER_URL;
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
  });

  it("falls back to the localhost harvester when HARVESTER_URL is unset", async () => {
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
