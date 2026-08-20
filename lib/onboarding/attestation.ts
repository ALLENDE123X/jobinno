/**
 * The one time grant of free applications, and the stamp that intake happened.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 * `app/page.tsx` and `tests/e2e/smoke.spec.ts` both promise "10 applications,
 * total" on the Free plan, and `lib/billing/plans.ts` has argued for a while
 * that the ten are "a one time trial granted at signup" — but nothing ever
 * granted them. `profiles.applications_cap` defaults to zero
 * (`lib/db/schema.ts`), `app/auth/callback/route.ts`'s upsert only ever writes
 * `id` and `email`, and the only two writers of the column are
 * `lib/billing/webhook.ts`'s Stripe handlers, one for a real purchase and one
 * for a lapse to zero. A free signup that finished onboarding and never paid
 * was stuck at a cap of zero forever, with `FindJobsButton` correctly refusing
 * it the whole time. This module is the missing grant.
 *
 * ── Why it lives here and not inline in the onboarding action ───────────────
 * `app/onboarding/actions.ts` already reaches Postgres through
 * `@supabase/supabase-js`, same as the rest of that file, but PostgREST's
 * update payload is a plain JSON object: it cannot express "set this column
 * from what another column already holds", only "set this column to a value I
 * already know." Deciding whether to grant ten needs exactly that: the
 * profile's *current* `plan` at the instant of the write. Fetching it first
 * and branching in application code would reopen the read then write race this
 * codebase has already ruled out twice, in `lib/application-quota.ts`'s
 * `reserveApplicationSlot` and `lib/search-cooldown.ts`'s `claimSearchSlot`:
 * two concurrent calls could both read "not yet attested" and both grant.
 * Postgres can decide from the row it already has locked, in the same
 * statement, so the write goes through Drizzle here instead, exactly as those
 * two modules do.
 *
 * ── Why one statement, and what makes it safe to call twice ─────────────────
 * `recordAttestation` is a single conditional `UPDATE ... WHERE id = $1 AND
 * attested_at IS NULL`. A row that statement does not touch was already
 * attested, so the call is a no op: it neither stamps the timestamp again nor
 * grants the cap again. That matters because `/onboarding` renders a different
 * page once `attested_at` is set rather than redirecting the route away, so
 * the server action behind the form is still reachable a second time for the
 * same person — a retried submit, a replayed request, anything that can POST
 * with a valid session. The grant has to survive that on its own; it cannot
 * rely on the UI never asking twice.
 *
 * Whether the cap is included in that same statement is decided by a SQL
 * `CASE` over the row's current `plan`, read at lock time rather than fetched
 * beforehand, so it is part of the one atomic decision rather than a second
 * one: only a profile still on `free` gets `FREE_PLAN_APPLICATIONS_CAP`.
 * Everything else keeps whatever `applications_cap` already held. That
 * `plan` check does not gate the timestamp: a profile that somehow paid before
 * finishing intake — not a flow this product offers today, but not one this
 * statement should silently mishandle if it ever happens — still gets
 * `attested_at` stamped, because the pipeline reads that column to decide
 * whether it may act for this person at all, and a paid customer forever
 * `null` there is a worse failure than one that keeps a real cap.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { FREE_PLAN_APPLICATIONS_CAP } from "@/lib/billing/plans";
import { db } from "@/lib/db/client";
import { profiles } from "@/lib/db/schema";

/** The Drizzle client the statement runs on. Injectable so a test can supply its own pool. */
export type AttestationDatabase = ReturnType<typeof db>;

export type AttestationResult =
  | { recorded: true; granted: boolean }
  | { recorded: false };

/**
 * Stamps `attested_at` for the first time, and grants the free trial cap in
 * the same statement when this really is the first time on a plan that is
 * still free.
 *
 * `recorded` is true only when this call is the one that set the timestamp.
 * `granted` says whether the `CASE` inside the same UPDATE actually raised the
 * cap; a profile that was already on a paid plan at this instant is recorded
 * but not granted, so a caller that logs or reports on the grant is not told
 * it happened when the statement actually left a real cap untouched.
 */
export async function recordAttestation(
  userId: string,
  database: AttestationDatabase = db()
): Promise<AttestationResult> {
  const now = new Date();

  const [row] = await database
    .update(profiles)
    .set({
      attestedAt: now,
      updatedAt: now,
      applicationsCap: sql`case when ${profiles.plan} = 'free' then ${FREE_PLAN_APPLICATIONS_CAP} else ${profiles.applicationsCap} end`,
    })
    .where(and(eq(profiles.id, userId), isNull(profiles.attestedAt)))
    // `plan` is read back rather than assumed, so `granted` reflects the row
    // the `CASE` actually saw rather than guessing from the cap it wrote: a
    // paid plan whose cap already happened to read ten would otherwise look
    // like a grant that never happened.
    .returning({ plan: profiles.plan });

  if (!row) return { recorded: false };
  return { recorded: true, granted: row.plan === "free" };
}
