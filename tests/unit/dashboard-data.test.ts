// @vitest-environment node
/**
 * JOB-009. The dashboard reads one person's rows and nobody else's.
 *
 * ── Why the fake client filters instead of just recording ───────────────────
 * `tests/unit/application-records.test.ts` records what a module asks Supabase
 * for and asserts on the request, because a fake that answers anything would
 * pass just as happily against the wrong table. That is half of what is needed
 * here. The other half is the property this ticket is actually about: a list
 * that shows somebody else's applications is the worst bug this page can have,
 * and an assertion that the module emitted `eq("user_id", …)` does not by
 * itself say the result was scoped.
 *
 * So the fake below applies the filters it was handed to a fixture holding two
 * people's rows. A module that forgets the filter gets both back and fails, and
 * the recorded call is asserted as well so that a filter on the wrong column
 * cannot pass by coincidence.
 *
 * ── And why there is a live block ───────────────────────────────────────────
 * The select strings are stringly typed. Nothing in the type system knows
 * whether `jobs(title,url,boards(company))` names real columns across real
 * foreign keys, and getting it wrong is a run time PostgREST error on a page
 * that type checks, lints and unit tests clean. CI has a real Postgres carrying
 * the real schema, so the names are checked against the catalog there. It
 * cannot exercise PostgREST itself, and it cannot exercise row level security
 * either: CI's `auth.uid()` is a stub that returns null, so no policy ever
 * matches a row. The filter above is what this suite can prove, and the policy
 * behind it is proven in `tests/unit/db-schema.test.ts`.
 *
 * ── And why a suite about what an error does not say ────────────────────────
 * The last block is the other half of the same worry. Both reads sit on a path
 * that ends in text in somebody's browser, and Postgres writes its errors for
 * whoever holds the connection: they name tables, columns, constraints and
 * policies as they really are. So the assertion there is not that a tidy message
 * comes back. It is that no fragment of the database's own wording survives into
 * anything the caller receives, and that all of it survives into the log.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";

import {
  DASHBOARD_APPLICATION_LIMIT,
  DASHBOARD_READ_FAILED,
  DASHBOARD_SELECTS,
  listApplications,
  readDashboardProfile,
  toQuota,
} from "@/lib/dashboard/dashboard-data";

const ME = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SOMEBODY_ELSE = "9c858901-8a57-4791-81fe-4c455b099bc9";

type Call = {
  table: string;
  columns: string;
  filters: [string, unknown][];
  order: { column: string; ascending: boolean } | null;
  limit: number | null;
};

const calls: Call[] = [];
/** `table` → every row that table holds, across both people. */
const tables: Record<string, Record<string, unknown>[]> = {};

/**
 * A Supabase client that records the query and then answers it, honestly, from
 * the fixture. `eq` is the only filter the dashboard uses, so it is the only
 * one implemented; anything else would be scaffolding for a caller that does
 * not exist.
 */
function fakeClient(): SupabaseClient {
  return {
    from(table: string) {
      const call: Call = { table, columns: "", filters: [], order: null, limit: null };
      calls.push(call);

      const matching = () =>
        (tables[table] ?? []).filter((row) =>
          call.filters.every(([column, value]) => row[column] === value)
        );

      const chain: Record<string, unknown> = {
        select(columns: string) {
          call.columns = columns;
          return chain;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return chain;
        },
        order(column: string, options: { ascending: boolean }) {
          call.order = { column, ascending: options.ascending };
          return chain;
        },
        limit(count: number) {
          call.limit = count;
          return chain;
        },
        maybeSingle() {
          return Promise.resolve({ data: matching()[0] ?? null, error: null });
        },
        then(resolve: (value: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: matching(), error: null }).then(resolve);
        },
      };

      return chain;
    },
  } as unknown as SupabaseClient;
}

