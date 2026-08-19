/**
 * One shared answer to the question "is this `SUPABASE_URL` the project this
 * deployment is allowed to touch?".
 *
 * ── Provenance (JOB-002) ────────────────────────────────────────────────────
 * Four ported modules carried a private copy of this check, each with actinno's
 * project ref (`oihpglvvzzmjigxrlmfz`) baked in as a literal, and each throwing
 * on any other project. Their own comments said the duplication was three
 * copies too many and that lifting it out was overdue. This module is that
 * lift, plus the one change that makes the ported code usable here at all: the
 * expected ref now comes from the environment rather than from source.
 *
 * The guard is NOT going away. Its whole purpose is to stop one project writing
 * rows into another's database, and the accident it prevents is cheap to cause
 * and expensive to discover: a stale `SUPABASE_URL` left in a shell, a copied
 * `.env.local`, a deploy pointed at the wrong environment. Every one of those
 * ends with real candidate rows in a database nobody is looking at. The service
 * role key bypasses row level security, so nothing downstream would object.
 *
 * ── How it decides ──────────────────────────────────────────────────────────
 * 1. A Supabase URL is `https://{ref}.supabase.co`, so the project ref is the
 *    first hostname label. That is the whole parse.
 * 2. `localhost` and `127.0.0.1` are always allowed. A local or self hosted
 *    Supabase has no project ref to compare against, and the point of the guard
 *    is telling two hosted projects apart, not blocking development. CI relies
 *    on this: it points `SUPABASE_URL` at `http://localhost:54321` and never
 *    talks to a hosted project.
 * 3. Otherwise `EXPECTED_SUPABASE_PROJECT_REF` has to be set and has to match.
 *
 * Unset is an error rather than a pass. "No expected ref configured" and "any
 * project is fine" are very different statements, and only one of them is safe
 * to assume in a process holding a service role key.
 */

/** Env var naming the one hosted Supabase project this checkout may touch. */
export const EXPECTED_PROJECT_REF_ENV_VAR = "EXPECTED_SUPABASE_PROJECT_REF";

/** Hostnames that mean "a Supabase running on this machine". */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/**
 * The project ref a Supabase URL names, or `null` for a local Supabase, which
 * has no ref. Throws if the string is not a URL at all.
 */
export function supabaseProjectRef(rawUrl: string): string | null {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    throw new Error(`SUPABASE_URL is not a valid URL: ${rawUrl}`);
  }

  if (LOCAL_HOSTNAMES.has(host)) return null;

  return host.split(".")[0];
}

/**
 * Throws unless `rawUrl` names the project this checkout is configured for.
 *
 * Call it once, immediately before creating a Supabase client, which is what
 * every caller in `lib/` does. Cheap enough to repeat and worth repeating: the
 * environment can change between one client and the next.
 */
export function assertSupabaseProject(rawUrl: string): void {
  const ref = supabaseProjectRef(rawUrl);
  if (ref === null) return;

  const expected = process.env[EXPECTED_PROJECT_REF_ENV_VAR]?.trim();
  if (!expected) {
    throw new Error(
      `Refusing to run: ${EXPECTED_PROJECT_REF_ENV_VAR} is not set, so there ` +
        `is nothing to check SUPABASE_URL against. It names the one hosted ` +
        `Supabase project this checkout may read or write. Set it in ` +
        `.env.local (see .env.example). SUPABASE_URL currently points at ` +
        `project "${ref}".`
    );
  }

  if (ref !== expected) {
    throw new Error(
      `Refusing to run: SUPABASE_URL points at Supabase project "${ref}", ` +
        `but ${EXPECTED_PROJECT_REF_ENV_VAR} expects "${expected}". Check ` +
        `.env.local. Do not reuse another project's credentials here.`
    );
  }
}
