/**
 * JOB-211 — Gmail verification code reader.
 *
 * One function: `findVerificationCode`. Its whole job is to look at one
 * mailbox, narrowly, for one specific verification email that a live submit
 * run is waiting on, extract the code, and return it. It is the read side of
 * the `gmail.readonly` scope Jobinno was granted through the JOB-189 OAuth
 * flow, and it is the piece Google's OAuth verification demo has to record
 * the scope actually being used for.
 *
 * ── What this deliberately is not ────────────────────────────────────────────
 * Not a background poller. Not a subscriber to a mailbox. Not `lib/future-gmail/`.
 * That folder is V2 reference code kept unwired on purpose (see its README
 * and CLAUDE.md HARD STOP 11). This module was written from scratch, imports
 * nothing from there, and scopes narrower than that reference implementation
 * did: no ambiguity tie break across concurrent signups (the caller has one
 * row already), no verification link path (the caller passes a code pattern),
 * no intent regex (an anchor phrase inside `codePattern` is the caller's
 * responsibility to compose), no persistence, no logging of email content.
 *
 * ── Security boundary (read this before changing the scope) ──────────────────
 * A module that reads inbound email and returns a value the browser will type
 * into a real employer's site is a phishing target by construction. The
 * scope this reader trusts is bounded by three things, all of which must hold
 * for a message to be returned:
 *
 *  1. **Sender allowlist.** The caller passes it. An empty allowlist returns
 *     `no_match` immediately, before any Gmail call, because a bug in a
 *     caller that forgot to fill the allowlist would otherwise silently read
 *     the whole mailbox. There is no default. There is no fallback that
 *     widens on failure.
 *  2. **Time window.** The caller passes `since` and `until` as `Date`s.
 *     They are turned into unix seconds and pushed into the Gmail query as
 *     `after:`/`before:`, then re-checked exactly against each returned
 *     message's `internalDate` because Gmail's own granularity there is not
 *     contractually to the second.
 *  3. **Code pattern.** The caller passes the regex. This reader does not
 *     guess. Different ATS platforms use different code shapes and guessing
 *     here would either burn Gmail quota on wrong hits or, worse, hand a
 *     wrong string back to the type in stage.
 *
 * Every failure is fail closed: an unreadable message, a decode error, a
 * stray Gmail 5xx, an unparseable `internalDate` — all lead to a typed
 * status the caller renders as "we did not read a code" and never to a
 * plausible looking wrong code.
 *
 * ── Reads this will never do ─────────────────────────────────────────────────
 *  · No modifying endpoint. Only `users.messages.list` and `users.messages.get`.
 *    No `watch`, no `labels`, no `threads`, no `settings.*`.
 *  · No pagination. First page of results only, `maxResults` capped at 20. If
 *    the allowlist and window are tight the code is on that page. If a real
 *    case ever fails because of this, that is its own ticket.
 *  · No empty query. Empty allowlist returns `no_match` before the network call.
 *  · No debug flag that logs subject lines or body content. Every log line in
 *    this module names the message id and the shape of the outcome only.
 *  · No cache, no debug table write, no dumping into `skip_log`. The caller
 *    gets the match. Everything else is dropped.
 */

import { google, type gmail_v1 } from "googleapis";

import { decryptGmailRefreshToken } from "@/lib/gmail-token-crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";

const LOG = "[gmail-verification-reader]";

/**
 * Hard upper bound on messages examined per call. Not user tunable and not
 * meant to be raised without a ticket. The bound is on `messages.list` results
 * (first page only) plus a per message `messages.get`, and the whole thing has
 * to fit inside `timeoutMs` regardless. 20 is the ceiling from the ticket.
 */
const MAX_MESSAGES = 20;

/** Rejects hostile or malformed allowlist entries. */
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * One verification email matched against the caller's allowlist, window and
 * pattern.
 */
