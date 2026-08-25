-- v1-C (#143): the channel a pending_user_input notification goes to.
--
-- Defaulted to `email` because Resend is the only wired sender right now
-- (Twilio credentials are absent from `.env.local`), so a user who has never
-- touched this still receives one. The CHECK is the closed set the notifier
-- honours: anything else is a value the notifier cannot dispatch to.
--
-- The person owns this preference, so it follows the JOB-101 pattern:
-- `authenticated` gets an explicit column grant per the rule
-- `drizzle/0003_profiles_column_privileges.sql` states.

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS notification_preference text NOT NULL DEFAULT 'email';

ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS profiles_notification_preference_check;
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_notification_preference_check
    CHECK (notification_preference IN ('email', 'sms', 'both'));

GRANT UPDATE (notification_preference) ON public.profiles TO authenticated;
