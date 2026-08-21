/**
 * The creator signup insert, checked at the payload boundary (JOB-042), on
 * the same reasoning `tests/unit/feedback.test.ts` documents: RLS and a CHECK
 * constraint will both reject a near miss and the failure surfaces as a shrug
 * in the browser, so what matters is that the row this module builds matches
 * the columns `creators` actually has and that a rule the form enforces also
 * holds before any network call is made.
 */

import { describe, expect, it, vi } from "vitest";

import { CREATOR_PAYOUT_METHODS } from "@/lib/db/schema";
import {
  buildCreatorRow,
  buildReferralLink,
  submitCreatorSignup,
  CREATOR_PAYOUT_METHOD_OPTIONS,
  CREATORS_TABLE,
  type CreatorInput,
  type CreatorRow,
  type CreatorSignupInsertClient,
} from "@/lib/creator-signup";

/** Records the table and row it was handed, and reports no error. */
function recordingClient() {
  const insert = vi.fn(async () => ({ error: null }));
  const from = vi.fn(() => ({ insert }));
  return {
    client: { from } as unknown as CreatorSignupInsertClient,
    from,
    insert,
  };
}

/** A full, valid set of answers, so each test only has to override what it cares about. */
const VALID_INPUT: CreatorInput = {
  name: "Courtney Lee",
  email: "Courtney@Example.com",
  refCode: "Courtney-2026",
  instagramHandle: "@courtney",
  linkedinHandle: "",
  tiktokHandle: "",
  twitterHandle: "",
  otherSocial: "",
  payoutMethod: "zelle",
  payoutTag: "555 123 4567",
  phoneNumber: "555 987 6543",
};

describe("creator payout methods", () => {
  it("offers exactly the methods the table's CHECK constraint allows", () => {
    expect(CREATOR_PAYOUT_METHOD_OPTIONS.map((option) => option.value)).toEqual([
      ...CREATOR_PAYOUT_METHODS,
    ]);
  });
});

describe("buildCreatorRow", () => {
  it("uses the table's own column names, trims every field, and lowercases email and ref code", () => {
    const row = buildCreatorRow(VALID_INPUT);

    const expected: CreatorRow = {
      name: "Courtney Lee",
      email: "courtney@example.com",
      ref_code: "courtney-2026",
      instagram_handle: "@courtney",
      linkedin_handle: null,
      tiktok_handle: null,
      twitter_handle: null,
      other_social: null,
      payout_method: "zelle",
      payout_tag: "555 123 4567",
      phone_number: "555 987 6543",
    };

    expect(row).toEqual(expected);
  });

  it("folds a blank or whitespace only optional social to null", () => {
    const row = buildCreatorRow({
      ...VALID_INPUT,
      instagramHandle: "   ",
      linkedinHandle: "linkedin.com/in/courtney",
    });

    expect(row.instagram_handle).toBeNull();
    expect(row.linkedin_handle).toBe("linkedin.com/in/courtney");
  });
});

describe("buildReferralLink", () => {
  it("builds the working link a creator is shown on success", () => {
    expect(buildReferralLink("courtney")).toBe(
      "https://jobinno.app/?ref=courtney"
    );
  });
});

describe("submitCreatorSignup", () => {
  it("inserts one row and returns the referral link on a valid submission", async () => {
    const { client, from, insert } = recordingClient();

    const result = await submitCreatorSignup(client, VALID_INPUT);

    expect(result).toEqual({
      ok: true,
      refCode: "courtney-2026",
      referralLink: "https://jobinno.app/?ref=courtney-2026",
    });
    expect(from).toHaveBeenCalledWith(CREATORS_TABLE);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(buildCreatorRow(VALID_INPUT));
  });

  it("turns a duplicate email into a friendly message rather than the raw Postgres error", async () => {
    const insert = vi.fn(async () => ({
      error: {
        message:
          'duplicate key value violates unique constraint "creators_email_key"',
        code: "23505",
      },
    }));
    const client = { from: vi.fn(() => ({ insert })) } as unknown as CreatorSignupInsertClient;

    const result = await submitCreatorSignup(client, VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      message: "That email is already registered for the creator program.",
    });
  });

  it("turns a duplicate referral code into a friendly message rather than the raw Postgres error", async () => {
    const insert = vi.fn(async () => ({
      error: {
        message:
          'duplicate key value violates unique constraint "creators_ref_code_key"',
        code: "23505",
      },
    }));
    const client = { from: vi.fn(() => ({ insert })) } as unknown as CreatorSignupInsertClient;

    const result = await submitCreatorSignup(client, VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      message: "That referral code is already taken. Try a different one.",
    });
  });

  it("refuses a submission with all five social fields blank, without touching the database", async () => {
    const { client, from } = recordingClient();

    const result = await submitCreatorSignup(client, {
      ...VALID_INPUT,
      instagramHandle: "",
      linkedinHandle: "",
      tiktokHandle: "",
      twitterHandle: "",
      otherSocial: "",
    });

    expect(result.ok).toBe(false);
    expect(
      result.ok === false && result.message
    ).toBe(
      "Add at least one of Instagram, LinkedIn, TikTok, Twitter or another social profile."
    );
    expect(from).not.toHaveBeenCalled();
  });

  it("accepts a submission where only one social field is filled in", async () => {
    const { client } = recordingClient();

    const result = await submitCreatorSignup(client, {
      ...VALID_INPUT,
      instagramHandle: "",
      otherSocial: "youtube.com/courtney",
    });

    expect(result.ok).toBe(true);
  });

  it("refuses an unselected payout method, without touching the database", async () => {
    const { client, from } = recordingClient();

    const result = await submitCreatorSignup(client, {
      ...VALID_INPUT,
      payoutMethod: "",
    });

    expect(result).toEqual({ ok: false, message: "Choose a payout method." });
    expect(from).not.toHaveBeenCalled();
  });

  it("accepts every payout method the CHECK constraint allows", async () => {
    for (const method of CREATOR_PAYOUT_METHODS) {
      const { client } = recordingClient();
      const result = await submitCreatorSignup(client, {
        ...VALID_INPUT,
        payoutMethod: method,
      });
      expect(result.ok).toBe(true);
    }
  });

  it("refuses a referral code outside the allowed shape, without touching the database", async () => {
    const { client, from } = recordingClient();

    const result = await submitCreatorSignup(client, {
      ...VALID_INPUT,
      refCode: "ab",
    });

    expect(result.ok).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it("returns a non unique violation error rather than throwing", async () => {
    const insert = vi.fn(async () => ({
      error: { message: "new row violates row level security policy" },
    }));
    const client = { from: vi.fn(() => ({ insert })) } as unknown as CreatorSignupInsertClient;

    const result = await submitCreatorSignup(client, VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      message: "new row violates row level security policy",
    });
  });
});
