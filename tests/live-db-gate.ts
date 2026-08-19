/**
 * The gate every test that *writes* to Postgres has to pass.
 *
 * Not a test file — `vitest.config.mts` only collects `tests/unit/**` — and
 * deliberately shared, because the point of it is that there is one answer to
 * "may this run write to the database" rather than one per suite.
 *
 * ── Why the localhost check is not enough on its own ────────────────────────
 * The rule these suites are written under is HARD STOP 5: nothing destructive
 * runs against a real `DATABASE_URL`. That used to be enforced by requiring the
 * host in the connection string to be `localhost` or `127.0.0.1`, on the
 * reasoning that CI's throwaway service container is one and a Supabase pooler
 * is not.
 *
 * A hostname is not a database. `psql "postgres://…@localhost:5432/…"` reaches
 * production the moment anybody runs a port forward at it, which is an ordinary
 * thing to be running — `cloud-sql-proxy`, an SSH tunnel, `kubectl
 * port-forward`, Supabase's own `db start` pointed at a linked project — and it
 * is exactly the situation in which somebody also has a test suite open. The
 * check would have passed, the fixtures would have been written into the real
 * `profiles`, and the cleanup below would have deleted from the real
 * `auth.users`.
 *
 * So writing now needs a second thing that no tunnel can supply on the
 * developer's behalf: `ALLOW_LIVE_DB_TESTS=1`, exported on purpose, for that
 * run. CI sets it in `.github/workflows/ci.yml` next to the `DATABASE_URL` of
 * the service container it just built. Both are required; either one missing
 * skips the suite rather than failing it, because a developer running `npm
 * test` on a laptop with no Postgres is doing nothing wrong.
 *
 * ── And why fixtures use fresh ids ──────────────────────────────────────────
 * `liveDbId()` exists so that no suite hard-codes a UUID. A constant like
 * `1111…` is a value a real row can hold, and a cleanup scoped to it is a
 * `delete from auth.users where id = …` aimed at whatever happens to be there.
 * A v4 UUID minted per run cannot collide with a row this suite did not create,
 * which makes the cleanup safe by construction instead of by hoping.
 */

import { randomUUID } from "node:crypto";

import { describe } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;

/** The host has to be loopback. Necessary, and — see the header — not sufficient. */
const looksLocal =
  DATABASE_URL !== undefined && /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);

/** The explicit, per-run opt in. Nothing infers this from anything. */
const optedIn = process.env.ALLOW_LIVE_DB_TESTS === "1";

/** May this run create and delete rows in the database `DATABASE_URL` names? */
export const liveDbWritesAllowed = looksLocal && optedIn;

/**
 * `DATABASE_URL`, but only when writing is allowed. Empty otherwise, so that a
 * suite which somehow got past the gate connects to nothing instead of to
 * whatever was exported.
 */
export const liveDbUrl = liveDbWritesAllowed ? (DATABASE_URL as string) : "";

/**
 * `describe` for a suite that writes, `describe.skip` when it may not.
 *
 * Vitest reports the skip with the suite's own name, which is what makes a
 * developer notice these exist. A silent pass would not.
 */
export const liveDbSuite = liveDbWritesAllowed ? describe : describe.skip;

/**
 * A UUID no pre-existing row can be holding. One per call, per run.
 *
 * Named rather than inlined so that `randomUUID()` scattered through a fixture
 * still reads as "this is a test id and the cleanup owns it".
 */
export function liveDbId(): string {
  return randomUUID();
}
