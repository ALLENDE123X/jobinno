// @vitest-environment node
/**
 * The allowance counter, against a real Postgres and under real concurrency.
 *
 * ── Why this suite is live and not faked ────────────────────────────────────
 * There is nothing in `lib/application-quota.ts` but two SQL statements. A fake
 * database would be asserting that the module builds the query the test also
 * builds, which is a tautology, and it would say nothing at all about the only
 * property that matters: that two statements racing for the last slot cannot
 * both win. That is a claim about Postgres' row locking under `READ COMMITTED`,
 * and the only thing that can settle it is Postgres.
 *
 * So `applies exactly the cap under concurrent pressure` below fires twenty
 * simultaneous reservations at a cap of five, across a pool wide enough for
 * them to be genuinely simultaneous, and asserts that exactly five come back
 * reserved holding the five distinct counter values 1 through 5. A read then
 * write implementation fails it; the reviewer's overshoot is precisely what it
 * reproduces.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * Writes, so `tests/live-db-gate.ts` decides whether it runs at all, and every
 * id is minted fresh per run. See that file: a hostname check on its own was
 * satisfiable by a port forward to production, and hard-coded fixture UUIDs
 * made the cleanup a delete aimed at whatever row happened to hold them.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  releaseApplicationSlot,
  reserveApplicationSlot,
  type SlotReservation,
} from "@/lib/application-quota";
import { APPLICATION_STATUS } from "@/lib/application-status";
import * as schema from "@/lib/db/schema";

import { liveDbId, liveDbSuite, liveDbUrl } from "../live-db-gate";

type Reserved = Extract<SlotReservation, { reserved: true }>;
const wasReserved = (outcome: SlotReservation): outcome is Reserved => outcome.reserved;

liveDbSuite("the application allowance", () => {
  const USER_ID = liveDbId();
  const BOARD_ID = liveDbId();
  const JOB_ID = liveDbId();

  // Wide enough that "concurrent" means concurrent. One connection would
  // serialise the race test in the client and prove nothing about the database.
  const sql = postgres(liveDbUrl, { prepare: false, max: 12, onnotice: () => {} });
  const database = drizzle(sql, { schema });

  /** Every `applications` row this file made, so the cleanup can name them. */
  const applicationIds: string[] = [];

  beforeAll(async () => {
    await sql`insert into auth.users (id, email) values (${USER_ID}, 'quota@example.com')`;
    await sql`
      insert into public.profiles (id, email, attested_at, applications_used, applications_cap)
      values (${USER_ID}, 'quota@example.com', now(), 0, 0)`;
    await sql`
      insert into public.boards (id, ats, company, board_token)
      values (${BOARD_ID}, 'greenhouse', 'Acme', ${`quota-${BOARD_ID}`})`;
    await sql`
      insert into public.jobs (id, board_id, ats, external_id, title, url)
      values (${JOB_ID}, ${BOARD_ID}, 'greenhouse', ${`quota-${JOB_ID}`},
              'SWE Intern', ${`https://boards.example.com/${JOB_ID}`})`;
  });

  afterAll(async () => {
    // Scoped to the ids minted above, all of them v4 UUIDs this run generated.
    if (applicationIds.length > 0) {
      await sql`delete from public.applications where id = any(${sql.array(applicationIds)}::uuid[])`;
    }
    await sql`delete from public.jobs where id = ${JOB_ID}`;
    await sql`delete from public.boards where id = ${BOARD_ID}`;
    await sql`delete from public.profiles where id = ${USER_ID}`;
    await sql`delete from auth.users where id = ${USER_ID}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`
      update public.profiles set applications_used = 0, applications_cap = 0
       where id = ${USER_ID}`;
  });

  const allow = async (used: number, cap: number) => {
    await sql`
      update public.profiles set applications_used = ${used}, applications_cap = ${cap}
       where id = ${USER_ID}`;
  };

  const used = async () => {
    const [row] = await sql<{ applications_used: number }[]>`
      select applications_used from public.profiles where id = ${USER_ID}`;
    return row?.applications_used ?? null;
  };

  const application = async (status: string) => {
    const id = liveDbId();
    await sql`
      insert into public.applications (id, user_id, job_id, status)
      values (${id}, ${USER_ID}, ${JOB_ID}, ${status})`;
    applicationIds.push(id);
    return id;
  };

  // ───────────────────────────────────
  // Reserving
  // ───────────────────────────────────

  it("takes one application off the allowance and reports the counter it wrote", async () => {
    await allow(0, 3);

    await expect(reserveApplicationSlot(USER_ID, database)).resolves.toEqual({
      reserved: true,
      used: 1,
      cap: 3,
    });
    expect(await used()).toBe(1);
  });

  it("refuses at the cap, and leaves the counter where it was", async () => {
    await allow(3, 3);

    await expect(reserveApplicationSlot(USER_ID, database)).resolves.toEqual({
      reserved: false,
      reason: "cap_reached",
      used: 3,
      cap: 3,
    });
    expect(await used()).toBe(3);
  });

  it("reads the default cap of zero as none left rather than as no limit", async () => {
    await allow(0, 0);

    await expect(reserveApplicationSlot(USER_ID, database)).resolves.toEqual({
      reserved: false,
      reason: "cap_reached",
      used: 0,
      cap: 0,
    });
  });

  it("says so when there is no profile, instead of inventing an allowance", async () => {
    await expect(reserveApplicationSlot(liveDbId(), database)).resolves.toEqual({
      reserved: false,
      reason: "no_profile",
    });
  });

  /**
   * The race, run for real.
   *
   * Twenty reservations against a cap of five, all in flight at once. The
   * conditional UPDATE means each one blocks on the row lock and re-evaluates
   * `applications_used < applications_cap` against the value the previous
   * winner committed, so five can succeed and the sixth through twentieth find
   * no row to update.
   *
   * The distinct-values assertion is the one that would catch a regression to
   * read-then-write: five winners all reporting `used: 1` is exactly what
   * "everybody read 0, everybody wrote 1" looks like.
   */
  it("applies exactly the cap under concurrent pressure, and never overshoots", async () => {
    await allow(0, 5);

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => reserveApplicationSlot(USER_ID, database))
    );

    const winners = outcomes.filter(wasReserved);
    expect(winners).toHaveLength(5);
    expect(new Set(winners.map((winner) => winner.used))).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(outcomes.filter((outcome) => !outcome.reserved)).toHaveLength(15);
    expect(await used()).toBe(5);
  });

  // ───────────────────────────────────
  // Releasing
  // ───────────────────────────────────

  /**
   * The secondary defect, closed: the old guard counted `applications` rows
   * with no status filter, so a listing that was merely discovered, or one the
   * board refused us on, spent an application the candidate never made.
   */
  it.each([
    APPLICATION_STATUS.DISCOVERED,
    APPLICATION_STATUS.FILLING_FORM,
    APPLICATION_STATUS.FORM_FILL_BLOCKED,
    APPLICATION_STATUS.SUBMISSION_BLOCKED,
    APPLICATION_STATUS.ERROR,
  ])("gives the slot back when the run ended at %s", async (status) => {
    await allow(0, 5);
    await reserveApplicationSlot(USER_ID, database);
    expect(await used()).toBe(1);

    const applicationId = await application(status);

    await expect(
      releaseApplicationSlot({ userId: USER_ID, applicationId }, database)
    ).resolves.toEqual({ outcome: "released", used: 0 });
    expect(await used()).toBe(0);
  });

  it.each([APPLICATION_STATUS.SUBMITTED, APPLICATION_STATUS.SUBMISSION_UNCONFIRMED])(
    "keeps the slot spent when the submit control was pressed (%s)",
    async (status) => {
      await allow(0, 5);
      await reserveApplicationSlot(USER_ID, database);

      const applicationId = await application(status);

      await expect(
        releaseApplicationSlot({ userId: USER_ID, applicationId }, database)
      ).resolves.toEqual({ outcome: "kept", status });
      expect(await used()).toBe(1);
    }
  );

  it("cannot drive the counter below zero", async () => {
    await allow(0, 5);
    const applicationId = await application(APPLICATION_STATUS.DISCOVERED);

    await expect(
      releaseApplicationSlot({ userId: USER_ID, applicationId }, database)
    ).resolves.toEqual({ outcome: "nothing_to_release", status: APPLICATION_STATUS.DISCOVERED });
    expect(await used()).toBe(0);
  });

  it("will not refund against an application row that is not this person's", async () => {
    await allow(2, 5);

    await expect(
      releaseApplicationSlot({ userId: USER_ID, applicationId: liveDbId() }, database)
    ).resolves.toEqual({ outcome: "nothing_to_release", status: null });
    expect(await used()).toBe(2);
  });

  it("settles concurrent releases exactly, with no double refund", async () => {
    await allow(0, 10);
    await Promise.all(
      Array.from({ length: 6 }, () => reserveApplicationSlot(USER_ID, database))
    );
    expect(await used()).toBe(6);

    const ids = await Promise.all(
      Array.from({ length: 6 }, () => application(APPLICATION_STATUS.FORM_FILL_BLOCKED))
    );

    const settled = await Promise.all(
      ids.map((applicationId) =>
        releaseApplicationSlot({ userId: USER_ID, applicationId }, database)
      )
    );

    expect(settled.every((outcome) => outcome.outcome === "released")).toBe(true);
    expect(new Set(settled.map((outcome) => (outcome as { used: number }).used))).toEqual(
      new Set([0, 1, 2, 3, 4, 5])
    );
    expect(await used()).toBe(0);
  });
});
