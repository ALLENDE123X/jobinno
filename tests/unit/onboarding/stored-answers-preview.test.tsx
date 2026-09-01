/**
 * JOB-315 unit test for the step 5 "here is what we will say on your
 * behalf" preview.
 *
 * Covers the acceptance criteria from the ticket directly: the component
 * renders for a partially filled intake, a missing field renders the fixed
 * placeholder rather than any invented text (HARD STOP 9), and the panel is
 * collapsed until the user opens it. A second pass exercises a complete
 * profile so every one of the ten example answers can be checked against a
 * real stored value in the same run.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  MISSING_FIELD_PLACEHOLDER,
  StoredAnswersPreview,
  buildExampleAnswers,
  type StoredAnswersProfile,
} from "@/app/onboarding/step/stored-answers-preview";

function emptyProfile(): StoredAnswersProfile {
  return {
    email: null,
    github_url: null,
    current_city: null,
    visa_status: null,
    salary_expectation: null,
    work_authorized_us: null,
    requires_sponsorship: null,
  };
}

function partialProfile(): StoredAnswersProfile {
  return {
    ...emptyProfile(),
    email: "candidate@example.com",
    current_city: "Austin",
    work_authorized_us: true,
  };
}

function completeProfile(): StoredAnswersProfile {
  return {
    email: "candidate@example.com",
    github_url: "https://github.com/candidate",
    current_city: "Austin",
    visa_status: "H1B",
    salary_expectation: "$120,000",
    work_authorized_us: true,
    requires_sponsorship: false,
  };
}

describe("buildExampleAnswers", () => {
  it("always returns exactly ten example answers", () => {
    expect(buildExampleAnswers(emptyProfile())).toHaveLength(10);
    expect(buildExampleAnswers(completeProfile())).toHaveLength(10);
  });

  it("never invents a value for a field with nothing stored", () => {
    const answers = buildExampleAnswers(emptyProfile());

    for (const item of answers) {
      expect(item.answer).toBe(MISSING_FIELD_PLACEHOLDER);
    }
  });

  it("always shows the placeholder for full name, phone and LinkedIn URL", () => {
    // These three have no column on `profiles` yet, so a complete profile
    // still cannot answer them without inventing a value. See HARD STOP 9.
    const answers = buildExampleAnswers(completeProfile());
    const byQuestion = Object.fromEntries(
      answers.map((item) => [item.question, item.answer]),
    );

    expect(byQuestion["Full name"]).toBe(MISSING_FIELD_PLACEHOLDER);
    expect(byQuestion["Phone number"]).toBe(MISSING_FIELD_PLACEHOLDER);
    expect(byQuestion["LinkedIn profile URL"]).toBe(MISSING_FIELD_PLACEHOLDER);
  });

  it("renders the real stored value for every field that is filled in", () => {
    const answers = buildExampleAnswers(completeProfile());
    const byQuestion = Object.fromEntries(
      answers.map((item) => [item.question, item.answer]),
    );

    expect(byQuestion["Email address"]).toBe("candidate@example.com");
    expect(byQuestion["GitHub URL"]).toBe("https://github.com/candidate");
    expect(byQuestion["Current city"]).toBe("Austin");
    expect(byQuestion["Visa status"]).toBe("H1B");
    expect(byQuestion["Expected salary"]).toBe("$120,000");
    expect(
      byQuestion[
        "Are you legally authorized to work in the United States"
      ],
    ).toBe("Yes");
    expect(
      byQuestion[
        "Will you now or in the future require visa sponsorship to work in the United States"
      ],
    ).toBe("No");
  });

  it("contains no prose hyphens or em dashes in any question or answer", () => {
    const answers = buildExampleAnswers(completeProfile());

    for (const item of answers) {
      expect(item.question).not.toMatch(/[-—]/);
      expect(item.answer).not.toMatch(/—/);
    }
  });
});

describe("StoredAnswersPreview", () => {
  it("renders collapsed by default, for a partially filled intake", () => {
    render(<StoredAnswersPreview profile={partialProfile()} />);

    const toggle = screen.getByRole("button", {
      name: /See what we will say on your behalf \(10 example answers\)/i,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Email address")).not.toBeInTheDocument();
  });

  it("expands to show all ten example answers on click, with a placeholder for missing fields", () => {
    render(<StoredAnswersPreview profile={partialProfile()} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /See what we will say on your behalf \(10 example answers\)/i,
      }),
    );

    expect(screen.getByText("Email address")).toBeInTheDocument();
    expect(screen.getByText("candidate@example.com")).toBeInTheDocument();
    expect(screen.getByText("Full name")).toBeInTheDocument();
    expect(screen.getAllByText(MISSING_FIELD_PLACEHOLDER).length).toBeGreaterThan(0);
  });

  it("renders every example answer for a complete intake with no placeholders left over that should be filled", () => {
    render(<StoredAnswersPreview profile={completeProfile()} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /See what we will say on your behalf \(10 example answers\)/i,
      }),
    );

    expect(screen.getByText("$120,000")).toBeInTheDocument();
    expect(screen.getByText("H1B")).toBeInTheDocument();
    // Full name, phone and LinkedIn URL remain placeholders even on a
    // complete profile, since none of the three has a stored column yet.
    expect(screen.getAllByText(MISSING_FIELD_PLACEHOLDER)).toHaveLength(3);
  });
});
