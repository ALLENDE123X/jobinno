-- v1-C (#143): async escalation flow.
--
-- Four columns on `applications` that carry the escalation state, and one on
-- `profiles` that names the channel the notifier uses.
--
-- The four escalation columns are all written by the pipeline, which holds the
-- service role key, so nothing here needs to grant them to `authenticated` —
-- and `applications` has no `update` policy at all (see the header on the table
-- in `lib/db/schema.ts`), so a user session cannot update this table through
-- PostgREST regardless. The resume path is a server action that runs against
-- the service role client on behalf of the signed in user.
--
-- Idempotent because these columns were applied ad hoc in an earlier session
-- against this project; a fresh CI database has to end up with the same shape
-- either way.

ALTER TABLE public.applications
    ADD COLUMN IF NOT EXISTS escalation_questions jsonb,
    ADD COLUMN IF NOT EXISTS escalation_created_at timestamptz,
    ADD COLUMN IF NOT EXISTS escalation_resolved_at timestamptz,
    ADD COLUMN IF NOT EXISTS escalation_notified_at timestamptz;
