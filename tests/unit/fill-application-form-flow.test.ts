// @vitest-environment node
/**
 * Properties of `fillApplicationForm`'s *sequence*, exercised through the real
 * function rather than through the pure helpers underneath it. None of them is
 * visible from inside any single module, which is what puts them at this level.
 *
 * `tests/unit/form-action-cache.test.ts` covers the shared cache in isolation,
 * and that is the right level for a fingerprint or a plan lookup. It is the
 * wrong level for the first two below, which JOB-006 contributed:
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
 * The apply URL blocks came next, and JOB-021 added the last block in the file:
 * the page is never read before it exists. That is the bug which failed 16 of 21
 * real applications on the first production run, and its fixture is a page that
 * arrives in pieces, which is what a client hydrated careers SPA is.
 *
 * Nothing here opens a browser, calls a model or touches a database. The browser
 * is a plain object whose page answers whatever the test wants the DOM to say,
 * and the module boundaries around the flow are mocked so that the flow itself
 * is the only real code under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  type Resolution = { selector: string; description: string; replayed: boolean } | null;

  /** What `STRUCTURAL_FLOOR_SCRIPT` answers with. Mirrors the module's own type. */
  type StructuralFloor = {
    passwordFields: number;
    fileInputs: number;
    textAreas: number;
    iframes: number;
    ordinaryInputs: number;
    textLength: number;
  };

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
    /**
     * Where the browser really is, which is not the same question as what the
     * row says. Null means it went where it was sent; a string is a redirect the
     * board answered the navigation with, or a page a click led to.
     */
    landedUrl: null as string | null,
    /** Set `landedUrl` to this the first time anything is typed into the form. */
    moveOnFirstType: null as string | null,
    /** What the structural DOM read reports. One file input turns the upload on. */
    fileInputs: 0,
    /** How many times a resume file was actually set on a control. */
    resumeAttachments: 0,
    /** Every write the module made, so a terminal status can be asserted. */
    writes: [] as { table: string; op: "update" | "insert"; values: unknown }[],
    /** How many times a browser was opened. */
    browsersOpened: 0,

    // ── JOB-021: a page that arrives in pieces ────────────────────────────
    /**
     * The DOM's own shape, one entry per structural read, last entry repeating
     * forever. Null means the fixed shape every other test in this file uses.
     *
     * A list rather than a timer because `sleep` is stubbed out here: what the
     * settle step actually does is read the DOM, wait, and read it again until
     * two reads agree, so "how many times has it been read" is the real clock.
     */
    floors: null as StructuralFloor[] | null,
    /** How many times the structural floor script has been evaluated. */
    domReads: 0,
    /** The last structural shape handed back, whatever produced it. */
    lastFloor: null as StructuralFloor | null,
    /** The DOM's shape at the moment of each `extract`, in order. */
    floorsAtExtract: [] as (StructuralFloor | null)[],
    /** How many structural reads had happened when the first `extract` ran. */
    domReadsAtFirstExtract: 0,
    /** How many times the page reader has been asked what is on screen. */
    extractCalls: 0,
    /** Every `waitForSelector` the flow made, with what it asked for. */
    selectorWaits: [] as { selector: string; state?: string; timeout?: number }[],
    /**
     * Overrides for what the reader reports, by 1-based `extract` call number.
     * A board whose form mounts late answers differently on the first call than
     * on the second, which no fixed fixture can express.
     */
    signalsOverride: null as null | ((call: number) => Record<string, unknown>),
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
    state.landedUrl = null;
    state.moveOnFirstType = null;
    state.fileInputs = 0;
    state.resumeAttachments = 0;
    state.writes = [];
    state.browsersOpened = 0;
    state.floors = null;
    state.domReads = 0;
    state.lastFloor = null;
    state.floorsAtExtract = [];
    state.domReadsAtFirstExtract = 0;
    state.extractCalls = 0;
    state.selectorWaits = [];
    state.signalsOverride = null;
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

  /** The fixed shape every test that is not about hydration reads. */
  const settledFloor = (): StructuralFloor => ({
    passwordFields: 0,
    fileInputs: state.fileInputs,
    textAreas: 1,
    iframes: 0,
    ordinaryInputs: 3,
    textLength: 4000,
  });

  /**
   * One structural read. When `state.floors` is set the reads walk that list and
   * then stay on its last entry, which is a page that finishes arriving; with it
   * unset every read answers the same thing, which is a page that already had.
   */
  const readFloor = (): StructuralFloor => {
    state.domReads += 1;
    const scripted = state.floors;
    const floor =
      scripted === null
        ? settledFloor()
        : scripted[Math.min(state.domReads - 1, scripted.length - 1)]!;
    state.lastFloor = floor;
    return floor;
  };

  const page = {
    goto: async () => undefined,
    // Where the browser is, not where it was sent. `goto` follows redirects, so
    // these are two different strings whenever `landedUrl` is set.
    url: async () => state.landedUrl ?? state.applyUrl,
    title: async () => "Careers at Example",
    /**
     * Resolves as soon as it is asked, the way the real one does on a page that
     * has already mounted something. A test that wants the miss branch would
     * override this; none does, because the miss is only ever logged.
     */
    waitForSelector: async (selector: string, options?: { state?: string; timeout?: number }) => {
      state.selectorWaits.push({ selector, ...options });
      state.events.push("waited for the page to have content");
      return true;
    },
    evaluate: async (script: unknown) =>
      String(script).includes("passwordFields") ? readFloor() : state.descriptor,
    screenshot: async () => new Uint8Array([1, 2, 3]),
    locator: () => ({
      inputValue: async () => state.lastTyped,
      setInputFiles: async () => {
        state.resumeAttachments += 1;
        state.events.push("uploaded the resume");
      },
    }),
  };

  const session = {
    logTag: "[test]",
    actionPlan: null as unknown,
    browser: {},
    page,
    stagehand: {
      extract: async () => {
        state.extractCalls += 1;
        // What the DOM looked like at the instant the reader was asked. This is
        // the whole JOB-021 assertion: on a page that arrives in pieces, a read
        // taken too early describes a shell nobody could apply through.
        state.floorsAtExtract.push(state.lastFloor);
        if (state.extractCalls === 1) state.domReadsAtFirstExtract = state.domReads;
        state.events.push("read what is on screen");
        const override = state.signalsOverride?.(state.extractCalls) ?? {};
        return { data: { ...readPage(), ...override } };
      },
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
  /**
   * Returns at once. The waiting this file cares about is *how many times the
   * page is read before a verdict is drawn*, and that is asserted by counting
   * reads rather than by burning the real six seconds of backoff on every case.
   */
  sleep: async () => undefined,
  typeInto: async (_session: unknown, _url: string, instruction: string, value: string) => {
    h.state.events.push(`typed into ${instruction}`);
    h.state.lastTyped = value;
    // A form that moves the browser once the candidate has started answering it.
    if (h.state.moveOnFirstType !== null) {
      h.state.landedUrl = h.state.moveOnFirstType;
      h.state.moveOnFirstType = null;
      h.state.events.push("the page moved");
    }
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

/**
 * The half of the rule that a check made before the navigation cannot reach.
 *
 * `loadApplicationState` validates a column. `page.goto` follows redirects, so a
 * listing URL that passes every one of those rules can still answer with a 302,
 * and the browser is then standing on a page nobody checked. A control clicked
 * on the way to the form moves it the same way, and so does a form that
 * navigates between its own steps.
 *
 * What each test below asserts is not only that the run stops. It is that it
 * stopped *before* the thing that page was there to collect: nothing typed and
 * no file uploaded, with the row and the skip log saying so.
 */
describe("a listing that redirects the browser somewhere else", () => {
  /** Where a redirect of this kind goes: a form the tenant controls. */
  const ELSEWHERE = "https://example-careers.attacker.example/apply/42";

  const skipRows = () =>
    h.state.writes
      .filter((write) => write.table === "skip_log" && write.op === "insert")
      .map(
        (write) =>
          write.values as { reason: string; ats: string; job_id: string; raw_context: { message: string } }
      );

  const statuses = () =>
    h.state.writes
      .filter((write) => write.table === "applications" && write.op === "update")
      .map((write) => (write.values as { status?: string }).status);

  /**
   * A fixture in which the candidate's email really would be typed and their
   * resume really would be uploaded.
   *
   * Without this the default fixture resolves no field at all, so "nothing was
   * typed" and "nothing was uploaded" would both pass on a run that could never
   * have typed or uploaded anything, and the tests below would prove nothing.
   * The two assertions the run must earn are asserted directly in the last two
   * cases in this block.
   */
  const aFormWorthFilling = (): void => {
    h.state.resolve = (instruction: string) =>
      instruction.includes("email address input")
        ? {
            selector: "xpath=/html[1]/body[1]/main[1]/form[1]/div[3]/input[1]",
            description: instruction,
            replayed: false,
          }
        : h.manualEntryOnly(instruction);
    h.state.descriptor = {
      ...h.state.descriptor,
      found: true,
      tag: "input",
      type: "text",
      haystack: "applicant_email | Email address",
    };
    // One real file input, so the resume upload takes the deterministic path.
    h.state.fileInputs = 1;
  };

  it("stops before a single field is filled when the first navigation lands off the board", async () => {
    // The row still says what it always said, and it still passes the pre
    // navigation check. Only the landing is different, which is the whole point.
    aFormWorthFilling();
    h.state.landedUrl = ELSEWHERE;

    const result = await run();

    expect(result.status).toBe("form_fill_blocked");
    expect(result.blockedReason).toContain("blocked_apply_url");
    expect(result.blockedReason).toContain("attacker.example");
    // The URL on the row is quoted too, so the human reading this can see that
    // the listing itself looked legitimate and the browser was moved.
    expect(result.blockedReason).toContain("job-boards.greenhouse.io");

    // Nothing of the candidate's reached the page. This is the assertion the
    // fix exists for: a browser was opened, so a check that only ran before the
    // navigation would have let everything below happen.
    expect(h.state.browsersOpened).toBe(1);
    expect(h.state.events.filter((event) => event.startsWith("typed into"))).toEqual([]);
    expect(h.state.resumeAttachments).toBe(0);
    expect(h.state.events).not.toContain("uploaded the resume");

    // Terminal, and logged under the reason the pre navigation refusal uses.
    // JOB-022 gave that refusal a reason of its own: nothing about this says the
    // page changed, and sharing `dom_changed` with real DOM failures is what
    // buried this case among fifteen unrelated ones on 2026 08 20.
    expect(statuses()).toEqual(["filling_form", "form_fill_blocked"]);
    expect(skipRows()).toHaveLength(1);
    expect(skipRows()[0]!.reason).toBe("blocked_redirect");
    expect(skipRows()[0]!.ats).toBe("greenhouse");
    expect(skipRows()[0]!.job_id).toBe(h.JOB_ID);
    expect(skipRows()[0]!.raw_context.message).toContain("attacker.example");
  });

  it("stops before the resume is uploaded when the page moves mid form", async () => {
    // The redirect that a single check after the first navigation would miss:
    // the listing opens on its own board, the fields are answered there, and
    // only then does the form move the browser. The resume is the file this
    // whole rule exists to protect, and it goes last.
    aFormWorthFilling();
    h.state.moveOnFirstType = ELSEWHERE;

    const result = await run();

    expect(result.status).toBe("form_fill_blocked");
    expect(result.blockedReason).toContain("blocked_apply_url");
    expect(result.blockedReason).toContain("attacker.example");

    // It got far enough to answer the form, which is what makes this a different
    // case from the one above rather than the same test twice.
    expect(h.state.events).toContain("the page moved");
    expect(h.state.events.filter((event) => event.startsWith("typed into")).length).toBeGreaterThan(0);

    // And the file never went anywhere.
    expect(h.state.resumeAttachments).toBe(0);
    expect(skipRows()).toHaveLength(1);
    expect(skipRows()[0]!.reason).toBe("blocked_redirect");
  });

  it("types the email and uploads the resume when nothing moves the browser", async () => {
    // The control for both tests above. Without it, "nothing was typed" and "the
    // resume was not uploaded" would pass just as well on a fixture where
    // neither could ever have happened.
    aFormWorthFilling();

    const result = await run();

    expect(result.status).toBe("form_filled");
    expect(result.blockedReason).toBeNull();
    expect(h.state.events.filter((event) => event.startsWith("typed into")).length).toBeGreaterThan(
      0
    );
    expect(result.fields.find((field) => field.field === "email")?.outcome).toBe("filled");
    expect(h.state.resumeAttachments).toBe(1);
    expect(result.fields.find((field) => field.field === "resume")?.outcome).toBe("filled");
  });

  it("does not mind a redirect that stays on the listing's own board", async () => {
    // Boards move the browser legitimately all the time: Greenhouse's embed
    // resolves to the board's own job page, and a multi step form walks through
    // its own paths. The rule is about which board, not about whether the URL
    // changed, and a check that blocked this would block real listings.
    aFormWorthFilling();
    h.state.landedUrl = "https://job-boards.greenhouse.io/example/jobs/42?gh_src=embed";

    const result = await run();

    expect(result.blockedReason).toBeNull();
    expect(result.status).toBe("form_filled");
    expect(h.state.resumeAttachments).toBe(1);
  });
});

// ───────────────────────────────────
// JOB-021: a page is not read before it exists
// ───────────────────────────────────

/** The module's `StructuralFloor`, which is private to it. */
type StructuralFloorShape = {
  passwordFields: number;
  fileInputs: number;
  textAreas: number;
  iframes: number;
  ordinaryInputs: number;
  textLength: number;
};

/**
 * The bug this block exists for, stated as evidence rather than as a theory.
 *
 * The first production run against real Ashby-hosted career pages made 21
 * application attempts and lost 16 of them inside four minutes, across eight
 * unrelated companies, to one identical message: "Could not reach the job
 * application form ... no application form on screen". The pages had loaded, and
 * the failures said so themselves — hundreds to thousands of characters of text,
 * two file inputs, two iframes each. A board with two file inputs on screen is a
 * board showing an application form.
 *
 * The two halves of that message came from two different moments.
 * `readFormSignals` asked a model what was on screen and only then counted the
 * DOM, and an extraction takes seconds. So the model described the shell that
 * `page.goto` returns at `domcontentloaded`, the DOM count described the page
 * that had hydrated while the model was thinking, and the run reported the
 * former. Nothing waited for the page anywhere in the module.
 *
 * The fixture below is that page: it arrives in pieces, and the pieces are only
 * all there by the third structural read.
 */
describe("a careers page that is still hydrating when the browser arrives", () => {
  /** An empty React shell: the document parsed, nothing mounted. */
  const SHELL: StructuralFloorShape = {
    passwordFields: 0,
    fileInputs: 0,
    textAreas: 0,
    iframes: 0,
    ordinaryInputs: 0,
    textLength: 0,
  };

  /** Chrome and the first data fetch, still short of the application form. */
  const PARTIAL: StructuralFloorShape = {
    passwordFields: 0,
    fileInputs: 0,
    textAreas: 0,
    iframes: 2,
    ordinaryInputs: 0,
    textLength: 474,
  };

  /**
   * The real page. The iframe and text figures are the ones the production
   * failures carried; the file input count is one rather than the two they
   * reported, so that the upload takes the deterministic "the page has exactly
   * one file input" path. Which control the resume goes into is a different
   * test's subject, and wiring an observation fixture in here would only add
   * noise to one about timing.
   */
  const HYDRATED: StructuralFloorShape = {
    passwordFields: 0,
    fileInputs: 1,
    textAreas: 1,
    iframes: 2,
    ordinaryInputs: 7,
    textLength: 6141,
  };

  const arrivesInPieces = (): void => {
    h.state.floors = [SHELL, PARTIAL, HYDRATED];
  };

  it("does not ask what is on screen until the DOM has stopped growing", async () => {
    arrivesInPieces();

    const result = await run();

    expect(result.blockedReason).toBeNull();

    // The assertion the bug fails. Without a settle step the reader is called
    // straight after `goto`, so the shape at that moment is the SHELL — or, as
    // it was before this fix, no shape at all, because the DOM had not been read
    // even once yet.
    expect(h.state.floorsAtExtract[0]).toEqual(HYDRATED);
    expect(h.state.floorsAtExtract[0]).not.toEqual(SHELL);
    expect(h.state.floorsAtExtract[0]).not.toEqual(PARTIAL);

    // And it got there by looking repeatedly rather than by waiting a fixed
    // time: three reads to see the page arrive, a fourth to see it stand still.
    expect(h.state.domReadsAtFirstExtract).toBeGreaterThanOrEqual(4);
  });

  it("keeps waiting when the only thing arriving is plain form inputs", async () => {
    // The blind spot the other four counts have, and the commonest shape of the
    // thing this ticket is about. A form mounting a column of text inputs moves
    // no password, file, textarea or iframe count, and a form whose fields carry
    // placeholders rather than visible labels does not lengthen `innerText`
    // either. Without `ordinaryInputs` in the floor this page reads as settled
    // on the second poll, and the extraction runs against a page with no fields.
    const bare = { passwordFields: 0, fileInputs: 0, textAreas: 0, iframes: 1, textLength: 900 };
    h.state.floors = [
      { ...bare, ordinaryInputs: 0 },
      { ...bare, ordinaryInputs: 4 },
      { ...bare, ordinaryInputs: 9 },
    ];

    const result = await run();

    expect(result.blockedReason).toBeNull();
    expect(h.state.floorsAtExtract[0]?.ordinaryInputs).toBe(9);
    // Four reads: three to watch the fields arrive, a fourth to see them stop.
    expect(h.state.domReadsAtFirstExtract).toBe(4);
  });

  it("waits for content to attach before it reads anything at all", async () => {
    arrivesInPieces();

    await run();

    const first = h.state.selectorWaits[0];
    expect(first).toBeDefined();
    // `attached`, not `visible`: a selector list resolves to the first match in
    // document order, so a hidden skip link or collapsed nav button would leave
    // a visibility wait pending on a page that has in fact rendered.
    expect(first!.state).toBe("attached");
    expect(first!.selector).toContain("form");
    expect(first!.timeout).toBeGreaterThan(0);

    // Ordering, not just occurrence: the wait is what the read is waiting for.
    expect(h.state.events.indexOf("waited for the page to have content")).toBeLessThan(
      h.state.events.indexOf("read what is on screen")
    );
  });

  it("reads the listing again when the first read came back empty handed", async () => {
    // The other half of the fix, for a board that mounts its form later than the
    // settle budget allows. The first read finds neither a form nor an apply
    // control nor a sign-in wall, which is precisely the state that used to go
    // straight to "could not reach the job application form".
    h.state.signalsOverride = (call) =>
      call === 1 ? { applicationFormPresent: false, applyControlPresent: false } : {};

    const result = await run();

    expect(result.status).toBe("form_filled");
    expect(result.blockedReason).toBeNull();
    expect(h.state.extractCalls).toBeGreaterThan(1);
  });

  it("still fails closed, and bounded, when there really is no form", async () => {
    // The control. A retry loop that never gives up would turn a listing this
    // product cannot apply to into a run that never ends, and a guard that can
    // be waited past is not a guard. Nothing is ever clicked here, so the
    // message must say so rather than hedging about an unconfirmed click.
    h.state.signalsOverride = () => ({
      applicationFormPresent: false,
      applyControlPresent: false,
    });

    const result = await run();

    expect(result.status).toBe("form_fill_blocked");
    expect(result.blockedReason).toContain("Could not reach the job application form");
    expect(result.blockedReason).toContain("Nothing was clicked or typed.");

    // One read plus the two bounded re-reads, and no more.
    expect(h.state.extractCalls).toBe(3);

    // And the message says the page was given its chance, so that whoever reads
    // this skip row can tell it apart from the failure that started JOB-021.
    // Phrased as the wait that was made rather than an outcome that was
    // observed, because a settle that times out still waited.
    expect(result.blockedReason).toContain("read 3 times");
    expect(result.blockedReason).toContain("waiting for it to finish arriving");
  });

  it("counts the reads it made after clicking an apply control", async () => {
    // The count in that sentence has to be the whole truth or it is worse than
    // no count at all. Reads happen in three places — the first one, the empty
    // handed re-reads, and once after every apply click — and a message that
    // reported only the first two would tell somebody the page was looked at
    // once when it had in fact been looked at three times, on the very path
    // where a click has already touched a real employer's site.
    h.state.resolve = (instruction: string) =>
      instruction.includes("opens this listing's job application form")
        ? {
            selector: "xpath=/html[1]/body[1]/main[1]/a[1]",
            description: "the Apply for this job button",
            replayed: false,
          }
        : null;
    // An apply control that is there and never opens anything, which is what a
    // button whose handler has not been wired up yet looks like.
    h.state.signalsOverride = () => ({
      applicationFormPresent: false,
      applyControlPresent: true,
    });

    const result = await run();

    expect(result.status).toBe("form_fill_blocked");
    expect(result.blockedReason).toContain("Could not reach the job application form");

    // One read on arrival plus one after each of the two clicks. No re-reads:
    // an apply control on screen is something to act on, so the page was never
    // empty handed.
    expect(h.state.extractCalls).toBe(3);
    expect(result.blockedReason).toContain("read 3 times");

    // And because a click happened, the message says its effect is unconfirmed
    // rather than claiming nothing happened.
    expect(result.blockedReason).toContain("A control was clicked");
    expect(result.blockedReason).not.toContain("Nothing was clicked or typed.");
  });

  it("does not spend its re-reads on a captcha", async () => {
    // A challenge is an answer, not an absence. Re-reading it costs a model call
    // per attempt and tells us nothing we did not already know on the first.
    h.state.signalsOverride = () => ({
      applicationFormPresent: false,
      applyControlPresent: false,
      captchaPresent: true,
      captchaEvidence: "a Turnstile widget above the application section",
    });

    const result = await run();

    expect(result.status).toBe("form_fill_blocked");
    expect(result.blockedReason).toContain("captcha_present");
    expect(h.state.extractCalls).toBe(1);
  });

  it("does not spend its re-reads on a page that may have already been submitted", async () => {
    // The captcha's sibling, and the one with teeth. A page reading as a post
    // submission confirmation means a control may have filed a real application
    // under this candidate's name, and the correct response is to stop and say
    // so — not to sit on the board reloading a confirmation page hoping a form
    // appears on it.
    h.state.signalsOverride = () => ({
      applicationFormPresent: false,
      applyControlPresent: false,
      applicationLikelySubmitted: true,
      applicationLikelySubmittedEvidence: "Thanks for applying, we will be in touch",
    });

    const result = await run();

    expect(result.status).toBe("form_fill_blocked");
    expect(result.blockedReason).toContain("possible_unintended_submission");
    expect(h.state.extractCalls).toBe(1);
  });

  it("leaves a settled page exactly as it found it", async () => {
    // The regression guard for the common case. A board that is already there
    // when the browser arrives must not pay for a second read, or every
    // application in the fan-out pays for this fix on every page.
    const result = await run();

    expect(result.status).toBe("form_filled");
    expect(h.state.floorsAtExtract[0]).toEqual({
      passwordFields: 0,
      fileInputs: 0,
      textAreas: 1,
      iframes: 0,
      ordinaryInputs: 3,
      textLength: 4000,
    });
    // Two structural reads to establish that the page is standing still, and no
    // re-read of the page reader on top of them.
    expect(h.state.domReadsAtFirstExtract).toBe(2);
  });
});

// ───────────────────────────────────
// JOB-036: SmartRecruiters says "I'm Interested", not "Apply"
// ───────────────────────────────────

describe("an apply control labelled the way SmartRecruiters labels it", () => {
  // A real RRS Group listing (job-060) never says "Apply" anywhere on the
  // page — its own call to action reads "I'm Interested" — and the run ended
  // with "no application form on screen ... Nothing was clicked or typed":
  // the apply-control vocabulary was written around Greenhouse/Ashby's
  // "Apply"/"Apply Now" wording and never recognized it, so the click loop in
  // `reachApplicationForm` never even attempted a click.
  it("is recognized and clicked, and the run reaches and fills the form", async () => {
    h.state.resolve = (instruction: string) =>
      instruction.includes("opens this listing's job application form")
        ? {
            selector: "xpath=/html[1]/body[1]/div[1]/a[1]",
            description:
              "The “I'm interested” link that opens this listing's job application form.",
            replayed: false,
          }
        : // Every other control (the cover letter's "Enter manually" switch, in
          // particular — `run()` always asks for one) resolves the ordinary way.
          h.manualEntryOnly(instruction);
    // The first read is the listing page: no form yet, but its own "I'm
    // Interested" control is on screen. Every read after the click sees
    // whatever page that click led to, which the default fixture reads as a
    // filled-in application form.
    h.state.signalsOverride = (call) =>
      call === 1 ? { applicationFormPresent: false, applyControlPresent: true } : {};

    const result = await run();

    // `readPage()` reports no form until the second (post-click) read, so
    // reaching "form_filled" at all is only possible if the click loop
    // recognized the "I'm Interested" control, actually clicked it (rather
    // than refusing it as unidentified), and picked up the resulting page.
    expect(result.status).toBe("form_filled");
    expect(result.blockedReason).toBeNull();
    expect(h.state.extractCalls).toBeGreaterThanOrEqual(2);
  });

  it("still refuses a control that reads as the application SUBMIT, even one whose wording also matches \"interested\"", async () => {
    // The safety property the widened match must not cost: recognizing "I'm
    // Interested" as an apply control must not open a path for a control that
    // actually submits the application to slip past `assertNotAnApplicationSubmit`
    // merely because its own description happens to share that word too.
    h.state.resolve = (instruction: string) =>
      instruction.includes("opens this listing's job application form")
        ? {
            selector: "xpath=/html[1]/body[1]/div[1]/button[1]",
            description:
              "the button that submits the application on behalf of a candidate who is interested",
            replayed: false,
          }
        : null;
    h.state.signalsOverride = () => ({
      applicationFormPresent: false,
      applyControlPresent: true,
    });

    const result = await run();

    expect(result.status).toBe("form_fill_blocked");
    expect(result.blockedReason).toContain("Refusing to click");
    expect(result.blockedReason).toContain("SUBMITS the application");
  });
});
