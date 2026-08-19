/**
 * Applies `scripts/supabase-storage-resumes-bucket.sql` and then reads the
 * result back out of the database. Run it with `npm run db:storage-bucket`.
 *
 * The read back is the point. A statement that ran without raising is not the
 * same claim as a bucket that exists and is private with the two policies
 * attached, and the difference between those two claims is exactly the kind of
 * thing that gets assumed rather than checked. So this prints what the database
 * actually holds afterwards, and exits non zero when it is not what the SQL
 * file asked for.
 *
 * Nothing here drops or deletes anything, so there is no destructive path and
 * no opt in gate to set. See HARD STOP 5 in CLAUDE.md for when one is needed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local" });

const BUCKET_ID = "resumes";
const EXPECTED_POLICIES = ["resumes_insert_own", "resumes_select_own"];

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. It lives in .env.local, which is gitignored."
    );
  }

  const sqlFile = path.join(
    process.cwd(),
    "scripts",
    "supabase-storage-resumes-bucket.sql"
  );

  // `max: 1` because the whole file has to run on one connection: a pooled
  // second connection would see a different transaction.
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    await sql.unsafe(readFileSync(sqlFile, "utf8"));

    const buckets = await sql<
      { id: string; public: boolean; file_size_limit: number | null }[]
    >`
      select id, public, file_size_limit
      from storage.buckets
      where id = ${BUCKET_ID}
    `;

    const [{ relrowsecurity: rlsEnabled }] = await sql<
      { relrowsecurity: boolean }[]
    >`
      select relrowsecurity
      from pg_class
      where oid = 'storage.objects'::regclass
    `;

    const policies = await sql<{ policyname: string; cmd: string }[]>`
      select policyname, cmd
      from pg_policies
      where schemaname = 'storage'
        and tablename = 'objects'
        and policyname = any(${EXPECTED_POLICIES})
      order by policyname
    `;

    const bucket = buckets[0];
    const problems: string[] = [];

    if (!bucket) {
      problems.push(`bucket "${BUCKET_ID}" does not exist`);
    } else if (bucket.public) {
      problems.push(`bucket "${BUCKET_ID}" is public and must not be`);
    }

    // Every policy below is decoration if this is off, so it is checked rather
    // than assumed. See the note in the SQL file about why it is not set there.
    if (!rlsEnabled) {
      problems.push("row level security is disabled on storage.objects");
    }

    for (const expected of EXPECTED_POLICIES) {
      if (!policies.some((policy) => policy.policyname === expected)) {
        problems.push(`policy "${expected}" is missing from storage.objects`);
      }
    }

    console.log("bucket:", bucket ?? "(none)");
    console.log("policies:", policies);

    if (problems.length > 0) {
      throw new Error(`Storage bucket is not correctly set up:\n  ${problems.join("\n  ")}`);
    }

    console.log(
      `\nVerified: bucket "${BUCKET_ID}" is private with ${policies.length} owner scoped policies.`
    );
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
