// @vitest-environment node
/**
 * The rule that decides where a browser holding a real person's resume is
 * allowed to go.
 *
 * Two halves, and both matter. The rejections are the point of the module: a
 * listing URL comes out of an ATS platform's JSON response, whoever owns the
 * tenant chooses it, and owning a tenant on one of these platforms is something
 * anybody can arrange. The acceptances are what keeps the fix from being a
 * denial of service against our own ingest, so every platform
 * `lib/ats-job-feeds.ts` reads is exercised with the URL shape that reader
 * actually produces.
 *
 * No network, no database, no browser. It is URL parsing and two table lookups.
 */
import { describe, expect, it } from "vitest";

import { checkApplyUrl, unroutableHostReason } from "@/lib/apply-url-guard";

/** Every platform, the board token, and one URL of the shape its reader emits. */
const REAL_LISTINGS: ReadonlyArray<[ats: string, boardToken: string, url: string]> = [
  // Built by `readGreenhouse` from a hardcoded host: the tenant is in `?for=`.
  [
    "greenhouse",
    "dvtrading",
    "https://job-boards.greenhouse.io/embed/job_app?for=dvtrading&token=4567890",
  ],
  // Lever's own `applyUrl`, taken verbatim from the postings API.
  ["lever", "belvederetrading", "https://jobs.lever.co/belvederetrading/9f1c2d3e-4a5b/apply"],
  // Ashby's `applyUrl`, likewise.
  ["ashby", "etched", "https://jobs.ashbyhq.com/etched/6c1f0b7a-2e11-4d/application"],
  // Workable's `application_url`.
  [
    "workable",
    "tmeic-corporation-americas",
    "https://apply.workable.com/tmeic-corporation-americas/j/A15A62A8BE/apply/",
  ],
  // Recruitee's `careers_apply_url`, where the tenant is the hostname.
  ["recruitee", "channable", "https://channable.recruitee.com/o/software-engineer-intern/c/new"],
  // Breezy's `url`.
  ["breezy", "breezy", "https://breezy.breezy.hr/p/8f21ac0b1e42-software-engineer-intern"],
  // Built by `readSmartRecruiters`. The API spells the identifier mixed case and
  // the registry stores it folded, which has to keep matching.
  ["smartrecruiters", "averydennison", "https://jobs.smartrecruiters.com/AveryDennison/744000012"],
  // Built by `readBambooHr`.
  ["bamboohr", "specteraerospace", "https://specteraerospace.bamboohr.com/careers/122"],
  // Teamtailor's `url` out of its JSON Feed.
  ["teamtailor", "tibber", "https://tibber.teamtailor.com/jobs/1234567-software-engineer-intern"],
];

describe("the listing shapes real ingestion produces", () => {
  it.each(REAL_LISTINGS)("accepts a %s listing on its own board", (ats, boardToken, url) => {
    expect(checkApplyUrl(url, { ats, boardToken })).toEqual({
      ok: true,
      host: new URL(url).hostname,
    });
  });

  it("folds case on the board token, since the registry stores it folded", () => {
    const verdict = checkApplyUrl("https://jobs.lever.co/Palantir/abc/apply", {
      ats: "lever",
      boardToken: "palantir",
    });
    expect(verdict.ok).toBe(true);
  });

  it("accepts Workable's account free short link, which names no tenant at all", () => {
    // The one exception in the module, and the reason it exists: the host is
    // still Workable's, so the data still goes to Workable, and refusing it
    // would drop real postings.
    const verdict = checkApplyUrl("https://apply.workable.com/j/A15A62A8BE/apply", {
      ats: "workable",
      boardToken: "capula-investment-management-ltd",
    });
    expect(verdict.ok).toBe(true);
  });

  it("does not extend that exception to a per customer hostname", () => {
    // `support.recruitee.com` is the vendor's help site, not a board, and the
    // hostname is where a Recruitee tenant is named. Nothing to be forgiving
    // about here.
    const verdict = checkApplyUrl("https://support.recruitee.com/articles/apply", {
      ats: "recruitee",
      boardToken: "channable",
    });
    expect(verdict).toMatchObject({ ok: false });
  });
});

