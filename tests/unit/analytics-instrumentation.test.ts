// @vitest-environment node
/**
 * JOB-014. That the events fire where the funnel says they fire, and that they
 * carry nothing about the person they are filed against.
 *
 * ── Why the call sites are tested and not just the sanitizer ────────────────
 * `tests/unit/analytics-events.test.ts` proves that a banned property cannot
 * get through `sanitizeProperties`. That is worth nothing on its own if the
 * event never fires, or fires on the wrong branch, or is filed against an email
 * address instead of a `profiles.id`. An instrumentation ticket's whole output
 * is call sites, so the call sites are what this file asserts.
 *
 * `@/lib/analytics/posthog-server` is mocked rather than the PostHog SDK, on
 * the same reasoning `tests/unit/dashboard-find-jobs-action.test.ts` gives for
 * mocking `@/lib/job-search-trigger`: the question here is who fires what and
 * when, and pulling a real HTTP client into the graph to establish it would be
 * cost for nothing. The two halves meet at `captureServerEvent`, which both
 * files name explicitly.
 *
 * ── The assertion that matters most ─────────────────────────────────────────
 * Every case checks the distinct id is the session's `profiles.id` UUID, and
 * every case runs `expectNoPersonalData` over the properties. Both server
 * actions and the callback route have the person's email address in scope on
 * the very line above the capture, which is exactly the situation a later edit
 * turns into a leak.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ANALYTICS_EVENT } from "@/lib/analytics/events";
import type { ServerCapture } from "@/lib/analytics/posthog-server";
import type { SearchCooldown } from "@/lib/search-cooldown";

// Typed with the parameters they really take, so that a change to either
// signature is a type error here rather than a mock that quietly accepts
// anything. Same reasoning as the `requestJobSearch` stub in
// `tests/unit/dashboard-find-jobs-action.test.ts`.
const captureServerEvent = vi.fn(async (capture: ServerCapture): Promise<void> => {
  void capture;
});
const captureServerEvents = vi.fn(
  async (captures: readonly ServerCapture[]): Promise<void> => {
    void captures;
  }
);

vi.mock("@/lib/analytics/posthog-server", () => ({
  captureServerEvent: (capture: ServerCapture) => captureServerEvent(capture),
  captureServerEvents: (captures: readonly ServerCapture[]) => captureServerEvents(captures),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── The session under test ──────────────────────────────────────────────────
const SESSION_USER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SESSION_EMAIL = "someone@university.edu";

const getUser = vi.fn();
const requestJobSearch = vi.fn(async (userId: string): Promise<void> => {
  void userId;
});

let profile: Record<string, unknown> | null = {
  attested_at: "2026-07-01T00:00:00.000Z",
  applications_used: 3,
  applications_cap: 150,
};

let profileUpdateError: { message: string } | null = null;
let resumeInsertError: { message: string } | null = null;

/** JOB-112. The `resumes.id` the insert hands back, and the parse event's key. */
const RESUME_ID = "8d3f5c21-0000-4000-8000-0000000000aa";

vi.mock("@/lib/job-search-trigger", () => ({
  requestJobSearch: (userId: string) => requestJobSearch(userId),
}));

// JOB-112. Stubbed rather than left real for the same reason `requestJobSearch`
// above is: this file is about which analytics event fires and when, and the
// real trigger would import the Inngest client and try to send.
const requestDocumentParse = vi.fn(
  async (userId: string, resumeId: string): Promise<void> => {
    void userId;
    void resumeId;
  }
);
vi.mock("@/lib/candidate-document-trigger", () => ({
  requestDocumentParse: (userId: string, resumeId: string) =>
    requestDocumentParse(userId, resumeId),
}));

// `claimSearchSlot` is one conditional UPDATE against the real `profiles`
// table in Postgres — see `tests/unit/dashboard-find-jobs-cooldown.test.ts`,
// which is where that claim is actually exercised, live, against a fixture
// row it inserts and cleans up itself. This file has no such row for
// `SESSION_USER`, and was never meant to: it is about who fires the analytics
// event and when, not about the cooldown. Left unmocked, `findJobsNow` reaches
// the real database, finds no profile row for `SESSION_USER`, and is refused
// with `{ allowed: false, reason: "no_profile" }` before it ever gets to
// `captureServerEvent`. Partial, so `describeRetryAfter` stays the real one,
// matching `tests/unit/dashboard-find-jobs-action.test.ts`, which stubs the
// same function for the same reason.
const claimSearchSlot = vi.fn(async (userId: string): Promise<SearchCooldown> => {
  void userId;
  return { allowed: true };
});

