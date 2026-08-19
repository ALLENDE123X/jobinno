// @vitest-environment node
/**
 * JOB-006. The fingerprint has to answer the same for two postings on one ATS
 * and differently for anything that would move a selector, and the plan has to
 * degrade into a live observation rather than into a wrong answer.
 *
 * Nothing here touches a browser, a model or a database. `loadActionPlan` and
 * `saveActionPlan` are exercised against a stand in whose only job is to record
 * what was asked of it, so the tests cover the failure paths that matter most
 * and that a real database would never produce on demand: a table that is not
 * there yet, a query that errors, and a stored row full of junk.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CACHE_DISABLED_ENV_VAR,
  classifyCoreSlot,
  detectAts,
  emptyActionPlan,
  fingerprintFormShape,
  loadActionPlan,
  planInvalidate,
  planLookup,
  planRecord,
  saveActionPlan,
  selectorShape,
  type CoreSlot,
  type ShapeField,
} from "@/lib/form-action-cache";
import {
  CACHEABLE_INSTRUCTION_SLOTS,
  corroborate,
  FIELD_KEYWORDS,
  type ControlDescriptor,
} from "@/lib/fill-application-form";
import { runFleet } from "@/scripts/form-action-cache-benchmark";

import type { SupabaseClient } from "@supabase/supabase-js";

// ───────────────────────────────────
// Form shapes, as the three boards really lay them out
// ───────────────────────────────────

const field = (label: string, kind: string, selector: string): ShapeField => ({
  label,
  kind,
  selector,
});

/** Greenhouse's embedded application form. Ids are the platform's own naming. */
const greenhouse = (customQuestions: number): ShapeField[] => [
  field("First Name", "text", '[id="first_name"]'),
  field("Last Name", "text", '[id="last_name"]'),
  field("Email", "text", '[id="email"]'),
  field("Phone", "text", '[id="phone"]'),
  field("Resume/CV", "file", '[id="resume"]'),
  ...Array.from({ length: customQuestions }, (_, index) =>
    field(
      `Custom question number ${index + 1}`,
      "text",
      `[id="job_application_answers_attributes_${index}_text_value"]`
    )
  ),
];

/** Lever. No ids on the text inputs, so `form-fields.ts` emits absolute XPaths. */
const lever = (offset: number): ShapeField[] => [
  field("Full name", "text", `xpath=/html[1]/body[1]/div[2]/form[1]/div[${offset}]/input[1]`),
  field("Email", "text", `xpath=/html[1]/body[1]/div[2]/form[1]/div[${offset + 1}]/input[1]`),
  field("Phone", "text", `xpath=/html[1]/body[1]/div[2]/form[1]/div[${offset + 2}]/input[1]`),
  field(
    "LinkedIn URL",
    "text",
    `xpath=/html[1]/body[1]/div[2]/form[1]/div[${offset + 3}]/input[1]`
  ),
  field("Resume/CV", "file", '[id="resume-upload-input"]'),
];

/** Ashby, whose ids are prefixed by the platform and stable across boards. */
const ashby = (): ShapeField[] => [
  field("Name", "text", '[id="_systemfield_name"]'),
  field("Email", "text", '[id="_systemfield_email"]'),
  field("Resume", "file", '[id="_systemfield_resume"]'),
];

const printOf = (ats: string, fields: readonly ShapeField[]): string =>
  fingerprintFormShape(ats, fields).fingerprint;

// ───────────────────────────────────
// Fingerprinting
// ───────────────────────────────────

