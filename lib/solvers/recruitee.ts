/**
 * JOB-236 — the Recruitee dedicated solver.
 *
 * Phase 5 of the per board solver architecture. Its shape is deliberately the
 * same as `domFallbackSolver`, `leverSolver`, `greenhouseSolver` and
 * `workableSolver`: fill with `fillApplicationFormRetainingSession` (ACT-007),
 * then submit with `runSubmitPhase` (ACT-008, still defined in
 * `lib/submit-application.ts`), on the same live Browserbase session, in the
 * same order. See `dom-fallback.ts`'s header for why that call order exists,
 * and `lever.ts`, `greenhouse.ts` and `workable.ts`'s headers for three
 * worked examples of a dedicated solver built on top of it.
 *
 * ── The diagnosis (JOB-236) ─────────────────────────────────────────────────
 * Recruitee's entire inventory in this database is one board (TransPerfect,
 * board token "transperfect", currently `active: false`), one job (Junior
 * Frontend Engineer, `https://transperfect.recruitee.com/o/junior-frontend-engineer-4`)
 * and one `applications` row: `549305dd-2c66-411d-98ee-3c4bc8a3ce58`, created
 * 2026 08 25, sitting at `submission_unconfirmed`. Its one `skip_log` row
 * (`reason: submit_failed`) reads, verbatim:
 *
 *   "Send" was clicked, but the application form is still on screen at
 *   "https://transperfect.recruitee.com/o/junior-frontend-engineer-4/c/new"
 *   with no confirmation of any kind ... The page is showing errors: "This
 *   phone number is invalid. Please enter a valid phone number, including the
 *   country calling code."
 *
 * The captured screenshot and page HTML (still on disk under
 * `lib/.submission-screenshots/549305dd-...`) show exactly one control marked
 * invalid:
 *
 *   <input type="tel" aria-invalid="true" name="candidate.phone"
 *     class="... PhoneInputInput" value="+40 44446018">
 *
 * `PhoneInputInput` is the class name the `react-phone-number-input` library
 * renders, a single visible text box paired with a country selector. The
 * value the pipeline's own fill left behind carries no calling code of its
 * own: what got typed was the candidate's raw digit string, and the widget's
 * own default country (whatever it happened to be selected to) read the
 * leading digits of that string as if they were its own calling code, which
 * is how "+40 44446018" appears at all. This is exactly the mechanism issue
 * #140 already diagnosed from this same row, independently, off the same
 * evidence: the candidate's stored phone comes back from resume parsing as
 * plain local digits, and nothing in the fill path ever adds a calling code
 * before typing it into a widget that needs one to parse the number
 * correctly, on any Recruitee employer whose phone box requires it inline
 * rather than through a separate free standing country dropdown.
 *
 * ── What this file fixes (#140) ──────────────────────────────────────────────
 * Between the fill and the submit click, this solver reads the live phone
 * box's own value off the DOM. When that value is present and does not
 * already start with a plus sign, it rewrites the field to E.164 shape,
 * a leading "+", the candidate's dial code, then the digits, using the exact
 * same `typeInto` primitive (`lib/stagehand-session.ts`) the fill itself used
 * to type the wrong value there in the first place, so React's own state for
 * a controlled input is updated the same trusted way rather than by setting
 * `.value` directly through `page.evaluate`, which a `react-phone-number-input`
 * box would simply ignore or revert. The dial code comes from the candidate's
 * own stated `profiles.current_country` when one is on file, read directly by
 * this solver since `PreflightRow` carries no country field; it falls back to
 * United States (dial code 1) when the candidate gave none or named a country
 * this file's small lookup table does not carry, which is not a guess about
 * the candidate's own number so much as a practical default for a product
 * whose stated population today is entirely United States based (the one
 * candidate on record here included). Once the value carries its own plus
 * prefix, `react-phone-number-input` no longer needs to guess a calling code
 * out of the digits at all, regardless of which country its own selector
 * still shows, which is why this fix does not need to touch that selector.
 *
 * A patch attempt that fails for any reason, an unreadable field, a selector
 * that no longer resolves, anything, is caught and logged rather than allowed
 * to stop the run: the worst outcome of a failed patch is the same
 * `submission_unconfirmed` outcome this row already carries, not a worse one.
 *
 * ── What this file also adds: a post submit read ─────────────────────────────
 * The same append only pattern `leverSolver`, `greenhouseSolver` and
 * `workableSolver` use: after `runSubmitPhase` returns unconfirmed, this
 * solver reads the phone box again. If Recruitee's own validation still names
 * a missing calling code, a second, more specific `skip_log` row is written
 * alongside the generic one `runSubmitPhase` already wrote, naming whether
 * this solver's own patch had already run against that exact value. This
 * matters because three honest but different stories are possible after a
 * patch attempt: the patched value itself still failed Recruitee's own check
 * for a reason this solver cannot see, the patch was never attempted because
 * the field did not match the shape #140 diagnosed, or a rewrite was judged
 * necessary and itself failed to complete before the click. Saying which one
 * happened is the entire value this second row adds over the generic hedge —
 * see `RecruiteePhonePatchOutcome` for the three states this is built on.
 * `applications.status` is left exactly as `runSubmitPhase` wrote it, still
 * `submission_unconfirmed`, still terminal, still never retried.
 *
 * ── The one real circular import ─────────────────────────────────────────────
 * Same cycle `lever.ts`, `greenhouse.ts` and `workable.ts`'s headers document
 * in detail, for the same reason: `submit-application.ts` imports
 * `lookupSolver` from `solvers/index.ts`, `index.ts` imports `recruiteeSolver`
 * from this file, and this file imports the real (not type only)
 * `gateName`/`runSubmitPhase` back out of `submit-application.ts`.
 * `recruiteeSolver` is declared with `function`, not a `const` arrow binding,
 * for exactly the reason the other three already give: a `const` initializer
 * is not available until its own module finishes evaluating, and whichever of
 * the three modules a given entry point resolves first can otherwise reach
 * `index.ts`'s object literal before this file's own top level code has run,
 * throwing `ReferenceError: Cannot access 'recruiteeSolver' before
 * initialization`. A function declaration is hoisted and bound before any
 * module's top level code runs at all, immune to that ordering question.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type Page } from "@browserbasehq/stagehand";

import { recordSkipQuietly } from "@/lib/application-records";
import { APPLICATION_STATUS } from "@/lib/application-status";
import { type SkipReason } from "@/lib/db/schema";
import { fillApplicationFormRetainingSession } from "@/lib/fill-application-form";
import {
  closeBrowserSession,
  typeInto,
  type BrowserSession,
} from "@/lib/stagehand-session";
import { assertSupabaseProject } from "@/lib/supabase-project-guard";
import { gateName, runSubmitPhase } from "@/lib/submit-application";
import type { SolverContext, SolverInput, SolverResult } from "@/lib/solvers/types";

const LOG = "[job-236-recruitee]";

// Same shape as the private helper of the same name in
// `lib/submit-application.ts`, `lib/solvers/ashby-direct.ts`,
// `lib/solvers/dom-fallback.ts`, `lib/solvers/lever.ts`,
// `lib/solvers/greenhouse.ts` and `lib/solvers/workable.ts` — each module
// that needs a Supabase client keeps its own copy rather than reaching
// across files for a private function.
function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required (see .env.example)"
    );
  }
  assertSupabaseProject(url);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ───────────────────────────────────
// The phone box probe — a read, used both before the click (to decide
// whether the #140 patch applies) and after it (to read whether Recruitee's
// own validation still names the same complaint).
// ───────────────────────────────────

/**
 * What the DOM says about Recruitee's phone box, read as plain values rather
 * than as page text — a shape, not a sentence, so nothing here is a text
 * pattern to keep in sync with a validation message that could read
 * differently across employers or locales.
 */
