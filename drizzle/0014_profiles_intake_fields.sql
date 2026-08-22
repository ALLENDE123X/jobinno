-- The eight intake answers that were blocking real applications. JOB-101,
-- which is issue #101 plus what later runs surfaced.
--
-- Every column here was added because a required field on a real employer's
-- form had no stored answer behind it and stopped the run:
--
--   clearance_eligibility, clearance_level_held
--     Blocked Anduril twice as `needs_attestation`, on the verbatim question
--     "CLEARANCE ELIGIBILITY - This position may require eligibility to obtain
--     and maintain a U.S. security clearance." and its follow up about which
--     level has ever been held. Anduril has 159 listings and SpaceX 244, and
--     both ask it. Storing an answer does not loosen the attestation ladder in
--     `lib/fill-application-form.ts`: it means the question is answered from
--     what the candidate stated rather than guessed at, and
--     `attestationFactAllowed` still refuses to let anything adjacent back it.
--
--   needs_sponsorship_non_us
--     Issue #108. `requires_sponsorship` is a US only fact derived from a US
--     citizenship status and says nothing about the United Kingdom or Ireland,
--     and it was being used to answer Virtu's UK sponsorship question "No" for
--     a candidate who would in fact need sponsorship there.
--
--   visa_status
--     Pylon Labs asks "What is your current visa status?" outright on Ashby and
--     it blocked. A visa status is a legal attestation, so prose is never
--     composed for one; the person's own words are the only answer available.
--
--   high_school_name, high_school_grad_year
--     All 128 of Palantir's Lever listings require a high school name and
--     Belvedere Trading requires the year. Neither is in a resume, and reading a
--     school off the page is what put "Stanford University" on a Georgia Tech
--     candidate's form (issue #100).
--
--   street_address, postal_code
--     Belvedere Trading requires both. `current_city` and `current_country`
--     already exist and are deliberately not duplicated here.
--
-- All eight belong to the person rather than to us, so all eight are granted to
-- `authenticated` by name in `0015_profiles_intake_fields_privileges.sql`,
-- following the rule `0003_profiles_column_privileges.sql` states: after that
-- migration `authenticated` holds no table wide UPDATE on `profiles`, so a new
-- column is not writable by a user session until a migration names it.
-- `stripe_customer_id` and `browserbase_context_id` are the counterexamples,
-- our records about a person rather than their answers, and stay ungranted.
--
-- Null on every existing row, meaning nobody has stated one yet. That is the
-- correct starting state: `toApplicationAnswers` in `lib/candidate-intake.ts`
-- drops a null rather than mapping it to a placeholder, so an unanswered
-- question still becomes a question put to the candidate.
--
-- Note for anyone regenerating from `lib/db/schema.ts`: `drizzle-kit generate`
-- also proposed re-adding `browserbase_context_id` here, because
-- `0013_profiles_browserbase_context_id.sql` was hand written and left no
-- snapshot behind, so the snapshot chain never learned about that column. It is
-- already in production and the line was removed rather than kept; running it
-- would fail on a column that already exists.
CREATE TYPE "public"."clearance_eligibility" AS ENUM('active_clearance', 'eligible', 'no');--> statement-breakpoint
CREATE TYPE "public"."clearance_level" AS ENUM('never_held', 'confidential', 'secret', 'top_secret');--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "clearance_eligibility" "clearance_eligibility";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "clearance_level_held" "clearance_level";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "needs_sponsorship_non_us" boolean;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "visa_status" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "high_school_name" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "high_school_grad_year" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "street_address" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_high_school_grad_year_range" CHECK ("profiles"."high_school_grad_year" is null or "profiles"."high_school_grad_year" between 1900 and 2100);
