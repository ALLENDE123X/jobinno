/**
 * JOB-014 — the whole product analytics vocabulary, and the rule about what is
 * allowed to leave this building.
 *
 * ── Why the vocabulary is a module and not a set of string literals ──────────
 * Five call sites fire events, in three different runtimes: a browser bundle, a
 * server action, and an Inngest function running on a server with no request
 * around it. Spelling an event name at each of those is how a funnel ends up
 * with `search_requested` and `search-requested` in the same project, and a
 * PostHog insight silently counting half the traffic. The names are declared
 * once, here, and every site imports them.
 *
 * ── Why properties are an allowlist rather than a denylist ──────────────────
 * Because the failure mode is asymmetric. A property that should have been sent
 * and was not is a missing chart. A property that should not have been sent and
 * was is somebody's personal data sitting in a third party's database, and
 * there is no taking it back. So the default answer to "may this be sent" is
 * no, and each event names the handful of keys it is allowed to carry.
 * `sanitizeProperties` drops everything else without asking the caller.
 *
 * There is a denylist too, below, and it is not the mechanism. It is the
 * backstop that catches an allowlist somebody widened without thinking.
 *
 * ── What is deliberately never sent, and why ────────────────────────────────
 *  · **Anything matching a demographic question.** HARD STOP 10 in CLAUDE.md:
 *    race, gender, veteran status and disability status are never stored, never
 *    inferred and never transmitted. An analytics property is a transmission.
 *    `BANNED_KEY_RE` carries the same terms `EEO_FIELD_RE` in
 *    `lib/form-fields.ts` matches on. It is a second spelling rather than an
 *    import because that module imports Stagehand, and a browser bundle has no
 *    business pulling a browser automation library in to check a string. The
 *    two are checked against each other by `tests/unit/analytics-events.test.ts`.
 *  · **Immigration and work authorization answers.** `citizenship_status`,
 *    `f1_status`, `work_authorized_us` and `requires_sponsorship` are all real
 *    intake fields and none of them appear in any allowlist below. They are not
 *    on the EEO list, but sponsorship need is a close enough proxy for national
 *    origin that sending it would be doing by inference what HARD STOP 10
 *    forbids doing directly. If a funnel genuinely needs them later, that is a
 *    product decision and its own ticket.
 *  · **Resume text, cover letter text, free text form answers, names, email
 *    addresses, phone numbers and street addresses.** None of these are in an
 *    allowlist, `BANNED_KEY_RE` names them anyway, and `sanitizeProperties`
 *    additionally drops any value that merely looks like an email address.
 *  · **Job titles and company names as free text.** `application_outcome`
 *    carries `ats` and nothing else about the listing. The ATS platform is one
 *    of ten fixed strings and identifies nobody; a job title plus a timestamp
 *    plus a distinct id is a fairly precise description of one person's job
 *    hunt.
 *
 * ── The identifier ──────────────────────────────────────────────────────────
 * Every event is keyed on the Supabase `auth.uid()`, which is the same opaque
 * UUID `applications.user_id` and `skip_log` are scoped by. Never the email
 * address, never a name. `lib/feedback.ts` reached the same conclusion for the
 * same reason: the id is what the database already joins on, and it says
 * nothing about the person to anybody who does not already hold the database.
 */

import { APPLICATION_STATUS, type ApplicationStatus } from "@/lib/application-status";

// ───────────────────────────────────
// The events
// ───────────────────────────────────

/**
 * Every custom event Jobinno sends. `$pageview` is not here because PostHog
 * owns that name and `components/analytics.tsx` sends it verbatim.
 */
export const ANALYTICS_EVENT = {
  /** A sign in link was asked for. Fired in the browser, before any session. */
  MAGIC_LINK_REQUESTED: "magic_link_requested",
  /** A link was opened and a real session now exists. Fired by the callback route. */
  SESSION_ESTABLISHED: "session_established",
  /** Intake was saved and attested to. The end of onboarding. */
  INTAKE_COMPLETED: "intake_completed",
  /** A search was asked for, by a person or by the cron. `source` says which. */
  SEARCH_REQUESTED: "search_requested",
  /** One listing finished, however it finished. The bottom of the funnel. */
  APPLICATION_OUTCOME: "application_outcome",
} as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENT)[keyof typeof ANALYTICS_EVENT];

/** What a property is allowed to be once sanitized. Nothing nested, ever. */
export type AnalyticsPropertyValue = string | number | boolean | null;
export type AnalyticsProperties = Record<string, AnalyticsPropertyValue>;

