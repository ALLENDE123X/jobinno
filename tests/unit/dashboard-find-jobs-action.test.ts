// @vitest-environment node
/**
 * JOB-009. What the "Find Jobs Now" button is allowed to start.
 *
 * ── The one that matters ────────────────────────────────────────────────────
 * A server action is a public HTTP endpoint, so the id this action searches on
 * behalf of has to come from the session and from nowhere else. `findJobsNow`
 * takes no parameters at all, which is the strongest version of that, and the
 * first test below is what keeps it true: it asserts the id handed to
 * `requestJobSearch` is the one the Auth server returned, not one the caller
 * could have chosen.
 *
 * The rest are the two refusals. Both cases would eventually be refused deeper
 * in the pipeline, by `claimApplicationRow`, and both would refuse silently
 * from the person's point of view: the event is accepted, a run starts, and
 * nothing ever appears. Answering in the same request is the whole point of
 * checking twice.
 *
 * `@/lib/job-search-trigger` is mocked rather than spied on here, unlike in
 * `tests/unit/job-search-trigger.test.ts`. That suite exists to prove the event
 * shape against the real pipeline module; this one is about who may cause one
 * at all, and pulling Stagehand into the graph to establish that would be cost
 * for nothing. The two halves meet at `requestJobSearch(userId)`, which both
 * files name explicitly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Typed with the parameter it really takes, so that a change to
// `requestJobSearch`'s signature is a type error here rather than a mock that
// quietly accepts anything.
const requestJobSearch = vi.fn(async (userId: string): Promise<void> => {
  void userId;
});
const getUser = vi.fn();
const profileRow = { attested_at: "2026-07-01T00:00:00.000Z", applications_used: 3, applications_cap: 150 };

let profile: Record<string, unknown> | null = profileRow;

vi.mock("@/lib/job-search-trigger", () => ({
  requestJobSearch: (userId: string) => requestJobSearch(userId),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => ({
    auth: { getUser },
    from() {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: profile, error: null }),
      };
      return chain;
    },
  }),
}));

const { findJobsNow } = await import("@/app/dashboard/actions");

const SESSION_USER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(() => {
  requestJobSearch.mockClear();
  profile = { ...profileRow };
  getUser.mockResolvedValue({ data: { user: { id: SESSION_USER, email: "me@example.com" } } });
});

describe("find jobs now", () => {
  it("searches for the session's user and takes no id from the caller", async () => {
    // `findJobsNow` deliberately has no parameters. If it ever grows one, this
    // assertion is what says the session is still the only source of the id.
    expect(findJobsNow.length).toBe(0);

    const result = await findJobsNow();

    expect(result).toEqual({ ok: true });
    expect(requestJobSearch).toHaveBeenCalledTimes(1);
    expect(requestJobSearch).toHaveBeenCalledWith(SESSION_USER);
  });

  it("sends no preferences, so the person's stored locations are what narrows it", async () => {
    await findJobsNow();

    // JOB-008's documented fallback. A second argument here would quietly
    // override the answers somebody gave at intake.
    expect(requestJobSearch.mock.calls[0]).toEqual([SESSION_USER]);
  });

  it("refuses when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await findJobsNow();

    expect(result.ok).toBe(false);
    expect(requestJobSearch).not.toHaveBeenCalled();
  });

  it("refuses before intake, because nothing may be submitted on an unattested profile", async () => {
    profile = { ...profileRow, attested_at: null };

    const result = await findJobsNow();

    expect(result).toEqual({
      ok: false,
      message: "Finish your intake first. We cannot apply for you until you have confirmed your answers.",
    });
    expect(requestJobSearch).not.toHaveBeenCalled();
  });

  it("refuses at the cap and says which number was reached", async () => {
    profile = { ...profileRow, applications_used: 150, applications_cap: 150 };

    const result = await findJobsNow();

    expect(result).toEqual({ ok: false, message: "You have used all 150 applications on your plan." });
    expect(requestJobSearch).not.toHaveBeenCalled();
  });

  it("refuses an unprovisioned account without telling it it is full", async () => {
    profile = { ...profileRow, applications_used: 0, applications_cap: 0 };

    const result = await findJobsNow();

    expect(result).toEqual({
      ok: false,
      message: "There are no applications on your plan yet, so there is nothing to search with.",
    });
    expect(requestJobSearch).not.toHaveBeenCalled();
  });
});