export type RecruiteePhoneProbe = {
  /** Whether a phone input was found on the page at all. */
  present: boolean;
  /** That input's own current value, or null when no input was found. */
  value: string | null;
  /** The input's own `aria-invalid` attribute, read as a boolean. */
  invalid: boolean;
  /** The text of the element the input's `aria-describedby` points at, if any. */
  errorText: string | null;
};

// A string expression, not a function passed to `page.evaluate()` — the same
// reason `LEVER_HCAPTCHA_GATE_SCRIPT` in `lib/solvers/lever.ts` and
// `GREENHOUSE_REQUIRED_FIELD_GATE_SCRIPT` in `lib/solvers/greenhouse.ts` are
// ones: an arrow function this file's callbacks would otherwise be compiled
// through tsx first, which wraps it in an `__name(fn, "name")` call that does
// not exist in the page's own global scope and throws `ReferenceError` on the
// first evaluated line. See the comment on the Ashby reCAPTCHA patch in
// `lib/submit-application.ts` for the fuller account of why.
//
// `input.PhoneInputInput` is `react-phone-number-input`'s own class name,
// confirmed against the real captured markup for row
// `549305dd-2c66-411d-98ee-3c4bc8a3ce58` (see this module's header). The
// `input[type="tel"]` fallback is kept for whichever future Recruitee posting
// renders the same field without that exact class, so this probe still finds
// something to read rather than reporting `present: false` on a page that
// plainly has a phone box.
// `aria-describedby` is allowed to hold a space separated list of element
// ids, not just one — the ARIA spec's own shape for it. Reading it with a
// single `document.getElementById(describedBy)` call, which is what this
// probe did originally, returns null the moment Recruitee renders more than
// one id there, which makes `errorText` read null and the whole downstream
// gate silently stop firing. Split on plain spaces (not a regex — see this
// file's header for why a template literal like this one is not a safe place
// for a backslash escape).
//
// A first pass at fixing that split simply returned the first id's non empty
// text, but `aria-describedby` commonly lists a hint or help text id before
// the actual error message id, and a field can carry both at once (a always
// present placeholder hint plus a validation message that only exists once
// the field is invalid). Returning whichever text happens to come first
// silently reads the hint back as `errorText` on exactly the pages where the
// real error message was listed second, which defeats
// `recruiteePhoneValidationStillBlocked`'s own text match below without ever
// looking like a bug from this probe's own return value. This loop instead
// walks every id, remembers the first non empty text as a fallback, and
// prefers whichever text belongs to an element whose own id or class name
// names it as an error: `error` or `invalid` appearing in either, the two
// words Recruitee's own markup and most component libraries use for exactly
// this. Only when nothing in the list matches that heuristic does the
// fallback (the first non empty text found, this probe's original behavior)
// get used, so a Recruitee page that never adopts that naming convention
// still reads something rather than nothing.
const RECRUITEE_PHONE_PROBE_SCRIPT = `(() => {
  const input = document.querySelector('input.PhoneInputInput') || document.querySelector('input[type="tel"]');
  if (!input) return { present: false, value: null, invalid: false, errorText: null };
  const describedBy = input.getAttribute('aria-describedby') || '';
  const ids = describedBy.split(' ').filter(Boolean);
  let errorText = null;
  let fallbackText = null;
  for (const id of ids) {
    const el = document.getElementById(id);
    const text = el ? (el.textContent || '').trim() : '';
    if (text.length === 0) continue;
    if (fallbackText === null) fallbackText = text;
    const idLower = id.toLowerCase();
    const classLower = (el && el.className ? String(el.className) : '').toLowerCase();
    const looksLikeError = idLower.indexOf('error') !== -1 || classLower.indexOf('error') !== -1 || classLower.indexOf('invalid') !== -1;
    if (looksLikeError) {
      errorText = text;
      break;
    }
  }
  if (errorText === null) errorText = fallbackText;
  return {
    present: true,
    value: input.value,
    invalid: input.getAttribute('aria-invalid') === 'true',
    errorText,
  };
})()`;

