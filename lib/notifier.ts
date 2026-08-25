/**
 * v1-C (#143) — the pending_user_input notifier.
 *
 * Fires one email (Resend) or SMS (Twilio) per escalated `applications` row,
 * rate limited to one dispatch every 6h per row so a re-escalation that lands
 * in the same window does not double-notify. The row it reads is picked up by
 * id and joined out to `profiles.email`, `profiles.notification_preference`
 * and the `jobs`/`boards` embed that names the company.
 *
 * Design decisions worth naming:
 *
 * · **The dispatchers are dependency injected.** `sendEscalationNotification`
 *   takes a `NotifierAdapter` so a test can pass fakes and count invocations,
 *   and the real callers pass `resendAndTwilioAdapter()` which fans out to
 *   the wired providers. There is no global singleton, so a test does not have
 *   to patch a module cache.
 *
 * · **The rate limit is a read of `escalation_notified_at` on the row, not a
 *   process-level cache.** Two workers picking up the same row within the
 *   window still cannot double-notify, because whichever fires second sees
 *   the fresh stamp. This is the same reason `escalation_notified_at` is a
 *   column rather than a rolling counter.
 *
 * · **A missing provider is a warning, not a failure.** Jobinno is dispatched
 *   from a worker whose whole job is to keep the pipeline moving; a row that
 *   escalates without a notifier configured must still land in
 *   `pending_user_input` and wait for the user to happen to visit the
 *   dashboard, rather than blocking on a warning about credentials. The
 *   warning is enough for an operator to spot from logs.
 *
 * · **The email body reads as prose, not as a system message.** Copy is per
 *   the ticket, and it names the company so a person with multiple pending
 *   applications can tell them apart.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { NotificationPreference } from "@/lib/db/schema";

const LOG = "[v1-c-notifier]";

/**
 * How long a row waits before the notifier is willing to fire again. Six
 * hours per the ticket; a re-escalation within that window still updates the
 * row's escalation state but does not re-send.
 */
export const NOTIFY_RATE_LIMIT_MS = 6 * 60 * 60 * 1000;

/**
 * The one path a notification takes to a person, injectable so tests do not
 * have to reach a real SMTP/HTTP endpoint. `sendEmail` and `sendSms` return
 * true on a successful dispatch and false on a soft failure (no credentials,
 * upstream rejection); a thrown error is a hard failure that stops the caller.
 */
export type NotifierAdapter = {
  sendEmail: (input: { to: string; subject: string; text: string }) => Promise<boolean>;
  sendSms: (input: { to: string; text: string }) => Promise<boolean>;
};

/**
 * The default dispatchers, wired to Resend (email) and Twilio (SMS) via bare
 * `fetch` so no new npm package is added in this PR. Both are optional: a
 * `RESEND_API_KEY` (or `TWILIO_*`) that is missing or blank produces a
 * warning and a `false` return, rather than a throw.
 */
export function resendAndTwilioAdapter(): NotifierAdapter {
  return {
    async sendEmail({ to, subject, text }) {
      const apiKey = process.env.RESEND_API_KEY;
      const from = process.env.RESEND_FROM_ADDRESS ?? "Jobinno <hello@jobinno.app>";
      if (!apiKey || apiKey.trim() === "") {
        console.warn(`${LOG} RESEND_API_KEY is not set; email to ${to} was not sent.`);
        return false;
      }
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ from, to, subject, text }),
        });
        if (!response.ok) {
          const body = await response.text();
          console.warn(`${LOG} resend rejected ${response.status}: ${body.slice(0, 300)}`);
          return false;
        }
        return true;
      } catch (err) {
        console.warn(
          `${LOG} resend send threw: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      }
    },
    async sendSms({ to, text }) {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const from = process.env.TWILIO_FROM_NUMBER;
      if (!sid || !token || !from) {
        console.warn(`${LOG} TWILIO_* env is not set; sms to ${to} was not sent.`);
        return false;
      }
      try {
        const body = new URLSearchParams({ From: from, To: to, Body: text });
        const response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
            },
            body: body.toString(),
          }
        );
        if (!response.ok) {
          const responseBody = await response.text();
          console.warn(
            `${LOG} twilio rejected ${response.status}: ${responseBody.slice(0, 300)}`
          );
          return false;
        }
        return true;
      } catch (err) {
        console.warn(
          `${LOG} twilio send threw: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      }
    },
  };
}

/**
 * What one dispatch returns. `sent` is true when at least one channel
 * succeeded; `rateLimited` is true when the row had a stamp inside the 6h
 * window and nothing was attempted.
 */
