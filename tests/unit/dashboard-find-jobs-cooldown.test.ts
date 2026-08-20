// @vitest-environment node
/**
 * The "Find Jobs Now" rate limit, end to end, against a real Postgres.
 *
 * ── Why this suite is live and not faked ────────────────────────────────────
 * `lib/search-cooldown.ts` is one conditional UPDATE. A fake database would be
 * asserting that the module builds the query the test also builds, which is a
 * tautology, and it would say nothing about the property the ticket is actually
 * about: that a caller who never rendered the button, and who fires again
 * immediately, is refused. That is a claim about Postgres re-evaluating a WHERE
 * clause under a row lock, and only Postgres can settle it. Same reasoning, and
 * the same gate, as `tests/unit/application-quota.test.ts`.
 *
 * So `findJobsNow` is driven for real here. Only the two things that are not the
 * database are stubbed: Supabase Auth, because there is no browser session to
 * read, and `requestJobSearch`, because sending a real Inngest event would pull
 * Stagehand into the graph and would prove nothing about the cooldown. The
 * cooldown, the column and the statement are all the real ones.
 *
 * ── On the third test ───────────────────────────────────────────────────────
 * The burst is the case the button's own cooldown cannot touch and the case the
 * ticket names: eight simultaneous calls, none of which rendered any React
 * state. A read then write implementation lets all eight through, and so does
 * any check built on `applications` rows, since none of them exist yet at the
 * moment these calls arrive.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import postgres from "postgres";

import { closeDb } from "@/lib/db/client";
import { SEARCH_COOLDOWN_MINUTES } from "@/lib/search-cooldown";

import { liveDbId, liveDbSuite, liveDbUrl } from "../live-db-gate";

const getUser = vi.fn();
const requestJobSearch = vi.fn(async (userId: string): Promise<void> => {
  void userId;
});

vi.mock("@/lib/job-search-trigger", () => ({
  requestJobSearch: (userId: string) => requestJobSearch(userId),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Attested and well under the cap, so that the cooldown is the only thing left
// that can refuse a call. The profile row in Postgres is real, because that is
// what the UPDATE has to find; this is only what the page's read returns.
const profileRow = {
  attested_at: "2026-07-01T00:00:00.000Z",
  applications_used: 3,
  applications_cap: 150,
};

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({
    auth: { getUser },
    from() {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: profileRow, error: null }),
      };
      return chain;
    },
  }),
}));

const { findJobsNow } = await import("@/app/dashboard/actions");

liveDbSuite("the server side search cooldown", () => {
  const USER_ID = liveDbId();
  const EMAIL = `cooldown-${USER_ID}@example.com`;

  // Wide enough that "simultaneous" means simultaneous in the third test. One
  // connection would serialise the burst in the client and prove nothing.
  const sql = postgres(liveDbUrl, { prepare: false, max: 10, onnotice: () => {} });

  beforeAll(async () => {
    await sql`insert into auth.users (id, email) values (${USER_ID}, ${EMAIL})`;
    await sql`
      insert into public.profiles (id, email, attested_at, applications_used, applications_cap)
      values (${USER_ID}, ${EMAIL}, now(), 3, 150)`;
  });

  afterAll(async () => {
    // Scoped to the one id this run minted, so the delete cannot reach a row
    // this suite did not create. See `tests/live-db-gate.ts`.
    await sql`delete from public.profiles where id = ${USER_ID}`;
    await sql`delete from auth.users where id = ${USER_ID}`;
    await sql.end({ timeout: 5 });
    await closeDb();
  });

  beforeEach(async () => {
    requestJobSearch.mockClear();
    getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: EMAIL } } });
    await sql`update public.profiles set last_search_requested_at = null where id = ${USER_ID}`;
  });

  it("accepts the first call and refuses the next one straight after it", async () => {
    expect(await findJobsNow()).toEqual({ ok: true });

    const second = await findJobsNow();

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.message).toContain("You can start another search in");
    expect(requestJobSearch).toHaveBeenCalledTimes(1);
    expect(requestJobSearch).toHaveBeenCalledWith(USER_ID);
  });

  it("stamps the column, which is what the refusal is made of", async () => {
    await findJobsNow();

    const [row] = await sql<{ last_search_requested_at: Date | null }[]>`
      select last_search_requested_at from public.profiles where id = ${USER_ID}`;

    expect(row.last_search_requested_at).toBeInstanceOf(Date);
  });

  it("accepts one again once the window has passed", async () => {
    expect(await findJobsNow()).toEqual({ ok: true });
    expect((await findJobsNow()).ok).toBe(false);

    // That column is the whole of the cooldown's state, so moving the stamp back
    // past the window is the same event as the window elapsing. A test that
    // really waited five minutes is a test nobody would run.
    const beforeTheWindow = new Date(Date.now() - (SEARCH_COOLDOWN_MINUTES * 60 + 1) * 1000);
    await sql`
      update public.profiles
      set last_search_requested_at = ${beforeTheWindow}
      where id = ${USER_ID}`;

    expect(await findJobsNow()).toEqual({ ok: true });
    expect(requestJobSearch).toHaveBeenCalledTimes(2);
  });

  it("still refuses a stamp that is one second short of the window", async () => {
    const justInsideTheWindow = new Date(Date.now() - (SEARCH_COOLDOWN_MINUTES * 60 - 1) * 1000);
    await sql`
      update public.profiles
      set last_search_requested_at = ${justInsideTheWindow}
      where id = ${USER_ID}`;

    expect((await findJobsNow()).ok).toBe(false);
    expect(requestJobSearch).not.toHaveBeenCalled();
  });

  it("lets exactly one of eight simultaneous calls through", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => findJobsNow()));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(requestJobSearch).toHaveBeenCalledTimes(1);
  });
});
