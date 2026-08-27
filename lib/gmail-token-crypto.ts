/**
 * JOB-189 — encrypts the Gmail refresh token before it ever reaches
 * `profiles.gmail_refresh_token`.
 *
 * AES-256-GCM under a key that lives only in `GMAIL_TOKEN_ENCRYPTION_KEY`
 * (a 32 byte key, given as 64 hex characters) and never in the database. A
 * stolen row is therefore ciphertext with no key behind it, which is the
 * whole reason this file exists rather than writing the refresh token
 * `app/api/auth/gmail/callback/route.ts` receives straight into the column.
 *
 * The stored shape is `${ivHex}.${authTagHex}.${ciphertextHex}`: the
 * initialization vector and the authentication tag travel with the
 * ciphertext because both are required to decrypt it and neither is secret
 * on its own. GCM's authentication tag is also what turns a tampered or
 * truncated ciphertext into a thrown error rather than a wrong answer
 * decrypted silently — `decryptGmailRefreshToken` cannot return a value that
 * was not the exact bytes `encryptGmailRefreshToken` produced.
 *
 * Every failure here is a `GmailTokenCryptoError` naming what went wrong.
 * None of them include the key, the token, or the ciphertext in the message:
 * both the key and the raw refresh token are on the never-log list the
 * ticket calls out, and a decryption failure message that echoed the
 * ciphertext back would put a real user's encrypted credential in a log
 * line for no reason.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;

export class GmailTokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailTokenCryptoError";
  }
}

/**
 * Reads and validates `GMAIL_TOKEN_ENCRYPTION_KEY`. Fails closed: an unset,
 * short, or non hex value is a `GmailTokenCryptoError` rather than a key
 * silently coerced into something the wrong length, which is how AES would
 * otherwise fail much later with a confusing error from `node:crypto`
 * itself.
 */
function loadKey(): Buffer {
  const hex = process.env.GMAIL_TOKEN_ENCRYPTION_KEY?.trim();
  if (!hex) {
    throw new GmailTokenCryptoError(
      "GMAIL_TOKEN_ENCRYPTION_KEY is required but not set. See .env.example; " +
        "generate one with `openssl rand -hex 32`."
    );
  }
  const expectedHexLength = KEY_LENGTH_BYTES * 2;
  if (hex.length !== expectedHexLength || !/^[0-9a-f]+$/i.test(hex)) {
    throw new GmailTokenCryptoError(
      `GMAIL_TOKEN_ENCRYPTION_KEY must be exactly ${expectedHexLength} hex characters ` +
        `(${KEY_LENGTH_BYTES} bytes) for AES-256-GCM. Generate one with \`openssl rand -hex 32\`.`
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * A hex string, decoded, or `null` when it is not valid hex at all.
 *
 * `Buffer.from(value, "hex")` does not throw on invalid input; it stops
 * decoding at the first character it cannot read and returns whatever it
 * managed so far, which is exactly the kind of silent partial success this
 * module exists to avoid. Validating the string first is what turns a
 * malformed segment into a thrown error instead of a truncated buffer.
 */
function decodeHex(value: string): Buffer | null {
  if (value === "" || !/^[0-9a-f]+$/i.test(value)) return null;
  return Buffer.from(value, "hex");
}

/**
 * Encrypts a Gmail refresh token for storage. Returns
 * `${ivHex}.${authTagHex}.${ciphertextHex}`.
 */
export function encryptGmailRefreshToken(token: string): string {
  if (typeof token !== "string" || token.trim() === "") {
    throw new GmailTokenCryptoError("Cannot encrypt an empty refresh token.");
  }

  const key = loadKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(".");
}

/**
 * The inverse of `encryptGmailRefreshToken`. Throws `GmailTokenCryptoError`
 * when the ciphertext is malformed, was encrypted under a different key, or
 * fails GCM's authentication check — which is what a single flipped byte
 * anywhere in a tampered value produces. None of those three cases are
 * distinguished in the thrown message, on purpose: telling an attacker which
 * one they hit is free information a legitimate caller never needs.
 */
export function decryptGmailRefreshToken(ciphertext: string): string {
  if (typeof ciphertext !== "string" || ciphertext === "") {
    throw new GmailTokenCryptoError("Cannot decrypt an empty ciphertext.");
  }

  const parts = ciphertext.split(".");
  if (parts.length !== 3) {
    throw new GmailTokenCryptoError(
      `Malformed Gmail refresh token ciphertext: expected "iv.authTag.ciphertext", ` +
        `got ${parts.length} segment(s).`
    );
  }
  const [ivHex, authTagHex, dataHex] = parts;

  const iv = decodeHex(ivHex);
  const authTag = decodeHex(authTagHex);
  const data = decodeHex(dataHex);
  if (iv === null || authTag === null || data === null) {
    throw new GmailTokenCryptoError(
      "Malformed Gmail refresh token ciphertext: one or more segments are not valid hex."
    );
  }
  if (iv.length !== IV_LENGTH_BYTES) {
    throw new GmailTokenCryptoError(
      `Malformed Gmail refresh token ciphertext: the IV must be ${IV_LENGTH_BYTES} bytes, got ${iv.length}.`
    );
  }

  const key = loadKey();

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // `setAuthTag`/`final` throw on a bad key, a tampered ciphertext, or a
    // tampered tag. All three land here as one message, per the header.
    throw new GmailTokenCryptoError(
      "Failed to decrypt Gmail refresh token: the ciphertext is invalid, tampered with, " +
        "or was encrypted under a different key."
    );
  }
}
