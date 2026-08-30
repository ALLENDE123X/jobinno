/**
 * JOB-280 (sub ticket C of #276). The pure label to identity slot heuristics
 * shared between the legacy fill path and the agent path's deterministic
 * prefill pass.
 *
 * Why this module exists. `FIELD_KEYWORDS` used to live inside
 * `lib/fill-application-form.ts` alongside its DOM safety machinery, and the
 * two roles read the same regexes for opposite reasons: the DOM safety layer
 * uses the table as a conflict check when placing a value on a control the
 * model chose, and the new prefill pass in `lib/agent/prefill.ts` reads the
 * same table forward, turning a field label into the slot to fill from the
 * fact catalog. Both readings have to agree about what a label means, and
 * duplicating the regexes into a second table was the exact scenario the
 * "same corpus reaches two answers" test in `tests/unit/form-action-cache`
 * exists to prevent. Lifting the constant here keeps one source of truth.
 *
 * Semantics preserved. The regexes below are, character by character, the ones the
 * legacy path shipped with; the extraction is a hoist, not a rewrite. The
 * legacy behavior test named in `tests/unit/adaptive-form-fill.test.ts`
 * exercises `FIELD_KEYWORDS` transitively and still passes on this branch.
 */

/**
 * What each field's control must say about itself. Matched against
 * `ControlDescriptor.haystack` (DOM truth) and, only when the DOM has nothing
 * to say, against `observe()`'s description.
 *
 * They double as a *conflict* table: a control whose own labelling matches
 * a different field's pattern and not this one is refused outright, which is
 * what stops the classic failure of a correct looking observation landing
 * one box off. See `corroborate()` in `lib/fill-application-form.ts` for
 * the DOM safety reader; see `classifyPrefillSlot()` in
 * `lib/agent/prefill.ts` for the forward reader.
 */
export const FIELD_KEYWORDS = {
  firstName: /first[\s_-]*name|given[\s_-]*name|\bfname\b/i,
  lastName: /last[\s_-]*name|\bsurname\b|family[\s_-]*name|\blname\b/i,
  fullName: /(full|your|applicant)[\s_-]*name|^\s*name\b/i,
  email: /e-?mail/i,
  confirmEmail: /confirm[\s_-]*(?:your[\s_-]*)?e-?mail|re-?enter[\s_-]*e-?mail|repeat[\s_-]*e-?mail|verify[\s_-]*e-?mail/i,
  city: /\bcity\b|\bcurrent[\s_-]*(?:city|location)\b/i,
  phone: /phone|mobile|telephone|\btel\b/i,
  linkedin: /linked-?in/i,
  website: /website|portfolio|personal[\s_-]*(site|url|page)|\bgithub\b/i,
  coverLetter: /cover[\s_-]*letter/i,
  resume: /resum|\bcv\b|curriculum/i,
} as const;

export type FieldKey = keyof typeof FIELD_KEYWORDS;
