/**
 * What a complete intake is, as one schema that both sides of the form use.
 *
 * ── Why the validation is strict ────────────────────────────────────────────
 * Everything here ends up as an answer on a real employer's application form,
 * submitted under a real person's name. HARD STOP 9 in CLAUDE.md says nothing
 * downstream may invent a fact the intake does not contain, which puts the
 * whole weight of "is this answer true" on this object being complete and
 * internally consistent before it is stored. A blank that reaches the pipeline
 * becomes either a stopped run or, if anything ever guesses, a lie on somebody's
 * application. So required means required, and the contradictions that a form
 * can express but a person cannot be are rejected here rather than reconciled
 * later.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * Race, gender, veteran status and disability status. HARD STOP 10: those are
 * answered "decline to self identify" on every form, are never stored, and are
 * never asked. There is no field for them here, nothing in the UI collects
 * them, and there is no setting that turns them on.
 */

import { z } from "zod";

/**
 * Citizenship options, as an application form asks the question. The values
 * match the `citizenship_status` enum in `lib/db/schema.ts`; the labels are what
 * the form shows. Kept together so the two cannot drift.
 */
export const CITIZENSHIP_OPTIONS = [
  { value: "us_citizen", label: "US citizen" },
  { value: "permanent_resident", label: "Permanent resident" },
  { value: "f1", label: "F1 student visa" },
  { value: "h1b", label: "H1B" },
  { value: "other", label: "Other" },
] as const;

/** Only asked when citizenship is F1. Matches the `f1_status` enum. */
export const F1_STATUS_OPTIONS = [
  { value: "opt", label: "On OPT" },
  { value: "cpt", label: "On CPT" },
  { value: "none", label: "Neither yet" },
] as const;

/**
 * Security clearance eligibility, worded the way the boards that ask it word
 * it. Values match the `clearance_eligibility` enum in `lib/db/schema.ts`.
 *
 * Asked at all because a required clearance question with no way to decline is
 * one of the few things that stops a run outright, and it stopped Anduril twice
 * on a candidate who could have answered it in a second. Asked in the board's
 * own three states rather than as a yes or no, because the difference between
 * holding a clearance and being able to get one is the difference the question
 * is drawn to capture.
 */
export const CLEARANCE_ELIGIBILITY_OPTIONS = [
  { value: "active_clearance", label: "I hold an active US security clearance" },
  { value: "eligible", label: "I am eligible for a US security clearance" },
  { value: "no", label: "Neither" },
] as const;

/** The follow up question. Matches the `clearance_level` enum. */
export const CLEARANCE_LEVEL_OPTIONS = [
  { value: "never_held", label: "I have never held one" },
  { value: "confidential", label: "Confidential" },
  { value: "secret", label: "Secret" },
  { value: "top_secret", label: "Top Secret" },
] as const;

/**
 * Statuses that carry their own answer to the two work authorization questions.
 * A US citizen who says they need sponsorship has mis clicked something, and
 * storing that contradiction means generating two answers on one form that
 * cannot both be true.
 */
const INHERENTLY_AUTHORIZED = ["us_citizen", "permanent_resident"] as const;

const citizenshipStatus = z.enum(
  CITIZENSHIP_OPTIONS.map((option) => option.value)
);
const f1Status = z.enum(F1_STATUS_OPTIONS.map((option) => option.value));
const clearanceEligibility = z.enum(
  CLEARANCE_ELIGIBILITY_OPTIONS.map((option) => option.value)
);
const clearanceLevelHeld = z.enum(
  CLEARANCE_LEVEL_OPTIONS.map((option) => option.value)
);

const requiredText = (field: string, max = 120) =>
  z
    .string()
    .trim()
    .min(1, `${field} is required.`)
    .max(max, `${field} is too long.`);

/**
 * A key inside the private `resumes` bucket, which by convention is
 * `{userId}/{uuid}.pdf`. The first segment is not decoration: it is what the
 * bucket's storage policies compare against `auth.uid()`, so a path with the
 * wrong prefix is one the database would have refused to write anyway.
 */
