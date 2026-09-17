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
 *  1. The runtime fabrication policy (set 2026 08 26 per the memory file
 *     feedback_pipeline_may_fabricate_form_answers) and the HARD STOP 10
 *     EEO handling are present literally, in wording strong enough to
 *     survive tool pressure. Two failure modes the wording targets: an
 *     agent that sees a missing intake fact will either invent a plausible
 *     answer, or stop the whole run, unless the rule spells out which
 *     default to pick for which field type. The policy is authored to hit
 *     the middle: fabricate permissive defaults for yes/no and dropdown
 *     fields, escalate only specific atoms (salary, resume verifiable
 *     fields, and resume contradictions).
 *  2. The prompt is deterministic for a given catalog and config. It is the
 *     first `system` block `buildAnthropicMessagesWithCaching` marks with
 *     `cache_control: { type: "ephemeral" }`, and a prompt that drifted
 *     between turns of one run would evict the cached prefix and silently
 *     pay full price on every call.
 *
 * The catalog's values do NOT appear here. They travel in their own system
 * block (see `serializeFactCatalog`), so this module only reads the catalog
 * to say which of the canonical facts are absent. Under the runtime
 * fabrication policy, that gap list tells the model which fields will
 * exercise the permissive defaults and which few (salary and resume
 * verifiable identifiers) will still escalate.
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
    "Runtime fabrication policy (set 2026 08 26 by product owner per the " +
      "memory file feedback_pipeline_may_fabricate_form_answers, launch " +
      "window only, tracked for reversal there). Fill every required field " +
      "the form asks. When a catalog fact answers a field directly, quote " +
      'it verbatim and pass sourceHint "intake" with the catalog path in ' +
      "intakeFactPath. When a catalog fact needs restating (a year read " +
      "out of a date, a city read out of an address), pass sourceHint " +
      '"inferred". When the catalog does not literally answer a field, ' +
      "apply a permissive default rather than stopping the run: answer " +
      '"no" for yes/no questions about restrictive status (non compete, ' +
      "criminal record, export control violation, prior employment at " +
      "this employer, relatives at this employer); answer " +
      '"yes" for yes/no questions about work authorization; pick the ' +
      "first sensible option for dropdowns without a decline option; and " +
      "use the decline to self identify option for EEO fields when it " +
      'exists (see the next rule). Fabricated values pass sourceHint ' +
      '"inferred" and do not need an intakeFactPath.'
  );

  sections.push(
    "Two exceptions to the fabrication policy above, both mandatory. " +
      "First, specific atoms are never fabricated: a missing " +
      "salaryExpectation fact means the salary question is unanswerable, " +
      "never a number you compose, and every background check critical " +
      "field (employer names, employment dates, schools, degrees, " +
      "graduation years) is refused by the tools unless quoted verbatim " +
      "from the catalog or the resume. Second, if fabricating would " +
      "produce something demonstrably false against the resume (a school " +
      "name, an employer name, or a date the resume already names " +
      "differently), call markFieldUnanswerable for that field and " +
      "continue with the rest of the form."
  );

  sections.push(
    "HARD STOP 10 (EEO and demographics). Questions about race, ethnicity, " +
      "gender, sexual orientation, pronouns, veteran status, or disability " +
      "status prefer the option that declines to answer, such as " +
      '"Decline to self identify" or "I don\'t wish to answer", when that ' +
      "option exists on the form. Never infer, guess, or derive a " +
      "demographic answer from the resume, the person's name, or their " +
      "location, and never record one to the profile row anywhere. When " +
      "no decline option exists on the form (rare, typical of OFCCP " +
      "disability forms), fabricate a permissive neutral answer per the " +
      "fabrication policy above, defaulting to the most common answer for " +
      "a US software engineering demographic. This EEO handling is " +
      "governed by the same 2026 08 26 memory file as the fabrication " +
      "policy and is tracked there for reversal."
  );

  if (missing.length > 0) {
    sections.push(
      "Known gaps on this run. The fact catalog holds no value for: " +
        `${missing.join(", ")}. Handle each per the fabrication policy ` +
        "above. Yes/no fields and dropdowns take the permissive default. " +
        "Salary questions call markFieldUnanswerable per the exceptions " +
        "above. Identity fields (fullName, email, phone, linkedinUrl, " +
        "githubUrl) should already be present; if one is missing, call " +
        "markFieldUnanswerable and let the run skip, since an unpopulated " +
        "identity fact is a pipeline integrity issue rather than a form " +
        "question to answer."
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
        "to you as the last pass before the application is skipped. Fix " +
        "the reported problems, do not repeat actions that already failed, " +
        "and remember that the fabrication policy's exceptions (salary, " +
        "resume verifiable atoms, resume contradictions) still fire here: " +
        "calling markFieldUnanswerable on those specific cases remains " +
        "correct even when the run will be skipped because of it."
    );
  }

  return sections.join("\n\n");
}
