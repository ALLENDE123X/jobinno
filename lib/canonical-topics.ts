/**
 * JOB-v1-B — a closed list of the intents an employer's form actually asks about.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * `lib/fill-application-form.ts` used to reach for a stored answer by fuzzy
 * substring on the truncated question text. That works while every employer
 * words the same question the same way, and it stops working the first time
 * one of them rewords it: on the 2026-08-25 SmartRecruiters run three of four
 * employers blocked on questions whose intent had already been answered
 * elsewhere in the profile. ServiceNow asked *"Are you legally authorized to
 * work in the country in which you are applying for a role?"* against a
 * profile whose `work_authorized_us` column had held the answer since intake.
 * SOCOTEC asked *"Do you now, or will you in the future, require immigration
 * sponsorship for work authorization?"* against `requires_sponsorship=false`.
 * Nothing on the fill path asked the database for either.
 *
 * The fix is not another regex over the sentence — the sentence changes every
 * time. It is to name the *intent* every employer is asking about, and to
 * write the lookup against that name rather than against the words the
 * employer chose. `resolveAnswer` in `lib/candidate-answers.ts` walks the
 * ladder in order: typed profile column keyed by the intent, then the
 * candidate's stored answer keyed by the same intent, then the intent's own
 * safe default, then escalate.
 *
 * ── What a canonical topic is, and what it deliberately is not ──────────────
 * A `CanonicalTopic` is one row of a hand-written taxonomy of the roughly
 * twenty questions that recur across US ATS submissions. The v1 scope is
 * regex-and-lookup only — no model call, no similarity score. The parent
 * design (issue #138) contemplates an LLM classifier once this stable list
 * has been in production for a while; that is v1.1 and is deliberately not
 * built here. Every rule below is either a keyword the intent's question
 * cannot plausibly avoid (`H-1B sponsorship` for `requires_visa_sponsorship`,
 * `GDPR` for `gdpr_data_processing_consent`) or a plain-language phrase that
 * has appeared verbatim on real forms this session (see
 * `tests/unit/canonical-topics.test.ts` for the corpus).
 *
 * Three properties this module preserves at every intent, so a reader is not
 * surprised by them later:
 *
 *  1. **A missed intent is safer than a mismatched one.** A question this
 *     table does not recognise becomes `intent: null`, which the fill loop
 *     routes to escalation. The only cost of a gap is one more question put
 *     to the candidate. A false positive, by contrast, could hand a stored
 *     sponsorship answer to a criminal-history question.
 *
 *  2. **Default answers exist only where a wrong answer cannot hurt.** GDPR
 *     boilerplate, terms-and-conditions acknowledgements, SMS opt-ins and
 *     "how did you hear about us" are true-or-safe irrespective of the
 *     candidate — declining GDPR consent merely prevents the application from
 *     submitting, which is the same outcome as escalating. Anything with a
 *     post-hire consequence (work auth, citizenship, felony, clearance) has
 *     `defaultAnswer: null` and `alwaysBlock: true`, and is escalated.
 *
 *  3. **`columnLookup` is a pure function of a profile snapshot.** It never
 *     reads Supabase; the fill layer has already loaded the columns it needs.
 *     That keeps this module a leaf, matches the same rule
 *     `lib/candidate-intake.ts` follows, and means the tests can hand it a
 *     plain object.
 *
 * ── How to add a new intent ─────────────────────────────────────────────────
 * Three things, in this order. Missing any of them makes the intent
 * unreachable at fill time, which is worse than not adding it at all.
 *
 *  a. Add a row to `CANONICAL_TOPICS` below. Slug in `snake_case`, at least
 *     two matcher patterns (a keyword and a plain-language phrase), a
 *     `columnLookup` if a profile column already holds the answer, a
 *     `defaultAnswer` only if a wrong answer is genuinely harmless, and
 *     `alwaysBlock: true` only for post-hire risk categories.
 *
 *  b. Add two real question strings for it to
 *     `tests/unit/canonical-topics.test.ts`. Pull one from
 *     `~/claude-memory/projects/startup/MEMORY.md` if it names one; otherwise
 *     from a real `.form-fill-screenshots/*.html` capture. Never make one up.
 *
 *  c. If the intent should narrow HARD STOP #9's "no fabrication" gate on the
 *     fill path — either by adding a new always-block category or by making a
 *     previously-blocking topic defaultable — mirror the change in
 *     `lib/fill-application-form.ts::blockedForAnswers`.
 *
 * ── The tension between "match first" and "match nothing" ───────────────────
 * Two intents whose matchers both fire on one question is evidence that the
 * question is compound rather than that two intents are one. Rather than
 * silently pick a winner, `classifyIntent` returns null in that case — the
 * safe outcome, and the outcome that produces an escalation which a person
 * can actually answer. The one exception is the case where an intent is a
 * strict specialization of another (e.g. `family_govt_employment_5y` names
 * "immediate family", which contains the word "family" that
 * `state_local_govt_employment_5y` never uses): the more specific intent
 * lives earlier in the list, and matches before the more general one gets
 * looked at. See the `classifyIntent` implementation for exactly how that
 * priority is applied without ever silently resolving a real ambiguity.
 */

