#!/usr/bin/env node
/**
 * JOB-176, part two: turning a discovery report into real boards and jobs.
 *
 * Companion to `scripts/source-sr-breezy.ts`, which finds candidate SR
 * tenants and Breezy subdomains but writes nothing. This script does the two
 * writes, through the same primitives the daily cron uses:
 *
 *   1. Insert `boards` rows for the report's tokens that are not registered
 *      yet. Conflict safe on `(ats, board_token)`, exactly as
 *      `seedBoardRegistry` inserts: re running this against an already
 *      ingested report is a no-op, not a duplicate.
 *   2. Call `ingestBoards` over only the rows inserted here, so the existing
 *      boards are not re read and the relevance filter, apply URL screen and
 *      upsert semantics are the production ones rather than a copy.
 *
 * Nothing deletes, truncates or resets anything, per HARD STOP 5. The writes
 * go to whatever DATABASE_URL names, which is normally the real project; run
 * with --dry-run first to see what would be added.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` first, then `.env`, ambient environment beating both. Same order
// as every CLI in `lib/`.
const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn(
    "[job-176] No readable ../.env.local, so relying on the ambient environment " +
      "for DATABASE_URL."
  );
}

// Below the config() calls on purpose, matching lib/board-sync-cli.ts.
import { inArray, sql } from "drizzle-orm";

import { ingestBoards, listActiveBoards, loadBoards } from "@/lib/board-ingest";
import { placeholderCompanyName } from "@/lib/ats-boards";
import { closeDb, db } from "@/lib/db/client";
import { boards, jobs } from "@/lib/db/schema";

type SrReportEntry = { company?: string | null };
type BreezyReportEntry = { company?: string | null };
type Report = {
  smartrecruiters?: Record<string, SrReportEntry>;
  breezy?: Record<string, BreezyReportEntry>;
};

async function srBreezyJobCounts(): Promise<Map<string, number>> {
  const rows = await db()
    .select({ ats: jobs.ats, n: sql<number>`count(*)::int` })
    .from(jobs)
    // inArray over the two values rather than a raw string literal pair: the
    // column is text and drizzle types the parameter list for us.
    .where(inArray(jobs.ats, ["smartrecruiters", "breezy"]))
    .groupBy(jobs.ats);
  return new Map(rows.map((row) => [row.ats, Number(row.n)]));
}

function parseArgs(argv: readonly string[]): {
  reportPath: string;
  dryRun: boolean;
  limit: number | null;
} {
  let reportPath = "";
  let dryRun = false;
  let limit: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--report") {
      index += 1;
      if (index >= argv.length) {
        console.error("--report needs a value");
        process.exit(2);
      }
      reportPath = argv[index];
    } else if (token === "--dry-run") dryRun = true;
    else if (token === "--limit") {
      limit = Number(argv[++index]);
      if (!Number.isInteger(limit) || limit <= 0) {
        console.error("--limit needs a positive whole number");
        process.exit(2);
      }
    } else {
      console.error(`Unknown argument ${JSON.stringify(token)}`);
      process.exit(2);
    }
  }
  if (!reportPath) {
    console.error("Usage: npx tsx scripts/ingest-discovered-boards.ts --report <file> [--dry-run] [--limit N]");
    process.exit(2);
  }
  return { reportPath, dryRun, limit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = JSON.parse(readFileSync(args.reportPath, "utf8")) as Report;

  const srTokens = Object.keys(report.smartrecruiters ?? {});
  const breezyTokens = Object.keys(report.breezy ?? {});
  const candidates = [
    ...srTokens.map((token) => ({
      ats: "smartrecruiters" as const,
      token,
      company: text(report.smartrecruiters?.[token]?.company),
    })),
    ...breezyTokens.map((token) => ({
      ats: "breezy" as const,
      token,
      company: text(report.breezy?.[token]?.company),
    })),
  ];
  console.log(`[job-176] report holds ${srTokens.length} SR and ${breezyTokens.length} ` +
    `Breezy candidate(s)`);

  const before = await srBreezyJobCounts();
  console.log(`[job-176] before: smartrecruiters=${before.get("smartrecruiters") ?? 0}, ` +
    `breezy=${before.get("breezy") ?? 0}`);

  // Registry rows already known are skipped here even though the insert would
  // skip them too, because their job rows must not be attributed to this run's
  // summary.
  const registered = new Set(
    (
      await db()
        .select({ ats: boards.ats, boardToken: boards.boardToken })
        .from(boards)
    ).map((row) => `${row.ats}:${row.boardToken.toLowerCase()}`)
  );
  const fresh = candidates.filter((entry) => !registered.has(`${entry.ats}:${entry.token}`));
  const selected = args.limit === null ? fresh : fresh.slice(0, args.limit);
  console.log(`[job-176] ${fresh.length} of ${candidates.length} candidate(s) are unregistered` +
    `${args.dryRun ? "; dry run, inserting nothing" : ""}`);

  if (args.dryRun) {
    for (const entry of selected.slice(0, 40)) {
      console.log(`  would add ${entry.ats}/${entry.token}`);
    }
    if (selected.length > 40) console.log(`  ... and ${selected.length - 40} more`);
    return;
  }

  // Same chunked onConflictDoNothing shape as seedBoardRegistry. Returning the
  // id is what separates genuinely new boards from tokens that raced in
  // between runs: only returned rows get ingested below.
  const INSERT_CHUNK = 200;
  const inserted: { id: string; ats: string; boardToken: string }[] = [];
  for (let index = 0; index < selected.length; index += INSERT_CHUNK) {
    const batch = selected.slice(index, index + INSERT_CHUNK);
    const returned = await db()
      .insert(boards)
      .values(
        batch.map((entry) => ({
          ats: entry.ats,
          boardToken: entry.token,
          // The ATS's own spelling overwrites this on the first successful
          // read inside ingestBoard, same as every registry row.
          company: entry.company || placeholderCompanyName(entry.token),
        }))
      )
      .onConflictDoNothing({ target: [boards.ats, boards.boardToken] })
      .returning({ id: boards.id, ats: boards.ats, boardToken: boards.boardToken });
    inserted.push(...returned);
  }
  console.log(`[job-176] registry: ${selected.length} candidate(s), ${inserted.length} inserted`);

  const rows = await loadBoards(inserted.map((entry) => entry.id));
  console.log(`[job-176] reading ${rows.length} newly inserted board(s)`);

  const { summary } = await ingestBoards(rows, 4);

  const after = await srBreezyJobCounts();
  const totalBefore = (before.get("smartrecruiters") ?? 0) + (before.get("breezy") ?? 0);
  const totalAfter = (after.get("smartrecruiters") ?? 0) + (after.get("breezy") ?? 0);
  console.log(
    `[job-176] done: ${summary.ok} synced, ${summary.deferred} deferred, ${summary.failed} failed; ` +
      `${summary.kept} listing(s) kept of ${summary.seen} seen`
  );
  console.log(
    `[job-176] jobs table: smartrecruiters ${before.get("smartrecruiters") ?? 0} -> ` +
      `${after.get("smartrecruiters") ?? 0}, breezy ${before.get("breezy") ?? 0} -> ` +
      `${after.get("breezy") ?? 0}; combined ${totalBefore} -> ${totalAfter}`
  );

  const active = await listActiveBoards();
  console.log(`[job-176] active boards now: ${active.length} ` +
    `(SR ${active.filter((b) => b.ats === "smartrecruiters").length}, ` +
    `Breezy ${active.filter((b) => b.ats === "breezy").length})`);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

main()
  .catch((err: unknown) => {
    console.error(`[job-176] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
