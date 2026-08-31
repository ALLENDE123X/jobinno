// @vitest-environment node
/**
 * JOB-308 round two BLOCKING 1 and BLOCKING 2, extended by JOB-312.
 *
 * saveIntakeDraft is a server action, so it is tested with a fake Supabase
 * client the way analytics-instrumentation.test.ts fakes it. The
 * behaviors this file locks down:
 *
 *  1. Step 1 with a resumePath writes a row into resumes. Without it,
 *     step-routing pins everyone at step 1 forever, since profiles has
 *     no resume_path column.
 *  2. Step 2 for a US citizen or permanent resident omits
 *     workAuthorizedUs and requiresSponsorship from the payload; the
 *     server derives them, so no answer we submit is one the user did
 *     not choose (HARD STOP 9).
 *  3. Step 2 for a US citizen or permanent resident also omits
 *     visaStatus; the server derives the correct string via
 *     prefillVisaStatus regardless of what, if anything, the client
 *     sent, and an F1's own visaStatus answer is written through as is.
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
  it("accepts a US citizen payload that omits workAuthorizedUs, requiresSponsorship and visaStatus", async () => {
    const result = await saveIntakeDraft(
      {
        citizenshipStatus: "us_citizen",
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
    // JOB-312: visa_status is server-derived via prefillVisaStatus too.
    expect(profileUpdate?.values?.visa_status).toBe("None, US citizen");
  });

  it("derives the permanent resident visa string when visaStatus is omitted", async () => {
    const result = await saveIntakeDraft(
      {
        citizenshipStatus: "permanent_resident",
      },
      2,
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.visa_status).toBe("Permanent resident");
    expect(profileUpdate?.values?.work_authorized_us).toBe(true);
    expect(profileUpdate?.values?.requires_sponsorship).toBe(false);
  });

  it("overrides a client supplied visaStatus for a US citizen with the derived value", async () => {
    // Defense in depth: even if a payload names an arbitrary visaStatus for
    // a US citizen, the server is the sole author of that value, exactly
    // like it already is for workAuthorizedUs and requiresSponsorship.
    const result = await saveIntakeDraft(
      {
        citizenshipStatus: "us_citizen",
        visaStatus: "something else entirely",
      },
      2,
    );

    expect(result.ok).toBe(true);
    const profileUpdate = writes.find(
      (w) => w.table === "profiles" && w.kind === "update",
    );
    expect(profileUpdate?.values?.visa_status).toBe("None, US citizen");
  });

  it("accepts an F1 with an explicit workAuthorizedUs=false answer and writes their own visaStatus", async () => {
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
    // The user's own words, written through unchanged.
    expect(profileUpdate?.values?.visa_status).toBe("F-1");
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

  it("rejects an F1 who omits visaStatus", async () => {
    const result = await saveIntakeDraft(
      {
        citizenshipStatus: "f1",
        f1Status: "opt",
        workAuthorizedUs: true,
        requiresSponsorship: false,
      },
      2,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors?.visaStatus).toBeDefined();
  });
});