/**
 * The subset of `profiles` columns any canonical topic's `columnLookup` may
 * read. Kept narrow on purpose: adding a column here means every reviewer of
 * this file can see the new dependency, and the fill layer that supplies it
 * (see `lib/candidate-answers.ts::resolveAnswer`) has one obvious place to
 * add the plumbing.
 *
 * `null` and `undefined` both read as "unknown". A `columnLookup` that would
 * have to answer from a still-null column returns `null`, which the ladder in
 * `resolveAnswer` treats as "this column did not answer, try the next step".
 */
export type CanonicalTopicProfileColumns = {
  workAuthorizedUs?: boolean | null;
  requiresSponsorship?: boolean | null;
  citizenshipStatus?: string | null;
  willingToRelocate?: boolean | null;
};

/**
 * One row of the intent taxonomy: what the form is really asking, how to
 * recognise it, where the answer lives, and whether the run must stop if the
 * answer is unknown.
 */
export type CanonicalTopic = {
  /**
   * Stable snake_case identifier the fill loop, `stored_answers` entries and
   * v1-C's escalation flow all key on. Never renamed — a rename here silently
   * orphans every existing stored answer.
   */
  slug: string;

  /**
   * The recurring intent, in one sentence a reviewer can check the matchers
   * against. Not shown to the user.
   */
  description: string;

  /**
   * Patterns applied to the lowercased question text. ANY match wins, so an
   * intent's matcher list is the union of the wordings the intent has been
   * observed under. Order within a single intent's list is not significant.
   */
  matchers: RegExp[];

  /**
   * When a typed profile column already holds this answer, the function that
   * turns the loaded columns into the string a form's question would accept.
   * Returns `null` when the column is unset — the ladder in `resolveAnswer`
   * treats that as "column did not answer", not as "the answer is no".
   */
  columnLookup?: (profile: CanonicalTopicProfileColumns) => string | null;

  /**
   * The safe answer this intent may fall back to when neither a column nor a
   * stored answer covers it. Present only for intents whose wrong answer has
   * no post-hire consequence (see property 2 above). `null` on every intent
   * that could hurt the candidate if wrong, which routes it to escalation.
   */
  defaultAnswer?: string | null;

  /**
   * True when the run must stop rather than fabricate an answer. Narrowing
   * HARD STOP #9 was one of the reasons this file exists: today's rule blocks
   * on the LEGAL_ATTESTATION_RE union, which fires on GDPR consent (harmless
   * to default) as much as on a felony question (never defaultable). This
   * flag is the load-bearing signal — the fill loop's `blockedForAnswers`
   * consults it to decide whether a classified intent belongs in the
   * `needs_attestation` bucket or the softer `needs_candidate_input` one.
   */
  alwaysBlock: boolean;
};

