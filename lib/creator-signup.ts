/**
 * Creator signup submission (JOB-042), kept out of the form component so the
 * payload shape is testable without rendering anything. Mirrors the split
 * `lib/waitlist.ts` already uses for the same reason, which is itself the
 * pattern `lib/feedback.ts` set first.
 *
 * ── Why this is a direct client side insert rather than a server route ──────
 * RLS on `creators` allows an insert from both the anon and the authenticated
 * role with no ownership check at all, see `creators_insert_any` in
 * `lib/db/schema.ts`, so the browser client with the publishable anon key is
 * the right client and no server route is needed. Passing the client in as an
 * argument rather than reaching for a module level singleton keeps the insert
 * callable from a test with a stub that records what it was handed, exactly as
 * `submitWaitlist` and `submitFeedback` do.
 *
 * ── Why `CREATOR_PAYOUT_METHODS` is restated here rather than imported ──────
 * The canonical list lives in `lib/db/schema.ts`, guarded by
 * `creators_payout_method_check`. Importing that module here would drag
 * Drizzle's `pg-core` into the browser bundle for the sake of three string
 * literals, so the list is restated instead, exactly as `lib/feedback.ts`
 * restates `FEEDBACK_CATEGORIES`. The restatement is not left to trust:
 * `tests/unit/creator-signup.test.ts` asserts the two lists agree.
 *
 * ── Why a duplicate email or referral code is not a raw Postgres error ──────
 * `creators_email_key` and `creators_ref_code_key` are both real unique
 * constraints, and Postgres reports a violation of either as error code
 * 23505. Unlike a duplicate waitlist email, a duplicate signup here is not
 * folded into a success state: there is no select policy on `creators` at
 * all, see the schema comment, so this module has no way to look up the
 * referral link a duplicate email already has and hand it back. The honest
 * answer is a plain, human sentence naming which field collided, never the
 * raw constraint text Postgres reports.
 *
 * ── Why the referral link is built here instead of in the form ──────────────
 * The form only ever needs the finished string to show the creator, and
 * building it next to `PRODUCTION_ORIGIN` keeps the one fact "this is where
 * jobinno.app lives" from being repeated at a second call site.
 */

import { PRODUCTION_ORIGIN } from "@/lib/auth/redirect-urls";

/** How a creator's payout gets sent. Restated from `CREATOR_PAYOUT_METHODS`, see header. */
export const CREATOR_PAYOUT_METHOD_OPTIONS = [
  { value: "zelle", label: "Zelle" },
  { value: "venmo", label: "Venmo" },
  { value: "cashapp", label: "CashApp" },
] as const;

export type CreatorPayoutMethod =
  (typeof CREATOR_PAYOUT_METHOD_OPTIONS)[number]["value"];

/** One row of `creators`, in the column names Postgres knows it by. */
export interface CreatorRow {
  name: string;
  email: string;
  ref_code: string;
  instagram_handle: string | null;
  linkedin_handle: string | null;
  tiktok_handle: string | null;
  twitter_handle: string | null;
  other_social: string | null;
  /** Empty string is a real possibility pre validation: the select starts unset. */
  payout_method: CreatorPayoutMethod | "";
  payout_tag: string;
  phone_number: string;
}

export interface CreatorInput {
  name: string;
  email: string;
  refCode: string;
  instagramHandle?: string;
  linkedinHandle?: string;
  tiktokHandle?: string;
  twitterHandle?: string;
  otherSocial?: string;
  payoutMethod: CreatorPayoutMethod | "";
  payoutTag: string;
  phoneNumber: string;
}

/**
 * Trims a free text field and folds an empty result to null, so an empty or
 * whitespace only answer reads the same as one that was never filled in.
 */