export type VerificationCodeMatch = {
  code: string;
  emailId: string;
  senderAddress: string;
  subject: string;
  /** ISO 8601. Derived from Gmail's `internalDate`. */
  receivedAt: string;
};

/**
 * Search inputs. Every field is the caller's responsibility to fill.
 *
 *  · `userId` — `profiles.id`, the person whose encrypted refresh token
 *    (`profiles.gmail_refresh_token`) is used to authenticate. Read via the
 *    service role client because the column has no user side SELECT grant.
 *  · `senderAllowlist` — exact addresses (`"no-reply@greenhouse.io"`) or
 *    domain suffixes starting with `@` (`"@greenhouse.io"`). See
 *    `lib/ats-verification-senders.ts` for how V1 populates this. Empty
 *    returns `no_match` immediately. There is no "default".
 *  · `since` / `until` — inclusive time window on Gmail's `internalDate`.
 *  · `codePattern` — the caller supplies the regex. The reader runs it
 *    against the plain text body first, then the subject. First win wins.
 *    A regex with a capture group returns the first non empty capture;
 *    otherwise the whole match is returned. Callers commonly pass a form
 *    that is anchored on a code announcing phrase so an unrelated 4 digit
 *    run in a marketing footer never comes back as `the code`.
 *  · `timeoutMs` — whole call budget as a hard cap. Enforced by
 *    `Promise.race`, so a slow Gmail does not hold up the surrounding submit
 *    run. Callers must treat a `read_failed` as "did not arrive in time",
 *    never as "retry forever".
 */
export type VerificationCodeSearch = {
  userId: string;
  senderAllowlist: readonly string[];
  since: Date;
  until: Date;
  codePattern: RegExp;
  timeoutMs: number;
};

/**
 * Typed outcome. `no_match` is not an error and is what a healthy call that
 * saw no eligible message returns.
 */
export type VerificationCodeResult =
  | { status: "found"; match: VerificationCodeMatch }
  | { status: "no_match"; readMessageCount: number; searchedUntil: string }
  | { status: "no_gmail_connection"; reason: string }
  | { status: "auth_failed"; reason: string }
  | { status: "read_failed"; reason: string };

/**
 * Thin seam over the two Gmail methods this reader is allowed to call. Kept
 * as an internal type so a test can pass a hand rolled shape without pulling
 * `googleapis` into the test at all.
 */
type GmailReader = {
  list: (query: string, maxResults: number) => Promise<gmail_v1.Schema$ListMessagesResponse>;
  get: (id: string) => Promise<gmail_v1.Schema$Message>;
};

/**
 * Injection hooks used only by tests. Production callers pass an input that
 * matches `VerificationCodeSearch` and nothing else; the second parameter is
 * `undefined` and the module builds its own reader from `googleapis` against
 * the user's encrypted refresh token.
 */
export type FindVerificationCodeInternals = {
  /** Swap the Gmail call layer entirely. */
  reader?: GmailReader;
  /** Swap the refresh token load (bypasses Supabase and decryption). */
  loadRefreshToken?: (userId: string) => Promise<string | null>;
  /** Deterministic clock for the timeout race. */
  now?: () => number;
};

/**
 * One narrow read of one user's Gmail for a verification code the caller is
 * about to type into a form. See the module header for the guardrails and
 * the reads this will and will not do.
 */