/**
 * ── The canonical taxonomy ─────────────────────────────────────────────────
 *
 * Ordered from most-specific to least-specific. `classifyIntent` walks this
 * list once and reports either a single match or null; when two intents both
 * fire on one question (the compound-label case) it reports null. Only the
 * genuine specialization pairs below rely on order:
 *
 *  · `family_govt_employment_5y` before both `federal_govt_employment_5y` and
 *    `state_local_govt_employment_5y`, because "spouse ... federal" is
 *    family-first and the two general govt-employment intents should not fire
 *    on it. The matchers still reject overlap (family requires a family
 *    noun), so the ordering is belt-and-braces and every classification is
 *    also verified in the test corpus.
 *
 *  · `us_citizen_or_pr` before `citizen_sanctioned_country`, because the
 *    sanctioned-country wording ("Are you a citizen of Cuba, Syria...") names
 *    "citizen" too and would otherwise ambiguously match both.
 *
 *  · `requires_visa_sponsorship` before `work_auth_current_us`, because
 *    "require ... work authorization" mentions "authorization to work" and
 *    the sponsorship intent is the more specific reading.
 */
export const CANONICAL_TOPICS: readonly CanonicalTopic[] = [
  // ── Legal attestations — never defaulted, always blocked ────────────────
  {
    slug: "requires_visa_sponsorship",
    description:
      "Whether the candidate now needs, or will in future need, employer-provided " +
      "visa sponsorship to work.",
    matchers: [
      /\brequire\b[^?!\n]{0,40}\bsponsorship\b/i,
      /\bneed\b[^?!\n]{0,40}\bsponsorship\b/i,
      /\brequire\b[^?!\n]{0,40}\bvisa\b/i,
      /\brequire\b[^?!\n]{0,40}\bimmigration\s+sponsorship\b/i,
      /\bh[-\s]?1[-\s]?b\s+sponsorship\b/i,
      /\bsponsorship\b[^?!\n]{0,40}\bemploy(?:ment|er)?\b/i,
      /\bsponsorship\b[^?!\n]{0,40}\bwork\s+(?:authoriz|permit|eligib)/i,
    ],
    columnLookup: (profile) =>
      typeof profile.requiresSponsorship === "boolean"
        ? profile.requiresSponsorship
          ? "Yes"
          : "No"
        : null,
    defaultAnswer: null,
    alwaysBlock: true,
  },
  {
    slug: "work_auth_current_us",
    description:
      "Whether the candidate is currently legally authorized to work in the United " +
      "States (without needing employer sponsorship, on today's date).",
    matchers: [
      /\bauthoriz\w*\s+to\s+work\b/i,
      /\blegally\s+authoriz\w*\b/i,
      /\bwork\s+eligibility\b/i,
      /\bauthorization\s+to\s+work\b/i,
      /\bright\s+to\s+work\b/i,
      /\bare\s+you\s+(?:now\s+)?authorized\b/i,
    ],
    columnLookup: (profile) =>
      typeof profile.workAuthorizedUs === "boolean"
        ? profile.workAuthorizedUs
          ? "Yes"
          : "No"
        : null,
    defaultAnswer: null,
    alwaysBlock: true,
  },
  {
    slug: "us_citizen_or_pr",
    description:
      "Whether the candidate is a US citizen or a lawful permanent resident (green " +
      "card holder).",
    matchers: [
      /\bu\.?\s?s\.?\s+citizen\b/i,
      /\bunited\s+states\s+citizen\b/i,
      /\bpermanent\s+resident\b/i,
      /\bcitizen\s+or\s+lawful\s+permanent\b/i,
      /\bgreen\s+card\b/i,
    ],
    columnLookup: (profile) => {
      const status = profile.citizenshipStatus;
      if (typeof status !== "string" || status.trim() === "") return null;
      return status === "us_citizen" || status === "permanent_resident" ? "Yes" : "No";
    },
    defaultAnswer: null,
    alwaysBlock: true,
  },
  {
    slug: "citizen_sanctioned_country",
    description:
      "Whether the candidate is a citizen of, or ordinarily resident in, an OFAC-sanctioned " +
      "country. Asked by defence and export-controlled employers.",
    matchers: [
      /\b(?:cuba|syria|iran|north\s+korea)\b/i,
      /\b(?:crimea|donetsk|luhansk)\b/i,
      /\bsanctioned\s+country\b/i,
      /\bofac[-\s]?sanctioned\b/i,
    ],
    // No column: intake does not ask this. But the safe default is "No"
    // because a candidate who IS a citizen of a sanctioned country must
    // affirmatively disclose it — the fill loop escalates via alwaysBlock so
    // the answer is not fabricated even though the safe default is well-known.
    defaultAnswer: null,
    alwaysBlock: true,
  },
  {
    slug: "federal_govt_employment_5y",
    description:
      "Whether the candidate has been an employee of the US Federal Government in the " +
      "last five years. Post-employment restrictions apply.",
    matchers: [
      /\bemployee\s+of\s+the\s+u\.?\s?s\.?\s+federal\s+government\b/i,
      /\bemployee\s+of\s+the\s+united\s+states\s+federal\s+government\b/i,
      /\bfederal\s+government\s+employ\w*\b/i,
      /\bfederal\s+employee\b/i,
      /\b(?:current|former)\s+federal\s+employ\w*\b/i,
    ],
    defaultAnswer: null,
    alwaysBlock: true,
  },
  {
    slug: "state_local_govt_employment_5y",
    description:
      "Whether the candidate has been an employee of a state, local or municipal " +
      "government (or a quasi-governmental entity) in the last five years.",
    matchers: [
      /\bstate,?\s+local,?\s+or\s+municipal\b/i,
      /\bstate\s+or\s+local\s+government\b/i,
      /\bgovernment\s+or\s+quasi[-\s]?governmental\s+entity\b/i,
      /\bmunicipal\s+government\s+employ\w*\b/i,
    ],
    defaultAnswer: null,
    alwaysBlock: true,
  },
  {
    slug: "family_govt_employment_5y",
    description:
      "Whether a member of the candidate's immediate family (spouse, parent, sibling, " +
      "child) has been employed by any government in the last five years.",
    matchers: [
      /\bimmediate\s+family\b[^?!\n]{0,80}\b(?:federal|state|local|municipal|government)\b/i,
      /\b(?:spouse|parent|sibling|child|relatives?)\b[^?!\n]{0,80}\b(?:federal|state|local|municipal)\s*[,]?\s*(?:or\s+)?(?:federal|state|local|municipal|government)\b/i,
      /\b(?:spouse|parent|sibling|child|relatives?)\b[^?!\n]{0,80}\bgovernment\b/i,
      /\bfamily\s+members?\b[^?!\n]{0,80}\b(?:federal|state|local|municipal|government)\b/i,
    ],
    defaultAnswer: null,
    alwaysBlock: true,
  },
  {
    slug: "security_clearance_holder",
    description:
      "Whether the candidate currently holds, or has ever held, an active US security " +
      "clearance (Secret, Top Secret, TS/SCI, with or without polygraph).",
    matchers: [
      /\bsecurity\s+clearance\b/i,
      /\bactive\s+clearance\b/i,
      /\b(?:secret|top\s+secret)\s+clearance\b/i,
      /\bts\s*\/\s*sci\b/i,
      /\bpolygraph\b/i,
    ],
    defaultAnswer: null,
    alwaysBlock: true,
  },
  {
    slug: "criminal_conviction_history",
    description:
      "Whether the candidate has any criminal conviction on record.",
    matchers: [
      /\bever\s+been\s+convicted\b/i,
      /\bfelony\s+conviction\b/i,
      /\bcriminal\s+record\b/i,
      /\bcriminal\s+history\b/i,
      /\bcriminal\s+conviction\w*\b/i,
      /\bever\s+been\s+(?:charged|arrested)\b/i,
      /\bconvicted\s+of\s+a\s+(?:felony|misdemean\w+|crime)\b/i,
    ],
    defaultAnswer: null,
    alwaysBlock: true,
  },

  // ── Preferences and boilerplate — escalate to user, sometimes with a
  // safe default, never with a post-hire consequence if wrong ─────────────
  {
    slug: "age_over_18",
    description:
      "Whether the candidate is at least 18 years old — a legal working-age check.",
    matchers: [
      /\bat\s+least\s+18\b/i,
      /\bover\s+18\s+years\b/i,
      /\b18\s+or\s+older\b/i,
      /\b18\s+years\s+of\s+age\s+or\s+older\b/i,
    ],
    // Safe default: this pipeline only serves adults (intake schema enforces
    // it). If a form asks anyway, "Yes" is a true statement about every
    // candidate whose profile has reached the fill layer.
    defaultAnswer: "Yes",
    alwaysBlock: false,
  },
  {
    slug: "willing_to_relocate",
    description:
      "Whether the candidate is willing to relocate for this role.",
    matchers: [
      /\bwilling\s+to\s+relocate\b/i,
      /\bopen\s+to\s+relocation\b/i,
      /\brelocation\s+willingness\b/i,
    ],
    columnLookup: (profile) =>
      typeof profile.willingToRelocate === "boolean"
        ? profile.willingToRelocate
          ? "Yes"
          : "No"
        : null,
    defaultAnswer: null,
    alwaysBlock: false,
  },
  {
    slug: "gdpr_data_processing_consent",
    description:
      "Consent for the employer to process the candidate's personal data under GDPR " +
      "or a similar data-protection regime. Boilerplate on European employers.",
    matchers: [
      /\bprocessing\s+of\s+your\s+personal\s+data\b/i,
      /\bdata\s+controller\b/i,
      /\bdata\s+processor\b/i,
      /\bgdpr\b/i,
      /\bpersonal\s+data\s+described\s+in\s+this\s+notice\b/i,
      /\bprivacy\s+notice\b[^?!\n]{0,40}\bconsent\b/i,
    ],
    // Safe default: without this consent the application cannot be submitted,
    // and the "harm" of a wrong answer is that the employer processes the
    // same data they need to process to consider the application at all. See
    // the narrowing rationale in `blockedForAnswers`.
    defaultAnswer: "Yes",
    alwaysBlock: false,
  },
  {
    slug: "video_interview_recording_consent",
    description:
      "Consent to have a subsequent video interview recorded. A real preference — " +
      "some candidates decline recorded interviews as a matter of policy.",
    matchers: [
      /\bvideo\s+interview\w*\s+being\s+recorded\b/i,
      /\brecord\w*\s+(?:the\s+)?interview\b/i,
      /\binterview\s+recording\b/i,
      /\brecorded\s+video\s+interview\b/i,
    ],
    // No safe default: it is a real preference. Escalate to the candidate.
    defaultAnswer: null,
    alwaysBlock: false,
  },
  {
    slug: "terms_and_conditions_consent",
    description:
      "Acknowledgement of the employer's or ATS's terms and conditions. Boilerplate.",
    matchers: [
      /\bagree\s+to\s+the\s+terms\b/i,
      /\bterms\s+and\s+conditions\b/i,
      /\backnowledge\b[^?!\n]{0,30}\bterms\b/i,
      /\baccept\s+the\s+terms\b/i,
    ],
    defaultAnswer: "Yes",
    alwaysBlock: false,
  },
  {
    slug: "sms_communications_consent",
    description:
      "Opt-in to receive SMS/text messages from the employer or ATS.",
    matchers: [
      /\breceive\s+sms\b/i,
      /\btext\s+message\w*\b[^?!\n]{0,30}\bconsent\b/i,
      /\bagree\s+to\s+receive\s+(?:text|sms)\b/i,
      /\bconsent\s+to\s+receive\s+(?:text|sms|these\s+text)\b/i,
      /\bsms\s+communications?\b/i,
    ],
    defaultAnswer: "Yes",
    alwaysBlock: false,
  },
  {
    slug: "previous_employment_at_this_employer",
    description:
      "Whether the candidate has previously worked at this specific employer.",
    // Every matcher is scoped to the "this employer" side of the question.
    // A generic "former employee" match would fire on the family-govt
    // question ("Immediate Family a current or former employee of the
    // federal government"), which is a different intent entirely.
    matchers: [
      /\bpreviously\s+(?:employed|worked)\b[^?!\n]{0,40}\b(?:by|for|at|with)\s+(?:this|our|us)\b/i,
      /\bworked\b[^?!\n]{0,20}\b(?:at|for|with)\s+(?:this|our|us)\b[^?!\n]{0,40}\bbefore\b/i,
      /\bformer\s+employee\s+of\s+(?:this|our|us)\b/i,
      /\bever\s+been\s+(?:employed|worked)\b[^?!\n]{0,20}\b(?:by|at|for|with)\s+(?:this|our|us)\b/i,
      /\bare\s+you\s+a\s+former\s+employee\b/i,
    ],
    defaultAnswer: null,
    alwaysBlock: false,
  },
  {
    slug: "relatives_at_this_employer",
    description:
      "Whether the candidate has any relatives (spouse, parent, sibling, child) " +
      "employed by this employer.",
    // Same scoping rule as `previous_employment_at_this_employer`. A
    // free-standing "family members employed" fires on the family-govt
    // question, so every matcher here requires the "this employer" side.
    matchers: [
      /\brelatives?\s+(?:working|employed)\s+(?:at|by)\s+(?:this|our|us)\b/i,
      /\bfamily\s+members?\s+(?:working|employed)\s+(?:at|by)\s+(?:this|our|us)\b/i,
      /\brelated\s+to\s+(?:an\s+employee|anyone\s+(?:working|employed))\b/i,
      /\brelatives?\b[^?!\n]{0,40}\b(?:this\s+(?:compan\w+|organi[sz]ation|firm)|our\s+(?:compan\w+|organi[sz]ation|firm))\b/i,
    ],
    defaultAnswer: null,
    alwaysBlock: false,
  },
  {
    slug: "salary_expectation",
    description:
      "The candidate's salary expectation, target compensation or desired pay range.",
    matchers: [
      /\bsalary\s+expectations?\b/i,
      /\bcompensation\s+range\b/i,
      /\bdesired\s+salary\b/i,
      /\btarget\s+compensation\b/i,
      /\bexpected\s+(?:salary|compensation|pay)\b/i,
      /\bsalary\s+requirements?\b/i,
    ],
    // HARD STOP 9 forbids inventing a salary number for a real person. No
    // column on `profiles` today holds this on the main branch, so every
    // instance escalates — the ticket flags this as an intent whose column
    // lookup would be added later, and the safe outcome until then is exactly
    // what happens for any intent without a column and without a default.
    defaultAnswer: null,
    alwaysBlock: false,
  },
  {
    slug: "notice_period",
    description:
      "How much notice the candidate must give their current employer before starting.",
    matchers: [
      /\bnotice\s+period\b/i,
      /\bhow\s+much\s+notice\b/i,
      /\bwhen\s+could\s+you\s+start\b/i,
      /\bwhen\s+can\s+you\s+start\b/i,
      /\bearliest\s+start\s+date\b/i,
    ],
    // No column on main today (JOB-101's `earliest_start` is a date, not a
    // notice-days integer; converting one to the other is guesswork). Escalate.
    defaultAnswer: null,
    alwaysBlock: false,
  },
  {
    slug: "heard_about_us_source",
    description:
      "Where the candidate first heard about the employer or the role. Purely a " +
      "sourcing-analytics field; every option is a true statement about somebody.",
    matchers: [
      /\bhow\s+did\s+you\s+hear\b/i,
      /\bwhere\s+did\s+you\s+(?:learn|hear)\b/i,
      /\breferral\s+source\b/i,
      /\bhow\s+did\s+you\s+find\s+(?:us|this\s+(?:role|position|opening|job))\b/i,
    ],
    // Safe default: LinkedIn is where the job matcher (`lib/job-matching.ts`)
    // most often sources listings from, so it is the closest thing to true
    // for a candidate whose profile does not name a referrer. Wrong answers
    // here have no post-hire consequence — the field is analytics, not an
    // attestation. See the narrowing rationale in `blockedForAnswers`.
    defaultAnswer: "LinkedIn",
    alwaysBlock: false,
  },
];

