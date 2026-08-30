/**
 * The upgrade cards under the dashboard's applications list (JOB-284).
 *
 * ── Why they live on the dashboard at all ─────────────────────────────────
 * A signed-in visitor who has spent their three free applications had no
 * path to pay for a plan without first navigating back to the landing page,
 * which is not a page they are looking at once they are inside the app. So
 * a person with a live account, a used quota, and money to spend was left
 * choosing between abandoning the tool and clicking around for the pricing
 * section they never found. Both are silent conversion failures, and this
 * component is the fix: the same two cards, in the same styling, right
 * below the applications list they just scrolled through.
 *
 * ── Why this is a server component with a plain form POST ─────────────────
 * The landing page's pricing cards (`app/page.tsx#pricing`) already do
 * exactly this, and the reason for it there is the reason for it here:
 * every card is a real `<form action={CHECKOUT_PATH} method="post">`, so
 * the browser navigates itself to Stripe on submit and the button needs no
 * client JavaScript at all. The route on the other end runs the same
 * `isTrustedOrigin` check for both surfaces — the check reads the Origin
 * header rather than the referring page, so a POST from `/dashboard`
 * passes the same test as a POST from `/`.
 *
 * The Free tier is not shown. Everyone on the dashboard already has it, so
 * it is not a plan to sell them. `DASHBOARD_UPGRADE_PLANS` in
 * `lib/pricing.ts` is the pre-filtered list.
 *
 * ── Why there is no current-plan gate ─────────────────────────────────────
 * The checkout route itself refuses a duplicate purchase and sends the
 * person back with `already_subscribed` (see
 * `app/api/billing/checkout/route.ts`), so both cards render regardless of
 * what somebody already holds. Anything cleverer here would be duplicating
 * a check that already lives at the trust boundary rather than at the UI.
 */

import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  CHECKOUT_PATH,
  CHECKOUT_PLAN_PARAM,
} from "@/lib/billing/plans";
import { DASHBOARD_UPGRADE_PLANS } from "@/lib/pricing";
import { cn } from "@/lib/utils";

export function UpgradeCards() {
  return (
    <section aria-labelledby="upgrade-cards-heading" className="space-y-6">
      <div className="space-y-2">
        <h2
          id="upgrade-cards-heading"
          className="text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          Add more applications
        </h2>
        <p className="text-muted-foreground text-base">
          Pick the plan that fits how long you are looking. Both open Stripe
          checkout for a real payment.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {DASHBOARD_UPGRADE_PLANS.map((plan) => (
          <div
            key={plan.slug}
            // `data-plan` gives the test a stable way to find the card for
            // a given slug without walking the DOM by class name, which
            // would break the moment a Tailwind class here changed.
            data-plan={plan.slug}
            className={cn(
              "flex flex-col rounded-2xl border p-6 sm:p-8",
              plan.featured
                ? "border-foreground/20 bg-card shadow-lg ring-1 ring-foreground/10"
                : "bg-card/40"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-medium">{plan.name}</h3>
              {plan.featured ? (
                <span className="rounded-full bg-foreground px-2.5 py-1 text-xs font-medium whitespace-nowrap text-background">
                  Most popular
                </span>
              ) : null}
            </div>

            <p className="mt-4 flex items-baseline gap-2">
              <span className="text-4xl font-semibold tracking-tight">
                {plan.price}
              </span>
              <span className="text-muted-foreground text-sm">
                {plan.cadence}
              </span>
            </p>

            <p className="mt-2 text-sm font-medium">{plan.allowance}</p>

            <ul className="mt-6 flex flex-1 flex-col gap-3">
              {plan.features.map((feature) => (
                <li
                  key={feature}
                  className="flex items-start gap-2 text-sm"
                >
                  <Check className="mt-0.5 size-4 shrink-0" />
                  <span className="text-muted-foreground">{feature}</span>
                </li>
              ))}
            </ul>

            <form action={CHECKOUT_PATH} method="post" className="mt-8">
              <input
                type="hidden"
                name={CHECKOUT_PLAN_PARAM}
                value={plan.slug}
              />
              <Button
                type="submit"
                className="h-10 w-full text-sm"
                variant={plan.featured ? "default" : "outline"}
                size="lg"
              >
                {plan.cta}
              </Button>
            </form>
          </div>
        ))}
      </div>
    </section>
  );
}
