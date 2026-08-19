// @vitest-environment node
/**
 * Checks that the schema in `lib/db/schema.ts` is actually in the database the
 * suite is pointed at, and that row level security is on where it has to be.
 *
 * ── Read only, and skipped unless `DATABASE_URL` is exported ────────────────
 * Every statement here is a catalog read. Nothing writes, nothing drops and
 * nothing truncates, per HARD STOP 5, and the suite does not load `.env.local`
 * either: a developer who wants to run this against a real project has to say
 * so by exporting `DATABASE_URL` for the run. CI exports it, pointing at the
 * throwaway Postgres service container that `drizzle-kit push` just built.
 */
import { afterAll, describe, expect, it } from "vitest";

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;

/** Every table the schema module defines. */
const TABLES = [
  "applications",
  "boards",
  "cached_form_actions",
  "feedback",
  "jobs",
  "profiles",
  "resumes",
  "skip_log",
] as const;

/**
 * Tables carrying resumes, citizenship status or anything else belonging to one
 * person. `boards` and `jobs` are public listing data and are in the list
 * anyway, because RLS off on a Supabase table means anyone holding the anon key
 * can write to it.
 */
const RLS_TABLES = TABLES;

const POLICIES: Record<string, string[]> = {
  applications: ["applications_insert_own", "applications_select_own"],
  boards: ["boards_select_all"],
  /**
   * JOB-006. Deliberately empty, and checked as empty rather than left out.
   *
   * RLS on with no policy is PostgREST refusing anon and authenticated every
   * verb, which is the whole intent for a table holding selectors: nothing in
   * the browser has any reason to read one, and anyone who could write one
   * could aim a real candidate's resume at a control of their choosing. The
   * pipeline reaches it on the service role key, which bypasses RLS.
   */
  cached_form_actions: [],
  feedback: ["feedback_insert_any", "feedback_select_own"],
  jobs: ["jobs_select_all"],
  profiles: ["profiles_select_own", "profiles_update_own"],
  resumes: ["resumes_insert_own", "resumes_select_own"],
  skip_log: ["skip_log_select_via_own_application"],
};

const suite = DATABASE_URL ? describe : describe.skip;

suite("database schema", () => {
  const sql = postgres(DATABASE_URL ?? "", {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("has every table the schema module defines", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    const present = new Set(rows.map((row) => row.table_name));
    for (const table of TABLES) expect(present).toContain(table);
  });

  it("has row level security enabled on every one of them", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    `;
    const enabled = new Map(rows.map((row) => [row.relname, row.relrowsecurity]));
    for (const table of RLS_TABLES) expect(enabled.get(table)).toBe(true);
  });

  it("has the expected policy on each table and no extras", async () => {
    const rows = await sql<{ tablename: string; policyname: string }[]>`
      select tablename, policyname from pg_policies where schemaname = 'public'
    `;
    for (const [table, expected] of Object.entries(POLICIES)) {
      const found = rows
        .filter((row) => row.tablename === table)
        .map((row) => row.policyname)
        .sort();
      expect(found).toEqual(expected);
    }
  });

  it("gives end users no way to write to skip_log", async () => {
    // Only the pipeline writes skips, and it holds the service role key, which
    // bypasses RLS. A select policy and nothing else is the whole intent.
    const rows = await sql<{ cmd: string }[]>`
      select cmd from pg_policies
      where schemaname = 'public' and tablename = 'skip_log'
    `;
    expect(rows.map((row) => row.cmd)).toEqual(["SELECT"]);
  });

  it("keeps applications immutable from the browser side", async () => {
    // `submitted` is terminal and `submission_unconfirmed` must never be
    // retried, so no update or delete policy may ever appear here.
    const rows = await sql<{ cmd: string }[]>`
      select cmd from pg_policies
      where schemaname = 'public' and tablename = 'applications'
    `;
    expect(rows.map((row) => row.cmd).sort()).toEqual(["INSERT", "SELECT"]);
  });
});