/**
 * Sanity-check the taxonomy at import time.
 *
 * A duplicate slug would silently orphan every stored answer keyed under the
 * losing definition; an empty matcher list would be an unreachable intent. A
 * throw here is louder than a test failure and cheaper than the confusion
 * either bug would produce.
 */
(function assertTaxonomyIsWellFormed(): void {
  const slugs = new Set<string>();
  for (const topic of CANONICAL_TOPICS) {
    if (!/^[a-z][a-z0-9_]*$/.test(topic.slug)) {
      throw new Error(
        `canonical-topics: slug "${topic.slug}" must be snake_case ` +
          `(a-z, 0-9, underscore; starting with a letter)`
      );
    }
    if (slugs.has(topic.slug)) {
      throw new Error(`canonical-topics: duplicate slug "${topic.slug}"`);
    }
    slugs.add(topic.slug);
    if (topic.matchers.length === 0) {
      throw new Error(
        `canonical-topics: "${topic.slug}" has no matchers and is unreachable`
      );
    }
  }
})();

/**
 * The canonical intent this question is about, or `null` when this table does
 * not plainly recognise it or when more than one intent matches.
 *
 * The rules are the ones the header on this file names and no others:
 *
 *  · A question is classified into an intent when at least one of that
 *    intent's `matchers` fires on the lowercased question text.
 *
 *  · If two or more intents both fire, the question is compound (it names
 *    two topics at once) and no intent is returned. The fill loop then
 *    escalates rather than picking a winner — see the "compound-label" note
 *    in the header. The one exception is a genuine specialization pair
 *    (`family_govt_employment_5y` beats the two general govt-employment
 *    intents, `us_citizen_or_pr` beats `citizen_sanctioned_country`,
 *    `requires_visa_sponsorship` beats `work_auth_current_us`): when the
 *    matches are exactly {specific, general} for a known pair, the specific
 *    wins. Any other multi-match returns `null`.
 *
 *  · An empty or whitespace-only question returns `null` unconditionally.
 *    That is not defensive coding; it is the observation that a form with no
 *    label on a required control is one this taxonomy cannot possibly
 *    classify, and inventing an intent for one would be exactly the kind of
 *    silent misroute this module exists to prevent.
 */
