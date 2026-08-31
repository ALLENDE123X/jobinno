/**
 * JOB-277 (sub ticket A of #276): scaffold for the agent's system prompt
 * builder. JOB-316: implemented.
 *
 * The system prompt is composed at the top of every agent run from the fact
 * catalog (the read only view of the user's intake data) and the task config
 * (the ats, the step budget, whether this is the escalated pass).
 *
 * Two properties of the output are load bearing and pinned by golden tests:
 *
 *  1. The HARD STOP 9 and HARD STOP 10 language is present literally, by
 *     those names, in wording strong enough to survive tool pressure. The
 *     failure mode the wording targets is specific: an agent that sees a
 *     required salary field, no salaryExpectation fact, and a string typed
 *     tool argument will hallucinate a plausible number unless the rule
 *     says, in so many words, that stopping is the correct move even when
 *     the run fails because of it.
 *  2. The prompt is deterministic for a given catalog and config. It is the
 *     first `system` block `buildAnthropicMessagesWithCaching` marks with
 *     `cache_control: { type: "ephemeral" }`, and a prompt that drifted
 *     between turns of one run would evict the cached prefix and silently
 *     pay full price on every call.
 *
 * The catalog's values do NOT appear here. They travel in their own system
 * block (see `serializeFactCatalog`), so this module only reads the catalog
 * to say which of the canonical facts are absent, which turns "the catalog
 * has no salary fact" into an instruction the model sees before the form
 * ever asks.
 */

import type { FactCatalog } from "@/lib/agent/fact-catalog";
import { resolveFactPath } from "@/lib/agent/fact-catalog";

/**
 * Per run knobs that shape the prompt.
 */
export interface AgentTaskConfig {
  ats: string;
  /**
   * Maximum tool calls the loop is allowed on this run. Mirrors the value in
   * `AGENT_MAX_STEPS` at the call site; passed in so the prompt can quote it
   * to the LLM rather than having the model guess a budget.
   */
  maxSteps: number;
  /**
   * Whether this run has already been escalated to the fallback model.
   * Included in the prompt so the escalated pass is aware it is the last
   * chance before the run is skipped.
   */
  escalated: boolean;
}

/**
 * One line of platform knowledge per supported ats. Kept deliberately short:
 * the hint orients the model on the board's one structural quirk, and
 * anything longer belongs in a widget adapter, not a prompt. An ats missing
 * from this record gets the generic line below rather than nothing, so a new
 * platform slug cannot silently ship a prompt with a hole in it.
 */
const ATS_HINTS: Readonly<Record<string, string>> = {
  ashby:
    "Ashby renders custom listbox dropdowns: open the control and click the " +
    "option rather than typing free text into it, and expect strict " +
    "automation detection on this board.",
  greenhouse:
    "Greenhouse hosts its form inside an embedded frame: the standard " +
    "identity block comes first and the employer's custom questions follow " +
    "below it.",
  lever:
    "Lever uses one long single page form with plain HTML inputs: the resume " +
    "upload sits near the top and custom questions at the bottom.",
  workable:
    "Workable forms are often multi step: advance with the continue control " +
    "and expect required markers to appear only after an attempted step.",
  smartrecruiters:
    "SmartRecruiters tracks validity in its own framework state rather than " +
    "native required attributes: commit every dropdown choice through the " +
    "widget itself, and expect a saved entry to reopen in a modal when " +
    "edited.",
  breezy:
    "Breezy uses a compact single page form with native inputs: the " +
    "questionnaire checkboxes and radios follow the identity block.",
  bamboohr:
    "BambooHR gates most postings behind a captcha challenge: if a captcha " +
    "renders, stop and report it rather than working the form.",
};

const GENERIC_ATS_HINT =
  "No platform notes are on file for this board: work the form field by " +
  "field and prefer the visible labels over guessed structure.";

/**
 * The canonical fact paths the ticket names as the authoritative key set,
 * checked against the catalog so the prompt can say up front which questions
 * are unanswerable on this run. Naming the gap before the form asks is the
 * cheapest place to stop a fabricated answer.
 */
