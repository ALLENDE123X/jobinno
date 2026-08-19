/**
 * The Drizzle connection, in one place (JOB-003).
 *
 * `lib/db/schema.ts` has described these tables since JOB-002, but nothing had
 * yet opened a connection to the database it describes: every ported module in
 * `lib/` reaches Supabase through `@supabase/supabase-js` instead. That
 * reconciliation is still open and still not this ticket. What this module adds
 * is the second caller, for the two tables no user owns and no row level
 * security policy would help with: `boards` and `jobs` are world readable
 * reference data written only by the sync.
 *
 * ── Why lazy, and why cached on `globalThis` ────────────────────────────────
 * Constructing the client at module scope would open a socket in any process
 * that so much as imports this file, including a Vitest worker that only wanted
 * a type. So the connection is made on first use and never before.
 *
 * The `globalThis` cache is for Next.js in development, where a hot reload
 * re evaluates modules while the old ones are still alive. Without it every
 * save leaks a pool until Postgres refuses new connections, which presents as
 * the app mysteriously dying after twenty edits.
 *
 * ── `prepare: false` ────────────────────────────────────────────────────────
 * Supabase's pooled connection string runs PgBouncer in transaction mode, which
 * cannot carry a prepared statement across the pool. Leaving prepares on works
 * against a direct connection and fails against the pooler, so it fails in
 * production and not locally, which is the worst way for it to fail.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

const cache = globalThis as unknown as {
  jobinnoDb?: DrizzleClient;
  jobinnoSql?: ReturnType<typeof postgres>;
};

/**
 * The shared Drizzle client.
 *
 * Throws rather than connecting to nothing when `DATABASE_URL` is unset. An
 * empty connection string does not fail here; it fails several frames later,
 * inside the driver, with a message about a socket.
 */
export function db(): DrizzleClient {
  if (cache.jobinnoDb) return cache.jobinnoDb;

  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. It is the Postgres connection string for the " +
        "Supabase project this checkout may write to. See .env.example."
    );
  }

  const sql = postgres(url, {
    // See the header. Required by Supabase's transaction mode pooler.
    prepare: false,
    // The sync is one background process doing short writes, not a web server.
    max: 5,
    idle_timeout: 20,
    connect_timeout: 30,
  });

  cache.jobinnoSql = sql;
  cache.jobinnoDb = drizzle(sql, { schema });
  return cache.jobinnoDb;
}

/**
 * Close the pool. For a script or a test that would otherwise hold the process
 * open; a long lived server should never call it.
 */
export async function closeDb(): Promise<void> {
  const sql = cache.jobinnoSql;
  cache.jobinnoDb = undefined;
  cache.jobinnoSql = undefined;
  if (sql) await sql.end({ timeout: 5 });
}
