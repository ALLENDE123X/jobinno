#!/usr/bin/env python3
"""
JOB-176: Supplemental sourcing from BuiltIn.

Crawls BuiltIn's public job search listing pages (no auth, no paid Apify actor),
follows each posting's "howToApply" outbound URL, and keeps only the ones that
land on SmartRecruiters (jobs.smartrecruiters.com/{Company}/...) or Breezy
({sub}.breezy.hr/...) since those are the only two ATS platforms this ticket
sources against.

This script only discovers *companies* (SR company slug / Breezy subdomain).
The actual bulk job listing per company is pulled separately from each ATS's
free public API (api.smartrecruiters.com, {sub}.breezy.hr/json), which is a
far more complete and efficient source than re deriving every posting from
BuiltIn's own listing pages.

Read only. Makes no writes anywhere. Output is a JSON file the caller reads
and turns into board registrations through scripts/ingest-discovered-boards.ts.

Usage:
    python3 scripts/scrape-builtin-sr-breezy.py --out /path/to/out.json \
        --max-pages-per-category 12 --sleep 1.5
"""

import argparse
import json
import random
import re
import sys
import time
import urllib.error
import urllib.request

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

# Category and location scoped listing URLs to crawl. Kept intentionally small
# and SWE flavored per the ticket's scope (dev-engineering, entry-level).
import os

_DEFAULT_CATEGORIES = [
    "jobs/dev-engineering/entry-level",
    "jobs/remote/dev-engineering/entry-level",
    "jobs/san-francisco/dev-engineering/entry-level",
    "jobs/new-york-city/dev-engineering/entry-level",
    "jobs/seattle/dev-engineering/entry-level",
    "jobs/austin/dev-engineering/entry-level",
    "jobs/boston/dev-engineering/entry-level",
    "jobs/chicago/dev-engineering/entry-level",
]

# Allow overriding via env var (comma separated) so a second sourcing pass can
# target different categories without re crawling the same postings.
_env_cats = os.environ.get("BUILTIN_CATEGORIES")
CATEGORY_PATHS = _env_cats.split(",") if _env_cats else _DEFAULT_CATEGORIES

JOB_LINK_RE = re.compile(r'href="(/job/[^"?#]+/(\d+))"')
HOW_TO_APPLY_RE = re.compile(r'"howToApply":"((?:[^"\\]|\\.)*)"')

SR_URL_RE = re.compile(r"jobs\.smartrecruiters\.com/([^/]+)/")
BREEZY_URL_RE = re.compile(r"https?://([a-zA-Z0-9-]+)\.breezy\.hr/")


def fetch(url: str, timeout: int = 10) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} on {url}", file=sys.stderr)
        return None
    except Exception as e:  # noqa: BLE001 - best-effort scraper, keep going
        print(f"  error fetching {url}: {e}", file=sys.stderr)
        return None


def unescape_json_string(s: str) -> str:
    try:
        return json.loads(f'"{s}"')
    except Exception:  # noqa: BLE001
        return s


def crawl_listing_pages(max_pages_per_category: int, sleep_s: float) -> set[tuple[str, str]]:
    """Returns a set of (job_id, detail_url) tuples discovered across categories."""
    seen: set[tuple[str, str]] = set()
    for cat in CATEGORY_PATHS:
        empty_streak = 0
        for page in range(1, max_pages_per_category + 1):
            url = f"https://builtin.com/{cat}" + (f"?page={page}" if page > 1 else "")
            html = fetch(url)
            time.sleep(sleep_s + random.uniform(0, 0.5))
            if html is None:
                empty_streak += 1
                if empty_streak >= 2:
                    break
                continue
            links = JOB_LINK_RE.findall(html)
            if not links:
                empty_streak += 1
                if empty_streak >= 2:
                    break
                continue
            empty_streak = 0
            before = len(seen)
            for path, job_id in links:
                seen.add((job_id, f"https://builtin.com{path}"))
            added = len(seen) - before
            print(f"[{cat}] page {page}: {len(links)} links, {added} new (total {len(seen)})")
    return seen


