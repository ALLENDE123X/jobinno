// @vitest-environment node
/**
 * JOB-003. One function, and it is here because a real run against the real
 * registry failed without it.
 *
 * Workable's `capula-investment-management-ltd` publishes twelve jobs under
 * eight shortcodes: a posting open in four offices is listed once per office,
 * and the shortcode is the posting. Handed straight to an
 * `insert … on conflict do update`, that is one key named four times in one
 * VALUES list, which Postgres refuses outright rather than resolving. The whole
 * board is lost, not just the duplicate.
 *
 * No database: the deduplication is a Map, and the constraint it protects is
 * exercised in CI by the schema push rather than here.
 */
import { describe, expect, it } from "vitest";

import { dedupeByExternalId } from "@/lib/board-ingest";
import type { FeedJob } from "@/lib/ats-job-feeds";

function entry(externalId: string, title: string) {
  const job: FeedJob = {
    externalId,
    nativeId: externalId.split(":")[1] ?? externalId,
    title,
    location: null,
    url: "https://apply.workable.com/j/A15A62A8BE/apply",
    description: null,
    postedAt: null,
    raw: { title },
  };
  return { job, isIntern: true, isNewGrad: false };
}

describe("dedupeByExternalId", () => {
  it("collapses one posting listed once per office", () => {
    const capula = [
      entry("capula:A15A62A8BE", "2027 Trading and Research Summer Internship"),
      entry("capula:A15A62A8BE", "2027 Trading and Research Summer Internship"),
      entry("capula:A15A62A8BE", "2027 Trading and Research Summer Internship"),
      entry("capula:A15A62A8BE", "2027 Trading and Research Summer Internship"),
      entry("capula:88F2A24444", "Technology Graduate Analyst"),
    ];

    expect(dedupeByExternalId(capula).map((row) => row.job.externalId)).toEqual([
      "capula:A15A62A8BE",
      "capula:88F2A24444",
    ]);
  });

  it("keeps the first of a repeated key and leaves the rest alone", () => {
    const rows = [entry("acme:1", "First"), entry("acme:1", "Second"), entry("acme:2", "Third")];
    expect(dedupeByExternalId(rows).map((row) => row.job.title)).toEqual(["First", "Third"]);
  });

  it("changes nothing when every key is already distinct", () => {
    const rows = [entry("acme:1", "One"), entry("acme:2", "Two")];
    expect(dedupeByExternalId(rows)).toHaveLength(2);
  });

  it("handles an empty board", () => {
    expect(dedupeByExternalId([])).toEqual([]);
  });
});
