/**
 * JOB-004 — the Inngest serve route. The one place the functions in `inngest/`
 * become reachable.
 *
 * Until this existed, nothing registered anything with Inngest. That is not a
 * detail: an Inngest function is not code that runs on a timer inside this
 * process, it is an HTTP endpoint that Inngest calls. Without an endpoint,
 * JOB-003's board sync could not fire on its schedule however correct its cron
 * expression was, and no event could reach the application pipeline however
 * well formed it was. `inngest/board-sync.ts` says as much in its own header.
 *
 * ── How registration actually happens ───────────────────────────────────────
 * `serve()` builds a handler that answers three verbs, and each does a
 * different job:
 *
 *  · **PUT** is the sync. Inngest calls it (or the dashboard's "Sync" button
 *    does, or `inngest-cli dev` does automatically) and the handler replies
 *    with every function's id, triggers and configuration. That reply is the
 *    registration. A cron is *stored on Inngest's side* from what this returns,
 *    so a schedule that has never been synced has never been scheduled.
 *  · **POST** is execution. Inngest calls it once per step, with a signature
 *    this handler verifies.
 *  · **GET** is introspection: a small unsigned JSON document describing this
 *    app, which the dev server and the dashboard use to check the endpoint is
 *    alive and configured. It is also what a health check should hit, because
 *    it needs no signature and changes nothing.
 *
 * ── The two keys ────────────────────────────────────────────────────────────
 * Neither is passed here, and that is correct rather than an omission. The SDK
 * reads `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` from the environment
 * itself, and passing them as literals would mean a second place for them to be
 * wrong and a real chance of one ending up in a log line. Both are already
 * provisioned in `.env.local` and documented in `.env.example`.
 *
 *  · `INNGEST_SIGNING_KEY` is how this route proves an incoming POST really
 *    came from Inngest. Without it the handler refuses every execution request,
 *    which presents as a route that returns 500 to Inngest and nothing at all
 *    in the application logs.
 *  · `INNGEST_EVENT_KEY` is the outbound half: it is what `inngest.send()` and
 *    `step.sendEvent()` authenticate with. The fan-out in `discoverListings`
 *    needs it; the handler itself does not.
 *
 * `INNGEST_DEV` decides whether the client talks to a local dev server or to
 * Inngest Cloud, and it is read when the client is *constructed*, not here. See
 * `inngest/load-env.ts` for why that forces an import ordering.
 *
 * ── Why every function is listed here and not collected automatically ───────
 * The two modules below both export function arrays, and it would be tidier to
 * glob them. It would also mean that the set of things registered with Inngest
 * depends on which files happen to exist, which is the wrong property for a
 * list that decides what runs against real employers' job boards on a schedule.
 * One explicit list, one file, greppable.
 */

import { serve } from "inngest/next";

import { syncJobBoards } from "@/inngest/board-sync";
import { applyToJob, discoverListings, inngest } from "@/inngest/job-application-pipeline";

/**
 * Node, not Edge. Non negotiable rather than a preference: the pipeline reaches
 * Stagehand and a Postgres driver, neither of which runs on the Edge runtime.
 */
export const runtime = "nodejs";

/**
 * Never statically rendered or cached. A cached POST response would be Inngest
 * being told a step had completed when it had not run.
 */
export const dynamic = "force-dynamic";

/**
 * Seconds. One `step.run` here can drive a real browser through a real
 * application form, which takes minutes rather than the platform default of
 * seconds. 300 is the ceiling on Vercel's Pro plan.
 *
 * This is a ceiling, not a target, and it is not the whole answer: a serverless
 * function that has to stay alive for the length of a browser session is the
 * wrong shape for this work, and moving the browser steps somewhere with no
 * request timeout is a real ticket rather than a bigger number. Until then a
 * run that exceeds this is retried by Inngest from its last completed step,
 * which is safe for every step here except a submit — and a submit that dies
 * mid click is exactly the `submission_unconfirmed` case ACT-008 refuses to
 * retry.
 */
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    // JOB-003. The cron that keeps `boards` and `jobs` current. This is the
    // registration that makes its schedule real.
    syncJobBoards,
    // ACT-009, by way of JOB-004. Search and fan out, then one run per listing.
    discoverListings,
    applyToJob,
  ],
});
