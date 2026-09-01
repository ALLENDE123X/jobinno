// @vitest-environment node
/**
 * JOB-311's candidate query, against a real Postgres.
 *
 * ── Why this is live and not faked ───────────────────────────────────────
 * `listReEngagementCandidates` is one SQL statement, and the three properties
 * this ticket actually turns on are all properties of that statement: that
 * the two sided window on `created_at` really excludes a profile just outside
 * either edge, that `attested_at IS NULL` really excludes somebody who
 * finished intake, and that `re_engagement_sent_at IS NULL` really makes a
 * second run a no op once the first has stamped a row. The same reasoning
 * `tests/unit/job-matching.test.ts` gives for being live applies unchanged,
 * including the gate: `tests/live-db-gate.ts` decides whether this runs at
 * all, and every id here is minted fresh per run so cleanup can only ever
 * delete rows this file created.
 *
 * ── Why the module is imported the way it is ─────────────────────────────
 * `inngest/reengagement-cron.ts` imports its Inngest client from
 * `job-application-pipeline.ts`, whose module graph reaches Stagehand and the
 * Supabase project guard, neither of which can resolve or run outside a real
 * deployment. `tests/unit/inngest-function-config.test.ts` stands both in the
 * same way for the same reason; this file does the same rather than inventing
 * a second pattern.
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

// Dev mode, so constructing the Inngest client needs no real signing key. See
// `inngest/load-env.ts` for why this has to be set before the imports below.
process.env.INNGEST_DEV = "1";
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const {
  listReEngagementCandidates,
  claimReEngagementSend,
  releaseReEngagementSlot,
  REENGAGEMENT_WINDOW_MIN_HOURS,
  REENGAGEMENT_WINDOW_MAX_DAYS,
  REENGAGEMENT_BATCH_LIMIT,
  REENGAGEMENT_MAX_SEND_FAILURES,
} = await import("@/inngest/reengagement-cron");

liveDbSuite("the re engagement candidate query", () => {
  const sql = postgres(liveDbUrl, { prepare: false, max: 4, onnotice: () => {} });
  const database = drizzle(sql, { schema });

  const userIds: string[] = [];

  /**
   * One profile, backdated to `createdAt` and otherwise defaulted to the
   * shape a fresh, unattested, never emailed signup actually has: no
   * attestation, no prior send.
   */
  const insertProfile = async (input: {
    createdAt: Date;
    attested?: boolean;
    reEngagementSentAt?: Date | null;
  }) => {
    const id = liveDbId();
    const email = `${id}@example.com`;
    await sql`insert into auth.users (id, email) values (${id}, ${email})`;
    await sql`
      insert into public.profiles (id, email, created_at, attested_at, re_engagement_sent_at)
      values (
        ${id}, ${email}, ${input.createdAt.toISOString()},
        ${input.attested ? input.createdAt.toISOString() : null},
        ${input.reEngagementSentAt ? input.reEngagementSentAt.toISOString() : null}
      )`;
    userIds.push(id);
    return { id, email };
  };

  /**
   * Every test in this file shares one Postgres, and `created_at` windows
   * three days, seven days and one hour wide overlap by construction. Without
   * clearing between tests, a row one test inserted would still be inside the
   * window a later test queries and would silently change which row is
   * oldest, which is exactly what the last test below depends on. So cleanup
   * runs after every test rather than only at the end.
   */
  afterEach(async () => {
    if (userIds.length > 0) {
      await sql`delete from public.profiles where id = any(${sql.array(userIds)}::uuid[])`;
      await sql`delete from auth.users where id = any(${sql.array(userIds)}::uuid[])`;
      userIds.length = 0;
    }
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  const NOW = new Date("2026-08-31T22:00:00Z");
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  const daysAgo = (days: number) => hoursAgo(days * 24);

  it("has the window and the batch limit the ticket names", () => {
    expect(REENGAGEMENT_WINDOW_MIN_HOURS).toBe(24);
    expect(REENGAGEMENT_WINDOW_MAX_DAYS).toBe(7);
    expect(REENGAGEMENT_BATCH_LIMIT).toBe(50);
    // JOB-321: bounded automatic retry before the row is left terminally
    // send failed. See `REENGAGEMENT_MAX_SEND_FAILURES`' own docstring for
    // why three.
    expect(REENGAGEMENT_MAX_SEND_FAILURES).toBe(3);
  });

  describe("the two sided window on created_at", () => {
    it("includes a profile squarely inside the window", async () => {
      const { id } = await insertProfile({ createdAt: daysAgo(3) });
      const rows = await listReEngagementCandidates(database, NOW);
      expect(rows.map((row) => row.id)).toContain(id);
    });

    it("includes a profile exactly on the 24 hour edge", async () => {
      // BETWEEN is inclusive on both ends, and this is the boundary the
      // ticket's own SQL names: `created_at BETWEEN now() - 7 days AND
      // now() - 24 hours`.
      const { id } = await insertProfile({ createdAt: hoursAgo(24) });
      const rows = await listReEngagementCandidates(database, NOW);
      expect(rows.map((row) => row.id)).toContain(id);
    });

    it("includes a profile exactly on the 7 day edge", async () => {
      const { id } = await insertProfile({ createdAt: daysAgo(7) });
      const rows = await listReEngagementCandidates(database, NOW);
      expect(rows.map((row) => row.id)).toContain(id);
    });

    it("excludes a profile that signed up less than 24 hours ago", async () => {
      const { id } = await insertProfile({ createdAt: hoursAgo(23) });
      const rows = await listReEngagementCandidates(database, NOW);
      expect(rows.map((row) => row.id)).not.toContain(id);
    });

    it("excludes a profile older than 7 days", async () => {
      const { id } = await insertProfile({ createdAt: daysAgo(8) });
      const rows = await listReEngagementCandidates(database, NOW);
      expect(rows.map((row) => row.id)).not.toContain(id);
    });
  });

  it("excludes a profile that already attested", async () => {
    const { id } = await insertProfile({ createdAt: daysAgo(3), attested: true });
    const rows = await listReEngagementCandidates(database, NOW);
    expect(rows.map((row) => row.id)).not.toContain(id);
  });

  it("excludes a profile already stamped, which is the whole of the idempotency guard", async () => {
    const { id } = await insertProfile({
      createdAt: daysAgo(3),
      reEngagementSentAt: hoursAgo(1),
    });
    const rows = await listReEngagementCandidates(database, NOW);
    expect(rows.map((row) => row.id)).not.toContain(id);

    // The scenario the ticket's acceptance check actually is: a second cron
    // run against the same candidate, after the first stamped it, sends
    // nothing.
    const second = await listReEngagementCandidates(database, NOW);
    expect(second.map((row) => row.id)).not.toContain(id);
  });

  it("orders the oldest signup first", async () => {
    // Asserted as a relative position rather than as "index 0": Vitest runs
    // test files against one shared database, and another suite's own
    // unattested, never emailed fixture could legitimately be older than
    // both of these and sort ahead of them without this test being wrong
    // about anything. What has to be true regardless of that noise is that
    // between these two, the older one comes first.
    const older = await insertProfile({ createdAt: daysAgo(5) });
    const newer = await insertProfile({ createdAt: daysAgo(2) });

    const rows = await listReEngagementCandidates(database, NOW, 1000);
    const ids = rows.map((row) => row.id);
    expect(ids.indexOf(older.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(newer.id)).toBeGreaterThan(ids.indexOf(older.id));
  });

  it("caps the result at the given limit", async () => {
    await insertProfile({ createdAt: daysAgo(5) });
    await insertProfile({ createdAt: daysAgo(2) });

    const rows = await listReEngagementCandidates(database, NOW, 1);
    expect(rows).toHaveLength(1);
  });

  /**
   * JOB-311 red team MAJOR 1 and MAJOR 2: `claimReEngagementSend` is the
   * conditional atomic claim that closes the stale eligibility race
   * `listReEngagementCandidates` alone cannot close, since a candidate list
   * read once at the top of the run can go stale (attestation, a concurrent
   * run's own claim) before a send actually happens. These tests exercise
   * the claim directly against a real database rather than through the
   * Inngest step that calls it, the same reasoning the module gives for
   * exporting it in the first place.
   */
  describe("claimReEngagementSend", () => {
    it("claims a still eligible profile and stamps it", async () => {
      const { id, email } = await insertProfile({ createdAt: daysAgo(3) });

      const claimed = await claimReEngagementSend(database, id, NOW);
      expect(claimed).toEqual({ id, email });

      const [row] = await sql`select re_engagement_sent_at from public.profiles where id = ${id}`;
      expect(row.re_engagement_sent_at).not.toBeNull();
    });

    it("refuses to claim a profile that has already attested", async () => {
      const { id } = await insertProfile({ createdAt: daysAgo(3), attested: true });

      const claimed = await claimReEngagementSend(database, id, NOW);
      expect(claimed).toBeNull();
    });

    it("refuses to claim a profile that is already stamped", async () => {
      const { id } = await insertProfile({ createdAt: daysAgo(3), reEngagementSentAt: hoursAgo(1) });

      const claimed = await claimReEngagementSend(database, id, NOW);
      expect(claimed).toBeNull();
    });

    it("lets only the first of two racing claims on the same profile through", async () => {
      // This is the TOCTOU scenario itself: two overlapping attempts to claim
      // the same profile, exactly what two overlapping cron runs (or a run
      // racing an attestation that lands mid run) would do. Only one may
      // succeed, and the loser has to come back `null` rather than a second
      // copy of the claim, or this cron would send the email twice.
      const { id, email } = await insertProfile({ createdAt: daysAgo(3) });

      const [first, second] = await Promise.all([
        claimReEngagementSend(database, id, NOW),
        claimReEngagementSend(database, id, NOW),
      ]);

      const winners = [first, second].filter((claim) => claim !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toEqual({ id, email });
    });

    it("does not affect a different profile's eligibility", async () => {
      const claimedProfile = await insertProfile({ createdAt: daysAgo(3) });
      const other = await insertProfile({ createdAt: daysAgo(2) });

      await claimReEngagementSend(database, claimedProfile.id, NOW);

      const rows = await listReEngagementCandidates(database, NOW);
      expect(rows.map((row) => row.id)).not.toContain(claimedProfile.id);
      expect(rows.map((row) => row.id)).toContain(other.id);
    });
  });

  /**
   * JOB-321: the compensating half of `claimReEngagementSend`. Pre-JOB-321
   * a Resend failure after a successful claim left the row stamped and the
   * candidate silently never got the email — a rotated key, a transient
   * 5xx and a bounced address all looked identical to a successful send at
   * the database level. `releaseReEngagementSlot` unstamps the row on the
   * same UPDATE that increments the failure counter, so the next hourly
   * run picks the candidate up again, up to `REENGAGEMENT_MAX_SEND_FAILURES`.
   * Beyond the cap the stamp stays and the counter records why.
   *
   * These tests hit the release function directly against a real database
   * rather than through the Inngest step that calls it, the same reasoning
   * `claimReEngagementSend`'s tests above give for exporting it in the
   * first place.
   */
  describe("releaseReEngagementSlot", () => {
    /** Claims a profile the way the cron would, so the release path is exercised on a real "just claimed" row. */
    const claimFresh = async (createdAt: Date) => {
      const profile = await insertProfile({ createdAt });
      const claimed = await claimReEngagementSend(database, profile.id, NOW);
      expect(claimed).not.toBeNull();
      return profile;
    };

    it("unstamps the row and returns the candidate to the next run below the cap", async () => {
      const { id } = await claimFresh(daysAgo(3));

      const outcome = await releaseReEngagementSlot(database, id);

      expect(outcome).toEqual({ released: true, failures: 1, terminal: false });

      // The row is unstamped, so the next hourly run's list step picks it
      // up again — the whole of the property this ticket exists to add.
      const rows = await listReEngagementCandidates(database, NOW);
      expect(rows.map((row) => row.id)).toContain(id);

      const [row] = await sql`
        select re_engagement_sent_at, re_engagement_send_failures
        from public.profiles where id = ${id}`;
      expect(row.re_engagement_sent_at).toBeNull();
      expect(Number(row.re_engagement_send_failures)).toBe(1);
    });

    it("leaves the stamp on the row once the failure counter reaches the cap", async () => {
      const { id } = await claimFresh(daysAgo(3));

      const first = await releaseReEngagementSlot(database, id);
      expect(first).toEqual({ released: true, failures: 1, terminal: false });

      // Re-claim to simulate the next hourly run getting there, then fail
      // again. The cron itself would re-run `claimReEngagementSend` before
      // each send attempt, so the second and third failures are exercised
      // through that same door.
      await claimReEngagementSend(database, id, NOW);
      const second = await releaseReEngagementSlot(database, id);
      expect(second).toEqual({ released: true, failures: 2, terminal: false });

      await claimReEngagementSend(database, id, NOW);
      const third = await releaseReEngagementSlot(database, id);
      expect(third).toEqual({ released: false, failures: 3, terminal: true });

      // Stamp survived: `listReEngagementCandidates` refuses this candidate
      // for good, and the counter records why on the row itself.
      const rows = await listReEngagementCandidates(database, NOW);
      expect(rows.map((row) => row.id)).not.toContain(id);

      const [row] = await sql`
        select re_engagement_sent_at, re_engagement_send_failures
        from public.profiles where id = ${id}`;
      expect(row.re_engagement_sent_at).not.toBeNull();
      expect(Number(row.re_engagement_send_failures)).toBe(3);
    });

    it("respects an injected lower cap so the terminal state is testable without three round trips", async () => {
      // The production cap is three (see `REENGAGEMENT_MAX_SEND_FAILURES`),
      // and the test above walks the row through all three; this one pins
      // the cap to one so the terminal branch is exercised on the very
      // first release call without depending on the production constant.
      const { id } = await claimFresh(daysAgo(3));

      const outcome = await releaseReEngagementSlot(database, id, 1);

      expect(outcome).toEqual({ released: false, failures: 1, terminal: true });

      const [row] = await sql`
        select re_engagement_sent_at, re_engagement_send_failures
        from public.profiles where id = ${id}`;
      expect(row.re_engagement_sent_at).not.toBeNull();
      expect(Number(row.re_engagement_send_failures)).toBe(1);
    });

    it("reports no_profile when the id does not exist rather than throwing", async () => {
      // The cron gets ids from `list-candidates` in the same run so this
      // path is a bug rather than an operating condition, but the function
      // still has to return a shape the caller's log branch can read
      // rather than throw a whole batch of sends over one missing row.
      const outcome = await releaseReEngagementSlot(database, liveDbId());

      expect(outcome).toEqual({
        released: false,
        failures: 0,
        terminal: false,
        reason: "no_profile",
      });
    });

    it("does not affect a different profile's counter or stamp", async () => {
      const releasing = await claimFresh(daysAgo(3));
      const bystander = await claimFresh(daysAgo(2));

      await releaseReEngagementSlot(database, releasing.id);

      const [bystanderRow] = await sql`
        select re_engagement_sent_at, re_engagement_send_failures
        from public.profiles where id = ${bystander.id}`;
      expect(bystanderRow.re_engagement_sent_at).not.toBeNull();
      expect(Number(bystanderRow.re_engagement_send_failures)).toBe(0);
    });
  });
});
