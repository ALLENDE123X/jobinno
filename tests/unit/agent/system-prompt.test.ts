/**
 * JOB-316. Golden assertions over the agent's system prompt.
 *
 * The acceptance criterion is literal: the runtime fabrication policy (set
 * 2026 08 26 per the memory file feedback_pipeline_may_fabricate_form_answers)
 * and the HARD STOP 10 EEO handling must be present such that a regex can
 * assert them. These tests are that regex. If one of them fails, the policy
 * wording was weakened, and the correct fix is the prompt, not the test.
 */

import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "@/lib/agent/system-prompt";
import type { FactCatalog } from "@/lib/agent/fact-catalog";

const FULL_CATALOG: FactCatalog = {
  userId: "u1",
  entries: [
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
  ].map((path) => ({
    path,
    label: path,
    value: "x",
    source: "profile" as const,
  })),
};

const EMPTY_CATALOG: FactCatalog = { userId: "u1", entries: [] };

const BASE_CONFIG = { ats: "greenhouse", maxSteps: 30, escalated: false };

describe("buildSystemPrompt", () => {
  it("encodes the runtime fabrication policy (2026 08 26)", () => {
    const prompt = buildSystemPrompt(FULL_CATALOG, BASE_CONFIG);
    expect(prompt).toContain("Runtime fabrication policy");
    expect(prompt).toContain("2026 08 26");
    expect(prompt).toContain("feedback_pipeline_may_fabricate_form_answers");
    expect(prompt).toContain(
      "apply a permissive default rather than stopping the run"
    );
    expect(prompt).toMatch(
      /answer "no" for yes\/no questions about restrictive status/
    );
    expect(prompt).toMatch(
      /answer "yes" for yes\/no questions about work authorization/
    );
    expect(prompt).toContain("first sensible option for dropdowns");
    expect(prompt).toContain("sourceHint");
    expect(prompt).toContain("intakeFactPath");
  });

  it("keeps escalation for salary, background check critical, and resume contradictions", () => {
    const prompt = buildSystemPrompt(FULL_CATALOG, BASE_CONFIG);
    expect(prompt).toContain("Two exceptions to the fabrication policy");
    expect(prompt).toContain("markFieldUnanswerable");
    expect(prompt).toMatch(
      /missing salaryExpectation fact means the salary question is unanswerable/
    );
    expect(prompt).toMatch(/never a number you compose/);
    expect(prompt).toMatch(/background check critical/);
    expect(prompt).toMatch(/quoted verbatim from the catalog or the resume/);
    expect(prompt).toMatch(
      /demonstrably false against the resume/
    );
  });

  it("encodes HARD STOP 10: prefer decline, fabricate when no decline option", () => {
    const prompt = buildSystemPrompt(FULL_CATALOG, BASE_CONFIG);
    expect(prompt).toMatch(/HARD STOP 10/);
    expect(prompt).toContain("Decline to self identify");
    expect(prompt).toMatch(/race/i);
    expect(prompt).toMatch(/gender/i);
    expect(prompt).toMatch(/veteran/i);
    expect(prompt).toMatch(/disability/i);
    expect(prompt).toMatch(/Never infer, guess, or derive a demographic answer/);
    expect(prompt).toContain("When no decline option exists on the form");
    expect(prompt).toContain("fabricate a permissive neutral answer");
    expect(prompt).toContain(
      "US software engineering demographic"
    );
  });

  it("carries one platform note per supported ats, each distinct", () => {
    const atses = [
      "ashby",
      "greenhouse",
      "lever",
      "workable",
      "smartrecruiters",
      "breezy",
      "bamboohr",
    ];
    const notes = new Set<string>();
    for (const ats of atses) {
      const prompt = buildSystemPrompt(FULL_CATALOG, {
        ...BASE_CONFIG,
        ats,
      });
      const match = prompt.match(/Platform note \(([^)]+)\)\. (.+)/);
      expect(match?.[1]).toBe(ats);
      expect(match?.[2]).toBeTruthy();
      notes.add(match?.[2] ?? "");
    }
    expect(notes.size).toBe(atses.length);
  });

  it("falls back to a generic platform note for an unknown ats", () => {
    const prompt = buildSystemPrompt(FULL_CATALOG, {
      ...BASE_CONFIG,
      ats: "someboard",
    });
    expect(prompt).toContain("Platform note (someboard).");
    expect(prompt).toContain("No platform notes are on file");
  });

  it("quotes the step budget to the model", () => {
    const prompt = buildSystemPrompt(FULL_CATALOG, {
      ...BASE_CONFIG,
      maxSteps: 42,
    });
    expect(prompt).toContain("at most 42 model turns");
  });

  it("marks the escalated pass, and only the escalated pass", () => {
    const first = buildSystemPrompt(FULL_CATALOG, BASE_CONFIG);
    const escalated = buildSystemPrompt(FULL_CATALOG, {
      ...BASE_CONFIG,
      escalated: true,
    });
    expect(first).not.toContain("Escalated pass");
    expect(escalated).toContain("Escalated pass");
    expect(escalated).toContain("last pass before the application is skipped");
  });

  it("names the canonical facts the catalog is missing", () => {
    const prompt = buildSystemPrompt(EMPTY_CATALOG, BASE_CONFIG);
    expect(prompt).toContain("The fact catalog holds no value for");
    expect(prompt).toContain("salaryExpectation");
    expect(prompt).toContain("workAuthorizedUs");

    const complete = buildSystemPrompt(FULL_CATALOG, BASE_CONFIG);
    expect(complete).not.toContain("The fact catalog holds no value for");
  });

  it("is deterministic for the same catalog and config", () => {
    expect(buildSystemPrompt(FULL_CATALOG, BASE_CONFIG)).toBe(
      buildSystemPrompt(FULL_CATALOG, BASE_CONFIG)
    );
  });

  it("contains no em dashes and no prose hyphens (HARD STOP 8)", () => {
    for (const catalog of [FULL_CATALOG, EMPTY_CATALOG]) {
      for (const escalated of [false, true]) {
        const prompt = buildSystemPrompt(catalog, {
          ...BASE_CONFIG,
          escalated,
        });
        expect(prompt).not.toContain("—");
        expect(/[A-Za-z]-[A-Za-z]/.test(prompt)).toBe(false);
      }
    }
  });
});
