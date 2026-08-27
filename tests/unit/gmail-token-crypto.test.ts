/**
 * JOB-189 — lib/gmail-token-crypto.ts.
 *
 * A real 32 byte key is set before each test and restored after, matching
 * the pattern tests/unit/browserbase-stealth-settings.test.ts uses for any
 * module that reads `process.env` at call time rather than at import time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GmailTokenCryptoError,
  decryptGmailRefreshToken,
  encryptGmailRefreshToken,
} from "@/lib/gmail-token-crypto";

const ENV_VAR = "GMAIL_TOKEN_ENCRYPTION_KEY";
const VALID_KEY_HEX = "a".repeat(64);
const OTHER_VALID_KEY_HEX = "b".repeat(64);

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env[ENV_VAR];
  process.env[ENV_VAR] = VALID_KEY_HEX;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedKey;
});

describe("encryptGmailRefreshToken / decryptGmailRefreshToken round trip", () => {
  it("decrypts back to the original token", () => {
    const token = "1//0gExampleRefreshTokenValue";
    const ciphertext = encryptGmailRefreshToken(token);
    expect(decryptGmailRefreshToken(ciphertext)).toBe(token);
  });

  it("produces a different ciphertext on every call, from a fresh random IV", () => {
    const token = "1//0gExampleRefreshTokenValue";
    const first = encryptGmailRefreshToken(token);
    const second = encryptGmailRefreshToken(token);
    expect(first).not.toBe(second);
    expect(decryptGmailRefreshToken(first)).toBe(token);
    expect(decryptGmailRefreshToken(second)).toBe(token);
  });

  it("stores the iv, auth tag, and ciphertext as three dot separated hex segments", () => {
    const ciphertext = encryptGmailRefreshToken("token-value");
    const parts = ciphertext.split(".");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("refuses to encrypt an empty token", () => {
    expect(() => encryptGmailRefreshToken("")).toThrow(GmailTokenCryptoError);
    expect(() => encryptGmailRefreshToken("   ")).toThrow(GmailTokenCryptoError);
  });
});

describe("decryptGmailRefreshToken with the wrong key", () => {
  it("throws rather than returning a wrong plaintext", () => {
    const ciphertext = encryptGmailRefreshToken("1//0gExampleRefreshTokenValue");
    process.env[ENV_VAR] = OTHER_VALID_KEY_HEX;
    expect(() => decryptGmailRefreshToken(ciphertext)).toThrow(GmailTokenCryptoError);
  });
});

describe("decryptGmailRefreshToken with a tampered ciphertext", () => {
  it("throws when a byte of the ciphertext segment is flipped", () => {
    const ciphertext = encryptGmailRefreshToken("1//0gExampleRefreshTokenValue");
    const [ivHex, authTagHex, dataHex] = ciphertext.split(".");
    const tamperedFirstByte = ((parseInt(dataHex.slice(0, 2), 16) ^ 0xff) & 0xff)
      .toString(16)
      .padStart(2, "0");
    const tamperedDataHex = tamperedFirstByte + dataHex.slice(2);
    const tampered = [ivHex, authTagHex, tamperedDataHex].join(".");

    expect(() => decryptGmailRefreshToken(tampered)).toThrow(GmailTokenCryptoError);
  });

  it("throws when the auth tag segment is tampered with", () => {
    const ciphertext = encryptGmailRefreshToken("1//0gExampleRefreshTokenValue");
    const [ivHex, authTagHex, dataHex] = ciphertext.split(".");
    const tamperedFirstByte = ((parseInt(authTagHex.slice(0, 2), 16) ^ 0xff) & 0xff)
      .toString(16)
      .padStart(2, "0");
    const tamperedAuthTagHex = tamperedFirstByte + authTagHex.slice(2);
    const tampered = [ivHex, tamperedAuthTagHex, dataHex].join(".");

    expect(() => decryptGmailRefreshToken(tampered)).toThrow(GmailTokenCryptoError);
  });

  it("throws on a malformed shape (wrong number of segments)", () => {
    expect(() => decryptGmailRefreshToken("not-a-real-ciphertext")).toThrow(
      GmailTokenCryptoError
    );
    expect(() => decryptGmailRefreshToken("a.b")).toThrow(GmailTokenCryptoError);
    expect(() => decryptGmailRefreshToken("a.b.c.d")).toThrow(GmailTokenCryptoError);
  });

  it("throws on a segment that is not valid hex", () => {
    expect(() => decryptGmailRefreshToken("zz.zz.zz")).toThrow(GmailTokenCryptoError);
  });

  it("throws on an odd length hex segment instead of silently dropping the trailing nibble", () => {
    const ciphertext = encryptGmailRefreshToken("1//0gExampleRefreshTokenValue");
    const [ivHex, authTagHex, dataHex] = ciphertext.split(".");
    const oddLengthDataHex = dataHex.slice(0, -1);
    const tampered = [ivHex, authTagHex, oddLengthDataHex].join(".");

    expect(() => decryptGmailRefreshToken(tampered)).toThrow(GmailTokenCryptoError);
  });

  it("throws on an empty ciphertext", () => {
    expect(() => decryptGmailRefreshToken("")).toThrow(GmailTokenCryptoError);
  });
});

describe("decryptGmailRefreshToken with a wrong length auth tag", () => {
  it("throws on a truncated auth tag rather than accepting a weaker check", () => {
    const ciphertext = encryptGmailRefreshToken("1//0gExampleRefreshTokenValue");
    const [ivHex, authTagHex, dataHex] = ciphertext.split(".");
    // Drop the last byte (two hex characters) of a valid 16 byte auth tag,
    // leaving 15 bytes. Node's GCM implementation accepts a truncated tag
    // unless `authTagLength` is passed explicitly to `createDecipheriv`, so
    // this only throws once that option is set.
    const truncatedAuthTagHex = authTagHex.slice(0, -2);
    const tampered = [ivHex, truncatedAuthTagHex, dataHex].join(".");

    expect(() => decryptGmailRefreshToken(tampered)).toThrow(GmailTokenCryptoError);
  });

  it("throws on an oversized auth tag", () => {
    const ciphertext = encryptGmailRefreshToken("1//0gExampleRefreshTokenValue");
    const [ivHex, authTagHex, dataHex] = ciphertext.split(".");
    const oversizedAuthTagHex = authTagHex + "ab";
    const tampered = [ivHex, oversizedAuthTagHex, dataHex].join(".");

    expect(() => decryptGmailRefreshToken(tampered)).toThrow(GmailTokenCryptoError);
  });
});

describe("a missing or malformed GMAIL_TOKEN_ENCRYPTION_KEY", () => {
  it("throws on encrypt when the key is unset", () => {
    delete process.env[ENV_VAR];
    expect(() => encryptGmailRefreshToken("token-value")).toThrow(GmailTokenCryptoError);
  });

  it("throws on decrypt when the key is unset", () => {
    const ciphertext = encryptGmailRefreshToken("token-value");
    delete process.env[ENV_VAR];
    expect(() => decryptGmailRefreshToken(ciphertext)).toThrow(GmailTokenCryptoError);
  });

  it("throws when the key is the wrong length", () => {
    process.env[ENV_VAR] = "abcd";
    expect(() => encryptGmailRefreshToken("token-value")).toThrow(GmailTokenCryptoError);
  });

  it("throws when the key is not valid hex", () => {
    process.env[ENV_VAR] = "z".repeat(64);
    expect(() => encryptGmailRefreshToken("token-value")).toThrow(GmailTokenCryptoError);
  });
});
