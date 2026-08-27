/**
 * JOB-189 — lib/gmail-oauth.ts, the signed state parameter.
 *
 * A real 32 hex character secret is set before each test and restored
 * after, matching the pattern tests/unit/gmail-token-crypto.test.ts uses for
 * any module that reads `process.env` at call time rather than at import
 * time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GmailOAuthStateError,
  signGmailOAuthState,
  verifyGmailOAuthState,
} from "@/lib/gmail-oauth";

const ENV_VAR = "GMAIL_OAUTH_STATE_SECRET";
const VALID_SECRET_HEX = "a".repeat(32);
const OTHER_VALID_SECRET_HEX = "b".repeat(32);

let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env[ENV_VAR];
  process.env[ENV_VAR] = VALID_SECRET_HEX;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedSecret;
});

describe("signGmailOAuthState / verifyGmailOAuthState round trip", () => {
  it("verifies a state it just signed for the same user", () => {
    const userId = "user-123";
    const state = signGmailOAuthState(userId);
    expect(() => verifyGmailOAuthState(state, userId)).not.toThrow();
  });

  it("throws when the state was issued for a different user", () => {
    const state = signGmailOAuthState("user-123");
    expect(() => verifyGmailOAuthState(state, "someone-else")).toThrow(GmailOAuthStateError);
  });
});

describe("a missing or malformed GMAIL_OAUTH_STATE_SECRET", () => {
  it("throws on sign when the secret is unset", () => {
    delete process.env[ENV_VAR];
    expect(() => signGmailOAuthState("user-123")).toThrow(GmailOAuthStateError);
  });

  it("throws on verify when the secret is unset", () => {
    const state = signGmailOAuthState("user-123");
    delete process.env[ENV_VAR];
    expect(() => verifyGmailOAuthState(state, "user-123")).toThrow(GmailOAuthStateError);
  });

  it("throws when the secret is shorter than 32 hex characters", () => {
    process.env[ENV_VAR] = "abcd";
    expect(() => signGmailOAuthState("user-123")).toThrow(GmailOAuthStateError);
  });

  it("throws when the secret is longer than 32 hex characters", () => {
    process.env[ENV_VAR] = "a".repeat(64);
    expect(() => signGmailOAuthState("user-123")).toThrow(GmailOAuthStateError);
  });

  it("throws when the secret is not valid hex", () => {
    process.env[ENV_VAR] = "z".repeat(32);
    expect(() => signGmailOAuthState("user-123")).toThrow(GmailOAuthStateError);
  });

  it("succeeds with a correctly sized hex secret, sign and verify round trip", () => {
    process.env[ENV_VAR] = OTHER_VALID_SECRET_HEX;
    const state = signGmailOAuthState("user-123");
    expect(() => verifyGmailOAuthState(state, "user-123")).not.toThrow();
  });
});

describe("verifyGmailOAuthState with a tampered or malformed state", () => {
  it("throws on a malformed shape (wrong number of segments)", () => {
    expect(() => verifyGmailOAuthState("not-a-real-state", "user-123")).toThrow(
      GmailOAuthStateError
    );
  });

  it("throws when the signature does not match", () => {
    const state = signGmailOAuthState("user-123");
    const [payloadB64Url] = state.split(".");
    const tampered = `${payloadB64Url}.${"0".repeat(64)}`;
    expect(() => verifyGmailOAuthState(tampered, "user-123")).toThrow(GmailOAuthStateError);
  });
});
