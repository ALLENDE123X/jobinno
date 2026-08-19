# Jobinno

An autonomous job application agent for CS interns and new grads. It applies while you sleep.

## The problem

Getting a software internship or a first job out of school is a volume game that nobody admits is a volume game. The advice is to tailor every application. The reality is that a strong candidate sends several hundred of them before anything lands. Each one is the same twenty minutes: find the posting, open the careers page, retype a name and an email and a phone number, upload the same resume, answer the same three questions about work authorization, click submit.

Jobinno does that part. You hand it a resume and a few facts about yourself once. It finds openings, opens each one in a real browser, fills the form with your real answers, and submits.

## What it actually does

* **Finds openings.** Pulls fresh postings from the public internship listing repos and from the applicant tracking systems that companies publish directly.
* **Reads your resume once.** Parses it into structured facts: schools, roles, dates, skills, links.
* **Fills the form.** Drives a real browser through the posting's application form, identifying each field and answering it from your intake data.
* **Submits.** Presses the button, confirms what the board showed back, and records the outcome.
* **Tells you what happened.** Every application ends in a row you can read: submitted, blocked and why, or needs a human.

## Supported application platforms

Greenhouse, Lever, Ashby, Workable, BambooHR, Breezy, JazzHR, Recruitee, Teamtailor, and SmartRecruiters.

## Two rules the agent will not break

These are product commitments, not implementation details.

1. **It never invents an answer.** Free text questions are answered from your intake data or not at all. When an application is submitted, you are attesting that everything on it is true, and a fabricated answer breaks that attestation. If a question cannot be answered honestly from what you told it, the run stops and asks you.
2. **It declines to self identify.** Every EEO and demographic question is answered "decline to self identify". Jobinno does not store, infer, or transmit race, gender, veteran status, or disability status.

## Stack

* **Next.js** with the App Router, TypeScript, Tailwind, and shadcn/ui for the dashboard
* **Supabase** for Postgres, auth, and resume storage, with Drizzle ORM on top
* **Inngest** for the durable background pipeline that runs each application
* **Browserbase** for remote browsers, driven by **Stagehand** for automation the LLM guides
* **Stripe** for billing and **PostHog** for product analytics
* **Vitest** for unit tests and **Playwright** for browser tests

## Repository layout

```
app/                  Next.js App Router pages and routes
components/           shadcn/ui components
inngest/              the durable pipeline that runs one application end to end
lib/                  the application engine, ported from the actinno project
  db/                 Drizzle schema
  future-gmail/       V2 reference code, not wired up (see that folder's README)
tests/unit/           Vitest
tests/e2e/            Playwright
```

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run dev
```

`.env.example` documents every variable, split into the ones that code reads today and the ones provisioned ahead of the tickets that will need them. Blank values are fine for anything in the second group.

Useful scripts:

```bash
npm run typecheck    # tsc --noEmit
npm run lint
npm test             # Vitest
npm run test:e2e     # Playwright
npm run db:generate  # write a migration for the current schema
npm run db:migrate   # apply pending migrations
npm run db:push      # push the schema straight to Postgres, no migration file
```

Schema changes go through `db:generate` and then `db:migrate`, always in that order and always both. `db:push` is for a scratch database only. Applying SQL to a real database by hand leaves drizzle's own bookkeeping table behind, and every migration after that fights the database instead of describing it.

## Where the engine came from

The form filling and submission engine in `lib/` was not written from scratch. It was ported from a sibling project called actinno, which built and tested the same machinery against real job boards. Roughly nine thousand lines came across mostly untouched, and the comments in those files still refer to actinno's own ticket numbers. That is deliberate. Those comments record why a regular expression has word boundaries on both ends, or why one module refuses to retry after a click, and rewriting them would throw away the reason while keeping the code.

Two pieces of that port are worth knowing about before reading the code:

* `lib/account-creation-placeholder.ts` stands in for a module that was deliberately left behind. The pipeline still has a step that calls it, and that step is scheduled for removal.
* `lib/future-gmail/` holds four modules that compile but never run. See the README in that folder.

## Status

Early. The engine works, the scaffold is up, and the database schema and its row level security policies are live. The dashboard, billing, and the wiring between them are all still ahead.

## A note on style

No em dashes and no hyphens in reader facing text anywhere in this repository. That covers UI copy, emails, error messages, and documentation like this file. Rephrase instead. `CLAUDE.md` states the rule for anyone, human or agent, working in here.
