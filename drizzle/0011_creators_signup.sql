CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"ref_code" text NOT NULL,
	"instagram_handle" text,
	"linkedin_handle" text,
	"tiktok_handle" text,
	"twitter_handle" text,
	"other_social" text,
	"payout_method" text NOT NULL,
	"payout_tag" text NOT NULL,
	"phone_number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creators_email_key" UNIQUE("email"),
	CONSTRAINT "creators_ref_code_key" UNIQUE("ref_code"),
	CONSTRAINT "creators_payout_method_check" CHECK ("payout_method" in ('zelle', 'venmo', 'cashapp')),
	CONSTRAINT "creators_at_least_one_social_check" CHECK ("creators"."instagram_handle" is not null or "creators"."linkedin_handle" is not null or "creators"."tiktok_handle" is not null or "creators"."twitter_handle" is not null or "creators"."other_social" is not null)
);
--> statement-breakpoint
ALTER TABLE "creators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "creators_insert_any" ON "creators" AS PERMISSIVE FOR INSERT TO "anon", "authenticated" WITH CHECK (true);