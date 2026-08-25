// @vitest-environment node
/**
 * JOB-004. The schema bridge, tested from both ends.
 *
 * ── Why two kinds of test and not one ───────────────────────────────────────
 * The bug this ticket closes was that the ported modules named tables and
 * columns that do not exist. Catching a recurrence needs two separate facts
 * established, and no single test can establish both.
 *
 *  1. **What the code asks for.** The `describe` blocks with a fake Supabase
 *     client record every table name, column list and filter the modules emit,
 *     and assert on them. A test that only checked the returned object would
 *     pass just as happily against `candidates` as against `profiles`, because
 *     the fake would answer either.
 *
 *  2. **That what it asks for is real.** The live block at the bottom writes
 *     the exact column sets to a real Postgres carrying the real schema, and
 *     lets the database refuse anything that is not there.
 *
 * The two are needed because CI has no PostgREST. `@supabase/supabase-js` talks
 * HTTP to PostgREST, the throwaway container in CI is a bare Postgres, and so
 * the real client cannot be pointed at the real schema anywhere in this suite.
 * Recording the request on one side and checking the shape against the database
 * on the other closes that gap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import postgres from "postgres";

import { liveDbId, liveDbSuite, liveDbUrl } from "../live-db-gate";

// Minted per run, never written down. See `tests/live-db-gate.ts`: a constant
// UUID is a value a real row can hold, and the live block below deletes the ids
// it was given.
const USER_ID = liveDbId();
const JOB_ID = liveDbId();
const APPLICATION_ID = liveDbId();
const BOARD_ID = liveDbId();

// ───────────────────────────────────
// A Supabase client that records instead of answering
// ───────────────────────────────────

type Call = {
  table: string;
  verb: string;
  columns?: string;
  head?: boolean;
  filters: [string, string, unknown][];
  payload?: unknown;
};

const calls: Call[] = [];
/** `table` → the rows a select on it should answer with. */
const rows: Record<string, unknown[]> = {};
/**
 * `table` → what a `select("…", { count: "exact", head: true })` on it should
 * report. Kept separate from `rows` so a test can seed the (user, job) lookup
 * (which needs actual rows) and the cap count (which does not) independently.
 */
const counts: Record<string, number> = {};

function fakeClient() {
  return {
    from(table: string) {
      const call: Call = { table, verb: "select", filters: [] };
      calls.push(call);

      const result = () => {
        // A head:true count query returns the count only — no rows — because
        // that is what PostgREST does. Falling back to `rows[table].length`
        // keeps the fake usable for suites that don't set `counts` at all.
        if (call.head) {
          return {
            data: null,
            error: null,
            count: counts[table] ?? (rows[table] ?? []).length,
          };
        }
        return {
          data: rows[table] ?? [],
          error: null,
          count: counts[table] ?? (rows[table] ?? []).length,
        };
      };
      const chain: Record<string, unknown> = {
        select(columns?: string, options?: { head?: boolean; count?: string }) {
          call.columns = columns;
          if (options?.head) call.head = true;
          return chain;
        },
        insert(payload: unknown) {
          call.verb = "insert";
          call.payload = payload;
          return chain;
        },
        update(payload: unknown) {
          call.verb = "update";
          call.payload = payload;
          return chain;
        },
        // An insert that asks for columns back gets its own payload back, plus
        // an id, because that is what PostgREST does and because a module that
        // checks the returned id — `claimApplicationRow` does — is otherwise
        // untestable on its success path.
        single: async () => ({
          data:
            call.verb === "insert"
              ? { id: APPLICATION_ID, ...(call.payload as Record<string, unknown>) }
              : ((rows[table] ?? [])[0] ?? null),
          error: null,
        }),
        then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };
      for (const filter of ["eq", "ilike", "in", "gte", "order", "limit"]) {
        chain[filter] = (a: string, b: unknown) => {
          call.filters.push([filter, a, b]);
          return chain;
        };
      }
      return chain;
    },
  };
}

