CREATE TABLE "cached_form_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ats" text NOT NULL,
	"form_fingerprint" text NOT NULL,
	"shape_version" integer DEFAULT 1 NOT NULL,
	"shape_tokens" jsonb,
	"actions" jsonb NOT NULL,
	"replay_hits" integer DEFAULT 0 NOT NULL,
	"replay_invalidations" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cached_form_actions_ats_fingerprint_key" UNIQUE("ats","form_fingerprint")
);
--> statement-breakpoint
ALTER TABLE "cached_form_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "cached_form_actions_ats_idx" ON "cached_form_actions" USING btree ("ats");