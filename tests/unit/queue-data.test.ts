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
            // v1-BLOCKER-2 (#152) shape: what writeEscalation actually persists.
            fieldKey: "work_auth",
            fieldLabel: "Are you authorized to work in the US?",
            question: "Are you authorized to work in the US?",
            options: ["Yes", "No"],
            required: true,
            topicSlug: "work_auth_current_us",
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
      question: "Are you authorized to work in the US?",
      topicSlug: "work_auth_current_us",
      options: ["Yes", "No"],
      required: true,
      fieldKey: "work_auth",
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
          // Missing fieldKey — dropped.
          { question: "How did you hear about us?" },
          // Missing question text — dropped.
          { fieldKey: "no-text-here" },
          null,
          "not an object",
          // Well formed.
          {
            fieldKey: "referral",
            question: "How did you hear about us?",
          },
          // Well formed with options.
          {
            fieldKey: "sponsorship",
            question: "Do you require sponsorship?",
            options: ["Yes", "No", 42],
            topicSlug: "requires_visa_sponsorship",
            required: true,
          },
        ],
      }),
    ];

    const queue = await readApplicationQueue(fakeClient(), ME);
    const questions = queue.pending[0].escalationQuestions;
    expect(questions.map((q) => q.question)).toEqual([
      "How did you hear about us?",
      "Do you require sponsorship?",
    ]);
    // The `42` gets dropped because it is not a string.
    expect(questions[1].options).toEqual(["Yes", "No"]);
    expect(questions[1].required).toBe(true);
    // fieldLabel falls back to fieldKey when the writer left it out.
    expect(questions[0].fieldLabel).toBe("referral");
  });

  // v1-BLOCKER-2 (#152) regression: the reader surfaces every row
  // `writeEscalation` writes. Rather than hand-write a JSONB fixture we call
  // the writer through the same shim the live-DB integration test uses.
  it("surfaces the questions in the shape writeEscalation actually produces", async () => {
    const { writeEscalation } = await import("@/lib/application-records");

    // Build the JSONB payload the way writeEscalation does — the fake client
    // captures the update, then we drop the payload straight into the fixture
    // so the reader consumes what the writer produced, byte for byte.
    let captured: unknown = null;
    const captureClient = {
      from(_table: string) {
        void _table;
        return {
          update(payload: Record<string, unknown>) {
            captured = payload.escalation_questions;
            return {
              async eq() {
                return { error: null };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof writeEscalation>[0];

    await writeEscalation(
      captureClient,
      "any-id",
      [
        {
          fieldKey: "work_auth",
          fieldLabel: "Are you authorized to work in the United States?",
          question: "Are you authorized to work in the United States?",
          options: ["Yes", "No"],
          required: true,
          topicSlug: "work_auth_current_us",
        },
        {
          fieldKey: "referral_source",
          fieldLabel: "How did you hear about us?",
          question: "How did you hear about us?",
          options: null,
          required: false,
          topicSlug: null,
        },
      ],
      { now: new Date("2026-08-25T00:00:00Z") }
    );

    tables.applications = [
      row({
        id: "mine-writer-shape",
        status: PENDING_STATUS,
        escalation_created_at: "2026-08-25T00:00:00.000Z",
        escalation_questions: captured,
      }),
    ];

    const queue = await readApplicationQueue(fakeClient(), ME);
    const pending = queue.pending[0];
    expect(pending.escalationQuestions).toHaveLength(2);
    expect(pending.escalationQuestions[0]).toMatchObject({
      fieldKey: "work_auth",
      question: "Are you authorized to work in the United States?",
      topicSlug: "work_auth_current_us",
      options: ["Yes", "No"],
      required: true,
    });
    expect(pending.escalationQuestions[1]).toMatchObject({
      fieldKey: "referral_source",
      question: "How did you hear about us?",
      topicSlug: null,
      options: null,
      required: false,
    });
  });
});