vi.mock("@/lib/supabase-project-guard", () => ({ assertSupabaseProject: () => undefined }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient() }));

// The env the ported modules' own `getSupabaseClient` insists on. The guard
// above is stubbed, and the client it would build is the fake one.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const {
  claimApplicationRow,
  clearEscalation,
  recordFailure,
  recordSkip,
  skipReasonFor,
  updateApplication,
  writeEscalation,
} = await import("@/lib/application-records");
const { listCandidateApplications, loadCandidate, toCandidateRecord } = await import(
  "@/lib/candidate-intake"
);

const client = () => fakeClient() as unknown as Parameters<typeof recordSkip>[0];

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(rows)) delete rows[key];
  for (const key of Object.keys(counts)) delete counts[key];
});

/** The one call against a table, when exactly one is expected. */
const callTo = (table: string): Call => {
  const matching = calls.filter((call) => call.table === table);
  expect(matching).toHaveLength(1);
  return matching[0]!;
};

// ───────────────────────────────────
// Reading a person
// ───────────────────────────────────

describe("loadCandidate", () => {
  const profileRow = {
    id: USER_ID,
    email: "candidate@example.com",
    target_locations: ["Remote", "New York"],
    work_authorized_us: true,
    requires_sponsorship: false,
    current_country: "United States",
    current_city: "Atlanta",
    willing_to_relocate: null,
  };

  it("reads profiles and resumes, and names neither actinno table", async () => {
    rows.profiles = [profileRow];
    rows.resumes = [{ storage_path: "resumes/user/abc.pdf", created_at: "2026-01-01T00:00:00Z" }];

    const record = await loadCandidate(USER_ID);

    expect(calls.map((call) => call.table)).toEqual(["profiles", "resumes"]);
    expect(calls.map((call) => call.table)).not.toContain("candidates");
    expect(calls.map((call) => call.table)).not.toContain("job_applications");

    // The exact column list, because a typo in it is the whole bug class. The
    // trailing four before `github_url` are JOB-022's, and a column missing
    // from here is not a typo sized problem: intake wrote all four of them and
    // this list not naming them is why the form filler had no graduation date,
    // no start date and no citizenship status to answer a form with. JOB-044
    // added `github_url` on the same reasoning, and JOB-101 the eight after it
    // on exactly the same reasoning again: a clearance eligibility written at
    // intake and absent from this line is a question the candidate answered
    // that no form ever gets told about. JOB-134's trailing five are four more
    // of exactly that plus `stored_answers`, which is the log of every question
    // this person has answered that intake never asked.
    expect(callTo("profiles").columns).toBe(
      "id,email,target_locations,work_authorized_us,requires_sponsorship,current_country," +
        "current_city,willing_to_relocate,citizenship_status,f1_status,grad_date,earliest_start," +
        "github_url,clearance_eligibility,clearance_level_held,needs_sponsorship_non_us," +
        "visa_status,high_school_name,high_school_grad_year,street_address,postal_code," +
        "subject_to_restrictive_covenant,relatives_at_target_employers," +
        "previously_employed_at_target_employers,salary_expectation,stored_answers"
    );
    expect(callTo("profiles").filters).toContainEqual(["eq", "id", USER_ID]);

    // Newest active resume, which is the rule when a person has re uploaded.
    expect(callTo("resumes").filters).toContainEqual(["eq", "user_id", USER_ID]);
    expect(callTo("resumes").filters).toContainEqual(["eq", "is_active", true]);
    expect(callTo("resumes").filters).toContainEqual([
      "order",
      "created_at",
      { ascending: false },
    ]);

    expect(record.userId).toBe(USER_ID);
    expect(record.applicationEmail).toBe("candidate@example.com");
    expect(record.resumeUrl).toBe("resumes/user/abc.pdf");
    expect(record.locations).toEqual(["Remote", "New York"]);
  });

  it("refuses an id that is not a uuid, before it reaches Postgres", async () => {
    await expect(loadCandidate("candidate@example.com")).rejects.toThrow(/profiles.id UUID/);
    expect(calls).toHaveLength(0);
  });

  it("says so when the person has signed in but never uploaded a resume", async () => {
    rows.profiles = [profileRow];
    rows.resumes = [];
    await expect(loadCandidate(USER_ID)).rejects.toThrow(/No active resumes row/);
  });

  it("maps a null answer to an absent one, never to a no", () => {
    const record = toCandidateRecord(
      { ...profileRow, requires_sponsorship: null, willing_to_relocate: null },
      {
        id: "1c0ffee0-0000-4000-8000-000000000001",
        storagePath: "resumes/user/abc.pdf",
        linkedinPdfPath: null,
      }
    );
    expect(record.applicationAnswers.workAuthorizedUs).toBe(true);
    expect("requiresSponsorship" in record.applicationAnswers).toBe(false);
    expect("willingToRelocate" in record.applicationAnswers).toBe(false);
  });
});

