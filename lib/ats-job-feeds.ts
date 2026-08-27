/**
 * JOB-003, part two: reading one board's current openings off the ATS
 * platform's own public API.
 *
 * Every endpoint below was called against a live board while this was written,
 * and the mapping under it describes the response that actually came back
 * rather than the one the vendor's documentation promises. The board used for
 * each check is named, so the claim can be rechecked in one command.
 *
 * ── The nine endpoints ──────────────────────────────────────────────────────
 *
 *  · **Greenhouse** `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`
 *    → `{ jobs: [{ id, title, location: { name }, absolute_url, updated_at,
 *    first_published, content, company_name }], meta: { total } }`.
 *    Checked against `dvtrading` (61 jobs) and `imc` (an EU hosted board, which
 *    the US API host serves without complaint).
 *
 *  · **Lever** `api.lever.co/v0/postings/{token}?mode=json`
 *    → a top level array of `{ id, text, categories: { location, … },
 *    descriptionPlain, createdAt, hostedUrl, applyUrl }`. The title is `text`.
 *    Checked against `belvederetrading` and `palantir`.
 *
 *  · **Ashby** `api.ashbyhq.com/posting-api/job-board/{board}`
 *    → `{ jobs: [{ id, title, location, publishedAt, descriptionPlain, jobUrl,
 *    applyUrl, isListed }] }`. Checked against `etched` (108 jobs).
 *
 *  · **Workable** `apply.workable.com/api/v1/widget/accounts/{acct}?details=true`
 *    → `{ name, jobs: [{ title, shortcode, city, state, country,
 *    application_url, published_on, description }] }`. The posting id is
 *    `shortcode`. Checked against `tmeic-corporation-americas`.
 *
 *  · **Recruitee** `{company}.recruitee.com/api/offers/`
 *    → `{ offers: [{ id, title, location, careers_url, careers_apply_url,
 *    published_at, description, company_name }] }`. Checked against
 *    `channable`, `bunq` and `effectory`.
 *
 *  · **Breezy** `{company}.breezy.hr/json`
 *    → a top level array of `{ id, name, url, published_date, location: { name },
 *    company: { name } }`. The title is `name`, and the list carries no
 *    description at all. Checked against `breezy`, the vendor's own board.
 *
 *  · **SmartRecruiters** `api.smartrecruiters.com/v1/companies/{co}/postings`
 *    → `{ offset, limit, totalFound, content: [{ id, name, releasedDate,
 *    location: { city, region, country, fullLocation }, company: { name } }] }`.
 *    The title is `name`, the page size caps at 100, and the list carries no
 *    description. Checked against `AveryDennison` (423 postings).
 *
 *  · **BambooHR** `{company}.bamboohr.com/careers/list`
 *    → `{ meta: { totalCount }, result: [{ id, jobOpeningName,
 *    location: { city, state }, departmentLabel }] }`. Checked against
 *    `specteraerospace`. This one is a find rather than a given: the ticket
 *    expected BambooHR to have no simple public JSON list, and it has one.
 *
 *  · **Teamtailor** `{company}.teamtailor.com/jobs.json`
 *    → a JSON Feed 1.1 document, `{ items: [{ id, title, url, date_published,
 *    content_html, _jobposting }] }`, where `_jobposting` is a schema.org
 *    JobPosting carrying the locations. Checked against `tibber`, `lunar`,
 *    `templafy` and `hedvig`. Also a find: Teamtailor's documented API at
 *    api.teamtailor.com needs a per customer token, and this needs none.
 *
 * ── The one platform with no public list, and why ───────────────────────────
 * **JazzHR** (`{company}.applytojob.com`) is registered but not ingested. Its
 * career site 404s on every candidate endpoint tried (`/apply/jobs/feed`, the
 * same with `?format=json`, `/apply/jobs.json`, `/api/v1/jobs`), and its
 * real jobs API, `api.resumatorapi.com/v1/jobs`, answers `{"error":"apikey not
 * set"}`, meaning a per customer key that no candidate side integration has.
 * Boards still get registry rows, so nothing is lost when a route is found;
 * `ingestBoard` returns `deferred` for them rather than pretending to sync.
 * Tracked as issue #7, split out of JOB-003 rather than blocking it.
 *
 * ── What comes out ──────────────────────────────────────────────────────────
 * One `FeedJob` shape, whatever the platform. Descriptions are reduced to plain
 * text and capped; the untouched vendor object goes to `jobs.raw`, because the
 * fields worth parsing next year are not the fields worth parsing today and a
 * listing that has closed cannot be fetched again.
 *
 * A job description is text an employer typed, reachable by anyone who can post
 * a job. Treat it as untrusted everywhere downstream, exactly as the ported
 * resume and form modules already do.
 *
 * Everything here is an unauthenticated GET. It writes nothing, to us or to any
 * ATS platform.
 */

