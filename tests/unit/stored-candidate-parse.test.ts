// @vitest-environment node
/**
 * JOB-112: `resumes.parsed` written, read, invalidated, and merged with the
 * LinkedIn export.
 *
 * The fixtures are the two real documents belonging to the user whose row this
 * ticket was raised against, transcribed rather than invented, because the
 * whole finding is about what those two documents actually say:
 *
 *  · The resume prints "B.S. Computer Science, Minor in Mathematics" as one
 *    line, and a model asked for a `discipline` returns that whole line. It is
 *    not an option on any dropdown and never can be.
 *  · The LinkedIn export prints "Bachelor of Science - BS, Computer Science"
 *    and, as a separate education entry, "Minor, Mathematics". Degree and field
 *    of study are separate values there, which is exactly the fix.
 *  · The resume's most recent job is Stanford, ending "Present". LinkedIn says
 *    that role ended in February 2026 and the current one is at DoorDash. A
 *    real disagreement, and one nobody should discover by finding the wrong
 *    employer on a submitted application.
 *
 * Nothing here calls a model. `buildResumeProfile` is pure, and the storage
 * layer is exercised against a stub Supabase client, which is the level these
 * two belong at: `tests/unit/fill-application-form-flow.test.ts` owns the
 * sequence around them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { readStoredParse, writeStoredParse } from "@/lib/candidate-documents";
import { buildResumeProfile } from "@/lib/resume-parser";
import type {
  CandidateRecord,
  ExtractedLinkedin,
  ExtractedResume,
} from "@/lib/resume-parser";

/**
 * The Inngest client, stubbed at the module boundary
 * `lib/candidate-document-trigger.ts` imports it across. Importing the real one
 * would pull in the whole application pipeline, which is exactly what that
 * module's dynamic import exists to keep out of the onboarding server action.
 */
const sent: unknown[] = [];
let sendShouldThrow = false;
vi.mock("@/inngest/job-application-pipeline", () => ({
  inngest: {
    send: async (event: unknown) => {
      if (sendShouldThrow) throw new Error("inngest is down");
      sent.push(event);
    },
  },
}));
vi.mock("@/inngest/parse-candidate-documents", () => ({
  INTAKE_COMPLETED: "intake/completed",
}));

const RESUME_ID = "a1057d9b-673c-495d-bb66-e0dc78f0bde8";
const RESUME_PATH = "resumes/1e1dfc47/6ef32cb3.pdf";
const LINKEDIN_PATH = "resumes/1e1dfc47/4fb356b8.pdf";

const CANDIDATE: CandidateRecord = {
  id: "1e1dfc47-6230-4cae-b767-176a35f8282d",
  applicationEmail: "verified@example.edu",
  linkedinUrl: null,
  githubUrl: null,
};

/** What the resume extraction returns for the real resume. */
const RESUME_EXTRACT: ExtractedResume = {
  // A resume header set in capitals, which is ordinary and is what was going
  // into employers' First Name boxes.
  firstName: "PRANAV",
  lastName: "LENDE",
  email: "someone@university.edu",
  phone: "404-444-6018",
  location: "Atlanta, GA",
  linkedinUrl: "linkedin.com/in/example",
  websiteUrl: null,
  workHistory: [
    {
      company: "Stanford University",
      title: "AI Engineer",
      startDate: "November 2025",
      endDate: "Present",
      summary: "Built an RL ops dashboard.",
    },
  ],
  education: [
    {
      school: "Georgia Institute of Technology",
      degree: "B.S.",
      // The bug, verbatim: one field of study field, two things in it.
      discipline: "Computer Science, Minor in Mathematics",
      endDate: null,
    },
  ],
  skills: ["Python", "TypeScript"],
};

/** What the LinkedIn extraction returns for the real export. */
const LINKEDIN_EXTRACT: ExtractedLinkedin = {
  firstName: "Pranav",
  lastName: "Lende",
  location: "San Francisco, California, United States",
  profileUrl: "www.linkedin.com/in/example",
  websiteUrl: null,
  email: "someone-else@example.com",
  phone: null,
  workHistory: [
    {
      company: "DoorDash",
      title: "Software Engineer",
      startDate: "March 2026",
      endDate: "Present",
      summary: null,
    },
    {
      company: "Stanford University",
      title: "LLM Researcher",
      startDate: "November 2025",
      endDate: "February 2026",
      summary: "Designed an end to end agent pipeline.",
    },
  ],
  education: [
    {
      school: "Georgia Institute of Technology",
      degree: "Bachelor of Science - BS",
      fieldOfStudy: "Computer Science",
      endDate: null,
    },
    {
      school: "Georgia Institute of Technology",
      degree: "Minor",
      fieldOfStudy: "Mathematics",
      endDate: null,
    },
  ],
  skills: ["Framer Motion", "Python"],
};