// ───────────────────────────────────
// Writing an outcome
// ───────────────────────────────────

describe("updateApplication", () => {
  it("writes applications, and spells confirmation_text the way the schema does", async () => {
    await updateApplication(client(), APPLICATION_ID, {
      status: "submitted",
      confirmationText: "REF-1234",
      submittedAt: "2026-08-19T00:00:00.000Z",
      redirectUrl: "https://boards.example.com/thanks",
      browserbaseSessionId: "bb-session-abc123",
    });

    const call = callTo("applications");
    expect(call.verb).toBe("update");
    expect(call.payload).toEqual({
      status: "submitted",
      confirmation_text: "REF-1234",
      submitted_at: "2026-08-19T00:00:00.000Z",
      redirect_url: "https://boards.example.com/thanks",
      browserbase_session_id: "bb-session-abc123",
    });
    // Two columns actinno wrote that do not exist here. Writing either would be
    // rejected by PostgREST at runtime and by nothing at compile time.
    expect(call.payload).not.toHaveProperty("error_message");
    expect(call.payload).not.toHaveProperty("updated_at");
    expect(call.filters).toContainEqual(["eq", "id", APPLICATION_ID]);
  });

  it("does not issue an UPDATE at all when the patch is empty", async () => {
    await updateApplication(client(), APPLICATION_ID, {});
    expect(calls).toHaveLength(0);
  });

  // JOB-045. `browserbase_session_id` follows the same "undefined means leave
  // it out, explicit null means write null" rule every other column here does
  // — see `patchColumns`. A run with no Browserbase session (the local
  // Chromium fallback) has to be able to say so on the row rather than the
  // column just being silently skipped.
  it("writes an explicit null for browserbaseSessionId rather than omitting the column", async () => {
    await updateApplication(client(), APPLICATION_ID, {
      status: "form_filled",
      browserbaseSessionId: null,
    });

    expect(callTo("applications").payload).toEqual({
      status: "form_filled",
      browserbase_session_id: null,
    });
  });
});

