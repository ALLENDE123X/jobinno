/**
 * JOB-217 — `lib/gmail-auto-read-gate.ts`.
 *
 * The wiring in `lib/fill-application-form.ts` reads this gate every time
 * `completeVerification` is about to call the reader, so a flip of the env
 * variable takes effect on the next call rather than requiring a redeploy.
 * These tests verify the exact contract the wiring depends on: the gate is
 * true only when the variable is the literal string `"on"`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isGmailAutoReadEnabled } from "@/lib/gmail-auto-read-gate";

const ENV_VAR = "JOBINNO_GMAIL_AUTO_READ";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_VAR];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = saved;
});

describe("isGmailAutoReadEnabled — the JOB-217 deploy time gate", () => {
  it("is false when the env var is unset (the default)", () => {
    delete process.env[ENV_VAR];
    expect(isGmailAutoReadEnabled()).toBe(false);
  });

  it("is true when the env var is exactly \"on\"", () => {
    process.env[ENV_VAR] = "on";
    expect(isGmailAutoReadEnabled()).toBe(true);
  });

  it("is false for every value other than \"on\" that a caller might try", () => {
    const disallowed = ["", "off", "OFF", "ON", "true", "TRUE", "1", "yes", "enabled", " on ", "on "];
    for (const value of disallowed) {
      process.env[ENV_VAR] = value;
      expect(isGmailAutoReadEnabled()).toBe(false);
    }
  });

  it("picks up an in process flip without a module reload", () => {
    delete process.env[ENV_VAR];
    expect(isGmailAutoReadEnabled()).toBe(false);
    process.env[ENV_VAR] = "on";
    expect(isGmailAutoReadEnabled()).toBe(true);
    process.env[ENV_VAR] = "off";
    expect(isGmailAutoReadEnabled()).toBe(false);
  });
});