export async function findVerificationCode(
  input: VerificationCodeSearch,
  internals: FindVerificationCodeInternals = {}
): Promise<VerificationCodeResult> {
  // ── Guardrail: empty allowlist never falls through to a Gmail call. ────────
  // This is the whole point of the reader. A caller that forgot to fill the
  // allowlist (a wiring bug, a config oversight) must not read the mailbox.
  const cleanedAllowlist = normalizeAllowlist(input.senderAllowlist);
  if (cleanedAllowlist.length === 0) {
    return {
      status: "no_match",
      readMessageCount: 0,
      searchedUntil: input.until.toISOString(),
    };
  }

  // ── Guardrail: sanity check the time window. ───────────────────────────────
  // A `since > until` window would still produce a valid Gmail query (the
  // service just returns nothing), but a caller passing that here almost
  // certainly composed the times wrong. Report it rather than silently
  // returning `no_match`.
  const sinceMs = input.since.getTime();
  const untilMs = input.until.getTime();
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) {
    return {
      status: "read_failed",
      reason: "since/until is not a valid time window",
    };
  }

  // ── Guardrail: zero budget must not dispatch a single call. ────────────────
  // The original review finding here was that a non positive `timeoutMs`
  // still ran the Supabase load and reached the Gmail SDK before failing.
  // Reject upfront so no I/O happens at all.
  if (input.timeoutMs <= 0) {
    return {
      status: "read_failed",
      reason: `Gmail read has a non positive timeoutMs (${input.timeoutMs}ms); no Gmail call was made`,
    };
  }

  // ── The whole I/O chain runs inside one `timeoutMs` race. ──────────────────
  // Every step below can block on the network: the Supabase load of the
  // encrypted refresh token, the OAuth2 client's implicit access token mint,
  // `messages.list`, `messages.get`. The original code only raced the last
  // two. So a stalled Supabase call was unbounded. Now the whole chain is
  // the `operation` argument of the race, and the timeout is the hard cap
  // on the whole thing regardless of which step is slow.
  //
  // `Promise.race` still cannot cancel an in flight call, so a slow request
  // keeps running in the background after this function returns. That is
  // fine: the caller has already moved on, the process is short lived, and
  // nothing this module holds is written anywhere.
  const operation: Promise<VerificationCodeResult> = (async () => {
    let reader: GmailReader;
    if (internals.reader) {
      reader = internals.reader;
    } else {
      const loaded = await loadRefreshTokenSafely(input.userId, internals.loadRefreshToken);
      if (loaded.status !== "found") return loaded.result;
      try {
        reader = createGoogleapisReader(loaded.refreshToken);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "unknown error";
        return { status: "auth_failed", reason };
      }
    }

    const query = buildGmailQuery(cleanedAllowlist, sinceMs, untilMs);
    if (query === null) {
      return {
        status: "no_match",
        readMessageCount: 0,
        searchedUntil: input.until.toISOString(),
      };
    }

    return await performRead(
      reader,
      query,
      cleanedAllowlist,
      sinceMs,
      untilMs,
      input.codePattern
    );
  })();

  return await raceAgainstDeadline(operation, input.timeoutMs, input.until);
}

// ───────────────────────────────────
// Allowlist plumbing
// ───────────────────────────────────

