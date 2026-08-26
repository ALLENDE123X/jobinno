#!/usr/bin/env node
/**
 * JOB-176: widen board discovery to listing repos beyond `LISTING_REPOS`.
 *
 * `lib/ats-boards.ts` seeds the registry from exactly two GitHub repos, both
 * scoped to summer internships (`SimplifyJobs/Summer2026-Internships` and
 * `vanshb03/Summer2026-Internships`). Neither one names a company whose only
 * open role is a new grad, full time position, so every community maintained
 * new grad list is untapped inventory. This script reuses
 * `harvestBoardsFromListingRepos` unmodified against a second set of repos and
 * writes a report in the same shape `scripts/ingest-discovered-boards.ts`
 * already reads, so the write path stays byte for byte the production one.
 *
 * Read only: one unauthenticated (or `GITHUB_TOKEN` authenticated) GET per
 * repo's README, nothing more.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn(
    "[job-176] No readable ../.env.local; GitHub reads will run unauthenticated " +
      "and may hit the anonymous rate limit sooner."
  );
}

import { harvestBoardsFromListingRepos } from "@/lib/ats-boards";
import { closeDb, db } from "@/lib/db/client";
import { boards } from "@/lib/db/schema";

/** Community maintained new grad and off cycle lists, none of them internship
 *  only, none of them in `LISTING_REPOS`. Checked live before adding: every
 *  one answers a real README with an ATS link table. */
const EXTRA_REPOS: readonly { owner: string; repo: string }[] = [
  { owner: "SimplifyJobs", repo: "New-Grad-Positions" },
  { owner: "vanshb03", repo: "New-Grad-2027" },
  { owner: "zapplyjobs", repo: "New-Grad-Software-Engineering-Jobs-2026" },
  { owner: "jobright-ai", repo: "2026-Software-Engineer-New-Grad" },
];

async function main(): Promise<void> {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error("Usage: npx tsx scripts/harvest-extra-listing-repos.ts <out.json>");
    process.exit(2);
  }

  const known = new Set(
    (
      await db()
        .select({ ats: boards.ats, boardToken: boards.boardToken })
        .from(boards)
    ).map((row) => `${row.ats}:${row.boardToken.toLowerCase()}`)
  );

  const harvested = await harvestBoardsFromListingRepos(EXTRA_REPOS);
  console.log(`[job-176] harvested ${harvested.length} board reference(s) across ${EXTRA_REPOS.length} repo(s)`);

  const smartrecruiters: Record<string, { company: null }> = {};
  const breezy: Record<string, { company: null }> = {};
  for (const entry of harvested) {
    if (entry.ats !== "smartrecruiters" && entry.ats !== "breezy") continue;
    const token = entry.boardToken.toLowerCase();
    if (known.has(`${entry.ats}:${token}`)) continue;
    if (entry.ats === "smartrecruiters") smartrecruiters[token] ??= { company: null };
    else breezy[token] ??= { company: null };
  }

  writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), smartrecruiters, breezy }, null, 2)
  );
  console.log(`[job-176] ${Object.keys(smartrecruiters).length} new SR candidate(s), ` +
    `${Object.keys(breezy).length} new Breezy candidate(s), unregistered so far`);
  console.log(`[job-176] report: ${outPath}`);
}

main()
  .catch((err: unknown) => {
    console.error(`[job-176] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
