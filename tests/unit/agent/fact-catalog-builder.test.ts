/**
 * JOB-296 Phase 2. Tests for the `buildAgentFactCatalog` adapter.
 *
 * The adapter reads the same intake data the legacy fill reads, hands it
 * to the ported `buildFactCatalog` to produce `CandidateFact[]`, then maps
 * that into the `FactCatalog { userId, entries: FactEntry[] }` shape the
 * agent's system prompt builder expects. These tests pin the mapping and
 * the source classification without touching the database or the resume
 * parser.
 */

import { describe, expect, it } from "vitest";

import { buildAgentFactCatalog } from "@/lib/agent/fact-catalog";
import type { CandidateApplicationAnswers } from "@/lib/candidate-intake";
import type { ResumeProfile } from "@/lib/resume-parser";

function fakeProfile(): ResumeProfile {
  return {
    firstName: "Pranav",
    lastName: "Lende",
    email: "pranav@example.test",
    phone: "+1 415 555 0111",
    linkedinUrl: "https://linkedin.com/in/pranavlende",
    websiteUrl: "https://pranavlende.com",
    githubUrl: "https://github.com/pranavlende",
    location: "San Francisco, CA",
    workHistory: [
      {
        company: "Acme Corp",
        title: "Software Engineer",
        startDate: "2024",
        endDate: null,
        summary: "Built things.",
      },
    ],
    education: [
      {
        school: "Georgia Tech",
        degree: "BS",
        discipline: "Computer Science",
        endDate: "2024",
      },
    ],
    skills: ["TypeScript", "React", "Postgres"],
    resumeStatedEmail: null,
    warnings: [],
  } satisfies ResumeProfile;
}

function fakeAnswers(): CandidateApplicationAnswers {
  return {
    workAuthorizedUs: true,
    requiresSponsorship: false,
    currentCountry: "United States",
    currentCity: "San Francisco",
    willingToRelocate: true,
    citizenshipStatus: "us_citizen",
    gradDate: "2024-05",
    earliestStart: "2026-09-01",
  };
}

describe("buildAgentFactCatalog", () => {
  it("returns the userId on the outer catalog", async () => {
    const catalog = await buildAgentFactCatalog("user_abc", {
      loadProfile: async () => fakeProfile(),
      loadAnswers: async () => ({ answers: fakeAnswers(), additional: {} }),
    });
    expect(catalog.userId).toBe("user_abc");
    expect(catalog.entries.length).toBeGreaterThan(0);
  });

  it("classifies education and work keys as `resume` source", async () => {
    const catalog = await buildAgentFactCatalog("user_abc", {
      loadProfile: async () => fakeProfile(),
      loadAnswers: async () => ({ answers: fakeAnswers(), additional: {} }),
    });
    const byPath = new Map(catalog.entries.map((e) => [e.path, e]));

    expect(byPath.get("work0.employer")?.source).toBe("resume");
    expect(byPath.get("education0.school")?.source).toBe("resume");
    expect(byPath.get("skills")?.source).toBe("resume");
    expect(byPath.get("mostRecentEmployer")?.source).toBe("resume");
    expect(byPath.get("school")?.source).toBe("resume");
    expect(byPath.get("degree")?.source).toBe("resume");
    expect(byPath.get("discipline")?.source).toBe("resume");
    expect(byPath.get("githubUrl")?.source).toBe("resume");
  });

  it("classifies profile fields as `profile` source", async () => {
    const catalog = await buildAgentFactCatalog("user_abc", {
      loadProfile: async () => fakeProfile(),
      loadAnswers: async () => ({ answers: fakeAnswers(), additional: {} }),
    });
    const byPath = new Map(catalog.entries.map((e) => [e.path, e]));

    expect(byPath.get("firstName")?.source).toBe("profile");
    expect(byPath.get("email")?.source).toBe("profile");
    expect(byPath.get("currentCountry")?.source).toBe("profile");
    expect(byPath.get("workAuthorizedUs")?.source).toBe("profile");
  });

  it("carries `answer:` prefixed keys through as `candidate_answer`", async () => {
    const catalog = await buildAgentFactCatalog("user_abc", {
      loadProfile: async () => fakeProfile(),
      loadAnswers: async () => ({
        answers: fakeAnswers(),
        additional: { "Why do you want to work here?": "Because I care." },
      }),
    });
    const answerEntry = catalog.entries.find((e) =>
      e.path.startsWith("answer:")
    );
    expect(answerEntry).toBeDefined();
    expect(answerEntry!.source).toBe("candidate_answer");
    expect(answerEntry!.value).toBe("Because I care.");
  });

  it("merges options.additionalAnswers over the loadAnswers output", async () => {
    const catalog = await buildAgentFactCatalog("user_abc", {
      loadProfile: async () => fakeProfile(),
      loadAnswers: async () => ({
        answers: fakeAnswers(),
        additional: { "How did you hear?": "LinkedIn" },
      }),
      additionalAnswers: { "How did you hear?": "Referral" },
    });
    const entry = catalog.entries.find(
      (e) => e.path === 'answer:How did you hear?'
    );
    expect(entry?.value).toBe("Referral");
  });

  it("refuses an empty userId with a clear message", async () => {
    await expect(
      buildAgentFactCatalog("  ", {
        loadProfile: async () => fakeProfile(),
        loadAnswers: async () => ({ answers: fakeAnswers(), additional: {} }),
      })
    ).rejects.toThrow("non-empty userId");
  });

  it("trims the userId before threading it into the catalog", async () => {
    const catalog = await buildAgentFactCatalog("  user_trim  ", {
      loadProfile: async () => fakeProfile(),
      loadAnswers: async () => ({ answers: fakeAnswers(), additional: {} }),
    });
    expect(catalog.userId).toBe("user_trim");
  });
});