function isRecruiteePhoneProbe(value: unknown): value is RecruiteePhoneProbe {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.present === "boolean" &&
    (typeof v.value === "string" || v.value === null) &&
    typeof v.invalid === "boolean" &&
    (typeof v.errorText === "string" || v.errorText === null)
  );
}

/**
 * Reads the phone box's shape off the live page. Never throws — a page that
 * has navigated away, closed, or simply carries no phone box reads as
 * `present: false`, not an error, the same "nothing to see here" outcome
 * `probeLeverHcaptchaGate` and `probeGreenhouseRequiredFieldGate` use for
 * their own boards.
 */
async function probeRecruiteePhoneField(page: Page): Promise<RecruiteePhoneProbe | null> {
  return page.evaluate(RECRUITEE_PHONE_PROBE_SCRIPT).then(
    (value) => (isRecruiteePhoneProbe(value) ? value : null),
    () => null
  );
}

/**
 * Whether the probe's own value is missing the leading plus sign that tells
 * `react-phone-number-input` the digits already carry a calling code — the
 * exact gap #140 diagnosed. Pure and exported so this is pinned by fixtures
 * rather than only by a live board, the same reason `leverHcaptchaGateBlocked`
 * and `greenhouseRequiredFieldsGateBlocked` are.
 *
 * An empty or unreadable value is left alone rather than treated as missing a
 * calling code: there is nothing this solver could sensibly rewrite it to,
 * and a truly empty required field is a different, already handled shape
 * (Recruitee's own required field validation, not this one).
 */