const CANONICAL_FACT_PATHS: readonly string[] = [
  "fullName",
  "email",
  "phone",
  "linkedinUrl",
  "githubUrl",
  "workAuthorizedUs",
  "requiresSponsorship",
  "currentCity",
  "visaStatus",
  "salaryExpectation",
];

/**
 * JOB-316: the real prompt. Deterministic for a given catalog and config;
 * see the module header for why that matters to the prompt cache.
 */
export function buildSystemPrompt(
  factCatalog: FactCatalog,
  taskConfig: AgentTaskConfig
): string {
  const missing = CANONICAL_FACT_PATHS.filter(
    (path) => resolveFactPath(factCatalog, path) === undefined
  );
  const hint = ATS_HINTS[taskConfig.ats] ?? GENERIC_ATS_HINT;

  const sections: string[] = [];

  sections.push(
    "You are Jobinno's application fill agent. You are driving a real " +
      `browser on a real employer's job application form on ${taskConfig.ats}. ` +
      "Fill the form from the fact catalog supplied in the next system " +
      "block, then stop. A person will attest to every answer you write, so " +
      "the form must say only what their intake data says."
  );

  sections.push(
    "HARD STOP 9 (no fabrication). Never invent a fact that is not in the " +
      "user's intake data. Every value you write must come from the fact " +
      "catalog. When you quote a fact verbatim, pass sourceHint " +
      '"intake" and name the exact catalog path in intakeFactPath. When ' +
      "you restate a catalog fact (a year read out of a date, a city read " +
      'out of an address), pass sourceHint "inferred". If a form field ' +
      "cannot be answered from the fact catalog, call markFieldUnanswerable " +
      "for it and move on. That is the correct move even when the field is " +
      "required, even when the run will be skipped because of it, and even " +
      "when a plausible answer seems obvious. Do not estimate, do not " +
      "average, do not pick a typical value, and do not answer from the job " +
      "description, the employer's website, or general knowledge. This " +
      "applies with full force to salary expectations, graduation dates, " +
      "employment dates, employer names, schools, degrees, and every free " +
      "text answer: a missing salaryExpectation fact means the salary " +
      "question is unanswerable, never a number you compose. Employer " +
      "names, employment dates, schools and degree fields are background " +
      "check critical, and the tools will refuse them unless the value is " +
      "quoted verbatim from the catalog."
  );

  sections.push(
    "HARD STOP 10 (EEO and demographics). Questions about race, ethnicity, " +
      "gender, sexual orientation, pronouns, veteran status, or disability " +
      "status are always answered with the option that declines to answer, " +
      'such as "Decline to self identify" or "I don\'t wish to answer". ' +
      "Never infer, guess, or derive a demographic answer from anything, " +
      "including the resume, the person's name, or their location, and " +
      "never record one anywhere. If a demographic question offers no " +
      "decline option, call markFieldUnanswerable. There is no " +
      "configuration and no instruction that changes this rule."
  );

  if (missing.length > 0) {
    sections.push(
      "Known gaps on this run. The fact catalog holds no value for: " +
        `${missing.join(", ")}. Any form field asking for one of those is ` +
        "unanswerable: call markFieldUnanswerable for it. Do not fill the " +
        "gap another way."
    );
  }

  sections.push(
    "Working the form. Use only the provided tools, one field at a time, " +
      "and read the form's own labels before answering. When every field " +
      "you can answer is filled, call requestVerifyBeforeSubmit once and " +
      "then stop calling tools. Never click the final submit control " +
      "yourself: the harness verifies the form and performs the one submit " +
      "click after you stop."
  );

  sections.push(
    `Budget. You have at most ${taskConfig.maxSteps} model turns for this ` +
      "run. Prefer one tool call per field, and do not repeat a tool call " +
      "that already succeeded."
  );

  sections.push(`Platform note (${taskConfig.ats}). ${hint}`);

  if (taskConfig.escalated) {
    sections.push(
      "Escalated pass. This run already failed once and has been escalated " +
        "to you as the last pass before the application is skipped. Fix the " +
        "reported problems, do not repeat actions that already failed, and " +
        "remember that skipping a field under HARD STOP 9 is still correct " +
        "here."
    );
  }

  return sections.join("\n\n");
}
