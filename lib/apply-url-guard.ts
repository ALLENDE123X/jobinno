/**
 * The one rule about where a browser carrying a real person's resume is allowed
 * to go.
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 * `jobs.url` is written from the ATS platform's own JSON response, and six of
 * the nine readers in `lib/ats-job-feeds.ts` take that link verbatim: Lever's
 * `applyUrl`, Ashby's `applyUrl`, Workable's `application_url`, Recruitee's
 * `careers_apply_url`, Breezy's `url` and Teamtailor's `url`. Whoever owns the
 * tenant chooses that string, and owning a tenant is not a privilege: the board
 * registry is seeded by harvesting links out of two public GitHub READMEs that
 * accept community pull requests, so a board token pointing at a free tier
 * tenant somebody controls can be added by anybody and is then read by the next
 * sync.
 *
 * What the pipeline does with the resulting URL is the part that matters. It
 * opens it in a real browser, decides by reading the DOM that the page is an
 * application form, types the candidate's real name, email, phone, location and
 * work history into it, and uploads their real resume PDF. A listing URL is
 * therefore not a link. It is an instruction to hand somebody a person's
 * identity documents, and it has to be checked like one.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A listing URL is acceptable only when all of the following hold:
 *
 *  1. It parses, and its scheme is https. Nothing else is opened, ever.
 *  2. It carries no embedded credentials. `https://jobs.lever.co@example.com/`
 *     is a hostname of `example.com` wearing a costume.
 *  3. Its host is not a bare IP address, not `localhost`, and not inside the
 *     loopback, RFC1918, carrier grade NAT or link local ranges. This is
 *     redundant with rule 4 and is kept anyway, because it is the rule whose
 *     absence let `http://169.254.169.254/` reach the cloud metadata endpoint
 *     of whatever host a local browser is running on.
 *  4. Its host is one `lib/ats-boards.ts` recognises, and belongs to the same
 *     ATS platform the listing was ingested from.
 *  5. It names the same board token the listing was ingested from.
 *
 * Rule 5 has one deliberate exception, and only one. On a host the vendor
 * operates for all of its customers at once (`apply.workable.com`,
 * `jobs.lever.co`) a URL that names no tenant at all is accepted:
 * `apply.workable.com/j/{shortcode}` is Workable's own account free short link
 * for a posting, and refusing it would drop real listings to protect against
 * nothing, since the host is still Workable's and the data still goes to
 * Workable. The exception never applies to a per customer hostname such as
 * `{tenant}.recruitee.com`, where the hostname is the tenant, and it is granted
 * to those two hosts by name rather than to every host that happens to keep its
 * tenant in the path. See `TENANT_FREE_LINK_HOSTS`.
 *
 * ── Where this is enforced ──────────────────────────────────────────────────
 * Three times, on purpose. `lib/board-ingest.ts` screens every listing before it
 * is written, which is the primary gate; `lib/fill-application-form.ts` screens
 * again before it navigates, because the CLI entry points reach that module
 * with a row that never went through ingest, and because a row written before
 * this check existed is still in the table; and the same module screens a third
 * time against the URL the browser actually ended up on, because a URL that
 * passes the first two checks is still only a string and `goto` follows
 * redirects.
 *
 * Nothing here does IO. It is URL parsing and two table lookups.
 */

import { classifyApplicationUrl, matchAtsHost } from "@/lib/ats-boards";

/** What the caller knows about where the listing came from. */
export type ExpectedBoard = {
  /** `jobs.ats`, or `boards.ats`. A plain string, since callers read it as one. */
  ats: string;
  /**
   * `boards.board_token`. Optional only so that a caller with no board row can
   * still get rules 1 to 4; every caller that has one passes it.
   */
  boardToken?: string | null;
};

export type ApplyUrlVerdict =
  | { ok: true; host: string }
  | { ok: false; reason: string };

/**
 * The hosts that may name a posting without naming the board it belongs to.
 *
 * This is rule 5's exception, and it is a list of two because the header says it
 * is a list of two. `matchAtsHost` answers `tenantIn: "path"` for five entries,
 * three of which are here only because their tenant is the first path segment:
 * Greenhouse, Ashby and SmartRecruiters. Reading `tenantIn: "path"` as "the
 * exception applies" therefore granted it to all five, and that is wider than it
 * reads. `classifyApplicationUrl` returns null on a path host whenever the first
 * segment is a word it knows is not a tenant, so
 * `job-boards.greenhouse.io/embed/job_app?token={jobId}` with the `for` parameter
 * left off was accepted against any Greenhouse board at all, and that URL is a
 * real application form Greenhouse serves rather than a shape nobody visits. The
 * host is still the vendor's either way, so this was never the resume going to
 * an attacker; it was the wrong employer inside the right vendor, which is still
 * an application the candidate did not choose to make.
 *
 * Kept here rather than as a flag on the host table in `lib/ats-boards.ts` so
 * that the exception and the rule it bends read together. The cost of that is
 * one pair of duplicated host strings, and the direction it fails in if they
 * ever drift is closed: an unrecognised host means the exception is not granted,
 * which refuses a real listing rather than admitting a bad one.
 */
