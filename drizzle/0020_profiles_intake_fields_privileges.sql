-- Grants JOB-101's eight new columns to `authenticated`.
--
-- `0003_profiles_column_privileges.sql` revoked the table wide UPDATE grant
-- Supabase's defaults left on `profiles` and granted back, by name, the columns
-- a person owns about themselves, and said plainly that a column added after it
-- is not writable by `authenticated` until a migration names it. All eight
-- columns added by `0014_profiles_intake_fields.sql` are ones a person owns:
-- their clearance eligibility, the clearance level they have held, whether they
-- would need sponsorship outside the United States, their visa status, their
-- high school and the year they left it, and their street address and postal
-- code. Every one of them is an answer the person gives about themselves at
-- intake, the same way `current_city` or `target_locations` is, so every one of
-- them belongs on the same list.
--
-- The counterexamples are already on the table and stay off this list:
-- `stripe_customer_id` is which Stripe customer somebody pays as, and
-- `browserbase_context_id` is which browser profile the pipeline reuses for
-- them. Both are our records about a person rather than their answers, and
-- neither is theirs to edit.
--
-- A second file rather than an edit to 0003 itself, for the reason
-- `0011_profiles_github_url_privileges.sql` gives: 0003 is already journalled
-- and already applied wherever this schema has been pushed, and rewriting an
-- applied migration is how a checksum mismatch or a silently missing grant
-- happens on a database that was migrated before this shipped. A later
-- privilege change is a new file, always.
--
-- Hand written rather than generated, same as 0003 and 0011: the Drizzle schema
-- DSL has no way to express GRANT, so this was created with `drizzle-kit
-- generate --custom` to stay journalled in `drizzle.__drizzle_migrations` and
-- then filled in by hand. `.github/workflows/ci.yml` applies 0003 and 0011 by
-- explicit name because `drizzle-kit push` cannot see them; this file has the
-- same line added there, for the same reason.

GRANT UPDATE (
    clearance_eligibility,
    clearance_level_held,
    needs_sponsorship_non_us,
    visa_status,
    high_school_name,
    high_school_grad_year,
    street_address,
    postal_code
) ON public.profiles TO authenticated;