describe("skipReasonFor", () => {
  it.each([
    ["needs_candidate_input: 3 required field(s)", "form_fill_blocked", "unanswerable_required"],
    ["captcha_present: a reCAPTCHA checkbox", "form_fill_blocked", "captcha"],
    ["submit_clicked_outcome_unknown: the page died", "submission_unconfirmed", "submit_failed"],
    ["submission_blocked: no control found", "submission_blocked", "submit_failed"],
    ["Jobinno holds no account on this board", "form_fill_blocked", "verification_required"],
    ["page.title timed out after 30000ms", "error", "timeout"],
    // JOB-022. This used to expect `dom_changed`, and that expectation was the
    // bug written down: an unrecognised message is not evidence that a page
    // changed, and filing it as though it were is what made 16 unrelated
    // failures read as one cause on 2026 08 20.
    ["something nobody has seen before", "error", "internal_error"],
    // The two reasons that came out of `dom_changed`, each keyed off the tag its
    // own writer puts on the message.
    ["blocked_apply_url: the browser is at https://elsewhere.example/x", "form_fill_blocked", "blocked_redirect"],
    ["needs_attestation: the form at ... has 1 required legal attestation(s)", "form_fill_blocked", "needs_attestation"],
    // JOB-026. The tag is written by `submit-application.ts` after the click,
    // when the page itself said it scored the submission as automated. Before
    // this entry existed the message landed on `submit_failed` with every
    // genuinely unknown outcome, which is how five real applications on
    // 2026 08 21 read as "the submit leg died somehow".
    [
      'submission_flagged_as_automated: "Submit Application" was clicked and the board refused ' +
        'it as automated traffic, in its own words: "flagged as possible spam"',
      "submission_unconfirmed",
      "bot_detected",
    ],
    // Ordering, and the reason the tag exists at all. These messages quote the
    // board's refusal verbatim, and Ashby's own version of this page tells the
    // reader to check their browser. A board that worded it around the word
    // "captcha" would file itself under somebody else's reason without this.
    [
      'submission_flagged_as_automated: the board said "your submission failed our captcha ' +
        'check and was flagged as a bot", and the page timed out afterwards',
      "submission_unconfirmed",
      "bot_detected",
    ],
    // The other direction, unchanged: an unknown outcome with no such tag is
    // still `submit_failed`, and must stay there.
    [
      'submit_clicked_outcome_unknown: "Submit" was clicked, but the form is still on screen',
      "submission_unconfirmed",
      "submit_failed",
    ],
  ])("reads %j as %s", (message, status, expected) => {
    expect(skipReasonFor(status as never, message)).toBe(expected);
  });

  // The trap PR #36 documented, kept as a live check rather than a comment. The
  // timeout tag matches the whole message, so a reason whose own tag sits below
  // it in `REASON_TAGS` is silently rerouted the moment its wording happens to
  // contain "timed out", and an export control question quoting a form label is
  // exactly the kind of message that could.
  it("files an attestation stop as an attestation even when its wording says timed out", () => {
    expect(
      skipReasonFor(
        "form_fill_blocked" as never,
        'needs_attestation: the form asks "have you ever held a clearance that timed out?"'
      )
    ).toBe("needs_attestation");
  });

  it("files a redirect as a redirect even when the URL it quotes spells captcha", () => {
    expect(
      skipReasonFor(
        "form_fill_blocked" as never,
        'blocked_apply_url: the browser is at "https://elsewhere.example/verify-captcha/1"'
      )
    ).toBe("blocked_redirect");
  });
});

describe("recordSkip", () => {
  it("writes a skip_log row with a reason the CHECK constraint allows", async () => {
    await recordSkip(client(), {
      applicationId: APPLICATION_ID,
      jobId: JOB_ID,
      ats: "greenhouse",
      reason: "unanswerable_required",
      message: "needs_candidate_input: 3 required field(s)",
      fieldLabel: "Are you legally authorized to work in the United States?",
      fieldKind: "radio",
      required: true,
    });

    const call = callTo("skip_log");
    expect(call.verb).toBe("insert");
    expect(call.payload).toEqual({
      application_id: APPLICATION_ID,
      job_id: JOB_ID,
      ats: "greenhouse",
      reason: "unanswerable_required",
      field_label: "Are you legally authorized to work in the United States?",
      field_kind: "radio",
      required: true,
      raw_context: { message: "needs_candidate_input: 3 required field(s)", browserbaseSessionId: null },
    });
  });

  it("refuses a reason outside the closed set rather than letting Postgres do it", async () => {
    await expect(
      recordSkip(client(), {
        applicationId: APPLICATION_ID,
        jobId: JOB_ID,
        ats: "lever",
        reason: "gave_up" as never,
        message: "…",
      })
    ).rejects.toThrow(/skip_log.reason must be one of/);
    expect(calls).toHaveLength(0);
  });

  it("accepts a null application_id, for a listing abandoned before a row existed", async () => {
    await recordSkip(client(), {
      applicationId: null,
      jobId: JOB_ID,
      ats: "ashby",
      reason: "dom_changed",
      message: "…",
    });
    expect((callTo("skip_log").payload as Record<string, unknown>).application_id).toBeNull();
  });
});