/**
 * Which keys each event may carry.
 *
 * Read this as the answer to "what does this event tell us", and note how short
 * every line is. That is the point rather than an oversight: each of these is a
 * fact about the funnel and none of them is a fact about a person.
 */
export const ALLOWED_PROPERTIES: Readonly<Record<AnalyticsEvent, ReadonlySet<string>>> = {
  // "sent" or "refused". Never the address the link was sent to.
  [ANALYTICS_EVENT.MAGIC_LINK_REQUESTED]: new Set(["outcome"]),
  // One of the routes the callback actually redirects to, or "other". Bucketed
  // in the route rather than passed through; see `knownDestination` there.
  [ANALYTICS_EVENT.SESSION_ESTABLISHED]: new Set(["destination"]),
  // Shape, not content. How many locations somebody named, not which ones.
  [ANALYTICS_EVENT.INTAKE_COMPLETED]: new Set(["has_linkedin_pdf", "target_location_count"]),
  // "dashboard" or "cron".
  [ANALYTICS_EVENT.SEARCH_REQUESTED]: new Set(["source"]),
  // `status` is the `applications.status` value, `outcome` is the coarse bucket
  // derived from it, `ats` is one of the ten supported platforms.
  [ANALYTICS_EVENT.APPLICATION_OUTCOME]: new Set([
    "status",
    "outcome",
    "ats",
    "submit_attempted",
  ]),
};

// ───────────────────────────────────
// The outcome bucket
// ───────────────────────────────────

/** The four ways an application run can end, as a funnel reads them. */
export const APPLICATION_OUTCOME = {
  SUBMITTED: "submitted",
  /** The submit control was pressed and the result is unknown. Never retried. */
  UNCONFIRMED: "unconfirmed",
  /** The form or the board stopped us: a captcha, an unanswerable question, a gate. */
  BLOCKED: "blocked",
  /** Everything else, including a run that threw. */
  FAILED: "failed",
} as const;

export type ApplicationOutcome =
  (typeof APPLICATION_OUTCOME)[keyof typeof APPLICATION_OUTCOME];

/**
 * Which bucket one `applications.status` falls in.
 *
 * Derived rather than stored, and derived here rather than at the call site, so
 * that the pipeline and any later reader agree on what "blocked" counts as.
 * `submission_unconfirmed` gets its own bucket rather than being folded into
 * either neighbour, because it is the one outcome a human has to go and check
 * by hand and a chart that hides it inside "submitted" hides the work.
 */
export function applicationOutcomeFor(status: string): ApplicationOutcome {
  switch (status) {
    case APPLICATION_STATUS.SUBMITTED:
      return APPLICATION_OUTCOME.SUBMITTED;
    case APPLICATION_STATUS.SUBMISSION_UNCONFIRMED:
      return APPLICATION_OUTCOME.UNCONFIRMED;
    case APPLICATION_STATUS.FORM_FILL_BLOCKED:
    case APPLICATION_STATUS.SUBMISSION_BLOCKED:
    case APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED:
      return APPLICATION_OUTCOME.BLOCKED;
    default:
      return APPLICATION_OUTCOME.FAILED;
  }
}

/** Narrowing helper so a caller can hand this an `ApplicationStatus` and keep its type. */
export type KnownApplicationStatus = ApplicationStatus;

// ───────────────────────────────────
// The backstop
// ───────────────────────────────────

/**
 * Property keys that may never be sent, whatever an allowlist says.
 *
 * The first alternation is the EEO vocabulary, matching the terms
 * `EEO_FIELD_RE` in `lib/form-fields.ts` matches on. The second is the ordinary
 * personal data an application form collects. Neither list is reachable through
 * `ALLOWED_PROPERTIES` today, and that is exactly why this is worth keeping:
 * the day somebody adds `company` to an allowlist because a chart wanted it,
 * this is what refuses.
 */
export const BANNED_KEY_RE =
  /(gender|\bsex\b|race|ethnic|hispanic|latin|veteran|disabilit|orientation|lgbt|queer|transgender|self[_\s-]?identif|demographic|citizenship|sponsorship|work[_\s-]?authoriz|visa|f1[_\s-]?status|email|full[_\s-]?name|first[_\s-]?name|last[_\s-]?name|resume|\bcv\b|cover[_\s-]?letter|phone|address|birth|\bdob\b|\bssn\b|salary|\bpay\b|company|job[_\s-]?title|answer|question|body|content|linkedin[_\s-]?url)/i;

/** Anything shaped like an email address, wherever it turns up in a value. */
const EMAIL_LIKE_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * How long a string property may be.
 *
 * Free text is the thing this file exists to keep out, and free text is long.
 * Every legitimate value in the allowlists above is a short enum member, a UUID
 * or a path, so a generous ceiling still refuses a cover letter, a job
 * description, or a form answer that arrived somewhere it should not have.
 */