/** Trim, lowercase, drop empties, drop syntactically hostile entries. */
function normalizeAllowlist(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;
    if (!isAcceptableAllowlistEntry(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Accepts either `"@domain.tld"` or `"local@domain.tld"`. Rejects anything
 * else so a malformed entry cannot land in the Gmail query as free text.
 */
function isAcceptableAllowlistEntry(entry: string): boolean {
  if (entry.startsWith("@")) {
    return DOMAIN_LABEL.test(entry.slice(1));
  }
  const at = entry.lastIndexOf("@");
  if (at <= 0) return false;
  const local = entry.slice(0, at);
  const host = entry.slice(at + 1);
  // The local part is deliberately loose here since RFC 5321 allows a lot,
  // and Gmail already lowercases what it compares. `+` and `.` are common.
  if (!/^[a-z0-9._+\-]+$/.test(local)) return false;
  return DOMAIN_LABEL.test(host);
}

/**
 * True when a parsed `From:` address is on the allowlist. Domain entries
 * match subdomains too, so `@greenhouse.io` accepts `mail.greenhouse.io`
 * but never `greenhouse.io.attacker.example`.
 */
export function isSenderOnAllowlist(
  fromHeader: string,
  allowlist: readonly string[]
): { allowed: boolean; address: string | null } {
  const address = parseAddress(fromHeader);
  if (address === null) return { allowed: false, address: null };
  const at = address.lastIndexOf("@");
  if (at === -1) return { allowed: false, address };
  const host = address.slice(at + 1);
  for (const entry of allowlist) {
    if (entry.startsWith("@")) {
      const domain = entry.slice(1);
      if (host === domain || host.endsWith(`.${domain}`)) {
        return { allowed: true, address };
      }
      continue;
    }
    if (address === entry) return { allowed: true, address };
  }
  return { allowed: false, address };
}

/**
 * `From:` header parser. Returns the routing address, lowercased, or null.
 *
 * ── The bug this exists to close ─────────────────────────────────────────────
 * The original parser took the FIRST `<...>` group in the header. A crafted
 * display name defeats that: a legal RFC 5322 header of the form
 *
 *   "Greenhouse <no-reply@greenhouse.io>" <attacker@evil.example>
 *
 * has two `<...>` runs, and only the second one is the actual routing
 * address per RFC 5322 (§3.4). The first is inside a quoted display name.
 * A naive first-match parser trusts the display name over the address the
 * mail was really sent from, and the sender allowlist trusts the wrong
 * side of it.
 *
 * ── What this does instead ───────────────────────────────────────────────────
 * Walk the header once, tracking whether the cursor is inside a `"..."`
 * quoted string. `<` and `>` inside quotes do not open or close an angle
 * addr; only unquoted `<...>` runs do. The routing address is the LAST
 * unquoted `<...>` run. If there is no unquoted `<...>` run at all the
 * whole trimmed header is treated as the address (bare `foo@bar` shape).
 *
 * The RFC has more shapes than this (comments in `(...)`, `\` escapes,
 * groups) but the ones that matter for sender-allowlist safety are:
 * (a) an attacker cannot smuggle a trusted address in the display name;
 * (b) a legitimate bare address without any display name still parses.
 * Both hold here.
 */
function parseAddress(header: string): string | null {
  let inQuotes = false;
  let escape = false;
  let lastOpen = -1;
  let lastClose = -1;
  let currentOpen = -1;
  for (let i = 0; i < header.length; i += 1) {
    const ch = header[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === "<") {
      currentOpen = i;
      continue;
    }
    if (ch === ">" && currentOpen >= 0) {
      lastOpen = currentOpen;
      lastClose = i;
      currentOpen = -1;
    }
  }
  const raw =
    lastOpen >= 0 && lastClose > lastOpen
      ? header.slice(lastOpen + 1, lastClose)
      : header;
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  const lowered = cleaned.toLowerCase();
  return lowered.includes("@") ? lowered : null;
}

// ───────────────────────────────────
// Gmail query composition
// ───────────────────────────────────

/**
 * Composes the Gmail search `q=` from an already normalized allowlist and a
 * time window in ms. Exported so a test can assert the exact string this
 * reader is asking Gmail for.
 */
export function buildGmailQuery(
  allowlist: readonly string[],
  sinceMs: number,
  untilMs: number
): string | null {
  const parts: string[] = [];
  for (const entry of allowlist) {
    // Gmail's `from:` accepts either a full address or a domain and treats
    // a domain as a suffix match. So both `from:no-reply@greenhouse.io`
    // and `from:greenhouse.io` are legal here. The `@` prefix on domain
    // entries is stripped for the query but preserved on the allowlist so
    // the re-check in `isSenderOnAllowlist` can still tell the two shapes
    // apart.
    parts.push(`from:${entry.startsWith("@") ? entry.slice(1) : entry}`);
  }
  if (parts.length === 0) return null;

  const afterSec = Math.floor(sinceMs / 1000);
  const beforeSec = Math.ceil(untilMs / 1000);
  const from = parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
  // `-in:trash` and `-in:spam` are conservative: a verification email caught
  // in either is a Gmail bug this reader cannot solve on its own, but not
  // returning nothing at all is worse than not returning a spam-classified
  // one.
  return `${from} after:${afterSec} before:${beforeSec} -in:trash -in:spam`;
}

// ───────────────────────────────────
// Refresh token load
// ───────────────────────────────────

/**
 * `profiles.gmail_refresh_token` for one user, decrypted. Returns a typed
 * `no_gmail_connection` when the column is null, and a typed `auth_failed`
 * when it exists but cannot be decrypted (a key rotation, corrupted row,
 * etc). Never logs the ciphertext or the token.
 */
async function loadRefreshTokenSafely(
  userId: string,
  overrideLoader: FindVerificationCodeInternals["loadRefreshToken"]
): Promise<
  | { status: "found"; refreshToken: string }
  | { status: "notfound"; result: VerificationCodeResult }
> {
  try {
    const loader = overrideLoader ?? defaultLoadRefreshToken;
    const encrypted = await loader(userId);
    if (encrypted === null || encrypted.length === 0) {
      return {
        status: "notfound",
        result: {
          status: "no_gmail_connection",
          reason: "profiles.gmail_refresh_token is not set for this user",
        },
      };
    }
    let plain: string;
    try {
      plain = decryptGmailRefreshToken(encrypted);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "decryption failed";
      return {
        status: "notfound",
        result: { status: "auth_failed", reason },
      };
    }
    return { status: "found", refreshToken: plain };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return {
      status: "notfound",
      result: { status: "read_failed", reason },
    };
  }
}

async function defaultLoadRefreshToken(userId: string): Promise<string | null> {
  const client = createServiceRoleClient();
  const { data, error } = await client
    .from("profiles")
    .select("gmail_refresh_token")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`profiles lookup for gmail_refresh_token failed: ${error.message}`);
  }
  if (!data) return null;
  const value = (data as { gmail_refresh_token: string | null }).gmail_refresh_token;
  return value ?? null;
}

// ───────────────────────────────────
// Real googleapis reader
// ───────────────────────────────────

function createGoogleapisReader(refreshToken: string): GmailReader {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must both be set to build a Gmail reader."
    );
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: "v1", auth });
  return {
    async list(query: string, maxResults: number) {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
      });
      return response.data;
    },
    async get(id: string) {
      const response = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      });
      return response.data;
    },
  };
}

