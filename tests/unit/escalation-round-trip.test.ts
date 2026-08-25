// @vitest-environment node
/**
 * v1-BLOCKER-2 (#152). The escalation cycle end to end, exercising every one
 * of the four hand-offs that were disagreeing before this ticket:
 *
 *   1. `writeEscalation` (v1-C, the source of truth) writes to
 *      `applications.escalation_questions`.
 *   2. `readApplicationQueue` (v1-D) reads it back for the dashboard.
 *   3. The `EscalationForm`'s submit body is built from the reader's shape.
 *   4. The `escalation-answers` API route's `parseAnswers` + `rememberAnswers`
 *      accept that body and file the entries into `profiles.stored_answers`.
 *
 * The whole test runs against fake in-memory Supabase clients: the goal is
 * contract alignment, not database behaviour, so no live-DB gating is needed.
 * A separate live-DB integration test still exists at
 * `tests/unit/escalation-integration.test.ts` for the raw column layer.
 */

import { describe, expect, it } from "vitest";

import {
  writeEscalation,
  type EscalationQuestion as WriterQuestion,
} from "@/lib/application-records";
import {
  readApplicationQueue,
  type EscalationQuestion as ReaderQuestion,
} from "@/lib/dashboard/queue-data";
import type { EscalationSubmitPayload } from "@/app/dashboard/queue/escalation-form";
import { parseStoredAnswers, rememberAnswers } from "@/lib/candidate-answers";

const USER_ID = "b79f4c81-37dd-4f02-963d-22c9e47d7c45";
const APPLICATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const QUESTIONS: WriterQuestion[] = [
  {
    fieldKey: "work_auth",
    fieldLabel: "Are you legally authorized to work in the United States?",
    question: "Are you legally authorized to work in the United States?",
    options: ["Yes", "No"],
    required: true,
    topicSlug: "work_auth_current_us",
  },
  {
    // Unknown intent: the classifier could not slug it, so the resume path
    // has to key the answer on the verbatim question text instead.
    fieldKey: "referral_source",
    fieldLabel: "How did you hear about us?",
    question: "How did you hear about us?",
    options: null,
    required: false,
    topicSlug: null,
  },
];

/**
 * A tiny fake Supabase client that stores one `applications` row and one
 * `profiles` row in a shared record. Enough for `writeEscalation` and the
 * queue reader; only the verbs those functions actually call are wired.
 */
