/**
 * JOB-365. Hardcoded data shared across several of the 15 mock pages, so a
 * realistic company list, a realistic role list, and the real
 * `applications.status` vocabulary each live in one place instead of being
 * retyped per page.
 *
 * Every value here is fabricated for the screenshot. Nothing reads the real
 * database (the ticket says so explicitly), and every company named below
 * is a real ATS-hosted employer, matching the ticket's "realistic data over
 * cute data" instruction: Ramp, Anthropic, Vercel, Stripe, Notion, Linear
 * and the rest are named because they are the kind of company Jobinno's own
 * board list already targets, not because any of them is a real customer or
 * a real applicant outcome.
 */

import { APPLICATION_STATUS, type ApplicationStatus } from "@/lib/application-status";

/** Real ATS-hosted employers, reused by the table, the logo grid, and the
 * rejection wall so the same 40 or so names read as one consistent world
 * across pages instead of each page inventing its own list. */
export const REAL_COMPANIES = [
  "Ramp", "Anthropic", "Vercel", "Stripe", "Notion", "Linear", "Rippling",
  "Brex", "Scale AI", "Figma", "Airtable", "Plaid", "Retool", "Deel",
  "Gusto", "Mercury", "Watershed", "Cohere", "Perplexity", "Airbnb",
  "Robinhood", "Coinbase", "DoorDash", "Instacart", "Affirm", "Asana",
  "Dropbox", "Segment", "Twilio", "Okta", "Datadog", "Snowflake",
  "HashiCorp", "Elastic", "MongoDB", "Confluent", "PagerDuty", "Zapier",
  "Webflow", "Canva", "Discord", "Reddit", "Pinterest", "Squarespace",
  "Shopify", "Block", "Samsara", "Benchling", "Modern Treasury", "Ashby",
] as const;

/** Roles a CS intern or new grad would realistically apply to, cycled
 * alongside `REAL_COMPANIES` for the table and timeline pages. */
export const REAL_TITLES = [
  "Software Engineer, New Grad",
  "Software Engineer Intern",
  "Backend Engineer, New Grad",
  "Frontend Engineer Intern",
  "Platform Engineer, New Grad",
  "Full Stack Engineer Intern",
  "Infrastructure Engineer, New Grad",
  "Data Engineer Intern",
] as const;

/** The subset of `APPLICATION_STATUS` these mock pages actually display.
 * Pulled from `lib/application-status.ts` rather than invented again here,
 * matching the CLAUDE.md rule against a second competing status enum. */
export const DISPLAY_STATUSES: readonly ApplicationStatus[] = [
  APPLICATION_STATUS.DISCOVERED,
  APPLICATION_STATUS.FILLING_FORM,
  APPLICATION_STATUS.SUBMITTED,
  APPLICATION_STATUS.SUBMISSION_UNCONFIRMED,
];

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  [APPLICATION_STATUS.DISCOVERED]: "queued",
  [APPLICATION_STATUS.CREATING_ACCOUNT]: "creating account",
  [APPLICATION_STATUS.NO_ACCOUNT_REQUIRED]: "no account required",
  [APPLICATION_STATUS.AWAITING_VERIFICATION]: "awaiting verification",
  [APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED]: "account gate blocked",
  [APPLICATION_STATUS.ERROR]: "error",
  [APPLICATION_STATUS.EMAIL_VERIFIED]: "email verified",
  [APPLICATION_STATUS.FILLING_FORM]: "filling",
  [APPLICATION_STATUS.FORM_FILLED]: "form filled",
  [APPLICATION_STATUS.FORM_FILL_BLOCKED]: "form fill blocked",
  [APPLICATION_STATUS.SUBMITTED]: "submitted",
  [APPLICATION_STATUS.SUBMISSION_BLOCKED]: "submission blocked",
  [APPLICATION_STATUS.PENDING_USER_INPUT]: "pending your input",
  [APPLICATION_STATUS.SUBMISSION_UNCONFIRMED]: "submission unconfirmed",
};

export const STATUS_TONE_CLASSES: Record<ApplicationStatus, string> = {
  [APPLICATION_STATUS.DISCOVERED]: "bg-muted text-muted-foreground",
  [APPLICATION_STATUS.CREATING_ACCOUNT]: "bg-sky-500/10 text-sky-400",
  [APPLICATION_STATUS.NO_ACCOUNT_REQUIRED]: "bg-muted text-muted-foreground",
  [APPLICATION_STATUS.AWAITING_VERIFICATION]: "bg-sky-500/10 text-sky-400",
  [APPLICATION_STATUS.ACCOUNT_GATE_BLOCKED]: "bg-amber-500/10 text-amber-400",
  [APPLICATION_STATUS.ERROR]: "bg-amber-500/10 text-amber-400",
  [APPLICATION_STATUS.EMAIL_VERIFIED]: "bg-sky-500/10 text-sky-400",
  [APPLICATION_STATUS.FILLING_FORM]: "bg-sky-500/10 text-sky-400",
  [APPLICATION_STATUS.FORM_FILLED]: "bg-sky-500/10 text-sky-400",
  [APPLICATION_STATUS.FORM_FILL_BLOCKED]: "bg-amber-500/10 text-amber-400",
  [APPLICATION_STATUS.SUBMITTED]: "bg-emerald-500/10 text-emerald-400",
  [APPLICATION_STATUS.SUBMISSION_BLOCKED]: "bg-amber-500/10 text-amber-400",
  [APPLICATION_STATUS.PENDING_USER_INPUT]: "bg-amber-500/10 text-amber-400",
  [APPLICATION_STATUS.SUBMISSION_UNCONFIRMED]: "bg-amber-500/10 text-amber-400",
};

export interface MockApplicationRow {
  company: string;
  title: string;
  status: ApplicationStatus;
  time: string;
}

/** Deterministic, not random: a fixed generator so the same 40+ rows render
 * identically on every build and every capture run, which matters for a
 * screenshot pipeline that is compared against previous output by eye. */
export function buildApplicationRows(count: number): MockApplicationRow[] {
  const rows: MockApplicationRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const company = REAL_COMPANIES[i % REAL_COMPANIES.length];
    const title = REAL_TITLES[i % REAL_TITLES.length];
    const status = DISPLAY_STATUSES[i % DISPLAY_STATUSES.length];
    const hour = 23 - Math.floor(i / 2);
    const normalizedHour = ((hour % 24) + 24) % 24;
    const minute = (i * 7) % 60;
    const period = normalizedHour < 12 ? "am" : "pm";
    const displayHour = normalizedHour % 12 === 0 ? 12 : normalizedHour % 12;
    const time = `${displayHour}:${minute.toString().padStart(2, "0")}${period}`;
    rows.push({ company, title, status, time });
  }
  return rows;
}
