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

/**
 * The same deployment reached through the `www` subdomain (JOB-023).
 *
 * Both hostnames are real and both serve the app. `www.jobinno.app` is a CNAME
 * to Vercel and answers `/login` with a 200, so a typed address, an old
 * bookmark or a link carrying the subdomain lands on a working sign in form.
 * The form then asks for a magic link from the one origin the allowlist did not
 * cover, and the person gets an error instead of an email.
 *
 * Allowlisting it is the fix rather than dropping it, because the domain
 * already resolves and real people are already arriving on it. Sending `www` to
 * the apex at the Vercel domain level is the tidier long term shape and is
 * worth doing, but that is a production domain change and sign in should not
 * wait on it.
 */
export const WWW_PRODUCTION_ORIGIN = "https://www.jobinno.app";

/** `next dev` serves here, and only here, unless someone passes a port. */
export const LOCAL_DEV_ORIGIN = "http://localhost:3000";

/**
 * Vercel preview deployments of this project on the nullcoders team (JOB-164).
 *
 * This is the Supabase style glob, spelled exactly as it appears in
 * `additional_redirect_urls` in `supabase/config.toml`: the unit test that
 * compares the two halves compares them as sets of strings, so the pattern has
 * to be byte for byte identical on both sides or the suite fails. It is a
 * pattern rather than an origin, which is why `authCallbackUrlFor` decides
 * concrete acceptance with the hostname pattern below instead of membership
 * here.
 *
 * Deliberately not `*.vercel.app`. That would admit every deployment anyone
 * has ever published anywhere on Vercel. This admits only previews whose
 * project name starts with `jobinno` under the nullcoders team scope.
 */
export const VERCEL_PREVIEW_ALLOWLIST_PATTERN =
  "https://jobinno-*-nullcoders-projects.vercel.app/**";

/**
 * The hostname half of the same decision, as a strict match against one
 * segment between the fixed prefix and the fixed team suffix. Anything else,
 * including other teams' projects that happen to start with `jobinno`, still
 * throws below.
 */
export const VERCEL_PREVIEW_HOSTNAME_PATTERN =
  /^jobinno-[a-z0-9]+-nullcoders-projects\.vercel\.app$/;

/**
 * Every callback URL the app is allowed to ask Supabase to send someone to.
 * Sorted, because the test that compares this against `supabase/config.toml`
 * compares sets and a stable order makes a failure readable.
 *
 * The final entry is the preview wildcard above, present so the set comparison
 * against `additional_redirect_urls` keeps holding and the error message below
 * names it. Concrete preview origins are accepted by `authCallbackUrlFor`
 * through `VERCEL_PREVIEW_HOSTNAME_PATTERN`.
 */
export const AUTH_REDIRECT_ALLOWLIST = [
  `${LOCAL_DEV_ORIGIN}${AUTH_CALLBACK_PATH}`,
  `${PRODUCTION_ORIGIN}${AUTH_CALLBACK_PATH}`,
  `${WWW_PRODUCTION_ORIGIN}${AUTH_CALLBACK_PATH}`,
  VERCEL_PREVIEW_ALLOWLIST_PATTERN,
] as const;

/**
 * The callback URL for an origin, or a thrown error naming the fix.
 *
 * Throwing is the whole point. The alternative is handing Supabase an origin it
 * does not recognise and letting it silently redirect somewhere else, so the
 * developer who started the dev server on port 3001 finds out here, in a
 * message that says what to do, instead of finding out from a dead link.
 *
 * ── The message below is for a developer and for nobody else (JOB-023) ───────
 * It names a constant, a config file and a shell command, which is the right
 * amount of detail for whoever has to fix the allowlist and the wrong amount
 * for a person who typed their email address into a sign in form. It was
 * rendered verbatim to real people on `www.jobinno.app` before JOB-023, because
 * the caller caught this error and put `error.message` straight on the page.
 *
 * Callers must therefore treat what this throws as a log line, never as copy.
 * `app/login/login-form.tsx` is the one caller and it does exactly that.
 */
export function authCallbackUrlFor(origin: string): string {
  const candidate = `${origin.replace(/\/+$/, "")}${AUTH_CALLBACK_PATH}`;

  let isVercelPreviewHostname = false;
  try {
    const { hostname } = new URL(candidate);
    isVercelPreviewHostname =
      VERCEL_PREVIEW_HOSTNAME_PATTERN.test(hostname);
  } catch {
    // An origin that is not an absolute URL cannot be a preview deployment.
    // It falls through to the exact membership check, which rejects it below.
  }

  if (
    !isVercelPreviewHostname &&
    !(AUTH_REDIRECT_ALLOWLIST as readonly string[]).includes(candidate)
  ) {
    throw new Error(
      `Refusing to send a magic link to ${candidate}: it is not in Jobinno's ` +
        `redirect allowlist. Supabase would not reject it either, it would ` +
        `silently redirect to the project Site URL instead and the emailed ` +
        `link would go nowhere useful. Allowed: ` +
        `${AUTH_REDIRECT_ALLOWLIST.join(", ")}. Preview deployments whose ` +
        `hostname matches jobinno-*-nullcoders-projects.vercel.app are also ` +
        `accepted. To add one, put it in AUTH_REDIRECT_ALLOWLIST and in ` +
        `additional_redirect_urls in supabase/config.toml, then run npm run ` +
        `supabase:auth-config.`
    );
  }

  return candidate;
}

// ───────────────────────────────────
// Where to go once the session exists
// ───────────────────────────────────

/**
 * The cookie carrying an intended destination across a magic link (JOB-010).
 *
 * ── Why a cookie and not a query parameter ──────────────────────────────────
 * `app/auth/callback/route.ts` already honours `?next=`, and the obvious move
 * is to put the destination on `emailRedirectTo` so it comes back on the link.
 * That is exactly the thing the top of this file warns about: Supabase compares
 * `emailRedirectTo` against the project allowlist and silently substitutes the
 * Site URL when it does not match, so appending a query string to an allowlisted
 * callback URL risks every sign in link going nowhere useful, and it fails
 * quietly rather than loudly.
 *
 * A cookie sidesteps the allowlist entirely. It is set before the person is
 * sent to sign in and read back by the callback, so the link itself stays
 * byte for byte what the allowlist already permits.
 *
 * `SameSite=Lax` is deliberate: clicking a link in an email client is a top
 * level navigation, which is precisely the case Lax still sends cookies for.
 */
export const POST_LOGIN_DESTINATION_COOKIE = "jobinno_after_login";

/** An hour, matching how long a magic link stays valid. */
export const POST_LOGIN_DESTINATION_MAX_AGE_SECONDS = 60 * 60;

/**
 * A destination that is safe to redirect to, or null.
 *
 * Same rule the callback route applies to `?next=`: our own paths only. A value
 * of `//evil.example` is read by browsers as an absolute URL, so two leading
 * slashes are refused along with anything carrying a scheme. Without this a
 * cookie an attacker can set becomes an open redirect wearing our domain.
 */
export function safeRelativeDestination(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // A backslash is normalised to a forward slash by some browsers, so `/\evil`
  // would leave here looking relative and arrive somewhere else entirely.
  if (value.includes("\\")) return null;
  return value;
}
