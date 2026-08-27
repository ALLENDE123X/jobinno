/**
 * JOB-228 — what a person sees on `/settings/gmail`, both states.
 *
 * `GmailSettingsView` renders `DisconnectGmailButton` in its connected
 * branch, which calls `useRouter()` unconditionally on mount, so rendering
 * this view at all needs a mocked app router, the same reason
 * tests/unit/dashboard-view.test.tsx mocks `next/navigation` for
 * `SignOutButton`.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import { GmailSettingsView } from "@/app/settings/gmail/gmail-settings-view";

describe("GmailSettingsView", () => {
  it("shows a Connect Gmail button and a link to the privacy policy when not connected", () => {
    render(<GmailSettingsView connected={false} />);

    expect(screen.getByRole("link", { name: "Connect Gmail" })).toHaveAttribute(
      "href",
      "/api/auth/gmail/start"
    );
    expect(screen.getByRole("link", { name: "privacy policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.queryByRole("button", { name: /disconnect gmail/i })).not.toBeInTheDocument();
  });

  it("shows the connected state with a disconnect button and the Google permissions link when connected", () => {
    render(<GmailSettingsView connected={true} />);

    expect(screen.getByText(/gmail account is connected/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect Gmail" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review access on Google" })).toHaveAttribute(
      "href",
      "https://myaccount.google.com/permissions"
    );
    expect(screen.queryByRole("link", { name: "Connect Gmail" })).not.toBeInTheDocument();
  });
});