export function classifyIntent(question: string): CanonicalTopic | null {
  const text = typeof question === "string" ? question.trim() : "";
  if (text === "") return null;

  const matched = CANONICAL_TOPICS.filter((topic) =>
    topic.matchers.some((matcher) => matcher.test(text))
  );

  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0]!;

  // Multi-match: apply the known specialization pairs first. Each pair reads
  // "if these two both fire, drop the general side". A question can trigger
  // several pairs at once (a "spouse ... federal government" question hits
  // family_govt AND federal_govt), so this runs as a filter over the full
  // match set rather than as a special case for length === 2. Adding a new
  // pair costs one entry here and two test cases in `canonical-topics.test.ts`.
  const specializationPairs: readonly [string, string][] = [
    ["family_govt_employment_5y", "federal_govt_employment_5y"],
    ["family_govt_employment_5y", "state_local_govt_employment_5y"],
    ["us_citizen_or_pr", "citizen_sanctioned_country"],
    ["requires_visa_sponsorship", "work_auth_current_us"],
  ];
  const matchedSlugs = new Set(matched.map((topic) => topic.slug));
  const dropped = new Set<string>();
  for (const [specific, general] of specializationPairs) {
    if (matchedSlugs.has(specific) && matchedSlugs.has(general)) {
      dropped.add(general);
    }
  }
  const surviving = matched.filter((topic) => !dropped.has(topic.slug));
  if (surviving.length === 1) return surviving[0]!;

  // Genuine multi-match with no pair to resolve it — the question is
  // compound. Escalate rather than pick a winner.
  return null;
}

/** The intent with this slug, or null. Named lookup for `resolveAnswer`. */
export function canonicalTopicBySlug(slug: string): CanonicalTopic | null {
  return CANONICAL_TOPICS.find((topic) => topic.slug === slug) ?? null;
}

/**
 * The subset of intents that must never be answered from anything softer than
 * a typed profile column, a stored candidate answer, or an explicit
 * escalation to the candidate. Consulted by `lib/fill-application-form.ts`
 * (see `blockedForAnswers`) to narrow HARD STOP #9's blanket "no fabrication
 * for legal attestations" rule down to the intents that actually carry a
 * post-hire consequence when wrong.
 */
export const ALWAYS_BLOCK_TOPIC_SLUGS: ReadonlySet<string> = new Set(
  CANONICAL_TOPICS.filter((topic) => topic.alwaysBlock).map((topic) => topic.slug)
);
