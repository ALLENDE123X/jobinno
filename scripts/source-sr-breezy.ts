#!/usr/bin/env node
/**
 * JOB-176: discovering SmartRecruiters and Breezy boards the existing
 * registry seeding never reaches.
 *
 * `lib/ats-boards.ts` seeds the registry from a fixed set of listing repos,
 * which is where the prior sourcing pass plateaued around 449 postings. This
 * script adds two discovery mechanisms that pass does not have:
 *
 *  · **SmartRecruiters global posting search.** The JSON endpoint behind the
 *    keyword search box on jobs.smartrecruiters.com answers across ALL SR
 *    tenants at once:
 *
 *        https://jobs.smartrecruiters.com/sr-jobs/search?keyword=<kw>&limit=100&offset=N
 *
 *    Public, unauthenticated. Two quirks found by probing it live shape how
 *    this script drives it:
 *
 *      - `totalFound` reports tens of thousands but `offset` past roughly one
 *        page changes nothing; every deep window repeats the same entries. A
 *        keyword therefore really holds about one hundred results, and this
 *        script stops sweeping a keyword the moment a page contributes no
 *        posting id it has not already seen, instead of walking a fake
 *        total.
 *
 *      - The keyword matches against location text as well as titles, so
 *        `software engineer san francisco` returns postings concentrated in
 *        California where bare `software engineer intern` returns a corpus
 *        dominated by overseas offices. The keyword list this script is run
 *        with exploits that: role phrases crossed with US cities and states
 *        are how a US biased candidate pool comes out of an unfilterable
 *        endpoint.
 *
 *    Each hit carries the tenant's identifier, so a sweep surfaces companies
 *    that have SWE roles open right now. The per tenant postings API under
 *    api.smartrecruiters.com has no such cross tenant search; a GET on
 *    `/v1/postings/search?q=...` answers 404.
 *
 *  · **Breezy subdomain validation.** Breezy publishes no global search, so
 *    candidate subdomains arrive from outside this script (the BuiltIn
 *    crawler in `scripts/scrape-builtin-sr-breezy.py`, or web search result
 *    dumps passed with --breezy-input) and are validated here against each
 *    board's own public feed, `{sub}.breezy.hr/json`.
 *
 * ── What this script deliberately does not do ───────────────────────────────
 * It writes nothing to the database. Discovery only produces a report; the
 * actual boards insert and job upsert run through the existing ingest
 * primitives in `scripts/ingest-discovered-boards.ts`, so the write path for
 * discovered boards is byte for byte the same path the daily sync uses.
 *
 * Relevance uses `classifyTitle` from `lib/ats-job-feeds.ts` directly rather
 * than a mirrored copy of its regexes. A private reimplementation could drift
 * from the real filter and nominate companies whose postings the ingest would
 * then throw away; importing it makes that impossible.
 *
 * The location bar for candidacy is US or remote, applied to whatever the ATS
 * itself reports (`location.country` / `location.remote` on SR search hits,
 * `location.country.id` / `location.is_remote` on Breezy feeds). A company is
 * nominated once it holds at least one relevant posting that clears the bar.
 *
 * Everything here is an unauthenticated GET plus local file writes. State is
 * checkpointed after every page and every board, so an interrupted sweep keeps
 * its work and resumes where it stopped.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// `.env.local` first, then `.env`, ambient environment beating both. Same order
// as every CLI in `lib/`. Only DATABASE_URL is read, inside loadKnownTokens().
const localEnv = config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

if (localEnv.error) {
  console.warn(
    "[job-176] No readable ../.env.local, so relying on the ambient environment " +
      "for DATABASE_URL."
  );
}

// Below the config() calls on purpose; nothing touched at evaluation time reads env.
import { classifyTitle } from "@/lib/ats-job-feeds";
import { closeDb, db } from "@/lib/db/client";
import { boards } from "@/lib/db/schema";

// ───────────────────────────────────
// Shapes
// ───────────────────────────────────

type SrPostingEvidence = {
  id: string;
  name: string;
  country: string;
  remote: boolean;
  releasedDate: string;
};

/** One SR tenant worth adding, with the postings that qualified it. */
type SrCandidate = {
  company: string | null;
  postings: Record<string, SrPostingEvidence>;
};

