/**
 * JOB-284. The upgrade cards render both paid plans, and each card's CTA
 * posts to the checkout route with the right slug.
 *
 * Free is deliberately not on this component: anyone on the dashboard has
 * it already. That absence is worth its own case because "quietly stopped
 * rendering" is exactly the failure mode a filter over the shared catalog
 * would surface as, and rendering three cards on a dashboard would look
 * fine right up until somebody clicked "Start free" on an account that
 * has been free for weeks.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UpgradeCards } from "@/app/dashboard/upgrade-cards";
import { DASHBOARD_UPGRADE_PLANS, LANDING_PLANS } from "@/lib/pricing";

describe("the dashboard upgrade cards", () => {
  it("renders both paid plans with their price, allowance and CTA copy", () => {
    const { container } = render(<UpgradeCards />);

    const starterCard = container.querySelector('[data-plan="starter"]');
    expect(starterCard).not.toBeNull();
    const starter = within(starterCard as HTMLElement);
    expect(
      starter.getByRole("heading", { level: 3, name: "Starter" }),
    ).toBeInTheDocument();
    expect(starter.getByText("$9")).toBeInTheDocument();
    expect(starter.getByText("per month")).toBeInTheDocument();
    expect(
      starter.getByText("150 applications every month"),
    ).toBeInTheDocument();
    expect(
      starter.getByRole("button", { name: "Get Starter" }),
    ).toBeInTheDocument();

    const seasonCard = container.querySelector('[data-plan="season_pass"]');
    expect(seasonCard).not.toBeNull();
    const season = within(seasonCard as HTMLElement);
    expect(
      season.getByRole("heading", { level: 3, name: "Season Pass" }),
    ).toBeInTheDocument();
    expect(season.getByText("$29")).toBeInTheDocument();
    expect(season.getByText("one time")).toBeInTheDocument();
    expect(
      season.getByText("500 applications, valid 6 months"),
    ).toBeInTheDocument();
    expect(
      season.getByRole("button", { name: "Get the Season Pass" }),
    ).toBeInTheDocument();
  });

  it("wraps each CTA in a real POST form pointed at the checkout route", () => {
    const { container } = render(<UpgradeCards />);

    const forms = container.querySelectorAll("form");
    expect(forms).toHaveLength(2);

    const submittedPlans = Array.from(forms).map((form) => {
      expect(form.getAttribute("action")).toBe("/api/billing/checkout");
      // A form default is GET, and the checkout route deletes its GET
      // handler on purpose (see the route file's header). Anything but a
      // literal POST here is a regression.
      expect(form.getAttribute("method")?.toLowerCase()).toBe("post");
      const planInput = form.querySelector(
        'input[type="hidden"][name="plan"]',
      );
      expect(planInput).not.toBeNull();
      return planInput?.getAttribute("value");
    });

    expect(submittedPlans).toEqual(["starter", "season_pass"]);
  });

  it("does not render the Free tier", () => {
    render(<UpgradeCards />);

    expect(
      screen.queryByRole("heading", { level: 3, name: "Free" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start free" }),
    ).not.toBeInTheDocument();
  });
});

describe("the shared pricing catalog", () => {
  it("exposes the three plans the landing page used to inline", () => {
    // The old inline literal on `app/page.tsx` had exactly these three
    // slugs in this order. An extraction that reordered or dropped one
    // would silently move the featured card on the landing page, so this
    // pins the shape at the boundary of the catalog itself rather than
    // asserting against the DOM of a page whose layout may change.
    expect(LANDING_PLANS.map((plan) => plan.slug)).toEqual([
      "free",
      "starter",
      "season_pass",
    ]);

    const featured = LANDING_PLANS.filter((plan) => plan.featured).map(
      (plan) => plan.slug,
    );
    expect(featured).toEqual(["starter"]);
  });

  it("filters the free tier out of the dashboard subset", () => {
    expect(DASHBOARD_UPGRADE_PLANS.map((plan) => plan.slug)).toEqual([
      "starter",
      "season_pass",
    ]);
  });
});
