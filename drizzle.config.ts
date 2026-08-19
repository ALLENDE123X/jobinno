import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// `.env.local` holds the real credentials and is gitignored. `.env.example`
// documents the shape. Nothing in this repo should ever carry a live
// DATABASE_URL in tracked source.
config({ path: ".env.local" });

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Supabase Postgres. Empty string rather than a throw so that `drizzle-kit`
    // can be introspected in CI and in a fresh checkout with no secrets set;
    // any command that actually needs a connection fails loudly on its own.
    url: process.env.DATABASE_URL || "",
  },
  schemaFilter: ["public"],
  // Supabase provisions `anon`, `authenticated` and `service_role` itself, and
  // the RLS policies in the schema grant to them by name. Without this,
  // drizzle-kit treats a role it did not create as drift and tries to drop it.
  entities: { roles: { provider: "supabase" } },
});
