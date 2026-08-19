/**
 * JOB-006. What the shared form action cache is actually worth, in `observe()`
 * calls not made.
 *
 * Run it with `npm run bench:form-cache`. It talks to nothing: no browser, no
 * model, no database, no network. Everything it measures comes out of the real
 * code the pipeline runs, driven over form shapes copied from the three boards
 * JOB-000's probe found live postings on.
 *
 * ── What is measured and what is assumed ────────────────────────────────────
 * Measured, exactly, by running the shipped functions: how many `observe()`
 * calls a fleet of applications makes with the cache off and with it on, how
 * many distinct form shapes each platform turns out to have, and how many
 * replays fail their checks and cost a live call anyway.
 *
 * Assumed, and stated rather than buried: what one `observe()` call costs. The
 * ticket's own figure is $0.10 to $0.15 of LLM spend across 20 to 40 calls for a
 * full application, which puts a call somewhere between $0.0025 and $0.0075, so
 * the table below prices the same measured call counts at three points across
 * that band instead of picking one and calling it a fact.
 *
 * ── What this does not claim ────────────────────────────────────────────────
 * `observe()` is not the whole model bill for an application. Reading the page
 * with `extract()`, parsing the resume, deciding answers and writing essays are
 * all separate calls, and none of them is cacheable this way: they depend on the
 * candidate and on the posting rather than on the platform's form layout.
 * `observe()` is the part that repeats identically across applications, which is
 * exactly why it is the part worth caching, and the report below counts it and
 * nothing else.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  detectAts,
  fingerprintFormShape,
  loadActionPlan,
  planInvalidate,
  planLookup,
  planRecord,
  saveActionPlan,
  type ActionPlan,
  type CoreSlot,
  type ShapeField,
} from "@/lib/form-action-cache";

// ───────────────────────────────────
// The instructions, and the slots they ask about
// ───────────────────────────────────

/**
 * Copied from `CACHEABLE_INSTRUCTIONS` in `lib/fill-application-form.ts` rather
 * than imported, so this script does not drag a Supabase client, the Gmail
 * modules and the whole form fill into a benchmark. The unit test pins the real
 * map; this only has to be the same nine slots.
 */
const SLOT_INSTRUCTIONS: ReadonlyMap<CoreSlot, string> = new Map([
  ["firstName", "the First Name input on the job application form"],
  ["lastName", "the Last Name input on the job application form"],
  ["fullName", "the single Full Name input on the job application form"],
  ["email", "the email address input on the job application form"],
  ["phone", "the phone number input on the job application form"],
  ["linkedin", "the LinkedIn profile URL input on the job application form"],
  ["website", "the personal website or portfolio URL input on the job application form"],
  ["resume", "the file upload control for the applicant's resume or CV"],
  ["coverLetter", "the multi-line text box where the applicant types or pastes their cover letter"],
]);

const CACHEABLE: ReadonlyMap<string, CoreSlot> = new Map(
  [...SLOT_INSTRUCTIONS].map(([slot, instruction]) => [instruction, slot] as const)
);

// ───────────────────────────────────
// Form shapes, as the three boards lay them out
// ───────────────────────────────────

type Board = {
  ats: string;
  /** Where an apply URL on this platform points, for the ATS detector. */
  applyUrl: (token: string, id: number) => string;
  /** The platform's own boilerplate, before any company's own questions. */
  variants: readonly { name: string; weight: number; fields: readonly ShapeField[] }[];
};

const field = (label: string, kind: string, selector: string): ShapeField => ({
  label,
  kind,
  selector,
});

const GREENHOUSE_CORE: readonly ShapeField[] = [
  field("First Name", "text", '[id="first_name"]'),
  field("Last Name", "text", '[id="last_name"]'),
  field("Email", "text", '[id="email"]'),
  field("Phone", "text", '[id="phone"]'),
  field("Resume/CV", "file", '[id="resume"]'),
];

const LEVER_CORE: readonly ShapeField[] = [
  field("Full name", "text", "xpath=/html[1]/body[1]/div[2]/form[1]/div[1]/input[1]"),
  field("Email", "text", "xpath=/html[1]/body[1]/div[2]/form[1]/div[2]/input[1]"),
  field("Phone", "text", "xpath=/html[1]/body[1]/div[2]/form[1]/div[3]/input[1]"),
  field("Resume/CV", "file", '[id="resume-upload-input"]'),
];

