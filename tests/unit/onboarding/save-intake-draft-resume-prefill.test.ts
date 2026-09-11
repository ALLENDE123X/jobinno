// @vitest-environment node
/**
 * JOB-360. Covers the step 1 branch of `saveIntakeDraft` that persists the
 * pre fill parse once the resumes row it belongs to actually exists.
 * `persistResumePrefillParse` is mocked so this never touches a real
 * service role client; `ResumePrefillDefaultsSchema` stays real so an
 * actually malformed payload is what makes these tests exercise the
 * fall through path, not a mock returning the wrong thing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const RESUME_OBJECT = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
const RESUME_PATH = `${SESSION_USER}/${RESUME_OBJECT}.pdf`;
const INSERTED_RESUME_ID = "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f8a9";

const validExtracted = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: null,
  phone: null,
  location: "London, UK",
  linkedinUrl: null,
  websiteUrl: null,
  workHistory: [],
  education: [],
  skills: [],
};

const validDefaults = {
  citizenshipStatus: null,
  workAuthorizedUs: null,
  currentCity: "London, UK",
  targetLocations: ["London, UK"],
  gradDate: null,
};

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/onboarding/resume-prefill", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/onboarding/resume-prefill")>();
  return { ...actual, persistResumePrefillParse: vi.fn() };
});

vi.mock("@/lib/supabase/server", () => ({
  RESUMES_BUCKET: "resumes",
  createServerClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: SESSION_USER } } }),
    },
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: () => chain,
        insert: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () =>
          table === "resumes"
            ? { data: { id: INSERTED_RESUME_ID }, error: null }
            : { data: null, error: null },
        then: (resolve: (value: { error: null }) => unknown) =>
          Promise.resolve(resolve({ error: null })),
      };
      return chain;
    },
  }),
}));

const { saveIntakeDraft } = await import("@/app/onboarding/actions");
const { persistResumePrefillParse } = await import(
  "@/lib/onboarding/resume-prefill"
);

beforeEach(() => {
  vi.mocked(persistResumePrefillParse).mockClear();
});

describe("saveIntakeDraft step 1 resume prefill persistence", () => {
  it("persists the parse once the resumes row exists", async () => {
    const result = await saveIntakeDraft(
      {
        githubUrl: null,
        resumePath: RESUME_PATH,
        linkedinPdfPath: null,
        resumeExtracted: validExtracted,
        resumeDefaults: validDefaults,
      },
      1,
    );

    expect(result.ok).toBe(true);
    expect(persistResumePrefillParse).toHaveBeenCalledWith(
      INSERTED_RESUME_ID,
      `resumes/${RESUME_PATH}`,
      validExtracted,
      validDefaults,
    );
  });

  it("does not persist when resumeExtracted is malformed", async () => {
    const result = await saveIntakeDraft(
      {
        githubUrl: null,
        resumePath: RESUME_PATH,
        linkedinPdfPath: null,
        resumeExtracted: { not: "a valid extraction" },
        resumeDefaults: validDefaults,
      },
      1,
    );

    expect(result.ok).toBe(true);
    expect(persistResumePrefillParse).not.toHaveBeenCalled();
  });

  it("does not persist when the earlier client side parse never ran", async () => {
    const result = await saveIntakeDraft(
      {
        githubUrl: null,
        resumePath: RESUME_PATH,
        linkedinPdfPath: null,
        resumeExtracted: null,
        resumeDefaults: null,
      },
      1,
    );

    expect(result.ok).toBe(true);
    expect(persistResumePrefillParse).not.toHaveBeenCalled();
  });
});