const TENANT_FREE_LINK_HOSTS: ReadonlySet<string> = new Set([
  "apply.workable.com",
  "jobs.lever.co",
]);

/** Enough of an untrusted string to identify it in a log, and no more. */
export function forLog(value: string, max = 200): string {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function normalizeHost(rawHost: string): string {
  return String(rawHost ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/**
 * Why a hostname must never be opened, or `null` when it names something on the
 * public internet.
 *
 * The dotted quad test is enough for the numeric forms too: the URL parser
 * normalises `http://2130706433/` and `http://0x7f.1/` to `127.0.0.1` before
 * this ever sees the hostname, which is worth knowing because the octal and
 * decimal spellings are the usual way a naive check gets walked past.
 */
export function unroutableHostReason(rawHost: string): string | null {
  const host = normalizeHost(rawHost);
  if (host === "") return "an empty hostname";
  if (host === "localhost" || host.endsWith(".localhost")) return "the loopback name localhost";
  // A bracketed IPv6 literal has already had its brackets stripped above, and a
  // colon cannot appear in a hostname any other way.
  if (host.includes(":")) return "a literal IPv6 address";

  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (quad === null) {
    // A hostname that is all digits is an IPv4 address the parser could not
    // normalise, which is not a name anybody's job board answers to either.
    return /^\d+$/.test(host) ? "a numeric hostname" : null;
  }

  const [a, b] = [Number(quad[1]), Number(quad[2])];
  if (a === 127) return "a loopback address";
  if (a === 10) return "an RFC1918 private address";
  if (a === 172 && b >= 16 && b <= 31) return "an RFC1918 private address";
  if (a === 192 && b === 168) return "an RFC1918 private address";
  if (a === 169 && b === 254) return "a link local address, which is where cloud metadata lives";
  if (a === 100 && b >= 64 && b <= 127) return "a carrier grade NAT address";
  if (a === 0) return "the unspecified address";
  return "a literal IP address rather than a board's hostname";
}

/**
 * Whether one listing URL may be stored and, later, opened in a browser holding
 * the candidate's resume. See the header for the rule and for the one exception
 * to it.
 */
export function checkApplyUrl(rawUrl: string, expected: ExpectedBoard): ApplyUrlVerdict {
  const raw = String(rawUrl ?? "").trim();
  if (raw === "") return { ok: false, reason: "the listing carries no url" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `"${forLog(raw)}" is not a url` };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      reason: `the scheme is "${url.protocol.replace(":", "")}" and only https is opened`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "the url carries credentials in front of its hostname" };
  }

  const host = normalizeHost(url.hostname);
  const unroutable = unroutableHostReason(host);
  if (unroutable !== null) {
    return { ok: false, reason: `the host "${forLog(host, 80)}" is ${unroutable}` };
  }

  const expectedAts = String(expected.ats ?? "").trim().toLowerCase();
  const expectedToken = String(expected.boardToken ?? "").trim().toLowerCase();

  const hostMatch = matchAtsHost(host);
  if (hostMatch === null) {
    return {
      ok: false,
      reason:
        `no supported ATS platform serves the host "${forLog(host, 80)}", so this is not a ` +
        `${expectedAts || "board"} application form however it describes itself`,
    };
  }
  if (hostMatch.ats !== expectedAts) {
    return {
      ok: false,
      reason:
        `the host "${forLog(host, 80)}" belongs to ${hostMatch.ats}, but the listing was read ` +
        `from ${expectedAts || "an unnamed platform"}`,
    };
  }

  const ref = classifyApplicationUrl(url.toString());
  if (ref === null) {
    // The vendor's own shared host, on one of the two hosts whose short links
    // name a posting and no account. Accepted, and only here. See the exception
    // in the header and `TENANT_FREE_LINK_HOSTS`.
    if (hostMatch.tenantIn === "path" && TENANT_FREE_LINK_HOSTS.has(host)) {
      return { ok: true, host };
    }
    return {
      ok: false,
      reason: `"${forLog(host, 80)}" is not the hostname of a single ${expectedAts} board`,
    };
  }

  if (ref.ats !== expectedAts) {
    return {
      ok: false,
      reason: `the url names a ${ref.ats} board but the listing was read from ${expectedAts}`,
    };
  }
  if (expectedToken !== "" && ref.boardToken !== expectedToken) {
    return {
      ok: false,
      reason:
        `the url names the ${ref.ats} board "${forLog(ref.boardToken, 80)}", but the listing ` +
        `was read from the board "${forLog(expectedToken, 80)}"`,
    };
  }

  return { ok: true, host };
}
