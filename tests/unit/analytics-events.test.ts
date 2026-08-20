// @vitest-environment node
/**
 * JOB-014. What may leave, and what happens when PostHog is not configured.
 *
 * ── The ones that matter ────────────────────────────────────────────────────
 * Two properties are being defended here and they are not the same property.
 *
 * The first is that no event can carry personal data. `sanitizeProperties` is
 * an allowlist, so the interesting cases are the ones that try to get past it:
 * a key nobody declared, a key that is declared but names something it should
 * not, a value that is free text, and a value that is an email address wearing
 * an innocent key. HARD STOP 10 in CLAUDE.md is the specific rule behind the
 * demographic cases, and the check against `EEO_FIELD_RE` is what stops the two
 * spellings of that vocabulary drifting apart.
 *
 * The second is that none of this can break the app. A missing key, a key of
 * the wrong kind and a PostHog client that refuses to start all have to come
 * out as a resolved promise, because the callers are a sign in, an attestation
 * and a real application against a real employer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SDK is stubbed rather than the module that wraps it, so that the wrapper's
 * own decisions are what gets tested: whether it builds a client at all,
 * whether it flushes, and what it does when the constructor throws.
 */
const capture = vi.fn();
const flush = vi.fn(async () => {});
const constructed = vi.fn();
let constructorThrows: Error | null = null;

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(key: string, options: unknown) {
      constructed(key, options);
      if (constructorThrows) throw constructorThrows;
    }
    capture = capture;
    flush = flush;
  },
}));

import {
  ALLOWED_PROPERTIES,
  ANALYTICS_EVENT,
  APPLICATION_OUTCOME,
  BANNED_KEY_RE,
  MAX_PROPERTY_CHARS,
  analyticsEnabled,
  analyticsHost,
  applicationOutcomeFor,
  sanitizeProperties,
} from "@/lib/analytics/events";
import {
  captureServerEvent,
  captureServerEvents,
  resetAnalyticsClientForTests,
} from "@/lib/analytics/posthog-server";
import { APPLICATION_STATUS } from "@/lib/application-status";
import { EEO_FIELD_RE } from "@/lib/form-fields";