// ───────────────────────────────────
// Message walk and code extraction
// ───────────────────────────────────

async function performRead(
  reader: GmailReader,
  query: string,
  allowlist: readonly string[],
  sinceMs: number,
  untilMs: number,
  codePattern: RegExp
): Promise<VerificationCodeResult> {
  let listed: gmail_v1.Schema$ListMessagesResponse;
  try {
    listed = await reader.list(query, MAX_MESSAGES);
  } catch (err) {
    return classifyGmailError(err);
  }

  const stubs = listed.messages ?? [];
  let readCount = 0;
  for (const stub of stubs) {
    if (!stub.id) continue;
    let message: gmail_v1.Schema$Message;
    try {
      message = await reader.get(stub.id);
    } catch (err) {
      // Auth failures affect every message uniformly (revoked token, expired
      // credential), so stop early. Every other per message error is skipped
      // and the loop continues to the next candidate: the point of this
      // reader is to find one code among many, not to require every
      // candidate to be readable.
      const classified = classifyGmailError(err);
      if (classified.status === "auth_failed") return classified;
      console.log(
        `${LOG} messages.get failed for ${stub.id}, continuing to the next candidate`
      );
      continue;
    }
    readCount += 1;

    // Re-check the sender against the allowlist even though the Gmail
    // query already narrowed by `from:`. This is not defence in depth for
    // its own sake: `from:` is a Gmail search operator and its semantics
    // are not contractually the byte for byte header check this module's
    // guarantee needs. The re-check happens against the exact `From:` header.
    const fromHeader = headerValue(message, "From");
    const senderCheck = isSenderOnAllowlist(fromHeader, allowlist);
    if (!senderCheck.allowed || senderCheck.address === null) continue;

    // Re-check the time window exactly.
    const internal = Number(message.internalDate ?? NaN);
    if (!Number.isFinite(internal)) continue;
    if (internal < sinceMs || internal > untilMs) continue;

    const subject = headerValue(message, "Subject");
    const bodyText = extractPlainTextBody(message.payload ?? undefined);

    // Body first, subject second — the code lives in the body on every real
    // ATS mail we know about, and the subject may carry a similar looking
    // token (ticket number, requisition id) that is not the code.
    const code =
      matchWithPattern(bodyText, codePattern) ?? matchWithPattern(subject, codePattern);
    if (code === null) continue;

    console.log(
      `${LOG} matched code from ${senderCheck.address} in message ${stub.id} ` +
        `(received ${new Date(internal).toISOString()})`
    );
    return {
      status: "found",
      match: {
        code,
        emailId: stub.id,
        senderAddress: senderCheck.address,
        subject,
        receivedAt: new Date(internal).toISOString(),
      },
    };
  }

  return {
    status: "no_match",
    readMessageCount: readCount,
    searchedUntil: new Date(untilMs).toISOString(),
  };
}

