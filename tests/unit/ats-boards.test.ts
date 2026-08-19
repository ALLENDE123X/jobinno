// @vitest-environment node
/**
 * JOB-003. Every URL below was harvested from a live read of one of the two
 * listing repositories on the day this was written, not invented to fit the
 * parser. That matters: the board token is the string the sync then hands to
 * an employer's API, and a token that is one path segment off produces a 404
 * for every listing that board will ever publish, silently, forever.
 *
 * No network and no database. Harvesting is string work, and the GitHub fetch
 * that feeds it is not exercised here.
 */
import { describe, expect, it } from "vitest";

import {
  classifyApplicationUrl,
  harvestBoards,
  placeholderCompanyName,
} from "@/lib/ats-boards";

describe("classifyApplicationUrl, tenant in the first path segment", () => {
  it("reads a Greenhouse board off the modern host", () => {
    expect(
      classifyApplicationUrl(
        "https://job-boards.greenhouse.io/dvtrading/jobs/4719118005?utm_source=github-vansh-ouckah"
      )
    ).toEqual({ ats: "greenhouse", boardToken: "dvtrading" });
  });

  it("reads a Greenhouse board off the older boards host", () => {
    expect(
      classifyApplicationUrl("https://boards.greenhouse.io/spacex/jobs/8621757002")
    ).toEqual({ ats: "greenhouse", boardToken: "spacex" });
  });

  it("reads an EU hosted Greenhouse board, whose tenant namespace is the same one", () => {
    expect(
      classifyApplicationUrl("https://job-boards.eu.greenhouse.io/imc/jobs/4912874101")
    ).toEqual({ ats: "greenhouse", boardToken: "imc" });
  });

  it("takes a Greenhouse embed's tenant from the query string, not the path", () => {
    expect(
      classifyApplicationUrl(
        "https://job-boards.greenhouse.io/embed/job_app?for=point72&token=7297613002"
      )
    ).toEqual({ ats: "greenhouse", boardToken: "point72" });
  });

  it("reads a Lever board", () => {
    expect(
      classifyApplicationUrl(
        "https://jobs.lever.co/belvederetrading/cbde47db-c60b-4339-a8f4-a8e4f30505ab"
      )
    ).toEqual({ ats: "lever", boardToken: "belvederetrading" });
  });

  it("reads an Ashby board and folds its case", () => {
    // Both spellings appear in the repos, and api.ashbyhq.com answers the same
    // for either, so they have to fold to one row rather than to two.
    expect(
      classifyApplicationUrl("https://jobs.ashbyhq.com/Etched/aa17bfa2-2922-4aa7-820d-76064f2551a8")
    ).toEqual({ ats: "ashby", boardToken: "etched" });
    expect(
      classifyApplicationUrl("https://jobs.ashbyhq.com/etched/aa17bfa2-2922-4aa7-820d-76064f2551a8")
    ).toEqual({ ats: "ashby", boardToken: "etched" });
  });

  it("keeps a dot in an Ashby token", () => {
    expect(
      classifyApplicationUrl("https://jobs.ashbyhq.com/ether.fi/6dcb712c-8fe5-4725-ad6a-0e9771af22cb")
    ).toEqual({ ats: "ashby", boardToken: "ether.fi" });
  });

  it("reads a Workable account", () => {
    expect(
      classifyApplicationUrl(
        "https://apply.workable.com/tmeic-corporation-americas/j/6FDBF2FD32/apply"
      )
    ).toEqual({ ats: "workable", boardToken: "tmeic-corporation-americas" });
  });

  it("refuses a Workable short link, which names a posting and not an account", () => {
    expect(classifyApplicationUrl("https://apply.workable.com/j/49FCF9E74B/apply")).toBeNull();
  });

  it("reads a SmartRecruiters company", () => {
    expect(
      classifyApplicationUrl("https://jobs.smartrecruiters.com/AveryDennison/744000144153141")
    ).toEqual({ ats: "smartrecruiters", boardToken: "averydennison" });
  });
});

describe("classifyApplicationUrl, tenant in the leftmost hostname label", () => {
  it("reads a BambooHR tenant", () => {
    expect(
      classifyApplicationUrl("https://specteraerospace.bamboohr.com/careers/122/")
    ).toEqual({ ats: "bamboohr", boardToken: "specteraerospace" });
  });

  it("reads a JazzHR tenant", () => {
    expect(
      classifyApplicationUrl("https://nro.applytojob.com/apply/oZyJp3ZEQh/summer-internship")
    ).toEqual({ ats: "jazzhr", boardToken: "nro" });
  });

  it("reads a Breezy tenant", () => {
    expect(classifyApplicationUrl("https://breezy.breezy.hr/p/98323abf2296-employee-12")).toEqual({
      ats: "breezy",
      boardToken: "breezy",
    });
  });

  it("reads a Recruitee tenant", () => {
    expect(classifyApplicationUrl("https://channable.recruitee.com/o/some-role")).toEqual({
      ats: "recruitee",
      boardToken: "channable",
    });
  });

  it("reads a Teamtailor tenant", () => {
    expect(classifyApplicationUrl("https://tibber.teamtailor.com/jobs/8180242-b2b-support")).toEqual(
      { ats: "teamtailor", boardToken: "tibber" }
    );
  });

  it("refuses the vendor's own marketing and support subdomains", () => {
    expect(classifyApplicationUrl("https://support.recruitee.com/en/articles/1066242")).toBeNull();
    expect(classifyApplicationUrl("https://www.teamtailor.com/en/careers/")).toBeNull();
  });
});