const ASHBY_CORE: readonly ShapeField[] = [
  field("Name", "text", '[id="_systemfield_name"]'),
  field("Email", "text", '[id="_systemfield_email"]'),
  field("Resume", "file", '[id="_systemfield_resume"]'),
];

/**
 * Weights are a rough read of the real world rather than a measurement: most
 * Greenhouse boards run the stock form, a good minority add a LinkedIn box, and
 * a smaller slice asks for a typed cover letter. What the benchmark is sensitive
 * to is how many distinct shapes exist per platform, not the exact split.
 */
const BOARDS: readonly Board[] = [
  {
    ats: "greenhouse",
    applyUrl: (token, id) =>
      `https://job-boards.greenhouse.io/embed/job_app?for=${token}&token=${id}`,
    variants: [
      { name: "stock", weight: 55, fields: GREENHOUSE_CORE },
      {
        name: "with LinkedIn",
        weight: 25,
        fields: [
          ...GREENHOUSE_CORE,
          field("LinkedIn Profile", "text", '[id="job_application_answers_attributes_0_text_value"]'),
        ],
      },
      {
        name: "with LinkedIn and website",
        weight: 12,
        fields: [
          ...GREENHOUSE_CORE,
          field("LinkedIn Profile", "text", '[id="job_application_answers_attributes_0_text_value"]'),
          field("Website", "text", '[id="job_application_answers_attributes_1_text_value"]'),
        ],
      },
      {
        name: "with a cover letter box",
        weight: 8,
        fields: [...GREENHOUSE_CORE, field("Cover Letter", "textarea", '[id="cover_letter_text"]')],
      },
    ],
  },
  {
    ats: "lever",
    applyUrl: (token, id) => `https://jobs.lever.co/${token}/00000000-0000-0000-0000-${id}/apply`,
    variants: [
      { name: "stock", weight: 60, fields: LEVER_CORE },
      {
        name: "with URL fields",
        weight: 40,
        fields: [
          ...LEVER_CORE,
          field("LinkedIn URL", "text", "xpath=/html[1]/body[1]/div[2]/form[1]/div[5]/input[1]"),
          field("GitHub URL", "text", "xpath=/html[1]/body[1]/div[2]/form[1]/div[6]/input[1]"),
        ],
      },
    ],
  },
  {
    ats: "ashby",
    applyUrl: (token, id) => `https://jobs.ashbyhq.com/${token}/${id}/application`,
    variants: [
      { name: "stock", weight: 70, fields: ASHBY_CORE },
      {
        name: "with LinkedIn",
        weight: 30,
        fields: [...ASHBY_CORE, field("LinkedIn", "text", '[id="_systemfield_linkedin"]')],
      },
    ],
  },
];

/** Share of the fleet's applications that land on each platform. */
const BOARD_MIX: readonly { board: Board; weight: number }[] = [
  { board: BOARDS[0], weight: 55 },
  { board: BOARDS[1], weight: 25 },
  { board: BOARDS[2], weight: 20 },
];

// ───────────────────────────────────
// A fleet of applications
// ───────────────────────────────────

/** Applications a Season Pass covers. The number the margin is decided at. */
const FLEET_SIZE = 500;

/**
 * How often a stored selector turns out not to resolve, or to resolve to the
 * wrong control, and has to be observed live after all.
 *
 * Set high on purpose. The real rate should be far below this on a platform
 * whose form has not changed, and the point of pricing it at one replay in
 * twenty is to show that the saving survives a cache that is wrong far more
 * often than it should be. A failed replay is not free and is not counted as if
 * it were: it costs the model call it tried to save, and the run continues.
 */
const REPLAY_FAILURE_RATE = 0.05;

/** The application at which Greenhouse is taken to have renamed its ids. */
const LAYOUT_CHANGE_AT = 350;

