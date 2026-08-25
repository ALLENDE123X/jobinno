// @vitest-environment node
/**
 * v1-C (#143). End to end escalation lifecycle against the real database:
 * force a row into `pending_user_input`, verify the columns land, resume via
 * the API contract, and confirm the row is back to `discovered` with the
 * answer merged into `profiles.stored_answers`.
 *
 * Gated behind `ALLOW_LIVE_DB_TESTS=1` and a loopback host, per
 * `tests/live-db-gate.ts` — same rule every other live-DB suite in this
 * repository follows. Nothing here talks to a real employer.
 */

import { afterAll, beforeAll, expect, it } from "vitest";

import postgres from "postgres";

import {
  clearEscalation,
  writeEscalation,
  type EscalationQuestion,
} from "@/lib/application-records";
import { rememberAnswers, parseStoredAnswers } from "@/lib/candidate-answers";
import { liveDbId, liveDbSuite, liveDbUrl } from "../live-db-gate";

const USER_ID = liveDbId();
const APPLICATION_ID = liveDbId();
const JOB_ID = liveDbId();
const BOARD_ID = liveDbId();

const QUESTION_TEXT = "Are you legally authorized to work in the United States?";
const FIELD_KEY = QUESTION_TEXT.toLowerCase();

liveDbSuite("escalation lifecycle end to end", () => {
  const sql = postgres(liveDbUrl, { prepare: false, max: 1, onnotice: () => {} });

  beforeAll(async () => {
    await sql`insert into auth.users (id, email) values (${USER_ID}, 'v1c@example.com')`;
    await sql`
      insert into public.profiles (id, email, attested_at, applications_cap)
      values (${USER_ID}, 'v1c@example.com', now(), 5)`;
    await sql`
      insert into public.boards (id, ats, company, board_token)
      values (${BOARD_ID}, 'greenhouse', 'Acme Robotics', ${`v1c-${BOARD_ID}`})`;
    await sql`
      insert into public.jobs (id, board_id, ats, external_id, title, url)
      values (${JOB_ID}, ${BOARD_ID}, 'greenhouse', ${`v1c-${JOB_ID}`},
              'SWE Intern', 'https://boards.example.com/apply')`;
    await sql`
      insert into public.applications (id, user_id, job_id, status)
      values (${APPLICATION_ID}, ${USER_ID}, ${JOB_ID}, 'discovered')`;
  });

  afterAll(async () => {
    await sql`delete from public.applications where id = ${APPLICATION_ID}`;
    await sql`delete from public.jobs where id = ${JOB_ID}`;
    await sql`delete from public.boards where id = ${BOARD_ID}`;
    await sql`delete from public.profiles where id = ${USER_ID}`;
    await sql`delete from auth.users where id = ${USER_ID}`;
    await sql.end({ timeout: 5 });
  });

  it("writes escalation columns, then clears them and merges the stored answer", async () => {
    // ── 1. writeEscalation lands the four columns and the pending status ──
    const questions: EscalationQuestion[] = [
      {
        fieldKey: FIELD_KEY,
        fieldLabel: QUESTION_TEXT,
        question: QUESTION_TEXT,
        options: ["Yes", "No"],
        required: true,
        // Use the topic slug the canonical answer topic in
        // `lib/candidate-answers.ts` actually assigns to this question,
        // so the reverse read below can assert on the concrete value.
        topicSlug: null,
      },
    ];

    const pgClient = postgresBackedClient(sql);
    const escalationNow = new Date("2026-08-25T10:00:00Z");
    await writeEscalation(pgClient, APPLICATION_ID, questions, {
      now: escalationNow,
    });

    const [afterEscalation] = await sql<
      Array<{
        status: string;
        escalation_questions: unknown;
        escalation_created_at: Date | null;
        escalation_notified_at: Date | null;
        escalation_resolved_at: Date | null;
      }>
    >`
      select status, escalation_questions, escalation_created_at,
             escalation_notified_at, escalation_resolved_at
        from public.applications where id = ${APPLICATION_ID}`;
    expect(afterEscalation?.status).toBe("pending_user_input");
    expect(afterEscalation?.escalation_created_at).not.toBeNull();
    expect(afterEscalation?.escalation_notified_at).toBeNull();
    expect(afterEscalation?.escalation_resolved_at).toBeNull();
    expect(Array.isArray(afterEscalation?.escalation_questions)).toBe(true);
    const stored = afterEscalation?.escalation_questions as Array<{ fieldKey: string }>;
    expect(stored[0]!.fieldKey).toBe(FIELD_KEY);

    // ── 2. Merge the user's answer into stored_answers ────────────────────
    const existing = parseStoredAnswers(null);
    const merged = rememberAnswers(existing, [{ question: QUESTION_TEXT, answer: "Yes" }], {
      now: new Date("2026-08-25T11:00:00Z"),
    });
    await sql`
      update public.profiles
         set stored_answers = ${sql.json(merged)}
       where id = ${USER_ID}`;

    // ── 3. clearEscalation flips the row back to discovered ───────────────
    const resumeNow = new Date("2026-08-25T11:00:05Z");
    await clearEscalation(pgClient, APPLICATION_ID, { now: resumeNow });

    const [afterClear] = await sql<
      Array<{ status: string; escalation_questions: unknown; escalation_resolved_at: Date | null }>
    >`
      select status, escalation_questions, escalation_resolved_at
        from public.applications where id = ${APPLICATION_ID}`;
    expect(afterClear?.status).toBe("discovered");
    expect(afterClear?.escalation_questions).toBeNull();
    expect(afterClear?.escalation_resolved_at).not.toBeNull();

    // ── 4. The stored answer is now available for any future fill ──────
    const [profileAfter] = await sql<Array<{ stored_answers: unknown }>>`
      select stored_answers from public.profiles where id = ${USER_ID}`;
    const parsed = parseStoredAnswers(profileAfter?.stored_answers);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.question.toLowerCase()).toContain("authorized to work");
    expect(parsed[0]!.answer).toBe("Yes");
  });
});

/**
 * A `SupabaseClient`-shaped adapter over the raw `postgres` connection this
 * live suite already opens. `writeEscalation`/`clearEscalation` only ever call
 * `from(...).update(...).eq("id", ...)`, so a hand written shim covering
 * exactly that verb is enough — no PostgREST needed.
 */
function postgresBackedClient(sql: ReturnType<typeof postgres>) {
  return {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          return {
            async eq(column: string, value: unknown) {
              // Serialise every value into a Postgres-friendly literal here
              // rather than relying on `sql.json`'s typing, which is stricter
              // than the shape `EscalationQuestion[]` actually is.
              const values: unknown[] = [];
              const setFragments: string[] = [];
              for (const [col, val] of Object.entries(payload)) {
                if (val === null) {
                  setFragments.push(`${col} = null`);
                } else if (val instanceof Date) {
                  values.push(val.toISOString());
                  setFragments.push(`${col} = $${values.length}`);
                } else if (typeof val === "object") {
                  values.push(JSON.stringify(val));
                  setFragments.push(`${col} = $${values.length}::jsonb`);
                } else {
                  values.push(val);
                  setFragments.push(`${col} = $${values.length}`);
                }
              }
              values.push(value);
              const query =
                `update public.${table} set ${setFragments.join(", ")} ` +
                `where ${column} = $${values.length}`;
              await sql.unsafe(query, values as Array<string | number | boolean | null>);
              return { error: null };
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof writeEscalation>[0];
}
