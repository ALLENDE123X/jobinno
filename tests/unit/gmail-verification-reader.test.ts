/**
 * JOB-211 — `lib/gmail-verification-reader.ts`.
 *
 * Three tests, matching the ticket's Test plan:
 *
 *  1. The empty allowlist guardrail returns `no_match` before any Gmail call.
 *  2. The Gmail query composed against a fixed allowlist and window is the
 *     exact string this reader asks Gmail for.
 *  3. `timeoutMs` bounds the call.
 *
 * The reader accepts an internals seam (`FindVerificationCodeInternals`) so
 * every test drives it with a fake Gmail layer and never pulls in
 * `googleapis`. A refresh token loader is injected too, so nothing here
 * touches Supabase or the token crypto module either.
 */
import { describe, expect, it } from "vitest";
import type { gmail_v1 } from "googleapis";

import {
  buildGmailQuery,
  findVerificationCode,
  isSenderOnAllowlist,
  type VerificationCodeSearch,
} from "@/lib/gmail-verification-reader";

// A refresh token loader that just hands back a placeholder string. The
// reader hands this to `createGoogleapisReader` only when the tests do not
// pass a fake reader in; the empty allowlist test never gets that far.
function fakeLoader(): () => Promise<string | null> {
  return async () => "not-a-real-token";
}

function fakeMessage(
  headers: Record<string, string>,
  bodyText: string,
  internalDateMs: number
): gmail_v1.Schema$Message {
  return {
    id: "msg-1",
    internalDate: String(internalDateMs),
    payload: {
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      mimeType: "text/plain",
      body: { data: Buffer.from(bodyText, "utf8").toString("base64url") },
    },
  } satisfies gmail_v1.Schema$Message;
}

describe("findVerificationCode — the empty allowlist guardrail", () => {
  it("returns no_match without any Gmail call when the allowlist is empty", async () => {
    let listCalled = false;
    let getCalled = false;

    const result = await findVerificationCode(
      {
        userId: "user-1",
        senderAllowlist: [],
        since: new Date("2026-08-27T10:00:00Z"),
        until: new Date("2026-08-27T10:15:00Z"),
        codePattern: /\d{6}/,
        timeoutMs: 60_000,
      } satisfies VerificationCodeSearch,
      {
        loadRefreshToken: fakeLoader(),
        reader: {
          async list() {
            listCalled = true;
            return {};
          },
          async get() {
            getCalled = true;
            return {};
          },
        },
      }
    );

    expect(result.status).toBe("no_match");
    if (result.status === "no_match") {
      expect(result.readMessageCount).toBe(0);
      expect(result.searchedUntil).toBe("2026-08-27T10:15:00.000Z");
    }
    expect(listCalled).toBe(false);
    expect(getCalled).toBe(false);
  });

  it("returns no_match when the allowlist has only syntactically invalid entries", async () => {
    let listCalled = false;
    const result = await findVerificationCode(
      {
        userId: "user-1",
        // "not-a-domain" fails DOMAIN_LABEL, "@" alone fails, "@evil space.com"
        // has a space and fails too. None reach the query.
        senderAllowlist: ["not-a-domain", "@", "@evil space.com"],
        since: new Date("2026-08-27T10:00:00Z"),
        until: new Date("2026-08-27T10:15:00Z"),
        codePattern: /\d{6}/,
        timeoutMs: 60_000,
      },
      {
        loadRefreshToken: fakeLoader(),
        reader: {
          async list() {
            listCalled = true;
            return {};
          },
          async get() {
            return {};
          },
        },
      }
    );

    expect(result.status).toBe("no_match");
    expect(listCalled).toBe(false);
  });
});