/** Deterministic, so two runs of this script report the same numbers. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(items: readonly { weight: number }[], roll: number): number {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let cursor = roll * total;
  for (let index = 0; index < items.length; index++) {
    cursor -= items[index].weight;
    if (cursor <= 0) return index;
  }
  return items.length - 1;
}

/**
 * The custom questions a company hangs off the platform's form.
 *
 * They are the majority of a real application form and they are the reason a
 * naive fingerprint over every control would never match twice. None of them
 * classifies as a boilerplate slot, so none of them should reach the digest.
 */
function customQuestions(count: number, salt: number): ShapeField[] {
  return Array.from({ length: count }, (_, index) =>
    field(
      `Company question ${salt}.${index}`,
      index % 3 === 0 ? "select" : "text",
      `[id="question_${salt * 1000 + index}"]`
    )
  );
}

/** Greenhouse renaming its own ids: same slots, different selectors. */
function renameGreenhouseIds(fields: readonly ShapeField[]): ShapeField[] {
  return fields.map((entry) =>
    entry.selector.startsWith('[id="') && !entry.selector.includes("question_")
      ? field(entry.label, entry.kind, entry.selector.replace('[id="', '[id="gh_'))
      : entry
  );
}

// ───────────────────────────────────
// A Postgres stand in
// ───────────────────────────────────

type Row = {
  actions: Record<string, unknown>;
  replay_hits: number;
  replay_invalidations: number;
};

/**
 * Implements the two calls `lib/form-action-cache.ts` makes, so the benchmark
 * exercises the shipped read and write paths including their serialisation
 * rather than a simplified copy of them.
 */
