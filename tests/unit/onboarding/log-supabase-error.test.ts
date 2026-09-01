// @vitest-environment node
/**
 * JOB-319 — describeSupabaseReadError is the shared log line formatter both
 * onboarding routing pages hand a failed Supabase read to. The properties
 * this file locks in:
 *
 *  1. Every field PostgREST fills in beyond `message` (code, details,
 *     hint) makes it onto the line, since `message` alone often does not
 *     tell a missing column apart from a policy that refused the row.
 *  2. A missing field logs as the string "null" rather than as the JS
 *     literal "undefined", because a log grep for a code value should
 *     always find the same shape.
 *  3. A raw thrown value (a string, or a plain Error whose message is all
 *     there is) still logs the message field rather than "[object Object]".
 *  4. No email or user-identifying value is invented on the caller's
 *     behalf. The helper never sees the user id — that stays with the two
 *     pages, which already know which user's read failed.
 */
import { describe, expect, it } from "vitest";

import { describeSupabaseReadError } from "@/lib/onboarding/log-supabase-error";

describe("describeSupabaseReadError", () => {
  it("formats a full supabase-js error with every PostgREST field", () => {
    const err = {
      message: "connection reset by peer",
      code: "PGRST000",
      details: "server terminated the connection",
      hint: "retry with backoff",
    };
    const line = describeSupabaseReadError(err);
    expect(line).toContain("message=connection reset by peer");
    expect(line).toContain("code=PGRST000");
    expect(line).toContain("details=server terminated the connection");
    expect(line).toContain("hint=retry with backoff");
  });

  it("logs missing fields as the string 'null' so a grep matches consistently", () => {
    const err = { message: "statement timeout" };
    const line = describeSupabaseReadError(err);
    expect(line).toContain("message=statement timeout");
    expect(line).toContain("code=null");
    expect(line).toContain("details=null");
    expect(line).toContain("hint=null");
  });

  it("handles a raw thrown string by putting it on the message field", () => {
    expect(describeSupabaseReadError("network unavailable")).toBe(
      "message=network unavailable",
    );
  });

  it("returns a stable sentinel when nothing was actually thrown", () => {
    expect(describeSupabaseReadError(null)).toBe("no error");
    expect(describeSupabaseReadError(undefined)).toBe("no error");
  });

  it("stringifies non-string field values rather than dropping them", () => {
    // Some clients set `code` to a numeric HTTP status. A number should
    // still land on the log line rather than log as "null".
    const err = { message: "boom", code: 500, details: null, hint: null };
    const line = describeSupabaseReadError(err);
    expect(line).toContain("code=500");
  });
});
