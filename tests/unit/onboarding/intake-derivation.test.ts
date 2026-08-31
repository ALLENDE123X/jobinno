import { describe, expect, it } from "vitest";

import {
  clearanceLevelIsRelevant,
  deriveNeedsSponsorshipNonUs,
  deriveRequiresSponsorship,
  deriveWorkAuthorizedUs,
  needsSponsorshipNonUsIsRelevant,
  prefillVisaStatus,
  targetLocationsIncludeNonUs,
} from "@/lib/onboarding/intake-derivation";

describe("deriveWorkAuthorizedUs", () => {
  it("forces true for a US citizen regardless of the explicit answer", () => {
    expect(deriveWorkAuthorizedUs("us_citizen", true)).toBe(true);
    expect(deriveWorkAuthorizedUs("us_citizen", false)).toBe(true);
    expect(deriveWorkAuthorizedUs("us_citizen", null)).toBe(true);
  });

  it("forces true for a permanent resident regardless of the explicit answer", () => {
    expect(deriveWorkAuthorizedUs("permanent_resident", false)).toBe(true);
  });

  it("uses the explicit answer for other citizenships", () => {
    expect(deriveWorkAuthorizedUs("f1", true)).toBe(true);
    expect(deriveWorkAuthorizedUs("f1", false)).toBe(false);
    expect(deriveWorkAuthorizedUs("f1", null)).toBe(false);
    expect(deriveWorkAuthorizedUs("h1b", true)).toBe(true);
  });
});

describe("deriveRequiresSponsorship", () => {
  it("forces false for a US citizen regardless of the explicit answer", () => {
    expect(deriveRequiresSponsorship("us_citizen", true)).toBe(false);
    expect(deriveRequiresSponsorship("us_citizen", null)).toBe(false);
  });

  it("forces false for a permanent resident", () => {
    expect(deriveRequiresSponsorship("permanent_resident", true)).toBe(false);
  });

  it("uses the explicit answer for other citizenships", () => {
    expect(deriveRequiresSponsorship("f1", true)).toBe(true);
    expect(deriveRequiresSponsorship("f1", false)).toBe(false);
  });
});

describe("targetLocationsIncludeNonUs", () => {
  it("is false when all locations look US based", () => {
    expect(
      targetLocationsIncludeNonUs(["San Francisco, US", "New York, United States"]),
    ).toBe(false);
  });

  it("is false for Remote and empty entries", () => {
    expect(targetLocationsIncludeNonUs(["Remote"])).toBe(false);
    expect(targetLocationsIncludeNonUs(["", "  "])).toBe(false);
  });

  it("is true when any location does not read as US", () => {
    expect(targetLocationsIncludeNonUs(["Toronto, Canada"])).toBe(true);
    expect(targetLocationsIncludeNonUs(["London, UK", "New York, US"])).toBe(
      true,
    );
  });

  it("recognizes US spelled a few ways as US", () => {
    expect(targetLocationsIncludeNonUs(["United States", "USA"])).toBe(false);
    expect(targetLocationsIncludeNonUs(["US"])).toBe(false);
    expect(targetLocationsIncludeNonUs(["America"])).toBe(false);
  });
});

describe("needsSponsorshipNonUsIsRelevant", () => {
  it("is relevant when willing to relocate", () => {
    expect(needsSponsorshipNonUsIsRelevant([], true)).toBe(true);
    expect(needsSponsorshipNonUsIsRelevant(["New York, US"], true)).toBe(true);
  });

  it("is relevant when targeting at least one non US location", () => {
    expect(
      needsSponsorshipNonUsIsRelevant(["Remote", "Toronto, Canada"], false),
    ).toBe(true);
  });

  it("is not relevant when staying US only and not relocating", () => {
    expect(
      needsSponsorshipNonUsIsRelevant(["New York, US"], false),
    ).toBe(false);
  });
});

describe("deriveNeedsSponsorshipNonUs", () => {
  it("uses the explicit answer when relevant", () => {
    expect(deriveNeedsSponsorshipNonUs([], true, true)).toBe(true);
    expect(deriveNeedsSponsorshipNonUs([], true, false)).toBe(false);
  });

  it("forces false when not relevant", () => {
    expect(deriveNeedsSponsorshipNonUs(["New York, US"], false, true)).toBe(
      false,
    );
  });
});

describe("clearanceLevelIsRelevant", () => {
  it("is true for any eligibility other than no", () => {
    expect(clearanceLevelIsRelevant("active_clearance")).toBe(true);
    expect(clearanceLevelIsRelevant("eligible")).toBe(true);
  });

  it("is false when the person has no clearance", () => {
    expect(clearanceLevelIsRelevant("no")).toBe(false);
  });
});

describe("prefillVisaStatus", () => {
  it("maps a US citizen to no visa", () => {
    expect(prefillVisaStatus("us_citizen", null)).toBe("None, US citizen");
  });

  it("maps a permanent resident", () => {
    expect(prefillVisaStatus("permanent_resident", null)).toBe(
      "Permanent resident",
    );
  });

  it("maps F1 according to its status", () => {
    expect(prefillVisaStatus("f1", "opt")).toBe("F-1 on OPT");
    expect(prefillVisaStatus("f1", "cpt")).toBe("F-1 on CPT");
    expect(prefillVisaStatus("f1", "none")).toBe("F-1");
    expect(prefillVisaStatus("f1", null)).toBe("F-1");
  });

  it("maps H1B", () => {
    expect(prefillVisaStatus("h1b", null)).toBe("H1B");
  });

  it("returns empty for other", () => {
    expect(prefillVisaStatus("other", null)).toBe("");
  });
});