vi.mock("@/lib/search-cooldown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/search-cooldown")>()),
  claimSearchSlot: (userId: string) => claimSearchSlot(userId),
}));

vi.mock("@/lib/supabase/server", () => ({
  RESUMES_BUCKET: "resumes",
  createServerClient: async () => ({
    auth: { getUser },
    // The two callers end their chains differently: `readDashboardProfile`
    // finishes on `.maybeSingle()`, `submitIntake` awaits `.eq()` directly. So
    // the chain is thenable as well as chainable, which is what a PostgREST
    // builder really is.
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: () => chain,
        eq: () => chain,
        // JOB-112. `submitIntake` now reads the new row's id back, so the
        // insert chain has to keep chaining rather than resolve on its own.
        insert: () => chain,
        single: async () => ({
          data: resumeInsertError === null ? { id: RESUME_ID } : null,
          error: resumeInsertError,
        }),
        maybeSingle: async () => ({ data: profile, error: null }),
        then: (resolve: (value: { error: { message: string } | null }) => unknown) =>
          Promise.resolve(
            resolve({ error: table === "profiles" ? profileUpdateError : null })
          ),
      };
      return chain;
    },
  }),
  createServiceRoleClient: () => ({
    from() {
      const chain: Record<string, unknown> = {
        update: () => chain,
        eq: async () => ({ error: null }),
      };
      return chain;
    },
  }),
}));

const { findJobsNow } = await import("@/app/dashboard/actions");
const { submitIntake } = await import("@/app/onboarding/actions");

beforeEach(() => {
  captureServerEvent.mockClear();
  captureServerEvents.mockClear();
  requestJobSearch.mockClear();
  requestDocumentParse.mockClear();
  claimSearchSlot.mockClear();
  claimSearchSlot.mockResolvedValue({ allowed: true });
  profileUpdateError = null;
  resumeInsertError = null;
  profile = { attested_at: "2026-07-01T00:00:00.000Z", applications_used: 3, applications_cap: 150 };
  getUser.mockResolvedValue({ data: { user: { id: SESSION_USER, email: SESSION_EMAIL } } });
});

/** The one capture this test expects, unwrapped. */
function onlyCapture(): ServerCapture {
  expect(captureServerEvent).toHaveBeenCalledTimes(1);
  const [capture] = captureServerEvent.mock.calls[0] ?? [];
  if (capture === undefined) throw new Error("no capture was recorded");
  return capture;
}

/**
 * Nothing in a property set may be the person, or anything they wrote.
 *
 * Deliberately checks the values as well as the keys. A key named `source`
 * holding an email address passes a key check and is still a leak, and the
 * whole reason both call sites are risky is that the address is in scope.
 */
function expectNoPersonalData(properties: Record<string, unknown> | undefined) {
  const serialized = JSON.stringify(properties ?? {});

  expect(serialized).not.toContain(SESSION_EMAIL);
  expect(serialized).not.toContain("@");
  for (const banned of ["resume", "cover_letter", "citizenship", "sponsorship", "gender", "race"]) {
    expect(serialized.toLowerCase(), `properties mention ${banned}`).not.toContain(banned);
  }
}

