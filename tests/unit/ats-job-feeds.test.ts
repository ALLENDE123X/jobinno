// @vitest-environment node
/**
 * JOB-003. Two things are checked here.
 *
 * **The relevance filter**, which decides which listings a real person ends up
 * applying to. Every title in the table is one that appeared on a board read
 * while this was written, including the two that motivated the word boundaries:
 * "Design Verification Engineer - Internal IP" is not an internship, and
 * "Sales Representative, Sweden" is not a software engineering role.
 *
 * **The nine response mappings**, each against a fragment of the real payload
 * that platform returned, trimmed to the fields the mapping reads. The point is
 * not that the code parses JSON. It is that Lever calls the title `text`,
 * SmartRecruiters and Breezy call it `name`, BambooHR calls it
 * `jobOpeningName`, and every one of those is a field named something else on
 * some other platform.
 *
 * `fetch` is stubbed, so nothing here touches the network. The one exception is
 * the live shape check at the bottom, which is skipped unless
 * `RUN_LIVE_ATS_TESTS=true` is set by hand: CI stays green when an employer's
 * board has a bad afternoon, and the check is still there to run deliberately
 * when a mapping is being changed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFERRED_ATS,
  classifyTitle,
  readBoardFeed,
  toPlainText,
} from "@/lib/ats-job-feeds";
import type { AtsPlatform } from "@/lib/db/schema";

function mockFetchOnce(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ───────────────────────────────────
// Relevance
// ───────────────────────────────────

describe("classifyTitle", () => {
  const keep: [string, { isIntern: boolean; isNewGrad: boolean }][] = [
    ["Software Engineer Intern, Summer 2027", { isIntern: true, isNewGrad: false }],
    ["2027 Summer Internship - Software Engineering", { isIntern: true, isNewGrad: false }],
    ["New Grad Software Engineer", { isIntern: false, isNewGrad: true }],
    ["Software Engineer, University Graduate", { isIntern: false, isNewGrad: true }],
    ["Early Career Software Engineer", { isIntern: false, isNewGrad: true }],
    ["SWE Intern (Platform)", { isIntern: true, isNewGrad: false }],
  ];

  it.each(keep)("keeps %s", (title, expected) => {
    expect(classifyTitle(title)).toEqual({ relevant: true, ...expected });
  });

  const drop = [
    // Nothing about it says intern, new grad or software engineering.
    "Technical Recruiter (Supercomputing/ML)",
    "B2B Support Specialist",
    "Physical Design Engineer",
    "Energy Market Specialist",
    // Seniority, with nothing to override it.
    "Senior Software Engineer",
    "Staff Software Engineer, Payments",
    "Principal Software Engineer",
    "Engineering Manager, Platform",
    "Director of Software Engineering",
    "AI Solutions Lead",
  ];

  it.each(drop)("drops %s", (title) => {
    expect(classifyTitle(title).relevant).toBe(false);
  });

  // ── The discipline gate ───────────────────────────────────────────────────
  // Every title below classified as `relevant: true` while the rule was
  // `isIntern || isNewGrad || SWE_RE.test(title)`, because the seniority word
  // alone carried it. `matchJobsForUser` is title blind whenever no title is
  // supplied — which is always, on the daily cron — so each of these was a
  // listing a real browser could be sent to apply to, spending an application
  // off a paying person's allowance on a discipline this product does not
  // serve. The first four are the reviewer's; the rest are verbatim from the
  // live `jobs` table, where 289 rows like them had already been ingested.
  const wrongDiscipline = [
    "Marketing Intern",
    "Legal Intern",
    "Investment Banking Summer Analyst Internship",
    "University Relations Coordinator",
    "Early Career Sales Associate",
    "Intern - Maintenance Technician",
    "Finance Intern - Summer 2027",
    "Intern, Commodity Sourcing",
    "2027 Point72 Academy Investment Analyst Summer Internship Program - Hong Kong",
    "Environmental Health & Safety Intern - Summer 2027",
    "2026 Early Career Mechanical Engineer",
  ];

  it.each(wrongDiscipline)("drops %s, which is an internship in the wrong field", (title) => {
    expect(classifyTitle(title).relevant).toBe(false);
  });

  it("still records the career stage on a title it refuses", () => {
    // The two booleans describe the title; `relevant` decides whether the row
    // is written. Keeping them honest on a rejected title is what makes the
    // assertions above about `relevant` specifically, rather than about the
    // seniority regexes having quietly stopped matching.
    expect(classifyTitle("Marketing Intern")).toEqual({
      relevant: false,
      isIntern: true,
      isNewGrad: false,
    });
    expect(classifyTitle("Early Career Sales Associate")).toEqual({
      relevant: false,
      isIntern: false,
      isNewGrad: true,
    });
  });

  it("drops a software role that is neither an internship nor for a new graduate", () => {
    // The other half of the "and". A plain mid level posting says nothing about
    // being open to a new graduate, and this product is for people who are one.
    expect(classifyTitle("Infrastructure Software Engineer")).toEqual({
      relevant: false,
      isIntern: false,
      isNewGrad: false,
    });
  });

  it("does not read Internal as intern", () => {
    // A real Ashby posting for a staff engineer. Without the word boundary this
    // is an internship, and a candidate applies to it.
    expect(classifyTitle("Design Verification Engineer - Internal IP")).toEqual({
      relevant: false,
      isIntern: false,
      isNewGrad: false,
    });
  });

  it("does not read Sweden as SWE", () => {
    expect(classifyTitle("Sales Representative, Sweden").relevant).toBe(false);
  });

  it("reads the abbreviation of senior as senior", () => {
    // Both real titles, both from the first sync run against the real registry,
    // and both kept as relevant until "sr" joined the exclusions.
    expect(classifyTitle("Sr. Software Engineer, Continuous Integration").relevant).toBe(false);
    expect(classifyTitle("Sr Software Engineer - Maritime Systems").relevant).toBe(false);
  });

  it("does not mistake SRE for that abbreviation", () => {
    expect(classifyTitle("SRE Software Engineer Intern").relevant).toBe(true);
  });

  it("keeps a software internship whatever seniority word the title also carries", () => {
    // The exclusion loses to an explicit internship on purpose. Dropping a real
    // software internship is the expensive mistake; a stray listing is a cheap
    // one. The discipline half of the test still has to pass, though — which is
    // why the bare "Engineering Manager Intern" this used to assert on now
    // appears below as a title that is dropped.
    expect(classifyTitle("Software Engineering Manager Intern")).toEqual({
      relevant: true,
      isIntern: true,
      isNewGrad: false,
    });
    expect(classifyTitle("Intern, Software Engineering (Lead Generation)").relevant).toBe(true);
    expect(classifyTitle("Engineering Manager Intern").relevant).toBe(false);
  });

  it("does not treat Leadership as the excluded word Lead", () => {
    // A new grad role rather than an internship, so the seniority exclusion is
    // live and a `\blead\b` that matched "Leadership" would drop it.
    expect(
      classifyTitle("New Grad Software Engineer, Leadership Development Program").relevant
    ).toBe(true);
  });
});

describe("toPlainText", () => {
  it("unescapes Greenhouse's twice escaped HTML and strips the markup", () => {
    // Greenhouse's `content` arrives entity escaped, so one pass yields tags
    // rather than text and the reader would store markup in a text column.
    expect(toPlainText("&lt;p&gt;About Us&lt;br&gt;We trade&lt;/p&gt;")).toBe("About Us\nWe trade");
  });

  it("turns ordinary HTML into readable lines", () => {
    expect(toPlainText("<p>One</p><p>Two &amp; three</p>")).toBe("One\nTwo & three");
  });

  it("returns null for nothing at all", () => {
    expect(toPlainText("")).toBeNull();
    expect(toPlainText("<p></p>")).toBeNull();
    expect(toPlainText(undefined)).toBeNull();
  });
});

// ───────────────────────────────────
// Mappings
// ───────────────────────────────────

async function feedOf(ats: AtsPlatform, token: string, body: unknown) {
  mockFetchOnce(body);
  const result = await readBoardFeed(ats, token);
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result.feed;
}

describe("readBoardFeed mappings", () => {
  it("maps Greenhouse, and emits the embedded application form rather than absolute_url", () => {
    return feedOf("greenhouse", "dvtrading", {
      jobs: [
        {
          id: 4709047005,
          title: "2027 Software Engineer Intern",
          company_name: "DV Trading",
          location: { name: "Chicago, IL" },
          absolute_url: "https://job-boards.greenhouse.io/dvtrading/jobs/4709047005",
          first_published: "2026-06-24T13:27:52-04:00",
          updated_at: "2026-08-05T11:14:34-04:00",
          content: "&lt;p&gt;About Us&lt;/p&gt;",
        },
      ],
      meta: { total: 1 },
    }).then((feed) => {
      expect(feed.company).toBe("DV Trading");
      expect(feed.jobs).toHaveLength(1);
      expect(feed.jobs[0]).toMatchObject({
        externalId: "dvtrading:4709047005",
        nativeId: "4709047005",
        title: "2027 Software Engineer Intern",
        location: "Chicago, IL",
        url: "https://job-boards.greenhouse.io/embed/job_app?for=dvtrading&token=4709047005",
        description: "About Us",
      });
      expect(feed.jobs[0].postedAt?.toISOString()).toBe("2026-06-24T17:27:52.000Z");
    });
  });

  it("maps Lever, whose title field is called text", async () => {
    const feed = await feedOf("lever", "belvederetrading", [
      {
        id: "be7ab7fc-03c2-4192-adbe-eaf85e9588fe",
        text: "Software Engineer Intern",
        categories: { location: "Chicago, Illinois", commitment: "Intern" },
        createdAt: 1765380089635,
        descriptionPlain: "Belvedere Trading is a leading proprietary trading firm.",
        hostedUrl: "https://jobs.lever.co/belvederetrading/be7ab7fc",
        applyUrl: "https://jobs.lever.co/belvederetrading/be7ab7fc/apply",
      },
    ]);

    expect(feed.jobs[0]).toMatchObject({
      externalId: "belvederetrading:be7ab7fc-03c2-4192-adbe-eaf85e9588fe",
      title: "Software Engineer Intern",
      location: "Chicago, Illinois",
      url: "https://jobs.lever.co/belvederetrading/be7ab7fc/apply",
    });
    expect(feed.jobs[0].postedAt?.getTime()).toBe(1765380089635);
  });

  it("maps Ashby and drops a posting the employer has unlisted", async () => {
    const feed = await feedOf("ashby", "etched", {
      apiVersion: "1",
      jobs: [
        {
          id: "7aeafe31-c2c6-43e0-bb31-01868dcfad39",
          title: "Software Engineer, New Grad",
          location: "San Jose",
          publishedAt: "2025-06-11T05:03:53.978+00:00",
          isListed: true,
          descriptionPlain: "About Etched",
          jobUrl: "https://jobs.ashbyhq.com/etched/7aeafe31",
          applyUrl: "https://jobs.ashbyhq.com/etched/7aeafe31/application",
        },
        {
          id: "00000000-0000-0000-0000-000000000000",
          title: "Software Engineer Intern",
          isListed: false,
          applyUrl: "https://jobs.ashbyhq.com/etched/00000000/application",
        },
      ],
    });

    expect(feed.jobs).toHaveLength(1);
    expect(feed.jobs[0]).toMatchObject({
      externalId: "etched:7aeafe31-c2c6-43e0-bb31-01868dcfad39",
      url: "https://jobs.ashbyhq.com/etched/7aeafe31/application",
      description: "About Etched",
    });
  });

  it("maps Workable, whose posting id is a shortcode", async () => {
    const feed = await feedOf("workable", "tmeic-corporation-americas", {
      name: "TMEIC Corporation Americas",
      jobs: [
        {
          title: "Engineering Intern",
          shortcode: "49FCF9E74B",
          city: "Brookshire",
          state: "Texas",
          country: "United States",
          application_url: "https://apply.workable.com/j/49FCF9E74B/apply",
          published_on: "2026-08-06",
          description: "<p>Job description</p>",
        },
      ],
    });

    expect(feed.company).toBe("TMEIC Corporation Americas");
    expect(feed.jobs[0]).toMatchObject({
      externalId: "tmeic-corporation-americas:49FCF9E74B",
      location: "Brookshire, Texas, United States",
      url: "https://apply.workable.com/j/49FCF9E74B/apply",
      description: "Job description",
    });
  });

  it("maps Recruitee, including its space separated UTC timestamps", async () => {
    const feed = await feedOf("recruitee", "channable", {
      offers: [
        {
          id: 2697907,
          title: "Software Engineer Intern",
          company_name: "Channable",
          location: "Utrecht, Utrecht, Netherlands",
          slug: "software-engineer-intern",
          careers_url: "https://jobs.channable.com/o/software-engineer-intern",
          careers_apply_url: "https://jobs.channable.com/o/software-engineer-intern/c/new",
          published_at: "2026-08-03 15:40:43 UTC",
          description: "<p>Are you fluent in Go?</p>",
        },
      ],
    });

    expect(feed.company).toBe("Channable");
    expect(feed.jobs[0]).toMatchObject({
      externalId: "channable:2697907",
      url: "https://jobs.channable.com/o/software-engineer-intern/c/new",
      description: "Are you fluent in Go?",
    });
    expect(feed.jobs[0].postedAt?.toISOString()).toBe("2026-08-03T15:40:43.000Z");
  });

  it("maps Breezy, whose title field is called name", async () => {
    const feed = await feedOf("breezy", "breezy", [
      {
        id: "98323abf2296",
        friendly_id: "98323abf2296-swe-intern",
        name: "SWE Intern",
        url: "https://breezy.breezy.hr/p/98323abf2296-swe-intern",
        published_date: "2024-02-15T14:37:22.684Z",
        location: { name: "Chaos, FL" },
        company: { name: "MS Breezy Trial" },
      },
    ]);

    expect(feed.company).toBe("MS Breezy Trial");
    expect(feed.jobs[0]).toMatchObject({
      externalId: "breezy:98323abf2296",
      title: "SWE Intern",
      location: "Chaos, FL",
      description: null,
    });
  });

  it("maps SmartRecruiters and builds the posting URL from the company identifier", async () => {
    const feed = await feedOf("smartrecruiters", "averydennison", {
      offset: 0,
      limit: 100,
      totalFound: 1,
      content: [
        {
          id: "744000144234730",
          name: "Software Engineering Intern",
          company: { identifier: "AveryDennison", name: "Avery Dennison" },
          location: { city: "Mentor", region: "Ohio", country: "us", fullLocation: "Mentor, Ohio, United States" },
          releasedDate: "2026-08-19T06:20:17.831Z",
        },
      ],
    });

    expect(feed.company).toBe("Avery Dennison");
    expect(feed.jobs[0]).toMatchObject({
      externalId: "averydennison:744000144234730",
      location: "Mentor, Ohio, United States",
      url: "https://jobs.smartrecruiters.com/AveryDennison/744000144234730",
    });
  });

  it("maps BambooHR, whose ids are numbered per tenant", async () => {
    const feed = await feedOf("bamboohr", "specteraerospace", {
      meta: { totalCount: 1 },
      result: [
        {
          id: "72",
          jobOpeningName: "Engineering Intern",
          departmentLabel: "Engineering",
          location: { city: "Peabody", state: "Massachusetts" },
        },
      ],
    });

    // The prefix is the whole reason this id is safe to store: "72" is the
    // first posting on every BambooHR board there is.
    expect(feed.jobs[0]).toMatchObject({
      externalId: "specteraerospace:72",
      nativeId: "72",
      title: "Engineering Intern",
      location: "Peabody, Massachusetts",
      url: "https://specteraerospace.bamboohr.com/careers/72",
    });
  });

  it("maps Teamtailor's JSON Feed, taking the location off the schema.org posting", async () => {
    const feed = await feedOf("teamtailor", "tibber", {
      version: "https://jsonfeed.org/version/1.1",
      title: "Tibber",
      items: [
        {
          id: "3043b310-64ba-4867-9a71-777dc0a7218b",
          title: "Software Engineer, New Grad",
          url: "https://tibber.teamtailor.com/jobs/8180242-software-engineer",
          date_published: "2026-08-06T11:34:27+02:00",
          content_html: "<p>Join us</p>",
          _jobposting: {
            "@type": "JobPosting",
            hiringOrganization: { name: "Tibber" },
            jobLocation: [
              { address: { addressLocality: "Amsterdam", addressCountry: "NL" } },
            ],
          },
        },
      ],
    });

    expect(feed.company).toBe("Tibber");
    expect(feed.jobs[0]).toMatchObject({
      externalId: "tibber:3043b310-64ba-4867-9a71-777dc0a7218b",
      location: "Amsterdam, NL",
      url: "https://tibber.teamtailor.com/jobs/8180242-software-engineer",
      description: "Join us",
    });
  });

  it("keeps the vendor's own object on every mapped listing", async () => {
    const original = {
      id: 1,
      title: "Software Engineer Intern",
      location: { name: "Remote" },
      unmapped_field: "kept anyway",
    };
    const feed = await feedOf("greenhouse", "acme", { jobs: [original] });
    expect(feed.jobs[0].raw).toEqual(original);
  });
});

describe("readBoardFeed failure handling", () => {
  it("defers a platform with no public list rather than failing the sync", async () => {
    expect(DEFERRED_ATS).toContain("jazzhr");
    const result = await readBoardFeed("jazzhr", "nro");
    expect(result.status).toBe("deferred");
  });

  it("reports a dead board as failed rather than throwing", async () => {
    mockFetchOnce({ error: "not found" }, 404);
    const result = await readBoardFeed("greenhouse", "no-such-board");
    expect(result).toEqual({ status: "failed", reason: "HTTP 404" });
  });

  it("reports a body that is not the documented shape rather than throwing", async () => {
    mockFetchOnce({ unexpected: true });
    expect((await readBoardFeed("lever", "acme")).status).toBe("failed");
    mockFetchOnce({ unexpected: true });
    expect((await readBoardFeed("ashby", "acme")).status).toBe("failed");
  });

  it("skips a listing with no id or no title instead of writing a broken row", async () => {
    const feed = await feedOf("greenhouse", "acme", {
      jobs: [{ id: 1, title: "" }, { title: "Software Engineer Intern" }, { id: 2, title: "SWE Intern" }],
    });
    expect(feed.jobs.map((job) => job.nativeId)).toEqual(["2"]);
  });
});

// ───────────────────────────────────
// Live shapes, opt in
// ───────────────────────────────────

/**
 * One real read per platform, against a board that was answering when this was
 * written. Read only GETs against public APIs, nothing written anywhere.
 *
 * Off by default. These depend on nine other companies' uptime, and a sync
 * mapping is not broken because one of them is redeploying.
 */
const LIVE_BOARDS: [AtsPlatform, string][] = [
  ["greenhouse", "dvtrading"],
  ["lever", "belvederetrading"],
  ["ashby", "etched"],
  ["workable", "tmeic-corporation-americas"],
  ["recruitee", "channable"],
  ["breezy", "breezy"],
  ["smartrecruiters", "averydennison"],
  ["bamboohr", "specteraerospace"],
  ["teamtailor", "tibber"],
];

describe.runIf(process.env.RUN_LIVE_ATS_TESTS === "true")("live board shapes", () => {
  it.each(LIVE_BOARDS)(
    "%s still answers with the shape the mapping expects",
    async (ats, token) => {
      vi.unstubAllGlobals();
      const result = await readBoardFeed(ats, token);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      expect(result.feed.jobs.length).toBeGreaterThan(0);
      for (const job of result.feed.jobs) {
        expect(job.title).not.toBe("");
        expect(job.externalId.startsWith(`${token}:`)).toBe(true);
        expect(job.url).toMatch(/^https:\/\//);
      }
    },
    60_000
  );
});