type BreezySamplePosting = { id: string; name: string; location: string };

/** One Breezy subdomain's validation verdict. */
type BreezyCandidate = {
  verdict: "kept" | "no_relevant" | "no_us_or_remote" | "empty" | "invalid" | "rate_limited";
  company: string | null;
  total: number;
  relevantCount: number;
  usOrRemoteRelevantCount: number;
  sample: BreezySamplePosting[];
};

type SourceState = {
  /** Keywords whose sweep finished; resumed runs skip these. */
  keywordsDone: string[];
  srSlugs: Record<string, SrCandidate>;
  breezy: Record<string, BreezyCandidate>;
  /**
   * Tenant ids checked by sr-validate and what happened, so a rerun neither
   * refetches a verdict nor loses one to rate limiting.
   */
  srChecks: Record<string, "checked" | "invalid" | "rate_limited">;
};

const USER_AGENT = "jobinno-board-sync";

const SR_SEARCH_URL = "https://jobs.smartrecruiters.com/sr-jobs/search";
/** Matches what readSmartRecruiters pages at. */
const SR_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function jittered(baseSeconds: number, spreadFraction = 0.4): number {
  return (baseSeconds + Math.random() * baseSeconds * spreadFraction) * 1000;
}

/**
 * Atomic state write: temp file then rename, so a crash mid write cannot leave
 * a truncated state file behind and silently lose a whole sweep's progress.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function fetchJson(url: string): Promise<{ status: number | null; body: unknown | null }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { status: null, body: null };
  }
  if (!response.ok) {
    await response.text().catch(() => "");
    return { status: response.status, body: null };
  }
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: response.status, body: null };
  }
}

// ───────────────────────────────────
// Known tokens
// ───────────────────────────────────

async function loadKnownTokens(): Promise<{ sr: Set<string>; breezy: Set<string> }> {
  const rows = await db()
    .select({ ats: boards.ats, boardToken: boards.boardToken })
    .from(boards);
  const known = { sr: new Set<string>(), breezy: new Set<string>() };
  for (const row of rows) {
    const token = row.boardToken.toLowerCase();
    if (row.ats === "smartrecruiters") known.sr.add(token);
    if (row.ats === "breezy") known.breezy.add(token);
  }
  return known;
}

// ───────────────────────────────────
// Mode one: SR global search
// ───────────────────────────────────

/** True when the ATS's own location fields say US or remote. */
function srLocationQualifies(location: Record<string, unknown>): boolean {
  const country = text(location.country).toLowerCase();
  return country === "us" || location.remote === true;
}

/**
 * One keyword, paged to exhaustion or to --max-pages-per-keyword.
 *
 * A page advances the offset by however many entries came back rather than by
 * the requested limit: this endpoint returns 98 entries for limit=100, so
 * trusting the requested size as the stride would loop forever on the same
 * window. Posting ids are the dedupe key, so any overlap between windows costs
 * nothing.
 *
 * Returns true when the keyword completed, false when it gave up partway (rate
 * limited or repeatedly erroring), so the caller leaves it off keywordsDone
 * and a rerun picks it back up.
 */
