// @vitest-environment node
/**
 * JOB-308 round two BLOCKING 1 and BLOCKING 2, and JOB-314 red team round
 * two BLOCKING 1 and MAJOR 2.
 *
 * saveIntakeDraft is a server action, so it is tested with a fake Supabase
 * client the way analytics-instrumentation.test.ts fakes it. The behaviors
 * this file locks down:
 *
 *  1. Step 1 with a resumePath writes a row into resumes. Without it,
 *     step-routing pins everyone at step 1 forever, since profiles has
 *     no resume_path column.
 *  2. Step 2 for a US citizen or permanent resident omits
 *     workAuthorizedUs and requiresSponsorship from the payload; the
 *     server derives them, so no answer we submit is one the user did
 *     not choose (HARD STOP 9).
 *  3. The `partial: true` path (Save and finish later) for steps 2, 3 and
 *     4 never turns an unanswered question into a stored true or false.
 *     Step 3 in particular: a JOB-314 red team round found that the
 *     original partial branch called deriveNeedsSponsorshipNonUs
 *     unconditionally, which fabricated a stored `false` for
 *     needs_sponsorship_non_us whenever a half filled draft had not named
 *     a non-US target location and had not answered willingToRelocate,
 *     even though the question was never shown to the user. That value
 *     then survived to submitIntake's attestation and was never displayed
 *     again on step 5, in violation of HARD STOP 9. The fix, and the
 *     tests below, distinguish "question not relevant yet" (store null)
 *     from "question relevant and the user gave a real answer" (store the
 *     derived value).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const RESUME_OBJECT = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
const RESUME_PATH = `${SESSION_USER}/${RESUME_OBJECT}.pdf`;

/** All the writes the fake client records so tests can assert what happened. */
type Write = {
  table: string;
  kind: "insert" | "update";
  values?: Record<string, unknown>;
};

const writes: Write[] = [];
const getUser = vi.fn();

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

const { saveIntakeDraft } = await import("@/app/onboarding/actions");

beforeEach(() => {
  writes.length = 0;
  getUser.mockResolvedValue({ data: { user: { id: SESSION_USER } } });
});

describe("saveIntakeDraft step 1", () => {
  it("writes a resumes row when a resumePath is provided", async () => {
    const result = await saveIntakeDraft(
      {
        githubUrl: null,
        resumePath: RESUME_PATH,
        linkedinPdfPath: null,
      },
      1,
    );

    expect(result.ok).toBe(true);
    const resumesInsert = writes.find(
      (w) => w.table === "resumes" && w.kind === "insert",
    );
    expect(resumesInsert).toBeDefined();
    expect(resumesInsert?.values?.user_id).toBe(SESSION_USER);
    expect(resumesInsert?.values?.storage_path).toBe(
      `resumes/${RESUME_PATH}`,
    );
    expect(resumesInsert?.values?.linkedin_pdf_path).toBeNull();
  });

  it("does not insert a resumes row when no resumePath is provided", async () => {
    const result = await saveIntakeDraft(
      { githubUrl: "https://github.com/handle" },
      1,
    );

    expect(result.ok).toBe(true);
    expect(writes.find((w) => w.table === "resumes")).toBeUndefined();
  });

  it("rejects a resumePath that names a different user's folder", async () => {
    const result = await saveIntakeDraft(
      {
        githubUrl: null,
        resumePath:
          "44444444-4444-4444-4444-444444444444/22222222-2222-2222-2222-222222222222.pdf",
      },
      1,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors?.resumePath).toBeDefined();
    expect(writes.find((w) => w.table === "resumes")).toBeUndefined();
  });
});