describe("findVerificationCode — Gmail query composition", () => {
  it("composes from:(a OR b) after:X before:Y -in:trash -in:spam and re-checks the sender exactly", async () => {
    const since = new Date("2026-08-27T10:00:00Z");
    const until = new Date("2026-08-27T10:15:00Z");

    let observedQuery: string | null = null;
    let observedMaxResults: number | null = null;

    const bodyText =
      "Copy and paste this code into the security code field on your application: 123456";
    const internalDateMs = new Date("2026-08-27T10:07:30Z").getTime();

    const result = await findVerificationCode(
      {
        userId: "user-1",
        senderAllowlist: ["no-reply@greenhouse.io", "@greenhouse.io"],
        since,
        until,
        codePattern: /\bcode\b[^0-9]{0,80}?(\d{4,8})\b/i,
        timeoutMs: 60_000,
      },
      {
        loadRefreshToken: fakeLoader(),
        reader: {
          async list(query: string, maxResults: number) {
            observedQuery = query;
            observedMaxResults = maxResults;
            return { messages: [{ id: "msg-1" }] };
          },
          async get() {
            return fakeMessage(
              {
                From: "Greenhouse <no-reply@greenhouse.io>",
                Subject: "Security code for your application to Discord",
              },
              bodyText,
              internalDateMs
            );
          },
        },
      }
    );

    expect(observedQuery).not.toBeNull();
    // Two allowlist entries: each gets its own `from:` term so Gmail treats
    // them as independent sender clauses joined by OR. The `@` prefix on the
    // domain suffix is stripped for the Gmail query (Gmail interprets a bare
    // domain as a suffix match), but preserved on the allowlist for the
    // exact-address re-check.
    expect(observedQuery).toContain("(from:no-reply@greenhouse.io OR from:greenhouse.io)");
    expect(observedQuery).toContain(`after:${Math.floor(since.getTime() / 1000)}`);
    expect(observedQuery).toContain(`before:${Math.ceil(until.getTime() / 1000)}`);
    expect(observedQuery).toContain("-in:trash");
    expect(observedQuery).toContain("-in:spam");
    expect(observedMaxResults).toBe(20);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.match.code).toBe("123456");
      expect(result.match.senderAddress).toBe("no-reply@greenhouse.io");
      expect(result.match.subject).toBe("Security code for your application to Discord");
      expect(result.match.emailId).toBe("msg-1");
      expect(result.match.receivedAt).toBe(new Date(internalDateMs).toISOString());
    }
  });

  it("buildGmailQuery uses a single from: term (no parens) for a one entry allowlist", () => {
    const query = buildGmailQuery(
      ["no-reply@greenhouse.io"],
      Date.parse("2026-08-27T10:00:00Z"),
      Date.parse("2026-08-27T10:15:00Z")
    );
    expect(query).not.toBeNull();
    expect(query).toContain("from:no-reply@greenhouse.io");
    expect(query).not.toContain("from:(");
  });

  it("isSenderOnAllowlist accepts a subdomain match on an @domain entry and rejects a domain suffix trick", () => {
    const allowlist = ["@greenhouse.io"];
    expect(
      isSenderOnAllowlist("Greenhouse Mail <no-reply@mail.greenhouse.io>", allowlist).allowed
    ).toBe(true);
    // A hostile domain that ENDS with greenhouse.io must never match:
    // greenhouse.io.attacker.example is not a subdomain of greenhouse.io.
    expect(
      isSenderOnAllowlist("Attacker <spoof@greenhouse.io.attacker.example>", allowlist).allowed
    ).toBe(false);
  });

  it("rejects a message from a sender not on the allowlist even if Gmail returned it", async () => {
    const result = await findVerificationCode(
      {
        userId: "user-1",
        senderAllowlist: ["@greenhouse.io"],
        since: new Date("2026-08-27T10:00:00Z"),
        until: new Date("2026-08-27T10:15:00Z"),
        codePattern: /\bcode\b[^0-9]{0,80}?(\d{4,8})\b/i,
        timeoutMs: 60_000,
      },
      {
        loadRefreshToken: fakeLoader(),
        reader: {
          async list() {
            return { messages: [{ id: "spoof-1" }] };
          },
          async get() {
            return fakeMessage(
              { From: "Spoofer <no-reply@lever.co>", Subject: "Your code" },
              "Your code: 999999",
              new Date("2026-08-27T10:05:00Z").getTime()
            );
          },
        },
      }
    );
    expect(result.status).toBe("no_match");
    if (result.status === "no_match") {
      // We did `get` the message, so readMessageCount is 1, but the sender
      // re-check rejected it before any code was returned.
      expect(result.readMessageCount).toBe(1);
    }
  });
});

describe("findVerificationCode — timeoutMs bounds the call", () => {
  it("returns read_failed when the Gmail reader hangs past the timeout", async () => {
    // A reader whose `list` never resolves. The Promise.race in the reader
    // must abandon it and return a typed `read_failed`.
    const hangingReader = {
      async list(): Promise<gmail_v1.Schema$ListMessagesResponse> {
        return await new Promise<gmail_v1.Schema$ListMessagesResponse>(() => {
          /* never resolves */
        });
      },
      async get(): Promise<gmail_v1.Schema$Message> {
        return await new Promise<gmail_v1.Schema$Message>(() => {
          /* never resolves */
        });
      },
    };

    const started = Date.now();
    const result = await findVerificationCode(
      {
        userId: "user-1",
        senderAllowlist: ["@greenhouse.io"],
        since: new Date("2026-08-27T10:00:00Z"),
        until: new Date("2026-08-27T10:15:00Z"),
        codePattern: /\d{4,8}/,
        timeoutMs: 50,
      },
      { loadRefreshToken: fakeLoader(), reader: hangingReader }
    );
    const elapsed = Date.now() - started;

    expect(result.status).toBe("read_failed");
    if (result.status === "read_failed") {
      expect(result.reason).toContain("50ms");
    }
    // Generous upper bound; a slow CI box must not flake this test.
    expect(elapsed).toBeLessThan(2000);
  });

  it("returns read_failed immediately when timeoutMs is zero", async () => {
    const result = await findVerificationCode(
      {
        userId: "user-1",
        senderAllowlist: ["@greenhouse.io"],
        since: new Date("2026-08-27T10:00:00Z"),
        until: new Date("2026-08-27T10:15:00Z"),
        codePattern: /\d{4,8}/,
        timeoutMs: 0,
      },
      {
        loadRefreshToken: fakeLoader(),
        reader: {
          async list() {
            throw new Error("should not be reached — the timeout is zero");
          },
          async get() {
            throw new Error("should not be reached — the timeout is zero");
          },
        },
      }
    );
    expect(result.status).toBe("read_failed");
  });
});
