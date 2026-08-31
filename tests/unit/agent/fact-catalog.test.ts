/**
 * JOB-316. The agent side fact catalog: the pure mapping from an intake
 * snapshot to fact entries, the deterministic serialization the prompt cache
 * depends on, and the wet builder's injection seam.
 *
 * The key spellings asserted here are the widget path's
 * (`lib/fill-application-form.ts` `buildFactCatalog`), which the ticket names
 * as the source of truth. If one of these assertions has to change, the two
 * catalogs have drifted and that drift is the bug.
 */

import { describe, expect, it } from "vitest";

import {
  buildFactCatalog,
  factEntriesFrom,
  resolveFactPath,
  serializeFactCatalog,
  type FactCatalog,
} from "@/lib/agent/fact-catalog";
import { buildAnthropicMessagesWithCaching } from "@/lib/agent/router";
import type { CandidateRecord } from "@/lib/candidate-intake";
import type { ResumeProfile } from "@/lib/resume-parser";

function candidateFixture(
  overrides: Partial<CandidateRecord> = {}
): CandidateRecord {
  return {
    userId: "11111111-2222-3333-4444-555555555555",
    applicationEmail: "casey@example.com",
    linkedinUrl: null,
    githubUrl: "https://github.com/casey",
    resumeId: "resume-1",
    resumeUrl: "resumes/casey.pdf",
    linkedinPdfPath: null,
    locations: ["San Francisco"],
    applicationAnswers: {
      workAuthorizedUs: true,
      requiresSponsorship: false,
      currentCountry: "United States",
      currentCity: "San Francisco",
      visaStatus: "F-1 on OPT",
      salaryExpectation: "120k",
      targetLocations: ["San Francisco", "Seattle"],
    },
    storedAnswers: [
      {
        topic: null,
        question: "how did you hear about us?",
        answer: "A friend told me",
        answeredAt: "2026-08-30T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function profileFixture(
  overrides: Partial<ResumeProfile> = {}
): ResumeProfile {
  return {
    firstName: "Casey",
    lastName: "Nguyen",
    email: "casey@example.com",
    phone: "415 555 0100",
    location: "San Francisco, CA",
    linkedinUrl: "https://www.linkedin.com/in/casey",
    websiteUrl: "https://casey.dev",
    githubUrl: null,
    workHistory: [
      {
        company: "Acme Corp",
        title: "Software Engineer Intern",
        startDate: "Jun 2025",
        endDate: "Sep 2025",
        summary: "Built internal tools",
      },
      {
        company: "Widget Labs",
        title: "Research Assistant",
        startDate: "Jan 2024",
        endDate: "May 2024",
        summary: null,
      },
    ],
    education: [
      {
        school: "UC Berkeley",
        degree: "BS",
        discipline: "Computer Science",
        endDate: "May 2026",
      },
    ],
    skills: ["TypeScript", "Python"],
    resumeStatedEmail: null,
    warnings: [],
    ...overrides,
  };
}

function pathsOf(catalog: { entries: Array<{ path: string }> }): string[] {
  return catalog.entries.map((entry) => entry.path);
}

describe("factEntriesFrom", () => {
  it("carries the ten authoritative keys for a full snapshot", () => {
    const entries = factEntriesFrom(candidateFixture(), profileFixture());
    const catalog: FactCatalog = { userId: "u", entries };

    expect(resolveFactPath(catalog, "fullName")?.value).toBe("Casey Nguyen");
    expect(resolveFactPath(catalog, "email")?.value).toBe("casey@example.com");
    expect(resolveFactPath(catalog, "phone")?.value).toBe("415 555 0100");
    expect(resolveFactPath(catalog, "linkedinUrl")?.value).toBe(
      "https://www.linkedin.com/in/casey"
    );
    expect(resolveFactPath(catalog, "githubUrl")?.value).toBe(
      "https://github.com/casey"
    );
    expect(resolveFactPath(catalog, "workAuthorizedUs")?.value).toBe("Yes");
    expect(resolveFactPath(catalog, "requiresSponsorship")?.value).toBe("No");
    expect(resolveFactPath(catalog, "currentCity")?.value).toBe(
      "San Francisco"
    );
    expect(resolveFactPath(catalog, "visaStatus")?.value).toBe("F-1 on OPT");
    expect(resolveFactPath(catalog, "salaryExpectation")?.value).toBe("120k");
  });

  it("attributes sources: profile columns, resume facts, stored answers", () => {
    const entries = factEntriesFrom(candidateFixture(), profileFixture());
    const catalog: FactCatalog = { userId: "u", entries };

    expect(resolveFactPath(catalog, "email")?.source).toBe("profile");
    expect(resolveFactPath(catalog, "githubUrl")?.source).toBe("profile");
    expect(resolveFactPath(catalog, "fullName")?.source).toBe("resume");
    expect(resolveFactPath(catalog, "work0.employer")?.source).toBe("resume");
    expect(
      resolveFactPath(catalog, "answer:how did you hear about us?")?.source
    ).toBe("candidate_answer");
  });

  it("emits indexed work and education paths plus the legacy aliases", () => {
    const entries = factEntriesFrom(candidateFixture(), profileFixture());
    const catalog: FactCatalog = { userId: "u", entries };

    expect(resolveFactPath(catalog, "work0.employer")?.value).toBe("Acme Corp");
    expect(resolveFactPath(catalog, "work1.employer")?.value).toBe(
      "Widget Labs"
    );
    expect(resolveFactPath(catalog, "work0.startDate")?.value).toBe("Jun 2025");
    expect(resolveFactPath(catalog, "education0.school")?.value).toBe(
      "UC Berkeley"
    );
    expect(resolveFactPath(catalog, "education0.discipline")?.value).toBe(
      "Computer Science"
    );
    // The historical spellings every previous run's cache names.
    expect(resolveFactPath(catalog, "school")?.value).toBe("UC Berkeley");
    expect(resolveFactPath(catalog, "degree")?.value).toBe("BS");
    expect(resolveFactPath(catalog, "discipline")?.value).toBe(
      "Computer Science"
    );
    expect(resolveFactPath(catalog, "mostRecentEmployer")?.value).toBe(
      "Acme Corp"
    );
    expect(resolveFactPath(catalog, "mostRecentTitle")?.value).toBe(
      "Software Engineer Intern"
    );
    expect(resolveFactPath(catalog, "skills")?.value).toBe(
      "TypeScript, Python"
    );
  });

  it("returns the correct partial shape when no resume parse exists", () => {
    const entries = factEntriesFrom(candidateFixture(), null);
    const catalog: FactCatalog = { userId: "u", entries };
    const paths = pathsOf(catalog);

    // Profile column facts survive.
    expect(resolveFactPath(catalog, "email")?.value).toBe("casey@example.com");
    expect(resolveFactPath(catalog, "githubUrl")?.value).toBe(
      "https://github.com/casey"
    );
    expect(resolveFactPath(catalog, "currentCity")?.value).toBe(
      "San Francisco"
    );
    // Resume derived facts are absent, not placeholders.
    expect(paths).not.toContain("fullName");
    expect(paths).not.toContain("phone");
    expect(paths).not.toContain("work0.employer");
    expect(paths).not.toContain("education0.school");
    // Stored answers survive.
    expect(paths).toContain("answer:how did you hear about us?");
  });

  it("omits unanswered facts instead of writing placeholders", () => {
    const candidate = candidateFixture({
      applicationAnswers: { currentCity: "Austin" },
      storedAnswers: [],
      githubUrl: null,
    });
    const entries = factEntriesFrom(candidate, null);
    const paths = pathsOf({ entries });

    expect(paths).not.toContain("salaryExpectation");
    expect(paths).not.toContain("workAuthorizedUs");
    expect(paths).not.toContain("visaStatus");
    expect(paths).not.toContain("githubUrl");
    expect(paths).toContain("currentCity");
  });

  it("falls back to a GitHub URL found on the parse, host anchored", () => {
    const candidate = candidateFixture({ githubUrl: null });
    const withGithubSite = factEntriesFrom(
      candidate,
      profileFixture({ websiteUrl: "https://casey.github.io/portfolio" })
    );
    expect(
      resolveFactPath({ userId: "u", entries: withGithubSite }, "githubUrl")
        ?.value
    ).toBe("https://casey.github.io/portfolio");

    const withImpostor = factEntriesFrom(
      candidate,
      profileFixture({
        websiteUrl: "https://evil.example/github.com/casey",
        linkedinUrl: null,
      })
    );
    expect(
      pathsOf({ entries: withImpostor })
    ).not.toContain("githubUrl");
  });

  it("resolves a repeated stored answer question to the newest answer", () => {
    const candidate = candidateFixture({
      storedAnswers: [
        {
          topic: null,
          question: "notice period?",
          answer: "two weeks",
          answeredAt: "2026-08-30T00:00:00.000Z",
        },
        {
          topic: null,
          question: "notice period?",
          answer: "one month",
          answeredAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const catalog: FactCatalog = {
      userId: "u",
      entries: factEntriesFrom(candidate, null),
    };
    // `storedAnswers` is newest first and `resolveFactPath` returns the
    // first match, so the newest answer wins.
    expect(resolveFactPath(catalog, "answer:notice period?")?.value).toBe(
      "two weeks"
    );
  });
});

describe("serializeFactCatalog", () => {
  it("is deterministic for the same catalog", () => {
    const catalog: FactCatalog = {
      userId: "u1",
      entries: factEntriesFrom(candidateFixture(), profileFixture()),
    };
    expect(serializeFactCatalog(catalog)).toBe(serializeFactCatalog(catalog));
    const again: FactCatalog = {
      userId: "u1",
      entries: factEntriesFrom(candidateFixture(), profileFixture()),
    };
    expect(serializeFactCatalog(again)).toBe(serializeFactCatalog(catalog));
  });

  it("names every path so the model can quote intakeFactPath verbatim", () => {
    const catalog: FactCatalog = {
      userId: "u1",
      entries: factEntriesFrom(candidateFixture(), profileFixture()),
    };
    const serialized = serializeFactCatalog(catalog);
    for (const entry of catalog.entries) {
      expect(serialized).toContain(entry.path);
    }
  });

  it("is what buildAnthropicMessagesWithCaching caches as the second system block", () => {
    const catalog: FactCatalog = {
      userId: "u1",
      entries: factEntriesFrom(candidateFixture(), profileFixture()),
    };
    const serialized = serializeFactCatalog(catalog);
    const messages = buildAnthropicMessagesWithCaching(
      "system prompt",
      serialized,
      []
    );
    expect(messages.system[1].text).toBe(serialized);
    expect(messages.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(messages.system[1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("buildFactCatalog", () => {
  it("hydrates through the injected loader and keeps the verified userId", async () => {
    const candidate = candidateFixture();
    const catalog = await buildFactCatalog("anything", {
      loadIntake: async (userId) => {
        expect(userId).toBe("anything");
        return { candidate, profile: profileFixture() };
      },
    });
    expect(catalog.userId).toBe(candidate.userId);
    expect(resolveFactPath(catalog, "fullName")?.value).toBe("Casey Nguyen");
  });

  it("returns the partial catalog when the loader has no parse", async () => {
    const catalog = await buildFactCatalog("u", {
      loadIntake: async () => ({ candidate: candidateFixture(), profile: null }),
    });
    expect(pathsOf(catalog)).not.toContain("fullName");
    expect(resolveFactPath(catalog, "email")?.value).toBe("casey@example.com");
  });
});