async function sweepKeyword(
  keyword: string,
  state: SourceState,
  opts: { maxPages: number; sleepSeconds: number }
): Promise<boolean> {
  let offset = 0;
  let totalFound = 0;
  let retryStreak = 0;
  // The endpoint repeats itself past the first page or two (see the header),
  // so a page whose every id is already in here means pagination is dead and
  // further requests would buy nothing.
  const seenThisKeyword = new Set<string>();

  for (let page = 0; page < opts.maxPages; page += 1) {
    const params = new URLSearchParams({
      keyword,
      limit: String(SR_PAGE_SIZE),
      offset: String(offset),
    });
    const { status, body } = await fetchJson(`${SR_SEARCH_URL}?${params.toString()}`);
    await sleep(jittered(opts.sleepSeconds));

    if (status === 429 || status === null || (status >= 500 && status < 600)) {
      retryStreak += 1;
      console.warn(`[job-176] ${keyword}: status ${status ?? "network"} at offset ${offset}, ` +
        `backing off 30s (streak ${retryStreak})`);
      if (retryStreak >= 3) {
        console.warn(`[job-176] ${keyword}: giving up at offset ${offset}; rerun resumes here`);
        return false;
      }
      await sleep(30_000);
      continue;
    }
    if (status !== 200 || !body || typeof body !== "object") {
      console.warn(`[job-176] ${keyword}: unexpected status ${status} at offset ${offset}, skipping`);
      break;
    }

    retryStreak = 0;
    const payload = record(body);
    totalFound = typeof payload.totalFound === "number" ? payload.totalFound : totalFound;
    const content = Array.isArray(payload.content) ? payload.content : [];
    if (content.length === 0) break;

    let freshOnPage = 0;
    let relevantOnPage = 0;
    for (const entry of content) {
      const posting = record(entry);
      const nativeId = text(posting.id);
      if (nativeId === "") continue;
      if (!seenThisKeyword.has(nativeId)) {
        seenThisKeyword.add(nativeId);
        freshOnPage += 1;
      }

      const title = text(posting.name);
      const companyRef = record(posting.company);
      const slug = text(companyRef.identifier).toLowerCase();
      if (title === "" || slug === "") continue;

      // Relevance first: a posting that fails classifyTitle never nominates
      // anybody, no matter where it sits.
      if (!classifyTitle(title).relevant) continue;
      const location = record(posting.location);
      if (!srLocationQualifies(location)) continue;

      const bucket = state.srSlugs[slug] ?? { company: null, postings: {} };
      bucket.company = text(companyRef.name) || bucket.company;
      bucket.postings[nativeId] = {
        id: nativeId,
        name: title,
        country: text(location.country),
        remote: location.remote === true,
        releasedDate: text(posting.releasedDate),
      };
      state.srSlugs[slug] = bucket;
      relevantOnPage += 1;
    }
    if (relevantOnPage > 0) {
      console.log(`[job-176] ${keyword}: offset ${offset}, ${relevantOnPage} qualifying posting(s), ` +
        `${Object.keys(state.srSlugs).length} distinct slugs so far`);
    }
    if (freshOnPage === 0) {
      console.log(`[job-176] ${keyword}: page repeated known postings at offset ${offset}, stopping`);
      break;
    }

    offset += content.length;
    if (offset >= totalFound) break;
  }

  console.log(`[job-176] ${keyword}: swept ${Math.min(offset, totalFound)} of ${totalFound}`);
  return true;
}

async function runSrSearch(
  keywords: readonly string[],
  state: SourceState,
  opts: { maxPages: number; sleepSeconds: number },
  save: () => void
): Promise<void> {
  for (const keyword of keywords) {
    if (state.keywordsDone.includes(keyword)) {
      console.log(`[job-176] ${keyword}: already done in earlier run`);
      continue;
    }
    const completed = await sweepKeyword(keyword, state, opts);
    if (completed) state.keywordsDone.push(keyword);
    save();
  }
}

// ───────────────────────────────────
// Mode two: Breezy validation
// ───────────────────────────────────

const BREEZY_SUB_RE = /([a-z0-9][a-z0-9-]*)\.breezy\.hr/gi;

/** Subdomains found in pasted web search output, lowercased and deduped. */
export function extractBreezySubdomains(raw: string): string[] {
  const found = new Set<string>();
  for (const match of raw.matchAll(BREEZY_SUB_RE)) {
    const sub = match[1].toLowerCase();
    // The vendor's own docs site and marketing pages are not hiring boards.
    if (sub !== "www" && sub !== "app" && sub !== "help") found.add(sub);
  }
  return [...found];
}