describe("fingerprintFormShape", () => {
  it("gives two postings on the same ATS the same fingerprint", () => {
    // Different companies, wildly different custom question counts, one identical
    // Greenhouse form underneath. This is the whole premise of the cache.
    expect(printOf("greenhouse", greenhouse(0))).toBe(printOf("greenhouse", greenhouse(11)));
  });

  it("ignores where a generated id happens to be numbered", () => {
    const early = [...greenhouse(0), field("LinkedIn", "text", '[id="answers_3_text"]')];
    const late = [...greenhouse(0), field("LinkedIn", "text", '[id="answers_17_text"]')];
    expect(printOf("greenhouse", early)).toBe(printOf("greenhouse", late));
  });

  it("ignores where the boilerplate sits in the document", () => {
    // A company putting a paragraph above Lever's form shifts every XPath index
    // and changes no layout anybody cares about.
    expect(printOf("lever", lever(1))).toBe(printOf("lever", lever(4)));
  });

  it("ignores the order controls come back in", () => {
    const forward = greenhouse(2);
    const reversed = [...forward].reverse();
    expect(printOf("greenhouse", forward)).toBe(printOf("greenhouse", reversed));
  });

  it("separates two platforms that happen to share a shape", () => {
    expect(printOf("greenhouse", ashby())).not.toBe(printOf("ashby", ashby()));
  });

  it("changes when the ATS renames one of its own ids", () => {
    const renamed = greenhouse(0).map((entry) =>
      entry.selector === '[id="first_name"]' ? field(entry.label, entry.kind, '[id="fname"]') : entry
    );
    expect(printOf("greenhouse", renamed)).not.toBe(printOf("greenhouse", greenhouse(0)));
  });

  it("changes when the ATS swaps an input for a scripted control", () => {
    const scripted = greenhouse(0).map((entry) =>
      entry.label === "Phone" ? field("Phone", "combobox", entry.selector) : entry
    );
    expect(printOf("greenhouse", scripted)).not.toBe(printOf("greenhouse", greenhouse(0)));
  });

  it("changes when a boilerplate field is not on the form at all", () => {
    const noPhone = greenhouse(0).filter((entry) => entry.label !== "Phone");
    expect(printOf("greenhouse", noPhone)).not.toBe(printOf("greenhouse", greenhouse(0)));
  });

  it("reports the boilerplate slots it recognised and nothing else", () => {
    const shape = fingerprintFormShape("lever", lever(1));
    expect([...shape.slots].sort()).toEqual(["email", "fullName", "linkedin", "phone", "resume"]);
    expect(shape.tokens).toHaveLength(5);
  });

  it("still produces a usable key for a form with no boilerplate at all", () => {
    const shape = fingerprintFormShape("unknown", [field("Anything", "text", '[id="x"]')]);
    expect(shape.slots.size).toBe(0);
    expect(shape.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("selectorShape", () => {
  it("keeps an id, because the id is the platform's own naming", () => {
    expect(selectorShape('[id="first_name"]')).toBe("id:first_name");
  });

  it("collapses digits and long hex runs inside a generated id", () => {
    expect(selectorShape('[id="question_29104773"]')).toBe("id:question_#");
    expect(selectorShape('[id="field-3f2b91ac77e4"]')).toBe("id:field-#");
  });

  it("keeps only the leaf tag of an XPath", () => {
    expect(selectorShape("xpath=/html[1]/body[1]/div[7]/form[1]/input[2]")).toBe("xpath:input");
  });

  it("has an answer for an empty selector", () => {
    expect(selectorShape("")).toBe("none");
  });
});

describe("detectAts", () => {
  it.each([
    ["https://job-boards.greenhouse.io/embed/job_app?for=discord&token=1234", "greenhouse"],
    ["https://boards.greenhouse.io/stripe/jobs/4567", "greenhouse"],
    ["https://jobs.lever.co/matchgroup/abcd-1234/apply", "lever"],
    ["https://jobs.ashbyhq.com/openai/1234/application", "ashby"],
    ["https://apply.workable.com/acme/j/ABC123/apply/", "workable"],
    ["https://careers.example.com/apply", "unknown"],
    ["not a url at all", "unknown"],
  ])("reads %s as %s", (url, expected) => {
    expect(detectAts(url)).toBe(expected);
  });
});

// ───────────────────────────────────
// The two label tables have to agree
// ───────────────────────────────────

/** A control the DOM found and that says nothing about itself. Workday's is real. */
const UNLABELLED_CONTROL: ControlDescriptor = {
  found: true,
  tag: "input",
  type: "text",
  haystack: "",
  attachedFiles: -1,
  text: "",
  role: "",
};

/** A selector that resolves to nothing here, which is what an iframe looks like. */
const NOT_IN_THIS_DOCUMENT: ControlDescriptor = {
  found: false,
  tag: "",
  type: "",
  haystack: "",
  attachedFiles: -1,
  text: "",
  role: "",
};

describe("slot classification", () => {
  /** Labels lifted from the three boards' real forms. */
  const CORPUS: readonly (readonly [string, CoreSlot])[] = [
    ["First Name", "firstName"],
    ["Given name", "firstName"],
    ["Last Name", "lastName"],
    ["Surname", "lastName"],
    ["Full name", "fullName"],
    ["Name", "fullName"],
    ["Email", "email"],
    ["E-mail address", "email"],
    ["Phone", "phone"],
    ["Mobile number", "phone"],
    ["LinkedIn Profile", "linkedin"],
    ["Website", "website"],
    ["Portfolio", "website"],
    ["GitHub", "website"],
    ["Resume/CV", "resume"],
    ["Curriculum Vitae", "resume"],
    ["Cover Letter", "coverLetter"],
  ];

  it.each(CORPUS)("reads %s as the %s slot", (label, slot) => {
    expect(classifyCoreSlot(label)).toBe(slot);
  });

  it("agrees with the safety table in fill-application-form.ts", () => {
    // Two tables, on purpose, because one is a cache key and the other decides
    // whether a control may receive a real person's data. They are allowed to be
    // separate; they are not allowed to disagree about what a label means.
    for (const [label, slot] of CORPUS) {
      expect(FIELD_KEYWORDS[slot].test(label)).toBe(true);
    }
  });

  it("classifies each cacheable instruction as the slot it is mapped to", () => {
    // A cached absence is only honoured when the live form's own slot set agrees
    // the field is not there, so the map's idea of which slot an instruction
    // asks about has to be the same as `classifyCoreSlot`'s. That is what this
    // pins, and it is the only thing it pins.
    for (const [instruction, slot] of CACHEABLE_INSTRUCTION_SLOTS) {
      expect(classifyCoreSlot(instruction)).toBe(slot);
    }
  });

  it("never lets an instruction stand in as corroboration of a replay of itself", () => {
    // This test used to assert the opposite, and the reasoning it carried was
    // the bug. Every instruction names its own field in plain words, so
    // `FIELD_KEYWORDS[slot].test(instruction)` is true for all nine of them, and
    // a replayed action carries the instruction as its description. Letting the
    // description answer for a replay therefore meant `corroborate()` matching a
    // string this codebase wrote against itself and passing every single time,
    // whatever the stored selector actually pointed at.
    //
    // The self match below is still true and still deliberately asserted: it is
    // the trap, and it has to stay visible so nobody restores the fallback that
    // walked into it.
    for (const [instruction, slot] of CACHEABLE_INSTRUCTION_SLOTS) {
      expect(FIELD_KEYWORDS[slot].test(instruction)).toBe(true);

      expect(corroborate(slot, UNLABELLED_CONTROL, instruction, false, true)).toMatchObject({
        ok: false,
      });
      expect(corroborate(slot, NOT_IN_THIS_DOCUMENT, instruction, false, true)).toMatchObject({
        ok: false,
      });
    }
  });

  it("still lets a live observation speak for a control the DOM cannot describe", () => {
    // The other half of the same rule. A freshly observed description is a
    // model's account of this page rather than a constant of ours, so it is real
    // evidence, and Workday's unlabelled sign up email box has nothing else.
    // Narrowing this would turn a cost fix into a regression.
    const fresh = "the email address box at the top of the sign up panel";
    expect(corroborate("email", UNLABELLED_CONTROL, fresh, false, false)).toMatchObject({
      ok: true,
    });
    expect(corroborate("email", NOT_IN_THIS_DOCUMENT, fresh, false, false)).toMatchObject({
      ok: true,
    });
  });

  it("serves no instruction that would be clicked", () => {
    // The rule that keeps a cache row from ever standing in for the check that
    // stops this module pressing a submit control.
    for (const instruction of CACHEABLE_INSTRUCTION_SLOTS.keys()) {
      expect(instruction).not.toMatch(/button|control that/i);
    }
    expect(CACHEABLE_INSTRUCTION_SLOTS.size).toBe(9);
  });

  it("has nothing to say about a custom question", () => {
    expect(classifyCoreSlot("Why do you want to work at Discord?")).toBeNull();
    expect(classifyCoreSlot("Are you legally authorized to work in the US?")).toBeNull();
    expect(classifyCoreSlot("")).toBeNull();
  });
});

// ───────────────────────────────────
// Hit, miss and fallback
// ───────────────────────────────────

const CACHEABLE = new Map<string, CoreSlot>([
  ["the email address input on the job application form", "email"],
  ["the LinkedIn profile URL input on the job application form", "linkedin"],
]);
const EMAIL = "the email address input on the job application form";
const LINKEDIN = "the LinkedIn profile URL input on the job application form";
const A_CLICK = "the button that opens this listing's job application form";

const planFor = (fields: readonly ShapeField[]) =>
  emptyActionPlan(fingerprintFormShape("greenhouse", fields), CACHEABLE);

describe("planLookup", () => {
  it("misses on a shape nothing is stored for", () => {
    expect(planLookup(planFor(greenhouse(0)), EMAIL)).toEqual({ hit: false });
  });

  it("misses when there is no plan at all", () => {
    expect(planLookup(null, EMAIL)).toEqual({ hit: false });
    expect(planLookup(undefined, EMAIL)).toEqual({ hit: false });
  });

  it("replays a stored action and counts it", () => {
    const plan = planFor(greenhouse(0));
    plan.entries.set(EMAIL, { selector: '[id="email"]', method: "fill" });

    expect(planLookup(plan, EMAIL)).toEqual({
      hit: true,
      action: { selector: '[id="email"]', method: "fill" },
    });
    expect(plan.stats.replayed).toBe(1);
  });

  it("refuses to answer for an instruction it was not given", () => {
    // The allowlist is what keeps every click on the live model path.
    const plan = planFor(greenhouse(0));
    plan.entries.set(A_CLICK, { selector: '[id="apply"]' });
    expect(planLookup(plan, A_CLICK)).toEqual({ hit: false });
    expect(plan.stats.replayed).toBe(0);
  });

  it("replays a stored absence, which is where most of the saving is", () => {
    // Greenhouse's standard form has no LinkedIn box. Discovering that costs a
    // model call every run until something remembers it.
    const plan = planFor(greenhouse(0));
    plan.entries.set(LINKEDIN, null);

    expect(planLookup(plan, LINKEDIN)).toEqual({ hit: true, action: null });
    expect(plan.stats.replayedAbsent).toBe(1);
  });

  it("ignores a stored absence the live form contradicts", () => {
    // The one reply that could quietly leave a required field blank on a real
    // application, so it is only given when this run's own read of the DOM
    // agrees the field is not there.
    const withLinkedin = [...greenhouse(0), field("LinkedIn Profile", "text", '[id="li"]')];
    const plan = planFor(withLinkedin);
    plan.entries.set(LINKEDIN, null);

    expect(planLookup(plan, LINKEDIN)).toEqual({ hit: false });
    expect(plan.stats.replayedAbsent).toBe(0);
  });
});

describe("planRecord", () => {
  it("files a live observation and marks the plan worth writing", () => {
    const plan = planFor(greenhouse(0));
    planRecord(plan, EMAIL, { selector: '[id="email"]' });

    expect(plan.entries.get(EMAIL)).toEqual({ selector: '[id="email"]' });
    expect(plan.dirty).toBe(true);
    expect(plan.stats.observed).toBe(1);
  });

  it("files an absence as well as a hit", () => {
    const plan = planFor(greenhouse(0));
    planRecord(plan, LINKEDIN, null);
    expect(plan.entries.get(LINKEDIN)).toBeNull();
    expect(plan.dirty).toBe(true);
  });

  it("does not dirty the plan when the answer has not changed", () => {
    // A warm run that observes something anyway must not rewrite an identical
    // row, or every run in the fleet writes on every application.
    const plan = planFor(greenhouse(0));
    plan.entries.set(EMAIL, { selector: '[id="email"]' });
    planRecord(plan, EMAIL, { selector: '[id="email"]' });

    expect(plan.dirty).toBe(false);
    expect(plan.stats.observed).toBe(1);
  });

  it("stores nothing for an instruction outside the allowlist", () => {
    const plan = planFor(greenhouse(0));
    planRecord(plan, A_CLICK, { selector: '[id="apply"]' });
    expect(plan.entries.has(A_CLICK)).toBe(false);
    expect(plan.dirty).toBe(false);
  });
});

describe("planInvalidate", () => {
  it("drops a replay that did not hold up and remembers that it happened", () => {
    const plan = planFor(greenhouse(0));
    plan.entries.set(EMAIL, { selector: '[id="stale"]' });

    planInvalidate(plan, EMAIL);
    expect(plan.entries.has(EMAIL)).toBe(false);
    expect(plan.stats.invalidated).toBe(1);
    expect(plan.dirty).toBe(true);

    // And the next lookup goes to the model rather than back to the same answer.
    expect(planLookup(plan, EMAIL)).toEqual({ hit: false });
  });

  it("is a no op for something that was never stored", () => {
    const plan = planFor(greenhouse(0));
    planInvalidate(plan, EMAIL);
    expect(plan.stats.invalidated).toBe(0);
    expect(plan.dirty).toBe(false);
  });
});

// ───────────────────────────────────
// The collision the review found, end to end
// ───────────────────────────────────

/**
 * Two unrelated companies, each hosting its own careers page, neither putting an
 * id on anything. `form-fields.ts` answers with absolute XPaths for all of them,
 * `selectorShape()` keeps only the leaf tag, and what is left of both forms is
 * the same four tokens. The DOM ladders below have nothing in common and the
 * labels are not even the same words; the fingerprint cannot tell them apart,
 * and that is not a flaw in the test, it is the shape of the key.
 */
const SELF_HOSTED_ALPHA: readonly ShapeField[] = [
  field("First Name", "text", "xpath=/html[1]/body[1]/div[1]/main[1]/form[1]/div[1]/input[1]"),
  field("Last Name", "text", "xpath=/html[1]/body[1]/div[1]/main[1]/form[1]/div[2]/input[1]"),
  field("Email", "text", "xpath=/html[1]/body[1]/div[1]/main[1]/form[1]/div[3]/input[1]"),
  field("Resume", "file", "xpath=/html[1]/body[1]/div[1]/main[1]/form[1]/div[4]/input[1]"),
];

const SELF_HOSTED_BETA: readonly ShapeField[] = [
  field(
    "Given name",
    "text",
    "xpath=/html[1]/body[1]/section[3]/article[1]/form[2]/fieldset[1]/p[4]/input[1]"
  ),
  field(
    "Surname",
    "text",
    "xpath=/html[1]/body[1]/section[3]/article[1]/form[2]/fieldset[1]/p[6]/input[1]"
  ),
  field(
    "E-mail address",
    "text",
    "xpath=/html[1]/body[1]/section[3]/article[1]/form[2]/fieldset[1]/p[9]/input[1]"
  ),
  field(
    "Curriculum Vitae",
    "file",
    "xpath=/html[1]/body[1]/section[3]/article[1]/form[2]/fieldset[1]/p[11]/input[1]"
  ),
];

/** Alpha's email box, which is nowhere near where Beta keeps its own. */
const ALPHAS_EMAIL_SELECTOR = "xpath=/html[1]/body[1]/div[1]/main[1]/form[1]/div[3]/input[1]";

describe("a fingerprint collision between two unrelated forms", () => {
  const alpha = fingerprintFormShape("unknown", SELF_HOSTED_ALPHA);
  const beta = fingerprintFormShape("unknown", SELF_HOSTED_BETA);

  it("really does happen, which is why replay has to be checked against the DOM", () => {
    expect(beta.fingerprint).toBe(alpha.fingerprint);
    expect(beta.ats).toBe("unknown");
  });

  it("serves one company's selector to the other company's form", () => {
    // Nothing here is contrived. Alpha ran first and filed what it observed;
    // Beta looks the row up under the key it computed from its own DOM and gets
    // a hit, because the key is the same key.
    const beforeBeta = emptyActionPlan(alpha, CACHEABLE);
    planRecord(beforeBeta, EMAIL, { selector: ALPHAS_EMAIL_SELECTOR, method: "fill" });

    const onBeta = emptyActionPlan(beta, CACHEABLE);
    onBeta.entries = new Map(beforeBeta.entries);
    onBeta.warm = true;

    expect(planLookup(onBeta, EMAIL)).toEqual({
      hit: true,
      action: { selector: ALPHAS_EMAIL_SELECTOR, method: "fill" },
    });
  });

  it("does not get typed into on corroboration that came from our own instruction", () => {
    // The two ways Alpha's XPath can land on Beta's page without the DOM having
    // anything to say about it. Before the fix both of these returned ok, on the
    // strength of the instruction matching itself, and a real candidate's email
    // address went into whatever box that selector happened to reach.
    const landedOnSomethingUnlabelled = corroborate(
      "email",
      UNLABELLED_CONTROL,
      EMAIL,
      false,
      true
    );
    const landedNowhere = corroborate("email", NOT_IN_THIS_DOCUMENT, EMAIL, false, true);

    expect(landedOnSomethingUnlabelled.ok).toBe(false);
    expect(landedNowhere.ok).toBe(false);
    // And the reason given names the cache, so the log says what happened.
    expect(landedOnSomethingUnlabelled.ok === false && landedOnSomethingUnlabelled.why).toContain(
      "shared form action cache"
    );
  });

  it("is still refused when the wrong box is one the DOM can describe", () => {
    // The check that was already here, unchanged, kept next to the new one so the
    // whole matrix is visible: a labelled control that belongs to another field
    // was always caught, and it is the unlabelled and unresolvable cases that
    // were not.
    const beta_phone: ControlDescriptor = {
      ...UNLABELLED_CONTROL,
      haystack: "applicant_phone | Phone number",
    };
    expect(corroborate("email", beta_phone, EMAIL, false, true).ok).toBe(false);
  });

  it("drops the colliding row and goes back to the model, once", () => {
    // What `reResolveLive` does with the refusal above, in the terms this module
    // owns: the entry is dropped, the drop is counted, and the next lookup for
    // the same instruction is a miss, so the run observes live exactly as it
    // would have with no cache at all. A colliding row costs one model call and
    // never a wrong answer.
    const onBeta = emptyActionPlan(beta, CACHEABLE);
    onBeta.entries.set(EMAIL, { selector: ALPHAS_EMAIL_SELECTOR, method: "fill" });
    onBeta.warm = true;

    expect(planLookup(onBeta, EMAIL)).toMatchObject({ hit: true });
    planInvalidate(onBeta, EMAIL);

    expect(planLookup(onBeta, EMAIL)).toEqual({ hit: false });
    expect(onBeta.stats.invalidated).toBe(1);
    expect(onBeta.dirty).toBe(true);

    // And what the live observation then finds is filed under Beta's own key, so
    // the next Beta run is warm with Beta's selector rather than Alpha's.
    const betasOwnEmail =
      "xpath=/html[1]/body[1]/section[3]/article[1]/form[2]/fieldset[1]/p[9]/input[1]";
    planRecord(onBeta, EMAIL, { selector: betasOwnEmail, method: "fill" });
    expect(planLookup(onBeta, EMAIL)).toEqual({
      hit: true,
      action: { selector: betasOwnEmail, method: "fill" },
    });
  });
});

// ───────────────────────────────────
// Postgres, with a stand in
// ───────────────────────────────────

type FakeResult = { data: unknown; error: { message: string } | null };

function fakeSupabase(read: FakeResult, write: { error: { message: string } | null } = { error: null }) {
  const upserts: unknown[] = [];
  const client = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return { maybeSingle: async () => read };
                },
              };
            },
          };
        },
        async upsert(row: unknown) {
          upserts.push(row);
          return write;
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, upserts };
}