function optional(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Turns what the form collected into the row Postgres expects. Every field is
 * trimmed here, and `email` and `refCode` are lowercased here, rather than in
 * the form, so that neither case nor whitespace ever reaches the table by way
 * of some other caller. This is a pure mapping and does not validate: that is
 * `submitCreatorSignup`'s job, so a caller can inspect the row a set of
 * answers would produce without also handling a network call.
 */
export function buildCreatorRow(input: CreatorInput): CreatorRow {
  return {
    name: input.name.trim(),
    // Lowercased so that "Jane@example.com" and "jane@example.com" collide on
    // the unique constraint instead of quietly becoming two rows.
    email: input.email.trim().toLowerCase(),
    // Lowercased for the same reason, and because the referral link itself is
    // lowercase: "jobinno.app/?ref=Courtney" and "jobinno.app/?ref=courtney"
    // have to be the same link.
    ref_code: input.refCode.trim().toLowerCase(),
    instagram_handle: optional(input.instagramHandle),
    linkedin_handle: optional(input.linkedinHandle),
    tiktok_handle: optional(input.tiktokHandle),
    twitter_handle: optional(input.twitterHandle),
    other_social: optional(input.otherSocial),
    payout_method: input.payoutMethod,
    payout_tag: input.payoutTag.trim(),
    phone_number: input.phoneNumber.trim(),
  };
}

/**
 * The narrow slice of a Supabase client this module uses. Structural, so a
 * test can pass a recorder and a real `SupabaseClient` still satisfies it.
 * `code` is optional because not every error a client can return is a
 * Postgres error, but every one this module cares about is.
 */
export interface CreatorSignupInsertClient {
  from(table: string): {
    insert(
      row: CreatorRow
    ): PromiseLike<{ error: { message: string; code?: string } | null }>;
  };
}

export type SubmitCreatorSignupResult =
  | { ok: true; refCode: string; referralLink: string }
  | { ok: false; message: string };

/** The table name, in one place, so the test and the form cannot drift apart. */
export const CREATORS_TABLE = "creators";

/** Postgres' code for a unique constraint violation. Not specific to this table. */
const UNIQUE_VIOLATION = "23505";

/**
 * The unique constraint names from `lib/db/schema.ts`. Postgres includes the
 * constraint name verbatim in a 23505 error's message, e.g. `duplicate key
 * value violates unique constraint "creators_email_key"`, which is what lets
 * this module tell a duplicate email apart from a duplicate referral code
 * without a select policy to look either row up.
 */
const EMAIL_UNIQUE_CONSTRAINT = "creators_email_key";
const REF_CODE_UNIQUE_CONSTRAINT = "creators_ref_code_key";

const NAME_REQUIRED_MESSAGE = "Enter your name.";
const INVALID_EMAIL_MESSAGE = "Enter a valid email address.";
const REF_CODE_MESSAGE =
  "Referral codes are 3 to 20 characters, lowercase letters, numbers, dashes and underscores only.";
const SOCIAL_REQUIRED_MESSAGE =
  "Add at least one of Instagram, LinkedIn, TikTok, Twitter or another social profile.";
const PAYOUT_METHOD_MESSAGE = "Choose a payout method.";
const PAYOUT_TAG_MESSAGE = "Enter your payout phone number or username.";
const PHONE_NUMBER_MESSAGE = "Enter a phone number.";
const DUPLICATE_EMAIL_MESSAGE =
  "That email is already registered for the creator program.";
const DUPLICATE_REF_CODE_MESSAGE =
  "That referral code is already taken. Try a different one.";
const GENERIC_DUPLICATE_MESSAGE =
  "That signup could not be completed. Please try again.";

/**
 * Deliberately loose, matching `lib/waitlist.ts`'s email check: something, an
 * @, something, a dot, something. It exists only to catch an empty or
 * obviously malformed field before spending a network round trip on it.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Matches `creators_ref_code_check`'s intent, enforced here before the insert. */
const REF_CODE_PATTERN = /^[a-z0-9_-]{3,20}$/;

const PAYOUT_METHOD_VALUES = CREATOR_PAYOUT_METHOD_OPTIONS.map(
  (option) => option.value
);

/**
 * Everything the form has to get right before this is worth a network call.
 * Returns the first problem found, or null when the row is ready to insert.
 */
function firstValidationError(row: CreatorRow): string | null {
  if (row.name.length === 0) return NAME_REQUIRED_MESSAGE;
  if (row.email.length === 0 || !LOOKS_LIKE_EMAIL.test(row.email)) {
    return INVALID_EMAIL_MESSAGE;
  }
  if (!REF_CODE_PATTERN.test(row.ref_code)) return REF_CODE_MESSAGE;
  if (
    row.instagram_handle === null &&
    row.linkedin_handle === null &&
    row.tiktok_handle === null &&
    row.twitter_handle === null &&
    row.other_social === null
  ) {
    return SOCIAL_REQUIRED_MESSAGE;
  }
  if (
    !PAYOUT_METHOD_VALUES.includes(row.payout_method as CreatorPayoutMethod)
  ) {
    return PAYOUT_METHOD_MESSAGE;
  }
  if (row.payout_tag.length === 0) return PAYOUT_TAG_MESSAGE;
  if (row.phone_number.length === 0) return PHONE_NUMBER_MESSAGE;
  return null;
}

/** The working link a creator shares, e.g. `jobinno.app/?ref=courtney`. */
export function buildReferralLink(refCode: string): string {
  return `${PRODUCTION_ORIGIN}/?ref=${refCode}`;
}

/**
 * Inserts one row. Never throws: the form turns the result into copy, and a
 * signup form that explodes while joining the affiliate program is worse
 * than useless.
 */
export async function submitCreatorSignup(
  client: CreatorSignupInsertClient,
  input: CreatorInput
): Promise<SubmitCreatorSignupResult> {
  const row = buildCreatorRow(input);

  const validationError = firstValidationError(row);
  if (validationError) {
    return { ok: false, message: validationError };
  }

  try {
    const { error } = await client.from(CREATORS_TABLE).insert(row);

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        if (error.message.includes(EMAIL_UNIQUE_CONSTRAINT)) {
          return { ok: false, message: DUPLICATE_EMAIL_MESSAGE };
        }
        if (error.message.includes(REF_CODE_UNIQUE_CONSTRAINT)) {
          return { ok: false, message: DUPLICATE_REF_CODE_MESSAGE };
        }
        return { ok: false, message: GENERIC_DUPLICATE_MESSAGE };
      }
      return { ok: false, message: error.message };
    }

    return {
      ok: true,
      refCode: row.ref_code,
      referralLink: buildReferralLink(row.ref_code),
    };
  } catch (thrown) {
    return {
      ok: false,
      message: thrown instanceof Error ? thrown.message : "Unknown failure.",
    };
  }
}
