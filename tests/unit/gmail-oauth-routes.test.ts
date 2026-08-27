// @vitest-environment node
/**
 * JOB-198 — regression tests for the CodeRabbit findings that survived
 * PR #190's merge (the Gmail OAuth wire):
 *
 *  1. The callback route's token exchange had no timeout, so a stalled call
 *     to Google could hang the request until the platform's own function
 *     timeout cut it off.
 *  2. The callback route reported success even when the `profiles` UPDATE
 *     matched zero rows, since Supabase reports no error for that case.
 *  3. Every post-auth failure in the callback route redirected to `/login`,
 *     which bounces a signed in visitor straight to `/dashboard` before it
 *     ever reads the `error` query parameter (see app/login/page.tsx), so
 *     the failure reason was silently dropped.
 *  4. The start route's `signGmailOAuthState` call sat outside its try
 *     block, so a missing `GMAIL_OAUTH_STATE_SECRET` escaped as an uncaught
 *     500 instead of the same handled 400 a missing client id gets.
 *
 * `@/lib/supabase/server`, `@/lib/gmail-oauth`, `@/lib/gmail-token-crypto`
 * and `googleapis` are all mocked, the same way
 * tests/unit/billing-checkout-route.test.ts mocks `@/lib/billing/stripe` and
 * `@/lib/supabase/server`: nothing here reaches Google or a real database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-2222-3333-4444-555555555555";

const createServerClient = vi.fn();
const createServiceRoleClient = vi.fn();
const gmailOAuthRedirectUri = vi.fn();
const signGmailOAuthState = vi.fn();
const verifyGmailOAuthState = vi.fn();
const encryptGmailRefreshToken = vi.fn();
const getToken = vi.fn();
const OAuth2 = vi.fn().mockImplementation(function OAuth2Stub(this: { getToken: typeof getToken }) {
  this.getToken = getToken;
});

class GmailOAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailOAuthStateError";
  }
}

function supabaseStub(user: { id: string } | null) {
  return {
    auth: {
      async getUser() {
        return { data: { user } };
      },
    },
  };
}

/** `updatedRows` stands for whatever `.select("id")` on the UPDATE returns. */
function serviceRoleStub(
  updatedRows: Array<{ id: string }> | null,
  error: { message: string } | null = null
) {
  return {
    from() {
      return {
        update() {
          return {
            eq() {
              return {
                async select() {
                  return { data: updatedRows, error };
                },
              };
            },
          };
        },
      };
    },
  };
}

function locationOf(response: Response): URL {
  const location = response.headers.get("location");
  if (!location) throw new Error("Expected a redirect Location header.");
  return new URL(location);
}

