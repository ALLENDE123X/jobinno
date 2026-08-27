/**
 * JOB-187 — minting Ashby's reCAPTCHA v3 token from the self hosted
 * recaptcha-harvester, instead of leaving Ashby's own client script to mint
 * one inside a Browserbase session.
 *
 * The reason this exists at all: a Browserbase session's fingerprint scores
 * low enough on Ashby's own reCAPTCHA v3 site key that a token it mints
 * itself is routinely rejected server side as `RECAPTCHA_SCORE_BELOW_THRESHOLD`
 * (see CLAUDE.md HARD STOPS and `/Users/pranavlende/claude-memory/projects/startup/`
 * for the fuller history of that failure mode, and 2captcha's own flakiness
 * and per solve cost on this same site key). The harvester is a separate,
 * already deployed service that solves the same challenge from an environment
 * reCAPTCHA scores well, and hands back a token Ashby's GraphQL submit
 * endpoint accepts — confirmed live 2026 08 26 against a real Ramp posting
 * (issue #187), where the submit response was Ashby's `FormRender` with
 * per-field "Missing entry for required field" errors: the shape Ashby
 * returns only *after* the reCAPTCHA check has already passed.
 *
 * `6LeFb_YUAAAAALUD5h-BiQEp8JaFChe0e0A6r49Y` is Ashby's own site key, the same
 * one embedded in every jobs.ashbyhq.com application form's client bundle and
 * used unchanged in `scripts/test-ashby-api.ts`. A site key is meant to travel
 * with the page that uses it and is not a secret; nothing here treats it as
 * one.
 */

import { z } from "zod";

const ASHBY_RECAPTCHA_SITE_KEY = "6LeFb_YUAAAAALUD5h-BiQEp8JaFChe0e0A6r49Y";

/** Local dev default. A deployed harvester sets `HARVESTER_URL` instead. */
const DEFAULT_HARVESTER_URL = "http://127.0.0.1:3131";

/**
 * The harvester takes roughly 40s per token in visible window mode. 60s per
 * attempt is headroom on top of that, not a number chosen to be tight.
 */
const MINT_TIMEOUT_MS = 60_000;

const HarvesterResponseSchema = z.object({
  token: z.string().min(1),
  userAgent: z.string(),
  solveTime: z.number(),
});

/**
 * Every way `mintAshbyRecaptchaToken` can fail, typed so the Ashby submit path
 * can catch exactly this and stop before clicking Submit rather than
 * proceeding with a stale or missing token. `retryable` is internal to this
 * module — it says whether the failure looked transient enough to earn the
 * one allowed retry, not something a caller needs to branch on.
 */
export class HarvesterError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message);
    this.name = "HarvesterError";
    this.retryable = options?.retryable ?? false;
    // Not read anywhere in this module today; kept on the instance rather than
    // discarded so a caller logging this error still has the original thrown
    // value (a raw fetch failure, a JSON parse error) to print alongside it.
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
  }
}

function harvesterBaseUrl(): string {
  const configured = process.env.HARVESTER_URL?.trim();
  return (configured && configured.length > 0 ? configured : DEFAULT_HARVESTER_URL).replace(
    /\/+$/,
    ""
  );
}

/** ECONNREFUSED and ETIMEDOUT are the only two the ticket calls out as transient. */
function isTransientNetworkFailure(err: unknown): boolean {
  const code =
    (err as { cause?: { code?: string } } | undefined)?.cause?.code ??
    (err as { code?: string } | undefined)?.code;
  return code === "ECONNREFUSED" || code === "ETIMEDOUT";
}

/** HTTP statuses that say "the harvester itself is unavailable right now", not "no". */
function isTransientHttpStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** One request to `{HARVESTER_URL}/solve`. No retry logic lives here; the caller owns that. */
async function requestToken(endpoint: string, body: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new HarvesterError(
        `could not reach the harvester at ${endpoint}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { retryable: isTransientNetworkFailure(err), cause: err }
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HarvesterError(
        `harvester responded HTTP ${response.status}` + (text ? `: ${text.slice(0, 500)}` : ""),
        { retryable: isTransientHttpStatus(response.status) }
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new HarvesterError(
        `harvester response was not valid JSON: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { retryable: false, cause: err }
      );
    }

    // Checked ahead of the schema parse: a harvester that reports its own
    // failure this way may still send a `token` field alongside it (a stale
    // or placeholder one), and an errorCode is the more specific signal of
    // the two.
    if (json !== null && typeof json === "object" && "errorCode" in json) {
      const errorCode = (json as { errorCode?: unknown }).errorCode;
      throw new HarvesterError(`harvester reported an error: ${JSON.stringify(errorCode)}`, {
        retryable: false,
      });
    }

    const parsed = HarvesterResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new HarvesterError(
        `harvester response did not match the expected shape: ${parsed.error.message}`,
        { retryable: false }
      );
    }

    return parsed.data.token;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mints one fresh Ashby reCAPTCHA v3 token for `url`, the page the token will
 * be presented on.
 *
 * Retries exactly once, and only when the first attempt's failure was
 * transient (a connection failure or a 502/503/504 from the harvester
 * itself) — never on an HTTP 4xx or a well formed error response, both of
 * which mean the harvester answered and said no. Whatever the second
 * attempt does is final: it is never retried again, whether it succeeds or
 * fails.
 */
export async function mintAshbyRecaptchaToken(url: string): Promise<string> {
  const endpoint = `${harvesterBaseUrl()}/solve`;
  const body = JSON.stringify({
    websiteURL: url,
    websiteKey: ASHBY_RECAPTCHA_SITE_KEY,
    pageAction: "submit",
    enterprise: false,
  });

  try {
    return await requestToken(endpoint, body);
  } catch (err) {
    if (err instanceof HarvesterError && err.retryable) {
      return await requestToken(endpoint, body);
    }
    throw err;
  }
}
