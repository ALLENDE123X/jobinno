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
}

export interface WaitlistInput {
  email: string;
  name?: string;
  biggestFrustration?: string;
  /** Empty string is treated the same as undefined: the question was skipped. */
  weeklyApplicationVolume?: WaitlistWeeklyVolume | "";
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

  return {
    // Lowercased so that "Jane@example.com" and "jane@example.com" collide on
    // the unique constraint instead of quietly becoming two rows.
    email: input.email.trim().toLowerCase(),
    name: name.length > 0 ? name : null,
    biggest_frustration: frustration.length > 0 ? frustration : null,
    weekly_application_volume: input.weeklyApplicationVolume
      ? input.weeklyApplicationVolume
      : null,
  };
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