const SHAPE = fingerprintFormShape("greenhouse", greenhouse(0));

describe("loadActionPlan", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty plan for a shape nobody has filed yet", async () => {
    const { client } = fakeSupabase({ data: null, error: null });
    const plan = await loadActionPlan(client, SHAPE, CACHEABLE, "[test]");
    expect(plan.warm).toBe(false);
    expect(plan.entries.size).toBe(0);
    expect(plan.fingerprint).toBe(SHAPE.fingerprint);
  });

  it("reads a stored plan, absences included", async () => {
    const { client } = fakeSupabase({
      data: {
        actions: { [EMAIL]: { selector: '[id="email"]', method: "fill" }, [LINKEDIN]: null },
        replay_hits: 42,
        replay_invalidations: 1,
      },
      error: null,
    });
    const plan = await loadActionPlan(client, SHAPE, CACHEABLE, "[test]");

    expect(plan.warm).toBe(true);
    expect(plan.entries.get(EMAIL)).toEqual({ selector: '[id="email"]', method: "fill" });
    expect(plan.entries.get(LINKEDIN)).toBeNull();
    expect(plan.priorHits).toBe(42);
    expect(plan.priorInvalidations).toBe(1);
  });

  it("throws away entries that are not the shape this code expects", async () => {
    const { client } = fakeSupabase({
      data: {
        actions: {
          [EMAIL]: { selector: '[id="email"]' },
          "no selector": { method: "fill" },
          "wrong type": 7,
          "empty selector": { selector: "" },
        },
        replay_hits: 0,
      },
      error: null,
    });
    const plan = await loadActionPlan(client, SHAPE, CACHEABLE, "[test]");
    expect([...plan.entries.keys()]).toEqual([EMAIL]);
  });

  it("observes instead of failing when the table is not there", async () => {
    // Exactly what a deploy that has not run the migration yet looks like.
    const { client } = fakeSupabase({
      data: null,
      error: { message: 'relation "public.cached_form_actions" does not exist' },
    });
    const plan = await loadActionPlan(client, SHAPE, CACHEABLE, "[test]");
    expect(plan.entries.size).toBe(0);
    expect(plan.warm).toBe(false);
  });

  it("observes instead of failing when the query throws", async () => {
    const client = {
      from() {
        throw new Error("network is unreachable");
      },
    } as unknown as SupabaseClient;
    await expect(loadActionPlan(client, SHAPE, CACHEABLE, "[test]")).resolves.toMatchObject({
      warm: false,
    });
  });

  it("reads nothing at all when the kill switch is set", async () => {
    vi.stubEnv(CACHE_DISABLED_ENV_VAR, "true");
    const { client } = fakeSupabase({
      data: { actions: { [EMAIL]: { selector: '[id="email"]' } } },
      error: null,
    });
    const plan = await loadActionPlan(client, SHAPE, CACHEABLE, "[test]");
    expect(plan.entries.size).toBe(0);
  });
});