function inMemorySupabase(store: Map<string, Row>): SupabaseClient {
  let selectAts = "";
  let selectFingerprint = "";
  const client = {
    from() {
      return {
        select() {
          return {
            eq(_column: string, value: string) {
              selectAts = value;
              return {
                eq(_second: string, fingerprint: string) {
                  selectFingerprint = fingerprint;
                  return {
                    async maybeSingle() {
                      const row = store.get(`${selectAts}:${selectFingerprint}`);
                      return { data: row ?? null, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        async upsert(row: Record<string, unknown>) {
          store.set(`${row.ats as string}:${row.form_fingerprint as string}`, {
            actions: row.actions as Record<string, unknown>,
            replay_hits: row.replay_hits as number,
            replay_invalidations: row.replay_invalidations as number,
          });
          return { error: null };
        },
      };
    },
  };
  return client as unknown as SupabaseClient;
}

// ───────────────────────────────────
// One application
// ───────────────────────────────────

type RunTally = {
  /** Model calls this application actually made. */
  observed: number;
  /** Lookups the cache answered. */
  replayed: number;
  /** Replays that failed their checks and cost a live call anyway. */
  invalidated: number;
};

/**
 * The `observe()` traffic of one form fill, and nothing else.
 *
 * Mirrors what `fillFields` and `attachResume` really do: one lookup per
 * boilerplate field the form has, and one for the resume upload only when the
 * page has more than one file input, because a page with exactly one takes the
 * deterministic path and needs no model at all. Clicks are excluded throughout,
 * since the cache is not allowed to answer for them.
 */
function runApplication(
  plan: ActionPlan | null,
  slots: readonly CoreSlot[],
  failureRoll: () => number
): RunTally {
  const tally: RunTally = { observed: 0, replayed: 0, invalidated: 0 };

  for (const slot of slots) {
    const instruction = SLOT_INSTRUCTIONS.get(slot);
    if (instruction === undefined) continue;

    const lookup = planLookup(plan, instruction);
    if (lookup.hit && lookup.action !== null) {
      if (failureRoll() < REPLAY_FAILURE_RATE) {
        // The selector did not hold up against the DOM. `reResolveLive` drops it
        // and pays for a real call, which is the honest cost of a wrong row.
        planInvalidate(plan, instruction);
        tally.invalidated++;
        tally.observed++;
        planRecord(plan, instruction, { selector: `fresh:${slot}`, method: "fill" });
        continue;
      }
      tally.replayed++;
      continue;
    }

    tally.observed++;
    planRecord(plan, instruction, { selector: `observed:${slot}`, method: "fill" });
  }

  return tally;
}

/** Which boilerplate fields a fill would actually go looking for on this form. */
function lookupSlots(shapeSlots: ReadonlySet<CoreSlot>, fileInputs: number): CoreSlot[] {
  const slots: CoreSlot[] = [...shapeSlots].filter((slot) => slot !== "resume");
  // `attachResume` only asks a model when the page has more than one file input.
  if (shapeSlots.has("resume") && fileInputs > 1) slots.push("resume");
  return slots;
}

// ───────────────────────────────────
// The fleet
// ───────────────────────────────────

type FleetResult = {
  applications: number;
  observedWithoutCache: number;
  observedWithCache: number;
  replayed: number;
  invalidated: number;
  shapesByAts: Map<string, Set<string>>;
  coldApplications: number;
};

async function runFleet(): Promise<FleetResult> {
  const random = seededRandom(20260819);
  const store = new Map<string, Row>();
  const supabase = inMemorySupabase(store);

  const result: FleetResult = {
    applications: FLEET_SIZE,
    observedWithoutCache: 0,
    observedWithCache: 0,
    replayed: 0,
    invalidated: 0,
    shapesByAts: new Map(),
    coldApplications: 0,
  };

  for (let index = 0; index < FLEET_SIZE; index++) {
    const board = BOARD_MIX[pick(BOARD_MIX, random())].board;
    const variant = board.variants[pick(board.variants, random())];
    const company = `company${Math.floor(random() * 400)}`;

    // Every posting brings its own custom questions. None of them may reach the
    // fingerprint, which is what makes one stored plan serve hundreds of
    // postings.
    let fields: ShapeField[] = [
      ...variant.fields,
      ...customQuestions(Math.floor(random() * 16), index),
    ];
    if (board.ats === "greenhouse" && index >= LAYOUT_CHANGE_AT) {
      fields = renameGreenhouseIds(fields);
    }

    // Through the real detector rather than the board's own label, so a change
    // that stopped recognising an apply URL would show up here as the hit rate
    // collapsing rather than passing silently.
    const shape = fingerprintFormShape(
      detectAts(board.applyUrl(company, 100000 + index)),
      fields
    );
    const seen = result.shapesByAts.get(shape.ats) ?? new Set<string>();
    if (!seen.has(shape.fingerprint)) result.coldApplications++;
    seen.add(shape.fingerprint);
    result.shapesByAts.set(shape.ats, seen);

    const fileInputs = variant.fields.filter((entry) => entry.kind === "file").length;
    const slots = lookupSlots(shape.slots, fileInputs);

    // The baseline: every lookup is a model call, which is what the code did
    // before this ticket, because the per URL cache never sees the same URL
    // twice in production.
    result.observedWithoutCache += slots.length;

    const plan = await loadActionPlan(supabase, shape, CACHEABLE, "[bench]");
    const tally = runApplication(plan, slots, random);
    await saveActionPlan(supabase, plan, "[bench]");

    result.observedWithCache += tally.observed;
    result.replayed += tally.replayed;
    result.invalidated += tally.invalidated;
  }

  return result;
}

// ───────────────────────────────────
// The report
// ───────────────────────────────────

/** Per call prices spanning the ticket's own $0.10 to $0.15 per application. */
const PRICE_POINTS = [0.0025, 0.004, 0.0075];

/**
 * Every model call one application makes, as `[calls, what, cacheable this
 * way]`, so the `observe()` saving above is read against the bill it belongs to
 * rather than mistaken for the whole of it.
 *
 * Counts come from reading the call sites rather than from running them. The
 * three `observe()` and `extract()` rows are much the most expensive per call,
 * because they send the board's whole rendered page, while the resume and answer
 * calls send a few thousand characters of text each.
 */
const CALL_INVENTORY: readonly (readonly [string, string, string])[] = [
  ["4 to 9", "observe(), one per boilerplate field", "yes, this ticket"],
  ["2 to 4", "extract(), the page reader", "no, see the note below"],
  ["1", "extract(), the confirmation reader", "no"],
  ["1 to 2", "act() on a sentence, the submit click", "never, by design"],
  ["1", "parse the resume", "not shareable, per candidate"],
  ["1", "decide the custom field answers", "not shareable, per posting"],
  ["0 to 4", "write the cover letter and essays", "not shareable, per posting"],
];

const money = (value: number): string => `$${value.toFixed(2)}`;
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  // The benchmark measures the mechanism, not a database, so the kill switch
  // must be off however the shell that started it is configured.
  delete process.env.FORM_ACTION_CACHE_DISABLED;

  const quiet = process.argv.includes("--verbose") ? null : console.log;
  if (quiet !== null) console.log = () => {};
  const result = await runFleet();
  if (quiet !== null) console.log = quiet;

  const avoided = result.observedWithoutCache - result.observedWithCache;
  const hitRate = result.replayed / result.observedWithoutCache;

  const lines: string[] = [];
  lines.push("");
  lines.push("JOB-006  observe() replay cache, simulated over one Season Pass");
  lines.push("=".repeat(66));
  lines.push(`applications                     ${result.applications}`);
  lines.push(`observe() calls, cache off       ${result.observedWithoutCache}`);
  lines.push(`observe() calls, cache on        ${result.observedWithCache}`);
  lines.push(`calls avoided                    ${avoided}  (${percent(avoided / result.observedWithoutCache)})`);
  lines.push(`replay hit rate                  ${percent(hitRate)}`);
  lines.push(`replays that failed their checks ${result.invalidated}`);
  lines.push(
    `applications that paid full      ${result.coldApplications}  ` +
      `(a form shape nobody had filed yet)`
  );
  lines.push("");
  lines.push("distinct form shapes seen");
  for (const [ats, shapes] of [...result.shapesByAts].sort()) {
    lines.push(`  ${ats.padEnd(14)} ${shapes.size}`);
  }
  lines.push("");
  lines.push("cost, at three prices per observe() call");
  lines.push(`  ${"per call".padEnd(12)}${"cache off".padStart(12)}${"cache on".padStart(12)}${"saved".padStart(12)}`);
  for (const price of PRICE_POINTS) {
    const off = result.observedWithoutCache * price;
    const on = result.observedWithCache * price;
    lines.push(
      `  ${`$${price.toFixed(4)}`.padEnd(12)}${money(off).padStart(12)}${money(on).padStart(12)}` +
        `${money(off - on).padStart(12)}`
    );
  }
  lines.push("");
  lines.push(
    "The call counts are measured. The prices are the ticket's own $0.10 to $0.15"
  );
  lines.push(
    "per application over 20 to 40 calls, spread across the band rather than"
  );
  lines.push("reduced to one number this repository cannot verify.");
  lines.push("");
  lines.push("where observe() sits in one application's model bill");
  lines.push(
    `  ${"calls".padEnd(9)}${"what".padEnd(40)}cacheable`
  );
  for (const [calls, what, cached] of CALL_INVENTORY) {
    lines.push(`  ${calls.padEnd(9)}${what.padEnd(40)}${cached}`);
  }
  lines.push("");
  lines.push(
    "Read that table before quoting the saving. The engine is already mostly"
  );
  lines.push(
    "deterministic: ACT-015 fills every custom question through the DOM with no"
  );
  lines.push(
    "model in the path, so observe() is roughly a third of the calls rather than"
  );
  lines.push(
    "the 20 to 40 a naive per field agent would make. It is a larger share of the"
  );
  lines.push(
    "money than of the count, because it and extract() are the two calls that send"
  );
  lines.push(
    "the board's whole rendered page. extract() is the obvious next ticket and is"
  );
  lines.push(
    "deliberately not this one: its answers include whether a captcha is on screen"
  );
  lines.push(
    "and whether the application has already been submitted, which are facts about"
  );
  lines.push("this moment rather than about the form's layout.");
  lines.push("");

  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Only prints when somebody ran this file. `tests/unit/form-action-cache.test.ts`
 * imports `runFleet` to hold the headline number to a floor in CI, and a
 * benchmark that dumped a table into the test output every run would be its own
 * small annoyance.
 */
if (/form-action-cache-benchmark/.test(process.argv[1] ?? "")) void main();

export { runFleet, FLEET_SIZE, REPLAY_FAILURE_RATE, CACHEABLE, SLOT_INSTRUCTIONS };