describe("classifyApplicationUrl, what it declines", () => {
  it("declines an employer's own careers site, even a Greenhouse backed one", () => {
    // A real Greenhouse posting, but the URL names no board, so no token can be
    // derived from it. Skipping is correct; guessing would mint a dead row.
    expect(
      classifyApplicationUrl("https://www.janestreet.com/join-jane-street/apply/8537797002?gh_jid=8537797002")
    ).toBeNull();
  });

  it("declines the platforms V1 does not target", () => {
    expect(
      classifyApplicationUrl(
        "https://uline.wd1.myworkdayjobs.com/en-US/Uline_Careers/job/Pleasant-Prairie-WI/Software"
      )
    ).toBeNull();
    expect(classifyApplicationUrl("https://careers-sig.icims.com/jobs/11005/job")).toBeNull();
    expect(classifyApplicationUrl("https://simplify.jobs/p/d935bae6-e667-4bd1-b10d")).toBeNull();
  });

  it("declines a board host with nothing after it", () => {
    expect(classifyApplicationUrl("https://job-boards.greenhouse.io/")).toBeNull();
    expect(classifyApplicationUrl("https://jobs.lever.co")).toBeNull();
  });

  it("declines a Greenhouse embed with no tenant in the query string", () => {
    expect(classifyApplicationUrl("https://job-boards.greenhouse.io/embed/job_app?token=1")).toBeNull();
  });

  it("declines input that is not a URL at all", () => {
    expect(classifyApplicationUrl("dvtrading")).toBeNull();
    expect(classifyApplicationUrl("")).toBeNull();
    expect(classifyApplicationUrl("mailto:jobs@example.com")).toBeNull();
  });
});

describe("harvestBoards", () => {
  // The first is a row from vanshb03's markdown table, the second a row from
  // SimplifyJobs's HTML one. One expression has to read both, which is the
  // whole reason the harvester works on URLs rather than on table cells.
  const MARKDOWN_ROW =
    '| Belvedere Trading | Quantitative Trading Intern | Chicago, IL | ' +
    '<a href="https://jobs.lever.co/belvederetrading/cbde47db?utm_source=github-vansh-ouckah">' +
    '<img src="https://i.imgur.com/u1KNU8z.png" width="118" alt="Apply"></a> | Aug 16 |';
  const HTML_ROW =
    '<td><div align="center"><a href="https://job-boards.greenhouse.io/dvtrading/jobs/4719119005' +
    '?utm_source=Simplify&ref=Simplify"><img src="https://i.imgur.com/fbjwDvo.png" width="50" ' +
    'alt="Apply"></a> <a href="https://simplify.jobs/p/f845f125?utm_source=GHList"></a></div></td>';

  it("reads both repositories' row formats with one expression", () => {
    expect(harvestBoards(`${MARKDOWN_ROW}\n${HTML_ROW}`)).toEqual([
      {
        ats: "lever",
        boardToken: "belvederetrading",
        sourceUrl: "https://jobs.lever.co/belvederetrading/cbde47db?utm_source=github-vansh-ouckah",
      },
      {
        ats: "greenhouse",
        boardToken: "dvtrading",
        sourceUrl:
          "https://job-boards.greenhouse.io/dvtrading/jobs/4719119005?utm_source=Simplify&ref=Simplify",
      },
    ]);
  });

  it("collapses one employer's many roles into one board", () => {
    const document = [
      "https://job-boards.greenhouse.io/virtu/jobs/8657500002",
      "https://job-boards.greenhouse.io/virtu/jobs/8657500003",
      "https://boards.greenhouse.io/virtu/jobs/8657500004",
    ].join("\n");

    expect(harvestBoards(document)).toEqual([
      {
        ats: "greenhouse",
        boardToken: "virtu",
        sourceUrl: "https://job-boards.greenhouse.io/virtu/jobs/8657500002",
      },
    ]);
  });

  it("keeps the same token under two platforms apart", () => {
    const document = [
      "https://job-boards.greenhouse.io/acme/jobs/1",
      "https://jobs.lever.co/acme/22222222-3333-4444-5555-666666666666",
    ].join("\n");

    expect(harvestBoards(document).map((entry) => `${entry.ats}:${entry.boardToken}`)).toEqual([
      "greenhouse:acme",
      "lever:acme",
    ]);
  });

  it("drops the sentence's punctuation from the end of a bare link", () => {
    expect(harvestBoards("Apply at https://jobs.lever.co/palantir/abc.")).toEqual([
      { ats: "lever", boardToken: "palantir", sourceUrl: "https://jobs.lever.co/palantir/abc" },
    ]);
  });

  it("finds nothing in a README with no supported boards in it", () => {
    expect(harvestBoards("# Internships\n\nSee https://www.linkedin.com/jobs for more.")).toEqual([]);
  });
});

describe("placeholderCompanyName", () => {
  it("makes a token readable until the first sync replaces it", () => {
    expect(placeholderCompanyName("al-warren-oil-company-inc")).toBe("Al Warren Oil Company Inc");
    expect(placeholderCompanyName("dvtrading")).toBe("Dvtrading");
    expect(placeholderCompanyName("ether.fi")).toBe("Ether Fi");
  });
});