export function recruiteePhoneMissingCountryCode(probe: RecruiteePhoneProbe): boolean {
  if (!probe.present || probe.value === null) return false;
  const trimmed = probe.value.trim();
  if (trimmed.length === 0) return false;
  return !trimmed.startsWith("+");
}

/**
 * Whether the probe still shows Recruitee's own missing calling code
 * complaint after the submit click. Three signals have to agree, the same
 * "not either alone" discipline `leverHcaptchaGateBlocked` documents for its
 * own gate: the field has to be present, it has to be marked invalid, and the
 * text naming why has to actually name a calling code rather than some other
 * reason a phone box can read as invalid.
 */
export function recruiteePhoneValidationStillBlocked(probe: RecruiteePhoneProbe): boolean {
  return (
    probe.present &&
    probe.invalid &&
    probe.errorText !== null &&
    /country calling code/i.test(probe.errorText)
  );
}

// ───────────────────────────────────
// The fix — #140
// ───────────────────────────────────

/**
 * Calling codes for the countries `profiles.current_country` is most likely
 * to name, keyed lower case. Not exhaustive: a country this table does not
 * carry falls back to United States (dial code "1") in `dialCodeForCountry`
 * below, which is a practical default rather than a claim about any
 * particular candidate, documented at that function.
 */
const COUNTRY_DIAL_CODES: Readonly<Record<string, string>> = {
  "united states": "1",
  "united states of america": "1",
  usa: "1",
  us: "1",
  canada: "1",
  "united kingdom": "44",
  uk: "44",
  india: "91",
  china: "86",
  australia: "61",
  germany: "49",
  france: "33",
  mexico: "52",
  brazil: "55",
  nigeria: "234",
  pakistan: "92",
  bangladesh: "880",
  vietnam: "84",
  "south korea": "82",
  philippines: "63",
  singapore: "65",
  "hong kong": "852",
  ireland: "353",
  netherlands: "31",
  spain: "34",
  italy: "39",
  japan: "81",
};

/**
 * The dial code to prepend when a Recruitee phone box is missing one of its
 * own. Falls back to United States ("1") when `country` is null or names a
 * country this file's small table does not carry. That default is not a
 * fabricated fact about any one candidate (see HARD STOP 9 in this repo's own
 * `CLAUDE.md`, the exact rule this default is written to respect): it changes
 * nothing about what was typed into the box, only how the digits already
 * typed are punctuated, and the one candidate this solver has real data for
 * today stated their own country as United States. A future candidate whose
 * stated country is not in this table gets the same default rather than a run
 * that stops here; widening the table as real inventory shows a need for it
 * is a small, low risk follow up, not a design change.
 */
export function dialCodeForCountry(country: string | null): string {
  if (country === null) return "1";
  const key = country.trim().toLowerCase();
  return COUNTRY_DIAL_CODES[key] ?? "1";
}

