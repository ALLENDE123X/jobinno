// @vitest-environment node
/**
 * JOB-v1-B — the stored-answer store and its `resolveAnswer` ladder.
 *
 * Everything here is pure: the module holds no Supabase client, no page and
 * nothing that can act. Every scenario is a plain-object profile snapshot and
 * a plain array of stored entries, run against the ladder documented on the
 * function.
 */
import { describe, expect, it } from "vitest";

import {
  classifiedIntentMustBlock,
  parseStoredAnswers,
  rememberAnswers,
  resolveAnswer,
  sameStoredAnswers,
  STORED_ANSWER_LIMIT,
  type StoredAnswer,
} from "@/lib/candidate-answers";

// ═══════════════════════════════════════════════════════════════════════════
// The three sources — profile column, intent-keyed store, canonical default —
// each verified against a real question from the classifier's corpus.
// ═══════════════════════════════════════════════════════════════════════════

describe("the resolveAnswer ladder", () => {
  describe("profile_column", () => {
    it("returns the column value when profiles.work_authorized_us is set", () => {
      const resolved = resolveAnswer(
        "Are you legally authorized to work in the country in which you are applying for a role?",
        { workAuthorizedUs: true },
        []
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.answer).toBe("Yes");
      expect(resolved!.source).toBe("profile_column");
      expect(resolved!.topic).toBe("work_auth_current_us");
    });

    it("returns the column value when profiles.requires_sponsorship is set", () => {
      const resolved = resolveAnswer(
        "Do you now, or will you in the future, require immigration sponsorship for work authorization?",
        { requiresSponsorship: false },
        []
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.answer).toBe("No");
      expect(resolved!.source).toBe("profile_column");
      expect(resolved!.topic).toBe("requires_visa_sponsorship");
    });

    it("derives us_citizen_or_pr from a citizenship_status of us_citizen", () => {
      const resolved = resolveAnswer(
        "Are you a U.S. citizen or a lawful permanent resident?",
        { citizenshipStatus: "us_citizen" },
        []
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.answer).toBe("Yes");
      expect(resolved!.source).toBe("profile_column");
      expect(resolved!.topic).toBe("us_citizen_or_pr");
    });

    it("prefers a column-backed answer over an intent-keyed stored one", () => {
      // Stored answer says No; the column says Yes. Column wins — it is the
      // authoritative answer, the stored row may be stale from an earlier
      // profile state that has since been corrected.
      const resolved = resolveAnswer(
        "Are you legally authorized to work in the United States?",
        { workAuthorizedUs: true },
        [
          {
            topic: "work_auth_current_us",
            question: "some earlier wording",
            answer: "No",
            answeredAt: "2020-01-01T00:00:00.000Z",
          },
        ]
      );
      expect(resolved!.answer).toBe("Yes");
      expect(resolved!.source).toBe("profile_column");
    });
  });

  describe("stored_by_intent", () => {
    it("returns the stored answer keyed by intent slug when no column has it", () => {
      const resolved = resolveAnswer(
        "Have you ever been convicted of a felony?",
        {},
        [
          {
            topic: "criminal_conviction_history",
            question: "have you ever been convicted of a crime?",
            answer: "No",
            answeredAt: "2026-08-25T10:00:00.000Z",
          },
        ]
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.answer).toBe("No");
      expect(resolved!.source).toBe("stored_by_intent");
      expect(resolved!.topic).toBe("criminal_conviction_history");
    });

    it("survives a wording change on the current form", () => {
      // The stored row's question text says "criminal record", the current
      // form asks about "felony conviction". Both classify into
      // `criminal_conviction_history`, so the intent slug matches even
      // though a fuzzy substring on the question text would miss.
      const resolved = resolveAnswer(
        "Do you have any criminal convictions on your record?",
        {},
        [
          {
            topic: "criminal_conviction_history",
            question: "have you ever been convicted of a felony?",
            answer: "No",
            answeredAt: "2026-08-24T10:00:00.000Z",
          },
        ]
      );
      expect(resolved!.source).toBe("stored_by_intent");
      expect(resolved!.answer).toBe("No");
    });
  });

  describe("canonical_default", () => {
    it("returns the canonical default for a defaultable intent when nothing else covers it", () => {
      const resolved = resolveAnswer(
        "I consent to the processing of your personal data as described in this notice.",
        {},
        []
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.answer).toBe("Yes");
      expect(resolved!.source).toBe("canonical_default");
      expect(resolved!.topic).toBe("gdpr_data_processing_consent");
    });

    it("returns LinkedIn as the default source for heard_about_us_source", () => {
      const resolved = resolveAnswer("How did you hear about us?", {}, []);
      expect(resolved!.answer).toBe("LinkedIn");
      expect(resolved!.source).toBe("canonical_default");
    });

    it("prefers a stored answer over the canonical default", () => {
      const resolved = resolveAnswer(
        "How did you hear about us?",
        {},
        [
          {
            topic: "heard_about_us_source",
            question: "how did you hear about us?",
            answer: "Referred by a friend",
            answeredAt: "2026-08-25T10:00:00.000Z",
          },
        ]
      );
      expect(resolved!.answer).toBe("Referred by a friend");
      expect(resolved!.source).toBe("stored_by_intent");
    });
  });

  describe("null — escalate to the candidate", () => {
    it("escalates a classified intent with no column, no stored, and no default", () => {
      // Salary expectation is classified but never defaulted. Nothing on
      // the profile answers it; escalate.
      expect(
        resolveAnswer("What are your salary expectations?", {}, [])
      ).toBeNull();
    });

    it("escalates a video-interview-recording question — a real preference, not defaultable", () => {
      expect(
        resolveAnswer("Do you consent to your video interviews being recorded?", {}, [])
      ).toBeNull();
    });

    it("escalates an alwaysBlock intent even when the wording is unambiguous", () => {
      expect(
        resolveAnswer(
          "Are you a citizen of or ordinarily resident in Cuba, Syria, Iran, or North Korea?",
          {},
          []
        )
      ).toBeNull();
    });
  });

  describe("stored_by_question — the legacy fuzzy path", () => {
    it("falls through to a fuzzy question-text match when the classifier does not recognise the intent", () => {
      // This is a real cover-letter-adjacent question the taxonomy does not
      // cover. The stored entry has no intent slug (legacy row), so the
      // fuzzy path takes over — a substring match on the raw question.
      const resolved = resolveAnswer(
        "Please describe a project you are proud of.",
        {},
        [
          {
            topic: null,
            question: "describe a project you are proud of",
            answer: "My senior thesis, described at length elsewhere.",
            answeredAt: "2026-08-25T10:00:00.000Z",
          },
        ]
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.source).toBe("stored_by_question");
      expect(resolved!.topic).toBeNull();
    });

    it("does not fall through to fuzzy when the classifier DID recognise the intent", () => {
      // The classifier recognises this as work_auth_current_us. Even though
      // a legacy row with the same words is present, the ladder returns
      // null rather than sliding into the fuzzy path — that path exists
      // only to catch questions the taxonomy does not know about, and using
      // it here would re-introduce the substring-collision bug this file
      // fixes.
      const resolved = resolveAnswer(
        "Are you authorized to work in the United States?",
        {},
        [
          {
            topic: null,
            question: "are you authorized to work in the united states?",
            answer: "Yes",
            answeredAt: "2020-01-01T00:00:00.000Z",
          },
        ]
      );
      expect(resolved).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The integration scenario the ticket asks for: three real questions, three
// different resolution sources, all in one call.
// ═══════════════════════════════════════════════════════════════════════════

describe("integration: three questions, three sources", () => {
  it("routes work-auth to profile column, criminal-history to stored intent, and GDPR to canonical default", () => {
    const profile = { workAuthorizedUs: true };
    const stored: StoredAnswer[] = [
      {
        topic: "criminal_conviction_history",
        question: "have you ever been convicted of a felony?",
        answer: "No",
        answeredAt: "2026-08-25T10:00:00.000Z",
      },
    ];

    const workAuth = resolveAnswer(
      "Are you authorized to work in the United States?",
      profile,
      stored
    );
    expect(workAuth?.source).toBe("profile_column");
    expect(workAuth?.topic).toBe("work_auth_current_us");
    expect(workAuth?.answer).toBe("Yes");

    const felony = resolveAnswer(
      "Do you have any criminal convictions on your record?",
      profile,
      stored
    );
    expect(felony?.source).toBe("stored_by_intent");
    expect(felony?.topic).toBe("criminal_conviction_history");
    expect(felony?.answer).toBe("No");

    const gdpr = resolveAnswer(
      "I consent to the processing of your personal data as described in this notice.",
      profile,
      stored
    );
    expect(gdpr?.source).toBe("canonical_default");
    expect(gdpr?.topic).toBe("gdpr_data_processing_consent");
    expect(gdpr?.answer).toBe("Yes");

    // And the un-answerable question routes to escalation.
    const salary = resolveAnswer("What are your salary expectations?", profile, stored);
    expect(salary).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseStoredAnswers and rememberAnswers — write side.
// ═══════════════════════════════════════════════════════════════════════════

describe("parseStoredAnswers", () => {
  it("returns an empty list for null, undefined or a non-array", () => {
    expect(parseStoredAnswers(null)).toEqual([]);
    expect(parseStoredAnswers(undefined)).toEqual([]);
    expect(parseStoredAnswers({})).toEqual([]);
    expect(parseStoredAnswers("not an array")).toEqual([]);
  });

  it("drops entries with a missing or empty question or answer", () => {
    const parsed = parseStoredAnswers([
      { question: "", answer: "yes", answeredAt: "2026-08-25T10:00:00Z" },
      { question: "How did you hear about us?", answer: "" },
      { question: "How did you hear about us?", answer: "LinkedIn", answeredAt: "2026-08-25T10:00:00Z" },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.answer).toBe("LinkedIn");
  });

  it("recomputes the topic slug from the current taxonomy rather than trusting the stored value", () => {
    const parsed = parseStoredAnswers([
      {
        // A row from an earlier taxonomy that mislabelled this as
        // "sponsorship". The classifier now correctly reads it as
        // work-auth, and the recomputed topic wins.
        topic: "requires_visa_sponsorship",
        question: "Are you authorized to work in the United States?",
        answer: "Yes",
        answeredAt: "2026-08-25T10:00:00Z",
      },
    ]);
    expect(parsed[0]!.topic).toBe("work_auth_current_us");
  });

  it("drops HARD-STOP-10 demographic entries on the way out even if they somehow reached the column", () => {
    const parsed = parseStoredAnswers([
      {
        question: "What is your gender?",
        answer: "prefer not to say",
        answeredAt: "2026-08-25T10:00:00Z",
      },
      {
        question: "How did you hear about us?",
        answer: "LinkedIn",
        answeredAt: "2026-08-25T10:00:00Z",
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.question).toBe("how did you hear about us?");
  });

  it("deduplicates by intent slug, keeping the first occurrence", () => {
    const parsed = parseStoredAnswers([
      {
        question: "Have you ever been convicted of a felony?",
        answer: "No",
        answeredAt: "2026-08-25T10:00:00Z",
      },
      {
        question: "Do you have any criminal convictions on your record?",
        answer: "Yes",
        answeredAt: "2026-08-24T10:00:00Z",
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.answer).toBe("No");
  });
});

describe("rememberAnswers", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");

  it("assigns an intent slug at write time using the classifier", () => {
    const merged = rememberAnswers(
      [],
      [
        {
          question: "Are you legally authorized to work in the country in which you are applying for a role?",
          answer: "Yes",
        },
      ],
      { now }
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.topic).toBe("work_auth_current_us");
    expect(merged[0]!.answer).toBe("Yes");
    expect(merged[0]!.answeredAt).toBe(now.toISOString());
  });

  it("accepts an explicit topic slug from v1-C's escalation flow", () => {
    const merged = rememberAnswers(
      [],
      [
        {
          question: "some unusual wording the classifier does not know yet",
          answer: "some answer",
          topic: "salary_expectation",
        },
      ],
      { now }
    );
    expect(merged[0]!.topic).toBe("salary_expectation");
  });

  it("rejects an explicit topic that does not name a known intent", () => {
    const merged = rememberAnswers(
      [],
      [
        {
          question: "some wording",
          answer: "some answer",
          topic: "not_a_real_slug",
        },
      ],
      { now }
    );
    // Falls back to the classifier, which does not recognise this either.
    expect(merged[0]!.topic).toBeNull();
  });

  it("newest wins when an incoming answer shares an intent slug with a stored one", () => {
    const stored: StoredAnswer[] = [
      {
        topic: "heard_about_us_source",
        question: "how did you hear about us?",
        answer: "LinkedIn",
        answeredAt: "2026-08-24T10:00:00.000Z",
      },
    ];
    const merged = rememberAnswers(
      stored,
      [{ question: "How did you hear about us?", answer: "A friend referred me" }],
      { now }
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.answer).toBe("A friend referred me");
  });

  it("drops HARD-STOP-10 demographic answers before they reach storage", () => {
    const merged = rememberAnswers(
      [],
      [
        { question: "What is your gender?", answer: "prefer not to say" },
        { question: "Race", answer: "prefer not to say" },
        { question: "How did you hear about us?", answer: "LinkedIn" },
      ],
      { now }
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.question).toContain("how did you hear about us");
  });

  it("caps the merged list at STORED_ANSWER_LIMIT, dropping the oldest first", () => {
    const incoming = Array.from({ length: 5 }, (_, i) => ({
      question: `Fresh question ${i}?`,
      answer: `Fresh answer ${i}`,
    }));
    const stored = Array.from({ length: STORED_ANSWER_LIMIT }, (_, i) => ({
      topic: null,
      question: `Old question ${i}?`,
      answer: `Old answer ${i}`,
      answeredAt: "2020-01-01T00:00:00.000Z",
    }));
    const merged = rememberAnswers(stored, incoming, { now });
    expect(merged.length).toBe(STORED_ANSWER_LIMIT);
    expect(merged[0]!.answer).toBe("Fresh answer 0");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// sameStoredAnswers and the block-narrowing helper.
// ═══════════════════════════════════════════════════════════════════════════

describe("sameStoredAnswers", () => {
  const now = "2026-08-25T10:00:00.000Z";
  const a: StoredAnswer = {
    topic: "work_auth_current_us",
    question: "are you authorized?",
    answer: "Yes",
    answeredAt: now,
  };

  it("compares length, question, answer and topic", () => {
    expect(sameStoredAnswers([a], [a])).toBe(true);
    expect(sameStoredAnswers([a], [{ ...a, answer: "No" }])).toBe(false);
    expect(sameStoredAnswers([a], [{ ...a, topic: "other" }])).toBe(false);
    expect(sameStoredAnswers([a], [])).toBe(false);
  });
});

describe("classifiedIntentMustBlock", () => {
  it("returns mustBlock=true for a real work-authorization question", () => {
    const { intent, mustBlock } = classifiedIntentMustBlock(
      "Are you authorized to work in the United States?"
    );
    expect(intent?.slug).toBe("work_auth_current_us");
    expect(mustBlock).toBe(true);
  });

  it("returns mustBlock=false for a boilerplate consent question with a safe default", () => {
    const { intent, mustBlock } = classifiedIntentMustBlock(
      "I consent to the processing of your personal data as described in this notice."
    );
    expect(intent?.slug).toBe("gdpr_data_processing_consent");
    expect(mustBlock).toBe(false);
  });

  it("returns intent=null and mustBlock=false for a question the taxonomy does not recognise", () => {
    const { intent, mustBlock } = classifiedIntentMustBlock(
      "Please describe your favourite side project."
    );
    expect(intent).toBeNull();
    expect(mustBlock).toBe(false);
  });
});
