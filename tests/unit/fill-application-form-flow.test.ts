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

  /**
   * A real Greenhouse embed URL rather than an invented careers page, because
   * `loadApplicationState` now refuses to open a listing whose host does not
   * belong to the board it came from. See `lib/apply-url-guard.ts`.
   */
  const APPLY_URL = "https://job-boards.greenhouse.io/embed/job_app?for=example&token=42";
  const BOARD_TOKEN = "example";
  const JOB_APPLICATION_ID = "11111111-1111-4111-8111-111111111111";
  const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
  /** `jobs.id`. The listing is its own row since JOB-004. */
  const JOB_ID = "33333333-3333-4333-8333-333333333333";

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
    /** What the listing row says its URL is. Overridden by the guard tests. */
    applyUrl: APPLY_URL,
    /** Every write the module made, so a terminal status can be asserted. */
    writes: [] as { table: string; op: "update" | "insert"; values: unknown }[],
    /** How many times a browser was opened. */
    browsersOpened: 0,
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
    state.applyUrl = APPLY_URL;
    state.writes = [];
    state.browsersOpened = 0;
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
    url: async () => state.applyUrl,
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
    BOARD_TOKEN,
    JOB_APPLICATION_ID,
    CANDIDATE_ID,
    JOB_ID,
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

/**
 * The database, as three tables rather than actinno's two (JOB-004).
 *
 * `loadApplicationState` now reads `applications` with the listing and the
 * employer embedded, and reaches `loadCandidate` for the person, which is two
 * more reads again. So the client is a chainable stub rather than a fixed
 * `select().eq().limit()` shape: every filter returns the builder and the
 * builder is thenable, which is close enough to PostgREST's own interface that
 * a query changing its filters does not have to change this mock.
 */
vi.mock("@supabase/supabase-js", () => {
  // Built per query rather than once, so that a test moving `state.applyUrl`
  // moves what the row says.
  const tables = (): Record<string, unknown[]> => ({
    applications: [
      {
        id: h.JOB_APPLICATION_ID,
        user_id: h.CANDIDATE_ID,
        job_id: h.JOB_ID,
        status: "discovered",
        // PostgREST returns a to-one embed as a nested object, which is what
        // `loadApplicationState` unwraps.
        jobs: {
          title: "Software Engineer Intern",
          url: h.state.applyUrl,
          ats: "greenhouse",
          boards: { company: "Example", board_token: h.BOARD_TOKEN },
        },
      },
    ],
    profiles: [
      {
        id: h.CANDIDATE_ID,
        email: "candidate@example.com",
        target_locations: null,
        work_authorized_us: null,
        requires_sponsorship: null,
        current_country: null,
        current_city: null,
        willing_to_relocate: null,
      },
    ],
    resumes: [
      { storage_path: "resumes/candidate.pdf", created_at: "2026-01-01T00:00:00.000Z" },
    ],
  });

  const builder = (table: string) => {
    const rows = tables();
    const result = { data: rows[table] ?? [], error: null };
    const chain: Record<string, unknown> = {
      single: async () => ({ data: rows[table]?.[0] ?? null, error: null }),
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    for (const method of ["select", "eq", "ilike", "in", "gte", "order", "limit", "upsert"]) {
      chain[method] = () => chain;
    }
    for (const op of ["update", "insert"] as const) {
      chain[op] = (values: unknown) => {
        h.state.writes.push({ table, op, values });
        return chain;
      };
    }
    return chain;
  };

  return { createClient: () => ({ from: (table: string) => builder(table) }) };
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
  openBrowserSession: async () => {
    h.state.browsersOpened += 1;
    return h.session;
  },
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

import { BlockedApplyUrlError, fillApplicationForm } from "@/lib/fill-application-form";
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

// ───────────────────────────────────
// Where the browser is allowed to go
// ───────────────────────────────────

/**
 * The second half of the apply URL fix. `lib/board-ingest.ts` screens a listing
 * before it is stored, and this is the same rule applied again by the module
 * that navigates, because two entry points reach it with a row ingest never
 * saw (`lib/fill-form-cli.ts` and `lib/submit-application-cli.ts`) and because
 * rows written before the screen existed are still in the table.
 *
 * What is asserted is not only that it refuses. It is that it refuses *before*
 * a browser exists, and that it leaves the row saying so.
 */
describe("an apply URL that does not belong to the board it came from", () => {
  const REFUSED = [
    // The exfiltration case: a page of the tenant's choosing, which the flow
    // would otherwise read as an application form and hand a real resume to.
    "https://example-careers.attacker.example/apply/42",
    // The same platform, somebody else's board.
    "https://job-boards.greenhouse.io/embed/job_app?for=attacker&token=42",
    // A different supported platform than the listing was read from.
    "https://jobs.lever.co/example/42/apply",
    // Our own host's metadata endpoint, which the local browser fallback can
    // genuinely reach.
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:3000/apply",
    // Right host, wrong scheme.
    "http://job-boards.greenhouse.io/embed/job_app?for=example&token=42",
  ];

  it.each(REFUSED)("refuses %s without opening a browser", async (url) => {
    h.state.applyUrl = url;

    await expect(run()).rejects.toBeInstanceOf(BlockedApplyUrlError);
    expect(h.state.browsersOpened).toBe(0);
  });

  it("writes form_fill_blocked on the row and a skip_log row saying why", async () => {
    h.state.applyUrl = "https://example-careers.attacker.example/apply/42";

    await expect(run()).rejects.toThrow(/Refusing to open the apply URL/);

    // The terminal status, so nothing picks the row up again expecting it to
    // work this time.
    const statuses = h.state.writes
      .filter((write) => write.table === "applications" && write.op === "update")
      .map((write) => (write.values as { status?: string }).status);
    expect(statuses).toEqual(["form_fill_blocked"]);
    // In particular the row never passed through `filling_form`, because nothing
    // was ever filled.
    expect(statuses).not.toContain("filling_form");

    // And the reason, in the one place this schema keeps reasons.
    const skips = h.state.writes.filter(
      (write) => write.table === "skip_log" && write.op === "insert"
    );
    expect(skips).toHaveLength(1);
    const skip = skips[0]!.values as {
      application_id: string;
      job_id: string;
      ats: string;
      reason: string;
      raw_context: { message: string };
    };
    expect(skip.application_id).toBe(h.JOB_APPLICATION_ID);
    expect(skip.job_id).toBe(h.JOB_ID);
    expect(skip.ats).toBe("greenhouse");
    expect(skip.reason).toBe("dom_changed");
    expect(skip.raw_context.message).toContain("attacker.example");
  });

  it("still runs the ordinary flow for the board's own URL", async () => {
    // The regression guard. A check this strict is only correct if the real
    // listing shape still goes through, so the default fixture is asserted
    // rather than assumed.
    const result = await run();
    expect(result.status).toBe("form_filled");
    expect(result.blockedReason).toBeNull();
    expect(h.state.browsersOpened).toBe(1);
  });
});