/** First path segment of a jobs.smartrecruiters.com URL is the tenant id. */
const SR_COMPANY_URL_RE = /jobs\.smartrecruiters\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)/gi;

/** Tenant ids found in pasted web search output, deduped case insensitively. */
export function extractSrSlugs(raw: string): string[] {
  const found = new Map<string, string>();
  for (const match of raw.matchAll(SR_COMPANY_URL_RE)) {
    const identifier = match[1];
    // The API spells tenant ids CamelCase (DeliveryHero, BoschGroup); keep the
    // first casing seen and key the map lowercased so repeats collapse.
    const key = identifier.toLowerCase();
    if (["www", "app", "careers", "help"].includes(key)) continue;
    if (!found.has(key)) found.set(key, identifier);
  }
  return [...found.values()];
}

/** Same location bar as SR, over Breezy's structured location object. */
function breezyLocationQualifies(location: Record<string, unknown>): boolean {
  const country = record(location.country);
  return text(country.id).toLowerCase() === "us" || location.is_remote === true;
}

class RateLimitStop extends Error {}

/**
 * Validate one subdomain against its own public feed.
 *
 * Kept means: at least one title passing classifyTitle AND at least one such
 * title whose location says US or remote. Both counts travel separately on the
 * verdict so a board full of relevant overseas roles stays visible in the
 * report instead of being indistinguishable from a board with nothing.
 */
async function validateBreezy(
  sub: string,
  state: SourceState,
  paceMs: () => number,
  rate: { consecutive429: number }
): Promise<void> {
  const { status, body } = await fetchJson(`https://${sub}.breezy.hr/json`);
  await sleep(paceMs());

  if (status === 429) {
    rate.consecutive429 += 1;
    state.breezy[sub] = {
      verdict: "rate_limited", company: null, total: 0,
      relevantCount: 0, usOrRemoteRelevantCount: 0, sample: [],
    };
    if (rate.consecutive429 >= 12) {
      throw new RateLimitStop("12 consecutive rate limited responses");
    }
    return;
  }
  rate.consecutive429 = 0;

  if (status !== 200 || !Array.isArray(body)) {
    state.breezy[sub] = {
      verdict: "invalid", company: null, total: 0,
      relevantCount: 0, usOrRemoteRelevantCount: 0, sample: [],
    };
    return;
  }
  if (body.length === 0) {
    state.breezy[sub] = {
      verdict: "empty", company: null, total: 0,
      relevantCount: 0, usOrRemoteRelevantCount: 0, sample: [],
    };
    return;
  }

  let company: string | null = null;
  let relevantCount = 0;
  let usOrRemote = 0;
  const sample: BreezySamplePosting[] = [];
  for (const entry of body) {
    const posting = record(entry);
    const nativeId = text(posting.id);
    const title = text(posting.name);
    if (nativeId === "" || title === "") continue;
    company = company ?? (text(record(record(posting.company)).name) || null);
    if (!classifyTitle(title).relevant) continue;
    relevantCount += 1;
    const location = record(posting.location);
    if (!breezyLocationQualifies(location)) continue;
    usOrRemote += 1;
    if (sample.length < 5) {
      sample.push({ id: nativeId, name: title, location: text(location.name) });
    }
  }

  state.breezy[sub] = {
    // Relevant but nowhere hireable in scope is recorded distinctly: those
    // boards exist and work, they just hold nobody this product serves.
    verdict: usOrRemote > 0 ? "kept" : relevantCount > 0 ? "no_us_or_remote" : "no_relevant",
    company, total: body.length, relevantCount, usOrRemoteRelevantCount: usOrRemote, sample,
  };
}

