// @vitest-environment node
/**
 * JOB-235 — the Workable "/oops" redirect probe, against the shape recovered
 * from the one real `applications` row that ever hit it.
 *
 * `probeWorkableOopsRedirect` fixtures below reproduce, character for
 * character, the `blocked_apply_url:` message
 * `assertStillOnTheBoard` (`lib/fill-application-form.ts`) wrote for
 * application row `61287043-d354-4588-bbaf-55fea19c39fd` (Pony.ai, "Software
 * Engineer, Behavior") — the browser landed on
 * "https://apply.workable.com/oops" having opened the listing at
 * "https://apply.workable.com/pony-ai/j/d29663c0-994f-4a09-912a-0ecfc8bb4542/".
 * `probeWorkableOopsRedirect` is the shape the diagnosis turned into code;
 * these are the cases it has to get right, plus the negative cases that keep
 * it from firing on an ordinary board mismatch that is not this named
 * mechanism.
 */
import { describe, expect, it } from "vitest";

import {
  describeWorkableOopsRedirect,
  probeWorkableOopsRedirect,
} from "@/lib/solvers/workable";
import { lookupSolver } from "@/lib/solvers/index";
import { workableSolver } from "@/lib/solvers/workable";

const PONY_AI_APPLY_URL =
  "https://apply.workable.com/pony-ai/j/d29663c0-994f-4a09-912a-0ecfc8bb4542/";

/** The exact message recovered from the one real blocked row. */
const OOPS_BLOCKED_REASON =
  'blocked_apply_url: the browser is at "https://apply.workable.com/oops" having opened the ' +
  "listing, and that page does not belong to the board this listing came from: the url names " +
  'the workable board "oops", but the listing was read from the board "pony-ai". The listing ' +
  `pointed at "${PONY_AI_APPLY_URL}", which passed this same rule before anything was opened, ` +
  "so a redirect or a click moved the browser afterwards. Nothing was typed into this page and " +
  "no resume was uploaded to it.";

describe("probeWorkableOopsRedirect", () => {
  it("fires on the exact message recovered from the real blocked row", () => {
    const probe = probeWorkableOopsRedirect(OOPS_BLOCKED_REASON);
    expect(probe).not.toBeNull();
    expect(probe?.landedUrl).toBe("https://apply.workable.com/oops");
  });

  it("still fires when the /oops path carries a trailing slash or query string", () => {
    expect(
      probeWorkableOopsRedirect(
        OOPS_BLOCKED_REASON.replace(
          '"https://apply.workable.com/oops"',
          '"https://apply.workable.com/oops/"'
        )
      )?.landedUrl
    ).toBe("https://apply.workable.com/oops/");

    expect(
      probeWorkableOopsRedirect(
        OOPS_BLOCKED_REASON.replace(
          '"https://apply.workable.com/oops"',
          '"https://apply.workable.com/oops?ref=email"'
        )
      )?.landedUrl
    ).toBe("https://apply.workable.com/oops?ref=email");
  });

  it("returns null on a null blockedReason — nothing to see here", () => {
    expect(probeWorkableOopsRedirect(null)).toBeNull();
  });

  it("returns null on a blocked_apply_url message that landed somewhere other than /oops", () => {
    // An ordinary board mismatch — the wrong tenant's own real page, not
    // Workable's named dead-link page. This is a real failure and deserves
    // the generic message, not a false claim that it is this mechanism.
    expect(
      probeWorkableOopsRedirect(
        'blocked_apply_url: the browser is at "https://apply.workable.com/some-other-tenant/j/abc/" ' +
          'having opened the listing, and that page does not belong to the board this listing ' +
          'came from: the url names the workable board "some-other-tenant", but the listing was ' +
          'read from the board "pony-ai".'
      )
    ).toBeNull();
  });

  it("returns null when the message is not the blocked_apply_url tag at all", () => {
    expect(
      probeWorkableOopsRedirect(
        "needs_candidate_input: a required question had no stored answer"
      )
    ).toBeNull();
  });

  it("returns null on a page that merely mentions the /oops URL without the exact tag shape", () => {
    // Guards against a coincidental substring match on an unrelated message.
    expect(
      probeWorkableOopsRedirect(
        "some unrelated log line that happens to quote https://apply.workable.com/oops in passing"
      )
    ).toBeNull();
  });
});

describe("describeWorkableOopsRedirect", () => {
  it("names the mechanism and both URLs rather than repeating the generic hedge", () => {
    const probe = probeWorkableOopsRedirect(OOPS_BLOCKED_REASON);
    expect(probe).not.toBeNull();
    const message = describeWorkableOopsRedirect(probe!, PONY_AI_APPLY_URL);
    expect(message).toContain("https://apply.workable.com/oops");
    expect(message).toContain(PONY_AI_APPLY_URL);
    expect(message).toContain("Workable's own server");
    // The point of this row is that it replaces a hedge with a fact — it
    // must never claim a specific cause the probe cannot actually see.
    expect(message).not.toContain("does not belong to the board");
    expect(message).not.toContain("was removed");
    expect(message).not.toContain("was filled");
  });

  it("says nothing here can tell the specific cause apart", () => {
    const probe = probeWorkableOopsRedirect(OOPS_BLOCKED_REASON);
    const message = describeWorkableOopsRedirect(probe!, PONY_AI_APPLY_URL);
    expect(message.toLowerCase()).toContain("nothing observable here says why");
  });
});

describe("the solver registry", () => {
  it("routes workable through workableSolver", () => {
    expect(lookupSolver("workable")).toBe(workableSolver);
  });
});
