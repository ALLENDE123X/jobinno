/**
 * JOB-365. Maps each `VisualSlug` to the component that renders it. The one
 * place `[slug]/page.tsx` looks up, so adding a 16th page later is one import
 * and one map entry rather than a new branch in the route file itself.
 */
import type { ComponentType } from "react";

import type { VisualSlug } from "@/lib/internal-visuals-slugs";

import { ApplicationsTableRunning } from "../_pages/applications-table-running";
import { CompanyLogoTargetGrid } from "../_pages/company-logo-target-grid";
import { DashboardCounterClimbing } from "../_pages/dashboard-counter-climbing";
import { GraduationCountdown } from "../_pages/graduation-countdown";
import { GridMascotWorking } from "../_pages/grid-mascot-working";
import { HourlyThroughputChart } from "../_pages/hourly-throughput-chart";
import { IntakeFormShort } from "../_pages/intake-form-short";
import { ManualVsJobinnoSplit } from "../_pages/manual-vs-jobinno-split";
import { MoneyTimeSavedCounter } from "../_pages/money-time-saved-counter";
import { OfferEmailInbox } from "../_pages/offer-email-inbox";
import { OvernightTimeline } from "../_pages/overnight-timeline";
import { RecruiterLinkedinDm } from "../_pages/recruiter-linkedin-dm";
import { RejectionGraveyard } from "../_pages/rejection-graveyard";
import { ResumeParsedFields } from "../_pages/resume-parsed-fields";
import { SubmittedBadgeView } from "../_pages/submitted-badge-view";

export const VISUAL_PAGES: Record<VisualSlug, ComponentType> = {
  "dashboard-counter-climbing": DashboardCounterClimbing,
  "applications-table-running": ApplicationsTableRunning,
  "overnight-timeline": OvernightTimeline,
  "offer-email-inbox": OfferEmailInbox,
  "recruiter-linkedin-dm": RecruiterLinkedinDm,
  "manual-vs-jobinno-split": ManualVsJobinnoSplit,
  "rejection-graveyard": RejectionGraveyard,
  "grid-mascot-working": GridMascotWorking,
  "money-time-saved-counter": MoneyTimeSavedCounter,
  "intake-form-short": IntakeFormShort,
  "company-logo-target-grid": CompanyLogoTargetGrid,
  "resume-parsed-fields": ResumeParsedFields,
  "submitted-badge-view": SubmittedBadgeView,
  "hourly-throughput-chart": HourlyThroughputChart,
  "graduation-countdown": GraduationCountdown,
};
