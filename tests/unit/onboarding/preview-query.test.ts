// @vitest-environment node
/**
 * JOB-309. getPreviewJobs is tested with a fake Supabase client the way
 * save-intake-draft.test.ts fakes one: the function takes its client as a
 * parameter (see the header on lib/onboarding/preview-query.ts for why),
 * so a unit test can hand it a recording fake instead of a live database.
 *
 * The three properties this ticket actually turns on:
 *
 *  1. The primary pass asks for intern rows off an active board only.
 *  2. An empty primary pass falls back to any active board's listings,
 *     rather than surfacing nothing when board coverage on interns
 *     specifically is thin.
 *  3. A query error is treated the same as a genuine zero match rather
 *     than thrown, because a broken read must never break the one page
 *     meant to show value before asking for anything.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getPreviewJobs } from "@/lib/onboarding/preview-query";

type Filter = [string, string, unknown];

type Call = {
  columns?: string;
  filters: Filter[];
  order?: { column: string; options: unknown };
  limit?: number;
};

type Response = { data: unknown[] | null; error: { message: string } | null };

/**
 * One `.from("jobs")...` call becomes one `Call` entry, in order. `responses`
 * is a queue: the Nth query awaited gets the Nth response, the same as the
 * Nth real request would get the Nth answer from PostgREST.
 */
function fakeClient(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];

  const client = {
    from(table: string) {
      expect(table).toBe("jobs");
      const call: Call = { filters: [] };
      calls.push(call);

      const chain = {
        select(columns: string) {
          call.columns = columns;
          return chain;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, "eq", value]);
          return chain;
        },
        order(column: string, options: unknown) {
          call.order = { column, options };
          return chain;
        },
        limit(count: number) {
          call.limit = count;
          return chain;
        },
        then(
          resolve: (value: Response) => unknown,
        ) {
          const next = queue.shift() ?? { data: [], error: null };
          return Promise.resolve(resolve(next));
        },
      };
      return chain;
    },
  };

  return { client, calls };
}

const ROW_A = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Software Engineer Intern",
  location: "Remote",
  ats: "greenhouse",
  boards: { company: "Acme", active: true },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getPreviewJobs", () => {
  it("asks for intern rows off an active board first, and stops there on a match", async () => {
    const { client, calls } = fakeClient([{ data: [ROW_A], error: null }]);

    const jobs = await getPreviewJobs(
      client as unknown as Parameters<typeof getPreviewJobs>[0],
    );

    expect(jobs).toEqual([
      {
        id: ROW_A.id,
        title: "Software Engineer Intern",
        company: "Acme",
        location: "Remote",
        ats: "greenhouse",
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].filters).toContainEqual(["boards.active", "eq", true]);
    expect(calls[0].filters).toContainEqual(["is_intern", "eq", true]);
  });

  it("falls back to any active board's listings when the intern only pass is empty", async () => {
    const rowB = {
      id: "22222222-2222-2222-2222-222222222222",
      title: "New Grad Software Engineer",
      location: null,
      ats: "lever",
      boards: [{ company: "Beta Co", active: true }],
    };
    const { client, calls } = fakeClient([
      { data: [], error: null },
      { data: [rowB], error: null },
    ]);

    const jobs = await getPreviewJobs(
      client as unknown as Parameters<typeof getPreviewJobs>[0],
    );

    expect(jobs).toEqual([
      {
        id: rowB.id,
        title: "New Grad Software Engineer",
        company: "Beta Co",
        location: null,
        ats: "lever",
      },
    ]);
    expect(calls).toHaveLength(2);
    // The primary pass narrowed to interns.
    expect(calls[0].filters).toContainEqual(["is_intern", "eq", true]);
    // The fallback dropped that filter, keeping only the active board gate.
    expect(calls[1].filters).toContainEqual(["boards.active", "eq", true]);
    expect(calls[1].filters).not.toContainEqual(["is_intern", "eq", true]);
  });

  it("returns an empty array when both passes come back with nothing", async () => {
    const { client, calls } = fakeClient([
      { data: [], error: null },
      { data: [], error: null },
    ]);

    const jobs = await getPreviewJobs(
      client as unknown as Parameters<typeof getPreviewJobs>[0],
    );

    expect(jobs).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("treats a query error as a zero match and still tries the fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rowC = {
      id: "33333333-3333-3333-3333-333333333333",
      title: "Backend Engineer Intern",
      location: "Austin, TX",
      ats: "ashby",
      boards: { company: "Gamma Inc", active: true },
    };
    const { client } = fakeClient([
      { data: null, error: { message: "connection reset" } },
      { data: [rowC], error: null },
    ]);

    const jobs = await getPreviewJobs(
      client as unknown as Parameters<typeof getPreviewJobs>[0],
    );

    expect(jobs).toEqual([
      {
        id: rowC.id,
        title: "Backend Engineer Intern",
        company: "Gamma Inc",
        location: "Austin, TX",
        ats: "ashby",
      },
    ]);
  });

  it("passes the requested limit through to both passes", async () => {
    const { client, calls } = fakeClient([
      { data: [], error: null },
      { data: [], error: null },
    ]);

    await getPreviewJobs(
      client as unknown as Parameters<typeof getPreviewJobs>[0],
      3,
    );

    expect(calls[0].limit).toBe(3);
    expect(calls[1].limit).toBe(3);
  });
});