import type { AtsPlatform } from "@/lib/db/schema";

// ───────────────────────────────────
// Shapes
// ───────────────────────────────────

/** One opening, normalised. Maps one to one onto a row of `jobs`. */
export type FeedJob = {
  /**
   * The value written to `jobs.external_id`: the ATS platform's own posting id,
   * prefixed with the board token.
   *
   * The prefix is not decoration. The unique key is `(ats, external_id)` rather
   * than `(board_id, external_id)`, and at least one supported platform numbers
   * its postings per tenant rather than globally: BambooHR's first posting is
   * `"72"` on one board and can be `"72"` on another. Unprefixed, the second
   * board's opening would silently overwrite the first's. Every platform is
   * prefixed rather than only the ones known to need it, so that the next
   * platform added cannot reintroduce the bug by being assumed global.
   */
  externalId: string;
  /** The posting id exactly as the platform reports it, unprefixed. */
  nativeId: string;
  title: string;
  location: string | null;
  /** Where a person applies. The vendor's own apply link wherever it publishes one. */
  url: string;
  /** Plain text, capped. UNTRUSTED, see the header. */
  description: string | null;
  postedAt: Date | null;
  /** The vendor's object for this posting, untouched. */
  raw: unknown;
};

export type BoardFeed = {
  /** The employer's name as the platform spells it, when it says. */
  company: string | null;
  jobs: FeedJob[];
};

export type BoardFeedResult =
  | { status: "ok"; feed: BoardFeed }
  | { status: "deferred"; reason: string }
  | { status: "failed"; reason: string };

/** Platforms with no public list endpoint. See the header for the evidence. */
export const DEFERRED_ATS: readonly AtsPlatform[] = ["jazzhr"];

/**
 * Sixty seconds, and it is the body rather than the connection that needs
 * them. `AbortSignal.timeout` covers the whole exchange including streaming,
 * and a whole Greenhouse board with descriptions attached is tens of megabytes:
 * `andurilindustries` publishes 2220 postings and timed out at thirty seconds
 * on the second real run of this sync, having loaded fine on the first.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const USER_AGENT = "jobinno-board-sync";
/** SmartRecruiters pages at 100. Five pages is 500 postings, which is a big board. */
const SMARTRECRUITERS_MAX_PAGES = 5;
/** Long enough for any real posting, short enough that one row cannot be a book. */
const MAX_DESCRIPTION_CHARS = 20_000;

// ───────────────────────────────────
// HTTP
// ───────────────────────────────────

type JsonResult = { ok: true; body: unknown } | { ok: false; error: string };

/**
 * One unauthenticated GET, JSON out, never throwing. Same reasoning as the
 * helper of the same name in `lib/search-job-listings.ts`: a board that has
 * gone away and a request that failed are different facts, and the caller has
 * to be able to tell them apart without a try block around every call.
 */
async function getJson(url: string): Promise<JsonResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    // Drain the body so the socket is released rather than left to the GC.
    await response.text().catch(() => "");
    return { ok: false, error: `HTTP ${response.status}` };
  }

  try {
    return { ok: true, body: await response.json() };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `unparseable JSON: ${reason}` };
  }
}

