// @vitest-environment node
/**
 * v1-C (#143). The pending_user_input notifier: rate limit, channel routing,
 * and the `escalation_notified_at` stamp.
 *
 * A fake Supabase client answers the row lookup and records the update, and
 * a fake `NotifierAdapter` counts the dispatches. Nothing here reaches Resend
 * or Twilio.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  NOTIFY_RATE_LIMIT_MS,
  sendEscalationNotification,
  type NotifierAdapter,
} from "@/lib/notifier";

const APPLICATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type FakeRow = {
  id: string;
  status: string;
  escalation_notified_at: string | null;
  user_id: string;
  profiles: { email: string; notification_preference: "email" | "sms" | "both" };
  jobs: { title: string; boards: { company: string } };
};

let rowStore: FakeRow;
let updateCalls: Array<Record<string, unknown>> = [];

function fakeSupabase() {
  return {
    from() {
      const chain: Record<string, unknown> = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        limit() {
          return Promise.resolve({ data: [rowStore], error: null });
        },
        update(payload: Record<string, unknown>) {
          updateCalls.push(payload);
          return {
            eq: async () => ({ error: null }),
          };
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof sendEscalationNotification>[0]["supabase"];
}

function makeAdapter(): NotifierAdapter & {
  emails: Array<{ to: string; subject: string; text: string }>;
  smses: Array<{ to: string; text: string }>;
} {
  const emails: Array<{ to: string; subject: string; text: string }> = [];
  const smses: Array<{ to: string; text: string }> = [];
  return {
    emails,
    smses,
    async sendEmail(input) {
      emails.push(input);
      return true;
    },
    async sendSms(input) {
      smses.push(input);
      return true;
    },
  };
}

beforeEach(() => {
  updateCalls = [];
  rowStore = {
    id: APPLICATION_ID,
    status: "pending_user_input",
    escalation_notified_at: null,
    user_id: USER_ID,
    profiles: { email: "candidate@example.com", notification_preference: "email" },
    jobs: { title: "Software Engineer, Intern", boards: { company: "Acme Robotics" } },
  };
});

describe("sendEscalationNotification", () => {
  it("emails the candidate, stamps escalation_notified_at, names the company", async () => {
    const adapter = makeAdapter();
    const now = new Date("2026-08-25T12:00:00Z");
    const outcome = await sendEscalationNotification({
      supabase: fakeSupabase(),
      applicationId: APPLICATION_ID,
      now,
      adapter,
      dashboardUrl: "https://jobinno.app/dashboard/pending",
    });

    expect(outcome.sent).toBe(true);
    expect(outcome.channels).toEqual(["email"]);
    expect(adapter.emails).toHaveLength(1);
    expect(adapter.emails[0]!.to).toBe("candidate@example.com");
    expect(adapter.emails[0]!.subject).toContain("Acme Robotics");
    expect(adapter.emails[0]!.text).toContain(
      "https://jobinno.app/dashboard/pending"
    );
    expect(adapter.smses).toHaveLength(0);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.escalation_notified_at).toBe(now.toISOString());
  });

  it("refuses to fire when the row has already been notified inside the 6h window", async () => {
    const stampedAt = new Date("2026-08-25T09:00:00Z");
    const now = new Date("2026-08-25T12:00:00Z");
    rowStore.escalation_notified_at = stampedAt.toISOString();

    const adapter = makeAdapter();
    const outcome = await sendEscalationNotification({
      supabase: fakeSupabase(),
      applicationId: APPLICATION_ID,
      now,
      adapter,
    });

    expect(outcome).toEqual({ sent: false, rateLimited: true, channels: [] });
    expect(adapter.emails).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("fires again once the 6h window has elapsed", async () => {
    const stampedAt = new Date("2026-08-25T05:00:00Z");
    // Just past the window.
    const now = new Date(stampedAt.getTime() + NOTIFY_RATE_LIMIT_MS + 60_000);
    rowStore.escalation_notified_at = stampedAt.toISOString();

    const adapter = makeAdapter();
    const outcome = await sendEscalationNotification({
      supabase: fakeSupabase(),
      applicationId: APPLICATION_ID,
      now,
      adapter,
    });

    expect(outcome.sent).toBe(true);
    expect(adapter.emails).toHaveLength(1);
  });

  it("does not fire when the row is no longer pending_user_input", async () => {
    rowStore.status = "discovered";

    const adapter = makeAdapter();
    const outcome = await sendEscalationNotification({
      supabase: fakeSupabase(),
      applicationId: APPLICATION_ID,
      now: new Date(),
      adapter,
    });

    expect(outcome).toEqual({ sent: false, rateLimited: false, channels: [] });
    expect(adapter.emails).toHaveLength(0);
  });

  it("routes to email only when preference is email even if adapter offers sms", async () => {
    rowStore.profiles.notification_preference = "email";
    const adapter = makeAdapter();
    await sendEscalationNotification({
      supabase: fakeSupabase(),
      applicationId: APPLICATION_ID,
      now: new Date(),
      adapter,
    });
    expect(adapter.emails).toHaveLength(1);
    expect(adapter.smses).toHaveLength(0);
  });
});
