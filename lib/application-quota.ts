/**
 * The plan allowance, as a counter rather than as a count (JOB-004).
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 * `profiles.applications_used` has existed since JOB-002 and nothing ever wrote
 * it. `claimApplicationRow` therefore gated on a live `count(*)` of the
 * person's `applications` rows instead, and JOB-010's Stripe webhook writes
 * `applications_used = 0` on a genuine plan change so that "150 a month" means
 * 150 from the moment somebody pays. Those two facts do not compose:
 *
 *  · Somebody who used ten free applications and then upgraded got 140, not the
 *    150 they were sold, because the lifetime row count still carried the ten.
 *  · A long standing customer whose lifetime count had passed a renewed cap was
 *    refused outright the moment they paid again.
 *  · Every `discovered` row and every failed or skipped attempt counted, so a
 *    board that refused us burned somebody's allowance.
 *
 * The counter is the source of truth now, and this module is the only thing
 * that moves it. `applications` rows are the record of what happened; they are
 * not the meter.
 *
 * ── Why the write is one statement and not a read then a write ──────────────
 * `applyToJob` runs `browserConcurrencyLimit()` listings at once for the same
 * person, so "read the counter, compare it to the cap, write the counter back"
 * has a real window in it: three runs read 149 of 150 and all three write 150.
 * Both statements below are single conditional UPDATEs, so Postgres serialises
 * them on the row lock and the condition is re-evaluated against the value that
 * actually won. A reservation that would exceed the cap matches no row and
 * returns nothing, and *that* — not a preceding check — is what refuses it.
 *
 * ── Reserve before the click, release if nothing was sent ───────────────────
 * The allowance has to be taken before the submit control is pressed, because
 * the only way to enforce a cap is to enforce it while refusing is still
 * possible. So `reserveApplicationSlot` runs ahead of the browser and
 * `releaseApplicationSlot` hands the slot back when the run ends without an
 * application existing at the employer.
 *
 * The release is conditional on the same `applications` row in the same
 * statement: a row at `submitted` or `submission_unconfirmed` keeps its slot,
 * because in both cases a submit control was pressed and something may well be
 * sitting in an employer's inbox. Everything else — blocked, errored, still
 * `discovered` — gives it back, which is what makes a failed attempt free.
 *
 * ── The one thing this does not survive ─────────────────────────────────────
 * A process that dies between the reservation and the release leaks one slot.
 * The pipeline pairs them in memoized Inngest steps so an ordinary failure,
 * including an exhausted retry, still releases; a hard kill does not. That
 * error is deliberately in the conservative direction — a person loses one
 * application from their allowance rather than getting one free — and closing
 * it properly wants a reservation ledger keyed by application id, which is a
 * migration rather than a line.
 *
 * ── Why Drizzle here and Supabase everywhere else in the pipeline ───────────
 * PostgREST cannot express either statement. `applications_used =
 * applications_used + 1` is arithmetic on a column and
 * `applications_used < applications_cap` compares two columns, and
 * `@supabase/supabase-js` can send neither, so going through it would force the
 * read-then-write this module exists to avoid. `lib/db/client.ts` is already
 * the second connection in this process — `board-ingest.ts` writes through it
 * from an Inngest function registered on the same route — so this is a second
 * caller of an existing thing rather than a new dependency.
 */

import { and, eq, exists, notInArray, sql } from "drizzle-orm";

import { APPLICATION_STATUS } from "@/lib/application-status";
import { db } from "@/lib/db/client";
import { applications, profiles } from "@/lib/db/schema";

/** The Drizzle client the statements run on. Injectable so a test can supply its own pool. */
export type QuotaDatabase = ReturnType<typeof db>;

/**
 * The two statuses that keep a reserved slot spent.
 *
 * Both mean a submit control was clicked. `submitted` is the confirmed case and
 * `submission_unconfirmed` is the one where nobody knows — and an unknown
 * submission has to be charged for, because the alternative is refunding an
 * allowance for an application that really is sitting with an employer.
 */