describe("saveIntakeDraft step 2", () => {
  it("accepts a US citizen payload that omits workAuthorizedUs and requiresSponsorship", async () => {
    const result = await saveIntakeDraft(
      {
        citizenshipStatus: "us_citizen",
        visaStatus: "None, US citizen",
      },
      2,
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    // Server-derived: US citizen is authorized and needs no sponsorship,
    // even though the client did not send those fields.
    expect(profileUpdate?.values?.work_authorized_us).toBe(true);
    expect(profileUpdate?.values?.requires_sponsorship).toBe(false);
  });

  it("accepts an F1 with an explicit workAuthorizedUs=false answer", async () => {
    const result = await saveIntakeDraft(
      {
        citizenshipStatus: "f1",
        f1Status: "none",
        visaStatus: "F-1",
        workAuthorizedUs: false,
        requiresSponsorship: true,
      },
      2,
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    // The user's own answer, not a fabricated true.
    expect(profileUpdate?.values?.work_authorized_us).toBe(false);
    expect(profileUpdate?.values?.requires_sponsorship).toBe(true);
  });

  it("rejects an F1 who omits workAuthorizedUs", async () => {
    const result = await saveIntakeDraft(
      {
        citizenshipStatus: "f1",
        f1Status: "opt",
        visaStatus: "F-1 on OPT",
        requiresSponsorship: true,
      },
      2,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors?.workAuthorizedUs).toBeDefined();
  });
});

describe("saveIntakeDraft step 2 partial (Save and finish later)", () => {
  it("stores null, not a fabricated false, for an F1 candidate who has not answered work authorization yet", async () => {
    const result = await saveIntakeDraft(
      {
        citizenshipStatus: "f1",
        f1Status: "opt",
        visaStatus: "F-1 on OPT",
        // workAuthorizedUs and requiresSponsorship intentionally omitted:
        // this person has not reached that question yet.
      },
      2,
      { partial: true },
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.work_authorized_us).toBeNull();
    expect(profileUpdate?.values?.requires_sponsorship).toBeNull();
  });

  it("still forces true / false for a US citizen even on a partial save, since that much is not in question", async () => {
    const result = await saveIntakeDraft(
      {
        citizenshipStatus: "us_citizen",
        // visaStatus intentionally omitted.
      },
      2,
      { partial: true },
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.work_authorized_us).toBe(true);
    expect(profileUpdate?.values?.requires_sponsorship).toBe(false);
  });
});

describe("saveIntakeDraft step 3 partial (Save and finish later)", () => {
  // JOB-314 red team round two BLOCKING 1. The bug: the original partial
  // branch called deriveNeedsSponsorshipNonUs unconditionally, which
  // resolves a question that either is not relevant yet or has not been
  // answered yet to a hard `false`, and wrote that false to
  // needs_sponsorship_non_us under the user's name before they had ever
  // seen the question, in violation of HARD STOP 9. The five cases below
  // pin the fixed behavior.

  it("stores null when targetLocations is empty and willingToRelocate is unanswered", async () => {
    const result = await saveIntakeDraft(
      {
        targetLocations: [],
        willingToRelocate: null,
      },
      3,
      { partial: true },
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.needs_sponsorship_non_us).toBeNull();
  });

  it("stores null when the only target named is Remote and willingToRelocate is unanswered", async () => {
    const result = await saveIntakeDraft(
      {
        targetLocations: ["Remote"],
        willingToRelocate: null,
      },
      3,
      { partial: true },
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.needs_sponsorship_non_us).toBeNull();
  });

  it("stores the user's own answer once the question is actually shown (non-US target named, willing to relocate)", async () => {
    const result = await saveIntakeDraft(
      {
        targetLocations: ["London", "San Francisco"],
        willingToRelocate: true,
        needsSponsorshipNonUs: true,
      },
      3,
      { partial: true },
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.needs_sponsorship_non_us).toBe(true);
  });

  it("passes an explicit false through once the question is shown, the same as any other real answer", async () => {
    const result = await saveIntakeDraft(
      {
        targetLocations: ["London", "San Francisco"],
        willingToRelocate: true,
        needsSponsorshipNonUs: false,
      },
      3,
      { partial: true },
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.needs_sponsorship_non_us).toBe(false);
  });

  it("stores null when the question is relevant and shown but the user has not picked yes or no yet", async () => {
    const result = await saveIntakeDraft(
      {
        targetLocations: ["London", "San Francisco"],
        willingToRelocate: true,
        // needsSponsorshipNonUs intentionally omitted: shown, not chosen.
      },
      3,
      { partial: true },
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.needs_sponsorship_non_us).toBeNull();
  });
});

describe("saveIntakeDraft step 4 partial (Save and finish later)", () => {
  it("stores null for clearance level when clearance eligibility is unanswered, matching the behavior already verified safe on the strict path", async () => {
    const result = await saveIntakeDraft(
      {
        salaryExpectation: "$120,000",
        // clearanceEligibility and clearanceLevelHeld intentionally
        // omitted: this person has not reached that question yet.
      },
      4,
      { partial: true },
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.clearance_level_held).toBeNull();
  });

  it("still forces never_held once clearance eligibility is explicitly answered no", async () => {
    const result = await saveIntakeDraft(
      {
        salaryExpectation: "$120,000",
        clearanceEligibility: "no",
      },
      4,
      { partial: true },
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.clearance_level_held).toBe("never_held");
  });
});
