/**
 * JOB-134. What the answer memory keeps, what it refuses to keep, and what it
 * refuses to call the same question.
 *
 * The second of those is the one worth reading. Issue #134 asks for two
 * employers wording one question differently to stop being two questions to the
 * candidate, and warns in the same sentence that merging two questions which
 * only look alike is how a wrong answer reaches a form. The split this module
 * makes is that a canonical topic decides only which stored answers are the
 * same answer, and never routes an answer onto a field it did not match. So
 * every test below about topics is a test about deduplication, and the tests
 * about a wrong answer reaching a form live where they always did, over the
 * attestation ladder in `adaptive-form-fill.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalAnswerTopic,
  parseStoredAnswers,
  rememberAnswers,
  sameStoredAnswers,
  withStoredAnswers,
  STORED_ANSWER_LIMIT,
  type StoredAnswer,
} from "@/lib/candidate-answers";

const NOW = new Date("2026-08-22T12:00:00.000Z");

function remember(
  stored: readonly StoredAnswer[],
  supplied: Record<string, string>
): StoredAnswer[] {
  return rememberAnswers(stored, supplied, { now: NOW });
}

// ═══════════════════════════════════════════════════════════════════════════
describe("canonical topics recognise the questions every employer asks", () => {
  it("reads a non-compete question in any of the wordings boards use", () => {
    // The question that stopped the Avery Dennison run, plus the wordings three
    // other boards draw it in. One entry, not four.
    for (const question of [
      "are you subject to a non-compete agreement?",
      "do you have any non compete obligations to a former employer?",
      "are you bound by any non-solicitation clause?",
      "please confirm you are under no restrictive covenants",
    ]) {
      expect(canonicalAnswerTopic(question)).toBe("restrictive_covenant");
    }
  });

  it("reads a salary question only when it asks what the candidate wants", () => {
    expect(canonicalAnswerTopic("what are your salary expectations?")).toBe(
      "salary_expectation"
    );
    expect(canonicalAnswerTopic("desired compensation")).toBe("salary_expectation");
    // The word on its own is most of a job description, and a question about
    // how somebody heard of a pay transparency notice is not a question about
    // what they want to be paid.
    expect(canonicalAnswerTopic("this role's compensation is posted below")).toBeNull();
  });

  it("reads relatives and prior employment as two different questions", () => {
    expect(
      canonicalAnswerTopic("do you have any relatives employed by this company?")
    ).toBe("relatives_at_employer");
    expect(
      canonicalAnswerTopic("have you ever been employed by our company?")
    ).toBe("prior_employment_at_employer");
  });

  it("gives a question naming the employer by name no topic at all", () => {
    // "Have you previously worked at Avery Dennison?" is a question about one
    // named company, and its answer is not an answer about employers in
    // general. No topic means it is kept under its own wording and merged with
    // nothing, which is right.
    expect(
      canonicalAnswerTopic("have you previously worked at avery dennison?")
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a topic never merges across jurisdictions", () => {
  it("reads a US sponsorship question as the US sponsorship question", () => {
    expect(
      canonicalAnswerTopic(
        "will you now or in the future require sponsorship to work in the United States?"
      )
    ).toBe("visa_sponsorship_us");
    expect(canonicalAnswerTopic("do you require visa sponsorship in the U.S.?")).toBe(
      "visa_sponsorship_us"
    );
  });

  it("refuses to give the UK version of the question the US topic", () => {
    // Issue #108, applied to keying rather than to answering. The UK question
    // and the US question are not one question, and a topic table that merged
    // them would hand the second answer to the first — which is the exact
    // failure that issue records, arriving by a new route.
    expect(
      canonicalAnswerTopic(
        "do you now, or will you in the future, need sponsorship to work in the UK?"
      )
    ).toBeNull();
    expect(
      canonicalAnswerTopic("will you require sponsorship to work in Ireland?")
    ).toBeNull();
  });

  it("refuses a sponsorship question that names no country", () => {
    // Safe in the right direction: no topic means no merge, and the answer is
    // still kept under its own wording and still reused through the fact
    // catalogue. A gap in this table costs nothing but a duplicate entry.
    expect(canonicalAnswerTopic("will you require visa sponsorship?")).toBeNull();
  });

  it("does not read the pronoun \"us\" as the United States", () => {
    // Every board on earth calls itself "us". Reading that as the country is
    // issue #108 with an extra step.
    expect(
      canonicalAnswerTopic("would you need sponsorship to work for us?")
    ).toBeNull();
  });

  it("gives a question about two topics no topic", () => {
    // A compound question is evidence that the question is about two things,
    // not that the two things are one. Neither stored answer is replaced by it.
    expect(
      canonicalAnswerTopic(
        "have you ever been employed by our company, and do you have relatives working here?"
      )
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("what the memory keeps", () => {
  it("keeps an answer the candidate gave, keyed by the form's own label", () => {
    const kept = remember([], {
      "are you subject to a non-compete agreement?": "No, I am not currently subject to a non compete",
    });

    expect(kept).toHaveLength(1);
    expect(kept[0]!.question).toBe("are you subject to a non-compete agreement?");
    expect(kept[0]!.answer).toBe("No, I am not currently subject to a non compete");
    expect(kept[0]!.topic).toBe("restrictive_covenant");
    expect(kept[0]!.answeredAt).toBe(NOW.toISOString());
  });

  it("keeps one entry when a second board words the same question differently", () => {
    // The deduplication, and the only thing a canonical topic is ever used for.
    const first = remember([], {
      "are you subject to a non-compete agreement?": "No",
    });
    const second = remember(first, {
      "are you bound by any non-solicitation clause with a previous employer?": "No",
    });

    expect(second).toHaveLength(1);
    // The newest wording wins, because it is the sentence the person most
    // recently read and answered.
    expect(second[0]!.question).toContain("non-solicitation");
  });

  it("keeps two entries for two questions it does not recognise", () => {
    const kept = remember([], {
      "what is your favourite programming language?": "TypeScript",
      "how did you hear about this role?": "A friend",
    });

    expect(kept).toHaveLength(2);
    expect(kept.every((entry) => entry.topic === null)).toBe(true);
  });

  it("treats one question in two spellings as one question", () => {
    const first = remember([], { "Are you subject to a non-compete?": "No" });
    // Same sentence, different case and a required marker the form printed.
    const second = remember(first, { "* are you subject to a non-compete? ": "Yes" });

    expect(second).toHaveLength(1);
    expect(second[0]!.answer).toBe("Yes");
  });

  it("lets the newest answer replace the one it had", () => {
    const first = remember([], { "what are your salary expectations?": "$110,000" });
    const second = remember(first, { "desired compensation": "$130,000" });

    expect(second).toHaveLength(1);
    expect(second[0]!.answer).toBe("$130,000");
  });

  it("drops nothing but the oldest when it reaches the cap", () => {
    const supplied: Record<string, string> = {};
    for (let i = 0; i < STORED_ANSWER_LIMIT + 20; i += 1) {
      supplied[`unrecognised question number ${i}`] = `answer ${i}`;
    }
    expect(remember([], supplied)).toHaveLength(STORED_ANSWER_LIMIT);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("what the memory refuses to keep", () => {
  it("never stores a demographic answer, whatever supplied one", () => {
    // HARD STOP 10. Race, gender, veteran status and disability status are
    // answered "decline to self identify" on every form, are never stored and
    // are never transmitted. That a caller managed to supply one does not make
    // it storable, and this is the last place it could be written down.
    const kept = remember([], {
      "what is your gender?": "prefer not to say",
      "are you a protected veteran?": "No",
      "do you have a disability?": "No",
      "race / ethnicity": "prefer not to say",
      "please self-identify your gender": "prefer not to say",
    });

    expect(kept).toEqual([]);
  });

  it("does not drop an answer because the question contains the word agreement", () => {
    // JOB-132, one layer down, and this test is why `neverStored` has exactly
    // one rule. An earlier draft also excluded anything matching
    // `CONSENT_FIELD_RE`, which matches the word "agreement", which is in the
    // question that stopped the Avery Dennison run. The answer this whole
    // ticket exists to keep was being silently thrown away by the code meant to
    // keep it.
    //
    // The safety that arm was supposed to add is where it always was:
    // `resolveAdditionalAnswer` still refuses to tick a checkbox or a radio
    // from a supplied answer, stored or not.
    const kept = remember([], {
      "are you subject to a non-compete agreement?": "No",
    });

    expect(kept).toHaveLength(1);
    expect(kept[0]!.answer).toBe("No");
  });

  it("drops a demographic answer on the way out as well as on the way in", () => {
    // Defence in depth. `rememberAnswers` is the only writer this build has,
    // but the column is JSON in a database that outlives any one build.
    const parsed = parseStoredAnswers([
      { question: "what is your gender?", answer: "prefer not to say", answeredAt: "" },
      { question: "what are your salary expectations?", answer: "$120,000", answeredAt: "" },
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.question).toBe("what are your salary expectations?");
  });

  it("drops an entry that is not a question and an answer", () => {
    expect(
      parseStoredAnswers([
        null,
        "not an object",
        { question: "", answer: "yes" },
        { question: "a real question?", answer: "   " },
        { answer: "orphaned" },
        { question: "how many years of Python?", answer: "4" },
      ])
    ).toHaveLength(1);
  });

  it("reads a null column as no answers rather than as an error", () => {
    expect(parseStoredAnswers(null)).toEqual([]);
    expect(parseStoredAnswers(undefined)).toEqual([]);
    expect(parseStoredAnswers({ question: "not an array" })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("stored answers reach the fill as ordinary supplied answers", () => {
  const stored: StoredAnswer[] = [
    {
      question: "are you subject to a non-compete agreement?",
      answer: "No",
      topic: "restrictive_covenant",
      answeredAt: NOW.toISOString(),
    },
    {
      question: "how many years of python do you have?",
      answer: "4",
      topic: null,
      answeredAt: NOW.toISOString(),
    },
  ];

  it("hands a caller that supplied nothing everything the person ever answered", () => {
    expect(withStoredAnswers(stored, {})).toEqual({
      "are you subject to a non-compete agreement?": "No",
      "how many years of python do you have?": "4",
    });
  });

  it("lets a freshly supplied answer beat the stored one, in value and in order", () => {
    // Both halves matter. `matchAdditionalAnswer` walks this object in
    // insertion order and takes the first key that contains or is contained by
    // the field's own, so a stale stored answer listed first could win a fuzzy
    // match against a fresh one listed second. Somebody answering a question
    // again right now is correcting the record.
    const merged = withStoredAnswers(stored, {
      "Are you subject to a non-compete agreement?": "Yes",
    });

    expect(Object.values(merged)).toContain("Yes");
    expect(Object.values(merged)).not.toContain("No");
    expect(Object.keys(merged)[0]).toBe("Are you subject to a non-compete agreement?");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("an unchanged list is not written back", () => {
  it("says a run that learned nothing new changed nothing", () => {
    const stored = remember([], { "how many years of python?": "4" });
    expect(sameStoredAnswers(remember(stored, {}), stored)).toBe(true);
    expect(sameStoredAnswers(remember(stored, { "how many years of python?": "4" }), stored)).toBe(
      true
    );
  });

  it("says a run that was told something new did change something", () => {
    const stored = remember([], { "how many years of python?": "4" });
    expect(sameStoredAnswers(remember(stored, { "how many years of go?": "1" }), stored)).toBe(
      false
    );
  });
});