async function runBreezyValidation(
  subs: readonly string[],
  state: SourceState,
  paceMs: () => number,
  save: () => void
): Promise<void> {
  const rate = { consecutive429: 0 };
  // Four at a time is politeness, matching ingestBoards' own ceiling.
  const queue = [...subs];
  let done = 0;
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const sub = queue.shift();
      if (sub === undefined || rate.consecutive429 >= 12) return;
      await validateBreezy(sub, state, paceMs, rate);
      done += 1;
      if (done % 20 === 0) {
        const kept = Object.values(state.breezy).filter((b) => b.verdict === "kept").length;
        console.log(`[job-176] breezy: validated ${done}/${subs.length}, ${kept} kept`);
        save();
      }
    }
  });
  try {
    await Promise.all(workers);
  } catch (err) {
    if (!(err instanceof RateLimitStop)) throw err;
    console.warn("[job-176] breezy: hard stop on repeated rate limiting; progress saved");
  }
  save();
}

// ───────────────────────────────────
// Mode three: SR tenant validation
// ───────────────────────────────────

/**
 * Same depth readSmartRecruiters pages at: five pages of one hundred. A verdict
 * reached on less would nominate tenants whose qualifying postings sit past the
 * cap the real ingest enforces, and those nominations would ingest to nothing.
 */
const SR_VALIDATE_MAX_PAGES = 5;

/** The per company feed's location object carries country and, on some
 *  postings, a remote flag; remote also shows up spelled out in text. */
function srFeedLocationQualifies(location: Record<string, unknown>): boolean {
  if (text(location.country).toLowerCase() === "us" || location.remote === true) return true;
  return /remote/i.test(text(location.fullLocation));
}

