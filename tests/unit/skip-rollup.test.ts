// @vitest-environment node
/**
 * JOB-015's rollup, against a real Postgres.
 *
 * ── Why this suite is live ──────────────────────────────────────────────────
 * `lib/skip-rollup.ts` is four grouped SELECTs and a merge of their results.
 * Faked, every assertion would be about a query builder producing the shape the
 * test also describes, which proves nothing about whether Postgres groups the
 * rows that way. The properties this ticket turns on are all properties of the
 * SQL and of the merge over its output: that a skip with no `application_id` is
 * still counted, that the window really excludes older rows, that the
 * denominator comes from `applications` and not from the skips themselves, and
 * that the company name arrives through the join `skip_log` cannot do alone.
 * The same reasoning `tests/unit/job-matching.test.ts` gives applies unchanged.
 *
 * `formatSkipRollup` is tested outside the gate, because it is a pure function
 * over a fixture and a laptop with no Postgres should still run it.
 *
 * ── Why every fixture invents its own ATS platform name ─────────────────────
 * The rollup is site wide by design: it has no `user_id` filter to scope an
 * assertion with. Vitest runs test files in parallel workers against one
 * database, and `tests/unit/application-records.test.ts` writes real `skip_log`
 * rows of its own, so a count of every `greenhouse` skip in the last week is a
 * count of whatever else was running at the time.
 *
 * `ats` is free text on both `skip_log` and `jobs` — `ATS_PLATFORMS` in the
 * schema is explicitly a code side list and not a constraint — so a name minted
 * per run gives this file a platform nothing else can write to. Every exact
 * assertion below is scoped to one of those two names. The site wide totals are
 * asserted as floors rather than as equalities, for the same reason.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { APPLICATION_STATUS } from "@/lib/application-status";
import * as schema from "@/lib/db/schema";
import { formatSkipRollup, loadSkipRollup, type SkipRollup } from "@/lib/skip-rollup";

import { liveDbId, liveDbSuite, liveDbUrl } from "../live-db-gate";

// ───────────────────────────────────
// The part that needs no database
// ───────────────────────────────────

const emptyRollup: SkipRollup = {
  window: { days: 7, since: "2026-08-12T00:00:00.000Z", until: "2026-08-19T00:00:00.000Z" },
  totalSkips: 0,
  totalAttempts: 0,
  totalSubmitted: 0,
  byReason: [],
  byPlatform: [],
  topBoards: [],
  unansweredQuestions: [],
};

describe("the report a person reads", () => {
  it("says a platform was never attempted rather than showing it a zero", () => {
    // A platform with skips and no attempts inside the window is the case a
    // percentage cannot describe, and printing 0.0% would read as the opposite
    // of what happened.
    const report = formatSkipRollup({
      ...emptyRollup,
      totalSkips: 2,
      byReason: [{ reason: "captcha", skips: 2 }],
      byPlatform: [
        {
          ats: "workable",
          attempts: 0,
          submitted: 0,
          unconfirmed: 0,
          skips: 2,
          skipsPerAttempt: null,
          submitRate: null,
          byReason: [{ reason: "captcha", skips: 2 }],
        },
      ],
    });

    expect(report).toContain("nothing attempted in this window");
    expect(report).not.toContain("%");
    expect(report).toContain("captcha: 2");
  });

  it("shows the bounded rate as a percentage and the unbounded one as a ratio", () => {
    // More skips than attempts is ordinary: one run can log two, and a skip
    // inside the window can belong to a run started before it. Rendered as a
    // percentage it would read as 300% and look like a defect.
    const report = formatSkipRollup({
      ...emptyRollup,
      totalSkips: 3,
      totalAttempts: 1,
      byPlatform: [
        {
          ats: "workable",
          attempts: 1,
          submitted: 0,
          unconfirmed: 0,
          skips: 3,
          skipsPerAttempt: 3,
          submitRate: 0,
          byReason: [{ reason: "captcha", skips: 3 }],
        },
      ],
    });

    expect(report).toContain("0.0% went through");
    expect(report).toContain("3.00 per attempt");
    expect(report).not.toContain("300");
  });

  it("names the question behind a skip and the company that asked it", () => {
    const report = formatSkipRollup({
      ...emptyRollup,
      totalSkips: 1,
      totalAttempts: 4,
      totalSubmitted: 3,
      byPlatform: [
        {
          ats: "greenhouse",
          attempts: 4,
          submitted: 3,
          unconfirmed: 0,
          skips: 1,
          skipsPerAttempt: 0.25,
          submitRate: 0.75,
          byReason: [{ reason: "unanswerable_required", skips: 1 }],
        },
      ],
      unansweredQuestions: [
        {
          ats: "greenhouse",
          company: "Acme Robotics",
          fieldLabel: "Desired salary",
          fieldKind: "text",
          asked: 1,
        },
      ],
    });

    expect(report).toContain("75.0% went through");
    expect(report).toContain('1x "Desired salary"');
    expect(report).toContain("Acme Robotics");
  });

  it("says so plainly when a window holds nothing at all", () => {
    const report = formatSkipRollup(emptyRollup);
    expect(report).toContain("nothing was skipped in this window");
    expect(report).toContain("no activity in this window");
  });
});

describe("the window", () => {
  it("refuses a window that is not a positive whole number of days", async () => {
    // Checked before the connection is opened, so this runs on a machine with
    // no Postgres and no DATABASE_URL.
    await expect(loadSkipRollup({ days: 0 })).rejects.toThrow(/positive whole number of days/);
    await expect(loadSkipRollup({ days: -7 })).rejects.toThrow(/positive whole number of days/);
    await expect(loadSkipRollup({ days: 1.5 })).rejects.toThrow(/positive whole number of days/);
  });
});

// ───────────────────────────────────
// The queries themselves
// ───────────────────────────────────

liveDbSuite("rolling up real skip_log rows", () => {
  const USER_ID = liveDbId();
  const ACME_BOARD_ID = liveDbId();
  const GLOBEX_BOARD_ID = liveDbId();

  // See the header: a platform name nothing else in the suite can write to.
  const SUFFIX = liveDbId().slice(0, 8);
  const ALPHA = `rollup-alpha-${SUFFIX}`;
  const BETA = `rollup-beta-${SUFFIX}`;

  const sql = postgres(liveDbUrl, { prepare: false, max: 4, onnotice: () => {} });
  const database = drizzle(sql, { schema });

  const jobIds: string[] = [];
  const applicationIds: string[] = [];

  const insertJob = async (ats: string, boardId: string) => {
    const id = liveDbId();
    await sql`
      insert into public.jobs (id, board_id, ats, external_id, title, url)
      values (${id}, ${boardId}, ${ats}, ${`rollup-${id}`}, 'SWE Intern',
              ${`https://boards.example.com/${id}`})`;
    jobIds.push(id);
    return id;
  };

  const insertApplication = async (jobId: string, status: string, hoursAgo = 1) => {
    const id = liveDbId();
    await sql`
      insert into public.applications (id, user_id, job_id, status, created_at)
      values (${id}, ${USER_ID}, ${jobId}, ${status}, now() - ${`${hoursAgo} hours`}::interval)`;
    applicationIds.push(id);
    return id;
  };

  const insertSkip = async (input: {
    jobId: string;
    ats: string;
    reason: string;
    applicationId?: string | null;
    fieldLabel?: string | null;
    fieldKind?: string | null;
    daysAgo?: number;
  }) => {
    await sql`
      insert into public.skip_log
        (id, application_id, job_id, ats, reason, field_label, field_kind, created_at)
      values (${liveDbId()}, ${input.applicationId ?? null}, ${input.jobId}, ${input.ats},
              ${input.reason}, ${input.fieldLabel ?? null}, ${input.fieldKind ?? null},
              now() - ${`${input.daysAgo ?? 0} days`}::interval - '1 hour'::interval)`;
  };

  beforeAll(async () => {
    await sql`insert into auth.users (id, email) values (${USER_ID}, 'rollup@example.com')`;
    await sql`
      insert into public.profiles (id, email, attested_at, applications_cap)
      values (${USER_ID}, 'rollup@example.com', now(), 50)`;
    await sql`
      insert into public.boards (id, ats, company, board_token)
      values (${ACME_BOARD_ID}, ${ALPHA}, 'Acme Robotics', ${`acme-${SUFFIX}`})`;
    await sql`
      insert into public.boards (id, ats, company, board_token)
      values (${GLOBEX_BOARD_ID}, ${BETA}, 'Globex', ${`globex-${SUFFIX}`})`;

    // ── ALPHA: four attempts, one of them submitted, three skips ────────────
    const alphaJobs = [
      await insertJob(ALPHA, ACME_BOARD_ID),
      await insertJob(ALPHA, ACME_BOARD_ID),
      await insertJob(ALPHA, ACME_BOARD_ID),
      await insertJob(ALPHA, ACME_BOARD_ID),
    ];
    await insertApplication(alphaJobs[0], APPLICATION_STATUS.SUBMITTED);
    const blocked = await insertApplication(alphaJobs[1], APPLICATION_STATUS.FORM_FILL_BLOCKED);
    const stuck = await insertApplication(alphaJobs[2], APPLICATION_STATUS.ERROR);
    await insertApplication(alphaJobs[3], APPLICATION_STATUS.SUBMISSION_UNCONFIRMED);

    await insertSkip({ jobId: alphaJobs[1], ats: ALPHA, reason: "dom_changed", applicationId: blocked });
    await insertSkip({ jobId: alphaJobs[2], ats: ALPHA, reason: "dom_changed", applicationId: stuck });
    await insertSkip({
      jobId: alphaJobs[1],
      ats: ALPHA,
      reason: "unanswerable_required",
      applicationId: blocked,
      fieldLabel: "Desired salary",
      fieldKind: "text",
    });

    // Older than any window this suite asks for, except the one that asks for it.
    await insertSkip({ jobId: alphaJobs[0], ats: ALPHA, reason: "timeout", daysAgo: 30 });

    // ── BETA: skips only, and one of them owned by nobody ───────────────────
    const betaJob = await insertJob(BETA, GLOBEX_BOARD_ID);
    // `application_id` null is the row no end user can ever read: the RLS policy
    // grants a select through the owning application and there is no owning
    // application. This rollup is the only thing that will ever see it.
    await insertSkip({ jobId: betaJob, ats: BETA, reason: "captcha", applicationId: null });
    await insertSkip({
      jobId: betaJob,
      ats: BETA,
      reason: "unanswerable_required",
      applicationId: null,
      fieldLabel: "Desired salary",
      fieldKind: "text",
    });
    // A labelled field on a skip that is not `unanswerable_required`. The
    // questions list is about answers the intake could not supply, not about
    // every field a stopped run happened to be looking at.
    await insertSkip({
      jobId: betaJob,
      ats: BETA,
      reason: "dom_changed",
      applicationId: null,
      fieldLabel: "Cover letter",
      fieldKind: "textarea",
    });
  });

  afterAll(async () => {
    if (jobIds.length > 0) {
      await sql`delete from public.skip_log where job_id = any(${sql.array(jobIds)}::uuid[])`;
      await sql`delete from public.applications where id = any(${sql.array(applicationIds)}::uuid[])`;
      await sql`delete from public.jobs where id = any(${sql.array(jobIds)}::uuid[])`;
    }
    await sql`delete from public.boards where id = any(${sql.array([ACME_BOARD_ID, GLOBEX_BOARD_ID])}::uuid[])`;
    await sql`delete from public.profiles where id = ${USER_ID}`;
    await sql`delete from auth.users where id = ${USER_ID}`;
    await sql.end({ timeout: 5 });
  });

  const platform = async (ats: string, days = 7) => {
    const rollup = await loadSkipRollup({ days, database });
    return { rollup, row: rollup.byPlatform.find((entry) => entry.ats === ats) };
  };

  it("counts each platform's skips against the attempts that platform got", async () => {
    const { row } = await platform(ALPHA);

    expect(row).toBeDefined();
    expect(row?.attempts).toBe(4);
    expect(row?.submitted).toBe(1);
    expect(row?.unconfirmed).toBe(1);
    // Three skips inside the window; the fourth is thirty days old.
    expect(row?.skips).toBe(3);
    // The denominator is the attempts, not the skips: three of four, not one.
    expect(row?.skipsPerAttempt).toBe(0.75);
    expect(row?.submitRate).toBe(0.25);
    expect(row?.byReason).toEqual([
      { reason: "dom_changed", skips: 2 },
      { reason: "unanswerable_required", skips: 1 },
    ]);
  });

  it("counts a skip that has no application row, which no user can see", async () => {
    const { row } = await platform(BETA);

    // All three BETA skips carry a null `application_id`, so every one of them
    // is invisible to `skip_log_select_via_own_application`.
    expect(row?.skips).toBe(3);
    expect(row?.byReason).toEqual([
      { reason: "captcha", skips: 1 },
      { reason: "dom_changed", skips: 1 },
      { reason: "unanswerable_required", skips: 1 },
    ]);
  });

  it("reports no rate rather than a rate of zero when nothing was attempted", async () => {
    const { row } = await platform(BETA);

    // Three skips and no attempts. A rate of zero would say the opposite.
    expect(row?.attempts).toBe(0);
    expect(row?.skipsPerAttempt).toBeNull();
    expect(row?.submitRate).toBeNull();
  });

  it("leaves out everything older than the window, and finds it in a longer one", async () => {
    const recent = await platform(ALPHA, 7);
    expect(recent.row?.byReason.map((entry) => entry.reason)).not.toContain("timeout");

    const wider = await platform(ALPHA, 60);
    expect(wider.row?.skips).toBe(4);
    expect(wider.row?.byReason).toContainEqual({ reason: "timeout", skips: 1 });
  });

  it("names the company behind the skips and not only the platform", async () => {
    const { rollup } = await platform(ALPHA);

    // `skip_log` denormalizes the platform and not the company, so this only
    // works through the join to `jobs` and on to `boards`.
    expect(rollup.topBoards).toContainEqual({ ats: ALPHA, company: "Acme Robotics", skips: 3 });
    expect(rollup.topBoards).toContainEqual({ ats: BETA, company: "Globex", skips: 3 });
  });

  it("groups the unanswered questions by label, and only the unanswerable ones", async () => {
    const { rollup } = await platform(ALPHA);
    const ours = rollup.unansweredQuestions.filter((entry) => entry.ats === ALPHA || entry.ats === BETA);

    // One "Desired salary" on each platform, and the labelled `dom_changed` row
    // on BETA is not a question anybody failed to answer.
    expect(ours).toContainEqual({
      ats: ALPHA,
      company: "Acme Robotics",
      fieldLabel: "Desired salary",
      fieldKind: "text",
      asked: 1,
    });
    expect(ours).toContainEqual({
      ats: BETA,
      company: "Globex",
      fieldLabel: "Desired salary",
      fieldKind: "text",
      asked: 1,
    });
    expect(ours.map((entry) => entry.fieldLabel)).not.toContain("Cover letter");
  });

  it("adds up site wide, over at least the rows this file wrote", async () => {
    const { rollup } = await platform(ALPHA);

    // A floor rather than an equality: other suites write real `skip_log` rows
    // into the same database at the same time. See the header.
    expect(rollup.totalSkips).toBeGreaterThanOrEqual(6);
    expect(rollup.totalAttempts).toBeGreaterThanOrEqual(4);
    expect(rollup.totalSubmitted).toBeGreaterThanOrEqual(1);
    expect(rollup.byReason.find((entry) => entry.reason === "dom_changed")?.skips).toBeGreaterThanOrEqual(3);
    // Descending, which is the whole point of the list.
    const counts = rollup.byReason.map((entry) => entry.skips);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });
});
