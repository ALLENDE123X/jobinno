-- JOB-112. Column privileges on `resumes`, for the same reason
-- `0003_profiles_column_privileges.sql` added them to `profiles`: row level
-- security restricts rows and not columns, and Supabase's defaults left every
-- column of this table writable by `authenticated`.
--
-- Until this ticket that was theoretical, because `resumes.parsed` was dead
-- storage nothing wrote and nothing read. It is not theoretical now. `parsed`
-- holds the candidate's employment and education history, extracted from their
-- documents, and it is what the fill pipeline puts on real employers' forms.
-- There is exactly one thing that should be able to write it, and it is not the
-- browser session of the person whose history it is.
--
-- ── What was actually open, and what was not ───────────────────────────────
-- `authenticated` held table wide INSERT and UPDATE grants on `resumes`. Only
-- one of the two was reachable:
--
--   INSERT was live. `resumes_insert_own` permits an insert whose `user_id` is
--   the caller's, and nothing constrained which other columns that insert
--   carried, so a signed in person could POST a row through PostgREST with
--   `parsed` set to anything they liked and have the pipeline fill a form from
--   it. Not a privilege escalation — it is their own application — but it is a
--   way to put text of the caller's choosing into the model prompt that decides
--   what goes on a form, which is precisely the surface `lib/resume-parser.ts`
--   exists to keep narrow.
--
--   UPDATE was not, because this table has no update policy at all, so RLS
--   refused every one of those writes before column privileges were consulted.
--   It is revoked anyway, on the same reasoning `0003` gives for revoking
--   `anon`: leaving a grant in place means the next policy added here decides
--   something by accident.
--
-- ── Why the revoke is table wide and the grant is per column ────────────────
-- Same trap `0003` documents. Postgres satisfies a column write from the table
-- level privilege first, and revoking a column level privilege does not touch
-- the table level one, so revoking `INSERT (parsed)` on its own would have done
-- nothing at all. The table wide grant has to go, and the columns a person
-- genuinely supplies are granted back by name.
--
-- Granted back: `user_id`, `storage_path` and `linkedin_pdf_path`, which are
-- exactly what `app/onboarding/actions.ts` inserts. `id`, `is_active`,
-- `created_at` and `parsed` are left ungranted and take their defaults, which
-- is what makes a re-upload arrive with `parsed` NULL rather than with whatever
-- the client felt like sending.
--
-- Hand written rather than generated, because the Drizzle schema DSL cannot
-- express GRANT or REVOKE. Created with `drizzle-kit generate --custom` so it
-- is still journalled and still recorded in `drizzle.__drizzle_migrations`.
-- Note that `drizzle-kit push`, which is what CI uses to build its throwaway
-- database, does not apply this file.

REVOKE INSERT ON public.resumes FROM authenticated;
--> statement-breakpoint
REVOKE UPDATE ON public.resumes FROM authenticated;
--> statement-breakpoint
REVOKE INSERT ON public.resumes FROM anon;
--> statement-breakpoint
REVOKE UPDATE ON public.resumes FROM anon;
--> statement-breakpoint
GRANT INSERT (
    user_id,
    storage_path,
    linkedin_pdf_path
) ON public.resumes TO authenticated;
--> statement-breakpoint
-- Redundant today: `service_role` holds a table wide grant already and bypasses
-- RLS besides. Written down anyway, because `parsed` now has exactly one writer
-- and a reader of this file should be able to see who it is without going and
-- reading Supabase's role defaults.
GRANT UPDATE (parsed) ON public.resumes TO service_role;