async function validateSr(
  identifier: string,
  state: SourceState,
  paceMs: () => number,
  rate: { consecutive429: number }
): Promise<void> {
  const slug = identifier.toLowerCase();
  let company: string | null = null;
  let usOrRemote = 0;
  const evidence: Record<string, SrPostingEvidence> = {};
  let sawAnyPosting = false;
  let lastStatus: number | null = null;

  for (let page = 0; page < SR_VALIDATE_MAX_PAGES; page += 1) {
    const { status, body } = await fetchJson(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(identifier)}` +
        `/postings?limit=100&offset=${page * 100}`
    );
    await sleep(paceMs());
    lastStatus = status;
    if (status === 429) {
      rate.consecutive429 += 1;
      state.srChecks[slug] = "rate_limited";
      if (rate.consecutive429 >= 12) throw new RateLimitStop("12 consecutive rate limited responses");
      return;
    }
    rate.consecutive429 = 0;
    if (status !== 200) break;

    const payload = record(body);
    const content = Array.isArray(payload.content) ? payload.content : [];
    for (const entry of content) {
      const posting = record(entry);
      const nativeId = text(posting.id);
      const title = text(posting.name);
      if (nativeId === "" || title === "") continue;
      sawAnyPosting = true;
      company = company ?? (text(record(record(posting.company)).name) || null);
      if (!classifyTitle(title).relevant) continue;
      const location = record(posting.location);
      if (!srFeedLocationQualifies(location)) continue;
      usOrRemote += 1;
      if (Object.keys(evidence).length < 5) {
        evidence[nativeId] = {
          id: nativeId,
          name: title,
          country: text(location.country),
          remote: location.remote === true || /remote/i.test(text(location.fullLocation)),
          releasedDate: text(posting.releasedDate),
        };
      }
    }
    if (content.length < 100) break;
  }

  // A tenant id that never answered 200 is a guess that missed, not a board.
  state.srChecks[slug] = lastStatus !== 200 && !sawAnyPosting ? "invalid" : "checked";
  // Five sample postings are evidence enough for the report; the ingest re
  // reads the whole feed through the production reader anyway.
  if (usOrRemote > 0) state.srSlugs[slug] = { company, postings: evidence };
}

async function runSrValidation(
  identifiers: readonly string[],
  state: SourceState,
  paceMs: () => number,
  save: () => void
): Promise<void> {
  const rate = { consecutive429: 0 };
  const queue = [...identifiers];
  let done = 0;
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const identifier = queue.shift();
      if (identifier === undefined || rate.consecutive429 >= 12) return;
      await validateSr(identifier, state, paceMs, rate);
      done += 1;
      if (done % 20 === 0) {
        console.log(`[job-176] sr-validate: checked ${done}/${identifiers.length}, ` +
          `${Object.keys(state.srSlugs).length} slug(s) qualified so far`);
        save();
      }
    }
  });
  try {
    await Promise.all(workers);
  } catch (err) {
    if (!(err instanceof RateLimitStop)) throw err;
    console.warn("[job-176] sr-validate: hard stop on repeated rate limiting; progress saved");
  }
  save();
}

// ───────────────────────────────────
// Report
// ───────────────────────────────────

/**
 * Candidates minus every token already registered, so the ingest driver can
 * insert exactly this file's contents without rechecking anything.
 */
function buildReport(
  state: SourceState,
  known: { sr: Set<string>; breezy: Set<string> }
): { generatedAt: string; smartrecruiters: Record<string, SrCandidate>; breezy: Record<string, BreezyCandidate> } {
  const smartrecruiters: Record<string, SrCandidate> = {};
  for (const [slug, candidate] of Object.entries(state.srSlugs)) {
    if (!known.sr.has(slug)) smartrecruiters[slug] = candidate;
  }
  const breezy: Record<string, BreezyCandidate> = {};
  for (const [sub, candidate] of Object.entries(state.breezy)) {
    if (candidate.verdict === "kept" && !known.breezy.has(sub)) breezy[sub] = candidate;
  }
  return { generatedAt: new Date().toISOString(), smartrecruiters, breezy };
}

// ───────────────────────────────────
// CLI
// ───────────────────────────────────

const USAGE = [
  "Usage:",
  "  npx tsx scripts/source-sr-breezy.ts sr-search --keywords <file> \\",
  "      --state <file> --out <report.json> [--max-pages-per-keyword N] [--sleep S]",
  "  npx tsx scripts/source-sr-breezy.ts sr-validate --state <file> --out <report.json> \\",
  "      --sr-input <file> [--sr-input <more>...] [--sleep S]",
  "  npx tsx scripts/source-sr-breezy.ts breezy-validate --state <file> --out <report.json> \\",
  "      --breezy-input <file> [--breezy-input <more>...] [--sleep S]",
  "",
  "  --state     resumable checkpoint, written after every page and board",
  "  --out       report for scripts/ingest-discovered-boards.ts",
  "  --keywords  one keyword phrase per line",
  "  --sr-input  text files (or JSON discovery reports) that carry SR apply URLs",
  "  --breezy-input  text files (or JSON discovery reports) that carry Breezy apply URLs",
  "  --sleep     seconds between requests to the same host (default 1.2)",
].join("\n");

type Args = {
  mode: "sr-search" | "sr-validate" | "breezy-validate";
  keywordsFile?: string;
  statePath: string;
  outPath: string;
  srInputs: string[];
  breezyInputs: string[];
  maxPages: number;
  sleepSeconds: number;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    mode: "sr-search",
    statePath: "",
    outPath: "",
    srInputs: [],
    breezyInputs: [],
    maxPages: 20,
    sleepSeconds: 1.2,
  };
  if (argv.length === 0 || (argv[0] !== "sr-search" && argv[0] !== "sr-validate" && argv[0] !== "breezy-validate")) {
    console.error(USAGE);
    process.exit(2);
  }
  args.mode = argv[0] as Args["mode"];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const next = (): string => {
      index += 1;
      if (index >= argv.length) {
        console.error(`${token} needs a value\n\n${USAGE}`);
        process.exit(2);
      }
      return argv[index];
    };
    if (token === "--keywords") args.keywordsFile = next();
    else if (token === "--state") args.statePath = next();
    else if (token === "--out") args.outPath = next();
    else if (token === "--sr-input") args.srInputs.push(next());
    else if (token === "--breezy-input") args.breezyInputs.push(next());
    else if (token === "--max-pages-per-keyword") args.maxPages = Number(next());
    else if (token === "--sleep") args.sleepSeconds = Number(next());
    else {
      console.error(`Unknown argument ${JSON.stringify(token)}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  if (!args.statePath || !args.outPath) {
    console.error("--state and --out are both required\n\n" + USAGE);
    process.exit(2);
  }
  if (args.mode === "sr-search" && !args.keywordsFile) {
    console.error("sr-search needs --keywords\n\n" + USAGE);
    process.exit(2);
  }
  if (args.mode === "sr-validate" && args.srInputs.length === 0) {
    console.error("sr-validate needs at least one --sr-input\n\n" + USAGE);
    process.exit(2);
  }
  if (args.mode === "breezy-validate" && args.breezyInputs.length === 0) {
    console.error("breezy-validate needs at least one --breezy-input\n\n" + USAGE);
    process.exit(2);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const state: SourceState = { keywordsDone: [], srSlugs: {}, breezy: {}, srChecks: {} };
  try {
    Object.assign(state, JSON.parse(readFileSync(args.statePath, "utf8")));
    console.log(`[job-176] resumed state: ${Object.keys(state.srSlugs).length} SR slug(s), ` +
      `${Object.keys(state.breezy).length} Breezy check(s), ` +
      `${state.keywordsDone.length} keyword(s) done`);
  } catch {
    console.log("[job-176] starting fresh");
  }

  const known = await loadKnownTokens();
  console.log(`[job-176] registry already holds ${known.sr.size} SR and ${known.breezy.size} ` +
    `Breezy token(s); candidates among them are excluded from the report`);

  const save = (): void => {
    mkdirSync(dirname(resolve(args.statePath)), { recursive: true });
    writeJsonAtomic(args.statePath, state);
    writeJsonAtomic(args.outPath, buildReport(state, known));
  };

  if (args.mode === "sr-search") {
    const keywords = readFileSync(args.keywordsFile!, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    console.log(`[job-176] sweeping ${keywords.length} keyword(s)`);
    await runSrSearch(keywords, state, { maxPages: args.maxPages, sleepSeconds: args.sleepSeconds }, save);
  } else if (args.mode === "sr-validate") {
    const raw = args.srInputs.map((path) => readFileSync(path, "utf8")).join("\n");
    const identifiers = extractSrSlugs(raw).filter((identifier) => {
      const prior = state.srChecks[identifier.toLowerCase()];
      return prior === undefined || prior === "rate_limited";
    });
    console.log(`[job-176] validating ${identifiers.length} new SR tenant id(s)`);
    const paceMs = (): number => jittered(args.sleepSeconds);
    await runSrValidation(identifiers, state, paceMs, save);
  } else {
    const raw = args.breezyInputs.map((path) => readFileSync(path, "utf8")).join("\n");
    const subs = extractBreezySubdomains(raw).filter((sub) => {
      const prior = state.breezy[sub];
      // A rate limited check is unfinished business, everything else stands.
      return prior === undefined || prior.verdict === "rate_limited";
    });
    console.log(`[job-176] validating ${subs.length} new Breezy subdomain(s)`);
    const paceMs = (): number => jittered(args.sleepSeconds);
    await runBreezyValidation(subs, state, paceMs, save);
  }

  const report = JSON.parse(readFileSync(args.outPath, "utf8")) as ReturnType<typeof buildReport>;
  console.log(`[job-176] report ready: ${Object.keys(report.smartrecruiters).length} new SR candidate(s), ` +
    `${Object.keys(report.breezy).length} new Breezy candidate(s)`);
  console.log(`[job-176] state: ${args.statePath}`);
  console.log(`[job-176] report: ${args.outPath}`);
}

main()
  .catch((err: unknown) => {
    console.error(`[job-176] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
