/**
 * The pricing card catalog (JOB-284).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The landing page pricing section (`app/page.tsx#pricing`) and the dashboard
 * upgrade cards (`app/dashboard/upgrade-cards.tsx`) show the same three
 * plans, or a subset of them, with the same numbers and the same call to
 * action copy. Two inline copies of that catalog was the shape JOB-284 found:
 * changing "150 applications" on the landing page and forgetting the
 * dashboard was a live risk, and the person who wears the consequence of the
 * drift is somebody paying for one number and being shown another.
 *
 * So one array, imported by both surfaces. The Stripe slugs (`starter`,
 * `season_pass`) still come from `lib/billing/plans.ts` — this file only
 * owns the copy a person reads on a card.
 *
 * ── Why the display data is not on `lib/billing/plans.ts` ──────────────────
 * That module is the source of truth for what a plan costs, how many
 * applications it grants, and which Stripe price sells it. Anything a webhook
 * or the checkout route reads belongs there. This file is the display side:
 * feature bullets, cadence copy, CTA labels. Keeping them separate means the
 * webhook does not have to import a features array to run, and this file
 * does not have to import Stripe types to render.
 */

import {
  FREE_PLAN_APPLICATIONS_CAP,
  PAID_PLANS,
  type PlanSlug,
} from "@/lib/billing/plans";

/**
 * One card's worth of data.
 *
 * `slug` is the value posted to `/api/billing/checkout` for the paid ones,
 * and the sentinel `"free"` for the trial tier, which has no Stripe price.
 * `featured` is the "Most popular" ring on the landing page. Keeping it in
 * the catalog rather than on the component means the two surfaces cannot
 * disagree about which plan is highlighted.
 */
export interface PricingPlan {
  readonly slug: PlanSlug;
  readonly name: string;
  readonly price: string;
  readonly cadence: string;
  readonly allowance: string;
  readonly features: readonly string[];
  readonly cta: string;
  readonly featured: boolean;
}

/**
 * The full pricing lineup shown on the landing page, in the order they render.
 *
 * The two paid caps (150 and 500) are quoted from `PAID_PLANS` so that a
 * change to the applications cap in one place cannot leave a stale number on
 * a marketing page. The free cap is quoted from `FREE_PLAN_APPLICATIONS_CAP`
 * for the same reason.
 */
export const LANDING_PLANS: readonly PricingPlan[] = [
  {
    slug: "free",
    name: "Free",
    price: "$0",
    cadence: "to try it",
    allowance: `${FREE_PLAN_APPLICATIONS_CAP} applications, total`,
    features: [
      `${FREE_PLAN_APPLICATIONS_CAP} applications, once`,
      "Every supported ATS platform",
      "Full log of what was submitted",
    ],
    cta: "Start free",
    featured: false,
  },
  {
    slug: "starter",
    name: "Starter",
    price: "$29",
    cadence: "per month",
    allowance: `${PAID_PLANS.starter.applicationsCap} applications every month`,
    features: [
      `${PAID_PLANS.starter.applicationsCap} applications per month`,
      "Runs overnight, every night",
      "Full log of what was submitted",
      "Cancel whenever you want",
    ],
    cta: "Get Starter",
    featured: true,
  },
  {
    slug: "season_pass",
    name: "Season Pass",
    price: "$99",
    cadence: "one time",
    allowance: `${PAID_PLANS.season_pass.applicationsCap} applications, valid 6 months`,
    features: [
      `${PAID_PLANS.season_pass.applicationsCap} applications`,
      "Valid for 6 months",
      "Built for one recruiting season",
      "No subscription to remember",
    ],
    cta: "Get the Season Pass",
    featured: false,
  },
];

/**
 * The subset shown on the dashboard's upgrade cards.
 *
 * Skips the free tier: anyone on the dashboard already has it, so it is not
 * a plan to sell them. This is a filter over `LANDING_PLANS` rather than a
 * separate list, so a change to Starter or Season Pass copy applies to both
 * surfaces without any second edit here to remember.
 */
export const DASHBOARD_UPGRADE_PLANS: readonly PricingPlan[] =
  LANDING_PLANS.filter((plan) => plan.slug !== "free");