def resolve_apply_urls(
    jobs: set[tuple[str, str]], sleep_s: float, limit: int, out_path: str,
    max_consecutive_failures: int = 8,
) -> list[dict]:
    results = []
    sr_companies: dict[str, str] = {}
    breezy_subs: dict[str, str] = {}
    checked = 0
    consecutive_failures = 0
    for job_id, detail_url in list(jobs)[:limit]:
        html = fetch(detail_url)
        checked += 1
        if html is None:
            consecutive_failures += 1
            backoff = min(30.0, sleep_s * (2 ** min(consecutive_failures, 4)))
            print(f"  fetch failure #{consecutive_failures}, backing off {backoff:.1f}s")
            time.sleep(backoff)
            if consecutive_failures >= max_consecutive_failures:
                print(f"  {max_consecutive_failures} consecutive failures, stopping detail "
                      f"resolution early at {checked}/{limit} checked (likely rate limited).")
                break
            continue
        consecutive_failures = 0
        time.sleep(sleep_s + random.uniform(0, 0.5))
        m = HOW_TO_APPLY_RE.search(html)
        if not m:
            continue
        apply_url = unescape_json_string(m.group(1))
        sr_m = SR_URL_RE.search(apply_url)
        breezy_m = BREEZY_URL_RE.search(apply_url)
        if sr_m:
            company = sr_m.group(1)
            sr_companies.setdefault(company, apply_url)
            results.append({"ats": "smartrecruiters", "company_slug": company, "apply_url": apply_url, "builtin_url": detail_url})
        elif breezy_m:
            sub = breezy_m.group(1)
            breezy_subs.setdefault(sub, apply_url)
            results.append({"ats": "breezy", "company_slug": sub, "apply_url": apply_url, "builtin_url": detail_url})
        if checked % 15 == 0:
            print(f"  checked {checked}/{min(limit, len(jobs))} detail pages, "
                  f"{len(sr_companies)} SR companies, {len(breezy_subs)} breezy subs so far")
            # Write incremental progress so a kill or timeout does not lose everything.
            _write_out(out_path, len(jobs), checked, results)
    return results


def _write_out(out_path: str, total_seen: int, checked: int, results: list[dict]):
    sr_companies = sorted({r["company_slug"] for r in results if r["ats"] == "smartrecruiters"})
    breezy_subs = sorted({r["company_slug"] for r in results if r["ats"] == "breezy"})
    out = {
        "total_builtin_postings_seen": total_seen,
        "total_detail_pages_checked": checked,
        "sr_companies": sr_companies,
        "breezy_subdomains": breezy_subs,
        "matches": results,
    }
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-pages-per-category", type=int, default=10)
    ap.add_argument("--sleep", type=float, default=1.2)
    ap.add_argument("--max-detail-fetches", type=int, default=500)
    args = ap.parse_args()

    print("Crawling BuiltIn listing pages...")
    jobs = crawl_listing_pages(args.max_pages_per_category, args.sleep)
    print(f"Discovered {len(jobs)} unique BuiltIn job postings across categories.")

    print("Resolving outbound apply URLs (this is the slow part)...")
    results = resolve_apply_urls(jobs, args.sleep, args.max_detail_fetches, args.out)

    sr_companies = sorted({r["company_slug"] for r in results if r["ats"] == "smartrecruiters"})
    breezy_subs = sorted({r["company_slug"] for r in results if r["ats"] == "breezy"})
    _write_out(args.out, len(jobs), min(len(jobs), args.max_detail_fetches), results)

    print(f"\nDone. {len(sr_companies)} unique SR companies, {len(breezy_subs)} unique Breezy "
          f"subdomains discovered via BuiltIn. Written to {args.out}")


if __name__ == "__main__":
    main()
