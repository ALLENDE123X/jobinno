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

import { sendMetaCapiEvent } from "@/lib/analytics/meta-conversions-api";
import { META_EVENT } from "@/lib/analytics/meta-pixel-client";
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

  // ── Building the client is a separate failure from verifying the signature ──
  // Both used to happen inside one try, and both came out of it as a 400. That
  // is right for a signature and badly wrong for a missing `STRIPE_SECRET_KEY`:
  // Stripe retries 5xx and does not retry 4xx, so a deployment that lost its
  // key answered 400 to a real payment, Stripe marked the event delivered, and
  // the plan activation was gone for good with nothing left to replay. A
  // configuration problem has to look like a server problem, because that is
  // what it is, and because a retry after somebody fixes the variable is the
  // only thing that saves the payment.
  let stripe;
  try {
    stripe = createStripeClient();
  } catch (thrown) {
    const detail =
      thrown instanceof Error ? thrown.message : "Stripe client unavailable.";
    console.error(`[stripe-webhook] cannot build a Stripe client: ${detail}`);
    // Generic in the body. The detail names which environment variable is
    // empty, which is exactly what the server log is for and exactly what an
    // unauthenticated public endpoint should not hand back to a caller.
    return NextResponse.json(
      { error: "Billing webhook is not configured." },
      { status: 500 }
    );
  }

  let event;
  try {
    // The async variant, because it uses WebCrypto and therefore behaves the
    // same on every runtime this could end up deployed to.
    event = await stripe.webhooks.constructEventAsync(
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
  // idempotent. Activation reads the row first and only resets the counter when
  // the plan is genuinely changing, a lapse is guarded on the profile still
  // being on `starter`, and everything else is a constant from the catalog. See
  // `applyPlanChange`, which is where that is enforced rather than hoped for.
  //
  // JOB-200: build the service role client under its own try/catch so a
  // missing `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` produces the same
  // shape as the Stripe client failure above rather than a framework 500
  // with a stack trace. 500 keeps Stripe retrying, which is the right thing
  // to do for a configuration miss on this endpoint.
  let serviceClient: ReturnType<typeof createServiceRoleClient>;
  try {
    serviceClient = createServiceRoleClient();
  } catch (thrown) {
    const detail =
      thrown instanceof Error ? thrown.message : "service role client unavailable";
    console.error(`[stripe-webhook] service role client unavailable: ${detail}`);
    return NextResponse.json(
      { error: "Billing webhook is not configured." },
      { status: 500 }
    );
  }

  const result = await applyPlanChange(
    serviceClient as unknown as ProfileBillingClient,
    change
  );

  if (!result.ok) {
    console.error(
      `[stripe-webhook] ${event.type} (${event.id}) failed: ${result.message}`
    );
    // 500 so Stripe retries. A dropped upgrade is somebody who paid and did not
    // get what they paid for, which is the worst outcome available here. The
    // reason stays in the log: it is a Postgres error and can name columns and
    // constraints, which is not something a public endpoint should recite.
    return NextResponse.json(
      { error: "Could not record that event." },
      { status: 500 }
    );
  }

  console.info(
    `[stripe-webhook] ${event.type} (${event.id}): ${result.applied}, ${result.detail}`
  );

  // JOB-328. Meta Purchase via the Conversions API. Fired only when the plan
  // actually activated on a checkout.session.completed event, so a redelivery
  // that the idempotency guard above already collapsed to "nothing" or a
  // subscription lapse cannot double count. The Stripe event id doubles as
  // Meta's dedupe key so that a Pixel-fired Purchase and this server side
  // Purchase for the same checkout resolve to one event on Meta's side.
  // The customer's email is hashed inside sendMetaCapiEvent (HARD STOP 9);
  // amount_total is in the smallest currency unit per Stripe convention, so
  // it is divided by 100 to give Meta the value in whole currency units.
  if (
    event.type === "checkout.session.completed" &&
    result.applied === "activated"
  ) {
    const session = event.data.object;
    const amountTotal = session.amount_total ?? 0;
    const email =
      session.customer_details?.email ??
      (typeof session.customer_email === "string"
        ? session.customer_email
        : null);
    await sendMetaCapiEvent({
      eventName: META_EVENT.PURCHASE,
      email,
      eventId: event.id,
      value: amountTotal / 100,
      currency: (session.currency ?? "usd").toLowerCase(),
    });
  }

  return NextResponse.json({ received: true, applied: result.applied });
}