export const MAX_PROPERTY_CHARS = 120;

/**
 * The properties an event is actually allowed to carry, from the ones a caller
 * offered.
 *
 * Drops rather than throws, on purpose and after some thought. A throw here
 * would turn a mistake in an analytics property into a failed sign in, a failed
 * intake, or a failed application, which is a far worse outcome than a missing
 * chart. It logs instead, loudly enough to be found and quietly enough not to
 * matter, and the tests are what actually hold the line.
 */
export function sanitizeProperties(
  event: AnalyticsEvent,
  properties: Record<string, unknown> | undefined
): AnalyticsProperties {
  if (!properties) return {};

  const allowed = ALLOWED_PROPERTIES[event];
  const clean: AnalyticsProperties = {};

  for (const [key, value] of Object.entries(properties)) {
    if (!allowed?.has(key)) {
      warn(`dropped property "${key}" from ${event}: not in that event's allowlist`);
      continue;
    }
    if (BANNED_KEY_RE.test(key)) {
      warn(`dropped property "${key}" from ${event}: the key names personal data`);
      continue;
    }

    if (value === null || typeof value === "boolean") {
      clean[key] = value;
      continue;
    }

    if (typeof value === "number") {
      // `NaN` and the infinities serialize to `null` in JSON anyway, so sending
      // them would put a hole in a chart and blame the event for it.
      if (!Number.isFinite(value)) {
        warn(`dropped property "${key}" from ${event}: ${String(value)} is not a finite number`);
        continue;
      }
      clean[key] = value;
      continue;
    }

    if (typeof value !== "string") {
      warn(`dropped property "${key}" from ${event}: only strings, numbers, booleans and null`);
      continue;
    }

    if (value.length > MAX_PROPERTY_CHARS) {
      warn(`dropped property "${key}" from ${event}: ${value.length} characters reads as free text`);
      continue;
    }
    if (EMAIL_LIKE_RE.test(value)) {
      warn(`dropped property "${key}" from ${event}: the value looks like an email address`);
      continue;
    }

    clean[key] = value;
  }

  return clean;
}

function warn(message: string): void {
  console.warn(`[job-014] ${message}`);
}

// ───────────────────────────────────
// Configuration
// ───────────────────────────────────

/**
 * The environment variables, read as static member expressions.
 *
 * That is a requirement rather than a style: Next inlines `NEXT_PUBLIC_` reads
 * into the browser bundle at build time, and it only recognises them written
 * out literally. A lookup through a variable key compiles to `undefined` on the
 * client and analytics goes silently dark.
 */
function rawKey(): string {
  return (process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "").trim();
}

/** The ingestion host. Defaults to PostHog Cloud US, which is the project's own region. */
export function analyticsHost(): string {
  const host = (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "").trim();
  return host === "" ? "https://us.i.posthog.com" : host;
}

/**
 * Whether capture is on, and the single place that decides it.
 *
 * Three things have to be true, and each of them is a way this has gone wrong
 * somewhere before:
 *
 *  · **A key is set.** Unset is the normal state in CI and on a fresh checkout,
 *    and it has to mean "do nothing" rather than "throw". `npm run build` in
 *    `.github/workflows/ci.yml` sets no PostHog variables at all.
 *  · **The key is a project key.** PostHog hands out several kinds and only the
 *    `phc_` one belongs in a browser bundle. A personal API key pasted here
 *    would not fail at startup, it would fail as a 401 on every capture, which
 *    presents as an empty dashboard rather than as an error.
 *  · **This is production, or somebody said otherwise.** A developer clicking
 *    around localhost otherwise pollutes the same funnel the product is
 *    measured on. `NEXT_PUBLIC_POSTHOG_CAPTURE_IN_DEV=true` turns capture back
 *    on for the case where the thing being tested is the instrumentation.
 */
export function analyticsEnabled(): boolean {
  const key = rawKey();
  if (key === "") return false;

  if (!key.startsWith("phc_")) {
    warn(
      "NEXT_PUBLIC_POSTHOG_KEY is set but is not a project key, which start with " +
        "phc_. Capture is off rather than failing on every event. See .env.example."
    );
    return false;
  }

  if (process.env.NODE_ENV === "production") return true;
  return process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_IN_DEV === "true";
}

/** The project key, or null when capture is off for any of the reasons above. */
export function analyticsKey(): string | null {
  return analyticsEnabled() ? rawKey() : null;
}