/**
 * Formats a raw phone value read off a Recruitee phone box into E.164 shape.
 * A value that already starts with a plus sign is returned unchanged: it
 * already carries its own calling code, whatever it is, and this function
 * never second guesses one that is already there. An 11 digit value that
 * already begins with "1" and whose dial code is also "1" is treated as
 * already carrying the North American trunk digit rather than doubled up
 * with a second one. Everything else is the dial code followed by whatever
 * digits were present, since digits are the only part of the original value
 * this function keeps: separators, spaces and parentheses are Recruitee's
 * own formatting choice to make on read back, not something this fix needs
 * to reproduce.
 *
 * One more shape has to be handled before that final concatenation: most
 * countries outside the North American Numbering Plan write their own
 * national numbers with a leading trunk zero that is dropped the moment a
 * calling code is added in front of it. Six of the entries in
 * `COUNTRY_DIAL_CODES` above work this way (the United Kingdom, Germany,
 * France, Spain, the Netherlands and Ireland, among others this table does
 * not carry), and a resume parsed local number for any of them, for example
 * the United Kingdom's "07911123456", already starts with that zero.
 * Prepending "+44" straight onto it without stripping the zero first
 * produces "+4407911123456", a number with the wrong shape and the wrong
 * digit count for the country it names, silently, on the candidate's real
 * application. NANP numbers never lead with a zero (an area code cannot
 * start with one), so the strip only ever needs to be withheld from dial
 * code "1", not from a specific list this table would otherwise have to keep
 * in step with `COUNTRY_DIAL_CODES` by hand.
 *
 * Italy is the well known real world exception to that trunk zero rule: an
 * Italian landline number keeps its leading zero even once the "+39" calling
 * code is in front of it, because Italy's own numbering plan treats that
 * zero as part of the subscriber number rather than as a trunk prefix to
 * dial around. Stripping it the way this function does for the United
 * Kingdom or Germany would produce a number one digit short of a real
 * Italian one. `KEEPS_TRUNK_ZERO_COUNTRIES` below names the dial codes this
 * function knows keep that zero; today that is Italy alone, since it is the
 * one this file has a reported real world counter example for, not a claim
 * that no other country works the same way.
 *
 * A value can also arrive already written for international dialing rather
 * than for a national context: a leading "00" is the international dial out
 * prefix a resume parsed number sometimes carries in place of a "+", and the
 * digits after it are already a complete international number, own calling
 * code included. That shape is read first, before either the trunk zero
 * question or the dial code prepend below even come up, because treating
 * "00" as if it were an ordinary trunk zero and prepending this call's own
 * dial code on top of it would double up a calling code the value already
 * carries, for example turning the United Kingdom's "00447911123456" into
 * the wrong shaped "+440447911123456" instead of the correct "+447911123456".
 */
const KEEPS_TRUNK_ZERO_COUNTRIES: ReadonlySet<string> = new Set(["39"]);

export function formatRecruiteePhoneE164(rawValue: string, dialCode: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith("+")) return trimmed;
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return trimmed;
  if (digits.length > 2 && digits.startsWith("00")) {
    return `+${digits.slice(2)}`;
  }
  if (dialCode === "1" && digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (dialCode !== "1" && !KEEPS_TRUNK_ZERO_COUNTRIES.has(dialCode) && digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  return `+${dialCode}${digits}`;
}

/**
 * `profiles.current_country`, read directly by this solver rather than
 * threaded through `PreflightRow`, which carries no country field of its own
 * (see `submit-application.ts`'s own `PreflightRow` type). Two queries, one
 * to find the candidate behind this application and one to read their stated
 * country, kept as plain reads rather than a join because both tables already
 * have their own row level security policies and this solver already holds a
 * service role client that bypasses them intentionally, the same as every
 * other read in this file.
 *
 * Never throws. A missing application row, a missing profile row, or any
 * error from either query reads as null, the same "nothing to see here"
 * outcome `dialCodeForCountry` already turns into its own documented
 * default. A phone format fix is not worth failing a real submission over.
 */
async function loadCandidateCountry(
  supabase: SupabaseClient,
  jobApplicationId: string
): Promise<string | null> {
  try {
    const { data: application } = await supabase
      .from("applications")
      .select("user_id")
      .eq("id", jobApplicationId)
      .maybeSingle();
    if (!application?.user_id) return null;
    const { data: profile } = await supabase
      .from("profiles")
      .select("current_country")
      .eq("id", application.user_id)
      .maybeSingle();
    return profile?.current_country ?? null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${LOG} could not read the candidate's stored country for ${jobApplicationId} (${reason}); ` +
        `the phone fix will default its dial code to United States (+1)`
    );
    return null;
  }
}