describe("recordFailure", () => {
  it("sets a terminal status and logs the reason, rather than parking the row", async () => {
    await recordFailure(client(), {
      applicationId: APPLICATION_ID,
      jobId: JOB_ID,
      ats: "greenhouse",
      status: "form_fill_blocked",
      message: "captcha_present: an hCaptcha widget is on the application form",
    });

    expect(callTo("applications").payload).toEqual({ status: "form_fill_blocked" });
    const skip = callTo("skip_log").payload as Record<string, unknown>;
    expect(skip.reason).toBe("captcha");
    // The status is a real one, not an intermediate "waiting for something".
    expect(callTo("applications").payload).not.toEqual({ status: "awaiting_verification" });
  });

  // JOB-045. `raw_context.browserbaseSessionId` (via `recordSkip`, above) was
  // the only place this ever landed before — a stop's recording, not the row
  // itself. When the caller has one to give, it now has to reach both, because
  // `applications.browserbase_session_id` is meant to answer "which recording
  // is THIS attempt" for a query against `applications` alone, with no join to
  // `skip_log` required.
  it("carries the Browserbase session id onto both the row and the skip log, when the caller has one", async () => {
    await recordFailure(client(), {
      applicationId: APPLICATION_ID,
      jobId: JOB_ID,
      ats: "greenhouse",
      status: "form_fill_blocked",
      message: "captcha_present: an hCaptcha widget is on the application form",
      browserbaseSessionId: "bb-session-xyz789",
    });

    expect(callTo("applications").payload).toEqual({
      status: "form_fill_blocked",
      browserbase_session_id: "bb-session-xyz789",
    });
    const skip = callTo("skip_log").payload as { raw_context: { browserbaseSessionId: string | null } };
    expect(skip.raw_context.browserbaseSessionId).toBe("bb-session-xyz789");
  });

  it("never throws over the original error when the database refuses both writes", async () => {
    const exploding = {
      from: () => {
        throw new Error("connection reset");
      },
    } as unknown as Parameters<typeof recordFailure>[0];

    await expect(
      recordFailure(exploding, {
        applicationId: APPLICATION_ID,
        jobId: JOB_ID,
        ats: "greenhouse",
        status: "error",
        message: "the original failure",
      })
    ).resolves.toBeUndefined();
  });
});

// ───────────────────────────────────
// Claiming a row
// ───────────────────────────────────

