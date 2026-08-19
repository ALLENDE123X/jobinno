"use client";

/**
 * The message the checkout route sends somebody back with when a Checkout
 * Session could not be opened (JOB-010).
 *
 * ── Why this is a client component and not a `searchParams` read ────────────
 * Reading `searchParams` in `app/page.tsx` would be less code, and it would
 * also opt the entire landing page into dynamic rendering. That page is the
 * marketing surface: it is almost always rendered for somebody who has never
 * pressed a pricing button, and making every one of those visits a server
 * render to check a query parameter that is nearly always absent is a bad
 * trade.
 *
 * Reading it here keeps the page prerendered and pays the cost only in the
 * failure case. The Suspense boundary around this component is required rather
 * than decorative: `useSearchParams` suspends during prerender, and without one
 * Next refuses to build.
 *
 * ── The query parameter itself is never rendered ────────────────────────────
 * What arrives is a code, and the sentence shown comes from the table in
 * `lib/billing/plans.ts` keyed by that code. This component used to print the
 * parameter directly, which turned a public marketing page into somewhere
 * anybody could put a sentence of their choosing, styled as our own alert,
 * simply by sending somebody a link. React escapes the value so it was never
 * script injection, but a line such as "your account is suspended, call this
 * number" reads just as convincingly with no markup in it at all.
 *
 * `billingErrorMessageFor` never returns what it was given, so a code that is
 * not one of ours gets the generic sentence rather than a passthrough.
 */

import { useSearchParams } from "next/navigation";

import {
  BILLING_ERROR_PARAM,
  billingErrorMessageFor,
} from "@/lib/billing/plans";

export function BillingError() {
  const message = billingErrorMessageFor(
    useSearchParams().get(BILLING_ERROR_PARAM)
  );

  if (!message) return null;

  return (
    <p
      role="alert"
      className="border-destructive/40 bg-destructive/5 text-destructive mx-auto mt-8 max-w-xl rounded-lg border px-4 py-3 text-center text-sm"
    >
      {message}
    </p>
  );
}