export const SLOT_CONSUMING_STATUSES: readonly string[] = [
  APPLICATION_STATUS.SUBMITTED,
  APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
];

export type SlotReservation =
  | { reserved: true; used: number; cap: number }
  | { reserved: false; reason: "cap_reached"; used: number; cap: number }
  | { reserved: false; reason: "no_profile" };

/**
 * Takes one application off the person's allowance, or refuses.
 *
 * The UPDATE is the whole decision. Nothing is read first, and the `RETURNING`
 * is what says it happened: rows back means the slot is now this caller's, no
 * rows means the row did not satisfy `applications_used < applications_cap` at
 * the instant the lock was held.
 *
 * The follow-up SELECT runs only on the refusal path and only to say *why* —
 * a cap that is full reads differently from a profile that does not exist, and
 * the caller's error message is the only place either fact ever surfaces. It is
 * deliberately not part of the decision.
 */
export async function reserveApplicationSlot(
  userId: string,
  database: QuotaDatabase = db()
): Promise<SlotReservation> {
  const [claimed] = await database
    .update(profiles)
    .set({
      applicationsUsed: sql`${profiles.applicationsUsed} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(profiles.id, userId),
        sql`${profiles.applicationsUsed} < ${profiles.applicationsCap}`
      )
    )
    .returning({ used: profiles.applicationsUsed, cap: profiles.applicationsCap });

  if (claimed) return { reserved: true, used: claimed.used, cap: claimed.cap };

  const [current] = await database
    .select({ used: profiles.applicationsUsed, cap: profiles.applicationsCap })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (!current) return { reserved: false, reason: "no_profile" };
  return { reserved: false, reason: "cap_reached", used: current.used, cap: current.cap };
}

export type SlotSettlement =
  | { outcome: "released"; used: number }
  | { outcome: "kept"; status: string }
  | { outcome: "nothing_to_release"; status: string | null };

/**
 * Hands the slot back, unless the application really was sent.
 *
 * The `exists` subquery is inside the UPDATE on purpose. Reading the status and
 * then deciding would reopen the window this module is built to avoid: a run
 * that reads `form_fill_blocked`, is beaten to the punch by nothing in
 * particular, and then refunds a slot for a row that has since been written to.
 * One statement, one lock, one decision.
 *
 * `applications_used > 0` is belt and braces, and it is also the one place this
 * module and JOB-010's webhook can meet. The webhook writes
 * `applications_used = 0` when somebody genuinely changes plan, and it can do
 * that while a run holds a reservation — Stripe does not wait for the pipeline.
 * The guard means the release finds a zero, declines, and leaves the freshly
 * bought allowance whole; the person is forgiven a slot they had already spent,
 * which is the direction to be wrong in. A `NOT NULL integer` at zero minus one
 * is a number the rest of the product would have to defend against forever.
 */
export async function releaseApplicationSlot(
  input: { userId: string; applicationId: string },
  database: QuotaDatabase = db()
): Promise<SlotSettlement> {
  const { userId, applicationId } = input;

  const [released] = await database
    .update(profiles)
    .set({
      applicationsUsed: sql`${profiles.applicationsUsed} - 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(profiles.id, userId),
        sql`${profiles.applicationsUsed} > 0`,
        exists(
          database
            .select({ present: sql`1` })
            .from(applications)
            .where(
              and(
                eq(applications.id, applicationId),
                eq(applications.userId, profiles.id),
                notInArray(applications.status, [...SLOT_CONSUMING_STATUSES])
              )
            )
        )
      )
    )
    .returning({ used: profiles.applicationsUsed });

  if (released) return { outcome: "released", used: released.used };

  // Nothing was released. Report which of the two reasons it was, for the log
  // line the pipeline writes; neither changes what happens next.
  const [row] = await database
    .select({ status: applications.status })
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)))
    .limit(1);

  const status = row?.status ?? null;
  if (status !== null && SLOT_CONSUMING_STATUSES.includes(status)) {
    return { outcome: "kept", status };
  }
  return { outcome: "nothing_to_release", status };
}