describe("claimApplicationRow", () => {
  it("reuses the existing row for a (user, job) pair instead of inserting a second", async () => {
    rows.applications = [{ id: APPLICATION_ID, status: "form_fill_blocked" }];

    const claimed = await claimApplicationRow(client(), { userId: USER_ID, jobId: JOB_ID });

    expect(claimed).toEqual({
      applicationId: APPLICATION_ID,
      status: "form_fill_blocked",
      created: false,
    });
    expect(calls.every((call) => call.verb === "select")).toBe(true);
  });

  it.each(["submitted", "submission_unconfirmed"])(
    "refuses to hand back a row at %s",
    async (status) => {
      rows.applications = [{ id: APPLICATION_ID, status }];
      await expect(
        claimApplicationRow(client(), { userId: USER_ID, jobId: JOB_ID })
      ).rejects.toThrow(/submit control has been clicked/);
    }
  );

  it("refuses a profile that has never attested to its intake", async () => {
    rows.applications = [];
    rows.profiles = [{ id: USER_ID, attested_at: null, applications_cap: 50 }];
    await expect(
      claimApplicationRow(client(), { userId: USER_ID, jobId: JOB_ID })
    ).rejects.toThrow(/never attested/);
  });

  it("refuses when the plan's application cap is used up, and reads zero as none left", async () => {
    rows.applications = [];
    rows.profiles = [
      {
        id: USER_ID,
        attested_at: "2026-08-01T00:00:00Z",
        applications_cap: 0,
      },
    ];
    await expect(
      claimApplicationRow(client(), { userId: USER_ID, jobId: JOB_ID })
    ).rejects.toThrow(/has used 0 of 0 applications/);
  });

  /**
   * The count, off the source of truth (JOB-v1-A).
   *
   * `claimApplicationRow` used to gate on `profiles.applications_used`, which
   * `lib/application-quota.ts` maintains. That works only while the counter
   * matches the real count of slot consuming `applications` rows, and it did
   * not on 2026 08 24: at least one production profile carried rows from
   * before the counter was wired, and its `applications_used` read 2 against
   * 10+ real rows. A gate on a counter that lags reality is a no op.
   *
   * The check now counts the rows in `CAP_CONSUMING_STATUSES` off `applications`
   * directly. The stored counter is not read at all, and it is not on the
   * `profiles` select any more.
   */
  it("gates on a live count of slot consuming applications rows, not the stored counter", async () => {
    // No existing row for this (user, job). Ten slot consuming rows for this
    // person against other listings, cap of ten. The stored counter is
    // deliberately not on the profiles read at all any more; supplying it
    // here would prove nothing about which value the guard trusted.
    rows.applications = [];
    counts.applications = 10;
    rows.profiles = [
      {
        id: USER_ID,
        attested_at: "2026-08-01T00:00:00Z",
        applications_cap: 10,
      },
    ];

    await expect(
      claimApplicationRow(client(), { userId: USER_ID, jobId: JOB_ID })
    ).rejects.toThrow(/has used 10 of 10 applications/);

    // `applications_used` is no longer on the profiles read: the guard reads
    // whichever value it counts, not one somebody else was supposed to write.
    expect(callTo("profiles").columns).toBe("id,attested_at,applications_cap");

    // Two `applications` calls: the (user, job) lookup and the count. The count
    // uses `head: true` and filters on `user_id` plus a status IN clause built
    // from `CAP_CONSUMING_STATUSES`.
    const applicationsCalls = calls.filter((call) => call.table === "applications");
    expect(applicationsCalls).toHaveLength(2);
    const countCall = applicationsCalls[1]!;
    expect(countCall.head).toBe(true);
    expect(countCall.filters).toContainEqual(["eq", "user_id", USER_ID]);
    const inFilter = countCall.filters.find(([verb]) => verb === "in");
    expect(inFilter?.[1]).toBe("status");
    // The set of statuses the count filters on has to include every terminal
    // outcome of a real attempt, and nothing that could be re-run or was never
    // attempted. This mirrors the ticket's acceptance list for JOB-v1-A.
    expect(inFilter?.[2]).toEqual(
      expect.arrayContaining([
        "submitted",
        "submission_unconfirmed",
        "form_fill_blocked",
        "submission_blocked",
        "account_gate_blocked",
      ])
    );
    // And nothing that should not count.
    expect(inFilter?.[2]).not.toEqual(expect.arrayContaining(["discovered"]));
    expect(inFilter?.[2]).not.toEqual(expect.arrayContaining(["error"]));
  });

  it("lets the claim through when the live count is one short of the cap", async () => {
    // Nine of ten used, this attempt is the tenth. The count is what says so.
    rows.applications = [];
    counts.applications = 9;
    rows.profiles = [
      {
        id: USER_ID,
        attested_at: "2026-08-01T00:00:00Z",
        applications_cap: 10,
      },
    ];

    const claimed = await claimApplicationRow(client(), { userId: USER_ID, jobId: JOB_ID });
    expect(claimed.created).toBe(true);
    expect(claimed.status).toBe("discovered");
    expect(calls.find((call) => call.verb === "insert")?.payload).toEqual({
      user_id: USER_ID,
      job_id: JOB_ID,
      status: "discovered",
    });
  });
});

// ───────────────────────────────────
// Reading applications back
// ───────────────────────────────────

