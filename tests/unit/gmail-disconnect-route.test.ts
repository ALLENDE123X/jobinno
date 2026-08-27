// @vitest-environment node
/**
 * JOB-228 — smoke tests for the disconnect route's auth gate and its write
 * path, mirroring the mocking pattern tests/unit/gmail-oauth-routes.test.ts
 * already uses for the sibling start and callback routes: `@/lib/supabase/server`
 * is mocked, so nothing here reaches a real database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-2222-3333-4444-555555555555";

const createServerClient = vi.fn();
const createServiceRoleClient = vi.fn();

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

async function callDisconnect() {
  const { POST } = await import("@/app/api/auth/gmail/disconnect/route");
  return POST();
}

beforeEach(() => {
  vi.resetModules();
  createServerClient.mockReset();
  createServiceRoleClient.mockReset();

  vi.doMock("@/lib/supabase/server", () => ({
    createServerClient,
    createServiceRoleClient,
  }));
});

afterEach(() => {
  vi.doUnmock("@/lib/supabase/server");
});

describe("POST /api/auth/gmail/disconnect", () => {
  it("refuses an unauthenticated caller with 401, before touching the database", async () => {
    createServerClient.mockResolvedValue(supabaseStub(null));

    const response = await callDisconnect();

    expect(response.status).toBe(401);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("clears the refresh token for the signed in user and returns ok", async () => {
    createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
    const serviceStub = serviceRoleStub([{ id: USER_ID }]);
    createServiceRoleClient.mockReturnValue(serviceStub);
    const updateSpy = vi.spyOn(serviceStub, "from");

    const response = await callDisconnect();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true });
    expect(updateSpy).toHaveBeenCalledWith("profiles");
  });

  it("reports a failure rather than success when the update matches zero rows", async () => {
    createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
    createServiceRoleClient.mockReturnValue(serviceRoleStub([]));

    const response = await callDisconnect();

    expect(response.status).toBe(404);
  });

  it("reports a failure when the update itself errors", async () => {
    createServerClient.mockResolvedValue(supabaseStub({ id: USER_ID }));
    createServiceRoleClient.mockReturnValue(serviceRoleStub(null, { message: "db unavailable" }));

    const response = await callDisconnect();

    expect(response.status).toBe(500);
  });
});