describe("search_requested, from the dashboard", () => {
  it("fires once a search really was accepted, against the session's own id", async () => {
    const result = await findJobsNow();

    expect(result).toEqual({ ok: true });

    const capture = onlyCapture();
    expect(capture.event).toBe(ANALYTICS_EVENT.SEARCH_REQUESTED);
    expect(capture.event).toBe("search_requested");
    // The `profiles.id` UUID and never the address in `SESSION_EMAIL`, which
    // `getUser` returned on the same object.
    expect(capture.distinctId).toBe(SESSION_USER);
    expect(capture.properties).toEqual({ source: "dashboard" });
    expectNoPersonalData(capture.properties);
  });

  it("distinguishes itself from the cron, which sends the identical Inngest event", async () => {
    await findJobsNow();
    expect(onlyCapture().properties?.source).toBe("dashboard");
  });

  it("does not fire when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    await findJobsNow();

    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  it("does not fire for a refusal, so the event counts searches and not button presses", async () => {
    profile = { attested_at: null, applications_used: 0, applications_cap: 150 };

    const result = await findJobsNow();

    expect(result.ok).toBe(false);
    expect(requestJobSearch).not.toHaveBeenCalled();
    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  it("does not fire when Inngest refused the event", async () => {
    requestJobSearch.mockRejectedValueOnce(new Error("inngest is down"));

    const result = await findJobsNow();

    expect(result.ok).toBe(false);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });
});

describe("intake_completed", () => {
  /**
   * A complete, valid intake. `intakeSchema` is the real one, not a stub, so
   * this has to satisfy every rule in it including the storage path pattern and
   * the attestation literal.
   */
  const RESUME_OBJECT = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
  const LINKEDIN_OBJECT = "1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901";

  function validIntake(overrides: Record<string, unknown> = {}) {
    return {
      citizenshipStatus: "f1",
      f1Status: "opt",
      workAuthorizedUs: true,
      requiresSponsorship: true,
      // JOB-101's eight. Present here because `intakeSchema` is the real one, so
      // a fixture missing a required answer would fail this file at the parse
      // rather than at the assertion, and would say nothing about analytics.
      needsSponsorshipNonUs: true,
      visaStatus: "F-1, currently on OPT",
      clearanceEligibility: "no",
      clearanceLevelHeld: "never_held",
      streetAddress: "12 Peachtree Street NE",
      currentCity: "Atlanta",
      postalCode: "30303",
      currentCountry: "United States",
      willingToRelocate: true,
      targetLocations: ["San Francisco", "New York", "Seattle"],
      gradDate: "2027-05-01",
      earliestStart: "2027-06-01",
      highSchoolName: "Northview High School",
      highSchoolGradYear: 2022,
      // JOB-134. None of these four is sent to analytics either, and the salary
      // expectation and the non-compete answer least of all — see the note in
      // `app/onboarding/actions.ts` about what deliberately does not leave.
      subjectToRestrictiveCovenant: false,
      relativesAtTargetEmployers: false,
      previouslyEmployedAtTargetEmployers: false,
      salaryExpectation: "$120,000, or negotiable",
      resumePath: `${SESSION_USER}/${RESUME_OBJECT}.pdf`,
      attestation: true,
      ...overrides,
    };
  }

  it("fires only once everything it attests to is in the database", async () => {
    const result = await submitIntake(validIntake());

    expect(result).toEqual({ ok: true });

    const capture = onlyCapture();
    expect(capture.event).toBe(ANALYTICS_EVENT.INTAKE_COMPLETED);
    expect(capture.event).toBe("intake_completed");
    expect(capture.distinctId).toBe(SESSION_USER);
  });

  it("sends the shape of the answers and none of their content", async () => {
    await submitIntake(
      validIntake({ linkedinPdfPath: `${SESSION_USER}/${LINKEDIN_OBJECT}.pdf` })
    );

    const capture = onlyCapture();

    // Two facts about the shape. Not the city, not the country, not the
    // graduation date, and above all not the citizenship or sponsorship
    // answers, which `submitIntake` writes to `profiles` on the line above.
    // JOB-101 added a security clearance status, a visa status and a home
    // address to that same write, and none of those goes out here either. The
    // exact-equality assertion is what keeps that true: a new property added to
    // the capture fails this test rather than shipping quietly.
    expect(capture.properties).toEqual({
      has_linkedin_pdf: true,
      target_location_count: 3,
    });
    expectNoPersonalData(capture.properties);
  });

  it("reports no LinkedIn export as false rather than omitting it", async () => {
    await submitIntake(validIntake());
    expect(onlyCapture().properties?.has_linkedin_pdf).toBe(false);
  });

  it("does not fire when the payload was rejected", async () => {
    const result = await submitIntake({ citizenshipStatus: "not a real option" });

    expect(result.ok).toBe(false);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  it("does not fire when the resume insert failed, because the intake is not complete", async () => {
    resumeInsertError = { message: "storage path rejected" };

    const result = await submitIntake(validIntake());

    expect(result.ok).toBe(false);
    expect(captureServerEvent).not.toHaveBeenCalled();
    // JOB-112. No row, nothing to parse. Asking for a parse of a resume that
    // was never stored would be a run somebody has to go and look at, for an
    // intake that did not happen.
    expect(requestDocumentParse).not.toHaveBeenCalled();
  });
});