// ───────────────────────────────────
// Field helpers
// ───────────────────────────────────

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed !== "") return trimmed;
  }
  return null;
}

/** A date the platform reported, or null. Epoch milliseconds and ISO both occur. */
function parseDate(value: unknown): Date | null {
  if (typeof value === "number") {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }
  const raw = text(value);
  if (raw === "") return null;
  // Recruitee reports "2026-08-03 15:40:43 UTC", which Date rejects as written.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/.test(raw)
    ? raw.replace(" ", "T").replace(" UTC", "Z")
    : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * HTML in, readable plain text out, capped.
 *
 * Greenhouse is the reason the unescape runs twice: `content` arrives entity
 * escaped, so the markup itself is spelled `&lt;p&gt;` and one pass produces
 * tags rather than text. Two passes is enough for every payload checked, and
 * the loop is bounded rather than run to a fixed point so that a crafted
 * description cannot spin it.
 */
export function toPlainText(value: unknown): string | null {
  let working = text(value);
  if (working === "") return null;

  for (let pass = 0; pass < 2; pass += 1) {
    working = working.replace(/&(#?\w+);/g, (match, name: string) => {
      const named = HTML_ENTITIES[name.toLowerCase()];
      if (named !== undefined) return named;
      const numeric = /^#(\d+)$/.exec(name);
      return numeric ? String.fromCodePoint(Number(numeric[1])) : match;
    });
  }

  const plain = working
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    // The literal is spelled as an escape on purpose: a non breaking space in
    // source is invisible to a reader and to most diffs.
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (plain === "") return null;
  return plain.length > MAX_DESCRIPTION_CHARS ? plain.slice(0, MAX_DESCRIPTION_CHARS) : plain;
}

/** `boardToken:nativeId`. See `FeedJob["externalId"]` for why. */
export function qualifyExternalId(boardToken: string, nativeId: string): string {
  return `${boardToken.toLowerCase()}:${nativeId}`;
}

// ───────────────────────────────────
// Relevance
// ───────────────────────────────────

/**
 * What a title says about who a listing is for.
 *
 * Three regular expressions, and the shape of each was decided by a title that
 * really appeared in a board read while writing this:
 *
 *  · `INTERN_RE` requires a word boundary. `/intern/` without one matches
 *    "Design Verification Engineer, Internal IP", a real Ashby posting for a
 *    staff engineer, and every board has titles like it.
 *
 *  · `NEW_GRAD_RE` allows a space, a hyphen or nothing between "new" and
 *    "grad", because all three spellings occur, and accepts "graduate" as the
 *    long form of the same word.
 *
 *  · `SWE_RE` requires a word boundary around "swe" for the same reason as
 *    "intern": bare `/swe/` matches "Sweden", so "Sales Representative, Sweden"
 *    would enter the pipeline as a software role.
 *
 * The exclusions are seniority words, plus "sr", which the first real sync run
 * made necessary: SpaceX and Anduril both write "Sr. Software Engineer" and not
 * "Senior Software Engineer", so a list of whole words alone let several
 * hundred experienced roles through.
 *
 * The exclusions lose to an explicit internship: "Software Engineering Manager
 * Intern" is an internship whatever else the title says, and dropping it would
 * be the expensive mistake of the two. Everything else about the filter is
 * deliberately narrow, on the reasoning `lib/search-job-listings.ts` already
 * sets out for its own title match: a false positive is a real application
 * sent to a job the candidate never asked for.
 *
 * ── Discipline and seniority are both required, not either ──────────────────
 * `relevant` used to be `isIntern || isNewGrad || SWE_RE.test(title)`, and that
 * "or" is the whole reason this section is here. It let a title through on the
 * seniority word alone, so "Marketing Intern", "Legal Intern", "Investment
 * Banking Summer Analyst Internship", "University Relations Coordinator" and
 * "Early Career Sales Associate" were all written to `jobs` as relevant.
 *
 * None of those is a hypothetical. On the live table, 289 of the 958 rows
 * ingested under the old rule carried `is_intern` or `is_new_grad` with a title
 * naming no software role at all: "Intern - Maintenance Technician", "Finance
 * Intern - Summer 2027", "Intern, Commodity Sourcing", "Environmental Health &
 * Safety Intern", "2027 Point72 Academy Investment Analyst Summer Internship".
 * A further 559 were neither an internship nor a new grad role.
 *
 * That is not a cosmetic mislabel. `matchJobsForUser` is title blind whenever
 * no title is supplied, which is always true of the daily cron, so every one of
 * those rows was a listing a real browser could be sent to apply to, against a
 * paying person's finite application allowance, for a job in a discipline this
 * product does not serve. The product's scope is CS interns and new graduates
 * in software engineering roles, so the test is both halves: a software title,
 * AND an internship or a new grad role.
 *
 * What that costs, stated rather than hidden. Two classes are now dropped that
 * were kept before, and both are deliberate:
 *
 *  · A plain "Software Engineer" with no seniority word says nothing about
 *    being open to a new graduate, and hundreds of them are ordinary mid level
 *    postings. `is_intern` and `is_new_grad` no longer merely annotate the
 *    table; they are a condition of being in it.
 *  · A software internship whose title spells the discipline some other way —
 *    "Software Development Engineer Intern", "New Grad Backend Engineer" —
 *    fails `SWE_RE` and is dropped. Widening the discipline vocabulary is a
 *    real improvement to make, and is a deliberate change to `SWE_RE` with its
 *    own evidence, not a side effect of this one.
 *
 * ── JOB-183: the evidence for widening `SWE_RE` and `NEW_GRAD_RE` ───────────
 * The paragraph above named this as its own ticket with its own evidence, and
 * JOB-176's sourcing dispatch supplied it: 21 newly registered SmartRecruiters
 * boards, sourced specifically from GitHub new grad listing repos, produced
 * zero postings that cleared this filter. A cross employer keyword search
 * across 65 SR keywords plus a BuiltIn crawl surfaced dozens more candidate
 * boards and hit the same wall (issue #182). The bottleneck was this
 * classifier's vocabulary, not the discovery mechanisms feeding it.
 *
 * `SWE_RE` widens from "software engineer" and "swe" to the other names real
 * boards give the same job: "software developer", "backend engineer",
 * "frontend engineer", "full stack engineer" (and "fullstack" / "full-stack"),
 * "platform engineer", "applications engineer", "web developer", "mobile
 * engineer", "ios engineer", "android engineer", "machine learning engineer"
 * (and "ml engineer"), "ai engineer", "data engineer", "devops engineer",
 * "site reliability engineer" (and "sre"), and "junior developer" / "junior
 * engineer". Two titles pulled live from the `jobs` table prove the gap this
 * closes: "Intern - Software Developer (Studying Bachelor Degree) - Start in
 * January 2027" and "Web Developer - Entry Level" both currently fail
 * `classifyTitle` even though both are exactly this product's audience.
 *
 * `NEW_GRAD_RE` widens from "new grad", "early career" and "university" to
 * also accept "entry level" (and "entry-level" / "entrylevel"), "graduate
 * program", "campus" (which also covers "campus hire"), and "class of
 * <year>" for any year rather than hardcoding 2026 and 2027, so this list
 * does not need a ticket every January to stay current. "Intern" and
 * "internship" are deliberately NOT added here even though JOB-183 listed
 * them as a plausible seniority signal: `isIntern` already carries that
 * signal into `matchesInterest` below through its own regex, and folding it
 * into `isNewGrad` too would flip `is_new_grad` true on every internship
 * posting. `internshipStagePredicate` in `lib/job-matching.ts` reads
 * `is_new_grad OR NOT is_intern` for a non-intern seeking user specifically
 * because `is_new_grad` and `is_intern` are assumed mutually informative but
 * not both true on an internship row; making that assumption false would
 * leak internships into full time new grad search results.
 *
 * The AND gate itself, and the seniority exclusion's list of words, are
 * unchanged in shape by this widening: a title still needs a role signal AND
 * a career stage signal, and an explicit internship still outranks every
 * seniority word for the reason given above. Two words join the seniority
 * exclusion list itself: "vp" and "head of" / "vice president" name the same
 * kind of role the existing list already excludes and were simply missing.
 *
 * `NON_ENGINEERING_ROLE_RE` is new: a title naming sales, marketing, a
 * product manager, a designer, a design engineer or a recruiter is rejected
 * outright, intern or not. Nothing in the current `SWE_RE` vocabulary matches
 * any of those phrases on its own, so this rule does not change any of
 * today's outcomes; it exists so the next widening of `SWE_RE` does not have
 * to re-derive this exclusion list from scratch to stay safe.
 */
const INTERN_RE = /\bintern(ship|ships|s)?\b/i;
const NEW_GRAD_RE =
  /\bnew[\s-]?grad(uate|uates|s)?\b|\bearly[\s-]?career\b|\buniversity\b|\bentry[\s-]?level\b|\bgraduate\s+program\b|\bcampus\b|\bclass\s+of\s+20\d{2}\b/i;
const SWE_RE =
  /\bsoftware\s+engineer|\bswe\b|\bsoftware\s+developer|\bback[\s-]?end\s+engineer|\bfront[\s-]?end\s+engineer|\bfull[\s-]?stack\s+engineer|\bplatform\s+engineer|\bapplications?\s+engineer|\bweb\s+developer|\bmobile\s+engineer|\bios\s+engineer|\bandroid\s+engineer|\bmachine\s+learning\s+engineer|\bml\s+engineer|\bai\s+engineer|\bdata\s+engineer|\bdevops\s+engineer|\bsite\s+reliability\s+engineer|\bsre\b|\bjunior\s+developer|\bjunior\s+engineer/i;
const SENIORITY_RE =
  /\b(senior|sr|staff|principal|manager|director|vp)\b|\blead\b|\bhead\s+of\b|\bvice\s+president\b/i;
const NON_ENGINEERING_ROLE_RE =
  /\bsales\b|\bmarketing\b|\bproduct\s+manager\b|\bdesigner\b|\bdesign\s+engineer\b|\brecruiter\b|\bfield\s+applications?\s+engineer\b/i;

export type TitleRelevance = {
  /** Whether this listing belongs in `jobs` at all. */
  relevant: boolean;
  isIntern: boolean;
  isNewGrad: boolean;
};

export function classifyTitle(rawTitle: string): TitleRelevance {
  const title = String(rawTitle ?? "");

  const isIntern = INTERN_RE.test(title);
  const isNewGrad = NEW_GRAD_RE.test(title);
  // Both, not either: the discipline and the career stage. See above for what
  // the "or" this replaced actually admitted, and for what the "and" costs.
  const matchesInterest = SWE_RE.test(title) && (isIntern || isNewGrad);

  // An explicit internship outranks every seniority word. See above.
  const passesSeniorityGate = isIntern || !SENIORITY_RE.test(title);

  // Defense in depth for the widened `SWE_RE`: a non-engineering discipline
  // word rejects the title outright, intern or not, so a future widening
  // that accidentally admits a phrase like "design engineer" does not also
  // have to get this list right on its own. See above.
  const isNonEngineeringRole = NON_ENGINEERING_ROLE_RE.test(title);

  const relevant = matchesInterest && passesSeniorityGate && !isNonEngineeringRole;

  return { relevant, isIntern, isNewGrad };
}

// ───────────────────────────────────
// Per platform readers
// ───────────────────────────────────

type Reader = (boardToken: string) => Promise<BoardFeedResult>;

function failed(reason: string): BoardFeedResult {
  return { status: "failed", reason };
}

function ok(company: string | null, jobs: FeedJob[]): BoardFeedResult {
  return { status: "ok", feed: { company, jobs } };
}

const readGreenhouse: Reader = async (boardToken) => {
  const url =
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs` +
    `?content=true`;
  const result = await getJson(url);
  if (!result.ok) return failed(result.error);

  const raw = record(result.body);
  const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  let company: string | null = null;

  const mapped: FeedJob[] = [];
  for (const entry of jobs) {
    const job = record(entry);
    const nativeId = text(job.id);
    const title = text(job.title);
    if (nativeId === "" || title === "") continue;
    company ??= firstNonEmpty(text(job.company_name));

    mapped.push({
      externalId: qualifyExternalId(boardToken, nativeId),
      nativeId,
      title,
      location: firstNonEmpty(text(record(job.location).name)),
      // Not `absolute_url`: ACT-018 established that Greenhouse's own field is
      // frequently the employer's marketing page with no form on it, while the
      // embed URL is the bare application form for every board it checked.
      // `lib/search-job-listings.ts` carries the full evidence.
      url:
        `https://job-boards.greenhouse.io/embed/job_app` +
        `?for=${encodeURIComponent(boardToken)}&token=${encodeURIComponent(nativeId)}`,
      description: toPlainText(job.content),
      postedAt: parseDate(job.first_published) ?? parseDate(job.updated_at),
      raw: entry,
    });
  }

  return ok(company, mapped);
};

