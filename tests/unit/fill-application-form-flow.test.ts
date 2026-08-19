// @vitest-environment node
/**
 * JOB-006. Two orderings the shared form action cache depends on, exercised
 * through `fillApplicationForm` itself rather than through the cache module's
 * pure functions.
 *
 * `tests/unit/form-action-cache.test.ts` covers the cache in isolation, and that
 * is the right level for a fingerprint or a plan lookup. It is the wrong level
 * for the two things below, because both are properties of the *sequence* the
 * flow runs in and neither is visible from inside the module:
 *
 *  1. The fingerprint is taken after the cover letter has been switched to
 *     manual entry, so the key describes the form that is about to be filled
 *     rather than the one that was on screen a moment earlier. Taking it a few
 *     lines sooner produces a different key and files a "this form has no cover
 *     letter box" answer against a form that has one.
 *
 *  2. A replayed selector with nothing in the DOM to corroborate it sends the
 *     run back to a live observation instead of being typed into.
 *
 * Nothing here opens a browser, calls a model or touches a database. The browser
 * is a plain object whose page answers whatever the test wants the DOM to say,
 * and the module boundaries around the flow are mocked so that the flow itself
 * is the only real code under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  type Resolution = { selector: string; description: string; replayed: boolean } | null;

  const APPLY_URL = "https://careers.example.com/jobs/42/apply";
  const JOB_APPLICATION_ID = "11111111-1111-4111-8111-111111111111";
  const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";

  /**
   * The one control every run in this file clicks. A test that cares about a
   * field's own resolution overrides this and keeps the branch.
   */
  const manualEntryOnly = (instruction: string): Resolution =>
    instruction.includes("switches the cover letter")
      ? {
          selector: "xpath=/html[1]/body[1]/main[1]/form[1]/a[1]",
          description: 'the "Enter manually" link beside the cover letter upload',
          replayed: false,
        }
      : null;

  const state = {
    /** Flipped by the click, exactly as the real page would be. */
    manualEntryClicked: false,
    /** What `tryResolveAction` answers for an instruction. */
    resolve: manualEntryOnly,
    /** The last value `typeInto` was given, which is what the page reads back. */
    lastTyped: "",
    /** What the DOM says about the control `describeControl` asks about. */
    descriptor: {
      found: false,
      tag: "",
      type: "",
      haystack: "",
      attachedFiles: -1,
      text: "",
      role: "",
    },
    /** Every step worth ordering, in the order it happened. */
    events: [] as string[],
    /** The shape each `loadActionPlan` was handed. */
    shapes: [] as { fingerprint: string; slots: string[] }[],
  };

  const reset = (): void => {
    state.manualEntryClicked = false;
    state.resolve = manualEntryOnly;
    state.lastTyped = "";
    state.descriptor = {
      found: false,
      tag: "",
      type: "",
      haystack: "",
      attachedFiles: -1,
      text: "",
      role: "",
    };
    state.events = [];
    state.shapes = [];
  };

  /**
   * What the page reader sees. The cover letter box does not exist until the
   * manual entry control has been pressed, which is the whole point of the
   * ordering this file is about.
   */
  const readPage = () => ({
    applicationFormPresent: true,
    applyControlPresent: false,
    signInFormPresent: false,
    verificationCodeFieldPresent: false,
    firstNameFieldPresent: true,
    lastNameFieldPresent: true,
    fullNameFieldPresent: false,
    emailFieldPresent: true,
    phoneFieldPresent: false,
    linkedinFieldPresent: false,
    websiteFieldPresent: false,
    resumeUploadPresent: false,
    coverLetterTextAreaPresent: state.manualEntryClicked,
    coverLetterUploadPresent: true,
    coverLetterManualEntryControlPresent: !state.manualEntryClicked,
    passwordFieldCount: 0,
    fileInputCount: 0,
    submitApplicationControlLabels: ["Submit Application"],
    captchaPresent: false,
    captchaEvidence: "",
    applicationLikelySubmitted: false,
    applicationLikelySubmittedEvidence: "",
  });

  /**
   * The controls a DOM read finds. `currentValue` is non empty throughout so the
   * ACT-015 pass has nothing left to do and the test stays about the ordering.
   */
  const control = (label: string, kind: string, selector: string) => ({
    key: label.toLowerCase(),
    selector,
    activateSelectors: [],
    label,
    kind,
    required: false,
    currentValue: "already answered",
    options: [],
    optionSelectors: [],
    optionValues: [],
    optionsKnown: true,
    optionsTruncated: false,
    maxLength: null,
    helpText: "",
  });

  /** A self hosted careers page: no ids anywhere, so every selector is an XPath. */
  const formControls = () => [
    control("First Name", "text", "xpath=/html[1]/body[1]/main[1]/form[1]/div[1]/input[1]"),
    control("Last Name", "text", "xpath=/html[1]/body[1]/main[1]/form[1]/div[2]/input[1]"),
    control("Email", "text", "xpath=/html[1]/body[1]/main[1]/form[1]/div[3]/input[1]"),
    ...(state.manualEntryClicked
      ? [
          control(
            "Cover Letter",
            "textarea",
            "xpath=/html[1]/body[1]/main[1]/form[1]/div[4]/textarea[1]"
          ),
        ]
      : []),
  ];

  const page = {
    goto: async () => undefined,
    url: async () => APPLY_URL,
    title: async () => "Careers at Example",
    evaluate: async (script: unknown) =>
      String(script).includes("passwordFields")
        ? { passwordFields: 0, fileInputs: 0, textAreas: 1, iframes: 0, textLength: 4000 }
        : state.descriptor,
    screenshot: async () => new Uint8Array([1, 2, 3]),
    locator: () => ({
      inputValue: async () => state.lastTyped,
      setInputFiles: async () => undefined,
    }),
  };

  const session = {
    logTag: "[test]",
    actionPlan: null as unknown,
    browser: {},
    page,
    stagehand: {
      extract: async () => ({ data: readPage() }),
      act: async (action: { description?: string }) => {
        const description = action.description ?? "";
        if (description.includes("switches the cover letter")) {
          state.manualEntryClicked = true;
          state.events.push("clicked the cover letter manual entry control");
        } else {
          state.events.push(`acted on ${description}`);
        }
      },
      observe: async () => ({ data: [] }),
    },
  };

  return {
    state,
    reset,
    session,
    formControls,
    manualEntryOnly,
    APPLY_URL,
    JOB_APPLICATION_ID,
    CANDIDATE_ID,
  };
});

