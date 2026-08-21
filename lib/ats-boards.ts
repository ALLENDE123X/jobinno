/**
 * JOB-003, part one: turning an application link into an ATS and a board token.
 *
 * The board registry is seeded from two community maintained repositories that
 * track CS internships and publish, for each role, the employer's own direct
 * application link:
 *
 *   · github.com/SimplifyJobs/Summer2026-Internships
 *   · github.com/vanshb03/Summer2026-Internships
 *
 * Both now redirect to their Summer 2027 successors, which is why the fetch
 * below asks the GitHub API for the repository's README rather than for a
 * pinned path: the API follows the rename and returns whatever the repo's
 * current default branch actually serves.
 *
 * ── Why this parses URLs and not tables ─────────────────────────────────────
 * The two repos do not agree on a format. vanshb03 keeps a GitHub flavoured
 * markdown table with pipe delimited rows; SimplifyJobs emits raw HTML, rows of
 * `<td><div align="center"><a href="…"><img …></a></div></td>`. A table parser
 * would need one implementation each, and would break the next time either repo
 * restyles its list. So this module reads neither table. It harvests every URL
 * in the document and keeps the ones whose host is an ATS it recognises, which
 * is format independent and survives a restyle untouched.
 *
 * The cost of that choice is that the company's display name, which lives in
 * the row rather than in the link, is not available here. `boards.company` is
 * therefore seeded from the token and corrected on the first sync from the ATS
 * platform's own response, which is the authoritative spelling anyway. See
 * `lib/board-ingest.ts`.
 *
 * ── The board token is a different shape on every platform ──────────────────
 * Every pattern below was checked against a real link harvested from one of the
 * two READMEs, and every resulting token was then used against that platform's
 * live API. The three shapes, and the traps in each:
 *
 *  · **First path segment.** Greenhouse, Lever, Ashby, Workable,
 *    SmartRecruiters. Greenhouse has two extra cases: `boards.greenhouse.io`
 *    and `job-boards.eu.greenhouse.io` are alternative hosts for the same
 *    tenant namespace (an EU hosted board is still readable through the US API
 *    host, verified with `imc`), and an embedded application form carries the
 *    tenant in `?for=` instead of in the path, the same special case
 *    `lib/search-job-listings.ts` and the Gmail listener both already make.
 *    SmartRecruiters has one of its own (JOB-036): clicking a listing's apply
 *    control lands on `/oneclick-ui/company/{token}/publication/{uuid}`, whose
 *    tenant is the segment after `company` rather than the first segment.
 *
 *  · **Leftmost hostname label.** BambooHR, Breezy, JazzHR, Recruitee,
 *    Teamtailor. `specteraerospace.bamboohr.com/careers/122` is the tenant
 *    `specteraerospace`, and the path is the posting.
 *
 *  · **Neither.** A large share of the Greenhouse backed listings in these
 *    repos point at the employer's own careers site with a `?gh_jid=` query
 *    parameter (`janestreet.com/join-jane-street/apply/8537797002?gh_jid=…`).
 *    Those are real Greenhouse postings, but the URL does not name the board,
 *    so the token cannot be derived and the link is skipped. Recovering those
 *    boards needs a lookup this module does not have.
 *
 * Tokens are compared and stored lowercased. Greenhouse, Ashby and
 * SmartRecruiters were each checked to answer identically for a mixed case
 * token and its lowercase form (`DVTrading`, `Etched`, `AveryDennison`), so
 * folding case costs nothing and makes `boards.ats + boards.board_token` a
 * dependable unique key rather than one that admits the same board twice.
 *
 * Nothing here writes anywhere. It is string handling plus one unauthenticated
 * GET against api.github.com.
 */

import type { AtsPlatform } from "@/lib/db/schema";

/** The two listing repositories the registry is seeded from. */
export const LISTING_REPOS: readonly { owner: string; repo: string }[] = [
  { owner: "SimplifyJobs", repo: "Summer2026-Internships" },
  { owner: "vanshb03", repo: "Summer2026-Internships" },
];

/** A board as this module can describe it: platform plus tenant, nothing more. */
export type BoardRef = {
  ats: AtsPlatform;
  boardToken: string;
};

/** Everything a harvested link tells us, kept together for logging. */
export type HarvestedBoard = BoardRef & {
  /** One real link that produced this board. Useful when a token looks wrong. */
  sourceUrl: string;
};

// ───────────────────────────────────
// Host tables
// ───────────────────────────────────

/**
 * Hosts whose tenant is the first path segment.
 *
 * Matched on the whole hostname rather than on a suffix, deliberately: an
 * employer's own careers site can sit on a subdomain of these vendors without
 * being a board root, and a suffix match would mint a token out of whatever
 * happened to be first in the path.
 */
