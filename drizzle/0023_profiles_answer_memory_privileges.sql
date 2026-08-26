-- Grants JOB-134's four new intake columns to `authenticated`, and deliberately
-- does not grant the fifth.
--
-- `0003_profiles_column_privileges.sql` revoked the table wide UPDATE grant
-- Supabase's defaults left on `profiles` and granted back, by name, the columns
-- a person owns about themselves, and said plainly that a column added after it
-- is not writable by `authenticated` until a migration names it. Four of the
-- five columns `0017_profiles_answer_memory.sql` adds are ones a person owns:
-- whether a previous employer's contract still binds them, whether they have
-- relatives at companies they are applying to, whether they have worked at one
-- before, and what they expect to be paid. Every one of them is an answer the
-- person gives about themselves at intake, the same way `current_city` is, so
-- every one of them belongs on the same list.
--
-- ── The fifth, and why it is not on it ─────────────────────────────────────
-- `stored_answers` is not a field on the intake form. It is free text that
-- becomes a fact in the catalogue handed to the model that decides what gets
-- typed onto a real employer's application form. `0016_resumes_column_
-- privileges.sql` settled the same question for `resumes.parsed` and settled it
-- the same way, in its own words: a signed in person being able to write it is
-- "a way to put text of the caller's choosing into the model prompt that
-- decides what goes on a form". Not a privilege escalation, since it is their
-- own application, but not a grant worth making either. The pipeline writes
-- this column with the service role, from an answer the person actually gave in
-- response to a question a real form actually asked.
--
-- The in app surface for answering a pending question, which is item 4 of issue
-- #134 and is not built here, wants a server action that validates the answer
-- against a question the run really escalated. That is the shape to add when
-- somebody builds it, not a column grant here.
--
-- The other counterexamples are already on the table and stay off this list:
-- `stripe_customer_id` is which Stripe customer somebody pays as,
-- `browserbase_context_id` is which browser profile the pipeline reuses for
-- them, and `last_search_requested_at` is a rate limit. All three are our
-- records about a person rather than their answers.
--
-- A second file rather than an edit to 0003, for the reason
-- `0011_profiles_github_url_privileges.sql` gives: 0003 is already journalled
-- and already applied wherever this schema has been pushed, and rewriting an
-- applied migration is how a checksum mismatch or a silently missing grant
-- happens on a database that was migrated before this shipped. A later
-- privilege change is a new file, always.
--
-- Hand written rather than generated, same as 0003, 0011, 0015 and 0016: the
-- Drizzle schema DSL has no way to express GRANT. `.github/workflows/ci.yml`
-- applies those four by explicit name because `drizzle-kit push` cannot see
-- them; this file has the same line added there, for the same reason.

GRANT UPDATE (
    subject_to_restrictive_covenant,
    relatives_at_target_employers,
    previously_employed_at_target_employers,
    salary_expectation
) ON public.profiles TO authenticated;
