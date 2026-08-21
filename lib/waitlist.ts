/**
 * Waitlist submission (JOB-031), kept out of the form component so the
 * payload shape is testable without rendering anything. Mirrors the split
 * `lib/feedback.ts` already uses for the same reason.
 *
 * ── Why this is a direct client side insert rather than a server route ──────
 * RLS on `waitlist` allows an insert from both the anon and the authenticated
 * role with no ownership check at all, see `waitlist_insert_any` in
 * `lib/db/schema.ts`, so the browser client with the publishable anon key is
 * the right client and no server route is needed. Passing the client in as an
 * argument rather than reaching for a module level singleton keeps the insert
 * callable from a test with a stub that records what it was handed, exactly as
 * `submitFeedback` does.
 *
 * ── Why a duplicate email is not an error ────────────────────────────────────
 * `waitlist_email_key` is a real unique constraint, and Postgres reports a
 * violation of it as error code 23505. That is not surfaced as a failure here:
 * someone submitting the same email a second time is not asking to be added
 * twice, they are confirming they are already on the list, and the form shows
 * the same success state either way. `SubmitWaitlistResult.alreadyJoined` is
 * the only thing that tells the two cases apart, and only so the copy can say
 * "you are already on the list" instead of "you are on the list" when it is
 * true.
 *
 * ── Creator referral attribution (JOB-041) ──────────────────────────────────
 * `?ref=<code>` on the marketing site names the creator whose link brought a
 * visitor here. `middleware.ts` is what writes it into `WAITLIST_REFERRAL_COOKIE`
 * on every request that carries the param, because a Server Component cannot
 * set a cookie itself, and a visit today has to survive until a submission
 * tomorrow without losing attribution. `resolveWaitlistReferral` below is the
 * one place the precedence between a live query param and that cookie is
 * decided, so `app/page.tsx` and any test exercising this rule read it the
 * same way. The resolved value flows into `WaitlistInput.referredBy`, and
 * `buildWaitlistRow` copies it into `referred_by` unvalidated: there is no
 * `creators` table yet to check it against, and this ships without needing
 * one. JOB-043 reads the column back later to decide who gets credit.
 */

/** Roughly how many applications a signup submits in a typical week. */
export const WAITLIST_WEEKLY_VOLUME_OPTIONS = [
  { value: "under_5", label: "Under 5" },
  { value: "5_to_15", label: "5 to 15" },
  { value: "16_to_30", label: "16 to 30" },
  { value: "30_plus", label: "30 or more" },
] as const;

export type WaitlistWeeklyVolume =
  (typeof WAITLIST_WEEKLY_VOLUME_OPTIONS)[number]["value"];

/** One row of `waitlist`, in the column names Postgres knows it by. */
export interface WaitlistRow {
  email: string;
  name: string | null;
  biggest_frustration: string | null;
  weekly_application_volume: WaitlistWeeklyVolume | null;
  referred_by: string | null;
}

export interface WaitlistInput {
  email: string;
  name?: string;
  biggestFrustration?: string;
  /** Empty string is treated the same as undefined: the question was skipped. */
  weeklyApplicationVolume?: WaitlistWeeklyVolume | "";
  /**
   * The creator referral code this signup arrived with, already resolved by
   * `resolveWaitlistReferral`. Not a form field: nobody types this, it comes
   * from the URL or the cookie `middleware.ts` set from an earlier one. See
   * the file header for why it is unvalidated.
   */
  referredBy?: string | null;
}

/**
 * Turns what the form collected into the row Postgres expects. Every optional
 * field is trimmed here and folded to null when empty, rather than in the
 * form, so that whitespace or an empty string never reaches the table by way
 * of some other caller.
 */
