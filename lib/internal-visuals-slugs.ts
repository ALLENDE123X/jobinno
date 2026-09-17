/**
 * The 15 slugs JOB-365 ships under `app/internal/visuals/[slug]/page.tsx`,
 * one file plain enough for both sides that read it to import without pulling
 * in anything server only:
 *
 *   - `app/internal/visuals/_lib/registry.tsx` maps each slug to the page
 *     component that renders it.
 *   - `scripts/capture-visuals.ts` walks this same list to know which routes
 *     to screenshot, so the route list and the capture list can never drift
 *     apart into two competing sources of truth.
 *
 * The slugs and their order are copied verbatim from the ticket body. Do not
 * rename or reorder without updating both readers above.
 */
export const VISUAL_SLUGS = [
  "dashboard-counter-climbing",
  "applications-table-running",
  "overnight-timeline",
  "offer-email-inbox",
  "recruiter-linkedin-dm",
  "manual-vs-jobinno-split",
  "rejection-graveyard",
  "grid-mascot-working",
  "money-time-saved-counter",
  "intake-form-short",
  "company-logo-target-grid",
  "resume-parsed-fields",
  "submitted-badge-view",
  "hourly-throughput-chart",
  "graduation-countdown",
] as const;

export type VisualSlug = (typeof VISUAL_SLUGS)[number];

export function isVisualSlug(value: string): value is VisualSlug {
  return (VISUAL_SLUGS as readonly string[]).includes(value);
}
