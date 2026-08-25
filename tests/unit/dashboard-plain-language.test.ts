// @vitest-environment node
/**
 * JOB-009. Nothing internal reaches a person's screen untranslated.
 *
 * ── The failure this is built to catch ──────────────────────────────────────
 * A fourteenth `applications.status`, added by a later ticket, that nobody
 * remembers to give wording to. The type system catches it first — the mapping
 * is a `Record<ApplicationStatus, …>` and an incomplete one does not compile —
 * and this suite catches it a second time, because the status column is free
 * text and a `Record` says nothing about a value that arrives from outside the
 * enum. The two together are what make "no snake case on the page" a property
 * rather than a habit.
 *
 * The same pair of checks runs over `SKIP_REASONS`, which is a closed set the
 * database enforces, and where the equivalent miss is a reason code rendered at
 * somebody who has no idea what `dom_changed` means.
 */
import { describe, expect, it } from "vitest";

import { APPLICATION_STATUS } from "@/lib/application-status";
import {
  SKIP_REASON_TEXT,
  STATUS_PRESENTATION,
  UNRECOGNISED_STATUS,
  describeSkipReason,
  describeStatus,
} from "@/lib/dashboard/plain-language";
import { SKIP_REASONS } from "@/lib/db/schema";

const STATUSES = Object.values(APPLICATION_STATUS);

/** Snake case, or the enum value itself, showing up in something a person reads. */
function looksInternal(text: string, rawValue: string): boolean {
  return text.includes("_") || text.toLowerCase() === rawValue.toLowerCase();
}

describe("status wording", () => {
  it("covers every status in the enum and nothing that is not one", () => {
    // Both directions on purpose. Missing keys are the new status nobody wrote
    // wording for; extra keys are wording left behind by a status that was
    // removed, which is how a mapping quietly stops describing the real set.
    expect(Object.keys(STATUS_PRESENTATION).sort()).toEqual([...STATUSES].sort());
  });

  it.each(STATUSES)("says %s in words rather than in code", (status) => {
    const presentation = describeStatus(status);

    expect(presentation).not.toBe(UNRECOGNISED_STATUS);
    expect(presentation.label.trim()).not.toBe("");
    expect(looksInternal(presentation.label, status)).toBe(false);
    expect(presentation.description.trim()).not.toBe("");
    expect(looksInternal(presentation.description, status)).toBe(false);
  });

  it.each(STATUSES)("keeps %s free of hyphens and em dashes", (status) => {
    // CLAUDE.md HARD STOP 8, checked rather than remembered. Every string here
    // is rendered to a user.
    const { label, description } = describeStatus(status);
    expect(`${label} ${description}`).not.toMatch(/[-—]/);
  });

  it("reads the blocked statuses as something a person can act on", () => {
    expect(describeStatus(APPLICATION_STATUS.FORM_FILL_BLOCKED).label).toBe("needs your attention");
    expect(describeStatus(APPLICATION_STATUS.SUBMITTED).label).toBe("sent");
  });

  it("marks exactly the statuses that cannot move without a person", () => {
    const needsHuman = STATUSES.filter((status) => describeStatus(status).needsHuman).sort();

    // The four blocked ones plus `submission_unconfirmed`, which is not blocked
    // and still needs a human: a submit control was pressed and nobody knows
    // what happened, so it must never be retried automatically. v1-C (#143)
    // added `pending_user_input` to this list: the row is waiting on the
    // person to answer questions on the dashboard, which is a "cannot move
    // without a person" state even though the pipeline will resume the row
    // automatically once they do.
    expect(needsHuman).toEqual(
      [
        APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED,
        APPLICATION_STATUS.ERROR,
        APPLICATION_STATUS.FORM_FILL_BLOCKED,
        APPLICATION_STATUS.PENDING_USER_INPUT,
        APPLICATION_STATUS.SUBMISSION_BLOCKED,
        APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
      ].sort()
    );
  });

  it("never claims a submitted application is anything other than sent", () => {
    const submitted = describeStatus(APPLICATION_STATUS.SUBMITTED);
    expect(submitted.tone).toBe("sent");
    expect(submitted.needsHuman).toBe(false);
  });

  it("asks for a human when the status column holds something unknown", () => {
    // Reachable: the column is free text by design, so a value from outside the
    // enum is a real possibility and guessing at it is the wrong answer.
    const unknown = describeStatus("teleported_to_mars");
    expect(unknown).toBe(UNRECOGNISED_STATUS);
    expect(unknown.needsHuman).toBe(true);
    expect(unknown.label).not.toContain("_");
  });
});

describe("skip reason wording", () => {
  it("covers every reason the database will accept and nothing else", () => {
    expect(Object.keys(SKIP_REASON_TEXT).sort()).toEqual([...SKIP_REASONS].sort());
  });

  it.each(SKIP_REASONS)("explains %s as a sentence", (reason) => {
    const text = describeSkipReason(reason);

    expect(text).not.toBeNull();
    expect(looksInternal(text as string, reason)).toBe(false);
    expect(text as string).not.toMatch(/[-—]/);
    expect((text as string).length).toBeGreaterThan(20);
  });

  it("says nothing rather than something wrong for a reason it does not know", () => {
    expect(describeSkipReason("wandered_off")).toBeNull();
    expect(describeSkipReason(null)).toBeNull();
    expect(describeSkipReason(undefined)).toBeNull();
  });
});
