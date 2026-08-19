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

      currentCity: requiredText("Current city"),
      currentCountry: requiredText("Current country"),
      willingToRelocate: z.boolean(),
      targetLocations: z
        .array(requiredText("Target location"))
        .min(1, "Add at least one place you want to work.")
        .max(20, "That is more target locations than a search can use."),

      gradDate: z.iso.date("Graduation date must be a real date."),
      earliestStart: z.iso.date("Earliest start date must be a real date."),

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
