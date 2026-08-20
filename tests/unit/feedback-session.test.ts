/**
 * The feedback widget has to read the session from the same place the app puts
 * it (JOB-011).
 *
 * This is a regression test for a silent one. The widget used to build a
 * private client with `createClient` from `@supabase/supabase-js`, which keeps
 * its session in `localStorage`. Jobinno never writes one there: sign in
 * finishes server side in `app/auth/callback/route.ts` and the session is
 * written to cookies, which is why `lib/supabase/client.ts` uses
 * `createBrowserClient` from `@supabase/ssr`.
 *
 * Nothing failed loudly. `getSession()` on the private client simply returned
 * null every time, so every report from a signed in person was filed as
 * anonymous and `feedback.user_id` collected nulls it was built to avoid.
 *
 * So the test drives the real clients against a real cookie rather than a mock.
 * A mocked `getSession()` would have passed happily before the fix, which is
 * exactly the property that makes it worthless here.
 */

import { createClient as createPlainClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/client";

const PROJECT_REF = "efyubrtiptcsrhfakbwc";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const ANON_KEY = "anon-key-for-this-test-only";
const USER_ID = "8b1a9953-0000-4000-8000-000000000001";

/**
 * A token shaped like the real thing. Never verified by anything in this test:
 * the browser side never verifies one either, Postgres does. See the widget's
 * header for why reading it unverified in the browser is safe.
 */
function unsignedToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.unsigned`;
}

/** Far enough out that no clock skew on a CI runner expires it mid test. */
const EXPIRES_AT = 4_102_444_800;

const SESSION = {
  access_token: unsignedToken({
    sub: USER_ID,
    exp: EXPIRES_AT,
    role: "authenticated",
  }),
  refresh_token: "refresh-token",
  expires_at: EXPIRES_AT,
  expires_in: 999_999,
  token_type: "bearer",
  user: { id: USER_ID, email: "someone@example.com" },
};

/**
 * Writes the session exactly the way `@supabase/ssr` stores it: one cookie
 * named for the project ref, holding base64url JSON behind a `base64-` marker.
 */
function writeSessionCookie() {
  const encoded = Buffer.from(JSON.stringify(SESSION)).toString("base64url");
  document.cookie = `sb-${PROJECT_REF}-auth-token=base64-${encoded}; path=/`;
}

function clearSessionCookie() {
  document.cookie = `sb-${PROJECT_REF}-auth-token=; path=/; max-age=0`;
}

describe("the client the feedback widget submits with", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON_KEY);
    localStorage.clear();
    clearSessionCookie();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearSessionCookie();
    localStorage.clear();
  });

  it("finds the signed in person in the cookie the app signs them in with", async () => {
    writeSessionCookie();

    const { data } = await createClient().auth.getSession();

    expect(data.session?.user.id).toBe(USER_ID);
  });

  it("reports an anonymous visitor as anonymous rather than throwing", async () => {
    const { data } = await createClient().auth.getSession();

    expect(data.session).toBeNull();
  });

  it("would have seen nobody through a localStorage backed client", async () => {
    // The bug, kept executable. This is what the widget used to do, and it is
    // why `user_id` was always null. If a future change reaches for a plain
    // `createClient` again, the assertion above is the one that breaks.
    writeSessionCookie();

    const { data } = await createPlainClient(
      SUPABASE_URL,
      ANON_KEY
    ).auth.getSession();

    expect(data.session).toBeNull();
    expect(localStorage.getItem(`sb-${PROJECT_REF}-auth-token`)).toBeNull();
  });
});