describe("buildResumeProfile, merging the two documents", () => {
  it("splits the degree from the field of study, which one line of resume prose cannot", () => {
    const resumeOnly = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, null);
    // The state this ticket was raised about: not an option on any dropdown.
    expect(resumeOnly.education[0].discipline).toBe("Computer Science, Minor in Mathematics");

    const merged = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, LINKEDIN_EXTRACT);
    expect(merged.education[0].degree).toBe("Bachelor of Science - BS");
    expect(merged.education[0].discipline).toBe("Computer Science");
    // And the minor is its own entry rather than folded into the major.
    expect(merged.education[1].discipline).toBe("Mathematics");
  });

  it("marks every fact with the document it came from", () => {
    const merged = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, LINKEDIN_EXTRACT);
    expect(merged.education.map((entry) => entry.source)).toEqual(["linkedin", "linkedin"]);
    expect(merged.workHistory.map((entry) => entry.source)).toEqual(["linkedin", "linkedin"]);
    expect(merged.provenance?.location).toBe("linkedin");

    const resumeOnly = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, null);
    expect(resumeOnly.education[0].source).toBe("resume");
    expect(resumeOnly.workHistory[0].source).toBe("resume");
    expect(resumeOnly.provenance?.location).toBeUndefined();
  });

  it("records a disagreement rather than discarding the losing value", () => {
    const merged = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, LINKEDIN_EXTRACT);
    const joined = merged.warnings.join(" | ");
    // The resume says the Stanford role is current; LinkedIn says it ended.
    expect(joined).toContain(
      'Stanford University: the resume says the end date "Present" and the LinkedIn export ' +
        'says "February 2026"'
    );
    // And the field of study, which is the failure this ticket was raised over.
    expect(joined).toContain(
      'the resume says the field of study "Computer Science, Minor in Mathematics" and the ' +
        'LinkedIn export says "Computer Science"'
    );
  });

  it("takes LinkedIn's capitalisation of the name without calling it a disagreement", () => {
    const resumeOnly = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, null);
    expect(resumeOnly.firstName).toBe("PRANAV");

    const merged = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, LINKEDIN_EXTRACT);
    expect(merged.firstName).toBe("Pranav");
    expect(merged.lastName).toBe("Lende");
    expect(merged.warnings.join(" | ")).not.toMatch(/firstName|lastName/);
  });

  it("does not report two spellings of one URL as a disagreement", () => {
    // A resume prints `linkedin.com/in/name` and the export prints
    // `www.linkedin.com/in/name`. Reporting that on every application would
    // bury the disagreements that are real.
    const merged = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, LINKEDIN_EXTRACT);
    expect(merged.warnings.join(" | ")).not.toMatch(/linkedinUrl/);
    expect(merged.linkedinUrl).toBe("https://www.linkedin.com/in/example");
  });

  it("takes LinkedIn's current employer, because a resume goes stale and a profile does not", () => {
    const merged = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, LINKEDIN_EXTRACT);
    expect(merged.workHistory[0].company).toBe("DoorDash");
  });

  it("never lets either document decide the email", () => {
    const merged = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, LINKEDIN_EXTRACT);
    // Both PDFs state a different address and neither wins. `profiles.email` is
    // the address Supabase Auth verified and the one an employer replies to.
    expect(merged.email).toBe("verified@example.edu");
    expect(merged.resumeStatedEmail).toBe("someone@university.edu");
  });

  it("unions the skills rather than preferring one document's list", () => {
    const merged = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, LINKEDIN_EXTRACT);
    expect(merged.skills).toEqual(["Python", "TypeScript", "Framer Motion"]);
  });

  it("falls back to the resume for anything LinkedIn is silent about", () => {
    const merged = buildResumeProfile(RESUME_EXTRACT, CANDIDATE, LINKEDIN_EXTRACT);
    // LinkedIn's contact block carries no phone number for this member.
    expect(merged.phone).toBe("404-444-6018");
  });
});