const readLever: Reader = async (boardToken) => {
  const result = await getJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(boardToken)}?mode=json`
  );
  if (!result.ok) return failed(result.error);
  if (!Array.isArray(result.body)) return failed("expected a top level array of postings");

  const mapped: FeedJob[] = [];
  for (const entry of result.body) {
    const job = record(entry);
    const nativeId = text(job.id);
    // Lever calls the title `text`. Nothing else on the object is one.
    const title = text(job.text);
    if (nativeId === "" || title === "") continue;

    const categories = record(job.categories);
    mapped.push({
      externalId: qualifyExternalId(boardToken, nativeId),
      nativeId,
      title,
      location: firstNonEmpty(text(categories.location), text(job.country)),
      url: firstNonEmpty(text(job.applyUrl), text(job.hostedUrl)) ?? "",
      description: toPlainText(job.descriptionPlain) ?? toPlainText(job.description),
      postedAt: parseDate(job.createdAt),
      raw: entry,
    });
  }

  return ok(null, mapped.filter((job) => job.url !== ""));
};

const readAshby: Reader = async (boardToken) => {
  const result = await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardToken)}`
  );
  if (!result.ok) return failed(result.error);

  const jobs = record(result.body).jobs;
  if (!Array.isArray(jobs)) return failed("expected a jobs array");

  const mapped: FeedJob[] = [];
  for (const entry of jobs) {
    const job = record(entry);
    const nativeId = text(job.id);
    const title = text(job.title);
    // `isListed: false` is a posting the employer has taken off its own board.
    if (nativeId === "" || title === "" || job.isListed === false) continue;

    mapped.push({
      externalId: qualifyExternalId(boardToken, nativeId),
      nativeId,
      title,
      location: firstNonEmpty(text(job.location)),
      url: firstNonEmpty(text(job.applyUrl), text(job.jobUrl)) ?? "",
      description: toPlainText(job.descriptionPlain),
      postedAt: parseDate(job.publishedAt),
      raw: entry,
    });
  }

  return ok(null, mapped.filter((job) => job.url !== ""));
};

