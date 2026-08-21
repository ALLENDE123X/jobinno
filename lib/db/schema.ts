/**
 * Jobinno's Postgres schema (JOB-002).
 *
 * Everything here lives in Supabase's `public` schema and is reached two ways:
 * the Next.js app talks to it through PostgREST with a user's JWT, and the
 * pipeline in `lib/` talks to it with the service role key. Those two callers
 * have very different powers, and the row level security policies at the bottom
 * of each table are what keeps that difference safe. The service role bypasses
 * RLS entirely, so every policy below is written for the browser side only.
 *
 * JOB-004 pointed the ported modules at these tables. They still reach Supabase
 * through `@supabase/supabase-js` rather than through Drizzle, which is the half
 * of that reconciliation still open, but the names and columns they use are the
 * ones below. `lib/future-gmail/` is the one exception, and it is unwired
 * reference code; see its README.
 *
 * ── Why `profiles` and not `users` ──────────────────────────────────────────
 * Supabase Auth owns `auth.users`. A second table called `users` in `public`
 * means every query, view and policy in the codebase has to say which one it
 * means, and the day one of them does not is the day a query silently reads the
 * wrong table. `profiles` keyed by the same uuid costs nothing and removes the
 * ambiguity for good.
 *
 * ── Why the checks are checks and not enums ─────────────────────────────────
 * Three columns get a real Postgres enum (`plan`, `citizenship_status`,
 * `f1_status`) because their values are a closed set that changes only with a
 * product decision. `skip_log.reason` and `feedback.category` get CHECK
 * constraints built from the exported arrays instead, because widening a CHECK
 * is a one line migration while removing a value from a Postgres enum is not.
 * `boards.ats` and `jobs.ats` get neither: supporting a new ATS platform is a
 * routine addition and should not need a migration to land.
 *
 * ── Why `applications.status` is free text ──────────────────────────────────
 * The status vocabulary already exists, in `lib/application-status.ts`, and
 * CLAUDE.md is explicit that nothing may add a second competing enum. Its own
 * docstring says the column is free text with a `discovered` default and that
 * the values are a convention rather than a constraint. That property is worth
 * keeping: a status column that rejects a value a running pipeline wants to
 * write fails in the worst possible place, halfway through a real application.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  anonRole,
  authUid,
  authUsers,
  authenticatedRole,
} from "drizzle-orm/supabase";

// ───────────────────────────────────
// Vocabularies
// ───────────────────────────────────

/** Billing tiers. `applications_cap` is what actually gates a run. */
export const planEnum = pgEnum("plan_tier", ["free", "starter", "season_pass"]);

/**
 * Work authorization, as an application form asks it. Kept coarse on purpose:
 * these are the only distinctions the answer generator needs, and every extra
 * one is another piece of immigration status stored about a real person.
 */
export const citizenshipStatusEnum = pgEnum("citizenship_status", [
  "us_citizen",
  "permanent_resident",
  "f1",
  "h1b",
  "other",
]);

/** Only meaningful when `citizenship_status` is `f1`; null otherwise. */
export const f1StatusEnum = pgEnum("f1_status", ["opt", "cpt", "none"]);

/**
 * Why a listing was abandoned. The pipeline writes one of these and nothing
 * else, so the set is closed and enforced.
 *
 * `needs_attestation` is the one that matters most: a required work
 * authorization, citizenship, clearance, export control or criminal history
 * question that the intake data does not answer, on a control offering no way to
 * decline. HARD STOP 9 says the run stops and the question is surfaced rather
 * than guessed at, and this is the row that records that it happened.
 *
 * JOB-022 narrowed that rule to those questions alone. `unanswerable_required`
 * is what is left of it: a required field of any other kind that the run could
 * not put an answer in. It should now be uncommon, because most of the form is
 * answered on a best effort basis rather than escalated.
 */