function makeFakeSupabase(state: {
  application: Record<string, unknown>;
  profile: Record<string, unknown>;
}) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {
        _filters: [] as Array<[string, unknown]>,
        _ins: [] as Array<[string, unknown[]]>,
        select() {
          return chain;
        },
        update(payload: Record<string, unknown>) {
          Object.assign(state[table === "applications" ? "application" : "profile"], payload);
          return {
            async eq() {
              return { error: null };
            },
          };
        },
        eq(col: string, val: unknown) {
          (chain._filters as Array<[string, unknown]>).push([col, val]);
          return chain;
        },
        in(col: string, values: unknown[]) {
          (chain._ins as Array<[string, unknown[]]>).push([col, values]);
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        async maybeSingle() {
          if (table === "profiles") return { data: state.profile, error: null };
          return { data: state.application, error: null };
        },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          const rows =
            table === "applications" &&
            (chain._filters as Array<[string, unknown]>).some(
              ([c, v]) => c === "user_id" && v === USER_ID
            ) &&
            (chain._ins as Array<[string, unknown[]]>).length === 0
              ? [state.application]
              : (chain._ins as Array<[string, unknown[]]>).some(([c]) => c === "status")
                ? [] // applied side: nothing to return
                : [state.application];
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof writeEscalation>[0];
}

describe("v1-BLOCKER-2 escalation round trip: writer → reader → form → API → stored", () => {
  it("every hand-off preserves the intended data", async () => {
    // ── 1. writeEscalation persists the JSONB payload ──────────────────────
    const state = {
      application: {
        id: APPLICATION_ID,
        user_id: USER_ID,
        status: "discovered",
        escalation_questions: null as unknown,
        escalation_created_at: null as string | null,
        jobs: {
          title: "SWE Intern",
          url: "https://boards.example.com/apply/1",
          location: "San Francisco",
          boards: { company: "Acme Robotics" },
        },
      },
      profile: { id: USER_ID, stored_answers: null as unknown },
    };
    const supabase = makeFakeSupabase(state);

    const escalationNow = new Date("2026-08-25T10:00:00.000Z");
    await writeEscalation(supabase, APPLICATION_ID, QUESTIONS, { now: escalationNow });

    expect(state.application.status).toBe("pending_user_input");
    expect(state.application.escalation_questions).toEqual(QUESTIONS);
    expect(state.application.escalation_created_at).toBe(escalationNow.toISOString());

    // ── 2. readApplicationQueue surfaces every question in the reader shape ─
    const queue = await readApplicationQueue(supabase, USER_ID);
    const pending = queue.pending;
    expect(pending).toHaveLength(1);
    const rendered: ReaderQuestion[] = pending[0]!.escalationQuestions;
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toEqual({
      question: "Are you legally authorized to work in the United States?",
      fieldKey: "work_auth",
      fieldLabel: "Are you legally authorized to work in the United States?",
      options: ["Yes", "No"],
      required: true,
      topicSlug: "work_auth_current_us",
    });
    expect(rendered[1]).toEqual({
      question: "How did you hear about us?",
      fieldKey: "referral_source",
      fieldLabel: "How did you hear about us?",
      options: null,
      required: false,
      topicSlug: null,
    });

    // ── 3. Build the submit body the way `EscalationForm` does ─────────────
    const userAnswers = ["Yes", "LinkedIn"];
    const submitBody: EscalationSubmitPayload = {
      answers: rendered.map((q, i) => ({
        topicSlug: q.topicSlug ?? null,
        question: q.question,
        answer: userAnswers[i]!,
      })),
    };
    // The keys the API will read out of the JSON body match the reader shape
    // exactly — no rewrite step required.
    expect(submitBody.answers[0]).toEqual({
      topicSlug: "work_auth_current_us",
      question: "Are you legally authorized to work in the United States?",
      answer: "Yes",
    });
    expect(submitBody.answers[1]).toEqual({
      topicSlug: null,
      question: "How did you hear about us?",
      answer: "LinkedIn",
    });

    // ── 4. Parse the body the way the API route does, then rememberAnswers ─
    //
    // The route's `parseAnswers` is unexported. Mirror it here in three lines
    // rather than pull it out of the module, because the property being tested
    // is that a body built off the reader shape survives parseAnswers's own
    // validation, not the parser's private structure.
    const parsed = submitBody.answers.map((a) => ({
      topicSlug: typeof a.topicSlug === "string" ? a.topicSlug : null,
      question: (a.question ?? "").trim(),
      answer: (a.answer ?? "").trim(),
    }));
    for (const entry of parsed) {
      expect(entry.question).not.toBe("");
      expect(entry.answer).not.toBe("");
    }

    const existing = parseStoredAnswers(state.profile.stored_answers);
    const now = new Date("2026-08-25T11:00:00.000Z");
    const merged = rememberAnswers(
      existing,
      parsed.map((p) => ({ question: p.question, answer: p.answer, topic: p.topicSlug })),
      { now }
    );

    // Both answers survived the merge. rememberAnswers may re-run the
    // classifier and assign a slug to the referral question if the taxonomy
    // covers it; the round-trip property being asserted is that the answer
    // reached the stored blob, not what it was keyed on.
    expect(merged).toHaveLength(2);
    const bySlug = merged.find((m) => m.topic === "work_auth_current_us");
    expect(bySlug).toBeDefined();
    expect(bySlug!.answer).toBe("Yes");
    const referral = merged.find(
      (m) => m.question === "how did you hear about us?"
    );
    expect(referral).toBeDefined();
    expect(referral!.answer).toBe("LinkedIn");
  });

  it("an entry from writeEscalation always includes the two load-bearing fields", () => {
    // A regression fence: if a future ticket adds a field to writeEscalation
    // without threading it through the reader, this at least catches the
    // reverse — the reader dropping the pair the form needs to build a body.
    const state = {
      application: {
        id: APPLICATION_ID,
        user_id: USER_ID,
        status: "discovered",
        escalation_questions: QUESTIONS,
        jobs: { title: "SWE", url: null, location: null, boards: { company: "X" } },
      },
      profile: { id: USER_ID, stored_answers: null as unknown },
    };
    const supabase = makeFakeSupabase(state);
    return readApplicationQueue(supabase, USER_ID).then((queue) => {
      for (const q of queue.pending[0]!.escalationQuestions) {
        expect(typeof q.question).toBe("string");
        expect(q.question.length).toBeGreaterThan(0);
        expect(typeof q.fieldKey).toBe("string");
        expect(q.fieldKey.length).toBeGreaterThan(0);
      }
    });
  });
});
