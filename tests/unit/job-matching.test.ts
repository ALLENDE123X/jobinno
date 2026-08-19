// @vitest-environment node
/**
 * JOB-008's matching, against a real Postgres.
 *
 * ── Why this suite is live and not faked ────────────────────────────────────
 * `lib/job-matching.ts` is two SQL statements and a handful of predicates that
 * only exist to be compiled into them. A fake database would assert that the
 * module builds the query the test also builds, which proves nothing, and the
 * three properties this ticket actually turns on are all properties of the
 * SQL: that the anti join really excludes a listing with an `applications` row,
 * that the LIMIT really cuts the fan out to the allowance, and that a
 * correlated `not exists` against `profiles.id` really excludes the right
 * person. The same reasoning `tests/unit/application-quota.test.ts` gives for
 * being live applies unchanged.
 *
 * The pure helpers — `fanOutLimit`, `acceptableLocations` — are tested outside
 * the gate, because they need no database and a laptop with no Postgres should
 * still run them.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * This writes, so `tests/live-db-gate.ts` decides whether the live half runs at
 * all, and every id is minted fresh per run so the cleanup can only ever delete
 * rows this file created.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { APPLICATION_STATUS } from "@/lib/application-status";
import * as schema from "@/lib/db/schema";
import {
  FANOUT_MULTIPLIER,
  acceptableLocations,
  fanOutLimit,
  listUsersDueForSearch,
  loadMatchProfile,
  matchJobsForUser,
  remainingAllowance,
  searchBlockedReason,
  type MatchProfile,
} from "@/lib/job-matching";

import { liveDbId, liveDbSuite, liveDbUrl } from "../live-db-gate";

// ───────────────────────────────────
// The parts that need no database
// ───────────────────────────────────

const profileOf = (overrides: Partial<MatchProfile> = {}): MatchProfile => ({
  targetLocations: null,
  willingToRelocate: null,
  currentCity: null,
  applicationsUsed: 0,
  applicationsCap: 0,
  attestedAt: new Date(),
  hasActiveResume: true,
  ...overrides,
});

describe("the fan out ceiling", () => {
  it("is the remaining allowance times the multiplier, not the allowance itself", () => {
    // The multiplier exists because a dispatched listing does not reliably
    // spend a slot: `settleApplicationSlot` refunds every run that submitted
    // nothing, so a fan out sized exactly to the allowance leaves it unspent.
    expect(fanOutLimit(1)).toBe(FANOUT_MULTIPLIER);
    expect(fanOutLimit(50)).toBe(50 * FANOUT_MULTIPLIER);
  });

  it("is zero for a person with nothing left, and never negative", () => {
    expect(remainingAllowance(profileOf({ applicationsUsed: 5, applicationsCap: 5 }))).toBe(0);
    // A counter past its cap is not impossible — JOB-010's webhook moves the cap
    // independently — and it must read as "nothing left", not as a negative
    // limit that a caller turns into an unbounded query.
    expect(remainingAllowance(profileOf({ applicationsUsed: 9, applicationsCap: 5 }))).toBe(0);
    expect(fanOutLimit(0)).toBe(0);
    expect(fanOutLimit(-3)).toBe(0);
  });
});

describe("whether a profile can be searched for at all", () => {
  it("passes a profile that has attested and has a resume", () => {
    expect(searchBlockedReason(profileOf())).toBeNull();
  });

  it("refuses one that has never attested", () => {
    // HARD STOP 9. Checked once, in discovery, rather than N times in N fanned
    // out runs — which is the property the live search had by accident, because
    // `loadCandidate` threw on it.
    expect(searchBlockedReason(profileOf({ attestedAt: null }))).toMatch(/never attested/);
  });

  it("refuses one with no resume to attach", () => {
    expect(searchBlockedReason(profileOf({ hasActiveResume: false }))).toMatch(/no active resume/);
  });
});

describe("which locations a search should accept", () => {
  it("takes the stated destinations over the relocation flag", () => {
    // The schema's own note on `target_locations`: "yes, anywhere in the US" and
    // "yes, but only to New York" are different instructions.
    expect(
      acceptableLocations(profileOf({ targetLocations: ["New York"], willingToRelocate: true }))
    ).toEqual(["new york"]);
  });

  it("falls back to the city they are in when they will not move", () => {
    expect(
      acceptableLocations(profileOf({ willingToRelocate: false, currentCity: "Atlanta" }))
    ).toEqual(["atlanta"]);
  });

  it("accepts anywhere when nothing is known that would exclude a listing", () => {
    expect(acceptableLocations(profileOf({ willingToRelocate: true }))).toEqual([]);
    expect(acceptableLocations(profileOf())).toEqual([]);
  });

  it("lets one search override the stored destinations", () => {
    expect(
      acceptableLocations(profileOf({ targetLocations: ["New York"] }), ["Seattle"])
    ).toEqual(["seattle"]);
  });
});

// ───────────────────────────────────
// The query itself
// ───────────────────────────────────

liveDbSuite("matching against the synced jobs table", () => {
  const USER_ID = liveDbId();
  const OTHER_USER_ID = liveDbId();
  const ACME_BOARD_ID = liveDbId();
  const OTHER_BOARD_ID = liveDbId();
  const ACME_TOKEN = `acme-${ACME_BOARD_ID}`;
  const GLOBEX_TOKEN = `globex-${OTHER_BOARD_ID}`;

  /**
   * Every assertion here is scoped to these two boards, and that is not
   * tidiness.
   *
   * Vitest runs test files in parallel workers against one database, and
   * `jobs` is not user scoped: `tests/unit/application-quota.test.ts` inserts
   * an untitled `SWE Intern` listing of its own, and a match with no allowlist
   * finds it. Scoping every query to boards this file created is what makes the
   * exact equality assertions below mean what they say. The one case that has
   * to run unscoped — "no allowlist means every board" — asserts containment
   * instead, for the same reason.
   */
  const OWN_BOARDS = [ACME_TOKEN, GLOBEX_TOKEN];

  const sql = postgres(liveDbUrl, { prepare: false, max: 4, onnotice: () => {} });
  const database = drizzle(sql, { schema });

  /** Every `jobs` row this file made, newest first insertion order. */
  const jobIds: string[] = [];

  /**
   * One listing on the Acme board. `postedAt` is spread out so the ordering
   * assertion below has something real to order by.
   */
  const insertJob = async (input: {
    title: string;
    location: string | null;
    boardId?: string;
    postedMinutesAgo?: number;
  }) => {
    const id = liveDbId();
    const boardId = input.boardId ?? ACME_BOARD_ID;
    const minutes = input.postedMinutesAgo ?? jobIds.length;
    await sql`
      insert into public.jobs (id, board_id, ats, external_id, title, location, url, posted_at)
      values (${id}, ${boardId}, 'greenhouse', ${`match-${id}`}, ${input.title},
              ${input.location}, ${`https://boards.example.com/${id}`},
              now() - ${`${minutes} minutes`}::interval)`;
    jobIds.push(id);
    return id;
  };

  const applicationIds: string[] = [];
  const insertApplication = async (input: {
    userId: string;
    jobId: string;
    status: string;
    ageHours?: number;
  }) => {
    const id = liveDbId();
    await sql`
      insert into public.applications (id, user_id, job_id, status, created_at)
      values (${id}, ${input.userId}, ${input.jobId}, ${input.status},
              now() - ${`${input.ageHours ?? 0} hours`}::interval)`;
    applicationIds.push(id);
    return id;
  };

  const clearApplications = async () => {
    if (applicationIds.length === 0) return;
    await sql`delete from public.applications where id = any(${sql.array(applicationIds)}::uuid[])`;
    applicationIds.length = 0;
  };

  const allow = async (userId: string, used: number, cap: number) => {
    await sql`
      update public.profiles set applications_used = ${used}, applications_cap = ${cap}
       where id = ${userId}`;
  };

  beforeAll(async () => {
    for (const [id, email] of [
      [USER_ID, "match@example.com"],
      [OTHER_USER_ID, "other@example.com"],
    ] as const) {
      await sql`insert into auth.users (id, email) values (${id}, ${email})`;
      await sql`
        insert into public.profiles (id, email, attested_at, applications_used, applications_cap)
        values (${id}, ${email}, now(), 0, 10)`;
      await sql`
        insert into public.resumes (id, user_id, storage_path, is_active)
        values (${liveDbId()}, ${id}, ${`resumes/${id}.pdf`}, true)`;
    }

    await sql`
      insert into public.boards (id, ats, company, board_token)
      values (${ACME_BOARD_ID}, 'greenhouse', 'Acme Robotics', ${ACME_TOKEN})`;
    await sql`
      insert into public.boards (id, ats, company, board_token)
      values (${OTHER_BOARD_ID}, 'lever', 'Globex', ${GLOBEX_TOKEN})`;
  });

  afterAll(async () => {
    await clearApplications();
    if (jobIds.length > 0) {
      await sql`delete from public.jobs where id = any(${sql.array(jobIds)}::uuid[])`;
    }
    await sql`delete from public.resumes where user_id = any(${sql.array([USER_ID, OTHER_USER_ID])}::uuid[])`;
    await sql`delete from public.boards where id = any(${sql.array([ACME_BOARD_ID, OTHER_BOARD_ID])}::uuid[])`;
    await sql`delete from public.profiles where id = any(${sql.array([USER_ID, OTHER_USER_ID])}::uuid[])`;
    await sql`delete from auth.users where id = any(${sql.array([USER_ID, OTHER_USER_ID])}::uuid[])`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await clearApplications();
    if (jobIds.length > 0) {
      await sql`delete from public.jobs where id = any(${sql.array(jobIds)}::uuid[])`;
      jobIds.length = 0;
    }
    await allow(USER_ID, 0, 10);
    await allow(OTHER_USER_ID, 0, 10);
    await sql`update public.profiles set attested_at = now() where id = ${USER_ID}`;
    await sql`update public.profiles set attested_at = now() where id = ${OTHER_USER_ID}`;
  });

  const match = async (
    overrides: {
      profile?: Partial<MatchProfile>;
      preferences?: Parameters<typeof matchJobsForUser>[0]["preferences"];
      limit?: number;
      userId?: string;
    } = {}
  ) =>
    matchJobsForUser(
      {
        userId: overrides.userId ?? USER_ID,
        profile: profileOf(overrides.profile),
        // Scoped to this file's own boards unless a case says otherwise. See
        // `OWN_BOARDS`.
        preferences: { companies: OWN_BOARDS, ...overrides.preferences },
        limit: overrides.limit ?? 50,
      },
      database
    );

  // ───────────────────────────────────
  // The exclusion this ticket is really about
  // ───────────────────────────────────

  it("excludes a listing this person already has an applications row for", async () => {
    const applied = await insertJob({ title: "Software Engineer Intern", location: "Remote" });
    const fresh = await insertJob({ title: "Software Engineer, New Grad", location: "Remote" });

    // Before: both are on offer.
    expect((await match()).map((row) => row.jobId).sort()).toEqual([applied, fresh].sort());

    await insertApplication({
      userId: USER_ID,
      jobId: applied,
      status: APPLICATION_STATUS.SUBMITTED,
    });

    // After: only the one with no row. This is what makes a repeated
    // `job-search/requested` idempotent — without it the second search
    // re-dispatches a listing already sitting in an employer's inbox.
    expect((await match()).map((row) => row.jobId)).toEqual([fresh]);
  });

  it("excludes on any status, not only the submitted ones", async () => {
    // Every one of these is a reason not to re-dispatch, and they are different
    // reasons: `discovered` is a run in flight that a second event would race,
    // `filling_form` likewise, and the two blocked values are listings this
    // version cannot get through — re-dispatching those daily would spend a
    // browser to be stopped in the same place, forever.
    const statuses = [
      APPLICATION_STATUS.DISCOVERED,
      APPLICATION_STATUS.FILLING_FORM,
      APPLICATION_STATUS.FORM_FILL_BLOCKED,
      APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
    ];

    const taken: string[] = [];
    for (const status of statuses) {
      const jobId = await insertJob({ title: `SWE Intern ${status}`, location: "Remote" });
      await insertApplication({ userId: USER_ID, jobId, status });
      taken.push(jobId);
    }
    const free = await insertJob({ title: "SWE Intern free", location: "Remote" });

    const matched = (await match()).map((row) => row.jobId);
    expect(matched).toEqual([free]);
    for (const jobId of taken) expect(matched).not.toContain(jobId);
  });

  it("does not exclude a listing somebody else applied to", async () => {
    // The anti join is scoped to one person. A correlated subquery that lost its
    // `user_id` predicate would pass every other test in this file and quietly
    // hide every popular listing from everybody.
    const jobId = await insertJob({ title: "Software Engineer Intern", location: "Remote" });
    await insertApplication({
      userId: OTHER_USER_ID,
      jobId,
      status: APPLICATION_STATUS.SUBMITTED,
    });

    expect((await match()).map((row) => row.jobId)).toEqual([jobId]);
  });

  // ───────────────────────────────────
  // The cap on the fan out
  // ───────────────────────────────────

  it("returns no more listings than the limit, however many match", async () => {
    for (let index = 0; index < 9; index += 1) {
      await insertJob({ title: `Software Engineer Intern ${index}`, location: "Remote" });
    }

    // Nine match. A person with two applications left has a ceiling of
    // 2 × FANOUT_MULTIPLIER, so that is what comes back — not nine.
    const remaining = 2;
    const limited = await match({ limit: fanOutLimit(remaining) });

    expect(limited).toHaveLength(remaining * FANOUT_MULTIPLIER);
    expect(remaining * FANOUT_MULTIPLIER).toBeLessThan(9);
  });

  it("dispatches nothing at all when the allowance is spent", async () => {
    await insertJob({ title: "Software Engineer Intern", location: "Remote" });
    await allow(USER_ID, 10, 10);

    const profile = await loadMatchProfile(USER_ID, database);
    expect(profile).not.toBeNull();
    // Read fresh off `profiles`, not from anything this test told the module.
    expect(remainingAllowance(profile as MatchProfile)).toBe(0);

    // And the query short circuits rather than issuing `limit 0`.
    expect(await match({ limit: fanOutLimit(0) })).toEqual([]);
  });

  it("takes the newest listings when the limit cuts the set", async () => {
    // Ordering is not decoration when a limit is in play: it decides which two
    // of nine listings a person's last two applications are spent on. Newest
    // first, because a posting's age is the best proxy this table carries for
    // whether it is still open.
    const older = await insertJob({
      title: "Software Engineer Intern old",
      location: "Remote",
      postedMinutesAgo: 500,
    });
    const newest = await insertJob({
      title: "Software Engineer Intern new",
      location: "Remote",
      postedMinutesAgo: 1,
    });

    expect((await match({ limit: 1 })).map((row) => row.jobId)).toEqual([newest]);
    expect((await match({ limit: 2 })).map((row) => row.jobId)).toEqual([newest, older]);
  });

  // ───────────────────────────────────
  // What the match is made of
  // ───────────────────────────────────

  it("keeps a listing whose location contains one of the named places", async () => {
    const wanted = await insertJob({ title: "SWE Intern", location: "New York, NY" });
    const elsewhere = await insertJob({ title: "SWE Intern", location: "Dublin, Ireland" });
    const unknown = await insertJob({ title: "SWE Intern", location: null });

    const matched = (await match({ profile: { targetLocations: ["new york"] } })).map(
      (row) => row.jobId
    );

    expect(matched).toContain(wanted);
    expect(matched).not.toContain(elsewhere);
    // A null location cannot be shown to overlap anything, and a slot is a paid,
    // scarce thing. Documented on `locationPredicate`.
    expect(matched).not.toContain(unknown);
  });

  it("keeps a remote listing whatever places were named", async () => {
    const remote = await insertJob({ title: "SWE Intern", location: "Remote - US" });
    const elsewhere = await insertJob({ title: "SWE Intern", location: "Dublin, Ireland" });

    const matched = (await match({ profile: { targetLocations: ["Seattle"] } })).map(
      (row) => row.jobId
    );

    expect(matched).toEqual([remote]);
    expect(matched).not.toContain(elsewhere);
  });

  it("filters on the board allowlist by token or by company name", async () => {
    const acme = await insertJob({ title: "SWE Intern", location: "Remote" });
    const globex = await insertJob({
      title: "SWE Intern",
      location: "Remote",
      boardId: OTHER_BOARD_ID,
    });

    const byCompany = await match({ preferences: { companies: ["acme robotics"] } });
    expect(byCompany.map((row) => row.jobId)).toEqual([acme]);
    // The employer name comes off the joined `boards` row, which is the only
    // place it lives: `jobs` has no company column.
    expect(byCompany[0].company).toBe("Acme Robotics");

    const byToken = await match({
      preferences: { companies: [GLOBEX_TOKEN.toUpperCase()] },
    });
    expect(byToken.map((row) => row.jobId)).toEqual([globex]);

    // No allowlist at all means every active board, not none. Containment
    // rather than equality: other suites' listings are in this table too.
    const unscoped = await matchJobsForUser(
      { userId: USER_ID, profile: profileOf(), limit: 500 },
      database
    );
    expect(unscoped.map((row) => row.jobId)).toEqual(expect.arrayContaining([acme, globex]));
  });

  it("ignores listings on a board that has been deactivated", async () => {
    const jobId = await insertJob({ title: "SWE Intern", location: "Remote" });
    expect((await match()).map((row) => row.jobId)).toEqual([jobId]);

    await sql`update public.boards set active = false where id = ${ACME_BOARD_ID}`;
    try {
      expect(await match()).toEqual([]);
    } finally {
      await sql`update public.boards set active = true where id = ${ACME_BOARD_ID}`;
    }
  });

  it("narrows on the title only when one is supplied", async () => {
    const intern = await insertJob({ title: "Software Engineer Intern", location: "Remote" });
    const newGrad = await insertJob({ title: "Software Engineer, New Grad", location: "Remote" });

    // Title blind by default. Ingest already refused anything that was not an
    // internship, a new grad role or an unsenior software engineering role, so
    // an untitled search is still a relevant one.
    expect((await match()).map((row) => row.jobId).sort()).toEqual([intern, newGrad].sort());

    expect((await match({ preferences: { title: "intern" } })).map((row) => row.jobId)).toEqual([
      intern,
    ]);
  });

  it("does not let a wildcard in a supplied value widen the filter", async () => {
    // `_` matches any character in LIKE and `%` matches any run of them.
    // Unescaped, a title of "_" would match every listing on the board rather
    // than none of them. The location is deliberately not remote here, since a
    // remote listing passes the location filter by a separate clause and would
    // hide the bug.
    await insertJob({ title: "Software Engineer Intern", location: "Dublin, Ireland" });
    expect(await match({ preferences: { title: "_" } })).toEqual([]);
    expect(await match({ profile: { targetLocations: ["%"] } })).toEqual([]);

    // And the same values, escaped correctly, still match when they really occur.
    await insertJob({ title: "Site Reliability Engineer 100% Remote", location: "Dublin, Ireland" });
    expect(await match({ preferences: { title: "100%" } })).toHaveLength(1);
  });
});

// ───────────────────────────────────
// Who the cron should fire for
// ───────────────────────────────────

liveDbSuite("choosing who is due for a scheduled search", () => {
  const BOARD_ID = liveDbId();
  const JOB_ID = liveDbId();

  const sql = postgres(liveDbUrl, { prepare: false, max: 4, onnotice: () => {} });
  const database = drizzle(sql, { schema });

  const userIds: string[] = [];
  const applicationIds: string[] = [];

  /** One profile, described by the four things the schedule reads. */
  const addProfile = async (input: {
    attested: boolean;
    used: number;
    cap: number;
    resume?: boolean;
  }): Promise<string> => {
    const id = liveDbId();
    const email = `due-${id}@example.com`;
    await sql`insert into auth.users (id, email) values (${id}, ${email})`;
    await sql`
      insert into public.profiles (id, email, attested_at, applications_used, applications_cap)
      values (${id}, ${email}, ${input.attested ? sql`now()` : null},
              ${input.used}, ${input.cap})`;
    if (input.resume !== false) {
      await sql`
        insert into public.resumes (id, user_id, storage_path, is_active)
        values (${liveDbId()}, ${id}, ${`resumes/${id}.pdf`}, true)`;
    }
    userIds.push(id);
    return id;
  };

  const addApplication = async (userId: string, status: string, ageHours: number) => {
    const id = liveDbId();
    await sql`
      insert into public.applications (id, user_id, job_id, status, created_at)
      values (${id}, ${userId}, ${JOB_ID}, ${status}, now() - ${`${ageHours} hours`}::interval)`;
    applicationIds.push(id);
  };

  beforeAll(async () => {
    await sql`
      insert into public.boards (id, ats, company, board_token)
      values (${BOARD_ID}, 'greenhouse', 'Acme', ${`due-${BOARD_ID}`})`;
    await sql`
      insert into public.jobs (id, board_id, ats, external_id, title, url)
      values (${JOB_ID}, ${BOARD_ID}, 'greenhouse', ${`due-${JOB_ID}`}, 'SWE Intern',
              ${`https://boards.example.com/${JOB_ID}`})`;
  });

  afterAll(async () => {
    if (applicationIds.length > 0) {
      await sql`delete from public.applications where id = any(${sql.array(applicationIds)}::uuid[])`;
    }
    await sql`delete from public.jobs where id = ${JOB_ID}`;
    await sql`delete from public.boards where id = ${BOARD_ID}`;
    if (userIds.length > 0) {
      await sql`delete from public.resumes where user_id = any(${sql.array(userIds)}::uuid[])`;
      await sql`delete from public.profiles where id = any(${sql.array(userIds)}::uuid[])`;
      await sql`delete from auth.users where id = any(${sql.array(userIds)}::uuid[])`;
    }
    await sql.end({ timeout: 5 });
  });

  it("fires for the onboarded people with allowance left, and for nobody else", async () => {
    const ready = await addProfile({ attested: true, used: 2, cap: 10 });
    const notAttested = await addProfile({ attested: false, used: 0, cap: 10 });
    // A cap of zero is the default and means "not provisioned to apply yet".
    const notProvisioned = await addProfile({ attested: true, used: 0, cap: 0 });
    const exhausted = await addProfile({ attested: true, used: 10, cap: 10 });
    // Attested, provisioned, and nothing to attach. A fan out for this person
    // would reach a real employer's form before finding out.
    const noResume = await addProfile({ attested: true, used: 0, cap: 10, resume: false });
    const midSearch = await addProfile({ attested: true, used: 1, cap: 10 });
    const finishedSearch = await addProfile({ attested: true, used: 1, cap: 10 });
    const staleRow = await addProfile({ attested: true, used: 1, cap: 10 });

    // In flight an hour ago: their last search has not finished.
    await addApplication(midSearch, APPLICATION_STATUS.FILLING_FORM, 1);
    // Terminal an hour ago: finished, and due again.
    await addApplication(finishedSearch, APPLICATION_STATUS.SUBMITTED, 1);
    // In flight, but two days old. A row that got stuck must not suppress this
    // person's searches forever, which is the whole reason for the window.
    await addApplication(staleRow, APPLICATION_STATUS.DISCOVERED, 48);

    const due = await listUsersDueForSearch(database);

    expect(due).toContain(ready);
    expect(due).toContain(finishedSearch);
    expect(due).toContain(staleRow);

    expect(due).not.toContain(notAttested);
    expect(due).not.toContain(notProvisioned);
    expect(due).not.toContain(exhausted);
    expect(due).not.toContain(noResume);
    expect(due).not.toContain(midSearch);
  });
});
