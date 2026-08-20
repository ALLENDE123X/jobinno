#!/usr/bin/env node
/**
 * JOB-015's rollup, on demand.
 *
 *   npm run skip-rollup                 the last seven days
 *   npm run skip-rollup -- --days 30    a longer window
 *   npm run skip-rollup -- --json       the same numbers, machine readable
 *
 * ── Why a command and not a page or an email ────────────────────────────────
 * An emailed weekly digest was the other candidate and it cannot be delivered.
 * `RESEND_API_KEY` is in `.env.example` under "not yet wired" and there is no
 * mail sending code in this repository, so a scheduled function that composed a
 * digest would have nowhere to hand it. Announcing an email nobody receives is
 * worse than not having one.
 *
 * An internal page was the third. It needs an answer to "who may see every
 * user's data", and `profiles` carries no such flag, so the page would have had
 * to invent an operator role and an authorization check for it. That is a
 * security surface and it deserves its own ticket rather than being introduced
 * as the frame around a report.
 *
 * What is left is the thing that is honest today: a report anybody who can
 * already reach `DATABASE_URL` can run, in the same shape as the five other
 * entrypoints in `lib/`. The window still defaults to a week, so "the weekly
 * rollup" is a command rather than a promise about a schedule.
 *
 * It reads and never writes. Every statement it reaches is a SELECT, so running
 * it against the real project is the intended use rather than something to be
 * careful about.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` (secrets, gitignored) first, then `.env` (committed defaults).
// dotenv never overwrites a variable that is already set, so first load wins
// and real process env still beats both. Same order as every CLI in `lib/`.
const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn("[job-015] No readable ../.env.local, so relying on the ambient DATABASE_URL.");
}

// Imported below the `config()` call above, like the other CLIs here: nothing
// either module reads at evaluation time comes from the environment, and
// `DATABASE_URL` is read inside `db()` when the first query runs.
import { closeDb } from "@/lib/db/client";
import { DEFAULT_ROLLUP_DAYS, formatSkipRollup, loadSkipRollup } from "@/lib/skip-rollup";

const USAGE = [
  "Usage: npm run skip-rollup -- [--days <n>] [--limit <n>] [--json]",
  "",
  `  --days <n>    how far back to look. Defaults to ${DEFAULT_ROLLUP_DAYS}.`,
  "  --limit <n>   how many boards and questions to list. Defaults to 10.",
  "  --json        print the rollup as JSON instead of as a report",
].join("\n");

function positive(token: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`${token} needs a positive whole number\n\n${USAGE}`);
    process.exit(2);
  }
  return parsed;
}

function parseArgs(argv: string[]): { days: number; limit: number | undefined; json: boolean } {
  let days = DEFAULT_ROLLUP_DAYS;
  let limit: number | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") json = true;
    else if (token === "--days") days = positive(token, argv[++index]);
    else if (token === "--limit") limit = positive(token, argv[++index]);
    else {
      console.error(`Unknown argument ${JSON.stringify(token)}\n\n${USAGE}`);
      process.exit(2);
    }
  }

  return { days, limit, json };
}

async function main(): Promise<void> {
  const { days, limit, json } = parseArgs(process.argv.slice(2));
  const rollup = await loadSkipRollup({ days, limit });
  console.log(json ? JSON.stringify(rollup, null, 2) : formatSkipRollup(rollup));
}

// Not top level await: this package has no "type": "module", so tsx compiles
// this file to CommonJS and a top level await is a build error rather than a
// runtime one. The pool is closed either way, or the process hangs on an idle
// connection after the work is done.
main()
  .catch((err: unknown) => {
    console.error(`[job-015] rollup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