const PATH_SEGMENT_HOSTS: readonly { hosts: readonly string[]; ats: AtsPlatform }[] = [
  {
    ats: "greenhouse",
    hosts: [
      "job-boards.greenhouse.io",
      "boards.greenhouse.io",
      "job-boards.eu.greenhouse.io",
      "boards.eu.greenhouse.io",
    ],
  },
  { ats: "lever", hosts: ["jobs.lever.co"] },
  { ats: "ashby", hosts: ["jobs.ashbyhq.com"] },
  { ats: "workable", hosts: ["apply.workable.com"] },
  { ats: "smartrecruiters", hosts: ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"] },
];

/** Hosts whose tenant is the leftmost hostname label. */
const SUBDOMAIN_HOSTS: readonly { suffix: string; ats: AtsPlatform }[] = [
  { suffix: ".bamboohr.com", ats: "bamboohr" },
  { suffix: ".breezy.hr", ats: "breezy" },
  { suffix: ".applytojob.com", ats: "jazzhr" },
  { suffix: ".recruitee.com", ats: "recruitee" },
  { suffix: ".teamtailor.com", ats: "teamtailor" },
];

/**
 * Where a hostname's tenant lives, for the hosts above.
 *
 * `path` means the host is one the vendor operates for every one of its
 * customers (`jobs.lever.co`) and the tenant is in the path. `hostname` means
 * the tenant is the leftmost label and the host itself names the customer
 * (`bunq.recruitee.com`). The distinction matters to
 * `lib/apply-url-guard.ts`, which is allowed to be slightly more forgiving
 * about a shared vendor host than about a per customer one.
 */
export type AtsHostMatch =
  | { ats: AtsPlatform; tenantIn: "path" }
  | { ats: AtsPlatform; tenantIn: "hostname"; suffix: string };

/** A hostname, lowercased with any root label dot removed. */
function normalizeHost(rawHost: string): string {
  return String(rawHost ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/**
 * The ATS platform that operates a hostname, or `null` when no supported
 * platform does.
 *
 * The single reader of both host tables above, so that "is this host really
 * this platform's?" has one answer everywhere it is asked. `classifyApplicationUrl`
 * goes through it, and so does the ingest and pre navigation URL check.
 */
export function matchAtsHost(rawHost: string): AtsHostMatch | null {
  const host = normalizeHost(rawHost);
  if (host === "") return null;

  const pathHost = PATH_SEGMENT_HOSTS.find((entry) => entry.hosts.includes(host));
  if (pathHost) return { ats: pathHost.ats, tenantIn: "path" };

  const subdomainHost = SUBDOMAIN_HOSTS.find((entry) => host.endsWith(entry.suffix));
  if (subdomainHost) {
    return { ats: subdomainHost.ats, tenantIn: "hostname", suffix: subdomainHost.suffix };
  }

  return null;
}

/**
 * Hostname labels that are the vendor's own marketing or support site rather
 * than a customer's board. `support.recruitee.com` is not a company called
 * "support", and a registry row for it would fail on every sync forever.
 */
const NOT_A_TENANT = new Set(["www", "support", "help", "blog", "docs", "api", "app", "status"]);

/**
 * Path segments that appear where a tenant would and are not one. `embed` is
 * Greenhouse's application form host prefix, handled separately below; `j` is
 * Workable's account free short link, which names a posting and not an account.
 */
const NOT_A_TOKEN = new Set(["embed", "j", "jobs", "job", "apply", "search", "p", "o"]);

// ───────────────────────────────────
// Classification
// ───────────────────────────────────

/**
 * The ATS and board token a single application link names, or `null` when the
 * link is not one of the supported platforms or does not name its board.
 *
 * `null` is the common case and not an error: most links in these repos point
 * at Workday, Oracle Cloud, iCIMS or an employer's own site, none of which
 * V1 targets.
 */
export function classifyApplicationUrl(rawUrl: string): BoardRef | null {
  let url: URL;
  try {
    url = new URL(String(rawUrl ?? "").trim());
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = normalizeHost(url.hostname);
  const segments = url.pathname.split("/").filter(Boolean);

  const match = matchAtsHost(host);
  if (match === null) return null;

  if (match.tenantIn === "path") {
    const first = (segments[0] ?? "").toLowerCase();

    // job-boards.greenhouse.io/embed/job_app?for={token}&token={jobId} is the
    // bare application form, and the only Greenhouse URL shape whose tenant is
    // in the query string rather than in the path.
    if (match.ats === "greenhouse" && first === "embed") {
      return board(match.ats, url.searchParams.get("for"));
    }

    // JOB-036. jobs.smartrecruiters.com/oneclick-ui/company/{token}/publication/{uuid}
    // is SmartRecruiters' own application form — where a listing's "I'm
    // Interested" control (SmartRecruiters' name for what every other board
    // here calls "Apply") actually leads. It is the same kind of exception as
    // Greenhouse's `embed` case just above: a real, applyable page whose tenant
    // sits somewhere other than the first path segment. Confirmed against a
    // real RRS Group listing (job-060) — the browser lands on exactly this
    // shape after the apply click, and without this case that click was
    // refused a step later as having wandered onto an unrelated board named
    // "oneclick-ui".
    if (match.ats === "smartrecruiters" && first === "oneclick-ui") {
      return segments[1] === "company" ? board(match.ats, segments[2]) : null;
    }

    return NOT_A_TOKEN.has(first) ? null : board(match.ats, first);
  }

  const label = host.slice(0, -match.suffix.length);
  // Only a single label is a tenant. `careers.acme.recruitee.com` is not a
  // shape this has been shown to work for, so it is left alone rather than
  // guessed at.
  if (label === "" || label.includes(".") || NOT_A_TENANT.has(label)) return null;
  return board(match.ats, label);
}

function board(ats: AtsPlatform, rawToken: string | null | undefined): BoardRef | null {
  const boardToken = String(rawToken ?? "")
    .trim()
    .toLowerCase();
  // A token is a URL safe identifier. Anything else came from a link shape this
  // module has not been shown to understand, and a bad token is a board that
  // 404s on every sync.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(boardToken)) return null;
  return { ats, boardToken };
}

// ───────────────────────────────────
// Harvesting
// ───────────────────────────────────

/**
 * Every URL in a document. Stops at whitespace and at the characters that end a
 * link in markdown (`)`, `]`) or in HTML (`"`, `'`, `<`, `>`), which is what
 * makes one expression work on both of the formats described in the header.
 */
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * The distinct boards a listing repo's README names, in the order first seen.
 *
 * Deduplicated on `ats` plus `boardToken`, matching the unique key on `boards`,
 * so a repo listing nine roles at one employer yields one board.
 */
export function harvestBoards(document: string): HarvestedBoard[] {
  const found = new Map<string, HarvestedBoard>();

  for (const rawUrl of String(document ?? "").match(URL_RE) ?? []) {
    // Trailing punctuation is part of the prose, not of the link.
    const trimmed = rawUrl.replace(/[.,;:]+$/, "");
    const ref = classifyApplicationUrl(trimmed);
    if (!ref) continue;

    const key = `${ref.ats}:${ref.boardToken}`;
    if (found.has(key)) continue;
    found.set(key, { ...ref, sourceUrl: trimmed });
  }

  return [...found.values()];
}

// ───────────────────────────────────
// GitHub
// ───────────────────────────────────

const GITHUB_API = "https://api.github.com";
const README_TIMEOUT_MS = 30_000;

/**
 * A repository's README, as raw markdown.
 *
 * `GITHUB_TOKEN` is optional and carries no scopes: these are public repos, and
 * the only thing the token buys is the authenticated rate limit of 5000 requests
 * an hour instead of the anonymous 60. Two requests per sync is nowhere near
 * either ceiling, but a shared runner IP burns the anonymous budget on other
 * things, so the token is used when it is there and its absence is a warning
 * rather than a failure.
 */
export async function fetchListingRepoReadme(owner: string, repo: string): Promise<string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    console.warn(
      `[job-003] GITHUB_TOKEN is not set. Reading ${owner}/${repo} anonymously, ` +
        `which shares a 60 request per hour budget with everything else on this IP.`
    );
  }

  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/readme`, {
    headers: {
      // The raw media type returns the file itself rather than base64 in JSON.
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jobinno-board-registry",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(README_TIMEOUT_MS),
  });

  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    await response.text().catch(() => "");
    throw new Error(
      `GitHub returned HTTP ${response.status} for ${owner}/${repo}'s README` +
        (remaining === "0" ? " (rate limit exhausted; set GITHUB_TOKEN)" : "")
    );
  }

  return response.text();
}

