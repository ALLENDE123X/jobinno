// @vitest-environment node
/**
 * JOB-170 — the LLM fabrication rung and its sane default fallback.
 *
 * The model call itself is stubbed at `fetch`, so every scenario here is a
 * wiring test: which rung of the pinned ladder wins, what happens when the
 * provider errors or answers garbage, and that an EEO question never reaches
 * the prompt at all. The ordering asserted below is the one pinned in the
 * ticket revision of 2026-08-26: profile column, stored answer, canonical
 * default, LLM fabrication, sane default.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  answerProvenanceEntry,
  llmFabricate,
  resolveAnswer,
  type AnswerProvenanceEntry,
} from "@/lib/candidate-answers";

function fabricationContext(
  intake: Record<string, string> = {},
  resume = "B.S. Computer Science, Georgia Tech, 2025."
) {
  return { intake, resume };
}

/** Stubs global fetch with one OpenAI shaped chat completion response. */
function stubModelResponse(content: unknown): void {
  vi.stubEnv("RESUME_LLM_API_KEY", "test-key-not-a-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
        status: 200,
      })
    )
  );
}

function stubModelError(status: number): void {
  vi.stubEnv("RESUME_LLM_API_KEY", "test-key-not-a-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("upstream exploded", { status }))
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════════════
// The pinned ladder order, rung against rung.
// ═══════════════════════════════════════════════════════════════════════════

describe("the JOB-170 ladder order", () => {
  const everythingElse = {
    options: ["Yes", "No"],
    context: fabricationContext({ citizenship_status: "us_citizen" }),
  };

  it("rung 1: profile column beats stored answer, canonical default and the LLM", async () => {
    stubModelResponse({ answer: "No", confidence: 0.9, reasoning: "test" });
    const resolved = await resolveAnswer(
      "Are you legally authorized to work in the United States?",
      { workAuthorizedUs: true },
      [
        {
          topic: "work_auth_current_us",
          question: "authorized to work?",
          answer: "No",
          answeredAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      everythingElse
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("profile_column");
    expect(resolved!.answer).toBe("Yes");
  });

  it("rung 2: stored answer beats canonical default and the LLM", async () => {
    stubModelResponse({ answer: "Yes", confidence: 0.9, reasoning: "test" });
    const resolved = await resolveAnswer(
      "Are you legally authorized to work in the United States?",
      {},
      [
        {
          topic: "work_auth_current_us",
          question: "authorized to work?",
          answer: "No",
          answeredAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      everythingElse
    );
    expect(resolved!.source).toBe("stored_by_intent");
    expect(resolved!.answer).toBe("No");
  });

  it("rung 3: canonical default beats the LLM", async () => {
    stubModelResponse({ answer: "No", confidence: 0.9, reasoning: "test" });
    const resolved = await resolveAnswer(
      "Are you at least 18 years of age or older?",
      {},
      [],
      everythingElse
    );
    expect(resolved!.source).toBe("canonical_default");
    expect(resolved!.answer).toBe("Yes");
  });

  it("rung 4: LLM fabrication answers when nothing above it did", async () => {
    stubModelResponse({ answer: "No", confidence: 0.82, reasoning: "intake says nothing binds" });
    const resolved = await resolveAnswer(
      "Are you currently subject to a non compete clause with any former employer?",
      {},
      [],
      everythingElse
    );
    expect(resolved!.source).toBe("llm_fabrication");
    expect(resolved!.answer).toBe("No");
    expect(resolved!.confidence).toBe(0.82);
    expect(resolved!.topic).toBeNull();
  });

  it("rung 5: sane default takes over only when the LLM call errors", async () => {
    stubModelError(500);
    const resolved = await resolveAnswer(
      "Are you currently subject to a non compete clause with any former employer?",
      {},
      [],
      everythingElse
    );
    expect(resolved!.source).toBe("sane_default");
    expect(resolved!.answer).toBe("No");
  });

  it("no fabrication context: rungs 4 and 5 are unreachable and the ladder escalates", async () => {
    const resolved = await resolveAnswer(
      "Are you currently subject to a non compete clause with any former employer?",
      {},
      []
    );
    expect(resolved).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// What the model is asked and what comes back.
// ═══════════════════════════════════════════════════════════════════════════

describe("llmFabricate", () => {
  it("mirrors an authorization question from intake when the classifier has no column for it", async () => {
    let capturedBody: { messages?: Array<{ role: string; content: string }> } | undefined;
    vi.stubEnv("RESUME_LLM_API_KEY", "test-key-not-a-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ answer: "Yes", confidence: 0.93, reasoning: "intake mirrors citizen" }) } },
            ],
          }),
          { status: 200 }
        );
      })
    );
    const fabricated = await llmFabricate(
      "US citizen? y/n",
      ["Yes", "No"],
      fabricationContext({
        visa_status: "US Citizen",
        citizenship_status: "us_citizen",
      })
    );
    expect(fabricated).not.toBeNull();
    expect(fabricated!.answer).toBe("Yes");
    // The grounding reached the prompt: intake lines and the option set are
    // both in the user message, and the system prompt carries the EEO rule.
    const userMessage = capturedBody!.messages!.find((m) => m.role === "user")!.content;
    expect(userMessage).toContain("visa_status: US Citizen");
    expect(userMessage).toContain("1. Yes");
    const systemMessage = capturedBody!.messages!.find((m) => m.role === "system")!.content;
    expect(systemMessage.toLowerCase()).toContain("self identification");
  });

  it("returns No for a restrictive yes/no from a grounded intake answer", async () => {
    stubModelResponse({
      answer: "No",
      confidence: 0.88,
      reasoning: "intake records no restrictive covenant",
    });
    const fabricated = await llmFabricate(
      "Are you subject to a non-compete?",
      ["Yes", "No"],
      fabricationContext({ subject_to_restrictive_covenant: "No" })
    );
    expect(fabricated!.answer).toBe("No");
    expect(fabricated!.confidence).toBeGreaterThanOrEqual(0);
    expect(fabricated!.confidence).toBeLessThanOrEqual(1);
  });

  it("returns No for a restrictive yes/no when intake holds nothing (permissive default)", async () => {
    stubModelResponse({ answer: "No", confidence: 0.6, reasoning: "nothing indicates otherwise" });
    const fabricated = await llmFabricate(
      "Are you subject to a non-compete?",
      ["Yes", "No"],
      fabricationContext()
    );
    expect(fabricated!.answer).toBe("No");
  });

  it("returns null on an API error so the caller falls to the sane default without throwing", async () => {
    stubModelError(503);
    await expect(
      llmFabricate("Anything at all?", [], fabricationContext())
    ).resolves.toBeNull();
  });

  it("returns null on malformed model output instead of passing it through", async () => {
    stubModelResponse({ answer: "No", confidence: "very", reasoning: 7 });
    await expect(
      llmFabricate("Anything at all?", [], fabricationContext())
    ).resolves.toBeNull();
  });

  it("returns null when the model declines to invent an ungrounded atom", async () => {
    stubModelResponse({
      answer: "",
      confidence: 0.1,
      reasoning: "no salary figure was ever stated by the candidate",
    });
    await expect(
      llmFabricate(
        "What are your salary expectations?",
        [],
        fabricationContext({ grad_date: "2025-12-31" })
      )
    ).resolves.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HARD STOP #10: EEO questions are never fabricated and never defaulted.
// ═══════════════════════════════════════════════════════════════════════════

describe("EEO decline preservation", () => {
  it("never fabricates an EEO field even when its options include decline", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const resolved = await resolveAnswer(
      "What is your gender?",
      {},
      [],
      {
        options: ["Male", "Female", "Decline to self-identify"],
        context: fabricationContext({ gender: "Male" }),
      }
    );
    expect(resolved).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never defaults an EEO field either, with or without a decline option", async () => {
    const resolved = await resolveAnswer(
      "Are you a veteran?",
      {},
      [],
      { options: ["Yes", "No"], context: fabricationContext() }
    );
    expect(resolved).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Change 3: the provenance entry shape.
// ═══════════════════════════════════════════════════════════════════════════

describe("answerProvenanceEntry", () => {
  it("carries source and model_confidence for a fabricated answer", () => {
    const entry: AnswerProvenanceEntry = answerProvenanceEntry({
      fieldKey: "non compete",
      fieldLabel: "Are you subject to a non-compete?",
      questionText: "Are you subject to a non-compete?",
      resolution: {
        answer: "No",
        source: "llm_fabrication",
        topic: null,
        confidence: 0.82,
        reasoning: "intake says nothing binds",
      },
    });
    expect(entry.source).toBe("llm_fabrication");
    expect(entry.model_confidence).toBe(0.82);
    expect(entry.answered_value).toBe("No");
  });

  it("omits model_confidence for a sane default, which no model produced", () => {
    const entry = answerProvenanceEntry({
      fieldKey: "k",
      fieldLabel: "l",
      questionText: "q",
      resolution: { answer: "No", source: "sane_default", topic: null },
    });
    expect(entry.source).toBe("sane_default");
    expect(entry.model_confidence).toBeUndefined();
  });
});
