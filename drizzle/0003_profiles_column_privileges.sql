-- Column privileges on `profiles`, because row level security has none.
--
-- `profiles_update_own` decides which row an authenticated user may update. It
-- cannot decide which columns of that row: a policy applies to the whole row,
-- and Postgres has no per column granularity inside one. Column privileges are
-- the other half of that fence, and Supabase's defaults left them wide open.
-- `authenticated` held a table wide UPDATE grant on `profiles`, so a signed in
-- person could PATCH any column of their own row straight through PostgREST.
--
-- Two separate findings, one underlying bug:
--
--   `plan`, `applications_used`, `applications_cap`. Billing state, tracked as
--   issue #2 from JOB-002's review. Nothing reads them for enforcement yet and
--   JOB-010 is the ticket that will, at which point a user could have granted
--   themselves a paid plan by hand.
--
--   `attested_at`, added by JOB-007. Worse, because something already reads it:
--   `/onboarding` treats a non null value as proof that intake is finished, and
--   every other field the intake collects is nullable. A forged timestamp was
--   therefore a complete forged onboarding, with no citizenship answers and no
--   resume row behind it, and HARD STOP 9 rests on that attestation being a
--   real thing a real person did.
--
-- ── Why the revoke is table wide and the grant is per column ────────────────
-- `REVOKE UPDATE (plan, ...) ON public.profiles FROM authenticated` on its own
-- would have done nothing at all here. Postgres satisfies a column write from
-- the table level privilege first, and revoking a column level privilege does
-- not touch the table level one, which is exactly what the role held. So the
-- table wide grant goes, and the columns a person genuinely owns are granted
-- back by name.
--
-- That makes this list load bearing: a new column on `profiles` is not writable
-- by `authenticated` until a migration grants it. It fails closed, which is the
-- right direction for this table, but the ticket adding a column now owns the
-- grant that goes with it.
--
-- Left writable on purpose. `id`, because `profiles_update_own`'s `with check`
-- already pins it to `auth.uid()` and a row cannot be moved to another owner.
-- `email` and `created_at`, because nothing is enforced on either and widening
-- what a person may not edit about themselves is a product decision rather than
-- a security fix.
--
-- `anon` is revoked with nothing granted back. There is no update policy for
-- `anon` on this table, so RLS already refused every one of those writes, and
-- leaving the grant in place only means the next policy added here decides
-- something by accident.
--
-- Hand written rather than generated: `drizzle-kit generate` reads
-- `lib/db/schema.ts`, and the Drizzle schema DSL cannot express GRANT or
-- REVOKE. The file was created with `drizzle-kit generate --custom` so that it
-- is still journalled and still tracked in `drizzle.__drizzle_migrations` like
-- every other migration here. Note that `drizzle-kit push`, which is what CI
-- uses to build its throwaway database, does not apply this file; the CI
-- workflow applies it explicitly for that reason.

REVOKE UPDATE ON public.profiles FROM authenticated;
--> statement-breakpoint
REVOKE UPDATE ON public.profiles FROM anon;
--> statement-breakpoint
GRANT UPDATE (
    id,
    email,
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
    created_at,
    updated_at
) ON public.profiles TO authenticated;
--> statement-breakpoint
-- Redundant today: `service_role` holds a table wide UPDATE already and
-- bypasses RLS besides. Written down anyway, because these four columns now
-- have exactly one writer and a reader of this file should be able to see who
-- it is without going and reading Supabase's role defaults.
GRANT UPDATE (
    plan,
    applications_used,
    applications_cap,
    attested_at
) ON public.profiles TO service_role;
