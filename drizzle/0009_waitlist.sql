CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"biggest_frustration" text,
	"weekly_application_volume" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_email_key" UNIQUE("email"),
	CONSTRAINT "waitlist_weekly_application_volume_check" CHECK ("weekly_application_volume" in ('under_5', '5_to_15', '16_to_30', '30_plus'))
);
--> statement-breakpoint
ALTER TABLE "waitlist" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skip_log" DROP CONSTRAINT "skip_log_reason_check";--> statement-breakpoint
ALTER TABLE "skip_log" ADD CONSTRAINT "skip_log_reason_check" CHECK ("reason" in ('unanswerable_required', 'verification_required', 'captcha', 'dom_changed', 'timeout', 'submit_failed', 'blocked_redirect', 'needs_attestation', 'internal_error', 'bot_detected'));--> statement-breakpoint
CREATE POLICY "waitlist_insert_any" ON "waitlist" AS PERMISSIVE FOR INSERT TO "anon", "authenticated" WITH CHECK (true);