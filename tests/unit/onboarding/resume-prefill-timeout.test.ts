// @vitest-environment node
/**
 * JOB-360 round one red team MAJOR 2: `runResumeParseForPrefill` used to
 * have no server side bound of its own, so a client that gave up after its
 * own 30 second timeout left the server still awaiting the model for the
 * full `LLM_TIMEOUT_MS` (120 seconds, in `lib/resume-parser.ts`), burning a
 * full call nobody was waiting on any more.
 *
 * `loadResume` and `extractResume` are mocked to a promise that never
 * settles, standing in for a model call that is taking far longer than
 * `LLM_TIMEOUT_MS` would ever actually allow. Fake timers let this test
 * assert the function gives up at its own 30 second budget without a real
 * clock ever running that long.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/resume-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resume-parser")>();
  return {
    ...actual,
    loadResume: vi.fn(async () => ({
      bytes: new Uint8Array(),
      text: "Ada Lovelace, Software Engineer",
      pageCount: 1,
    })),
    // Never resolves, standing in for a model call the server would
    // otherwise wait on for the full LLM_TIMEOUT_MS.
    extractResume: vi.fn(() => new Promise<never>(() => {})),
  };
});

const { runResumeParseForPrefill } = await import("@/lib/onboarding/resume-prefill");

describe("runResumeParseForPrefill server side timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up at its own 30 second budget rather than waiting on the model's full timeout", async () => {
    const supabase = {} as never;
    let settled = false;
    const resultPromise = runResumeParseForPrefill(supabase, {
      userId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      userEmail: "person@example.com",
      resumeObjectPath: "3f2504e0-4f89-41d3-9a0c-0305e82c3301/resume.pdf",
    }).finally(() => {
      settled = true;
    });

    // Advance only to the server's own 30 second budget, well short of the
    // model's 120 second LLM_TIMEOUT_MS, and confirm the promise has
    // already settled instead of still waiting on the model.
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(settled).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("30 seconds");
    }
  });
});
