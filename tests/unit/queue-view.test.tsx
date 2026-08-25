/**
 * v1-D. What a person actually sees on the queue view: two columns with the
 * right things in the right one, an empty state that reads as a sentence, and
 * an escalation form that talks to the resume endpoint and moves its row
 * across on success.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { QueueClient } = await import("@/app/dashboard/queue/queue-client");
import type { ApplicationQueue } from "@/lib/dashboard/queue-data";

function withRows(): ApplicationQueue {
  return {
    applied: [
      {
        id: "app-applied-1",
        company: "Acme Corp",
        title: "Software Engineer Intern",
        location: "San Francisco, CA",
        url: "https://example.com/jobs/1",
        status: "submitted",
        submittedAt: "2026-08-20T10:00:00.000Z",
        confirmationText: "Reference APP-4417.",
      },
      {
        id: "app-applied-2",
        company: "Initech",
        title: "New Grad SWE",
        location: null,
        url: null,
        status: "submission_unconfirmed",
        submittedAt: "2026-08-19T10:00:00.000Z",
        confirmationText: null,
      },
    ],
    pending: [
      {
        id: "app-pending-1",
        company: "Globex Industries",
        title: "New Grad Software Engineer",
        location: "Remote (US)",
        url: "https://example.com/jobs/2",
        escalationCreatedAt: "2026-08-24T09:00:00.000Z",
        escalationQuestions: [
          {
            // v1-BLOCKER-2 (#152): camelCase everywhere.
            fieldKey: "work_auth",
            fieldLabel: "Are you authorized to work in the US?",
            question: "Are you authorized to work in the US?",
            options: ["Yes", "No"],
            required: true,
            topicSlug: "work_auth_current_us",
          },
          {
            fieldKey: "referral",
            fieldLabel: "How did you hear about us?",
            question: "How did you hear about us?",
            options: null,
            required: false,
            topicSlug: null,
          },
        ],
      },
    ],
  };
}

const originalFetch = global.fetch;

// Real timers, not fake: the escalation form's submit path awaits `fetch`,
// which itself sits on top of real timers, so a faked one deadlocks. The
// 30 second poll interval is left alone; each test finishes before it fires.

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("the queue view", () => {
  it("renders the empty state when there is nothing on either side", () => {
    render(<QueueClient initial={{ applied: [], pending: [] }} />);
    expect(screen.getByText(/queue is empty/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /applied/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /pending your input/i })).not.toBeInTheDocument();
  });

  it("shows both sections with the right rows when both sides are populated", () => {
    render(<QueueClient initial={withRows()} />);
    expect(screen.getByRole("heading", { name: /^applied$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /pending your input/i })).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("Globex Industries")).toBeInTheDocument();
    expect(screen.getByText(/Reference APP-4417/)).toBeInTheDocument();
    expect(screen.getByText("submitted")).toBeInTheDocument();
    expect(screen.getByText("unconfirmed")).toBeInTheDocument();
  });

  it("hides the applied section when nothing has been applied yet", () => {
    render(
      <QueueClient
        initial={{
          applied: [],
          pending: withRows().pending,
        }}
      />
    );
    expect(screen.queryByRole("heading", { name: /^applied$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /pending your input/i })).toBeInTheDocument();
  });

  it("submits an escalation and optimistically moves the row across", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(JSON.stringify({ ok: true, status: "discovered" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = fetchMock as any;

    render(<QueueClient initial={withRows()} />);

    const pendingSection = screen.getByRole("heading", { name: /pending your input/i })
      .closest("section")!;

    // Answer both questions.
    const yesRadio = within(pendingSection).getByLabelText("Yes");
    fireEvent.click(yesRadio);

    const textarea = within(pendingSection).getByPlaceholderText("Your answer");
    fireEvent.change(textarea, { target: { value: "LinkedIn" } });

    const submit = within(pendingSection).getByRole("button", { name: /send answers/i });
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/applications/app-pending-1/escalation-answers");
    expect(init?.method).toBe("PUT");
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.answers).toHaveLength(2);
    expect(body.answers[0]).toMatchObject({
      topicSlug: "work_auth_current_us",
      question: "Are you authorized to work in the US?",
      answer: "Yes",
    });
    expect(body.answers[1]).toMatchObject({
      topicSlug: null,
      question: "How did you hear about us?",
      answer: "LinkedIn",
    });

    // Row moves out of pending optimistically. Empty sections unmount, so
    // the "Pending your input" heading is gone; the placeholder shows in the
    // Applied column.
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: /pending your input/i })
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText(/resuming your application/i)).toBeInTheDocument();
  });

  it("reports a failed submit and keeps the row on the pending side", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Something went wrong." }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = fetchMock as any;

    render(<QueueClient initial={withRows()} />);

    const pendingSection = screen.getByRole("heading", { name: /pending your input/i })
      .closest("section")!;
    fireEvent.click(within(pendingSection).getByLabelText("Yes"));
    fireEvent.change(within(pendingSection).getByPlaceholderText("Your answer"), {
      target: { value: "LinkedIn" },
    });
    fireEvent.click(within(pendingSection).getByRole("button", { name: /send answers/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/something went wrong/i)
    );
    expect(screen.getByRole("heading", { name: /pending your input/i })).toBeInTheDocument();
  });
});
