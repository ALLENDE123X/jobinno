-- SELECT lockdown on `profiles.stripe_customer_id`, `profiles.browserbase_context_id`
-- and `profiles.gmail_refresh_token`. JOB-192, the follow up
-- `drizzle/0026_profiles_gmail_refresh_token_privileges.sql` explicitly left
-- open at the bottom of its own header.
--
-- Three columns on `profiles` hold values the person does not own and should
-- never read directly through PostgREST: `stripe_customer_id` (billing
-- identifier written by the Stripe webhook), `browserbase_context_id` (a
-- Browserbase handle owned by the pipeline) and `gmail_refresh_token` (an
-- AES-256-GCM encrypted refresh token). Every one of them is "our records
-- about a person, not their answers", as `lib/db/schema.ts` puts it, and
-- every one of them should have exactly one reader on this table: the
-- service role.
--
-- Row level security cannot do this on its own. `profiles_select_own`
-- decides which ROW an authenticated user may read; it cannot decide which
-- columns of that row, since a policy applies to the whole row and Postgres
-- has no per column granularity inside one. Column privileges are the other
-- half of that fence, and Supabase's defaults left them wide open:
-- `authenticated` and `anon` both hold a table wide SELECT grant on
-- `profiles`, so a signed in person can read every column of their own row
-- straight through PostgREST, and the three sensitive columns above ride
-- along with the rest of it.
--
-- The metadata this leaks is real. That a row has a `stripe_customer_id`
-- means the person has purchased, that a `browserbase_context_id` exists
-- means a run has started for them, and that a `gmail_refresh_token` is set
-- means Gmail is connected. None of those three is a fact the client should
-- learn by reading the column: each is either surfaced elsewhere on its own
-- terms or deliberately not surfaced at all. Locking them down here is
-- defence in depth against the "read the column and infer" path.
--
-- ── Why the revoke is table wide and the grant is per column ────────────────
-- Same reasoning as `0003_profiles_column_privileges.sql` gives for UPDATE:
-- `REVOKE SELECT (col_a, col_b) ON public.profiles FROM authenticated` on its
-- own would have done nothing at all, because Postgres satisfies a column
-- read from the table level privilege first, and revoking a column level
-- privilege does not touch the table level one, which is exactly what the
-- role held. So the table wide grant goes, and every column a signed in user
-- legitimately reads about themselves is granted back by name.
--
-- That makes this list load bearing, the same way 0003's UPDATE grant list
-- is: a new column on `profiles` is not readable by `authenticated` until a
-- migration grants it. It fails closed, which is the right direction for
-- this table, and every future column ticket now owns two grants rather than
-- one.
--
-- ── The three columns deliberately omitted ─────────────────────────────────
-- `stripe_customer_id`, `browserbase_context_id` and `gmail_refresh_token`
-- are not in the GRANT SELECT list. The column comments in
-- `lib/db/schema.ts` document why for each. The one caller on the user side
-- that was reading `stripe_customer_id` through a session client,
-- `app/api/billing/checkout/route.ts`, is moved to the service role in the
-- same PR that lands this migration. `browserbase_context_id` is only ever
-- read by `lib/fill-application-form.ts`, which already runs as the service
-- role. Nothing reads `gmail_refresh_token` at all yet outside the callback
-- route that writes it, which also uses the service role.
--
-- ── `anon` ─────────────────────────────────────────────────────────────────
-- Revoked too, with nothing granted back. `profiles` has no SELECT policy
-- for `anon`, so row level security already refused every one of those
-- reads, and leaving the grant in place only means the next policy added
-- here decides something by accident. Same reasoning as 0003 for `anon`'s
-- UPDATE grant.
--
-- ── `gmail_refresh_token` is not referenced by name ────────────────────────
-- `0025_profiles_gmail_refresh_token.sql` adds the column, and this file is
-- numbered after it so by the time this runs the column exists in any
-- database applying migrations in order. Nothing in this file names
-- `gmail_refresh_token` explicitly, however: it is simply absent from the
-- grant back list, and that absence is what locks it. Naming it in a
-- documentation only GRANT SELECT to `service_role` would fail on any
-- environment where 0025 has not landed yet, and adds nothing since
-- `service_role` already holds a table wide SELECT and bypasses row level
-- security besides.
--
-- ── The 34 columns granted back are the live schema minus the 3 above ──────
-- The grant list was built from a fresh `information_schema.columns` read
-- against the live database rather than from `lib/db/schema.ts`, per the
-- ticket. It is 34 columns because the table has 37 today and three of them
-- are locked. Any hand written migration that adds a column on `profiles`
-- has to add its own grant to the same list, the same way every existing
-- privileges migration in this directory does.
--
-- ── Hand written rather than generated ─────────────────────────────────────
-- `drizzle-kit generate` reads `lib/db/schema.ts` and the Drizzle schema DSL
-- cannot express GRANT or REVOKE, so this file was created with
-- `drizzle-kit generate --custom` to stay journalled in
-- `drizzle.__drizzle_migrations`. Applied in CI by name from
-- `.github/workflows/ci.yml`, matching every other privilege migration here.
-- `drizzle-kit push`, which CI uses to build its throwaway database, does
-- not apply it.

REVOKE SELECT ON public.profiles FROM authenticated;
--> statement-breakpoint
REVOKE SELECT ON public.profiles FROM anon;
--> statement-breakpoint
GRANT SELECT (
    id,
    email,
    plan,
    applications_used,
    applications_cap,
    citizenship_status,
    f1_status,
    work_authorized_us,
    requires_sponsorship,
    current_city,
    current_country,
    willing_to_relocate,
    target_locations,
    grad_date,
    earliest_start,
    github_url,
    clearance_eligibility,
    clearance_level_held,
    needs_sponsorship_non_us,
    visa_status,
    high_school_name,
    high_school_grad_year,
    street_address,
    postal_code,
    subject_to_restrictive_covenant,
    relatives_at_target_employers,
    previously_employed_at_target_employers,
    salary_expectation,
    attested_at,
    notification_preference,
    last_search_requested_at,
    stored_answers,
    created_at,
    updated_at
) ON public.profiles TO authenticated;
