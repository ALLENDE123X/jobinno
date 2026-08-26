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
 *
 * ── The other three options, and the prod hang they close (#168) ────────────
 * On a warm serverless instance the cached pool outlives any single request.
 * A socket left idle in that pool can be killed server side by the pooler's
 * own timeout while the instance sits frozen between invocations, and the next
 * query then reuses a dead handle that neither answers nor errors: the request
 * hangs until the platform kills it. That is exactly what every intake save on
 * jobinno.app did after launch opened signup. `idle_timeout` closes the socket
 * here before the pooler gets the chance to close it there, `max_lifetime`
 * caps how old a connection may get at all, `connect_timeout: 10` fails fast
 * instead of hanging when a fresh connection stalls, and `max: 1` matches how
 * a single request actually uses the pool. The sync script runs its short
 * writes sequentially, so a pool of one queues there rather than contending.
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
    // One request, one connection. See the header on #168.
    max: 1,
    // Close an idle socket here before the pooler kills it server side.
    idle_timeout: 20,
    // Fail a stalled new connection fast instead of holding the request open.
    connect_timeout: 10,
    // Retire connections well inside the pooler's own lifetime so none can
    // go stale underneath us no matter how warm the instance stays.
    max_lifetime: 60 * 30,
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
