// @vitest-environment node
/**
 * v1-C (#143). PUT /api/applications/{id}/escalation-answers, driven by a fake
 * Supabase client for both the session and service role paths.
 *
 * The endpoint has three shapes it must honor: refuse a caller who does not
 * own the row, merge the answers into `profiles.stored_answers` keyed by the
 * escalated question text (so the fill loop's own lookup finds them), and
 * flip the row back to `discovered` so the cron picks it up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const APPLICATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type FakeApplicationRow = {
  id: string;
  user_id: string;
  status: string;
  escalation_questions: unknown;
};

type FakeProfileRow = {
  id: string;
  stored_answers: unknown;
};

const state = {
  currentUserId: null as string | null,
  application: null as FakeApplicationRow | null,
  profile: { id: USER_ID, stored_answers: null } as FakeProfileRow,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
};

function makeChain(table: string, verb: string, payload?: unknown) {
  let matchedId: string | null = null;
  const chain: Record<string, unknown> = {
    select() {
      return chain;
    },
    eq(col: string, val: unknown) {
      if (col === "id" && typeof val === "string") matchedId = val;
      return chain;
    },
    async maybeSingle() {
      if (table === "applications") {
        if (state.application && matchedId === state.application.id) {
          return { data: state.application, error: null };
        }
        return { data: null, error: null };
      }
      if (table === "profiles") {
        return { data: state.profile, error: null };
      }
      return { data: null, error: null };
    },
    async then(resolve: (v: { error: null }) => unknown) {
      if (verb === "update") {
        state.updates.push({ table, payload: payload as Record<string, unknown> });
      }
      return Promise.resolve({ error: null }).then(resolve);
    },
  };
  return chain;
}

function fakeSupabaseClient(sessionUserId: string | null) {
  return {
    auth: {
      async getUser() {
        return {
          data: {
            user: sessionUserId === null ? null : { id: sessionUserId },
          },
          error: null,
        };
      },
    },
    from(table: string) {
      return {
        select() {
          return makeChain(table, "select");
        },
        update(payload: Record<string, unknown>) {
          return makeChain(table, "update", payload);
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: async () => fakeSupabaseClient(state.currentUserId),
  createServiceRoleClient: () => fakeSupabaseClient(null),
}));

vi.mock("@/lib/supabase-project-guard", () => ({
  assertSupabaseProject: () => undefined,
}));

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const { PUT } = await import("@/app/api/applications/[id]/escalation-answers/route");

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/applications/x/escalation-answers", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof PUT>[0];
}

beforeEach(() => {
  state.currentUserId = USER_ID;
  state.application = {
    id: APPLICATION_ID,
    user_id: USER_ID,
    status: "pending_user_input",
    escalation_questions: [
      {
        fieldKey: "are you legally authorized to work in the united states?",
        fieldLabel: "Are you legally authorized to work in the United States?",
        question: "Are you legally authorized to work in the United States?",
        options: ["Yes", "No"],
        required: true,
        topicSlug: "work_auth_current_us",
      },
    ],
  };
  state.profile = { id: USER_ID, stored_answers: null };
  state.updates = [];
});

// v1-BLOCKER-2 (#152). Body shape is the camelCase array v1-D's
// `EscalationForm` submits; each entry carries its own `question` verbatim
// and the pipeline's `topicSlug` when one was assigned.
const QUESTION_TEXT = "Are you legally authorized to work in the United States?";

describe("PUT /api/applications/[id]/escalation-answers", () => {
  it("401s a caller with no session", async () => {
    state.currentUserId = null;
    const response = await PUT(
      makeRequest({
        answers: [
          { topicSlug: "work_auth_current_us", question: QUESTION_TEXT, answer: "Yes" },
        ],
      }),
      { params: Promise.resolve({ id: APPLICATION_ID }) }
    );
    expect(response.status).toBe(401);
    expect(state.updates).toHaveLength(0);
  });

  it("404s a caller who does not own the row", async () => {
    state.currentUserId = OTHER_USER_ID;
    const response = await PUT(
      makeRequest({
        answers: [
          { topicSlug: "work_auth_current_us", question: QUESTION_TEXT, answer: "Yes" },
        ],
      }),
      { params: Promise.resolve({ id: APPLICATION_ID }) }
    );
    expect(response.status).toBe(404);
    expect(state.updates).toHaveLength(0);
  });

  it("409s when the row is not currently pending_user_input", async () => {
    state.application!.status = "discovered";
    const response = await PUT(
      makeRequest({
        answers: [
          { topicSlug: "work_auth_current_us", question: QUESTION_TEXT, answer: "Yes" },
        ],
      }),
      { params: Promise.resolve({ id: APPLICATION_ID }) }
    );
    expect(response.status).toBe(409);
    expect(state.updates).toHaveLength(0);
  });

  it("400s an empty answers array", async () => {
    const response = await PUT(
      makeRequest({ answers: [] }),
      { params: Promise.resolve({ id: APPLICATION_ID }) }
    );
    expect(response.status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });

  it("400s an entry missing the question text", async () => {
    const response = await PUT(
      makeRequest({
        answers: [{ topicSlug: null, answer: "Yes" }],
      }),
      { params: Promise.resolve({ id: APPLICATION_ID }) }
    );
    expect(response.status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });

  it("400s an entry missing the answer text", async () => {
    const response = await PUT(
      makeRequest({
        answers: [{ topicSlug: null, question: QUESTION_TEXT }],
      }),
      { params: Promise.resolve({ id: APPLICATION_ID }) }
    );
    expect(response.status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });

  it("400s an answers key that is an object (the pre-#152 shape)", async () => {
    const response = await PUT(
      makeRequest({ answers: { "some field": "Yes" } }),
      { params: Promise.resolve({ id: APPLICATION_ID }) }
    );
    expect(response.status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });

  it("merges the answers into profiles.stored_answers and flips status to discovered", async () => {
    const response = await PUT(
      makeRequest({
        answers: [
          { topicSlug: "work_auth_current_us", question: QUESTION_TEXT, answer: "Yes" },
        ],
      }),
      { params: Promise.resolve({ id: APPLICATION_ID }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; answersMerged: number };
    expect(body.ok).toBe(true);
    expect(body.answersMerged).toBe(1);

    const profileUpdate = state.updates.find((u) => u.table === "profiles");
    const applicationUpdate = state.updates.find((u) => u.table === "applications");

    expect(profileUpdate).toBeDefined();
    const answers = (profileUpdate!.payload.stored_answers as Array<{
      question: string;
      answer: string;
      topic: string | null;
    }>);
    expect(answers).toHaveLength(1);
    // v1-B's `rememberAnswers` lowercases and length-caps the question before
    // storing, so the stored form is the normalised shape rather than the
    // employer's original casing. See `lib/candidate-answers.ts`.
    expect(answers[0]!.question).toBe(QUESTION_TEXT.toLowerCase());
    expect(answers[0]!.answer).toBe("Yes");
    expect(answers[0]!.topic).toBe("work_auth_current_us");

    expect(applicationUpdate).toBeDefined();
    expect(applicationUpdate!.payload.status).toBe("discovered");
    expect(applicationUpdate!.payload.escalation_questions).toBeNull();
    expect(typeof applicationUpdate!.payload.escalation_resolved_at).toBe("string");
  });

  it("accepts an unknown-intent entry (topicSlug null) and still merges the answer", async () => {
    // The pipeline may escalate a question without a slug when the classifier
    // did not recognise the intent. The route must still merge the answer;
    // `rememberAnswers` re-runs the classifier and picks up a slug if the
    // taxonomy has since grown to cover it, otherwise the entry is filed by
    // normalised question text. Either behaviour is correct — the round-trip
    // property is that the answer is remembered, not what it was keyed on.
    const response = await PUT(
      makeRequest({
        answers: [
          { topicSlug: null, question: "How did you hear about us?", answer: "LinkedIn" },
        ],
      }),
      { params: Promise.resolve({ id: APPLICATION_ID }) }
    );
    expect(response.status).toBe(200);
    const profileUpdate = state.updates.find((u) => u.table === "profiles");
    expect(profileUpdate).toBeDefined();
    const answers = profileUpdate!.payload.stored_answers as Array<{
      question: string;
      answer: string;
      topic: string | null;
    }>;
    expect(answers).toHaveLength(1);
    expect(answers[0]!.answer).toBe("LinkedIn");
    expect(answers[0]!.question).toBe("how did you hear about us?");
  });
});
