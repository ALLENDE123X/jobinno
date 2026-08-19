-- Makes CI's throwaway Postgres container look enough like Supabase for
-- `drizzle-kit push` to apply `lib/db/schema.ts` against it.
--
-- THIS IS NOT A MIGRATION. Nothing here ever runs against a real database, and
-- nothing here belongs in `drizzle/`. Every schema change in this repository
-- goes through `drizzle-kit generate` and `drizzle-kit migrate`, because a
-- hand applied statement is invisible to drizzle's own bookkeeping and the
-- next `generate` then produces a migration that fights the database.
--
-- Three things the schema needs that a bare `postgres:15` image does not have:
--
--   1. `auth.users`, which `profiles.id` has a foreign key to.
--   2. The `anon`, `authenticated` and `service_role` roles that every policy
--      grants to by name. `CREATE POLICY ... TO anon` fails outright when the
--      role is missing.
--   3. `auth.uid()`, which the policy expressions call. Postgres resolves the
--      function at CREATE POLICY time, not at query time.
--
-- The definitions are the thinnest possible stand ins. They exist so that the
-- DDL parses and applies, not so that anything can be signed in.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY,
    email varchar(255)
);

-- Always null, so no policy ever matches a row. CI has no session and no JWT.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql
    STABLE
AS $func$ SELECT NULL::uuid $func$;

DO $roles$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    END IF;
END
$roles$;
