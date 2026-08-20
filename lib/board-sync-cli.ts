#!/usr/bin/env node
/**
 * Local entrypoint for JOB-003's board sync.
 *
 *   npm run sync-boards                  seed the registry, then read every board
 *   npm run sync-boards -- --seed-only   only refresh the registry
 *   npm run sync-boards -- --sync-only   only read the boards already registered
 *   npm run sync-boards -- --limit 5     read at most five boards
 *
 * The same two calls `inngest/board-sync.ts` makes on its cron, without Inngest
 * in the way. This exists because there is no Inngest serve route in this
 * repository yet, so the scheduled function cannot fire, and because a sync
 * worth scheduling is a sync worth being able to run by hand.
 *
 * It writes to whatever `DATABASE_URL` names, which is normally the real
 * project. Those writes are inserts and updates on `boards` and `jobs` only.
 * Nothing here deletes, truncates or resets anything, per HARD STOP 5, and
 * running it twice is the intended way to use it rather than something it
 * tolerates.
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
  console.warn(
    "[job-003] No readable ../.env.local, so relying on the ambient environment " +
      "for DATABASE_URL and GITHUB_TOKEN."
  );
}

// Imported below the `config()` call above rather than at the top of the file.
// Nothing either module reads at evaluation time comes from the environment;
// `DATABASE_URL` and `GITHUB_TOKEN` are both read inside the functions this
// file calls. Same arrangement as the other CLIs in `lib/`.
import { ingestBoards, listActiveBoards, seedBoardRegistry } from "@/lib/board-ingest";
import { closeDb } from "@/lib/db/client";

const USAGE = [
  "Usage: npm run sync-boards -- [--seed-only | --sync-only] [--limit <n>]",
  "",
  "  --seed-only   refresh the board registry from the listing repos and stop",
  "  --sync-only   skip the registry refresh and read the boards already known",
  "  --limit <n>   read at most n boards, oldest sync first",
].join("\n");

function parseArgs(argv: string[]): { seedOnly: boolean; syncOnly: boolean; limit: number | null } {
  let seedOnly = false;
  let syncOnly = false;
  let limit: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--seed-only") seedOnly = true;
    else if (token === "--sync-only") syncOnly = true;
    else if (token === "--limit") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value <= 0) {
        console.error(`--limit needs a positive whole number\n\n${USAGE}`);
        process.exit(2);
      }
      limit = value;
    } else {
      console.error(`Unknown argument ${JSON.stringify(token)}\n\n${USAGE}`);
      process.exit(2);
    }
  }

  if (seedOnly && syncOnly) {
    console.error(`--seed-only and --sync-only contradict each other\n\n${USAGE}`);
    process.exit(2);
  }

  return { seedOnly, syncOnly, limit };
}

async function main(): Promise<void> {
  const { seedOnly, syncOnly, limit } = parseArgs(process.argv.slice(2));

  if (!syncOnly) {
    const registry = await seedBoardRegistry();
    console.log(
      `[job-003] registry: ${registry.named} board(s) named, ${registry.inserted} inserted`
    );
    if (seedOnly) return;
  }

  const all = await listActiveBoards();
  const selected = limit === null ? all : all.slice(0, limit);
  console.log(`[job-003] reading ${selected.length} of ${all.length} active board(s)`);

  const { summary, outcomes } = await ingestBoards(selected);

  for (const outcome of outcomes) {
    if (outcome.status === "ok" && outcome.kept > 0) {
      console.log(
        `  ${outcome.ats}/${outcome.boardToken}: ${outcome.kept} kept of ${outcome.seen}`
      );
    }
  }

  console.log(
    `[job-003] ${summary.ok} synced, ${summary.deferred} deferred, ${summary.failed} failed; ` +
      `${summary.kept} listing(s) kept of ${summary.seen} seen` +
      (summary.rejected > 0 ? `, ${summary.rejected} dropped on an unusable apply URL` : "")
  );
}

// Not top level await: this package has no "type": "module", so tsx compiles
// this file to CommonJS and a top level await is a build error rather than a
// runtime one. The pool is closed either way, or the process hangs on an idle
// connection after the work is done.
main()
  .catch((err: unknown) => {
    console.error(`[job-003] sync failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
