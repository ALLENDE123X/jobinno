// @vitest-environment node
/**
 * The free trial grant, against a real Postgres.
 *
 * ── Why this suite is live and not faked ────────────────────────────────────
 * `recordAttestation` is one conditional UPDATE with a `CASE` inside it. A fake
 * database would only be asserting that the module builds the statement the
 * test also builds, which proves nothing about the property that actually
 * matters: that the statement really does refuse to run twice for the same
 * row, and really does leave a paid plan's cap alone. Those are claims about
 * what Postgres does with `WHERE ... AND attested_at IS NULL` under real row
 * locking, and only Postgres can settle them. `tests/unit/application-quota.test.ts`
 * makes the identical argument for `reserveApplicationSlot`.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * Writes, so `tests/live-db-gate.ts` decides whether it runs at all, and every
 * id is minted fresh per run. See that file for why a hostname check alone is
 * not enough and why no fixture uses a fixed uuid.
 */
import { afterAll, expect, it } from "vitest";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { FREE_PLAN_APPLICATIONS_CAP } from "@/lib/billing/plans";
import * as schema from "@/lib/db/schema";
import { recordAttestation } from "@/lib/onboarding/attestation";

import { liveDbId, liveDbSuite, liveDbUrl } from "../live-db-gate";

liveDbSuite("the free trial grant", () => {
  // Wide enough that the concurrent test is genuinely concurrent, matching
  // `application-quota.test.ts`.
  const sql = postgres(liveDbUrl, { prepare: false, max: 12, onnotice: () => {} });
  const database = drizzle(sql, { schema });

  /** Every `auth.users` / `profiles` row this file made, so cleanup can name them. */
  const userIds: string[] = [];

  const freshProfile = async (
    overrides: { plan?: string; attestedAt?: "now" | null; applicationsCap?: number } = {}
  ) => {
    const id = liveDbId();
    userIds.push(id);
    const email = `attest-${id}@example.com`;

    await sql`insert into auth.users (id, email) values (${id}, ${email})`;
    await sql`
      insert into public.profiles
        (id, email, plan, attested_at, applications_used, applications_cap)
      values (
        ${id},
        ${email},
        ${overrides.plan ?? "free"},
        ${overrides.attestedAt === "now" ? sql`now()` : null},
        0,
        ${overrides.applicationsCap ?? 0}
      )`;

    return id;
  };

  const profileRow = async (id: string) => {
    const [row] = await sql<
      { attested_at: string | null; applications_cap: number; plan: string }[]
    >`
      select attested_at, applications_cap, plan
      from public.profiles
      where id = ${id}`;
    return row ?? null;
  };

  afterAll(async () => {
    if (userIds.length > 0) {
      await sql`delete from public.profiles where id = any(${sql.array(userIds)}::uuid[])`;
      await sql`delete from auth.users where id = any(${sql.array(userIds)}::uuid[])`;
    }
    await sql.end({ timeout: 5 });
  });

  // ───────────────────────────────────
  // The grant that closes the bug
  // ───────────────────────────────────

  it("grants the three free applications on a fresh free profile's first attestation", async () => {
    const userId = await freshProfile({ plan: "free", attestedAt: null, applicationsCap: 0 });

    await expect(recordAttestation(userId, database)).resolves.toEqual({
      recorded: true,
      granted: true,
    });

    const row = await profileRow(userId);
    expect(row?.applications_cap).toBe(FREE_PLAN_APPLICATIONS_CAP);
    expect(row?.attested_at).not.toBeNull();
  });

  // ───────────────────────────────────
  // Exactly once
  // ───────────────────────────────────

  /**
   * The exploit this guards against: `/onboarding` only changes what it
   * renders once `attested_at` is set, it does not redirect the route away, so
   * the server action behind the form stays reachable. A second call for an
   * already attested person must not stamp the timestamp again or hand out a
   * second three.
   */
  it("does not grant or stamp again on a second call, once already attested", async () => {
    const userId = await freshProfile({ plan: "free", attestedAt: null, applicationsCap: 0 });

    await recordAttestation(userId, database);
    const afterFirst = await profileRow(userId);
    expect(afterFirst?.applications_cap).toBe(FREE_PLAN_APPLICATIONS_CAP);
    const firstStamp = afterFirst?.attested_at;

    // A person who somehow burned into their allowance between the two calls,
    // so a silent second grant would be visible as the counter jumping back up.
    await sql`update public.profiles set applications_cap = 3 where id = ${userId}`;

    await expect(recordAttestation(userId, database)).resolves.toEqual({ recorded: false });

    const afterSecond = await profileRow(userId);
    expect(afterSecond?.applications_cap).toBe(3);
    expect(afterSecond?.attested_at).toBe(firstStamp);
  });

  it("settles concurrent attestations exactly once, with no double grant", async () => {
    const userId = await freshProfile({ plan: "free", attestedAt: null, applicationsCap: 0 });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => recordAttestation(userId, database))
    );

    expect(outcomes.filter((outcome) => outcome.recorded)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.recorded)).toHaveLength(9);

    const row = await profileRow(userId);
    expect(row?.applications_cap).toBe(FREE_PLAN_APPLICATIONS_CAP);
  });

  // ───────────────────────────────────
  // What it deliberately refuses to touch
  // ───────────────────────────────────

  it("stamps attested_at but does not grant the free cap to a profile already on a paid plan", async () => {
    // Not a flow the product offers today, but the statement should not
    // silently hand a paid customer a second, smaller allowance if it ever
    // happens to be reachable.
    const userId = await freshProfile({ plan: "starter", attestedAt: null, applicationsCap: 150 });

    await expect(recordAttestation(userId, database)).resolves.toEqual({
      recorded: true,
      granted: false,
    });

    const row = await profileRow(userId);
    expect(row?.applications_cap).toBe(150);
    expect(row?.attested_at).not.toBeNull();
  });

  it("does nothing at all for a profile that does not exist", async () => {
    await expect(recordAttestation(liveDbId(), database)).resolves.toEqual({
      recorded: false,
    });
  });
});
