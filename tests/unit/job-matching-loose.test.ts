// @vitest-environment node
/**
 * JOB-171's loose matcher, against a real Postgres.
 *
 * ── What this suite pins down ───────────────────────────────────────────────
 * `MATCHER_MODE = "loose"` is the shipped default, so these cases run through
 * the public `matchJobsForUser` exactly as production does. The two filters
 * loose mode keeps are asserted positively: intern-vs-fulltime off the
 * graduation date, and the SWE-adjacent title allowlist. Everything the mode
 * dropped is asserted by absence: a profile with one absurd target location
 * ("Only Antarctica") still matches listings on every continent, which is the
 * whole empirical point of the ticket.
 *
 * The strict semantics those cases replaced keep their own suite in
 * job-matching.test.ts, pinned to `"strict"` explicitly. Flip
 * `MATCHER_MODE = "strict"` and both files must pass with no edits.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * Same rule as every suite that writes: `tests/live-db-gate.ts` decides, ids
 * are minted per run, and cleanup deletes only what this file created.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { APPLICATION_STATUS } from "@/lib/application-status";
import * as schema from "@/lib/db/schema";
import {
  MATCHER_MODE,
  SWE_ADJACENT_TITLES,
  matchJobsForUser,
  matchJobsForUserInMode,
  seekingInternship,
  type MatchProfile,
} from "@/lib/job-matching";

import { liveDbId, liveDbSuite, liveDbUrl } from "../live-db-gate";

// ───────────────────────────────────
// The parts that need no database
// ───────────────────────────────────

describe("the shipped matcher mode", () => {
  it("is loose, because JOB-171 shipped the loosening as the default", () => {
    // Guarding the constant itself: a future flip to "strict" is exactly the
    // unwind path JOB-171 documents, but it should be a deliberate edit that
    // sees and updates this assertion rather than a silent revert.
    expect(MATCHER_MODE).toBe("loose");
  });
});

describe("the SWE-adjacent title list", () => {
  it("holds lowercase needles, since containment is case insensitive anyway", () => {
    for (const needle of SWE_ADJACENT_TITLES) {
      expect(needle).toBe(needle.toLowerCase());
      expect(needle.trim().length).toBeGreaterThan(0);
    }
  });

  it("contains no obvious cross-domain families", () => {
    const joined = SWE_ADJACENT_TITLES.join(" | ");
    for (const family of ["nurse", "nursing", "marketing", "sales", "mechanical", "chemical"]) {
      expect(joined).not.toContain(family);
    }
  });
});

describe("whether a profile reads as still in school", () => {
  const today = new Date("2026-08-26T12:00:00Z");
  const profileWithGradDate = (gradDate: string | null): Pick<MatchProfile, "gradDate"> => ({
    gradDate,
  });

  it("reads a graduation date in the future as a student seeking internships", () => {
    expect(seekingInternship(profileWithGradDate("2028-06-15"), today)).toBe(true);
    // Tomorrow counts; the boundary day itself does not.
    expect(seekingInternship(profileWithGradDate("2026-08-27"), today)).toBe(true);
  });

  it("reads a past or same-day graduation date as graduated", () => {
    expect(seekingInternship(profileWithGradDate("2025-12-31"), today)).toBe(false);
    expect(seekingInternship(profileWithGradDate("2026-08-26"), today)).toBe(false);
  });

  it("reads a missing or malformed graduation date as graduated, never as a student", () => {
    // Null means unknown, and unknown widens: the non-intern set is the
    // bigger one, and volume is what this mode exists for.
    expect(seekingInternship(profileWithGradDate(null), today)).toBe(false);
    expect(seekingInternship(profileWithGradDate("not a date"), today)).toBe(false);
  });
});

// ───────────────────────────────────
// The query itself
// ───────────────────────────────────

liveDbSuite("loose matching against the synced jobs table", () => {
  const USER_ID = liveDbId();
  const BOARD_ID = liveDbId();
  const TOKEN = `loose-${BOARD_ID}`;

  const sql = postgres(liveDbUrl, { prepare: false, max: 4, onnotice: () => {} });
  const database = drizzle(sql, { schema });

  /** Every `jobs` row this file made. */
  const jobIds: string[] = [];
  const applicationIds: string[] = [];

  /**
   * One listing on this file's own board, with the ingest flags under the
   * test's control. Rows bypass `ingestBoard` on purpose: the live table
   * holds rows written under older rules, and loose mode has to classify
   * them itself rather than trusting the flags to tell the truth.
   */
  const insertJob = async (input: {
    title: string;
    location: string;
    isIntern?: boolean;
    isNewGrad?: boolean;
    postedMinutesAgo?: number;
  }) => {
    const id = liveDbId();
    const minutes = input.postedMinutesAgo ?? jobIds.length;
    await sql`
      insert into public.jobs
        (id, board_id, ats, external_id, title, location, url, posted_at,
         is_intern, is_new_grad)
      values (${id}, ${BOARD_ID}, 'smartrecruiters', ${`loose-${id}`}, ${input.title},
              ${input.location}, ${`https://boards.example.com/${id}`},
              now() - ${`${minutes} minutes`}::interval,
              ${input.isIntern ?? false}, ${input.isNewGrad ?? false})`;
    jobIds.push(id);
    return id;
  };

  const insertApplication = async (jobId: string) => {
    const id = liveDbId();
    await sql`
      insert into public.applications (id, user_id, job_id, status)
      values (${id}, ${USER_ID}, ${jobId}, ${APPLICATION_STATUS.SUBMITTED})`;
    applicationIds.push(id);
    return id;
  };

  /**
   * The profile under test. `targetLocations` names one absurd place on
   * purpose: loose mode must ignore it completely, so any match at all is
   * proof the location filter was dropped.
   */
  const looseProfile = (overrides: Partial<MatchProfile> = {}): MatchProfile => ({
    targetLocations: ["Only Antarctica"],
    willingToRelocate: false,
    currentCity: "Only Antarctica",
    gradDate: "2028-06-15",
    applicationsUsed: 0,
    applicationsCap: 10,
    attestedAt: new Date(),
    hasActiveResume: true,
    ...overrides,
  });

  const looseMatch = async (profile: MatchProfile, limit = 50) =>
    matchJobsForUser(
      {
        userId: USER_ID,
        profile,
        preferences: { companies: [TOKEN] },
        limit,
      },
      database
    );

  beforeAll(async () => {
    await sql`insert into auth.users (id, email) values (${USER_ID}, ${`loose-${USER_ID}@example.com`})`;
    await sql`
      insert into public.profiles (id, email, attested_at, applications_used, applications_cap, grad_date)
      values (${USER_ID}, ${`loose-${USER_ID}@example.com`}, now(), 0, 10, '2028-06-15')`;
    await sql`
      insert into public.boards (id, ats, company, board_token)
      values (${BOARD_ID}, 'smartrecruiters', 'Loose Robotics', ${TOKEN})`;
  });

  afterAll(async () => {
    if (applicationIds.length > 0) {
      await sql`delete from public.applications where id = any(${sql.array(applicationIds)}::uuid[])`;
    }
    if (jobIds.length > 0) {
      await sql`delete from public.jobs where id = any(${sql.array(jobIds)}::uuid[])`;
    }
    await sql`delete from public.boards where id = ${BOARD_ID}`;
    await sql`delete from public.profiles where id = ${USER_ID}`;
    await sql`delete from auth.users where id = ${USER_ID}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    if (applicationIds.length > 0) {
      await sql`delete from public.applications where id = any(${sql.array(applicationIds)}::uuid[])`;
      applicationIds.length = 0;
    }
    if (jobIds.length > 0) {
      await sql`delete from public.jobs where id = any(${sql.array(jobIds)}::uuid[])`;
      jobIds.length = 0;
    }
  });

  it("matches an intern-seeking student across every location, Antarctica targets ignored", async () => {
    // Four postings in four places the profile did not name, two of them not
    // even in the same country. Under strict mode only the remote-ish ones
    // could ever surface; loose mode takes all four.
    const sf = await insertJob({
      title: "Software Engineer Intern",
      location: "San Francisco, CA",
      isIntern: true,
    });
    const nyc = await insertJob({
      title: "SWE Intern",
      location: "New York, NY",
      isIntern: true,
    });
    const malaysia = await insertJob({
      title: "Internship - Software Engineering",
      location: "Petaling Jaya, Malaysia",
      isIntern: true,
    });
    const erie = await insertJob({
      title: "Software Developer Intern",
      location: "Erie, PA",
      isIntern: true,
    });

    const matched = (await looseMatch(looseProfile())).map((row) => row.jobId);

    expect(matched.sort()).toEqual([sf, nyc, malaysia, erie].sort());
  });

  it("matches a graduated person on everything except internships, across every location", async () => {
    const plainBackend = await insertJob({
      title: "Backend Developer",
      location: "Berlin, Germany",
    });
    const newGrad = await insertJob({
      title: "Machine Learning Engineer, New Grad",
      location: "Austin, TX",
      isNewGrad: true,
    });
    const frontend = await insertJob({
      title: "Frontend Engineer",
      location: "Toronto, Canada",
    });
    const intern = await insertJob({
      title: "Software Engineer Intern",
      location: "Remote",
      isIntern: true,
    });

    const matched = (await looseMatch(looseProfile({ gradDate: "2025-12-31" }))).map(
      (row) => row.jobId
    );

    expect(matched.sort()).toEqual([plainBackend, newGrad, frontend].sort());
    expect(matched).not.toContain(intern);
  });

  it("keeps a plain developer title that the strict classifier rejects", async () => {
    // "Frontend Developer" carries neither an internship nor a new grad word,
    // so `classifyTitle` calls it irrelevant and strict mode drops it. Loose
    // mode keeps it: the title family is the filter now.
    const plain = await insertJob({ title: "Frontend Developer", location: "Remote" });

    const loose = (await looseMatch(looseProfile({ gradDate: null }))).map((row) => row.jobId);
    const strict = (
      await matchJobsForUserInMode(
        "strict",
        {
          userId: USER_ID,
          profile: looseProfile({ gradDate: null }),
          preferences: { companies: [TOKEN] },
          limit: 50,
        },
        database
      )
    ).map((row) => row.jobId);

    expect(loose).toEqual([plain]);
    expect(strict).toEqual([]);
  });

  it("skips a mechanical engineering posting even when it is tagged intern", async () => {
    await insertJob({
      title: "Mechanical Engineering Intern",
      location: "Detroit, MI",
      isIntern: true,
    });
    expect(await looseMatch(looseProfile())).toEqual([]);
  });

  it("skips a nurse posting even when it is tagged full time", async () => {
    await insertJob({ title: "Registered Nurse, Full Time", location: "Remote" });
    await insertJob({
      title: "Nurse Practitioner Software Tools Team",
      location: "Remote",
      isNewGrad: true,
    });
    expect(await looseMatch(looseProfile({ gradDate: "2025-12-31" }))).toEqual([]);
  });

  it("still refuses a listing this person already has an applications row for", async () => {
    const applied = await insertJob({
      title: "Software Engineer Intern",
      location: "San Francisco, CA",
      isIntern: true,
    });
    const fresh = await insertJob({
      title: "Data Engineer Intern",
      location: "New York, NY",
      isIntern: true,
    });
    await insertApplication(applied);

    const matched = (await looseMatch(looseProfile())).map((row) => row.jobId);

    expect(matched).toEqual([fresh]);
  });

  it("returns more than ten candidates once the inventory allows it, capped only by the limit", async () => {
    for (let index = 0; index < 12; index += 1) {
      await insertJob({
        title: `Full Stack Developer ${index}`,
        location: index % 2 === 0 ? "San Francisco, CA" : "Erie, PA",
        postedMinutesAgo: index,
      });
    }

    // A fresh graduate against twelve eligible listings: the fan out ceiling
    // for a full allowance is 30, and nothing narrows the set below twelve.
    const matched = await looseMatch(looseProfile({ gradDate: "2025-12-31" }), 30);

    expect(matched.length).toBeGreaterThan(10);
  });
});
