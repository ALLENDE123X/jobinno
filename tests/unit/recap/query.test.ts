// @vitest-environment node
/**
 * JOB-329's candidate query, against a real Postgres.
 *
 * Same reasoning as `tests/unit/reengagement/query.test.ts` for being live
 * and gated: `listRecapCandidates` is one SQL statement, and the three
 * properties this ticket actually turns on are all properties of that
 * statement: that the 12 hour submission window really excludes a row that
 * fell out of it, that the count threshold really excludes a profile with
 * only one submission, and that the 20 hour rate limit stamp really makes
 * a second run within the window a no op. `tests/live-db-gate.ts` decides
 * whether this runs at all, and every id here is minted fresh per run so
 * cleanup can only ever delete rows this file created.
 *
 * Why the module is imported the way it is
 *   `inngest/recap-cron.ts` imports its Inngest client from
 *   `job-application-pipeline.ts`, whose module graph reaches Stagehand and
 *   the Supabase project guard, neither of which can resolve or run outside
 *   a real deployment. `tests/unit/reengagement/query.test.ts` mocks both in
 *   the same way for the same reason.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/lib/db/schema";

import { liveDbId, liveDbSuite, liveDbUrl } from "../../live-db-gate";

vi.mock("@/lib/stagehand-session", () => ({
  NAVIGATION_TIMEOUT_MS: 30_000,
  browserConcurrencyLimit: () => 2,
  openBrowserSession: async () => {
    throw new Error("no browser in this test");
  },
  closeBrowserSession: async () => undefined,
  typeInto: async () => ({ selector: "", description: "" }),
  tryResolveAction: async () => null,
  clickControl: async () => null,
  describeControl: async () => ({ found: false }),
  observeOnce: async () => [],
  uploadFile: async () => undefined,
}));

vi.mock("@/lib/supabase-project-guard", () => ({ assertSupabaseProject: () => undefined }));

// Dev mode, so constructing the Inngest client needs no real signing key.
// See `inngest/load-env.ts` for why this has to be set before the imports
// below.
process.env.INNGEST_DEV = "1";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const {
  listRecapCandidates,
  listRecapSubmissions,
  claimRecapSend,
  RECAP_SUBMISSION_WINDOW_HOURS,
  RECAP_RATE_LIMIT_HOURS,
  RECAP_MIN_SUBMISSIONS,
  RECAP_BATCH_LIMIT,
} = await import("@/inngest/recap-cron");

liveDbSuite("the morning recap candidate query", () => {
  const sql = postgres(liveDbUrl, { prepare: false, max: 4, onnotice: () => {} });
  const database = drizzle(sql, { schema });

  const userIds: string[] = [];
  const jobIds: string[] = [];
  const boardIds: string[] = [];
  const appIds: string[] = [];

  const insertProfile = async (input: {
    plan?: "free" | "starter" | "season_pass";
    applicationsUsed?: number;
    applicationsCap?: number;
    recapEmailLastSentAt?: Date | null;
  } = {}) => {
    const id = liveDbId();
    const email = `${id}@example.test`;
    await sql`insert into auth.users (id, email) values (${id}, ${email})`;
    await sql`
      insert into public.profiles (
        id, email, plan, applications_used, applications_cap,
        recap_email_last_sent_at
      ) values (
        ${id}, ${email},
        ${input.plan ?? "free"},
        ${input.applicationsUsed ?? 0},
        ${input.applicationsCap ?? 3},
        ${input.recapEmailLastSentAt ? input.recapEmailLastSentAt.toISOString() : null}
      )`;
    userIds.push(id);
    return { id, email };
  };

  const insertBoard = async (company: string) => {
    const id = liveDbId();
    await sql`
      insert into public.boards (id, ats, company, board_token, active)
      values (${id}, 'greenhouse', ${company}, ${`token-${id}`}, true)`;
    boardIds.push(id);
    return id;
  };

  const insertJob = async (boardId: string, title: string) => {
    const id = liveDbId();
    await sql`
      insert into public.jobs (id, board_id, ats, external_id, title, url)
      values (${id}, ${boardId}, 'greenhouse', ${`ext-${id}`}, ${title}, ${`https://example.test/${id}`})`;
    jobIds.push(id);
    return id;
  };

  const insertApplication = async (input: {
    userId: string;
    jobId: string;
    status: string;
    submittedAt: Date | null;
  }) => {
    const id = liveDbId();
    await sql`
      insert into public.applications (id, user_id, job_id, status, submitted_at)
      values (
        ${id}, ${input.userId}, ${input.jobId}, ${input.status},
        ${input.submittedAt ? input.submittedAt.toISOString() : null}
      )`;
    appIds.push(id);
    return id;
  };

  /**
   * Every test in this file shares one Postgres, and the 12 hour
   * submission window plus the 20 hour rate limit window overlap by
   * construction. Without clearing between tests, a row one test inserted
   * would still be inside the window a later test queries and could
   * change which profiles show up.
   */
  afterEach(async () => {
    if (appIds.length > 0) {
      await sql`delete from public.applications where id = any(${sql.array(appIds)}::uuid[])`;
      appIds.length = 0;
    }
    if (jobIds.length > 0) {
      await sql`delete from public.jobs where id = any(${sql.array(jobIds)}::uuid[])`;
      jobIds.length = 0;
    }
    if (boardIds.length > 0) {
      await sql`delete from public.boards where id = any(${sql.array(boardIds)}::uuid[])`;
      boardIds.length = 0;
    }
    if (userIds.length > 0) {
      await sql`delete from public.profiles where id = any(${sql.array(userIds)}::uuid[])`;
      await sql`delete from auth.users where id = any(${sql.array(userIds)}::uuid[])`;
      userIds.length = 0;
    }
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  const NOW = new Date("2026-08-31T14:00:00Z");
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

  it("has the windows, threshold, and batch limit the ticket names", () => {
    expect(RECAP_SUBMISSION_WINDOW_HOURS).toBe(12);
    expect(RECAP_RATE_LIMIT_HOURS).toBe(20);
    expect(RECAP_MIN_SUBMISSIONS).toBe(2);
    expect(RECAP_BATCH_LIMIT).toBe(50);
  });

  describe("the count threshold", () => {
    it("includes a profile with exactly two overnight submissions", async () => {
      const profile = await insertProfile();
      const boardId = await insertBoard("Acme");
      const jobA = await insertJob(boardId, "Backend Intern");
      const jobB = await insertJob(boardId, "Frontend Intern");
      await insertApplication({ userId: profile.id, jobId: jobA, status: "submitted", submittedAt: hoursAgo(6) });
      await insertApplication({ userId: profile.id, jobId: jobB, status: "submitted", submittedAt: hoursAgo(4) });

      const rows = await listRecapCandidates(database, NOW);
      const match = rows.find((r) => r.id === profile.id);
      expect(match).toBeDefined();
      expect(match?.submissionCount).toBe(2);
    });

    it("excludes a profile with only one overnight submission", async () => {
      const profile = await insertProfile();
      const boardId = await insertBoard("Acme");
      const jobA = await insertJob(boardId, "Backend Intern");
      await insertApplication({ userId: profile.id, jobId: jobA, status: "submitted", submittedAt: hoursAgo(6) });

      const rows = await listRecapCandidates(database, NOW);
      expect(rows.map((r) => r.id)).not.toContain(profile.id);
    });

    it("only counts rows in status=submitted, not other statuses", async () => {
      const profile = await insertProfile();
      const boardId = await insertBoard("Acme");
      const jobA = await insertJob(boardId, "Backend Intern");
      const jobB = await insertJob(boardId, "Frontend Intern");
      const jobC = await insertJob(boardId, "Data Intern");
      await insertApplication({ userId: profile.id, jobId: jobA, status: "submitted", submittedAt: hoursAgo(6) });
      // These two are recent but not `submitted`, so they must not push the
      // profile over the count threshold on their own.
      await insertApplication({ userId: profile.id, jobId: jobB, status: "form_fill_blocked", submittedAt: hoursAgo(5) });
      await insertApplication({ userId: profile.id, jobId: jobC, status: "submission_unconfirmed", submittedAt: hoursAgo(4) });

      const rows = await listRecapCandidates(database, NOW);
      expect(rows.map((r) => r.id)).not.toContain(profile.id);
    });
  });

  describe("the submission window", () => {
    it("excludes a submission that landed more than 12 hours ago", async () => {
      const profile = await insertProfile();
      const boardId = await insertBoard("Acme");
      const jobA = await insertJob(boardId, "Backend Intern");
      const jobB = await insertJob(boardId, "Frontend Intern");
      // One inside the window, one outside. Only one counts, so the count
      // threshold refuses this profile.
      await insertApplication({ userId: profile.id, jobId: jobA, status: "submitted", submittedAt: hoursAgo(6) });
      await insertApplication({ userId: profile.id, jobId: jobB, status: "submitted", submittedAt: hoursAgo(14) });

      const rows = await listRecapCandidates(database, NOW);
      expect(rows.map((r) => r.id)).not.toContain(profile.id);
    });
  });

  describe("the 20 hour rate limit stamp", () => {
    it("excludes a profile whose stamp is inside the 20 hour window", async () => {
      const profile = await insertProfile({ recapEmailLastSentAt: hoursAgo(5) });
      const boardId = await insertBoard("Acme");
      const jobA = await insertJob(boardId, "Backend Intern");
      const jobB = await insertJob(boardId, "Frontend Intern");
      await insertApplication({ userId: profile.id, jobId: jobA, status: "submitted", submittedAt: hoursAgo(6) });
      await insertApplication({ userId: profile.id, jobId: jobB, status: "submitted", submittedAt: hoursAgo(4) });

      const rows = await listRecapCandidates(database, NOW);
      expect(rows.map((r) => r.id)).not.toContain(profile.id);
    });

    it("includes a profile whose stamp is older than 20 hours", async () => {
      const profile = await insertProfile({ recapEmailLastSentAt: hoursAgo(21) });
      const boardId = await insertBoard("Acme");
      const jobA = await insertJob(boardId, "Backend Intern");
      const jobB = await insertJob(boardId, "Frontend Intern");
      await insertApplication({ userId: profile.id, jobId: jobA, status: "submitted", submittedAt: hoursAgo(6) });
      await insertApplication({ userId: profile.id, jobId: jobB, status: "submitted", submittedAt: hoursAgo(4) });

      const rows = await listRecapCandidates(database, NOW);
      expect(rows.map((r) => r.id)).toContain(profile.id);
    });
  });

  it("carries the profile fields the template needs (plan, used, cap)", async () => {
    const profile = await insertProfile({
      plan: "starter",
      applicationsUsed: 12,
      applicationsCap: 150,
    });
    const boardId = await insertBoard("Acme");
    const jobA = await insertJob(boardId, "Backend Intern");
    const jobB = await insertJob(boardId, "Frontend Intern");
    await insertApplication({ userId: profile.id, jobId: jobA, status: "submitted", submittedAt: hoursAgo(6) });
    await insertApplication({ userId: profile.id, jobId: jobB, status: "submitted", submittedAt: hoursAgo(4) });

    const rows = await listRecapCandidates(database, NOW);
    const match = rows.find((r) => r.id === profile.id);
    expect(match?.plan).toBe("starter");
    expect(match?.applicationsUsed).toBe(12);
    expect(match?.applicationsCap).toBe(150);
  });

  describe("listRecapSubmissions", () => {
    it("returns company, role and submittedAt for every overnight submission", async () => {
      const profile = await insertProfile();
      const boardA = await insertBoard("Acme");
      const boardB = await insertBoard("Globex");
      const jobA = await insertJob(boardA, "Backend Intern");
      const jobB = await insertJob(boardB, "Frontend New Grad");
      await insertApplication({ userId: profile.id, jobId: jobA, status: "submitted", submittedAt: hoursAgo(6) });
      await insertApplication({ userId: profile.id, jobId: jobB, status: "submitted", submittedAt: hoursAgo(4) });

      const submissions = await listRecapSubmissions(database, profile.id, NOW);
      expect(submissions).toHaveLength(2);
      const companies = submissions.map((s) => s.company);
      expect(companies).toContain("Acme");
      expect(companies).toContain("Globex");
    });

    it("excludes a submission outside the 12 hour window", async () => {
      const profile = await insertProfile();
      const boardId = await insertBoard("Acme");
      const jobA = await insertJob(boardId, "Backend Intern");
      const jobB = await insertJob(boardId, "Frontend Intern");
      await insertApplication({ userId: profile.id, jobId: jobA, status: "submitted", submittedAt: hoursAgo(6) });
      await insertApplication({ userId: profile.id, jobId: jobB, status: "submitted", submittedAt: hoursAgo(20) });

      const submissions = await listRecapSubmissions(database, profile.id, NOW);
      expect(submissions).toHaveLength(1);
    });
  });

  describe("claimRecapSend", () => {
    it("claims a still eligible profile and stamps it", async () => {
      const profile = await insertProfile();

      const claimed = await claimRecapSend(database, profile.id, NOW);
      expect(claimed).toEqual({ id: profile.id, email: profile.email });

      const [row] = await sql`select recap_email_last_sent_at from public.profiles where id = ${profile.id}`;
      expect(row.recap_email_last_sent_at).not.toBeNull();
    });

    it("refuses to claim a profile stamped inside the rate limit window", async () => {
      const profile = await insertProfile({ recapEmailLastSentAt: hoursAgo(5) });

      const claimed = await claimRecapSend(database, profile.id, NOW);
      expect(claimed).toBeNull();
    });

    it("does claim a profile stamped outside the rate limit window", async () => {
      const profile = await insertProfile({ recapEmailLastSentAt: hoursAgo(25) });

      const claimed = await claimRecapSend(database, profile.id, NOW);
      expect(claimed).toEqual({ id: profile.id, email: profile.email });
    });

    it("lets only the first of two racing claims on the same profile through", async () => {
      // Same TOCTOU scenario `tests/unit/reengagement/query.test.ts`
      // exercises for `claimReEngagementSend`: two overlapping attempts to
      // claim the same profile must let exactly one through, or the cron
      // would send the recap twice.
      const profile = await insertProfile();

      const [first, second] = await Promise.all([
        claimRecapSend(database, profile.id, NOW),
        claimRecapSend(database, profile.id, NOW),
      ]);

      const winners = [first, second].filter((claim) => claim !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toEqual({ id: profile.id, email: profile.email });
    });
  });
});