// ───────────────────────────────────
// Everything around the flow, stood in for
// ───────────────────────────────────

vi.mock("@/lib/supabase-project-guard", () => ({
  assertSupabaseProject: () => undefined,
}));

// Only reached on the verification path, and it drags `googleapis` in with it.
vi.mock("@/lib/future-gmail/gmail-verification-listener", () => ({
  allowedSenderDomains: () => [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: async () => undefined,
  writeFile: async () => undefined,
}));

vi.mock("@supabase/supabase-js", () => {
  const rows: Record<string, unknown[]> = {
    job_applications: [
      {
        id: h.JOB_APPLICATION_ID,
        candidate_id: h.CANDIDATE_ID,
        company: "Example",
        job_title: "Software Engineer Intern",
        apply_url: h.APPLY_URL,
        status: "no_account_required",
        board_password: null,
      },
    ],
    candidates: [
      {
        id: h.CANDIDATE_ID,
        resume_url: "resumes/candidate.pdf",
        linkedin_url: null,
        application_email: "candidate@example.com",
        work_authorized_us: null,
        requires_sponsorship: null,
        current_country: null,
        current_city: null,
        willing_to_relocate: null,
      },
    ],
  };
  return {
    createClient: () => ({
      from(table: string) {
        return {
          select: () => ({
            eq: () => ({
              limit: async () => ({ data: rows[table] ?? [], error: null }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
          upsert: async () => ({ error: null }),
        };
      },
    }),
  };
});

vi.mock("@/lib/resume-parser", () => ({
  loadResume: async () => ({
    bytes: new Uint8Array([37, 80, 68, 70]),
    text: "resume text",
    pageCount: 1,
  }),
  parseResume: async () => ({
    firstName: "Ada",
    lastName: "Lovelace",
    email: "candidate@example.com",
    phone: null,
    location: null,
    linkedinUrl: null,
    websiteUrl: null,
    workHistory: [],
    education: [],
    skills: [],
    resumeStatedEmail: null,
    warnings: [],
  }),
  generateCoverLetter: async () => "A cover letter grounded in the intake data.",
  decideFieldAnswers: async () => [],
  generateEssayAnswer: async () => "",
  InjectionSuspectedError: class InjectionSuspectedError extends Error {},
}));

vi.mock("@/lib/stagehand-session", () => ({
  NAVIGATION_TIMEOUT_MS: 30_000,
  openBrowserSession: async () => h.session,
  closeBrowserSession: async () => undefined,
  typeInto: async (_session: unknown, _url: string, instruction: string, value: string) => {
    h.state.events.push(`typed into ${instruction}`);
    h.state.lastTyped = value;
    return { selector: "xpath=/html[1]/body[1]/main[1]/form[1]/div[3]/input[1]", description: instruction };
  },
  tryResolveAction: async (_session: unknown, _url: string, instruction: string) => {
    const resolution = h.state.resolve(instruction);
    if (resolution === null) return null;
    return {
      action: { selector: resolution.selector, description: resolution.description },
      cacheKey: instruction,
      cached: false,
      replayed: resolution.replayed,
    };
  },
  reResolveLive: vi.fn(async (_session: unknown, _url: string, instruction: string) => {
    h.state.events.push(`re-observed ${instruction} live`);
    return null;
  }),
}));

vi.mock("@/lib/form-fields", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/form-fields")>()),
  enumerateFormFields: async () => h.formControls(),
}));

vi.mock("@/lib/form-action-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/form-action-cache")>();
  return {
    ...actual,
    loadActionPlan: async (
      _client: unknown,
      shape: import("@/lib/form-action-cache").FormShape,
      cacheable: ReadonlyMap<string, import("@/lib/form-action-cache").CoreSlot>
    ) => {
      h.state.events.push("fingerprinted the form and looked the plan up");
      h.state.shapes.push({ fingerprint: shape.fingerprint, slots: [...shape.slots].sort() });
      return actual.emptyActionPlan(shape, cacheable);
    },
    saveActionPlan: async () => undefined,
  };
});

import { fillApplicationForm } from "@/lib/fill-application-form";
import { fingerprintFormShape } from "@/lib/form-action-cache";
import { reResolveLive } from "@/lib/stagehand-session";

const run = () =>
  fillApplicationForm({
    jobApplicationId: h.JOB_APPLICATION_ID,
    requiresCoverLetter: true,
    headless: true,
    screenshotDir: "/tmp/jobinno-test-screenshots",
  });

beforeEach(() => {
  h.reset();
  vi.mocked(reResolveLive).mockClear();
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ───────────────────────────────────
// When the fingerprint is taken
// ───────────────────────────────────

describe("the form shape is fingerprinted after the page has settled", () => {
  it("keys the cache on the form that includes the cover letter box", async () => {
    const result = await run();
    expect(result.blockedReason).toBeNull();

    // One lookup, and it happened after the click rather than before it.
    expect(h.state.shapes).toHaveLength(1);
    expect(h.state.events.indexOf("clicked the cover letter manual entry control")).toBeGreaterThan(
      -1
    );
    expect(h.state.events.indexOf("clicked the cover letter manual entry control")).toBeLessThan(
      h.state.events.indexOf("fingerprinted the form and looked the plan up")
    );

    // And the key describes the form as it stands after the click. This is the
    // assertion a regression trips: a fingerprint taken before the click has no
    // cover letter slot in it, so a stored "no cover letter box here" answer
    // would be filed against a form that grew one.
    expect(h.state.shapes[0]!.slots).toContain("coverLetter");
  });

  it("would key it differently if it were taken before the click", async () => {
    // The same read run against the pre-click DOM, to show the two keys are not
    // the same key. Without this the test above could pass on a form whose shape
    // does not depend on the click at all.
    const beforeTheClick = fingerprintFormShape(
      "unknown",
      h.formControls().map(({ label, kind, selector }) => ({ label, kind, selector }))
    );

    await run();

    expect(h.state.shapes[0]!.fingerprint).not.toBe(beforeTheClick.fingerprint);
  });
});

// ───────────────────────────────────
// What a replayed selector is worth
// ───────────────────────────────────

describe("a replayed selector with no DOM evidence behind it", () => {
  /** Somebody else's absolute XPath, served here because the fingerprints collided. */
  const FOREIGN_SELECTOR = "xpath=/html[1]/body[1]/section[3]/form[2]/p[9]/input[1]";

  const replayTheEmailField = (): void => {
    h.state.resolve = (instruction: string) => {
      if (instruction.includes("email address input")) {
        // What `resolveAction` hands back for a replay: the caller's own
        // instruction as the description, because no model wrote one.
        return { selector: FOREIGN_SELECTOR, description: instruction, replayed: true };
      }
      return h.manualEntryOnly(instruction);
    };
  };

  it("is re-observed live rather than typed into when the selector resolves to nothing", async () => {
    replayTheEmailField();
    // The selector reaches nothing in this document, which is what an iframe or
    // a foreign page's XPath looks like from here.
    h.state.descriptor = { ...h.state.descriptor, found: false };

    const result = await run();

    expect(vi.mocked(reResolveLive)).toHaveBeenCalledTimes(1);
    const [, , instruction, why] = vi.mocked(reResolveLive).mock.calls[0]!;
    expect(instruction).toContain("email address input");
    expect(String(why)).toContain("shared form action cache");

    const email = result.fields.find((entry) => entry.field === "email");
    expect(email?.outcome).not.toBe("filled");
    expect(h.state.events).not.toContain("typed into the email address input on the job application form");
  });

  it("is re-observed live when it resolves to a control that says nothing about itself", async () => {
    replayTheEmailField();
    h.state.descriptor = {
      ...h.state.descriptor,
      found: true,
      tag: "input",
      type: "text",
      haystack: "",
    };

    const result = await run();

    expect(vi.mocked(reResolveLive)).toHaveBeenCalledTimes(1);
    const email = result.fields.find((entry) => entry.field === "email");
    expect(email?.outcome).not.toBe("filled");
  });

  it("is accepted when the control in the DOM says it is the right field", async () => {
    // The cache still has to be worth having. A replay the page corroborates is
    // used, and no model call is made for it.
    replayTheEmailField();
    h.state.descriptor = {
      ...h.state.descriptor,
      found: true,
      tag: "input",
      type: "text",
      haystack: "applicant_email | Email address",
    };

    const result = await run();

    expect(vi.mocked(reResolveLive)).not.toHaveBeenCalled();
    const email = result.fields.find((entry) => entry.field === "email");
    expect(email?.outcome).toBe("filled");
  });
});
