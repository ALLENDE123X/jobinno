/**
 * Stripe's webhook endpoint (JOB-010). The only thing in Jobinno that may move
 * somebody onto a paid plan.
 *
 * ── The signature check is the whole security model ─────────────────────────
 * This route is public and unauthenticated, because Stripe's servers have no
 * session with us. What stands in for authentication is the HMAC in the
 * `stripe-signature` header, computed over the exact bytes of the body with the
 * endpoint's signing secret. Verify it and the request provably came from
 * Stripe; skip it and anyone on the internet can POST themselves 500
 * applications.
 *
 * So the body is read with `request.text()` and handed to Stripe unparsed.
 * `request.json()` would work and then quietly break the check, because the
 * signature covers the raw bytes and a reserialised object is not the same
 * bytes. That failure looks like a Stripe bug and is not one.
 *
 * ── Why the write uses the service role client ──────────────────────────────
 * There is no user session on this request to act as. There could not be: it
 * arrives from Stripe. Beyond that, `plan`, `applications_used` and
 * `applications_cap` are not writable by the `authenticated` role at all since
 * `drizzle/0003_profiles_column_privileges.sql`, so the service role client is
 * not a convenience here, it is the only client Postgres will accept the write
 * from. See the header of `lib/billing/webhook.ts`.
 *
 * ── What gets logged ────────────────────────────────────────────────────────
 * Event id, event type, and what was decided. Never the body, which carries a
 * customer's email and address, and never the signing secret.
 */

import { NextResponse, type NextRequest } from "next/server";

import { createStripeClient } from "@/lib/billing/stripe";
import {
  applyPlanChange,
  planChangeForEvent,
  type ProfileBillingClient,
} from "@/lib/billing/webhook";
import { createServiceRoleClient } from "@/lib/supabase/server";

// The Stripe SDK needs Node's crypto and its HTTP client. Stated rather than
// inherited, so that a future edge runtime default cannot silently break the
// signature check.
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const signingSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signingSecret) {
    // 500 and not 400: the request may well be perfectly valid and it is this
    // deployment that is misconfigured, so Stripe should retry rather than
    // treat the event as delivered and drop it.
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json(
      { error: "Billing webhook is not configured." },
      { status: 500 }
    );
  }

  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature." }, { status: 400 });
  }

  const payload = await request.text();

  let event;
  try {
    // The async variant, because it uses WebCrypto and therefore behaves the
    // same on every runtime this could end up deployed to.
    event = await createStripeClient().webhooks.constructEventAsync(
      payload,
      signature,
      signingSecret
    );
  } catch (thrown) {
    // A bad signature is a permanent failure. 400 tells Stripe not to retry,
    // which is right: the same bytes will not verify on the tenth attempt
    // either. The message is Stripe's own and names no secret.
    const message =
      thrown instanceof Error ? thrown.message : "Signature check failed.";
    console.warn(`[stripe-webhook] rejected an event: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const change = planChangeForEvent(event);

  // Retries are safe without an event ledger because every write here is
  // idempotent: activation sets the plan and the cap to constants from the
  // catalog, and a lapse is guarded on the profile still being on `starter`.
  // Replaying an event lands the row in the state it is already in.
  const result = await applyPlanChange(
    createServiceRoleClient() as unknown as ProfileBillingClient,
    change
  );

  if (!result.ok) {
    console.error(
      `[stripe-webhook] ${event.type} (${event.id}) failed: ${result.message}`
    );
    // 500 so Stripe retries. A dropped upgrade is somebody who paid and did not
    // get what they paid for, which is the worst outcome available here.
    return NextResponse.json({ error: result.message }, { status: 500 });
  }

  console.info(
    `[stripe-webhook] ${event.type} (${event.id}): ${result.applied}, ${result.detail}`
  );

  return NextResponse.json({ received: true, applied: result.applied });
}
