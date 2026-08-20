ALTER TABLE "profiles" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_stripe_customer_id_key" UNIQUE("stripe_customer_id");