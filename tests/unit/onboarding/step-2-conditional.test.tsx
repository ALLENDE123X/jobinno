/**
 * JOB-308 round two BLOCKING 1 UI test.
 *
 * The two Yes/No inputs for workAuthorizedUs and requiresSponsorship are
 * NOT rendered when citizenship is US citizen or permanent resident (the
 * server auto-derives those two). They ARE rendered when citizenship is
 * F1, H1B or Other, and the F1 case is exercised here as the canonical
 * one, because an F1 not yet on OPT should be able to answer
 * workAuthorizedUs=false without having a true silently fabricated.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/app/onboarding/actions", () => ({
  saveIntakeDraft: vi.fn(async () => ({ ok: true })),
}));

const { Step2Form } = await import("@/app/onboarding/step/step-2");

function baseProfile() {
  return {
    citizenship_status: null,
    f1_status: null,
    visa_status: null,
    work_authorized_us: null,
    requires_sponsorship: null,
  };
}

describe("Step2Form work authorization inputs", () => {
  it("does not render the two Yes/No inputs for a US citizen", () => {
    render(<Step2Form profile={{ ...baseProfile(), citizenship_status: "us_citizen" }} />);

    expect(
      screen.queryByText(/Are you authorized to work in the US/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Will you need visa sponsorship/i),
    ).not.toBeInTheDocument();
  });

  it("does not render the two Yes/No inputs for a permanent resident", () => {
    render(
      <Step2Form
        profile={{ ...baseProfile(), citizenship_status: "permanent_resident" }}
      />,
    );

    expect(
      screen.queryByText(/Are you authorized to work in the US/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Will you need visa sponsorship/i),
    ).not.toBeInTheDocument();
  });

  it("renders the two Yes/No inputs for an F1 student", () => {
    render(<Step2Form profile={{ ...baseProfile(), citizenship_status: "f1" }} />);

    expect(
      screen.getByText(/Are you authorized to work in the US/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Will you need visa sponsorship/i),
    ).toBeInTheDocument();
  });

  it("renders the two Yes/No inputs for an H1B holder", () => {
    render(<Step2Form profile={{ ...baseProfile(), citizenship_status: "h1b" }} />);

    expect(
      screen.getByText(/Are you authorized to work in the US/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Will you need visa sponsorship/i),
    ).toBeInTheDocument();
  });

  it("renders the two Yes/No inputs when citizenship is Other", () => {
    render(<Step2Form profile={{ ...baseProfile(), citizenship_status: "other" }} />);

    expect(
      screen.getByText(/Are you authorized to work in the US/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Will you need visa sponsorship/i),
    ).toBeInTheDocument();
  });
});
