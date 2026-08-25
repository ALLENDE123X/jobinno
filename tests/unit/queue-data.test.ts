// @vitest-environment node
/**
 * v1-D. The queue view splits one person's applications into two lists and
 * nobody else's rows ever appear on either side. Same argument as
 * `dashboard-data.test.ts`: an assertion that the module emitted `eq("user_id",
 * ...)` does not by itself say the result was scoped, so the fake below applies
 * the filters it was handed to a fixture holding two people's rows.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  APPLIED_STATUSES,
  PENDING_STATUS,
  QUEUE_APPLICATION_LIMIT,
  QUEUE_SELECTS,
  readApplicationQueue,
} from "@/lib/dashboard/queue-data";

const ME = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SOMEBODY_ELSE = "9c858901-8a57-4791-81fe-4c455b099bc9";

type Call = {
  table: string;
  columns: string;
  filters: [string, unknown][];
  ins: [string, unknown[]][];
  orders: { column: string; ascending: boolean }[];
  limit: number | null;
};

const calls: Call[] = [];
const tables: Record<string, Record<string, unknown>[]> = {};

/**
 * A recording Supabase client that also honours `eq`, `in`, `order` and
 * `limit` against the fixture. `in` and a second `order` are what the queue
 * read uses that the dashboard read does not, so the fake here is a superset
 * of `dashboard-data.test.ts`'s.
 */
function fakeClient(): SupabaseClient {
  return {
    from(table: string) {
      const call: Call = { table, columns: "", filters: [], ins: [], orders: [], limit: null };
      calls.push(call);

      const matching = () => {
        let rows = tables[table] ?? [];
        for (const [col, value] of call.filters) {
          rows = rows.filter((r) => r[col] === value);
        }
        for (const [col, values] of call.ins) {
          const set = new Set(values);
          rows = rows.filter((r) => set.has(r[col] as unknown));
        }
        for (const order of [...call.orders].reverse()) {
          rows = [...rows].sort((a, b) => {
            const av = a[order.column] as unknown as string | null;
            const bv = b[order.column] as unknown as string | null;
            if (av === bv) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            const cmp = av < bv ? -1 : 1;
            return order.ascending ? cmp : -cmp;
          });
        }
        if (call.limit != null) rows = rows.slice(0, call.limit);
        return rows;
      };

      const chain: Record<string, unknown> = {
        select(columns: string) {
          call.columns = columns;
          return chain;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return chain;
        },
        in(column: string, values: unknown[]) {
          call.ins.push([column, values]);
          return chain;
        },
        order(column: string, options: { ascending: boolean }) {
          call.orders.push({ column, ascending: options.ascending });
          return chain;
        },
        limit(count: number) {
          call.limit = count;
          return chain;
        },
        then(resolve: (value: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: matching(), error: null }).then(resolve);
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    user_id: ME,
    status: "submitted",
    submitted_at: "2026-08-01T10:00:00.000Z",
    escalation_created_at: null,
    escalation_questions: null,
    confirmation_text: null,
    jobs: {
      title: "Software Engineer Intern",
      url: "https://boards.example.com/1",
      location: "San Francisco",
      boards: { company: "Acme" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(tables)) delete tables[key];
});

describe("the queue read", () => {
  it("splits submitted from pending, and never surfaces somebody else's rows", async () => {
    tables.applications = [
      row({ id: "mine-applied-1", status: "submitted" }),
      row({ id: "theirs-applied", user_id: SOMEBODY_ELSE, status: "submitted" }),
      row({
        id: "mine-pending-1",
        status: PENDING_STATUS,
        escalation_created_at: "2026-08-10T09:00:00.000Z",
        escalation_questions: [
          {
            question_text: "Are you authorized to work in the US?",
            question_options: ["Yes", "No"],
            topic_slug: "work_auth_current_us",
          },
        ],
      }),
      row({ id: "theirs-pending", user_id: SOMEBODY_ELSE, status: PENDING_STATUS }),
      row({ id: "mine-noise", status: "discovered" }),
      row({ id: "mine-unconfirmed", status: "submission_unconfirmed" }),
    ];

    const queue = await readApplicationQueue(fakeClient(), ME);

    expect(queue.applied.map((r) => r.id).sort()).toEqual(
      ["mine-applied-1", "mine-unconfirmed"].sort()
    );
    expect(queue.pending.map((r) => r.id)).toEqual(["mine-pending-1"]);
    expect(queue.pending[0].escalationQuestions[0]).toMatchObject({
      question_text: "Are you authorized to work in the US?",
      topic_slug: "work_auth_current_us",
      question_options: ["Yes", "No"],
    });
  });

  it("scopes both reads on user_id and on the expected statuses", async () => {
    tables.applications = [];
    await readApplicationQueue(fakeClient(), ME);

    // Two queries, one for each side.
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.table).toBe("applications");
      expect(c.filters.some(([col, v]) => col === "user_id" && v === ME)).toBe(true);
    }
    // Applied uses `in` over the two "sent" statuses; pending uses `eq`.
    const applied = calls.find((c) => c.ins.length > 0);
    const pending = calls.find((c) => c.ins.length === 0);
    expect(applied?.ins).toEqual([["status", [...APPLIED_STATUSES]]]);
    expect(pending?.filters).toContainEqual(["status", PENDING_STATUS]);
  });

  it("caps both reads to the plan's largest allowance", async () => {
    tables.applications = [];
    await readApplicationQueue(fakeClient(), ME);
    expect(calls[0].limit).toBe(QUEUE_APPLICATION_LIMIT);
    expect(calls[1].limit).toBe(QUEUE_APPLICATION_LIMIT);
  });

  it("orders applied by submitted_at desc and pending by escalation_created_at desc", async () => {
    tables.applications = [];
    await readApplicationQueue(fakeClient(), ME);

    const appliedCall = calls.find((c) => c.ins.length > 0)!;
    const pendingCall = calls.find((c) => c.ins.length === 0)!;
    expect(appliedCall.orders[0]).toEqual({ column: "submitted_at", ascending: false });
    expect(pendingCall.orders[0]).toEqual({
      column: "escalation_created_at",
      ascending: false,
    });
  });

  it("names the joined columns the page needs on each side", async () => {
    tables.applications = [];
    await readApplicationQueue(fakeClient(), ME);
    const cols = calls.map((c) => c.columns);
    expect(cols).toContain(QUEUE_SELECTS.applied);
    expect(cols).toContain(QUEUE_SELECTS.pending);
    expect(QUEUE_SELECTS.applied).toContain("jobs(title,url,location,boards(company))");
    expect(QUEUE_SELECTS.pending).toContain("escalation_questions");
  });

  it("drops malformed escalation entries and keeps well formed ones", async () => {
    tables.applications = [
      row({
        id: "mine",
        status: PENDING_STATUS,
        escalation_created_at: "2026-08-10T09:00:00.000Z",
        escalation_questions: [
          { question_text: "How did you hear about us?" },
          { field_key: "no-text-here" },
          null,
          "not an object",
          {
            question_text: "Do you require sponsorship?",
            question_options: ["Yes", "No", 42],
            topic_slug: "requires_visa_sponsorship",
          },
        ],
      }),
    ];

    const queue = await readApplicationQueue(fakeClient(), ME);
    const questions = queue.pending[0].escalationQuestions;
    expect(questions.map((q) => q.question_text)).toEqual([
      "How did you hear about us?",
      "Do you require sponsorship?",
    ]);
    // The `42` gets dropped because it is not a string.
    expect(questions[1].question_options).toEqual(["Yes", "No"]);
  });
});
