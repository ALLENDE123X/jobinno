CREATE TYPE "public"."citizenship_status" AS ENUM('us_citizen', 'permanent_resident', 'f1', 'h1b', 'other');--> statement-breakpoint
CREATE TYPE "public"."f1_status" AS ENUM('opt', 'cpt', 'none');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('free', 'starter', 'season_pass');--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"submitted_at" timestamp with time zone,
	"confirmation_text" text,
	"redirect_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ats" text NOT NULL,
	"company" text NOT NULL,
	"board_token" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "boards_ats_board_token_key" UNIQUE("ats","board_token")
);
--> statement-breakpoint
ALTER TABLE "boards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_category_check" CHECK ("category" in ('bug', 'feature', 'other'))
);
--> statement-breakpoint
ALTER TABLE "feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"ats" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"location" text,
	"url" text NOT NULL,
	"description" text,
	"posted_at" timestamp with time zone,
	"is_intern" boolean DEFAULT false NOT NULL,
	"is_new_grad" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	CONSTRAINT "jobs_ats_external_id_key" UNIQUE("ats","external_id")
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"plan" "plan_tier" DEFAULT 'free' NOT NULL,
	"applications_used" integer DEFAULT 0 NOT NULL,
	"applications_cap" integer DEFAULT 0 NOT NULL,
	"citizenship_status" "citizenship_status",
	"f1_status" "f1_status",
	"work_authorized_us" boolean,
	"requires_sponsorship" boolean,
	"current_city" text,
	"current_country" text,
	"willing_to_relocate" boolean,
	"grad_date" date,
	"earliest_start" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "resumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"linkedin_pdf_path" text,
	"parsed" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resumes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "skip_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid,
	"job_id" uuid NOT NULL,
	"ats" text NOT NULL,
	"reason" text NOT NULL,
	"field_label" text,
	"field_kind" text,
	"required" boolean,
	"raw_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skip_log_reason_check" CHECK ("reason" in ('unanswerable_required', 'verification_required', 'captcha', 'dom_changed', 'timeout', 'submit_failed'))
);
--> statement-breakpoint
ALTER TABLE "skip_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skip_log" ADD CONSTRAINT "skip_log_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skip_log" ADD CONSTRAINT "skip_log_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_user_id_idx" ON "applications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "applications_job_id_idx" ON "applications" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "feedback_user_id_idx" ON "feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "jobs_board_id_idx" ON "jobs" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "resumes_user_id_idx" ON "resumes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "skip_log_application_id_idx" ON "skip_log" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "skip_log_job_id_idx" ON "skip_log" USING btree ("job_id");--> statement-breakpoint
CREATE POLICY "applications_select_own" ON "applications" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "applications"."user_id");--> statement-breakpoint
CREATE POLICY "applications_insert_own" ON "applications" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "applications"."user_id");--> statement-breakpoint
CREATE POLICY "boards_select_all" ON "boards" AS PERMISSIVE FOR SELECT TO "anon", "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "feedback_insert_any" ON "feedback" AS PERMISSIVE FOR INSERT TO "anon", "authenticated" WITH CHECK ("feedback"."user_id" is null or (select auth.uid()) = "feedback"."user_id");--> statement-breakpoint
CREATE POLICY "feedback_select_own" ON "feedback" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "feedback"."user_id");--> statement-breakpoint
CREATE POLICY "jobs_select_all" ON "jobs" AS PERMISSIVE FOR SELECT TO "anon", "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "profiles_select_own" ON "profiles" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "profiles"."id");--> statement-breakpoint
CREATE POLICY "profiles_update_own" ON "profiles" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((select auth.uid()) = "profiles"."id") WITH CHECK ((select auth.uid()) = "profiles"."id");--> statement-breakpoint
CREATE POLICY "resumes_select_own" ON "resumes" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((select auth.uid()) = "resumes"."user_id");--> statement-breakpoint
CREATE POLICY "resumes_insert_own" ON "resumes" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((select auth.uid()) = "resumes"."user_id");--> statement-breakpoint
CREATE POLICY "skip_log_select_via_own_application" ON "skip_log" AS PERMISSIVE FOR SELECT TO "authenticated" USING (exists (
        select 1
        from public.applications a
        where a.id = skip_log.application_id
          and a.user_id = (select auth.uid())
      ));