const readWorkable: Reader = async (boardToken) => {
  const result = await getJson(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(boardToken)}` +
      `?details=true`
  );
  if (!result.ok) return failed(result.error);

  const account = record(result.body);
  const jobs = Array.isArray(account.jobs) ? account.jobs : [];

  const mapped: FeedJob[] = [];
  for (const entry of jobs) {
    const job = record(entry);
    // Workable's posting id is its shortcode; there is no numeric id field.
    const nativeId = text(job.shortcode);
    const title = text(job.title);
    if (nativeId === "" || title === "") continue;

    mapped.push({
      externalId: qualifyExternalId(boardToken, nativeId),
      nativeId,
      title,
      location:
        firstNonEmpty(
          [text(job.city), text(job.state), text(job.country)].filter(Boolean).join(", ")
        ) ?? null,
      url:
        firstNonEmpty(text(job.application_url), text(job.url), text(job.shortlink)) ??
        `https://apply.workable.com/${encodeURIComponent(boardToken)}/j/${nativeId}/`,
      description: toPlainText(job.description),
      postedAt: parseDate(job.published_on) ?? parseDate(job.created_at),
      raw: entry,
    });
  }

  return ok(firstNonEmpty(text(account.name)), mapped);
};

const readRecruitee: Reader = async (boardToken) => {
  const result = await getJson(
    `https://${encodeURIComponent(boardToken)}.recruitee.com/api/offers/`
  );
  if (!result.ok) return failed(result.error);

  const offers = record(result.body).offers;
  if (!Array.isArray(offers)) return failed("expected an offers array");

  let company: string | null = null;
  const mapped: FeedJob[] = [];
  for (const entry of offers) {
    const offer = record(entry);
    const nativeId = text(offer.id);
    const title = text(offer.title);
    if (nativeId === "" || title === "") continue;
    company ??= firstNonEmpty(text(offer.company_name));

    mapped.push({
      externalId: qualifyExternalId(boardToken, nativeId),
      nativeId,
      title,
      location: firstNonEmpty(text(offer.location), text(offer.city)),
      url:
        firstNonEmpty(text(offer.careers_apply_url), text(offer.careers_url)) ??
        `https://${boardToken}.recruitee.com/o/${text(offer.slug)}`,
      description: toPlainText(offer.description),
      postedAt: parseDate(offer.published_at) ?? parseDate(offer.created_at),
      raw: entry,
    });
  }

  return ok(company, mapped);
};