describe("listCandidateApplications", () => {
  it("joins the listing and the employer, and reports the newest skip", async () => {
    rows.applications = [
      {
        id: APPLICATION_ID,
        job_id: JOB_ID,
        status: "form_fill_blocked",
        submitted_at: null,
        confirmation_text: null,
        redirect_url: null,
        created_at: "2026-08-01T00:00:00Z",
        jobs: { title: "SWE Intern", url: "https://x.example/apply", boards: { company: "Acme" } },
        skip_log: [
          { reason: "dom_changed", raw_context: { message: "old" }, created_at: "2026-08-01T00:00:00Z" },
          {
            reason: "unanswerable_required",
            raw_context: { message: "needs_candidate_input: 2 required field(s)" },
            created_at: "2026-08-02T00:00:00Z",
          },
        ],
      },
    ];

    const [record] = await listCandidateApplications(USER_ID);

    expect(callTo("applications").columns).toContain("jobs!inner(title,url,boards(company))");
    expect(callTo("applications").columns).toContain("skip_log(reason,raw_context,created_at)");
    expect(callTo("applications").filters).toContainEqual(["eq", "user_id", USER_ID]);

    expect(record?.company).toBe("Acme");
    expect(record?.jobTitle).toBe("SWE Intern");
    expect(record?.applyUrl).toBe("https://x.example/apply");
    expect(record?.skip?.reason).toBe("unanswerable_required");
    expect(record?.skip?.detail).toBe("needs_candidate_input: 2 required field(s)");
  });
});

// ───────────────────────────────────
// The same column sets, against a real database
// ───────────────────────────────────

/**
 * Runs only against a throwaway Postgres somebody deliberately pointed it at,
 * and skips otherwise. `tests/live-db-gate.ts` is the gate and explains itself.
 *
 * The short version, because this is the file the hole was found in: requiring
 * a `localhost` host was not enough, since a port forward to production is
 * `localhost` too, and the fixture ids were hard-coded UUIDs, so the `afterAll`
 * below was a `delete from auth.users` aimed at whatever row held one. The ids
 * are now minted per run and writing needs `ALLOW_LIVE_DB_TESTS=1` on top of
 * the host check.
 *
 * Everything created below is deleted in `afterAll`, and the delete is scoped to
 * the ids created here. There is no truncate, no reset and no unfiltered delete
 * anywhere in this file.
 */
// ───────────────────────────────────
// v1-C (#143): escalation lifecycle
// ───────────────────────────────────

describe("writeEscalation", () => {
  it("moves the row into pending_user_input with the questions attached", async () => {
    const now = new Date("2026-08-25T10:00:00Z");
    await writeEscalation(
      client(),
      APPLICATION_ID,
      [
        {
          fieldKey: "are you legally authorized to work in the united states?",
          fieldLabel: "Are you legally authorized to work in the United States?",
          question: "Are you legally authorized to work in the United States?",
          options: ["Yes", "No"],
          required: true,
          topicSlug: "work_auth_current_us",
        },
      ],
      { now }
    );

    const call = callTo("applications");
    expect(call.verb).toBe("update");
    expect(call.payload).toMatchObject({
      status: "pending_user_input",
      escalation_created_at: now.toISOString(),
      // Cleared so the notifier can fire again for this fresh escalation.
      escalation_notified_at: null,
      escalation_resolved_at: null,
    });
    const escalation = (call.payload as { escalation_questions: unknown[] })
      .escalation_questions;
    expect(escalation).toHaveLength(1);
    expect((escalation as Array<{ topicSlug: string | null }>)[0]!.topicSlug).toBe(
      "work_auth_current_us"
    );
  });
});

describe("clearEscalation", () => {
  it("flips the row back to discovered and stamps escalation_resolved_at", async () => {
    const now = new Date("2026-08-25T11:00:00Z");
    await clearEscalation(client(), APPLICATION_ID, { now });

    const call = callTo("applications");
    expect(call.verb).toBe("update");
    expect(call.payload).toEqual({
      status: "discovered",
      escalation_questions: null,
      escalation_resolved_at: now.toISOString(),
    });
  });
});

