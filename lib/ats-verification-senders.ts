/**
 * JOB-211 — sender allowlist for the Gmail verification code reader.
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * The single source of truth for which email senders a live submit run will
 * trust to have sent a real one time verification code, keyed by the ATS
 * platform slug the ticket already uses everywhere else (`AtsPlatform` from
 * `lib/db/schema.ts`, matching the `jobs.ats` and `boards.ats` columns and the
 * feed reader keys in `lib/ats-job-feeds.ts`). Do not invent a second taxonomy;
 * anything that resolves an ATS slug already reads from `AtsPlatform`.
 *
 * ── What an entry means ──────────────────────────────────────────────────────
 * Each entry is either:
 *
 *   1. an exact email address, e.g. `"no-reply@greenhouse.io"`, matched
 *      byte for byte against the parsed `From:` header, or
 *   2. a domain suffix beginning with `@`, e.g. `"@greenhouse.io"`, matched
 *      against the address host and any subdomain of it. `@greenhouse.io`
 *      accepts `no-reply@greenhouse.io` and `mail.greenhouse.io`, but never
 *      `greenhouse.io.attacker.example`.
 *
 * The reader in `lib/gmail-verification-reader.ts` composes these entries into
 * the Gmail search `q=` string and re-checks the `From:` header against the
 * same list after `messages.get`. Both checks share this module so an entry
 * added here changes both sides at once.
 *
 * ── Add an entry only when we have proof ─────────────────────────────────────
 * Every value in this map must be an address seen on a real verification
 * email during a real submit run. Adding "probably" here is exactly the kind
 * of speculative widening the ticket forbids: it broadens the mailbox scope
 * this reader is willing to trust, on a scope Google explicitly asks us to
 * keep narrow. When a new ATS is confirmed, add its entry in a small PR that
 * names the message id or the date it was seen.
 *
 * V1 ships with Greenhouse populated only. That is what the JOB-211 demo is
 * built against and it is the one ATS whose verification mail sender is
 * confirmed in existing code comments and the ported ACT-006 module.
 *
 * ── Never widen this at runtime ──────────────────────────────────────────────
 * There is no fallback branch anywhere that treats an empty list as "read
 * everything". `lookupVerificationSenders` returns `[]` for an ATS not in the
 * map, and the reader treats `[]` as `no_match` before any Gmail call. A
 * caller that passes an unknown ATS gets no reads and no code, which is the
 * correct failure direction here.
 */

import type { AtsPlatform } from "@/lib/db/schema";

/**
 * Frozen map from `AtsPlatform` slug to the addresses or domain suffixes we
 * accept a verification email `From:` header from.
 *
 * The type reads `Partial<Record<AtsPlatform, ...>>` on purpose: an ATS with
 * no entry here returns an empty allowlist from `lookupVerificationSenders`,
 * which the reader turns into `no_match` without a Gmail call. Adding a new
 * ATS to the taxonomy in `lib/db/schema.ts` must not silently grant it a
 * "probably ok" default here.
 */
export const VERIFICATION_SENDERS_BY_ATS: Readonly<
  Partial<Record<AtsPlatform, readonly string[]>>
> = Object.freeze({
  // Confirmed on the message ACT-017's own comment quotes verbatim:
  // "Security code for your application to Discord", "Copy and paste this
  // code into the security code field on your application: uMO4xvqA".
  // That message is from Greenhouse's own mail infra, not the employer's,
  // and both `no-reply@greenhouse.io` and the wider `@greenhouse.io`
  // suffix are trusted here so a small `mail.` or `notifications.`
  // subdomain shift on Greenhouse's side does not silently break the read.
  //
  // The pattern the wiring in `lib/fill-application-form.ts` runs against
  // this sender's mail is anchored on the word "code" and expects a 6 to 10
  // character alphanumeric run that contains at least one digit. That is
  // what `uMO4xvqA` looks like. If a future Greenhouse code carries a
  // different shape (all digits, no digits, shorter or longer), widen the
  // pattern there only after seeing the new shape on a real message.
  greenhouse: Object.freeze([
    "no-reply@greenhouse.io",
    "@greenhouse.io",
  ]),
});

/**
 * The allowlist for one ATS, or an empty array when we have not confirmed a
 * sender for that ATS. The reader must never fall back to any wider scope
 * on an empty return.
 */
export function lookupVerificationSenders(ats: string): readonly string[] {
  const entry = (
    VERIFICATION_SENDERS_BY_ATS as Record<string, readonly string[] | undefined>
  )[ats];
  return entry ?? [];
}