export function buildWaitlistRow(input: WaitlistInput): WaitlistRow {
  const name = input.name?.trim() ?? "";
  const frustration = input.biggestFrustration?.trim() ?? "";
  // Trimmed like the other optional fields, but otherwise left exactly as
  // given: JOB-041 stores whatever string was in the link, not a normalized
  // or validated form of it.
  const referredBy = input.referredBy?.trim() ?? "";

  return {
    // Lowercased so that "Jane@example.com" and "jane@example.com" collide on
    // the unique constraint instead of quietly becoming two rows.
    email: input.email.trim().toLowerCase(),
    name: name.length > 0 ? name : null,
    biggest_frustration: frustration.length > 0 ? frustration : null,
    weekly_application_volume: input.weeklyApplicationVolume
      ? input.weeklyApplicationVolume
      : null,
    referred_by: referredBy.length > 0 ? referredBy : null,
  };
}

/**
 * Query param and cookie name for creator referral attribution (JOB-041).
 * `middleware.ts` writes the cookie, `app/page.tsx` reads both back through
 * `resolveWaitlistReferral`. One place for both names so the two files
 * cannot drift apart.
 */
export const WAITLIST_REFERRAL_QUERY_PARAM = "ref";
export const WAITLIST_REFERRAL_COOKIE = "jobinno_ref";

/**
 * ~30 days, in seconds, for the cookie's `Max-Age`. Long enough that someone
 * who browses today and joins next week still gets attributed correctly;
 * short enough that a link shared once does not go on crediting a creator
 * indefinitely for a browser that never comes back.
 */
export const WAITLIST_REFERRAL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * The query-param-then-cookie-then-null rule for `WaitlistInput.referredBy`.
 * The live query param wins when present, because a visitor who just followed
 * a link is the freshest signal available and should not be overridden by a
 * cookie an older link left behind; the cookie is the fallback for exactly
 * that older-visit case, since a person who browses today and submits the
 * form tomorrow no longer carries `?ref=` in the URL at all. Blank strings
 * from either source are treated as absent, not as a code.
 */
export function resolveWaitlistReferral(
  queryParam: string | null | undefined,
  cookieValue: string | null | undefined
): string | null {
  const fromQuery = queryParam?.trim();
  if (fromQuery) return fromQuery;

  const fromCookie = cookieValue?.trim();
  if (fromCookie) return fromCookie;

  return null;
}

/**
 * The narrow slice of a Supabase client this module uses. Structural, so a
 * test can pass a recorder and a real `SupabaseClient` still satisfies it.
 * `code` is optional because not every error a client can return is a
 * Postgres error, but every one this module cares about is.
 */
export interface WaitlistInsertClient {
  from(table: string): {
    insert(
      row: WaitlistRow
    ): PromiseLike<{ error: { message: string; code?: string } | null }>;
  };
}

export type SubmitWaitlistResult =
  | { ok: true; alreadyJoined: boolean }
  | { ok: false; message: string };

/** The table name, in one place, so the test and the form cannot drift apart. */
export const WAITLIST_TABLE = "waitlist";

/** Postgres' code for a unique constraint violation. Not specific to this table. */
const UNIQUE_VIOLATION = "23505";

const INVALID_EMAIL_MESSAGE = "Enter a valid email address.";

/**
 * Deliberately loose: something, an @, something, a dot, something. This is
 * not the real validation, Postgres and the confirmation link a real signup
 * would eventually get are, it exists only to catch an empty or obviously
 * malformed field before spending a network round trip on it.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Inserts one row. Never throws: the form turns the result into copy, and a
 * waitlist box that explodes while joining the waitlist is worse than useless.
 */
export async function submitWaitlist(
  client: WaitlistInsertClient,
  input: WaitlistInput
): Promise<SubmitWaitlistResult> {
  const row = buildWaitlistRow(input);

  if (row.email.length === 0 || !LOOKS_LIKE_EMAIL.test(row.email)) {
    return { ok: false, message: INVALID_EMAIL_MESSAGE };
  }

  try {
    const { error } = await client.from(WAITLIST_TABLE).insert(row);

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        return { ok: true, alreadyJoined: true };
      }
      return { ok: false, message: error.message };
    }

    return { ok: true, alreadyJoined: false };
  } catch (thrown) {
    return {
      ok: false,
      message: thrown instanceof Error ? thrown.message : "Unknown failure.",
    };
  }
}
