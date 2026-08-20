// @vitest-environment node
/**
 * JOB-003. One function, and it is here because a real run against the real
 * registry failed without it.
 *
 * Workable's `capula-investment-management-ltd` publishes twelve jobs under
 * eight shortcodes: a posting open in four offices is listed once per office,
 * and the shortcode is the posting. Handed straight to an
 * `insert … on conflict do update`, that is one key named four times in one
 * VALUES list, which Postgres refuses outright rather than resolving. The whole
 * board is lost, not just the duplicate.
 *
 * No database: the deduplication is a Map, and the constraint it protects is
 * exercised in CI by the schema push rather than here.
 *
 * The second half of this file is the apply URL screen. That one does reach
 * `ingestBoard`, because the thing worth proving is not that a pure function
 * says no, it is that a posting whose `applyUrl` points away from its own board
 * never reaches the insert. Both the ATS platform's API and the database are
 * stubs; everything between them is the real module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dedupeByExternalId, ingestBoard, screenApplyUrls } from "@/lib/board-ingest";
import type { FeedJob } from "@/lib/ats-job-feeds";

/** Every `insert(...).values(rows)` the module made, in order. */
const inserted: unknown[][] = [];

vi.mock("@/lib/db/client", () => {
  // Drizzle's builders are chainable and thenable. This is the smallest thing
  // that behaves like one: every method hands the builder back, and awaiting it
  // resolves to an empty result set the way `returning()` would on a conflict
  // that changed nothing.
  const builder = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
    };
    for (const method of [
      "select",
      "from",
      "where",
      "orderBy",
      "update",
      "set",
      "insert",
      "onConflictDoNothing",
      "onConflictDoUpdate",
      "returning",
    ]) {
      chain[method] = () => chain;
    }
    chain.values = (rows: unknown[]) => {
      inserted.push(rows);
      return chain;
    };
    return chain;
  };

  return { db: () => builder(), closeDb: async () => undefined };
});

function entry(externalId: string, title: string) {
  const job: FeedJob = {
    externalId,
    nativeId: externalId.split(":")[1] ?? externalId,
    title,
    location: null,
    url: "https://apply.workable.com/j/A15A62A8BE/apply",
    description: null,
    postedAt: null,
    raw: { title },
  };
  return { job, isIntern: true, isNewGrad: false };
}

describe("dedupeByExternalId", () => {
  it("collapses one posting listed once per office", () => {
    const capula = [
      entry("capula:A15A62A8BE", "2027 Trading and Research Summer Internship"),
      entry("capula:A15A62A8BE", "2027 Trading and Research Summer Internship"),
      entry("capula:A15A62A8BE", "2027 Trading and Research Summer Internship"),
      entry("capula:A15A62A8BE", "2027 Trading and Research Summer Internship"),
      entry("capula:88F2A24444", "Technology Graduate Analyst"),
    ];

    expect(dedupeByExternalId(capula).map((row) => row.job.externalId)).toEqual([
      "capula:A15A62A8BE",
      "capula:88F2A24444",
    ]);
  });

  it("keeps the first of a repeated key and leaves the rest alone", () => {
    const rows = [entry("acme:1", "First"), entry("acme:1", "Second"), entry("acme:2", "Third")];
    expect(dedupeByExternalId(rows).map((row) => row.job.title)).toEqual(["First", "Third"]);
  });

  it("changes nothing when every key is already distinct", () => {
    const rows = [entry("acme:1", "One"), entry("acme:2", "Two")];
    expect(dedupeByExternalId(rows)).toHaveLength(2);
  });

  it("handles an empty board", () => {
    expect(dedupeByExternalId([])).toEqual([]);
  });
});

// ───────────────────────────────────
// The apply URL screen
// ───────────────────────────────────

/** `readBoardFeed` calls `fetch` once. This answers it with whatever a test wants. */
function answerWith(body: unknown): void {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
}

/** One posting as Lever's `/v0/postings/{token}?mode=json` publishes it. */
function leverPosting(id: string, text: string, applyUrl: string) {
  return {
    id,
    text,
    categories: { location: "New York" },
    descriptionPlain: "A real sounding job description.",
    createdAt: 1_760_000_000_000,
    hostedUrl: applyUrl.replace(/\/apply$/, ""),
    applyUrl,
  };
}

const ACME = {
  id: "b0000000-0000-4000-8000-000000000000",
  ats: "lever" as const,
  boardToken: "acmecorp",
  company: "Acme Corp",
};

let warnings: string[] = [];