async function callCallback(query: string) {
  const { GET } = await import("@/app/api/auth/gmail/callback/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`https://jobinno.app/api/auth/gmail/callback${query}`));
}

async function callStart() {
  const { GET } = await import("@/app/api/auth/gmail/start/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("https://jobinno.app/api/auth/gmail/start"));
}

beforeEach(() => {
  vi.resetModules();
  createServerClient.mockReset();
  createServiceRoleClient.mockReset();
  gmailOAuthRedirectUri.mockReset().mockReturnValue("https://jobinno.app/api/auth/gmail/callback");
  signGmailOAuthState.mockReset().mockReturnValue("signed-state");
  verifyGmailOAuthState.mockReset();
  encryptGmailRefreshToken.mockReset().mockReturnValue("encrypted-refresh-token");
  getToken.mockReset();
  OAuth2.mockClear();

  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";

  vi.doMock("@/lib/supabase/server", () => ({
    createServerClient,
    createServiceRoleClient,
  }));
  vi.doMock("@/lib/gmail-oauth", () => ({
    GMAIL_OAUTH_SCOPE: "https://www.googleapis.com/auth/gmail.readonly",
    GmailOAuthStateError,
    gmailOAuthRedirectUri,
    signGmailOAuthState,
    verifyGmailOAuthState,
  }));
  vi.doMock("@/lib/gmail-token-crypto", () => ({
    encryptGmailRefreshToken,
  }));
  vi.doMock("googleapis", () => ({
    google: { auth: { OAuth2 } },
  }));
});

afterEach(() => {
  vi.doUnmock("@/lib/supabase/server");
  vi.doUnmock("@/lib/gmail-oauth");
  vi.doUnmock("@/lib/gmail-token-crypto");
  vi.doUnmock("googleapis");
  vi.useRealTimers();
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
});

describe("GET /api/auth/gmail/callback", () => {
  it("stores the refresh token and redirects to the success page", async () => {
    createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
    createServiceRoleClient.mockReturnValue(serviceRoleStub([{ id: USER_ID }]));
    getToken.mockResolvedValue({ tokens: { refresh_token: "raw-refresh-token" } });

    const response = await callCallback("?code=abc123&state=signed-state");

    expect(response.status).toBe(303);
    expect(locationOf(response).pathname).toBe("/settings/gmail/success");
    expect(encryptGmailRefreshToken).toHaveBeenCalledWith("raw-refresh-token");
  });

  describe("JOB-198: the token exchange timeout", () => {
    it("gives up after 15 seconds rather than hanging, and fails closed", async () => {
      createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
      // Never settles on its own: only the 15 second timeout should resolve
      // this call, exactly like a stalled connection to Google would.
      getToken.mockReturnValue(new Promise(() => {}));

      // Resolved before the fake clock starts, so the dynamic import below
      // (real, un-faked async module loading) cannot itself eat into the
      // 15 second window this test is about to fast forward through.
      const { GET } = await import("@/app/api/auth/gmail/callback/route");
      const { NextRequest } = await import("next/server");

      vi.useFakeTimers();
      const responsePromise = GET(
        new NextRequest("https://jobinno.app/api/auth/gmail/callback?code=abc123&state=signed-state")
      );
      await vi.advanceTimersByTimeAsync(15_000);
      const response = await responsePromise;

      expect(response.status).toBe(303);
      const location = locationOf(response);
      // A timed out exchange is a post-auth failure, so it lands on the
      // outcome page rather than /login, same as every other failure below.
      // The outcome page reads the error param and renders the error card;
      // /dashboard was tried once and had the same silent drop /login had.
      expect(location.pathname).toBe("/settings/gmail/success");
      expect(location.searchParams.get("error")).toMatch(/took too long/i);
    });

    it("does not time out an exchange that resolves well within the window", async () => {
      vi.useFakeTimers();
      createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
      createServiceRoleClient.mockReturnValue(serviceRoleStub([{ id: USER_ID }]));
      getToken.mockResolvedValue({ tokens: { refresh_token: "raw-refresh-token" } });

      const response = await callCallback("?code=abc123&state=signed-state");

      expect(locationOf(response).pathname).toBe("/settings/gmail/success");
    });
  });

  describe("JOB-198: the zero row profiles update", () => {
    it("treats a zero row match as a failure instead of reporting success", async () => {
      // Supabase reports no error at all when an UPDATE matches zero rows,
      // which is exactly the case a missing `profiles` row for this user id
      // produces. Before this fix, that landed on SUCCESS_PATH anyway.
      createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
      createServiceRoleClient.mockReturnValue(serviceRoleStub([]));
      getToken.mockResolvedValue({ tokens: { refresh_token: "raw-refresh-token" } });

      const response = await callCallback("?code=abc123&state=signed-state");

      const location = locationOf(response);
      // The outcome page renders success when it is reached without an
      // `error` param, and an error card when `error` is set. A zero row
      // update lands here with `error` set, so the outcome page renders
      // the error card. The success and failure branches use the same
      // path on purpose; the search param is what distinguishes them.
      expect(location.pathname).toBe("/settings/gmail/success");
      expect(location.searchParams.get("error")).toMatch(/profile row was not found/i);
    });

    it("still succeeds when the update matches exactly one row", async () => {
      createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
      createServiceRoleClient.mockReturnValue(serviceRoleStub([{ id: USER_ID }]));
      getToken.mockResolvedValue({ tokens: { refresh_token: "raw-refresh-token" } });

      const response = await callCallback("?code=abc123&state=signed-state");

      expect(locationOf(response).pathname).toBe("/settings/gmail/success");
    });
  });

  describe("JOB-198: where a signed in failure lands", () => {
    it("sends a state verification failure to the outcome page, not to login", async () => {
      createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
      verifyGmailOAuthState.mockImplementation(() => {
        throw new GmailOAuthStateError("State has expired. Start the Gmail connection again.");
      });

      const response = await callCallback("?code=abc123&state=stale-state");

      const location = locationOf(response);
      expect(location.pathname).toBe("/settings/gmail/success");
      expect(location.searchParams.get("error")).toBeTruthy();
    });

    it("sends a token exchange failure to the outcome page, not to login", async () => {
      createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
      getToken.mockRejectedValue(new Error("invalid_grant"));

      const response = await callCallback("?code=abc123&state=signed-state");

      expect(locationOf(response).pathname).toBe("/settings/gmail/success");
    });

    it("still sends an unauthenticated visitor to login", async () => {
      createServerClient.mockResolvedValue(supabaseStub(null));

      const response = await callCallback("?code=abc123&state=signed-state");

      expect(locationOf(response).pathname).toBe("/login");
    });
  });
});

describe("GET /api/auth/gmail/start", () => {
  it("signs the state and redirects to Google when everything is configured", async () => {
    createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));

    const response = await callStart();

    expect(response.status).toBe(303);
    expect(locationOf(response).hostname).toBe("accounts.google.com");
    expect(signGmailOAuthState).toHaveBeenCalledWith(USER_ID);
  });

  it("JOB-198: returns a clean 400 instead of an uncaught 500 when the state secret is missing", async () => {
    // Before this fix, signGmailOAuthState ran outside the route's try
    // block, so this same GmailOAuthStateError escaped as a generic 500.
    createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
    signGmailOAuthState.mockImplementation(() => {
      throw new GmailOAuthStateError("GMAIL_OAUTH_STATE_SECRET is required but not set.");
    });

    const response = await callStart();

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/not available from this origin/i);
  });
});
