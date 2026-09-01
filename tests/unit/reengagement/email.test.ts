// @vitest-environment node
/**
 * JOB-322 — `redactEmail` is a logging helper the cron calls to keep real
 * recipient addresses out of logs. Every other logging site around it treats
 * a throw here as a normal error, which would take a whole re engagement run
 * down over one row whose email column drifted to `null` in some future
 * schema state. The signature stays typed as `string` so TypeScript still
 * catches obviously wrong callers, and these cases exercise the runtime
 * backstop that keeps the helper from ever throwing when the type is lied to
 * at a boundary (a query row, an untyped JSON payload, a mocked input in a
 * test).
 *
 * The malformed string cases (`""`, `"noatsign"`, `"@nolocal"`,
 * `"multiple@@ats"`) are covered too so a future edit that reworks the
 * `split("@")` path cannot silently regress them: they went through the
 * original PR #329 review round hand tested, and this is where that check
 * now lives.
 */
import { describe, expect, it } from "vitest";

import { redactEmail } from "@/lib/reengagement/email";

describe("redactEmail", () => {
  it("keeps two characters of the local part and the full domain", () => {
    expect(redactEmail("someone@example.com")).toBe("so***@example.com");
  });

  it("returns [invalid] for malformed strings rather than throwing", () => {
    expect(redactEmail("")).toBe("[invalid]");
    expect(redactEmail("noatsign")).toBe("[invalid]");
    expect(redactEmail("@nolocal")).toBe("[invalid]");
    // `split("@")` on this yields ["multiple", "", "ats"]; the empty middle
    // segment fails the `!domain` guard and lands on the same fallback.
    expect(redactEmail("multiple@@ats")).toBe("[invalid]");
  });

  it("returns [invalid] for non string input rather than throwing", () => {
    // Cast through `unknown` at the call site: the whole point of these
    // cases is a caller who lied to the type at some other boundary (a query
    // row where the email column was null, an untyped JSON payload). The
    // helper must survive that without taking a cron run down over it.
    expect(redactEmail(null as unknown as string)).toBe("[invalid]");
    expect(redactEmail(undefined as unknown as string)).toBe("[invalid]");
    expect(redactEmail(123 as unknown as string)).toBe("[invalid]");
    expect(redactEmail({} as unknown as string)).toBe("[invalid]");
  });
});