describe("saveActionPlan", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes what the run learned, keyed on the shape", async () => {
    const { client, upserts } = fakeSupabase({ data: null, error: null });
    const plan = await loadActionPlan(client, SHAPE, CACHEABLE, "[test]");
    planRecord(plan, EMAIL, { selector: '[id="email"]', method: "fill" });
    planRecord(plan, LINKEDIN, null);

    await saveActionPlan(client, plan, "[test]");

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      ats: "greenhouse",
      form_fingerprint: SHAPE.fingerprint,
      actions: { [EMAIL]: { selector: '[id="email"]', method: "fill" }, [LINKEDIN]: null },
    });
  });

  it("adds this run's replays to the counter already on the row", async () => {
    const { client, upserts } = fakeSupabase({
      data: {
        actions: { [EMAIL]: { selector: '[id="email"]' } },
        replay_hits: 100,
        replay_invalidations: 2,
      },
      error: null,
    });
    const plan = await loadActionPlan(client, SHAPE, CACHEABLE, "[test]");
    planLookup(plan, EMAIL);
    planInvalidate(plan, EMAIL);

    await saveActionPlan(client, plan, "[test]");
    expect(upserts[0]).toMatchObject({ replay_hits: 101, replay_invalidations: 3 });
  });

  it("writes nothing when a warm run learned nothing and replayed nothing", async () => {
    const { client, upserts } = fakeSupabase({ data: null, error: null });
    const plan = await loadActionPlan(client, SHAPE, CACHEABLE, "[test]");
    await saveActionPlan(client, plan, "[test]");
    expect(upserts).toHaveLength(0);
  });

  it("swallows a write failure rather than failing the application", async () => {
    const { client } = fakeSupabase({ data: null, error: null }, { error: { message: "read only" } });
    const plan = await loadActionPlan(client, SHAPE, CACHEABLE, "[test]");
    planRecord(plan, EMAIL, { selector: '[id="email"]' });
    await expect(saveActionPlan(client, plan, "[test]")).resolves.toBeUndefined();
  });

  it("writes nothing at all when the kill switch is set", async () => {
    const { client, upserts } = fakeSupabase({ data: null, error: null });
    const plan = await loadActionPlan(client, SHAPE, CACHEABLE, "[test]");
    planRecord(plan, EMAIL, { selector: '[id="email"]' });
    vi.stubEnv(CACHE_DISABLED_ENV_VAR, "true");
    await saveActionPlan(client, plan, "[test]");
    expect(upserts).toHaveLength(0);
  });
});

// ───────────────────────────────────
// The number the ticket exists for
// ───────────────────────────────────

describe("the measured saving", () => {
  it("keeps the replay hit rate above the floor the margin needs", async () => {
    // `scripts/form-action-cache-benchmark.ts` prints the full report. This
    // holds its headline to a floor so that a change which quietly stops the
    // fingerprint matching across postings fails here rather than showing up as
    // a bill. Measured at 93.0% when this was written, against a simulated
    // replay failure rate of 5%, which is far worse than a real board should be.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runFleet();
      const hitRate = result.replayed / result.observedWithoutCache;

      expect(result.observedWithoutCache).toBeGreaterThan(1500);
      expect(hitRate).toBeGreaterThan(0.85);
      expect(result.observedWithCache).toBeLessThan(result.observedWithoutCache * 0.15);

      // One cold application per distinct form shape, and no more. If this grows
      // the fingerprint has started splitting on something specific to a posting.
      const shapes = [...result.shapesByAts.values()].reduce(
        (total, set) => total + set.size,
        0
      );
      expect(result.coldApplications).toBe(shapes);
      expect(shapes).toBeLessThan(15);
    } finally {
      spy.mockRestore();
      spyWarn.mockRestore();
    }
  }, 60_000);
});
