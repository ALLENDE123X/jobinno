/**
 * Keeps the two halves of the magic link redirect allowlist honest.
 *
 * The bug this exists to prevent is not a crash. When `emailRedirectTo` is not
 * on the Supabase project's allowlist, Supabase substitutes the project Site
 * URL and returns success, so the only symptom is a link in a real person's
 * inbox that goes somewhere useless. Nothing in a normal test run would notice.
 *
 * So the check is structural: whatever the app is willing to ask for
 * (`AUTH_REDIRECT_ALLOWLIST`) has to be exactly what the project is configured
 * to permit (`additional_redirect_urls` in `supabase/config.toml`, which is what
 * `npm run supabase:auth-config` pushes). Adding an origin to one and not the
 * other fails here.
 *
 * What this cannot check from CI is the live project, which has no credentials
 * in a pull request build. That read back is a command an operator runs:
 * `npm run supabase:auth-config` reports "Remote Auth config is up to date"
 * when the project already matches this file, and prints a diff when it does
 * not.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUTH_CALLBACK_PATH,
  safeRelativeDestination,
  AUTH_REDIRECT_ALLOWLIST,
  LOCAL_DEV_ORIGIN,
  PRODUCTION_ORIGIN,
  authCallbackUrlFor,
} from "@/lib/auth/redirect-urls";

const configToml = readFileSync(
  path.join(process.cwd(), "supabase", "config.toml"),
  "utf8"
);

/**
 * A targeted read of the two keys this test is about, rather than a TOML
 * dependency for one file the repository writes and owns.
 */
function tomlStringList(key: string): string[] {
  const match = configToml.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"));
  if (!match) throw new Error(`supabase/config.toml has no ${key} list`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function tomlString(key: string): string {
  const match = configToml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
  if (!match) throw new Error(`supabase/config.toml has no ${key}`);
  return match[1];
}

describe("Supabase Auth redirect allowlist", () => {
  it("covers both the local dev origin and production", () => {
    expect(AUTH_REDIRECT_ALLOWLIST).toContain(
      `${LOCAL_DEV_ORIGIN}${AUTH_CALLBACK_PATH}`
    );
    expect(AUTH_REDIRECT_ALLOWLIST).toContain(
      `${PRODUCTION_ORIGIN}${AUTH_CALLBACK_PATH}`
    );
  });

  it("matches additional_redirect_urls in supabase/config.toml exactly", () => {
    expect(tomlStringList("additional_redirect_urls").sort()).toEqual(
      [...AUTH_REDIRECT_ALLOWLIST].sort()
    );
  });

  it("keeps the project Site URL pointed at production", () => {
    // The Site URL is where Supabase sends anyone whose redirect was not
    // allowlisted, so it is the destination of every mistake this file is about.
    // It should at least be a real Jobinno page.
    expect(tomlString("site_url")).toBe(PRODUCTION_ORIGIN);
  });

  it("names the Jobinno project and no other", () => {
    expect(tomlString("project_id")).toBe("efyubrtiptcsrhfakbwc");
  });

  describe("authCallbackUrlFor", () => {
    it("returns the callback URL for an allowlisted origin", () => {
      expect(authCallbackUrlFor(LOCAL_DEV_ORIGIN)).toBe(
        `${LOCAL_DEV_ORIGIN}${AUTH_CALLBACK_PATH}`
      );
      expect(authCallbackUrlFor(`${PRODUCTION_ORIGIN}/`)).toBe(
        `${PRODUCTION_ORIGIN}${AUTH_CALLBACK_PATH}`
      );
    });

    it.each([
      "http://localhost:3001",
      "https://jobinno-git-preview.vercel.app",
      "https://evil.example",
    ])("throws rather than let Supabase silently redirect from %s", (origin) => {
      expect(() => authCallbackUrlFor(origin)).toThrow(/redirect allowlist/);
    });
  });

  /**
   * The open redirect guard added by JOB-010, which both `?next=` and the post
   * login cookie are filtered through.
   *
   * Worth its own tests because the cookie widened the attack surface. A query
   * parameter has to be put in a link somebody clicks; a cookie can be written
   * by anything else sharing the origin, and it is then read on the one route
   * that runs immediately after a session is minted. A miss here is an open
   * redirect wearing our domain and a freshly signed in person behind it.
   */
  describe("safeRelativeDestination", () => {
    it.each([
      "/onboarding",
      "/api/billing/checkout?plan=starter",
      "/billing/success",
    ])("allows our own path %s", (value) => {
      expect(safeRelativeDestination(value)).toBe(value);
    });

    it.each([
      // Browsers read a protocol relative host as an absolute URL.
      "//evil.example",
      "///evil.example",
      "https://evil.example",
      "http://evil.example/onboarding",
      // Some browsers normalise a backslash to a forward slash, so this leaves
      // looking relative and arrives somewhere else entirely.
      "/\\evil.example",
      "\\\\evil.example",
      // Not a path at all.
      "javascript:alert(1)",
      "onboarding",
    ])("refuses %s", (value) => {
      expect(safeRelativeDestination(value)).toBeNull();
    });

    it("refuses nothing at all", () => {
      expect(safeRelativeDestination(null)).toBeNull();
      expect(safeRelativeDestination(undefined)).toBeNull();
      expect(safeRelativeDestination("")).toBeNull();
    });
  });
});