const readBreezy: Reader = async (boardToken) => {
  const result = await getJson(`https://${encodeURIComponent(boardToken)}.breezy.hr/json`);
  if (!result.ok) return failed(result.error);
  if (!Array.isArray(result.body)) return failed("expected a top level array of positions");

  let company: string | null = null;
  const mapped: FeedJob[] = [];
  for (const entry of result.body) {
    const job = record(entry);
    const nativeId = text(job.id);
    // Breezy calls the title `name`, and calls the company `company.name`.
    const title = text(job.name);
    if (nativeId === "" || title === "") continue;
    company ??= firstNonEmpty(text(record(job.company).name));

    mapped.push({
      externalId: qualifyExternalId(boardToken, nativeId),
      nativeId,
      title,
      location: firstNonEmpty(text(record(job.location).name)),
      url:
        firstNonEmpty(text(job.url)) ??
        `https://${boardToken}.breezy.hr/p/${text(job.friendly_id) || nativeId}`,
      // The list carries no description. A per posting fetch would, and is not
      // worth one request per job for a field nothing reads yet.
      description: null,
      postedAt: parseDate(job.published_date),
      raw: entry,
    });
  }

  return ok(company, mapped);
};

const readSmartRecruiters: Reader = async (boardToken) => {
  let company: string | null = null;
  const mapped: FeedJob[] = [];

  for (let page = 0; page < SMARTRECRUITERS_MAX_PAGES; page += 1) {
    const result = await getJson(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(boardToken)}/postings` +
        `?limit=100&offset=${page * 100}`
    );
    if (!result.ok) return page === 0 ? failed(result.error) : ok(company, mapped);

    const body = record(result.body);
    const content = Array.isArray(body.content) ? body.content : [];

    for (const entry of content) {
      const posting = record(entry);
      const nativeId = text(posting.id);
      // SmartRecruiters calls the title `name`.
      const title = text(posting.name);
      if (nativeId === "" || title === "") continue;
      company ??= firstNonEmpty(text(record(posting.company).name));

      const location = record(posting.location);
      mapped.push({
        externalId: qualifyExternalId(boardToken, nativeId),
        nativeId,
        title,
        location: firstNonEmpty(
          text(location.fullLocation),
          [text(location.city), text(location.region), text(location.country)]
            .filter(Boolean)
            .join(", ")
        ),
        // The list has no apply link. This is the public posting page, and the
        // identifier it wants is the company's, spelled as the API spells it.
        url:
          `https://jobs.smartrecruiters.com/${encodeURIComponent(
            text(record(posting.company).identifier) || boardToken
          )}/${encodeURIComponent(nativeId)}`,
        description: null,
        postedAt: parseDate(posting.releasedDate),
        raw: entry,
      });
    }

    if (content.length < 100) break;
  }

  return ok(company, mapped);
};

const readBambooHr: Reader = async (boardToken) => {
  const result = await getJson(
    `https://${encodeURIComponent(boardToken)}.bamboohr.com/careers/list`
  );
  if (!result.ok) return failed(result.error);

  const openings = record(result.body).result;
  if (!Array.isArray(openings)) return failed("expected a result array");

  const mapped: FeedJob[] = [];
  for (const entry of openings) {
    const opening = record(entry);
    // Numbered per tenant, which is what `qualifyExternalId` exists for.
    const nativeId = text(opening.id);
    const title = text(opening.jobOpeningName);
    if (nativeId === "" || title === "") continue;

    const location = record(opening.location);
    mapped.push({
      externalId: qualifyExternalId(boardToken, nativeId),
      nativeId,
      title,
      location: firstNonEmpty(
        [text(location.city), text(location.state)].filter(Boolean).join(", ")
      ),
      url: `https://${boardToken}.bamboohr.com/careers/${encodeURIComponent(nativeId)}`,
      // In `/careers/{id}/detail`, one request per posting. Same call as Breezy.
      description: null,
      postedAt: null,
      raw: entry,
    });
  }

  return ok(null, mapped);
};

