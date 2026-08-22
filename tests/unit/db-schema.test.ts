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

/**
 * The columns on `profiles` that the browser side must never be able to write,
 * and the reason `drizzle/0003_profiles_column_privileges.sql` exists. A policy
 * restricts rows and nothing else, so without a column privilege behind it an
 * authenticated user can PATCH any column of the row they already own.
 *
 * `plan`, `applications_used` and `applications_cap` are billing state, and
 * JOB-010's Stripe webhook is what now writes them. `attested_at` is the
 * completion gate on `/onboarding`. `stripe_customer_id` was added by JOB-010
 * and classified here rather than granted, because which Stripe customer a
 * person pays as is our record and not theirs.
 */
const PROFILE_SYSTEM_COLUMNS = [
  "applications_cap",
  "applications_used",
  "attested_at",
  "plan",
  "stripe_customer_id",
] as const;

/**
 * The other side of the same fence: what a person answers about themselves and
 * has to stay able to edit. `id` is here because the `with check` on
 * `profiles_update_own` already pins it to `auth.uid()`, so a grant on it
 * cannot move a row to another owner.
 *
 * The eight JOB-101 added are all on this side, and every one of them is an
 * answer the person gives about themselves at intake. A security clearance
 * status and a home address are sensitive, which is an argument for who may
 * READ them and never an argument for taking away the owner's ability to
 * correct their own record.
 */
const PROFILE_USER_COLUMNS = [
  "citizenship_status",
  "clearance_eligibility",
  "clearance_level_held",
  "created_at",
  "current_city",
  "current_country",
  "earliest_start",
  "email",
  "f1_status",
  "github_url",
  "grad_date",
  "high_school_grad_year",
  "high_school_name",
  "id",
  "needs_sponsorship_non_us",
  "postal_code",
  "requires_sponsorship",
  "street_address",
  "target_locations",
  "updated_at",
  "visa_status",
  "willing_to_relocate",
  "work_authorized_us",
] as const;

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

  describe("column privileges on profiles", () => {
    /** Which columns of `public.profiles` a role may write. */
    async function updatableBy(grantee: string) {
      const rows = await sql<{ column_name: string }[]>`
        select column_name
        from information_schema.column_privileges
        where table_schema = 'public'
          and table_name = 'profiles'
          and privilege_type = 'UPDATE'
          and grantee = ${grantee}
      `;
      return rows.map((row) => row.column_name).sort();
    }

    it("gives authenticated exactly the columns a person owns and no others", async () => {
      // Asserted as an exact set rather than as four absences on purpose. A new
      // column on this table has to be classified by whoever adds it, and a
      // test that only checks the four already known about would let the next
      // `applications_cap` through without a word.
      expect(await updatableBy("authenticated")).toEqual(
        [...PROFILE_USER_COLUMNS].sort()
      );
    });

    it("gives authenticated no way to write the system controlled columns", async () => {
      const updatable = new Set(await updatableBy("authenticated"));
      for (const column of PROFILE_SYSTEM_COLUMNS) {
        expect(updatable.has(column)).toBe(false);
      }
    });

    it("leaves the system controlled columns writable by the service role", async () => {
      // The attestation stamp in `app/onboarding/actions.ts` goes through this
      // role, and Stripe's webhook will write `plan` through it later. A revoke
      // that caught the service role too would be a locked door with the key
      // thrown away.
      const updatable = new Set(await updatableBy("service_role"));
      for (const column of PROFILE_SYSTEM_COLUMNS) {
        expect(updatable.has(column)).toBe(true);
      }
    });

    it("gives anon no way to update profiles at all", async () => {
      // RLS refuses these already, there being no update policy for `anon`. The
      // grant is revoked anyway so that the next policy added to this table
      // cannot hand out column access nobody meant to hand out.
      expect(await updatableBy("anon")).toEqual([]);
    });
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