beforeEach(() => {
  inserted.length = 0;
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a Lever tenant whose applyUrl points away from its own board", () => {
  it("writes the board's own listing and drops the ones that are not", async () => {
    // The attack, in the shape it would really arrive in: a board token added to
    // one of the public listing repositories, a free tier Lever tenant behind
    // it, and an `applyUrl` of the tenant's choosing on a posting titled to pass
    // the relevance filter.
    answerWith([
      leverPosting(
        "1111",
        "Software Engineer Intern",
        "https://jobs.lever.co/acmecorp/1111/apply"
      ),
      leverPosting(
        "2222",
        "Software Engineer Intern, Platform",
        "https://acmecorp-careers.attacker.example/apply/2222"
      ),
      leverPosting(
        "3333",
        "New Grad Software Engineer",
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
      ),
    ]);

    const outcome = await ingestBoard(ACME);

    expect(outcome.status).toBe("ok");
    expect(outcome.seen).toBe(3);
    expect(outcome.kept).toBe(1);
    expect(outcome.rejected).toBe(2);

    // The row that reached the database, and it is the only one.
    expect(inserted).toHaveLength(1);
    const rows = inserted[0] as { externalId: string; url: string }[];
    expect(rows.map((row) => row.url)).toEqual(["https://jobs.lever.co/acmecorp/1111/apply"]);
    expect(rows.map((row) => row.externalId)).toEqual(["acmecorp:1111"]);

    // And the two that did not are in the log with the URL that caused it, so a
    // real rejection is findable rather than a silent count.
    const dropped = warnings.filter((line) => line.includes("dropped listing"));
    expect(dropped).toHaveLength(2);
    expect(dropped.join("\n")).toContain("acmecorp-careers.attacker.example");
    expect(dropped.join("\n")).toContain("169.254.169.254");
  });

  it("keeps syncing the board rather than failing it", async () => {
    // Every posting on the board is unusable. That is still an `ok` sync of a
    // board with nothing to write, not a failure: one tenant must not be able to
    // stop the run that is reading everybody else's boards.
    answerWith([
      leverPosting("4444", "Software Engineer Intern", "https://attacker.example/apply"),
    ]);

    const outcome = await ingestBoard(ACME);

    expect(outcome).toMatchObject({ status: "ok", seen: 1, kept: 0, rejected: 1 });
    expect(inserted).toHaveLength(0);
  });

  it("writes the whole board when every apply URL is its own", async () => {
    // The regression this fix could cause, asserted directly.
    answerWith([
      leverPosting("5555", "Software Engineer Intern", "https://jobs.lever.co/acmecorp/5555/apply"),
      leverPosting(
        "6666",
        "New Grad Software Engineer",
        "https://jobs.lever.co/acmecorp/6666/apply"
      ),
    ]);

    const outcome = await ingestBoard(ACME);

    expect(outcome).toMatchObject({ status: "ok", seen: 2, kept: 2, rejected: 0 });
    expect(inserted[0]).toHaveLength(2);
  });
});

describe("screenApplyUrls", () => {
  /** One listing shaped the way each platform's reader really emits it. */
  const SHAPES: ReadonlyArray<[ats: string, token: string, url: string]> = [
    [
      "greenhouse",
      "dvtrading",
      "https://job-boards.greenhouse.io/embed/job_app?for=dvtrading&token=4567890",
    ],
    ["lever", "palantir", "https://jobs.lever.co/palantir/9f1c/apply"],
    ["ashby", "etched", "https://jobs.ashbyhq.com/etched/6c1f/application"],
    ["workable", "capula", "https://apply.workable.com/capula/j/A15A62A8BE/apply/"],
    ["recruitee", "channable", "https://channable.recruitee.com/o/swe-intern/c/new"],
    ["breezy", "breezy", "https://breezy.breezy.hr/p/8f21ac0b1e42-swe-intern"],
    ["smartrecruiters", "averydennison", "https://jobs.smartrecruiters.com/AveryDennison/74400"],
    ["bamboohr", "specteraerospace", "https://specteraerospace.bamboohr.com/careers/122"],
    ["teamtailor", "tibber", "https://tibber.teamtailor.com/jobs/1234-swe-intern"],
  ];

  const listing = (url: string) => ({
    job: {
      externalId: "token:1",
      nativeId: "1",
      title: "Software Engineer Intern",
      location: null,
      url,
      description: null,
      postedAt: null,
      raw: {},
    } satisfies FeedJob,
    isIntern: true,
    isNewGrad: false,
  });

  it.each(SHAPES)("keeps a real %s listing", (ats, boardToken, url) => {
    const { kept, rejected } = screenApplyUrls({ ats: ats as never, boardToken }, [listing(url)]);
    expect(rejected).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  it("reports the reason and the URL for each listing it drops", () => {
    const { kept, rejected } = screenApplyUrls({ ats: "lever", boardToken: "acmecorp" }, [
      listing("https://jobs.lever.co/acmecorp/1/apply"),
      listing("https://127.0.0.1:8443/apply"),
      listing("https://jobs.lever.co/someoneelse/2/apply"),
    ]);

    expect(kept).toHaveLength(1);
    expect(rejected.map((row) => row.url)).toEqual([
      "https://127.0.0.1:8443/apply",
      "https://jobs.lever.co/someoneelse/2/apply",
    ]);
    expect(rejected[0]!.reason).toContain("loopback");
    expect(rejected[1]!.reason).toContain("someoneelse");
  });
});