function application(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "application-1",
    user_id: ME,
    status: "submitted",
    submitted_at: "2026-08-01T10:00:00.000Z",
    confirmation_text: null,
    created_at: "2026-08-01T09:00:00.000Z",
    jobs: { title: "Software Engineer Intern", url: "https://boards.example.com/1", boards: { company: "Acme" } },
    skip_log: [],
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(tables)) delete tables[key];
});

describe("the applications list", () => {
  it("returns the signed in person's rows and not anybody else's", async () => {
    tables.applications = [
      application({ id: "mine-1" }),
      application({ id: "theirs-1", user_id: SOMEBODY_ELSE }),
      application({ id: "mine-2" }),
      application({ id: "theirs-2", user_id: SOMEBODY_ELSE }),
    ];

    const rows = await listApplications(fakeClient(), ME);

    expect(rows.map((row) => row.id)).toEqual(["mine-1", "mine-2"]);
  });

  it("scopes the query on user_id rather than on anything else", async () => {
    tables.applications = [];

    await listApplications(fakeClient(), ME);

    expect(calls[0].table).toBe("applications");
    expect(calls[0].filters).toEqual([["user_id", ME]]);
  });

  it("asks for the newest first, and for no more than a full plan's worth", async () => {
    tables.applications = [];

    await listApplications(fakeClient(), ME);

    expect(calls[0].order).toEqual({ column: "created_at", ascending: false });
    expect(calls[0].limit).toBe(DASHBOARD_APPLICATION_LIMIT);
  });

  it("flattens the company off the board and the title off the job", async () => {
    tables.applications = [
      application({
        confirmation_text: "Reference GH-4417",
        jobs: {
          title: "New Grad Software Engineer",
          url: "https://boards.example.com/42",
          boards: { company: "Initech" },
        },
      }),
    ];

    const [row] = await listApplications(fakeClient(), ME);

    expect(row).toMatchObject({
      company: "Initech",
      title: "New Grad Software Engineer",
      url: "https://boards.example.com/42",
      status: "submitted",
      submittedAt: "2026-08-01T10:00:00.000Z",
      confirmationText: "Reference GH-4417",
    });
  });

  it("renders a listing whose job row went missing rather than throwing", async () => {
    tables.applications = [application({ jobs: null })];

    const [row] = await listApplications(fakeClient(), ME);

    expect(row.company).toBe("Unknown company");
    expect(row.title).toBe("Unknown role");
    expect(row.url).toBeNull();
  });

  it("shows the newest skip reason when an application was attempted twice", async () => {
    // `recordSkip` appends, so the older reason describes a stop that has since
    // been superseded. Showing it would tell somebody about the wrong failure.
    tables.applications = [
      application({
        status: "form_fill_blocked",
        skip_log: [
          { reason: "timeout", created_at: "2026-08-01T09:30:00.000Z" },
          { reason: "unanswerable_required", created_at: "2026-08-02T11:00:00.000Z" },
          { reason: "captcha", created_at: "2026-07-30T08:00:00.000Z" },
        ],
      }),
    ];

    const [row] = await listApplications(fakeClient(), ME);

    expect(row.skipReason).toBe("unanswerable_required");
  });

  it("has no skip reason for an application that never stopped", async () => {
    tables.applications = [application({})];

    const [row] = await listApplications(fakeClient(), ME);

    expect(row.skipReason).toBeNull();
  });
});

