/**
 * JOB-009. What a person actually sees on the page.
 *
 * ── Why render the whole view and not just the mapping ──────────────────────
 * `tests/unit/dashboard-plain-language.test.ts` proves every status and every
 * skip reason has wording. That is a fact about a lookup table, and it stays
 * true even if the page renders `application.status` directly and never calls
 * the lookup at all. This suite is the other half: it renders the real view
 * with real rows and asserts that no internal vocabulary reached the screen.
 *
 * The server action behind the button is mocked out. Importing it for real
 * pulls the Inngest pipeline and Stagehand into a jsdom worker, which is the
 * wall `tests/unit/job-search-trigger.test.ts` documents, and nothing here is
 * about what the button does. What it does is tested in
 * `tests/unit/dashboard-find-jobs-action.test.ts`.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/actions", () => ({
  findJobsNow: async () => ({ ok: true as const }),
}));

// `DashboardView` renders inside `PageShell`, which always includes
// `SignOutButton`. That button calls `useRouter()` unconditionally, on every
// render, before it ever checks whether there is a session to sign out of, so
// rendering this view at all needs a mounted app router regardless of what
// this suite is actually asserting on.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// `SignOutButton` also opens a real Supabase browser client on mount to ask
// whether anyone is signed in, which throws in this environment because
// `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are not set for a
// plain test run. Stubbed to "nobody is signed in" for the same reason
// `@/app/dashboard/actions` above is stubbed: this suite is about what a
// person sees on the dashboard itself, not about the sign out control in the
// shared shell around it.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
  }),
}));

const { DashboardView } = await import("@/app/dashboard/dashboard-view");
const { toQuota } = await import("@/lib/dashboard/dashboard-data");
const { APPLICATION_STATUS } = await import("@/lib/application-status");

type Row = Parameters<typeof DashboardView>[0]["applications"][number];

function row(overrides: Partial<Row>): Row {
  return {
    id: "application-1",
    status: APPLICATION_STATUS.SUBMITTED,
    company: "Acme",
    title: "Software Engineer Intern",
    url: "https://boards.example.com/1",
    submittedAt: "2026-08-01T10:00:00.000Z",
    confirmationText: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    skipReason: null,
    ...overrides,
  };
}

describe("the dashboard view", () => {
  it("puts a company, a title, a plain status and a date on a submitted row", () => {
    render(
      <DashboardView
        email="me@example.com"
        quota={toQuota(1, 150)}
        applications={[row({ confirmationText: "Reference GH-4417" })]}
      />
    );

    const listed = screen.getByRole("listitem");
    expect(within(listed).getByText("Software Engineer Intern")).toBeInTheDocument();
    expect(within(listed).getByText("Acme")).toBeInTheDocument();
    expect(within(listed).getByText("sent")).toBeInTheDocument();
    expect(within(listed).getByText(/Sent Aug 1, 2026/)).toBeInTheDocument();
    expect(within(listed).getByText(/Reference GH-4417/)).toBeInTheDocument();
  });

  it("explains a blocked row in words, not in reason codes", () => {
    render(
      <DashboardView
        email="me@example.com"
        quota={toQuota(1, 150)}
        applications={[
          row({
            id: "blocked",
            status: APPLICATION_STATUS.FORM_FILL_BLOCKED,
            submittedAt: null,
            skipReason: "unanswerable_required",
          }),
        ]}
      />
    );

    expect(screen.getByText("needs your attention")).toBeInTheDocument();
    expect(screen.getByText(/required field we could not fill in/)).toBeInTheDocument();
    expect(screen.getByText(/Not sent yet/)).toBeInTheDocument();
  });

  it("renders no internal vocabulary anywhere on the page", () => {
    // One row per status, each carrying a skip reason, which is every code this
    // page can be asked to render at once.
    const applications = Object.values(APPLICATION_STATUS).map((status, index) =>
      row({ id: `row-${index}`, status, skipReason: "dom_changed" })
    );

    const { container } = render(
      <DashboardView
        email="me@example.com"
        quota={toQuota(13, 150)}
        applications={applications}
      />
    );

    const text = container.textContent ?? "";
    for (const status of Object.values(APPLICATION_STATUS)) {
      expect([status, text.includes(status)]).toEqual([status, false]);
    }
    expect(text).not.toContain("dom_changed");
  });

  it("says something encouraging rather than nothing when there is no history", () => {
    render(<DashboardView email="me@example.com" quota={toQuota(0, 150)} applications={[]} />);

    expect(screen.getByText("No applications yet")).toBeInTheDocument();
    expect(screen.getByText(/Press find jobs now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find jobs now" })).toBeEnabled();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("stops offering a search to somebody with nothing left to spend", () => {
    // The honest version of the cap. A button that is present, pressable and
    // quietly refused on the server is the outcome this is here to prevent.
    render(<DashboardView email="me@example.com" quota={toQuota(150, 150)} applications={[]} />);

    expect(screen.getByRole("button", { name: "Find jobs now" })).toBeDisabled();
    expect(screen.getByText(/used every application on your plan/)).toBeInTheDocument();
    expect(screen.getByText("Nothing applied for yet")).toBeInTheDocument();
  });

  it("stops offering another search while the one just started is still running", async () => {
    // The anti spam property, and it is UX rather than correctness: JOB-008's
    // concurrency guard already makes a second press safe. What it does not fix
    // is a button that snaps back to its resting state while a search that
    // shows nothing for minutes is under way, which reads as a button that did
    // nothing and invites another press.
    render(<DashboardView email="me@example.com" quota={toQuota(0, 150)} applications={[]} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Find jobs now" }));
    });

    const button = screen.getByRole("button", { name: "Search running" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/You can start another search in \d+ seconds/)).toBeInTheDocument();
  });

  it("tells an unprovisioned account to pick a plan rather than that it is full", () => {
    render(<DashboardView email="me@example.com" quota={toQuota(0, 0)} applications={[]} />);

    expect(screen.getByRole("button", { name: "Find jobs now" })).toBeDisabled();
    expect(screen.getByText(/Choose a plan and this button starts your first search/)).toBeInTheDocument();
  });
});