const REAL_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const REAL_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST;
const REAL_DEV = process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_IN_DEV;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  capture.mockClear();
  flush.mockClear();
  constructed.mockClear();
  constructorThrows = null;
  resetAnalyticsClientForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  restore("NEXT_PUBLIC_POSTHOG_KEY", REAL_KEY);
  restore("NEXT_PUBLIC_POSTHOG_HOST", REAL_HOST);
  restore("NEXT_PUBLIC_POSTHOG_CAPTURE_IN_DEV", REAL_DEV);
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("what an event is allowed to carry", () => {
  it("keeps the properties an event declares", () => {
    const clean = sanitizeProperties(ANALYTICS_EVENT.APPLICATION_OUTCOME, {
      status: APPLICATION_STATUS.SUBMITTED,
      outcome: APPLICATION_OUTCOME.SUBMITTED,
      ats: "greenhouse",
      submit_attempted: true,
    });

    expect(clean).toEqual({
      status: "submitted",
      outcome: "submitted",
      ats: "greenhouse",
      submit_attempted: true,
    });
  });

  it("drops the listing's company and title, which are the tempting ones", () => {
    // Both are in scope at the call site in `inngest/job-application-pipeline.ts`
    // and both would make a nicer chart. Neither is sendable: a job title plus a
    // distinct id plus a timestamp describes one person's job hunt.
    const clean = sanitizeProperties(ANALYTICS_EVENT.APPLICATION_OUTCOME, {
      ats: "lever",
      company: "Stripe",
      job_title: "Software Engineer Intern",
      apply_url: "https://jobs.lever.co/example/abc",
    });

    expect(clean).toEqual({ ats: "lever" });
    expect(clean).not.toHaveProperty("company");
    expect(clean).not.toHaveProperty("job_title");
    expect(clean).not.toHaveProperty("apply_url");
  });

  it("drops resume, cover letter and form answer text outright", () => {
    const clean = sanitizeProperties(ANALYTICS_EVENT.APPLICATION_OUTCOME, {
      ats: "ashby",
      resume_text: "Pranav Lende, Georgia Tech",
      cover_letter: "Dear hiring manager",
      answer: "I am excited about this role",
    });

    expect(clean).toEqual({ ats: "ashby" });
  });

  it("drops every demographic key, which HARD STOP 10 forbids transmitting", () => {
    const clean = sanitizeProperties(ANALYTICS_EVENT.APPLICATION_OUTCOME, {
      ats: "workable",
      gender: "declined",
      race: "declined",
      ethnicity: "declined",
      veteran_status: "declined",
      disability_status: "declined",
      sexual_orientation: "declined",
      self_identify: "declined",
    });

    expect(clean).toEqual({ ats: "workable" });
  });

  it("banishes every term EEO_FIELD_RE matches, so the two spellings cannot drift", () => {
    // `lib/form-fields.ts` decides which *form field* is a demographic question.
    // This file decides which *analytics property* is. They are separate
    // regexes because that module imports Stagehand and this one ships to a
    // browser, so this test is what keeps them saying the same thing.
    const terms = [
      "gender",
      "sex",
      "race",
      "ethnicity",
      "hispanic",
      "latino",
      "veteran",
      "disability",
      "sexual orientation",
      "lgbtq",
      "transgender",
      "self identify",
      "demographic",
    ];

    for (const term of terms) {
      expect(EEO_FIELD_RE.test(term), `EEO_FIELD_RE should match ${term}`).toBe(true);
      expect(BANNED_KEY_RE.test(term), `BANNED_KEY_RE should match ${term}`).toBe(true);
    }
  });

  it("drops immigration and work authorization keys even though they are not EEO fields", () => {
    // Sponsorship need is a close enough proxy for national origin that sending
    // it does by inference what HARD STOP 10 forbids doing directly. All four
    // are real `profiles` columns that `submitIntake` has in scope.
    for (const key of [
      "citizenship_status",
      "f1_status",
      "work_authorized_us",
      "requires_sponsorship",
      "visa_status",
    ]) {
      expect(BANNED_KEY_RE.test(key), `${key} should be banned`).toBe(true);
    }

    const clean = sanitizeProperties(ANALYTICS_EVENT.INTAKE_COMPLETED, {
      has_linkedin_pdf: true,
      citizenship_status: "f1_student",
      requires_sponsorship: true,
    });

    expect(clean).toEqual({ has_linkedin_pdf: true });
  });

  it("never lets an email address through, whatever key it arrives under", () => {
    // The login form and the callback route both have the address right there,
    // and the callback's own comment says so. This is the backstop under that.
    const clean = sanitizeProperties(ANALYTICS_EVENT.MAGIC_LINK_REQUESTED, {
      outcome: "someone@university.edu",
    });

    expect(clean).toEqual({});
  });

  it("drops a string long enough to be free text", () => {
    const clean = sanitizeProperties(ANALYTICS_EVENT.SEARCH_REQUESTED, {
      source: "x".repeat(MAX_PROPERTY_CHARS + 1),
    });

    expect(clean).toEqual({});
    expect(sanitizeProperties(ANALYTICS_EVENT.SEARCH_REQUESTED, { source: "cron" })).toEqual({
      source: "cron",
    });
  });

  it("drops nested values, which is how a whole intake object would arrive", () => {
    const clean = sanitizeProperties(ANALYTICS_EVENT.INTAKE_COMPLETED, {
      target_location_count: { length: 3 },
      has_linkedin_pdf: ["yes"],
    });

    expect(clean).toEqual({});
  });

  it("holds every declared allowlist to its own rule", () => {
    // The allowlists are the mechanism, so a later ticket widening one has to
    // pass this: no declared key may name personal data.
    for (const [event, keys] of Object.entries(ALLOWED_PROPERTIES)) {
      for (const key of keys) {
        expect(BANNED_KEY_RE.test(key), `${event}.${key} is on the banned list`).toBe(false);
      }
    }
  });

  it("returns an empty object rather than throwing when handed nothing", () => {
    expect(sanitizeProperties(ANALYTICS_EVENT.SEARCH_REQUESTED, undefined)).toEqual({});
  });
});

describe("the outcome bucket", () => {
  it("keeps submission_unconfirmed out of both of its neighbours", () => {
    // It is the one outcome a human has to check by hand. Folding it into
    // "submitted" would hide that work and folding it into "failed" would
    // report an application that may be with an employer as never sent.
    expect(applicationOutcomeFor(APPLICATION_STATUS.SUBMISSION_UNCONFIRMED)).toBe(
      APPLICATION_OUTCOME.UNCONFIRMED
    );
    expect(applicationOutcomeFor(APPLICATION_STATUS.SUBMITTED)).toBe(
      APPLICATION_OUTCOME.SUBMITTED
    );
  });

  it("buckets the three blocked statuses as blocked", () => {
    expect(applicationOutcomeFor(APPLICATION_STATUS.FORM_FILL_BLOCKED)).toBe("blocked");
    expect(applicationOutcomeFor(APPLICATION_STATUS.SUBMISSION_BLOCKED)).toBe("blocked");
    expect(applicationOutcomeFor(APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED)).toBe("blocked");
  });

  it("buckets anything it does not recognise as failed", () => {
    expect(applicationOutcomeFor(APPLICATION_STATUS.ERROR)).toBe("failed");
    expect(applicationOutcomeFor(APPLICATION_STATUS.DISCOVERED)).toBe("failed");
    expect(applicationOutcomeFor("a status invented in 2027")).toBe("failed");
  });
});