/**
 * Every board named by every configured listing repo, deduplicated across all
 * of them. One repo failing does not lose the other's boards: the failure is
 * logged and the sync continues, because a partial registry refresh is worth
 * more than none.
 */
export async function harvestBoardsFromListingRepos(
  repos: readonly { owner: string; repo: string }[] = LISTING_REPOS
): Promise<HarvestedBoard[]> {
  const found = new Map<string, HarvestedBoard>();

  for (const { owner, repo } of repos) {
    let readme: string;
    try {
      readme = await fetchListingRepoReadme(owner, repo);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[job-003] could not read ${owner}/${repo}: ${reason}`);
      continue;
    }

    const boards = harvestBoards(readme);
    console.log(`[job-003] ${owner}/${repo}: ${boards.length} board(s) named`);
    for (const entry of boards) {
      const key = `${entry.ats}:${entry.boardToken}`;
      if (!found.has(key)) found.set(key, entry);
    }
  }

  return [...found.values()];
}

/**
 * A first guess at a display name, used only until a sync replaces it with the
 * name the ATS platform itself reports. `al-warren-oil-company-inc` becomes
 * "Al Warren Oil Company Inc", which is close enough to be recognisable and
 * clearly not authoritative.
 */
export function placeholderCompanyName(boardToken: string): string {
  return (
    boardToken
      .split(/[-_.]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ") || boardToken
  );
}