export const SKIP_REASONS = [
  "unanswerable_required",
  "verification_required",
  "captcha",
  "dom_changed",
  "timeout",
  "submit_failed",
  // ── JOB-022: three values, because six were not enough to debug with ──────
  //
  // `skipReasonFor` fell back to `dom_changed` for any message none of its tags
  // recognised, and the comment defending that argued that a bucket naming
  // nothing is where unfixed bugs accumulate quietly. It was right about the
  // principle and the fallback did the opposite of it. On 2026 08 20 that
  // fallback filed 16 failures under `dom_changed`; an operator read that as one
  // broken selector across eight unrelated companies, and a day went into a page
  // structure theory of a problem that had nothing to do with page structure.
  //
  // `blocked_redirect` is the specific case that was hiding inside
  // `dom_changed`: the browser followed a listing and arrived somewhere the
  // board does not own. Nothing typed, nothing uploaded, and nothing wrong with
  // the form. That is a stale or rehosted listing, and the fix belongs in the
  // board registry rather than in the automation.
  "blocked_redirect",
  // A required legal attestation with no stored answer and no decline option.
  // Split out from `unanswerable_required` because the two now mean different
  // things and want different fixes: this one is closed by asking the person a
  // question once and keeping the answer.
  "needs_attestation",
  // The honest fallback. A run that failed in a way no tag recognises is a bug
  // in this system until somebody shows otherwise, and it should read as one
  // rather than borrow the name of a real and diagnosable failure mode.
  "internal_error",
  // ── JOB-026: the board said, in its own words, that it thinks this is a bot ─
  //
  // Distinct from `captcha`, and the distinction is the whole point of the
  // value. `captcha` is a challenge standing in front of the form: it is
  // visible, it is found before anything is submitted, and the run stops
  // without clicking. This one is the opposite end of the run. There is no
  // visible challenge anywhere on the page, the form fills normally, the submit
  // control is clicked, and the board then replies that it scored the
  // submission as automated and threw it away.
  //
  // Distinct from `submit_failed` too, which is where all five of these landed
  // on 2026 08 21 and is why they were unreadable. `submit_failed` means the
  // submit leg died and nobody knows what the board did with it. This means the
  // board answered, and the answer was no. Those want opposite responses: one
  // wants a human to go and check the employer's side in case an application is
  // sitting there, and this one wants the fingerprint of the browser doing the
  // submitting to change, because nothing on the employer's side is going to
  // improve on its own.
  "bot_detected",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** What a piece of feedback is about. */
export const FEEDBACK_CATEGORIES = ["bug", "feature", "other"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/**
 * Roughly how many applications a waitlist signup submits in a typical week,
 * self reported on the waitlist form (JOB-031). Coarse buckets rather than a
 * raw number: nobody knows their own count to the application, a dropdown is
 * one tap on a form that is trying to lose as little of its conversion as
 * possible, and the only use this ever gets is segmenting power users from
 * casual ones later, which four buckets already supports.
 */
export const WAITLIST_WEEKLY_VOLUME_BUCKETS = [
  "under_5",
  "5_to_15",
  "16_to_30",
  "30_plus",
] as const;
export type WaitlistWeeklyVolumeBucket =
  (typeof WAITLIST_WEEKLY_VOLUME_BUCKETS)[number];

/**
 * The ATS platforms V1 targets, per CLAUDE.md. Not a database constraint, see
 * the header. Validate against this in application code.
 */
export const ATS_PLATFORMS = [
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "bamboohr",
  "breezy",
  "jazzhr",
  "recruitee",
  "teamtailor",
  "smartrecruiters",
] as const;
export type AtsPlatform = (typeof ATS_PLATFORMS)[number];

/**
 * `"col" in ('a', 'b')` as raw SQL. The values come from the frozen arrays
 * above and never from user input, so there is nothing here to inject.
 */
function inList(column: string, values: readonly string[]) {
  const literals = values.map((value) => `'${value}'`).join(", ");
  return sql.raw(`"${column}" in (${literals})`);
}

// ───────────────────────────────────
// profiles
// ───────────────────────────────────

/**
 * One row per signed up person, keyed by `auth.users.id`. Deleting the auth
 * user cascades here, and from here to resumes and applications, which is the
 * whole account deletion story in one constraint.
 *
 * Note what is not here: race, gender, veteran status and disability status.
 * HARD STOP 10 says those are answered "decline to self identify" on every form
 * and never stored, so there is deliberately nowhere to store them.
 */
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    email: text("email").notNull(),

    plan: planEnum("plan").notNull().default("free"),
    applicationsUsed: integer("applications_used").notNull().default(0),
    /**
     * Zero by default, and deliberately so. An unset cap has to mean "cannot
     * apply yet" rather than "apply without limit": the failure of a wrong
     * default here is billable work done for free, on someone else's job board.
     * Whatever provisions the plan sets the real number.
     */
    applicationsCap: integer("applications_cap").notNull().default(0),

    /**
     * The Stripe customer this person pays as. Added by JOB-010.
     *
     * Billing state, so it sits on our side of the line that
     * `drizzle/0003_profiles_column_privileges.sql` drew: no grant to
     * `authenticated`, which after that migration means a new column is not
     * writable by a user session at all. Only the Stripe webhook, holding the
     * service role key, ever sets it.
     *
     * It exists because the subscription lifecycle events arrive months after
     * the checkout that created them and name a customer rather than a person.
     * `customer.subscription.deleted` carries the metadata we attached, but
     * `invoice.payment_failed` reliably carries only the customer, so without a
     * stored id a lapse has no way home to a profile row.
     *
     * Unique, because two profiles claiming one Stripe customer would make that
     * lookup ambiguous exactly when it is deciding whether to take somebody's
     * paid plan away. Null until the person's first purchase.
     */
    stripeCustomerId: text("stripe_customer_id"),

    citizenshipStatus: citizenshipStatusEnum("citizenship_status"),
    f1Status: f1StatusEnum("f1_status"),
    workAuthorizedUs: boolean("work_authorized_us"),
    requiresSponsorship: boolean("requires_sponsorship"),

    currentCity: text("current_city"),
    currentCountry: text("current_country"),
    willingToRelocate: boolean("willing_to_relocate"),
    /**
     * Added by JOB-007, because the intake form asks for it and there was
     * nowhere to put the answer. `willing_to_relocate` on its own is a yes or a
     * no with no destination attached, and "yes, anywhere in the US" and "yes,
     * but only to New York" are different instructions to a search that has to
     * decide which listings are worth opening.
     *
     * A `text[]` rather than a join table: these are place names a person
     * typed, not entities anything joins against, and the only question ever
     * asked of them is whether a listing's location looks like one of them.
     * Null means the question has not been answered yet, which is a different
     * state from an empty array meaning nowhere in particular.
     */
    targetLocations: text("target_locations").array(),

    gradDate: date("grad_date"),
    earliestStart: date("earliest_start"),

    /**
     * When the person confirmed their intake is accurate and authorized us to
     * apply on their behalf. Added by JOB-007.
     *
     * A column rather than a checkbox the form merely insists on, because the
     * attestation is what every generated answer stands on. HARD STOP 9 says no
     * answer may contain a fact the intake does not support, and the reason
     * that matters is that submitting an application is the applicant asserting
     * it is all true. If nothing records that they ever asserted it, the
     * pipeline has no way to check before it submits, and the checkbox was
     * decoration after all.
     *
     * Null means not yet attested, which is the state of any profile row
     * created at signup and not yet taken through intake.
     */
    attestedAt: timestamp("attested_at", { withTimezone: true }),

    /**
     * When a job search was last asked for on this person's behalf. The whole of
     * the server side rate limit on the dashboard's "Find Jobs Now" button; see
     * `lib/search-cooldown.ts` for why it is a column and not a derived signal.
     *
     * Ours, not the person's, so it stays out of `0003_profiles_column_privileges.sql`'s
     * grant list deliberately: `authenticated` holds no table wide UPDATE on
     * `profiles` any more, which leaves this writable only by the service role
     * and by the Drizzle connection. A rate limit the rate limited party can
     * reset is not a rate limit.
     *
     * Null means nobody has ever pressed the button for them, which is the state
     * of every row that predates this column and of every new signup.
     */
    lastSearchRequestedAt: timestamp("last_search_requested_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("profiles_stripe_customer_id_key").on(table.stripeCustomerId),
    pgPolicy("profiles_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.id}`,
    }),
    /**
     * No insert policy: the row is created for a new signup by the service
     * role, so a client cannot mint a profile for an id it does not own.
     *
     * `with check` repeats the `using` expression because without it a user
     * could update their own row into someone else's id.
     */
    pgPolicy("profiles_update_own", {
      for: "update",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.id}`,
      withCheck: sql`${authUid} = ${table.id}`,
    }),
  ]
);

// ───────────────────────────────────
// resumes
// ───────────────────────────────────

/**
 * A resume is a private Storage object; this row is the pointer to it plus
 * whatever the parser made of it. `storage_path` is a bucket qualified path and
 * not a fetchable URL, which is the convention `lib/candidate-intake.ts` writes
 * it under and `lib/resume-parser.ts` reads it under.
 */
export const resumes = pgTable(
  "resumes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    storagePath: text("storage_path").notNull(),
    /** A LinkedIn profile export, when the user gave one. Same private bucket. */
    linkedinPdfPath: text("linkedin_pdf_path"),
    /** Whatever `lib/resume-parser.ts` extracted. Null until it has run. */
    parsed: jsonb("parsed"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("resumes_user_id_idx").on(table.userId),
    pgPolicy("resumes_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.userId}`,
    }),
    pgPolicy("resumes_insert_own", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${table.userId}`,
    }),
  ]
);

// ───────────────────────────────────
// boards and jobs
// ───────────────────────────────────

/**
 * A company's job board on one ATS. `board_token` is whatever that ATS calls
 * the tenant in its own API: the Greenhouse board token, the Lever site name,
 * the Ashby org slug. Unique per platform, because the same string can name
 * different companies on two different ATS platforms.
 *
 * Not user scoped and carries no personal data, so it is world readable. RLS is
 * still enabled with a select only policy, because a Supabase table with RLS
 * off is fully writable by anyone holding the anon key.
 */
export const boards = pgTable(
  "boards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ats: text("ats").notNull(),
    company: text("company").notNull(),
    boardToken: text("board_token").notNull(),
    active: boolean("active").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (table) => [
    unique("boards_ats_board_token_key").on(table.ats, table.boardToken),
    pgPolicy("boards_select_all", {
      for: "select",
      to: [anonRole, authenticatedRole],
      using: sql`true`,
    }),
  ]
);

/**
 * One listing. `raw` keeps the ATS payload the row was built from, because the
 * fields we parse out today are not the fields a later ticket will want, and
 * refetching a listing that has since closed is not possible.
 *
 * `is_intern` and `is_new_grad` are the filter the whole product turns on. They
 * are stored rather than derived at query time so that the classification a run
 * actually used stays visible after the heuristic behind it changes.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    /** Denormalized from `boards.ats` so the unique key below can stand alone. */
    ats: text("ats").notNull(),
    /** The listing's id in the ATS, not ours. */
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    location: text("location"),
    url: text("url").notNull(),
    description: text("description"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    isIntern: boolean("is_intern").notNull().default(false),
    isNewGrad: boolean("is_new_grad").notNull().default(false),
    raw: jsonb("raw"),
  },
  (table) => [
    unique("jobs_ats_external_id_key").on(table.ats, table.externalId),
    index("jobs_board_id_idx").on(table.boardId),
    pgPolicy("jobs_select_all", {
      for: "select",
      to: [anonRole, authenticatedRole],
      using: sql`true`,
    }),
  ]
);

// ───────────────────────────────────
// applications
// ───────────────────────────────────

/**
 * One person's run against one listing. `status` uses the vocabulary in
 * `lib/application-status.ts`; see the header for why it is text.
 *
 * There is no update policy. `submitted` is terminal and can never be undone,
 * and `submission_unconfirmed` must never be retried, so the browser side gets
 * no way to move a status at all. Only the pipeline, on the service role key,
 * writes to this column.
 */
export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("discovered"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** What the board showed back: a reference number, or its wording. */
    confirmationText: text("confirmation_text"),
    /** Where the board sent the browser after submit, when it sent it anywhere. */
    redirectUrl: text("redirect_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("applications_user_id_idx").on(table.userId),
    index("applications_job_id_idx").on(table.jobId),
    pgPolicy("applications_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.userId}`,
    }),
    pgPolicy("applications_insert_own", {
      for: "insert",
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${table.userId}`,
    }),
  ]
);

// ───────────────────────────────────
// skip_log
// ───────────────────────────────────

/**
 * Why a listing was abandoned, in enough detail to fix the cause. The field
 * columns describe the specific control that stopped the run, which is what
 * turns "it failed on Workable again" into a reproducible bug.
 *
 * `application_id` is nullable because a listing can be skipped before there is
 * an application row to hang the skip off. Those rows are invisible to every
 * end user by design, see the policy below.
 *
 * Nobody but the pipeline writes here, so there is no insert, update or delete
 * policy. With RLS enabled and no such policy, PostgREST refuses those verbs
 * outright for anon and authenticated; the service role key bypasses RLS and is
 * unaffected.
 */
export const skipLog = pgTable(
  "skip_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id").references(() => applications.id, {
      onDelete: "cascade",
    }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    ats: text("ats").notNull(),
    reason: text("reason").notNull(),
    /** The label as it appeared on the page, verbatim. */
    fieldLabel: text("field_label"),
    /** The control type, from `lib/form-fields.ts`'s vocabulary. */
    fieldKind: text("field_kind"),
    required: boolean("required"),
    /** Anything else worth keeping. Never a screenshot and never resume text. */
    rawContext: jsonb("raw_context"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("skip_log_reason_check", inList("reason", SKIP_REASONS)),
    index("skip_log_application_id_idx").on(table.applicationId),
    index("skip_log_job_id_idx").on(table.jobId),
    /**
     * Readable by whoever owns the application it belongs to. Written as a
     * subquery rather than a denormalized `user_id` so that ownership has
     * exactly one definition, on `applications`, and cannot drift.
     *
     * The cost is that a skip with no application row is readable by nobody but
     * the service role. That is the honest answer for now: such a row has no
     * owner recorded anywhere, and inferring one would be a guess.
     */
    pgPolicy("skip_log_select_via_own_application", {
      for: "select",
      to: authenticatedRole,
      using: sql`exists (
        select 1
        from public.applications a
        where a.id = skip_log.application_id
          and a.user_id = ${authUid}
      )`,
    }),
  ]
);

// ───────────────────────────────────
// feedback
// ───────────────────────────────────

/**
 * Product feedback. `user_id` is nullable because the most useful feedback
 * often comes from someone who bounced off the landing page before signing up.
 *
 * Anyone may insert, including anonymous. Nobody may read anyone else's, and an
 * anonymous row is readable only by the service role, because there is nobody
 * to prove ownership to.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    category: text("category").notNull(),
    body: text("body").notNull(),
    /** `page_url`, `user_agent`, client timestamp. Nothing a form was filled with. */
    context: jsonb("context"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("feedback_category_check", inList("category", FEEDBACK_CATEGORIES)),
    index("feedback_user_id_idx").on(table.userId),
    /**
     * A signed in submitter may only stamp their own id on it. An anonymous
     * submitter may only leave it null. Neither can attribute feedback to
     * somebody else.
     */
    pgPolicy("feedback_insert_any", {
      for: "insert",
      to: [anonRole, authenticatedRole],
      withCheck: sql`${table.userId} is null or ${authUid} = ${table.userId}`,
    }),
    pgPolicy("feedback_select_own", {
      for: "select",
      to: authenticatedRole,
      using: sql`${authUid} = ${table.userId}`,
    }),
  ]
);

// ───────────────────────────────────
// waitlist
// ───────────────────────────────────

/**
 * Signups collected while the live site is gated behind the waitlist landing
 * page (JOB-031). See `middleware.ts` for the gate itself.
 *
 * Nothing here references `profiles`. The gate exists precisely because
 * signing in is gated too, so there is no account for a row to belong to yet,
 * and unlike `feedback` there is no later state where one appears: a waitlist
 * signup either becomes a real signup after the gate lifts, in which case
 * `profiles` gets its own row the ordinary way, or it never does.
 *
 * `email` is the only required column, on purpose. A waitlist form loses real
 * signups for every field it insists on, and the one fact this table has to
 * hold to be useful at all is an address to write to when the product is
 * ready. `name`, `biggest_frustration` and `weekly_application_volume` are
 * all nullable, all optional on the form, and answered by nobody who does not
 * want to bother.
 */
export const waitlist = pgTable(
  "waitlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Trimmed and lowercased before it ever reaches this column, see
     * `lib/waitlist.ts`. The unique constraint below is what a second signup
     * from the same address actually hits, so the normalisation has to happen
     * before the insert and not be trusted to Postgres.
     */
    email: text("email").notNull(),
    name: text("name"),
    /** Free text answer to "what is the most frustrating part of job hunting right now". */
    biggestFrustration: text("biggest_frustration"),
    /** One of `WAITLIST_WEEKLY_VOLUME_BUCKETS`, or null if the question was skipped. */
    weeklyApplicationVolume: text("weekly_application_volume"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("waitlist_email_key").on(table.email),
    check(
      "waitlist_weekly_application_volume_check",
      inList("weekly_application_volume", WAITLIST_WEEKLY_VOLUME_BUCKETS)
    ),
    /**
     * Anyone may insert, anonymous included, since the whole point of this
     * table is to collect signups from people who by definition hold no
     * session. `with check` is unconditional because there is no `user_id`
     * column here for it to guard.
     *
     * There is no select policy at all, matching the posture
     * `cached_form_actions` takes below and for the same reason: RLS enabled
     * with no policy for a verb is PostgREST refusing that verb outright for
     * `anon` and `authenticated`, and nobody holding the public anon key has
     * any business reading back a list of email addresses other people
     * submitted, including their own, since there is no session to prove which
     * row that even is. The service role bypasses RLS for whoever reads the
     * list back for real.
     */
    pgPolicy("waitlist_insert_any", {
      for: "insert",
      to: [anonRole, authenticatedRole],
      withCheck: sql`true`,
    }),
  ]
);

// ───────────────────────────────────
// cached_form_actions
// ───────────────────────────────────

/**
 * JOB-006. One replayable action plan per ATS form shape.
 *
 * Not user data. A row says "on a Greenhouse form of this shape, the First Name
 * box is at this selector", which is a fact about a public job board that every
 * user's run reads and every user's run may improve. That sharing is the whole
 * point: `observe()` is an LLM call, and paying for it once per form shape
 * rather than once per application is what makes a $99 Season Pass covering 500
 * applications work at all.
 *
 * `lib/form-action-cache.ts` owns the format and the rules, including why no
 * model written `description` is ever stored here and why only field lookups
 * are served from it.
 *
 * ── Why RLS is on with no policy at all ─────────────────────────────────────
 * `boards` and `jobs` are world readable because a signed in user's dashboard
 * has a reason to read them. Nothing in the browser has any reason to read a
 * selector, so this gets the posture `skip_log` gets for its writes, applied to
 * every verb: RLS enabled and no policy, which is PostgREST refusing anon and
 * authenticated outright. The pipeline holds the service role key, which
 * bypasses RLS and is unaffected. Leaving RLS off instead would make the table
 * fully writable by anyone holding the anon key, and a stranger who can write
 * here can aim a real candidate's resume at a control of their choosing.
 */
export const cachedFormActions = pgTable(
  "cached_form_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Platform slug, from the form's own hostname. `unknown` for a self hosted board. */
    ats: text("ats").notNull(),
    /** Hex digest of the form's boilerplate shape. See `fingerprintFormShape`. */
    formFingerprint: text("form_fingerprint").notNull(),
    /**
     * Which recipe produced `form_fingerprint`. Stored as well as folded into
     * the digest, so that a superseded generation of rows can be found and
     * deleted rather than only ever being missed.
     */
    shapeVersion: integer("shape_version").notNull().default(1),
    /** The tokens the digest was built from, so a changed key can be explained. */
    shapeTokens: jsonb("shape_tokens"),
    /**
     * Instruction to `{ selector, method }`, or to null meaning the form does
     * not have that field. The null entries matter as much as the others: a
     * board with no LinkedIn box costs a model call to discover that on every
     * run until something remembers it.
     */
    actions: jsonb("actions").notNull(),
    /** How many field lookups this row has answered without a model call. */
    replayHits: integer("replay_hits").notNull().default(0),
    /** How many replays failed validation and had to be observed live instead. */
    replayInvalidations: integer("replay_invalidations").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("cached_form_actions_ats_fingerprint_key").on(table.ats, table.formFingerprint),
    index("cached_form_actions_ats_idx").on(table.ats),
  ]
).enableRLS();