// The exact instruction text `INSTRUCTIONS.PHONE` carries in
// `lib/fill-application-form.ts` (that object is module private there, not
// exported), reused here so `typeInto`'s in memory action plan lookup for
// this session, already populated by phase one's own call with this same
// instruction, replays the same selector rather than triggering a fresh
// model observe call. Kept as a named constant, with this comment, so a
// future rewording of `INSTRUCTIONS.PHONE` does not silently stop matching.
const RECRUITEE_PHONE_FIELD_INSTRUCTION = "the phone number input on the job application form";

/**
 * A candidate's phone number is personal data. It has no business sitting in
 * plain text in a process log or in a persisted `skip_log.raw_context.message`
 * row, both of which live for as long as this project's own retention policy
 * says, not the candidate's. What a human reading either of those needs is
 * the shape, not the digits: whether a calling code prefix was present, and
 * enough of the tail to recognize which application a log line is talking
 * about without the full number being readable off it. Returns something
 * like "+...6018" or, for a value this solver could not even read, the
 * literal string "unreadable". Used everywhere this file would otherwise
 * have written `probe.value` or `corrected` straight into a message.
 */
function redactPhoneForLog(value: string | null): string {
  if (value === null) return "unreadable";
  const trimmed = value.trim();
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  const lastFour = digits.length > 4 ? digits.slice(-4) : digits;
  return `${hadPlus ? "+" : ""}...${lastFour.length > 0 ? lastFour : "?"}`;
}

/**
 * What `patchRecruiteePhoneCountryCode` did, told apart into the three
 * outcomes a person reading a downstream skip row needs distinguished, not
 * folded into one boolean the way an earlier version of this file did:
 *
 * - `"skipped"`: the field either could not be read, already carried its own
 *   plus prefix, or formatted to the exact same value it already held. There
 *   was nothing here to rewrite, and nothing was.
 * - `"attempted"`: a rewrite ran and `typeInto` reported success. Whatever
 *   Recruitee's own validation does with that value afterward is a separate
 *   fact this type says nothing about.
 * - `"failed"`: a rewrite was judged necessary and `typeInto` itself threw,
 *   an unreadable field, a selector that no longer resolves, anything. The
 *   field was left exactly as the fill wrote it, and the caller still goes
 *   on to attempt the real submit either way — see this function's own
 *   docstring for why a failed patch is not treated as a reason to stop.
 *
 * Collapsing `"failed"` back into `"skipped"`, which is what this file did
 * before, states something false: `"skipped"` says nothing was attempted,
 * and on the failed path something plainly was. `describeRecruiteePhoneStillBlocked`
 * below writes a different, accurate sentence for each of the three.
 */
export type RecruiteePhonePatchOutcome =
  | { outcome: "skipped"; correctedValue: null }
  | { outcome: "attempted"; correctedValue: string }
  | { outcome: "failed"; correctedValue: null; failureReason: string };

/**
 * The #140 fix. Reads the live phone box; when its value is present and
 * missing a calling code, rewrites it to E.164 shape through `typeInto`, the
 * same primitive the fill itself used, so a `react-phone-number-input`
 * controlled input's own React state updates the trusted way rather than
 * through a direct DOM write that library would simply ignore or revert.
 *
 * Never throws: a probe that finds nothing to fix, a `typeInto` call that
 * fails because the field no longer resolves, anything, is caught and logged
 * rather than allowed to stop the run. The worst outcome of a failed patch
 * attempt is the same `submission_unconfirmed` result this row already
 * carried before this file existed, not a worse one, and the caller still
 * goes on to attempt the real submit either way. What changed is that a
 * failed attempt is no longer reported the same way as nothing needing
 * fixing — see `RecruiteePhonePatchOutcome` above.
 */