describe("a URL the tenant chose that points away from its own board", () => {
  /** The attack in one line: a Lever tenant whose `applyUrl` is somewhere else. */
  const asLever = (url: string) => checkApplyUrl(url, { ats: "lever", boardToken: "acmecorp" });

  it("refuses a host that belongs to nobody we ingest from", () => {
    const verdict = asLever("https://careers.acmecorp-hiring.example/apply/swe-intern");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("no supported ATS platform");
  });

  it("refuses a hostname that only starts with a real board host", () => {
    expect(asLever("https://jobs.lever.co.attacker.example/acmecorp/1/apply").ok).toBe(false);
  });

  it("refuses credentials in front of the hostname", () => {
    // Parses to a hostname of `attacker.example`, whatever it looks like.
    const verdict = asLever("https://jobs.lever.co@attacker.example/acmecorp/1");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("credentials");
  });

  it("refuses a real board host belonging to a different platform", () => {
    const verdict = asLever("https://jobs.ashbyhq.com/acmecorp/1/application");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("belongs to ashby");
  });

  it("refuses another tenant's board on the right platform", () => {
    const verdict = asLever("https://jobs.lever.co/someoneelse/1/apply");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('"someoneelse"');
  });

  it("refuses a Greenhouse embed that names a different tenant in ?for=", () => {
    const verdict = checkApplyUrl(
      "https://job-boards.greenhouse.io/embed/job_app?for=attacker&token=1",
      { ats: "greenhouse", boardToken: "dvtrading" }
    );
    expect(verdict.ok).toBe(false);
  });

  it("refuses another tenant's Recruitee hostname", () => {
    const verdict = checkApplyUrl("https://someoneelse.recruitee.com/o/role/c/new", {
      ats: "recruitee",
      boardToken: "channable",
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses http on a host that would be fine over https", () => {
    const verdict = asLever("http://jobs.lever.co/acmecorp/1/apply");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("only https");
  });

  it("refuses a scheme that is not http at all", () => {
    expect(asLever("file:///etc/passwd").ok).toBe(false);
    expect(asLever("javascript:alert(1)").ok).toBe(false);
    expect(asLever("data:text/html,<form></form>").ok).toBe(false);
  });

  it("refuses an empty or unparseable url", () => {
    expect(asLever("").ok).toBe(false);
    expect(asLever("   ").ok).toBe(false);
    expect(asLever("not a url at all").ok).toBe(false);
  });
});

describe("hosts that are addresses rather than boards", () => {
  /** Whatever the scheme, and whatever platform claims to have published it. */
  const anyPlatform = (url: string) =>
    checkApplyUrl(url, { ats: "lever", boardToken: "acmecorp" });

  const UNROUTABLE = [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "https://169.254.169.254/computeMetadata/v1/",
    "http://localhost:3000/apply",
    "https://localhost/apply",
    "http://127.0.0.1:8080/apply",
    "https://127.1.2.3/apply",
    "https://10.0.0.5/apply",
    "https://172.16.0.9/apply",
    "https://172.31.255.254/apply",
    "https://192.168.1.1/apply",
    "https://100.64.0.1/apply",
    "https://0.0.0.0/apply",
    "http://[::1]/apply",
    // The decimal spelling of 127.0.0.1, which the URL parser normalises for us.
    "http://2130706433/apply",
  ];

  it.each(UNROUTABLE)("refuses %s", (url) => {
    expect(anyPlatform(url).ok).toBe(false);
  });

  it("names the range rather than saying only that it is an IP", () => {
    expect(unroutableHostReason("169.254.169.254")).toContain("link local");
    expect(unroutableHostReason("10.1.2.3")).toContain("RFC1918");
    expect(unroutableHostReason("172.20.0.1")).toContain("RFC1918");
    expect(unroutableHostReason("192.168.0.10")).toContain("RFC1918");
    expect(unroutableHostReason("127.0.0.1")).toContain("loopback");
    expect(unroutableHostReason("localhost")).toContain("loopback");
  });

  it("gets the 172.16.0.0/12 boundaries right", () => {
    // Both ends are still refused, as every bare address is. What is being
    // checked here is that the range test says the right thing about them,
    // because a range test that is one octet wide in the wrong place is the
    // classic way this check is written wrong.
    expect(unroutableHostReason("172.15.0.1")).not.toContain("RFC1918");
    expect(unroutableHostReason("172.16.0.1")).toContain("RFC1918");
    expect(unroutableHostReason("172.31.0.1")).toContain("RFC1918");
    expect(unroutableHostReason("172.32.0.1")).not.toContain("RFC1918");
  });

  it("says nothing about a hostname that is an ordinary name", () => {
    expect(unroutableHostReason("jobs.lever.co")).toBeNull();
    expect(unroutableHostReason("JOBS.LEVER.CO.")).toBeNull();
  });
});