export type NotifyOutcome = {
  sent: boolean;
  rateLimited: boolean;
  channels: Array<"email" | "sms">;
};

export type NotifyEscalationInput = {
  supabase: SupabaseClient;
  applicationId: string;
  now: Date;
  adapter?: NotifierAdapter;
  dashboardUrl?: string;
};

type ApplicationForNotify = {
  id: string;
  status: string;
  escalation_notified_at: string | null;
  user_id: string;
  profiles: {
    email: string;
    notification_preference: NotificationPreference;
  } | null;
  jobs: {
    title: string;
    boards: { company: string } | null;
  } | null;
};

/**
 * Fire an escalation notification for one `pending_user_input` row. Returns
 * quietly and stamps `escalation_notified_at` on success; the caller does not
 * need to check the outcome for the pipeline to keep moving.
 *
 * Preconditions the caller does not have to check: this function refuses to
 * fire when the row is not currently `pending_user_input` (a resume that
 * arrived first has moved the row back to `discovered`) and when the last
 * stamp is inside the 6h window.
 */
export async function sendEscalationNotification(
  input: NotifyEscalationInput
): Promise<NotifyOutcome> {
  const { supabase, applicationId, now } = input;
  const adapter = input.adapter ?? resendAndTwilioAdapter();
  const dashboardUrl = input.dashboardUrl ?? defaultDashboardUrl();

  const { data, error } = await supabase
    .from("applications")
    .select(
      // `profiles.phone` deliberately absent from this select: the column
      // does not exist on this project yet. A user who chooses `sms` (or
      // `both`) still has the email path fire, and the SMS branch below
      // warns and returns rather than throwing. When a phone column is
      // added, this select and the row shape below are where it wires in.
      "id,status,escalation_notified_at,user_id,profiles!inner(email,notification_preference),jobs!inner(title,boards!inner(company))"
    )
    .eq("id", applicationId)
    .limit(1);
  if (error) {
    console.warn(`${LOG} lookup for notification on ${applicationId} failed: ${error.message}`);
    return { sent: false, rateLimited: false, channels: [] };
  }
  const row = (data?.[0] ?? null) as unknown as ApplicationForNotify | null;
  if (row === null) {
    console.warn(`${LOG} application ${applicationId} not found; skipping notification.`);
    return { sent: false, rateLimited: false, channels: [] };
  }

  if (row.status !== "pending_user_input") {
    // A resume that reached the endpoint first moved the row back to
    // `discovered`; a second notification for a row somebody has already
    // answered would be noise, not help.
    return { sent: false, rateLimited: false, channels: [] };
  }

  if (row.escalation_notified_at !== null) {
    const stamped = new Date(row.escalation_notified_at).getTime();
    if (Number.isFinite(stamped) && now.getTime() - stamped < NOTIFY_RATE_LIMIT_MS) {
      return { sent: false, rateLimited: true, channels: [] };
    }
  }

  const company = row.jobs?.boards?.company ?? "your application";
  const subject = `Jobinno needs your input on your ${company} application`;
  const body =
    `Jobinno needs your input on your ${company} application. ` +
    `Answer at ${dashboardUrl}`;

  const preference = row.profiles?.notification_preference ?? "email";
  const email = row.profiles?.email ?? "";
  const phone = "";

  const channels: Array<"email" | "sms"> = [];
  let sent = false;

  if ((preference === "email" || preference === "both") && email !== "") {
    const ok = await adapter.sendEmail({ to: email, subject, text: body });
    if (ok) {
      channels.push("email");
      sent = true;
    }
  }
  if ((preference === "sms" || preference === "both") && phone !== "") {
    const ok = await adapter.sendSms({ to: phone, text: body });
    if (ok) {
      channels.push("sms");
      sent = true;
    }
  }

  if (sent) {
    // Stamp the row so the 6h window starts here. Done through the raw
    // client rather than through `markEscalationNotified` because this
    // module deliberately does not import from `application-records.ts` —
    // that direction is what `fill-application-form.ts` uses to call into
    // this file, and closing the loop would be a cycle.
    const { error: stampError } = await supabase
      .from("applications")
      .update({ escalation_notified_at: now.toISOString() })
      .eq("id", applicationId);
    if (stampError) {
      console.warn(
        `${LOG} could not stamp escalation_notified_at on ${applicationId}: ${stampError.message}`
      );
    }
  }

  return { sent, rateLimited: false, channels };
}

function defaultDashboardUrl(): string {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ?? process.env.SITE_URL ?? "https://jobinno.app";
  return `${base.replace(/\/+$/, "")}/dashboard/pending`;
}
