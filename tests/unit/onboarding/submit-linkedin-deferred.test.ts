// @vitest-environment node
/**
 * JOB-330. `submitLinkedInDeferred` is the server action behind the second
 * lane on step 1 of onboarding. Same shape as
 * `tests/unit/onboarding/save-intake-draft.test.ts` for the sibling
 * server action: a fake Supabase client, `revalidatePath` stubbed, and
 * an inspection of what the action did and did not write.
 *
 * These tests lock down:
 *
 *  1. A well shaped LinkedIn URL is written to
 *     `profiles.linkedin_url_pending` (normalized to a leading https://)
 *     and the follow-up email is dispatched.
 *  2. A malformed URL is refused with a field error and nothing gets
 *     written or emailed.
 *  3. An email send failure is swallowed (best effort — the write is the
 *     point of no return) and the action still returns ok.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SESSION_EMAIL = "someone@example.test";

type Write = {
  table: string;
  kind: "insert" | "update";
  values?: Record<string, unknown>;
};

const writes: Write[] = [];
const getUser = vi.fn();
const sendMock = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  RESUMES_BUCKET: "resumes",
  createServerClient: async () => ({
    auth: { getUser },
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (values: Record<string, unknown>) => {
          writes.push({ table, kind: "update", values });
          return chain;
        },
        insert: (values: Record<string, unknown>) => {
          writes.push({ table, kind: "insert", values });
          return chain;
        },
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (
          resolve: (value: { error: { message: string } | null }) => unknown,
        ) => Promise.resolve(resolve({ error: null })),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/resume-followup/email", () => ({
  sendResumeFollowupEmail: (input: unknown) => sendMock(input),
  buildResumeFollowupIdempotencyKey: (id: string) => `key-for-${id}`,
}));

const { submitLinkedInDeferred } = await import("@/app/onboarding/actions");

beforeEach(() => {
  writes.length = 0;
  getUser.mockResolvedValue({
    data: { user: { id: SESSION_USER, email: SESSION_EMAIL } },
  });
  sendMock.mockReset();
  sendMock.mockResolvedValue({ sent: true });
});

describe("submitLinkedInDeferred", () => {
  it("writes the URL to profiles.linkedin_url_pending and fires the follow-up email", async () => {
    const result = await submitLinkedInDeferred(
      "linkedin.com/in/pranavlende",
    );

    expect(result).toEqual({ ok: true });

    const update = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(update).toBeDefined();
    // Bare linkedin.com/in/handle is normalized to https:// before write.
    expect(update?.values?.linkedin_url_pending).toBe(
      "https://linkedin.com/in/pranavlende",
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const arg = sendMock.mock.calls[0][0] as {
      to: string;
      subject: string;
      idempotencyKey?: string;
    };
    expect(arg.to).toBe(SESSION_EMAIL);
    expect(arg.subject).toBe("finish your Jobinno signup from your laptop");
    expect(arg.idempotencyKey).toBe(`key-for-${SESSION_USER}`);
  });

  it("refuses a malformed URL and writes nothing", async () => {
    const result = await submitLinkedInDeferred("not a url");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors?.linkedinUrl).toBeDefined();
    expect(writes).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("refuses a URL from the wrong domain (HARD STOP 9: never a portfolio or GitHub instead)", async () => {
    const result = await submitLinkedInDeferred("https://github.com/pat");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors?.linkedinUrl).toBeDefined();
    expect(writes).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still returns ok when the follow-up email fails to send (best effort)", async () => {
    sendMock.mockResolvedValue({ sent: false, reason: "rejected" });

    const result = await submitLinkedInDeferred(
      "https://linkedin.com/in/pranavlende",
    );

    // The URL write is the point of no return; the person's next visit
    // already lands on step 2, so a mail send that misses is a followup
    // problem, not a submit blocker. The action still succeeds.
    expect(result).toEqual({ ok: true });
    const update = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(update).toBeDefined();
  });

  it("returns a session error when nobody is signed in, and writes nothing", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const result = await submitLinkedInDeferred(
      "https://linkedin.com/in/pranavlende",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/session/i);
    expect(writes).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
