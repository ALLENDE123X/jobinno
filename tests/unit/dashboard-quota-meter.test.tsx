/**
 * JOB-009. The allowance renders honestly at every point on a plan.
 *
 * Three of the four cases here are the ones a person actually sees over the
 * life of a subscription: nothing used, part used, all used. The fourth is the
 * cap of zero, which is what every profile row starts at and what a person sees
 * before they have a plan at all. "0 of 0 applications used" would be a
 * technically accurate sentence that tells them nothing, so it is not the one
 * this component renders, and that is worth a test rather than a comment.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QuotaMeter } from "@/app/dashboard/quota-meter";
import { toQuota } from "@/lib/dashboard/dashboard-data";

describe("the quota meter", () => {
  it("shows a fresh plan as nothing used", () => {
    render(<QuotaMeter quota={toQuota(0, 150)} />);

    expect(screen.getByText("0 of 150 applications used")).toBeInTheDocument();
    expect(screen.getByText("150 left.")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("shows the middle of a plan as used against cap", () => {
    render(<QuotaMeter quota={toQuota(12, 150)} />);

    expect(screen.getByText("12 of 150 applications used")).toBeInTheDocument();
    expect(screen.getByText("138 left.")).toBeInTheDocument();

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuemax", "150");
  });

  it("says so plainly at the cap rather than offering more of nothing", () => {
    render(<QuotaMeter quota={toQuota(150, 150)} />);

    expect(screen.getByText("150 of 150 applications used")).toBeInTheDocument();
    expect(screen.queryByText("0 left.")).not.toBeInTheDocument();
    expect(screen.getByText(/That is everything on your plan/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add more applications" })).toBeInTheDocument();
  });

  it("reads an unprovisioned cap of zero as no plan rather than as a full one", () => {
    render(<QuotaMeter quota={toQuota(0, 0)} />);

    expect(screen.getByText("No applications on your plan yet")).toBeInTheDocument();
    expect(screen.queryByText("0 of 0 applications used")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See the plans" })).toBeInTheDocument();
  });
});