async function patchRecruiteePhoneCountryCode(
  session: BrowserSession,
  supabase: SupabaseClient,
  jobApplicationId: string
): Promise<RecruiteePhonePatchOutcome> {
  const probe = await probeRecruiteePhoneField(session.page);
  if (probe === null || probe.value === null || !recruiteePhoneMissingCountryCode(probe)) {
    return { outcome: "skipped", correctedValue: null };
  }

  const country = await loadCandidateCountry(supabase, jobApplicationId);
  const dialCode = dialCodeForCountry(country);
  const corrected = formatRecruiteePhoneE164(probe.value, dialCode);
  if (corrected === probe.value) {
    return { outcome: "skipped", correctedValue: null };
  }

  try {
    const url = await session.page.url();
    await typeInto(session, url, RECRUITEE_PHONE_FIELD_INSTRUCTION, corrected);
    console.warn(
      `${LOG} rewrote ${jobApplicationId}'s phone field to carry a calling code before ` +
        `submitting: was ${redactPhoneForLog(probe.value)}, now ${redactPhoneForLog(corrected)} ` +
        `(dial code +${dialCode}` +
        `${country ? ", from the candidate's stored country" : ", defaulted, no stored country on file"})`
    );
    return { outcome: "attempted", correctedValue: corrected };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `${LOG} found a phone value missing a calling code (${redactPhoneForLog(probe.value)}) for ` +
        `${jobApplicationId} but could not rewrite it (${reason}); leaving it as the fill wrote ` +
        `it and continuing to the submit attempt`
    );
    return { outcome: "failed", correctedValue: null, failureReason: reason };
  }
}

/**
 * The sentence a human reads in `skip_log.raw_context.message` when Recruitee
 * still names a missing calling code after the click. Writes a different,
 * accurate sentence for each of `RecruiteePhonePatchOutcome`'s three states,
 * since a person deciding what to do next needs three different facts told
 * apart, not folded into one: nothing here needed fixing, a rewrite ran and
 * Recruitee still rejected the result, or a rewrite was attempted and never
 * completed. Never embeds the candidate's own phone digits — see
 * `redactPhoneForLog`.
 */
export function describeRecruiteePhoneStillBlocked(
  probe: RecruiteePhoneProbe,
  patch: RecruiteePhonePatchOutcome,
  finalUrl: string
): string {
  const patchNote =
    patch.outcome === "attempted"
      ? `This solver had already rewritten the field to ${redactPhoneForLog(patch.correctedValue)} ` +
        `before the click, specifically to add a calling code, and Recruitee's own validation ` +
        `still names the same complaint against that value.`
      : patch.outcome === "failed"
        ? `This solver found a phone value missing a calling code and tried to rewrite the field ` +
          `before the click, but that rewrite itself failed (${patch.failureReason}), so the ` +
          `field was left exactly as the fill wrote it and the click still went ahead. This is ` +
          `not the same as nothing needing fixing: a rewrite was attempted and did not complete.`
        : `This solver found nothing to rewrite before the click: the field's value ` +
          `${probe.value === null ? "could not be read" : "did not match"} the missing calling ` +
          `code shape #140 diagnosed, so nothing was changed.`;
  return (
    `Recruitee's own client side validation is still calling this phone number invalid for ` +
    `missing its country calling code` +
    `${probe.errorText ? `: "${probe.errorText}"` : ""} at "${finalUrl}" after the click. ` +
    `${patchNote} See issue #140 for the mechanism this solver was built to absorb. A person ` +
    `should check the board directly before deciding whether and how to proceed. Nothing here ` +
    `is retried automatically.`
  );
}

const RECRUITEE_PHONE_REASON: SkipReason = "internal_error";

