/**
 * JOB-314: Save and finish later.
 *
 * StepFooter is the shared Back / Save and finish later / Next row used by
 * onboarding steps 1 through 4. The behavior under test is the whole point
 * of the ticket: Save and finish later must call saveIntakeDraft with
 * `{ partial: true }` and whatever draft payload the caller handed it,
 * completely regardless of whether that payload would pass the step's own
 * `Next` validation, then redirect to "/". It must never run client side
 * required field validation of its own, and a save failure must surface a
 * message rather than redirect.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const saveIntakeDraft = vi.fn();

vi.mock("@/app/onboarding/actions", () => ({
  saveIntakeDraft: (...args: unknown[]) => saveIntakeDraft(...args),
}));

const { StepFooter } = await import("@/app/onboarding/step/_shared");

beforeEach(() => {
  push.mockClear();
  saveIntakeDraft.mockReset();
});

describe("StepFooter", () => {
  it("renders Back only when backHref is given", () => {
    const { rerender } = render(
      <StepFooter step={2} draftPayload={{}} busy={false} />,
    );
    expect(
      screen.queryByRole("button", { name: "Back" }),
    ).not.toBeInTheDocument();

    rerender(
      <StepFooter
        step={2}
        draftPayload={{}}
        busy={false}
        backHref="/onboarding/step/1"
      />,
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("saves an incomplete draft without client side required field validation", async () => {
    saveIntakeDraft.mockResolvedValue({ ok: true });

    // A step 2 draft with everything blank: no citizenship, no visa status,
    // nothing. This is exactly the payload the strict step2Schema used by
    // `Next` would reject. Save and finish later must not reject it too,
    // and must pass it straight through to the server unchanged.
    const draftPayload = {
      citizenshipStatus: "",
      f1Status: null,
      visaStatus: "",
      workAuthorizedUs: null,
      requiresSponsorship: null,
    };

    render(<StepFooter step={2} draftPayload={draftPayload} busy={false} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Save and finish later" }),
    );

    await waitFor(() => {
      expect(saveIntakeDraft).toHaveBeenCalledWith(draftPayload, 2, {
        partial: true,
      });
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });

  it("redirects to the landing page on a successful save", async () => {
    saveIntakeDraft.mockResolvedValue({ ok: true });

    render(
      <StepFooter
        step={3}
        draftPayload={{ currentCity: "Atlanta" }}
        busy={false}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Save and finish later" }),
    );

    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });

  it("shows an error and does not redirect when the save fails", async () => {
    saveIntakeDraft.mockResolvedValue({
      ok: false,
      message:
        "Your session has expired. Sign in again and your files are still there.",
    });

    render(<StepFooter step={4} draftPayload={{}} busy={false} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Save and finish later" }),
    );

    expect(
      await screen.findByText(/Your session has expired/i),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("disables Back, Save and finish later, and Next while busy", () => {
    // `busy` here stands for the step's own Next submission in flight, not
    // a Save and finish later save; only the Next button's label reacts to
    // it. All three controls must still be disabled, because a Next submit
    // and a save-and-later click racing each other is exactly the kind of
    // double submit this component exists to prevent.
    render(
      <StepFooter
        step={2}
        draftPayload={{}}
        busy={true}
        backHref="/onboarding/step/1"
      />,
    );

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save and finish later" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving" })).toBeDisabled();
  });
});
