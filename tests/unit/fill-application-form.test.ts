// @vitest-environment node
/**
 * JOB-170 — the escalation gate and the provenance contract on the fill side.
 *
 * Deliberately narrow. The fabrication rung's ladder logic is covered rung by
 * rung in `tests/unit/llm-fabricate.test.ts` against `lib/candidate-answers`
 * where it lives; this file pins the three properties of THIS module the
 * ticket names:
 *
 *  1. ESCALATION_ENABLED exports as exactly false, so the gate is visible and
 *     reversible rather than buried in a deletion.
 *  2. The escalation machinery itself is untouched: a needs-tagged block
 *     reason still classifies as an escalation block, so flipping the gate
 *     back to true restores v1-C behaviour with no other edit.
 *  3. blockedForAnswers still tags its stops needs_attestation versus
 *     needs_candidate_input from the field labels, because that tag decides
 *     the skip_log reason for any residual stop.
 */
import { describe, expect, it } from "vitest";

import {
  blockedForAnswers,
  ESCALATION_ENABLED,
  isEscalationBlock,
} from "@/lib/fill-application-form";

describe("the JOB-170 escalation gate", () => {
  it("exports ESCALATION_ENABLED as false, the Option A default", () => {
    expect(ESCALATION_ENABLED).toBe(false);
  });

  it("keeps classifying needs-tagged blocks as escalations for the day the gate flips back", () => {
    expect(isEscalationBlock("needs_candidate_input: something")).toBe(true);
    expect(isEscalationBlock("needs_attestation: something")).toBe(true);
    expect(isEscalationBlock("captcha at the form")).toBe(false);
    expect(isEscalationBlock("dom_changed: step 2")).toBe(false);
  });
});

describe("residual escalation tagging is unchanged", () => {
  const url = "https://jobs.smartrecruiters.com/some/listing";

  it("a required EEO question with no decline option still tags needs_attestation", () => {
    // This is the residual case that must keep escalating under Option A:
    // fabrication and sane defaults both refuse EEO fields (HARD STOP #10),
    // so a required one with no decline option lands here with everything
    // else already filled.
    const error = blockedForAnswers(
      [
        {
          key: "gender",
          fieldLabel: "What is your gender?",
          question: 'The form asks: "What is your gender?" What should we put?',
          why: "a required self identification question offering no way to decline",
          required: true,
          kind: "select",
        },
      ],
      url
    );
    expect(error.message.startsWith("needs_attestation:")).toBe(true);
  });

  it("an ordinary unanswerable field still tags needs_candidate_input", () => {
    const error = blockedForAnswers(
      [
        {
          key: "favourite crystal",
          fieldLabel: "What is your favourite crystal?",
          question: 'The form asks: "What is your favourite crystal?" What should we put?',
          why: "nothing known answers this",
          required: true,
          kind: "text",
        },
      ],
      url
    );
    expect(error.message.startsWith("needs_candidate_input:")).toBe(true);
  });
});