describe("configuration", () => {
  it("is off with no key at all, which is the state in CI and on a fresh checkout", () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    expect(analyticsEnabled()).toBe(false);
  });

  it("is off for a key that is not a project key, rather than failing every event", () => {
    // A personal API key pasted here would not fail at startup, it would 401 on
    // every capture, which presents as an empty dashboard rather than an error.
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phx_a_personal_api_key";
    process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_IN_DEV = "true";
    expect(analyticsEnabled()).toBe(false);
  });

  it("is off outside production unless somebody explicitly asked for it", () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_project_key";
    delete process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_IN_DEV;
    expect(analyticsEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_IN_DEV = "true";
    expect(analyticsEnabled()).toBe(true);
  });

  it("defaults to the project's own region rather than to nothing", () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
    expect(analyticsHost()).toBe("https://us.i.posthog.com");

    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";
    expect(analyticsHost()).toBe("https://eu.i.posthog.com");
  });
});

describe("capturing when PostHog is not configured", () => {
  /** Turns capture on for the cases below, which need a client to exist. */
  function configure(key = "phc_test_project_key") {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = key;
    process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_IN_DEV = "true";
    resetAnalyticsClientForTests();
  }

  it("no ops with no key rather than throwing, which is the state in CI", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    resetAnalyticsClientForTests();

    await expect(
      captureServerEvent({
        event: ANALYTICS_EVENT.SEARCH_REQUESTED,
        distinctId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        properties: { source: "cron" },
      })
    ).resolves.toBeUndefined();

    // Not merely quiet: no client is built at all, so an unconfigured
    // deployment does not pay for one on every capture.
    expect(constructed).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("no ops for a key of the wrong kind rather than failing on every event", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phx_a_personal_api_key";
    process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_IN_DEV = "true";
    resetAnalyticsClientForTests();

    await expect(
      captureServerEvent({
        event: ANALYTICS_EVENT.INTAKE_COMPLETED,
        distinctId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      })
    ).resolves.toBeUndefined();

    expect(constructed).not.toHaveBeenCalled();
  });

  it("survives a client that refuses to start", async () => {
    configure();
    constructorThrows = new Error("invalid api host");

    await expect(
      captureServerEvent({
        event: ANALYTICS_EVENT.SEARCH_REQUESTED,
        distinctId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        properties: { source: "dashboard" },
      })
    ).resolves.toBeUndefined();

    expect(capture).not.toHaveBeenCalled();
  });

  it("survives a flush that rejects, because the caller is a real application", async () => {
    configure();
    flush.mockRejectedValueOnce(new Error("posthog is down"));

    await expect(
      captureServerEvent({
        event: ANALYTICS_EVENT.APPLICATION_OUTCOME,
        distinctId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        properties: { status: APPLICATION_STATUS.SUBMITTED, ats: "greenhouse" },
      })
    ).resolves.toBeUndefined();
  });
});

describe("capturing when PostHog is configured", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_project_key";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";
    process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_IN_DEV = "true";
    resetAnalyticsClientForTests();
  });

  it("sends the sanitized properties and not the ones it was handed", async () => {
    await captureServerEvent({
      event: ANALYTICS_EVENT.APPLICATION_OUTCOME,
      distinctId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      properties: {
        status: APPLICATION_STATUS.SUBMITTED,
        ats: "greenhouse",
        company: "Stripe",
        cover_letter: "Dear hiring manager",
      },
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      distinctId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      event: "application_outcome",
      properties: { status: "submitted", ats: "greenhouse" },
    });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("configures itself for a runtime that gets frozen the moment it responds", async () => {
    await captureServerEvent({
      event: ANALYTICS_EVENT.SEARCH_REQUESTED,
      distinctId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      properties: { source: "cron" },
    });

    // A batch waiting on a timer inside a Vercel function or an Inngest step is
    // a batch that is never sent.
    expect(constructed).toHaveBeenCalledWith("phc_test_project_key", {
      host: "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  });

  it("costs the cron one flush rather than one per person", async () => {
    const userIds = ["a", "b", "c"].map(
      (suffix) => `3f2504e0-4f89-41d3-9a0c-0305e82c330${suffix.charCodeAt(0) % 10}`
    );

    await captureServerEvents(
      userIds.map((distinctId) => ({
        event: ANALYTICS_EVENT.SEARCH_REQUESTED as typeof ANALYTICS_EVENT.SEARCH_REQUESTED,
        distinctId,
        properties: { source: "cron" },
      }))
    );

    expect(capture).toHaveBeenCalledTimes(3);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty distinct id rather than filing events against one busy nobody", async () => {
    await captureServerEvent({
      event: ANALYTICS_EVENT.SEARCH_REQUESTED,
      distinctId: "   ",
      properties: { source: "cron" },
    });

    expect(capture).not.toHaveBeenCalled();
  });
});
