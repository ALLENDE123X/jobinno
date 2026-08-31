/**
 * Pure derivation functions for conditional onboarding fields.
 *
 * These run both client-side (for instant UI show/hide) and server-side
 * (before persisting a draft), so they must be side-effect-free and depend
 * only on the values passed in. The source of truth for what gets saved is
 * the server path; the client call is a convenience for immediate feedback.
 */

const INHERENTLY_AUTHORIZED = ["us_citizen", "permanent_resident"] as const;

/**
 * workAuthorizedUs is auto-derived for US citizens and permanent residents:
 * they are inherently authorized, so the explicit Yes/No field is hidden
 * and the value is forced true. For every other citizenship the explicit
 * answer from the form is used as-is.
 */
export function deriveWorkAuthorizedUs(
  citizenship: string,
  explicitAnswer: boolean | null,
): boolean {
  if (
    (INHERENTLY_AUTHORIZED as readonly string[]).includes(citizenship)
  ) {
    return true;
  }
  return explicitAnswer === true;
}

/**
 * requiresSponsorship is the mirror: forced false for US citizens and
 * permanent residents, explicit answer otherwise.
 */
export function deriveRequiresSponsorship(
  citizenship: string,
  explicitAnswer: boolean | null,
): boolean {
  if (
    (INHERENTLY_AUTHORIZED as readonly string[]).includes(citizenship)
  ) {
    return false;
  }
  return explicitAnswer === true;
}

/**
 * needsSponsorshipNonUs is only relevant when the person is targeting at
 * least one non-US location or is willing to relocate. When relevant, the
 * explicit answer is used. When irrelevant, the value is forced false.
 */
export function deriveNeedsSponsorshipNonUs(
  targetLocations: string[],
  willingToRelocate: boolean,
  explicitAnswer: boolean | null,
): boolean {
  if (needsSponsorshipNonUsIsRelevant(targetLocations, willingToRelocate)) {
    return explicitAnswer === true;
  }
  return false;
}

/**
 * powers the UI show/hide for the needsSponsorshipNonUs question on step 3.
 */
export function needsSponsorshipNonUsIsRelevant(
  targetLocations: string[],
  willingToRelocate: boolean,
): boolean {
  if (willingToRelocate) return true;
  return targetLocationsIncludeNonUs(targetLocations);
}

/**
 * Heuristic: true iff any target location does NOT look like a US location
 * and is not empty or just "Remote".
 *
 * This is a heuristic and not a source of truth. The final confirmation of
 * whether sponsorship is needed outside the US is what the user selects on
 * step 3 after the question is shown. This function decides only whether
 * the question should be shown at all.
 */
export function targetLocationsIncludeNonUs(locations: string[]): boolean {
  const US_PATTERN = /\b(US|USA|United States|U\.S\.|America)\b/i;
  for (const loc of locations) {
    const trimmed = loc.trim();
    if (trimmed === "") continue;
    if (trimmed.toLowerCase() === "remote") continue;
    if (!US_PATTERN.test(trimmed)) return true;
  }
  return false;
}

/**
 * clearanceLevelHeld is only relevant when the person has some form of
 * clearance eligibility. When irrelevant, it is auto-derived to "never_held".
 */
export function clearanceLevelIsRelevant(clearanceEligibility: string): boolean {
  return clearanceEligibility !== "no";
}

/**
 * Prefills the visa status text field from citizenship and F1 status,
 * giving the user a sensible default they can accept or overwrite.
 */
export function prefillVisaStatus(
  citizenship: string,
  f1Status: string | null | undefined,
): string {
  switch (citizenship) {
    case "us_citizen":
      return "None, US citizen";
    case "permanent_resident":
      return "Permanent resident";
    case "f1": {
      if (f1Status === "opt") return "F-1 on OPT";
      if (f1Status === "cpt") return "F-1 on CPT";
      return "F-1";
    }
    case "h1b":
      return "H1B";
    default:
      return "";
  }
}