const OBJECT_PATH_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f-]{36}\.pdf$/;

/**
 * The intake schema for one specific user.
 *
 * It takes the user id because two of the fields are storage paths, and a
 * storage path is only valid relative to whose folder it names. Baking the id
 * in means the ownership check cannot be forgotten at a call site: a payload
 * naming somebody else's object fails to parse rather than being caught by a
 * separate check that someone later removes as redundant.
 */
export function intakeSchema(userId: string) {
  const ownedObjectPath = z
    .string()
    .regex(OBJECT_PATH_PATTERN, "That file was not uploaded correctly.")
    .refine(
      (path) => path.startsWith(`${userId}/`),
      "That file belongs to a different account."
    );

  return z
    .object({
      citizenshipStatus,
      /**
       * Null unless citizenship is F1, and defaulted rather than required so
       * that a caller who is not on an F1 visa has nothing to say. When it is
       * F1, the cross field check below turns the missing value into a question
       * about OPT and CPT rather than a type error about null.
       */
      f1Status: f1Status.nullable().default(null),

      workAuthorizedUs: z.boolean(),
      requiresSponsorship: z.boolean(),
      /**
       * Issue #108, and a separate question from `requiresSponsorship` rather
       * than a rewording of it. That one is about the United States and is
       * settled for a citizen or a permanent resident; this one is about
       * everywhere else and is settled by neither. Asking them as one question
       * is what let a US answer be written onto a UK form.
       */
      needsSponsorshipNonUs: z.boolean(),
      /**
       * The candidate's own words. Required, because "what is your current visa
       * status?" is asked outright on real forms and a blank is a stopped run,
       * and free text rather than a menu because "none, I am a US citizen" and
       * "F-1, OPT expiring March 2027" are both answers and only the person can
       * give either.
       */
      visaStatus: requiredText("Visa status", 200),

      clearanceEligibility,
      clearanceLevelHeld,

      /**
       * ── JOB-134: the questions the pipeline kept having to ask ────────────
       *
       * Every one of these was a real screening question on a real board that
       * no stored answer covered, so the run stopped and the person answered it
       * on a terminal. They are here because a question answered at intake once
       * is a question the second user never sees at all.
       *
       * Whether a previous employer's contract still binds them: a non-compete,
       * a non-solicitation clause, or another restrictive covenant. Required
       * and a plain boolean, because the form's version is a plain yes or no
       * and a blank is a stopped application. A "yes" is not a dead end, it is
       * a true answer to the question every employer asks; any follow up asking
       * which agreement and on what terms is free text only the person can
       * write, so that one still reaches them.
       */
      subjectToRestrictiveCovenant: z.boolean(),
      /**
       * Read this one carefully, because it is deliberately not the question
       * the form asks. A form asks about one named employer; this asks about
       * every employer the person might apply to.
       *
       * That is what makes a "no" reusable: "none of them" entails "not this
       * one" for every company, so it truthfully answers the form's version of
       * the question. A "yes" entails nothing about any particular company, so
       * `buildFactCatalog` writes no fact for it at all and the question is
       * still put to the person, per company. The label the form shows says so
       * in as many words, because a question that quietly means something wider
       * than it appears to is a question somebody answers wrongly.
       */
      relativesAtTargetEmployers: z.boolean(),
      /** The same shape and the same asymmetry, for prior employment. */
      previouslyEmployedAtTargetEmployers: z.boolean(),
      /**
       * What they expect to be paid, in their own words.
       *
       * Free text rather than a number, and required rather than optional.
       * HARD STOP 9 names salary expectations outright as something no model
       * may compose, so the only answer this system can ever put on a form is
       * one the person wrote. "$120,000", "market rate for a new grad" and
       * "negotiable" are all real answers, and a number field would accept
       * neither of the last two.
       */
      salaryExpectation: requiredText("Salary expectation", 200),

      currentCity: requiredText("Current city"),
      currentCountry: requiredText("Current country"),
      streetAddress: requiredText("Street address", 200),
      postalCode: requiredText("Postal code", 20),
      willingToRelocate: z.boolean(),
      targetLocations: z
        .array(requiredText("Target location"))
        .min(1, "Add at least one place you want to work.")
        .max(20, "That is more target locations than a search can use."),

      gradDate: z.iso.date("Graduation date must be a real date."),
      earliestStart: z.iso.date("Earliest start date must be a real date."),

      /**
       * High school, which every one of Palantir's 128 Lever listings asks for
       * by name and nothing in a resume reliably carries.
       *
       * The year is an integer rather than a date because that is what the
       * question asks for, and it is bounded here rather than only by the CHECK
       * on the column so that a mistyped year comes back as a sentence the
       * person can act on instead of a constraint violation.
       */
      highSchoolName: requiredText("High school name"),
      highSchoolGradYear: z
        .number()
        .int("High school graduation year must be a year.")
        .min(1900, "High school graduation year must be a real year.")
        .max(2100, "High school graduation year must be a real year."),

      resumePath: ownedObjectPath,
      /**
       * Optional, in both senses: someone without a LinkedIn export still has a
       * resume, and a caller that has nothing to send may leave the key off
       * entirely rather than having to spell out a null.
       */
      linkedinPdfPath: ownedObjectPath.nullable().default(null),

      /**
       * Not decorative, and not a terms of service checkbox. Every free text
       * answer the pipeline generates is grounded in the fields above and then
       * submitted as this person's own statement, so this is the moment they
       * say the fields are true and that we may submit on their behalf. Without
       * it there is no attestation behind any application we send, which is
       * exactly the situation HARD STOP 9 exists to prevent.
       */
      attestation: z.literal(true, "You have to confirm this to continue."),
    })
    .check((ctx) => {
      const value = ctx.value;

      if (value.citizenshipStatus === "f1" && value.f1Status === null) {
        ctx.issues.push({
          code: "custom",
          input: value.f1Status,
          path: ["f1Status"],
          message: "Tell us which F1 work authorization you are on.",
        });
      }

      if (value.citizenshipStatus !== "f1" && value.f1Status !== null) {
        ctx.issues.push({
          code: "custom",
          input: value.f1Status,
          path: ["f1Status"],
          message: "OPT and CPT only apply to an F1 visa.",
        });
      }

      const inherentlyAuthorized = (
        INHERENTLY_AUTHORIZED as readonly string[]
      ).includes(value.citizenshipStatus);

      if (inherentlyAuthorized && !value.workAuthorizedUs) {
        ctx.issues.push({
          code: "custom",
          input: value.workAuthorizedUs,
          path: ["workAuthorizedUs"],
          message:
            "A US citizen or permanent resident is already authorized to work in the US.",
        });
      }

      if (inherentlyAuthorized && value.requiresSponsorship) {
        ctx.issues.push({
          code: "custom",
          input: value.requiresSponsorship,
          path: ["requiresSponsorship"],
          message:
            "A US citizen or permanent resident does not need sponsorship.",
        });
      }

      // The one clearance pair that cannot both be true. Every other
      // combination can: somebody who held Secret years ago may no longer be
      // eligible, and somebody eligible today may never have held anything,
      // which is the ordinary case. Holding an active clearance while never
      // having held one is not a story about a person, it is a mis click, and
      // storing it would put two answers on one form that contradict.
      if (
        value.clearanceEligibility === "active_clearance" &&
        value.clearanceLevelHeld === "never_held"
      ) {
        ctx.issues.push({
          code: "custom",
          input: value.clearanceLevelHeld,
          path: ["clearanceLevelHeld"],
          message:
            "You said you hold an active clearance, so tell us which level it is.",
        });
      }
    });
}

export type IntakeInput = z.infer<ReturnType<typeof intakeSchema>>;

/**
 * Field errors keyed by field name, which is the shape the form renders. Only
 * the first message per field: a control with three messages under it is worse
 * at telling someone what to do than a control with one.
 */
export function intakeFieldErrors(
  error: z.ZodError<unknown>
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !(field in errors)) {
      errors[field] = issue.message;
    }
  }
  return errors;
}