// ───────────────────────────────────
// The stored column
// ───────────────────────────────────

type StubRow = { parsed: unknown } | undefined;

let storedRow: StubRow;
let selectError: { message: string } | null;
let updates: unknown[];

function stubClient(): SupabaseClient {
  return {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        update: (values: unknown) => {
          updates.push(values);
          return chain;
        },
        limit: async () => ({
          data: storedRow === undefined ? [] : [storedRow],
          error: selectError,
        }),
        then: (resolve: (value: { error: null }) => unknown) =>
          Promise.resolve(resolve({ error: null })),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const PATHS = {
  resumeId: RESUME_ID,
  resumePath: RESUME_PATH,
  linkedinPdfPath: LINKEDIN_PATH,
};

const STORED = {
  version: 1 as const,
  parsedAt: "2026-08-22T12:00:00.000Z",
  resume: { storagePath: RESUME_PATH, extracted: RESUME_EXTRACT },
  linkedin: { storagePath: LINKEDIN_PATH, extracted: LINKEDIN_EXTRACT },
};

describe("resumes.parsed", () => {
  beforeEach(() => {
    storedRow = undefined;
    selectError = null;
    updates = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("reads back what it wrote", async () => {
    await writeStoredParse(stubClient(), RESUME_ID, STORED);
    expect(updates).toEqual([{ parsed: STORED }]);

    storedRow = { parsed: STORED };
    const read = await readStoredParse(stubClient(), PATHS);
    expect(read?.parsedAt).toBe("2026-08-22T12:00:00.000Z");
    expect(read?.linkedin?.storagePath).toBe(LINKEDIN_PATH);
  });

  it("treats a NULL column as nothing to read, which is every row before this ticket", async () => {
    storedRow = { parsed: null };
    expect(await readStoredParse(stubClient(), PATHS)).toBeNull();
  });

  it("discards a parse derived from a document the row no longer points at", async () => {
    // The invalidation that does not depend on nobody ever updating a path in
    // place. A stale parse is worse than none: it is confidently wrong rather
    // than obviously missing.
    storedRow = { parsed: { ...STORED, resume: { ...STORED.resume, storagePath: "old.pdf" } } };
    expect(await readStoredParse(stubClient(), PATHS)).toBeNull();
  });

  it("discards a parse from before a LinkedIn export was uploaded", async () => {
    storedRow = { parsed: { ...STORED, linkedin: null } };
    expect(await readStoredParse(stubClient(), PATHS)).toBeNull();
  });

  it("discards a shape this version does not understand rather than guessing", async () => {
    storedRow = { parsed: { version: 99, whatever: true } };
    expect(await readStoredParse(stubClient(), PATHS)).toBeNull();

    storedRow = { parsed: { ...STORED, resume: { storagePath: RESUME_PATH, extracted: {} } } };
    expect(await readStoredParse(stubClient(), PATHS)).toBeNull();
  });

  it("does not fail an application over a cache read", async () => {
    selectError = { message: "connection reset" };
    expect(await readStoredParse(stubClient(), PATHS)).toBeNull();
  });
});

// ───────────────────────────────────
// The trigger onboarding fires
// ───────────────────────────────────

describe("requestDocumentParse", () => {
  beforeEach(() => {
    sent.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("sends intake/completed keyed to the row onboarding just wrote", async () => {
    const { requestDocumentParse } = await import("@/lib/candidate-document-trigger");
    await requestDocumentParse(CANDIDATE.id, RESUME_ID);
    expect(sent).toEqual([
      { name: "intake/completed", data: { userId: CANDIDATE.id, resumeId: RESUME_ID } },
    ]);
  });

  it("refuses an id that is not a UUID rather than queueing a run that cannot work", async () => {
    const { requestDocumentParse } = await import("@/lib/candidate-document-trigger");
    await requestDocumentParse(CANDIDATE.id, "not-a-uuid");
    expect(sent).toEqual([]);
  });

  it("never fails the submit it was called from", async () => {
    // Onboarding is finished by the time this runs: the profile is written, the
    // resume row exists and the attestation is stamped. A dead Inngest must not
    // turn that into an error message about something the person cannot act on.
    sendShouldThrow = true;
    const { requestDocumentParse } = await import("@/lib/candidate-document-trigger");
    await expect(requestDocumentParse(CANDIDATE.id, RESUME_ID)).resolves.toBeUndefined();
    sendShouldThrow = false;
  });
});