describe("the profile read", () => {
  it("reads the allowance off the signed in person's own row", async () => {
    tables.profiles = [
      { id: ME, attested_at: "2026-07-01T00:00:00.000Z", applications_used: 12, applications_cap: 150 },
      { id: SOMEBODY_ELSE, attested_at: null, applications_used: 400, applications_cap: 500 },
    ];

    const profile = await readDashboardProfile(fakeClient(), ME);

    expect(calls[0].filters).toEqual([["id", ME]]);
    expect(profile?.attestedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(profile?.quota).toEqual({ used: 12, cap: 150, remaining: 138, atCap: false });
  });

  it("returns nothing at all when there is no profile row", async () => {
    tables.profiles = [];

    expect(await readDashboardProfile(fakeClient(), ME)).toBeNull();
  });
});

describe("the quota arithmetic", () => {
  it("is empty at zero used", () => {
    expect(toQuota(0, 150)).toEqual({ used: 0, cap: 150, remaining: 150, atCap: false });
  });

  it("counts down through the middle of a plan", () => {
    expect(toQuota(12, 150)).toEqual({ used: 12, cap: 150, remaining: 138, atCap: false });
  });

  it("is at the cap on the last one", () => {
    expect(toQuota(150, 150)).toEqual({ used: 150, cap: 150, remaining: 0, atCap: true });
  });

  it("treats an unprovisioned cap of zero as nothing left rather than as no limit", () => {
    // The schema is explicit about this: a zero cap means the account cannot
    // apply yet. Reading it as "no limit" is billable work done for free.
    expect(toQuota(0, 0)).toEqual({ used: 0, cap: 0, remaining: 0, atCap: true });
  });

  it("never reports a negative remainder if a counter ever overshoots", () => {
    expect(toQuota(160, 150)).toEqual({ used: 160, cap: 150, remaining: 0, atCap: true });
  });
});

// ───────────────────────────────────
// What a failed read is allowed to say
// ───────────────────────────────────

/**
 * A real PostgREST error object, in the shape `@supabase/supabase-js` hands
 * back: `message`, `code`, `details` and `hint`, every one of them describing
 * the database rather than the request. The four strings below are what must
 * not appear in anything a caller receives.
 */
const POSTGREST_ERROR = {
  message: 'new row violates row level security policy for table "profiles"',
  code: "42501",
  details: 'Failing row contains (3f2504e0, pro, 150, 2026-07-01).',
  hint: 'Perhaps you meant to reference the column "applications.user_id".',
};

const LEAKED_STRINGS = [
  POSTGREST_ERROR.message,
  POSTGREST_ERROR.code,
  POSTGREST_ERROR.details,
  POSTGREST_ERROR.hint,
  "row level security",
  "applications.user_id",
];

/** A client whose every query fails, the way PostgREST reports a refused one. */
function failingClient(error: unknown): SupabaseClient {
  return {
    from() {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error }),
        then: (resolve: (value: { data: null; error: unknown }) => unknown) =>
          Promise.resolve({ data: null, error }).then(resolve),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe("a read the database refused", () => {
  let logged: unknown[] = [];

  /**
   * Every argument the module logged, flattened to one searchable string.
   *
   * `JSON.stringify` would have been shorter and would have been wrong: it
   * escapes the quotes Postgres puts around an identifier, so a search for
   * `table "profiles"` finds nothing in a line that plainly contains it.
   */
  const loggedText = () =>
    logged
      .map((arg) =>
        arg !== null && typeof arg === "object"
          ? Object.values(arg as Record<string, unknown>).map(String).join(" ")
          : String(arg)
      )
      .join(" ");

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws the fixed sentence for the applications list", async () => {
    await expect(listApplications(failingClient(POSTGREST_ERROR), ME)).rejects.toThrow(
      DASHBOARD_READ_FAILED.applications
    );
  });

  it("throws the fixed sentence for the profile", async () => {
    await expect(readDashboardProfile(failingClient(POSTGREST_ERROR), ME)).rejects.toThrow(
      DASHBOARD_READ_FAILED.profile
    );
  });

  it("carries none of the database's own words out of either function", async () => {
    // The point of the ticket. Whatever the caller ends up rendering, it must
    // not be able to reconstruct one word of what Postgres said, so the error
    // is inspected whole rather than only through `.message`.
    const reads: ((supabase: SupabaseClient, userId: string) => Promise<unknown>)[] = [
      listApplications,
      readDashboardProfile,
    ];

    for (const read of reads) {
      const thrown = await read(failingClient(POSTGREST_ERROR), ME).then(
        () => null,
        (error: unknown) => error
      );

      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      const visible = `${error.message} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
      for (const secret of LEAKED_STRINGS) {
        expect([secret, visible.includes(secret)]).toEqual([secret, false]);
      }
    }
  });

  it("puts every one of those words in the log instead, with the user id", async () => {
    // Losing the detail would be the other way to fail this ticket: an engineer
    // still has to be able to tell a missing column from a policy that refused.
    await listApplications(failingClient(POSTGREST_ERROR), ME).catch(() => {});

    const line = loggedText();
    expect(line).toContain("listApplications");
    expect(line).toContain(ME);
    for (const secret of LEAKED_STRINGS.slice(0, 4)) {
      expect([secret, line.includes(secret)]).toEqual([secret, true]);
    }
  });

  it("says nothing about the database even when the client throws a bare string", async () => {
    // `error` is not always an object. A gateway in front of PostgREST can put
    // an HTML page or a plain sentence there, and `String(error)` on it is just
    // as much somebody else's words as a `message` field would have been.
    await expect(
      readDashboardProfile(failingClient("relation \"profiles\" does not exist"), ME)
    ).rejects.toThrow(DASHBOARD_READ_FAILED.profile);
  });
});

// ───────────────────────────────────
// Against the real schema
// ───────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const liveSuite = DATABASE_URL ? describe : describe.skip;

/** Every column the two select strings name, by the table it has to be on. */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  applications: ["id", "status", "submitted_at", "confirmation_text", "created_at", "user_id", "job_id"],
  jobs: ["title", "url", "board_id"],
  boards: ["company"],
  skip_log: ["reason", "created_at", "application_id"],
  profiles: ["attested_at", "applications_used", "applications_cap", "id"],
};

/**
 * The foreign keys PostgREST resolves each embed through. An embed without one
 * is not a slow query, it is a 400 saying the relationship could not be found.
 */
const REQUIRED_EMBEDS: [string, string, string][] = [
  ["applications", "job_id", "jobs"],
  ["jobs", "board_id", "boards"],
  ["skip_log", "application_id", "applications"],
];

describe("the list of columns the live check covers", () => {
  it("names everything the select strings ask for", () => {
    // Needs no database, so it runs everywhere. It guards the table above
    // against the module growing a column the live check would then never look
    // for: the select strings are the source, `REQUIRED_COLUMNS` is the mirror.
    const named = `${DASHBOARD_SELECTS.applications},${DASHBOARD_SELECTS.profiles}`
      .split(/[(),]/)
      .map((part) => part.trim())
      .filter((part) => part !== "");

    const covered = new Set(
      Object.values(REQUIRED_COLUMNS).flat().concat(Object.keys(REQUIRED_COLUMNS))
    );
    for (const name of named) expect([name, covered.has(name)]).toEqual([name, true]);
  });
});

liveSuite("the select strings name real columns", () => {
  const sql = postgres(DATABASE_URL ?? "", { max: 1, prepare: false, onnotice: () => {} });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("names only columns the database has", async () => {
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const rows = await sql<{ column_name: string }[]>`
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = ${table}
      `;
      const present = new Set(rows.map((row) => row.column_name));
      for (const column of columns) expect([table, column, present.has(column)]).toEqual([table, column, true]);
    }
  });

  it("has a foreign key behind every embedded resource", async () => {
    const rows = await sql<{ table_name: string; column_name: string; foreign_table_name: string }[]>`
      select
        tc.table_name,
        kcu.column_name,
        ccu.table_name as foreign_table_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
    `;

    const present = new Set(
      rows.map((row) => `${row.table_name}.${row.column_name}->${row.foreign_table_name}`)
    );

    for (const [table, column, target] of REQUIRED_EMBEDS) {
      expect([`${table}.${column}`, present.has(`${table}.${column}->${target}`)]).toEqual([
        `${table}.${column}`,
        true,
      ]);
    }
  });

});
