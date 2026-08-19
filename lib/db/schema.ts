/**
 * Drizzle schema, intentionally empty at JOB-001.
 *
 * The scaffold needs a schema module for `drizzle.config.ts` to point at and
 * for `drizzle-kit push` to run against in CI, but the tables themselves are a
 * later ticket's call, not this one's. actinno's Supabase project has two
 * tables, `candidates` and `job_applications`, and the ported modules in `lib/`
 * read and write them through `@supabase/supabase-js` directly rather than
 * through Drizzle. Reconciling those two access paths, and deciding which
 * tables Jobinno actually wants, is the schema ticket's job.
 *
 * Until then this file exports nothing and `drizzle-kit push` is a no-op.
 */

export {};
