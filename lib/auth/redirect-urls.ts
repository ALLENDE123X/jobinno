/**
 * The one place that says where a magic link is allowed to land.
 *
 * ── Why this is a module and not a string literal at the call site ──────────
 * `emailRedirectTo` on `signInWithOtp` reads like a parameter and behaves like
 * a lookup. Supabase compares the value against the project's redirect
 * allowlist, and when it does not match it does not reject the call: it quietly
 * substitutes the project's Site URL and carries on. Nothing throws, nothing
 * logs, and the sign in request comes back looking successful.
 *
 * What actually happened is that a real person now has a link in their inbox
 * pointing somewhere that cannot complete a session, and the first anyone hears
 * of it is a user saying the email does not work. A sibling project lost time
 * to exactly this, which is why it gets a module with a comment rather than a
 * template string tucked into a component.
 *
 * ── The two halves that have to agree ───────────────────────────────────────
 * 1. `AUTH_REDIRECT_ALLOWLIST` below, which is what the app asks for.
 * 2. `additional_redirect_urls` in `supabase/config.toml`, which is what the
 *    project permits, pushed with `npm run supabase:auth-config`.
 *
 * They are checked against each other by `tests/unit/auth-redirect-allowlist.test.ts`,
 * so adding an origin here without allowlisting it fails the suite rather than
 * a user's inbox. Adding one to either half means adding it to both.
 */

/** Where `app/auth/callback/route.ts` is mounted. */
export const AUTH_CALLBACK_PATH = "/auth/callback";

/** The deployed origin. Matches `site_url` in `supabase/config.toml`. */
export const PRODUCTION_ORIGIN = "https://jobinno.app";

/** `next dev` serves here, and only here, unless someone passes a port. */
export const LOCAL_DEV_ORIGIN = "http://localhost:3000";

/**
 * Every callback URL the app is allowed to ask Supabase to send someone to.
 * Sorted, because the test that compares this against `supabase/config.toml`
 * compares sets and a stable order makes a failure readable.
 */
export const AUTH_REDIRECT_ALLOWLIST = [
  `${LOCAL_DEV_ORIGIN}${AUTH_CALLBACK_PATH}`,
  `${PRODUCTION_ORIGIN}${AUTH_CALLBACK_PATH}`,
] as const;

/**
 * The callback URL for an origin, or a thrown error naming the fix.
 *
 * Throwing is the whole point. The alternative is handing Supabase an origin it
 * does not recognise and letting it silently redirect somewhere else, so the
 * developer who started the dev server on port 3001 finds out here, in a
 * message that says what to do, instead of finding out from a dead link.
 */
export function authCallbackUrlFor(origin: string): string {
  const candidate = `${origin.replace(/\/+$/, "")}${AUTH_CALLBACK_PATH}`;

  if (!(AUTH_REDIRECT_ALLOWLIST as readonly string[]).includes(candidate)) {
    throw new Error(
      `Refusing to send a magic link to ${candidate}: it is not in Jobinno's ` +
        `redirect allowlist. Supabase would not reject it either, it would ` +
        `silently redirect to the project Site URL instead and the emailed ` +
        `link would go nowhere useful. Allowed: ` +
        `${AUTH_REDIRECT_ALLOWLIST.join(", ")}. To add one, put it in ` +
        `AUTH_REDIRECT_ALLOWLIST and in additional_redirect_urls in ` +
        `supabase/config.toml, then run npm run supabase:auth-config.`
    );
  }

  return candidate;
}
