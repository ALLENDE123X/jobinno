"use client";

/**
 * The message the checkout route sends somebody back with when a Checkout
 * Session could not be opened (JOB-010).
 *
 * ── Why this is a client component and not a `searchParams` read ────────────
 * `app/page.tsx` now reads `searchParams` itself too, to decide whether to
 * skip the signed in redirect (JOB-020), so the page is no longer prerendered
 * regardless of what this component does. The original reason for keeping the
 * read here, that it let the page stay static and pay the cost only in the
 * failure case, no longer applies.
 *
 * Left as a client component anyway, because the reason that still holds is
 * separate from rendering mode: the code to safe message translation and the
 * alert markup belong together, next to each other, rather than folded into
 * the page's own growing `searchParams` handling. The Suspense boundary around
 * this component is required rather than decorative either way: `useSearchParams`
 * suspends, and without one Next refuses to build.
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
