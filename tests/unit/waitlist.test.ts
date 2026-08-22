/**
 * Waitlist submission's payload boundary (JOB-031), and creator referral
 * attribution on top of it (JOB-041).
 *
 * Mirrors `tests/unit/feedback.test.ts`: the form itself is presentational
 * and not worth a render test, but the object handed to Postgres has to match
 * the columns the table actually has, and the query-param-then-cookie
 * precedence rule for `referred_by` is exactly the kind of thing that is easy
 * to get backwards without a test pinning it down.
 */

import { describe, expect, it, vi } from "vitest";

import {
  buildWaitlistRow,
  resolveWaitlistReferral,
  submitWaitlist,
  WAITLIST_TABLE,
  type WaitlistInsertClient,
  type WaitlistRow,
} from "@/lib/waitlist";

/** Records the table and row it was handed, and reports no error. */
function recordingClient() {
  const insert = vi.fn(async () => ({ error: null }));
  const from = vi.fn(() => ({ insert }));
  return { client: { from } as unknown as WaitlistInsertClient, from, insert };
}

describe("resolveWaitlistReferral", () => {
  it("prefers a live query param over the cookie", () => {
    expect(resolveWaitlistReferral("courtney", "someone-else")).toBe(
      "courtney"
    );
  });

  it("falls back to the cookie when there is no live query param", () => {
    expect(resolveWaitlistReferral(undefined, "courtney")).toBe("courtney");
    expect(resolveWaitlistReferral(null, "courtney")).toBe("courtney");
  });

  it("resolves to null when neither the query param nor the cookie carry one", () => {
    expect(resolveWaitlistReferral(undefined, undefined)).toBeNull();
    expect(resolveWaitlistReferral(null, null)).toBeNull();
  });

  it("treats a blank query param as absent and still falls back to the cookie", () => {
    expect(resolveWaitlistReferral("   ", "courtney")).toBe("courtney");
  });

  it("treats a blank cookie the same as no cookie at all", () => {
    expect(resolveWaitlistReferral(undefined, "   ")).toBeNull();
  });
});

describe("buildWaitlistRow", () => {
  it("carries a referral code through to referred_by, trimmed", () => {
    const row = buildWaitlistRow({
      email: "jane@example.com",
      referredBy: "  courtney  ",
    });

    expect(row.referred_by).toBe("courtney");
  });

  it("leaves referred_by null when no referral code was resolved", () => {
    const row = buildWaitlistRow({ email: "jane@example.com" });

    expect(row.referred_by).toBeNull();
  });

  it("folds a blank referral code to null, same as the other optional fields", () => {
    const row = buildWaitlistRow({
      email: "jane@example.com",
      referredBy: "   ",
    });

    expect(row.referred_by).toBeNull();
  });

  it("folds an explicit null referral code to null", () => {
    const row = buildWaitlistRow({
      email: "jane@example.com",
      referredBy: null,
    });

    expect(row.referred_by).toBeNull();
  });
});

describe("submitWaitlist with referral attribution", () => {
  it("inserts the row with referred_by set when ?ref= was present at submit time", async () => {
    const { client, insert } = recordingClient();

    const referredBy = resolveWaitlistReferral("courtney", undefined);
    const result = await submitWaitlist(client, {
      email: "jane@example.com",
      referredBy,
    });

    expect(result).toEqual({ ok: true, alreadyJoined: false });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ referred_by: "courtney" })
    );
  });

  it("inserts the row with referred_by null when no referral code was ever seen", async () => {
    const { client, insert } = recordingClient();

    const referredBy = resolveWaitlistReferral(undefined, undefined);
    const result = await submitWaitlist(client, {
      email: "jane@example.com",
      referredBy,
    });

    expect(result).toEqual({ ok: true, alreadyJoined: false });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ referred_by: null })
    );
  });

  it("attributes to the cookie's referral code when ?ref= is gone by submit time", async () => {
    // The shape of a real visit: `?ref=courtney` was on the page the person
    // landed on, `middleware.ts` copied it into a cookie, and by the time
    // they actually submit the form the URL no longer carries the param at
    // all — `app/page.tsx` only has the cookie left to read.
    const { client, insert } = recordingClient();

    const referredBy = resolveWaitlistReferral(undefined, "courtney");
    const result = await submitWaitlist(client, {
      email: "jane@example.com",
      referredBy,
    });

    expect(result).toEqual({ ok: true, alreadyJoined: false });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ referred_by: "courtney" })
    );
  });

  it("matches WAITLIST_TABLE and the full row shape, referred_by included", async () => {
    const { client, from, insert } = recordingClient();

    await submitWaitlist(client, {
      email: "Jane@Example.com",
      name: "Jane",
      biggestFrustration: "Retyping the same six answers.",
      weeklyApplicationVolume: "5_to_15",
      referredBy: "courtney",
    });

    expect(from).toHaveBeenCalledWith(WAITLIST_TABLE);
    const expected: WaitlistRow = {
      email: "jane@example.com",
      name: "Jane",
      biggest_frustration: "Retyping the same six answers.",
      weekly_application_volume: "5_to_15",
      referred_by: "courtney",
    };
    expect(insert).toHaveBeenCalledWith(expected);
  });
});