// A `function` declaration, not a `const` arrow binding assigned `: SolverFn`
// — see this module's own header for the full account of why.
export async function recruiteeSolver(
  input: SolverInput,
  row: SolverContext
): Promise<SolverResult> {
  const jobApplicationId = input.jobApplicationId.trim();
  const supabase = getSupabaseClient();

  // ── Phase 1: fill. Unchanged from `domFallbackSolver` — see that file's
  // header for why ACT-007 owns every guard and status write here.
  const { result: fill, session } = await fillApplicationFormRetainingSession({
    jobApplicationId,
    requiresCoverLetter: input.requiresCoverLetter,
    jobDescription: input.jobDescription ?? row.jobDescription,
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.additionalAnswers === undefined
      ? {}
      : { additionalAnswers: input.additionalAnswers }),
    ...(input.headless === undefined ? {} : { headless: input.headless }),
    ...(input.fillScreenshotDir === undefined
      ? {}
      : { screenshotDir: input.fillScreenshotDir }),
  });

  if (fill.blockedReason !== null || session === null) {
    if (session !== null) await closeBrowserSession(session);
    console.warn(`${LOG} the fill did not complete — nothing to submit. Not clicking anything.`);
    return {
      jobApplicationId,
      status: fill.status,
      submitted: false,
      submitAttempted: false,
      confirmationRef: null,
      confirmation: null,
      securityCode: null,
      approval: { approved: false, gate: gateName(input), detail: "never reached — the fill stopped first" },
      submitControlLabel: null,
      fill,
      finalUrl: fill.finalUrl,
      pageTitle: fill.pageTitle,
      screenshotPath: fill.screenshotPath,
      blockedReason:
        fill.blockedReason ??
        "the form fill returned no live browser session, so there was nothing to submit",
      unconfirmedReason: null,
      rowUpdated: false,
    };
  }

  // ── Phase 1.5: the #140 fix. The browser is live and on the filled form,
  // before anything has been clicked. A patch attempt never blocks the
  // submit attempt that follows it, win or lose — see
  // `patchRecruiteePhoneCountryCode`'s own docstring.
  const patch = await patchRecruiteePhoneCountryCode(session, supabase, jobApplicationId);

  // ── Phase 2: submit, then the Recruitee specific read. The browser stays
  // live until this function's own `finally` closes it, after the probe
  // below has had its one chance to run.
  try {
    const result = await runSubmitPhase(supabase, session, input, jobApplicationId, row, fill);

    // Only worth a look when `runSubmitPhase` could not confirm anything: a
    // genuine `submitted` result has nothing for this to add to, and a pre
    // click `blocked()` result never reached a state Recruitee's own
    // validation could have had any bearing on.
    if (!result.submitted && result.status === APPLICATION_STATUS.SUBMISSION_UNCONFIRMED) {
      const probe = await probeRecruiteePhoneField(session.page);
      if (probe !== null && recruiteePhoneValidationStillBlocked(probe)) {
        console.warn(
          `${LOG} Recruitee's own phone validation is still blocking ${jobApplicationId} — ` +
            `writing a supplementary internal_error skip_log row alongside the generic one ` +
            `runSubmitPhase already wrote.`
        );
        await recordSkipQuietly(
          supabase,
          {
            applicationId: jobApplicationId,
            jobId: row.jobId,
            ats: row.ats,
            reason: RECRUITEE_PHONE_REASON,
            message: describeRecruiteePhoneStillBlocked(probe, patch, result.finalUrl),
            browserbaseSessionId: session.browser.sessionId ?? null,
          },
          LOG
        );
        return {
          ...result,
          unconfirmedReason:
            result.unconfirmedReason === null
              ? describeRecruiteePhoneStillBlocked(probe, patch, result.finalUrl)
              : `${result.unconfirmedReason} Recruitee's phone validation also confirmed: ${describeRecruiteePhoneStillBlocked(probe, patch, result.finalUrl)}`,
        };
      }
    }

    return result;
  } finally {
    await closeBrowserSession(session);
  }
}