liveDbSuite("the columns the code writes exist in the real schema", () => {
  const sql = postgres(liveDbUrl, { prepare: false, max: 1, onnotice: () => {} });

  afterAll(async () => {
    // Scoped to the ids this file created. `applications` and `skip_log` go
    // with the profile and the job by cascade, but they are named anyway so
    // that a schema change which drops a cascade does not quietly start
    // leaving rows behind.
    await sql`delete from public.skip_log where job_id = ${JOB_ID}`;
    await sql`delete from public.applications where id = ${APPLICATION_ID}`;
    await sql`delete from public.jobs where id = ${JOB_ID}`;
    await sql`delete from public.boards where id = ${BOARD_ID}`;
    await sql`delete from public.profiles where id = ${USER_ID}`;
    await sql`delete from auth.users where id = ${USER_ID}`;
    await sql.end({ timeout: 5 });
  });

  // Setup lives here rather than in the first `it` so that neither test depends
  // on the other having run, and so that a failure to build the fixture reads as
  // a broken fixture rather than as a broken assertion.
  beforeAll(async () => {
    await sql`insert into auth.users (id, email) values (${USER_ID}, 'live@example.com')`;
    await sql`
      insert into public.profiles (id, email, attested_at, applications_cap)
      values (${USER_ID}, 'live@example.com', now(), 5)`;
    await sql`
      insert into public.boards (id, ats, company, board_token)
      values (${BOARD_ID}, 'greenhouse', 'Acme', ${`job-004-${BOARD_ID}`})`;
    await sql`
      insert into public.jobs (id, board_id, ats, external_id, title, url)
      values (${JOB_ID}, ${BOARD_ID}, 'greenhouse', ${`job-004-${JOB_ID}`},
              'SWE Intern', 'https://boards.example.com/apply')`;

    // Exactly what `claimApplicationRow` inserts.
    await sql`
      insert into public.applications (id, user_id, job_id, status)
      values (${APPLICATION_ID}, ${USER_ID}, ${JOB_ID}, 'discovered')`;
  });

  it("accepts the applications patch the submit step writes, column for column", async () => {
    // Exactly what `updateApplication` patches, every column at once.
    await sql`
      update public.applications
         set status = 'submitted',
             confirmation_text = 'REF-1234',
             submitted_at = now(),
             redirect_url = 'https://boards.example.com/thanks',
             browserbase_session_id = 'bb-session-live-test'
       where id = ${APPLICATION_ID}`;

    const [application] = await sql<
      { status: string; confirmation_text: string | null; browserbase_session_id: string | null }[]
    >`select status, confirmation_text, browserbase_session_id from public.applications
       where id = ${APPLICATION_ID}`;
    expect(application?.status).toBe("submitted");
    expect(application?.confirmation_text).toBe("REF-1234");
    // JOB-045. Nullable, and this is the migration this proves landed: the
    // column did not exist before it, and this query would fail against a
    // database that never got the migration applied.
    expect(application?.browserbase_session_id).toBe("bb-session-live-test");
  });

  it("accepts the skip_log row the failure path writes, column for column", async () => {
    // Exactly what `recordSkip` inserts.
    await sql`
      insert into public.skip_log
        (application_id, job_id, ats, reason, field_label, field_kind, required, raw_context)
      values (${APPLICATION_ID}, ${JOB_ID}, 'greenhouse', 'unanswerable_required',
              'Work authorization?', 'radio', true,
              ${sql.json({ message: "needs_candidate_input: 1 required field(s)" })})`;

    const [skip] = await sql<{ reason: string; raw_context: { message: string } }[]>`
      select reason, raw_context from public.skip_log where application_id = ${APPLICATION_ID}`;
    expect(skip?.reason).toBe("unanswerable_required");
    expect(skip?.raw_context.message).toMatch(/needs_candidate_input/);
  });

  it("refuses a skip reason outside the closed set", async () => {
    await expect(
      sql`
        insert into public.skip_log (job_id, ats, reason)
        values (${JOB_ID}, 'greenhouse', 'gave_up')`
    ).rejects.toThrow(/skip_log_reason_check/);
  });
});