/** First non empty capture, or the whole match. */
function matchWithPattern(source: string, pattern: RegExp): string | null {
  if (!source) return null;
  const clone = new RegExp(pattern.source, pattern.flags.replace("g", ""));
  const match = clone.exec(source);
  if (!match) return null;
  for (let i = 1; i < match.length; i += 1) {
    const captured = match[i];
    if (typeof captured === "string" && captured.length > 0) return captured;
  }
  return match[0] ?? null;
}

function headerValue(message: gmail_v1.Schema$Message, name: string): string {
  const headers = message.payload?.headers ?? [];
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if ((header.name ?? "").toLowerCase() === wanted) return header.value ?? "";
  }
  return "";
}

/**
 * Depth first walk of the MIME tree, returning the concatenation of every
 * `text/plain` leaf. HTML is intentionally not decoded here: a code that only
 * appears inside HTML is inside an ATS's marketing template and the tighter
 * `text/plain` scope is enough for the ATSes V1 targets. If a future ATS
 * needs the HTML path, that is its own ticket.
 */
function extractPlainTextBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  const out: string[] = [];
  const visit = (node: gmail_v1.Schema$MessagePart): void => {
    const mime = (node.mimeType ?? "").toLowerCase();
    if (mime.startsWith("text/plain") && node.body?.data) {
      out.push(decodeBase64Url(node.body.data));
    }
    for (const child of node.parts ?? []) visit(child);
  };
  visit(part);
  return out.join("\n");
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function classifyGmailError(err: unknown): VerificationCodeResult {
  const reason = err instanceof Error ? err.message : "unknown error";
  // `invalid_grant` is Gmail's canonical response to a revoked or expired
  // refresh token. Called out as `auth_failed` so the caller can decide to
  // stop the run rather than retry.
  if (/invalid_grant|unauthorized_client|invalid_client|Invalid Credentials/i.test(reason)) {
    return { status: "auth_failed", reason };
  }
  return { status: "read_failed", reason };
}

// ───────────────────────────────────
// Timeout race
// ───────────────────────────────────

async function raceAgainstDeadline(
  operation: Promise<VerificationCodeResult>,
  budgetMs: number,
  until: Date
): Promise<VerificationCodeResult> {
  if (budgetMs <= 0) {
    return {
      status: "read_failed",
      reason: `Gmail read exceeded the ${Math.max(0, budgetMs)}ms timeoutMs before starting`,
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<VerificationCodeResult>((resolveTimeout) => {
    timer = setTimeout(() => {
      resolveTimeout({
        status: "read_failed",
        reason: `Gmail read exceeded the ${budgetMs}ms timeoutMs (searchedUntil ${until.toISOString()})`,
      });
    }, budgetMs);
  });
  try {
    const result = await Promise.race([operation, timeout]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