const readTeamtailor: Reader = async (boardToken) => {
  const result = await getJson(`https://${encodeURIComponent(boardToken)}.teamtailor.com/jobs.json`);
  if (!result.ok) return failed(result.error);

  const feed = record(result.body);
  const items = Array.isArray(feed.items) ? feed.items : [];

  let company: string | null = firstNonEmpty(text(feed.title));
  const mapped: FeedJob[] = [];
  for (const entry of items) {
    const item = record(entry);
    const nativeId = text(item.id);
    const title = text(item.title);
    const url = text(item.url);
    if (nativeId === "" || title === "" || url === "") continue;

    // A schema.org JobPosting, which is where the locations live.
    const posting = record(item._jobposting);
    company ??= firstNonEmpty(text(record(posting.hiringOrganization).name));
    const places = Array.isArray(posting.jobLocation) ? posting.jobLocation : [];
    const address = record(record(places[0]).address);

    mapped.push({
      externalId: qualifyExternalId(boardToken, nativeId),
      nativeId,
      title,
      location: firstNonEmpty(
        [text(address.addressLocality), text(address.addressCountry)].filter(Boolean).join(", ")
      ),
      url,
      description: toPlainText(item.content_html) ?? toPlainText(posting.description),
      postedAt: parseDate(item.date_published) ?? parseDate(posting.datePosted),
      raw: entry,
    });
  }

  return ok(company, mapped);
};

const READERS: Partial<Record<AtsPlatform, Reader>> = {
  greenhouse: readGreenhouse,
  lever: readLever,
  ashby: readAshby,
  workable: readWorkable,
  recruitee: readRecruitee,
  breezy: readBreezy,
  smartrecruiters: readSmartRecruiters,
  bamboohr: readBambooHr,
  teamtailor: readTeamtailor,
};

/**
 * One board's current openings, unfiltered.
 *
 * Returns `deferred` rather than throwing for a platform with no public list,
 * so that a sync over a mixed registry reports "8 synced, 1 deferred" instead
 * of failing on the first JazzHR row it reaches.
 */
export async function readBoardFeed(
  ats: AtsPlatform,
  boardToken: string
): Promise<BoardFeedResult> {
  const reader = READERS[ats];
  if (!reader) {
    return {
      status: "deferred",
      reason: `${ats} publishes no unauthenticated list of one board's postings`,
    };
  }
  return reader(boardToken);
}
