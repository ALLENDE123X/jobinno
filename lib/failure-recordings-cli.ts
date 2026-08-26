#!/usr/bin/env node
/**
 * JOB-027. Downloads the Browserbase recording behind each recent `skip_log`
 * failure and asks Gemini for a play-by-play of what actually happened.
 *
 *   npm run analyze-failures                        the last 7 days
 *   npm run analyze-failures -- --days 30 --ats ashby
 *   npm run analyze-failures -- --reason bot_detected --limit 5
 *
 * Requires `BROWSERBASE_API_KEY`, `GEMINI_API_KEY`, and `ffmpeg` on PATH.
 * Writes one video per analyzed failure into `--out` (default:
 * `./failure-recordings/`) alongside a `report.md` grouping the findings by
 * platform and reason — see `lib/failure-recordings.ts` for the pipeline
 * itself and why session ids on rows before JOB-027 are only a best guess.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn("[job-027] No readable ../.env.local, so relying on the ambient environment.");
}

import { closeDb } from "@/lib/db/client";
import {
  analyzeFailureVideo,
  downloadReplay,
  listRecentFailures,
  listRecentSessions,
  resolveSessionId,
  type FailureRecord,
} from "@/lib/failure-recordings";
import type { SkipReason } from "@/lib/db/schema";

const USAGE = [
  "Usage: npm run analyze-failures -- [--days <n>] [--reason <r>] [--ats <a>] [--limit <n>] [--out <dir>]",
  "",
  "  --days <n>     how far back to look. Defaults to 7.",
  "  --reason <r>   only this skip_log reason, e.g. bot_detected.",
  "  --ats <a>      only this platform, e.g. ashby.",
  "  --limit <n>    how many failures to analyze. Defaults to 10 — each one is a Gemini call.",
  "  --out <dir>    where videos and the report land. Defaults to ./failure-recordings.",
].join("\n");

function positive(token: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`${token} needs a positive whole number\n\n${USAGE}`);
    process.exit(2);
  }
  return parsed;
}

function parseArgs(argv: string[]): {
  days: number;
  reason: SkipReason | undefined;
  ats: string | undefined;
  limit: number;
  outDir: string;
} {
  let days = 7;
  let reason: SkipReason | undefined;
  let ats: string | undefined;
  let limit = 10;
  let outDir = resolve(process.cwd(), "failure-recordings");

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--days") days = positive(token, argv[++index]);
    else if (token === "--reason") reason = argv[++index] as SkipReason;
    else if (token === "--ats") ats = argv[++index];
    else if (token === "--limit") limit = positive(token, argv[++index]);
    else if (token === "--out") outDir = resolve(process.cwd(), argv[++index] ?? "");
    else {
      console.error(`Unknown argument ${JSON.stringify(token)}\n\n${USAGE}`);
      process.exit(2);
    }
  }

  return { days, reason, ats, limit, outDir };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    console.error(`${name} is required — set it in .env.local.`);
    process.exit(1);
  }
  return value;
}

type Analysis = { failure: FailureRecord; sessionId: string; videoPath: string; text: string };
type Skipped = { failure: FailureRecord; why: string };

async function main(): Promise<void> {
  const { days, reason, ats, limit, outDir } = parseArgs(process.argv.slice(2));
  const browserbaseApiKey = requireEnv("BROWSERBASE_API_KEY");
  const geminiApiKey = requireEnv("GEMINI_API_KEY");

  const failures = await listRecentFailures({ days, reason, ats, limit });
  if (failures.length === 0) {
    console.log(`No skip_log rows in the last ${days} day(s) match that filter.`);
    return;
  }
  console.log(`${failures.length} failure(s) to analyze. Fetching the recent-sessions list once…`);

  const sessions = await listRecentSessions({ apiKey: browserbaseApiKey });
  await mkdir(outDir, { recursive: true });

  const analyzed: Analysis[] = [];
  const skipped: Skipped[] = [];

  for (const failure of failures) {
    console.log(`\n— ${failure.ats}/${failure.reason} @ ${failure.createdAt.toISOString()} (${failure.id})`);
    const match = await resolveSessionId(failure, sessions, { apiKey: browserbaseApiKey });

    if (match.kind === "none") {
      skipped.push({ failure, why: "no Browserbase session overlaps this failure's timestamp" });
      console.log("  no overlapping session — skipped");
      continue;
    }
    if (match.kind === "ambiguous") {
      skipped.push({
        failure,
        why: `${match.candidateSessionIds.length} overlapping sessions, none uniquely on ${failure.ats} (${match.candidateSessionIds.join(", ")})`,
      });
      console.log(`  ambiguous — ${match.candidateSessionIds.length} candidates, skipped`);
      continue;
    }

    const videoPath = join(outDir, `${failure.id}.mp4`);
    try {
      console.log(`  session ${match.sessionId} (${match.kind}) — downloading replay…`);
      await downloadReplay(match.sessionId, videoPath, { apiKey: browserbaseApiKey });
      console.log("  asking Gemini for a play-by-play…");
      const text = await analyzeFailureVideo(videoPath, failure, { apiKey: geminiApiKey });
      analyzed.push({ failure, sessionId: match.sessionId, videoPath, text });
      console.log("  done");
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      skipped.push({ failure, why });
      console.error(`  failed: ${why}`);
    }
  }

  const reportPath = join(outDir, "report.md");
  await writeFile(reportPath, formatReport(analyzed, skipped));
  console.log(`\n${analyzed.length} analyzed, ${skipped.length} skipped. Report: ${reportPath}`);
}

function formatReport(analyzed: Analysis[], skipped: Skipped[]): string {
  const lines: string[] = [`# Failure recording analysis`, ``, `${analyzed.length} analyzed, ${skipped.length} skipped.`, ``];

  const byPlatform = new Map<string, Analysis[]>();
  for (const entry of analyzed) {
    const list = byPlatform.get(entry.failure.ats) ?? [];
    list.push(entry);
    byPlatform.set(entry.failure.ats, list);
  }

  for (const [platform, entries] of [...byPlatform.entries()].sort()) {
    lines.push(`## ${platform}`, ``);
    for (const entry of entries) {
      lines.push(
        `### ${entry.failure.reason} — ${entry.failure.createdAt.toISOString()}`,
        ``,
        `Session: \`${entry.sessionId}\` · Video: \`${entry.videoPath}\` · skip_log: \`${entry.failure.id}\``,
        ``,
        `Pipeline's own message: ${entry.failure.message}`,
        ``,
        entry.text,
        ``
      );
    }
  }

  if (skipped.length > 0) {
    lines.push(`## Skipped`, ``);
    for (const entry of skipped) {
      lines.push(`- \`${entry.failure.id}\` (${entry.failure.ats}/${entry.failure.reason}): ${entry.why}`);
    }
  }

  return lines.join("\n");
}

main()
  .catch((err: unknown) => {
    console.error(`[job-027] analyze-failures failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
