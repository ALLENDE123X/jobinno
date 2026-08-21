# Jobinno: Agent Operating Guide

MEMORY_PROJECT: startup

Read this file at the start of every session, before touching anything.

Jobinno is built by a fleet of agents working in parallel, one ticket each, coordinated by Pranav's orchestrating session. You are almost certainly an implementation agent. That means you pick up one ticket, work it on one branch, open one PR, and stop. You do not merge. An independent review agent does the review, and its verdict goes back to Pranav's session, not to you.

## HARD STOPS

Violating any of these is a critical failure, not a style problem.

**1. Never merge your own PR.** Do not run `gh pr merge`, and do not call the merge tool. Every merge requires an independent review agent's approval, communicated back to Pranav's orchestrating session. Implementation agents open the PR and stop there. This is not a formality you can shortcut when the change looks obviously fine, and it is not waived by CI being green.

**2. Never commit debugging artifacts.** Before every commit, check for and exclude `ci_log*.txt`, `review.md`, `*.log`, `pr_body.md`, `CONTEXT.md`, `output.txt`, and anything else that exists only because you were debugging or reviewing. Use explicit file paths in `git add`. Never `git add -A` and never `git add .`. Those two commands are how every one of the file names listed above got committed somewhere before.

**3. Never push directly to `main` for feature work.** Branch, then PR. The only exception on record is the one time bootstrap commit that created this repository, and that exception is spent.

**4. Never write a literal star followed by a slash inside a block comment.** It closes the comment early and breaks the build silently, and the usual way it happens is quoting a cron expression such as the one that means every fifteen minutes. Describe cron schedules in words instead, or put them in a line comment.

**5. Never run anything destructive against a real `DATABASE_URL` without an explicit opt in env var gate.** No `TRUNCATE`, no `DROP`, no bulk delete, no reset script, unless a variable like `RUN_DESTRUCTIVE_DB_TESTS=true` has to be set by hand first, and the default with that variable unset is to skip. Assume any `.env.local` you find points at production, because it usually does. When writing anything that touches the database, prefer a disposable insert and delete over anything that could empty a table.

**6. One ticket is one branch is one PR.** Do not let scope creep across ticket boundaries. If you notice a real problem outside your ticket, write it down in the PR description and leave it alone.

**7. Run `npm install` first thing in a fresh worktree.** `node_modules` is gitignored and does not come across when a worktree is created. Half the confusing failures in a new worktree are this.

**8. No em dashes and no hyphens anywhere in user facing or reader facing text.** That covers UI copy, emails, error messages, `README.md`, and documentation. Rephrase rather than hyphenate: write "new grad", not the hyphenated form, and "real time", not the hyphenated form. File names, flags, and code identifiers keep their real hyphens, because they are identifiers and not prose. This rule is checkable, and a reviewer will check it.

**9. Never let the LLM invent a fact that is not in the user's intake data.** This applies to every free text answer generated for an application form: cover letters, "why do you want to work here", "describe a project", salary expectations, graduation dates, anything. Submitting an application is the user attesting that what is on it is true. A fabricated answer breaks that attestation, and the person who wears the consequence is the applicant, not us. If the intake data does not support an honest answer, the correct behavior is to stop the run and surface the question, never to fill the gap plausibly. Any prompt that generates free text must be grounded in retrieved intake fields, and any response must be validated against them before it reaches a form.

**10. EEO and demographic fields are always answered "decline to self identify" in V1.** Race, gender, veteran status, and disability status are never stored, never inferred from anything, and never transmitted. There is no configuration option for this and no ticket should add one without an explicit product decision from Pranav.

**11. Never use Claude Code's own built in per directory auto memory system for this project.** Cross session memory for Jobinno, and for its prior chapters Actinno, Meminno, and Propinno, all lives at `/Users/pranavlende/claude-memory/projects/startup/`. Read `MEMORY.md` there before assuming no history exists, and route anything checkpoint or lesson worthy there, in the existing format, never to `~/.claude/projects/*/memory/`, which is the harness's own automatic location, scoped by a hash of the working directory and with no relationship to this project's real history. This has already misfired twice silently: once for the Propinno chapter and once on this exact repo on 2026-08-21, both caught and fixed after the fact rather than prevented. If a `/checkpoint` or `/restore` invocation is available, prefer passing `--project startup` explicitly over relying on auto detection, since the detection script the generic skill documents itself does not exist on this machine.

## What Jobinno is

An autonomous job application agent for CS interns and new grads. A user hands it a resume and a short intake once. It then finds openings, drives a real browser through each application form, fills it from the user's real data, submits, and records what happened.

Target platforms: Greenhouse, Lever, Ashby, Workable, BambooHR, Breezy, JazzHR, Recruitee, Teamtailor, SmartRecruiters.

## Architecture

* **Next.js** with the App Router and TypeScript. Tailwind v4 plus shadcn/ui for the dashboard. `components.json` is already configured, so the shadcn MCP tool works.
* **Supabase** for Postgres, auth, and resume storage in a private bucket. **Drizzle ORM** on top, schema in `lib/db/schema.ts`, config in `drizzle.config.ts`. Auth is Supabase Auth, not NextAuth.
* **Inngest** for the durable pipeline. `inngest/job-application-pipeline.ts` fans out from one search into one run per listing, each run its own sequential chain. Nothing but ids and strings crosses a step boundary, because a live browser cannot survive one.
* **Browserbase** for remote browsers, driven by **Stagehand** for automation the LLM guides. The ported code currently opens a local Chromium; moving it onto Browserbase is its own ticket.
* **Stripe** for billing. **PostHog** for product analytics.
* **Vitest** for unit tests in `tests/unit`, **Playwright** for browser tests in `tests/e2e`. The Playwright job in CI is conditional and only runs on PRs whose title or labels mention ui, dashboard, or page.

## The ported engine

Almost everything in `lib/` was ported from a sibling project called actinno, which built and tested the same form filling and submission machinery against real job boards. Two things follow from that.

**Read the comments before changing anything.** Those files carry long headers explaining why a decision was made, and the reasoning is usually load bearing. They still refer to actinno ticket numbers such as ACT-007. That is fine and expected. Do not delete the reasoning in the course of a cleanup.

**Never modify the actinno checkout.** It lives at `/Users/pranavlende/code/actinno` and is kept as is for possible future use. Read from it freely. Write to it never.

Two artifacts of the port to know about:

* `lib/application-status.ts` holds the status vocabulary that four modules share. It was lifted out of actinno's `create-board-account.ts`, which was not ported.
* `lib/account-creation-placeholder.ts` is a stub that throws. The pipeline still has a `create-account` step calling it, left in place deliberately so that removing it is its own reviewable change rather than something buried in a port.

### Known gaps left by the port

JOB-001 was a copy and make it compile ticket. The whole port type checks, lints, and builds clean, but these are wired to actinno's world and not yet to Jobinno's. Each needs its own ticket.

1. ~~The Supabase project guard was hardcoded to actinno.~~ **Closed by JOB-002.** The four private copies are gone; every ported module now imports the shared `assertSupabaseProject()` from `lib/supabase-project-guard.ts`, which reads the expected ref from `EXPECTED_SUPABASE_PROJECT_REF` rather than a hardcoded string. The localhost carve out is preserved.
2. **`SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` name the same project twice.** The ported modules read the first, the app side will read the second. Unify them.
3. **Stagehand still opens a local Chromium.** Moving it onto Browserbase is a ticket of its own (JOB-005), and `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` are already reserved in `.env.example` for it. JOB-000's probe confirmed Browserbase itself is viable, no blocking, so this is pure implementation, not a design question.
4. ~~`lib/db/schema.ts` was empty.~~ **Closed by JOB-002.** Seven tables (`profiles`, `resumes`, `boards`, `jobs`, `applications`, `skip_log`, `feedback`), RLS enabled on the five that hold user data, 11 policies verified live against the real database. ~~The ported modules still read actinno's `candidates` and `job_applications`.~~ **Closed by JOB-004**, which repointed every one of them at `profiles`, `resumes`, `applications`, `jobs` and `skip_log`, replaced the `error_message` column with a `skip_log` row, and added the Inngest serve route that finally registers JOB-003's cron. Two things it left open on purpose: the `supabase-js` versus Drizzle reconciliation, since the ported modules still reach Supabase over PostgREST rather than through Drizzle, and `lib/future-gmail/`, which still names `job_applications` because it is unwired V2 reference code for a flow this schema deliberately does not have.
5. ~~Authenticated users can update their own `plan` and `applications_cap` columns directly, because Postgres row level security restricts rows and not columns.~~ **Closed by JOB-007**, which found the same bug a second time on `attested_at` and fixed both in `drizzle/0003_profiles_column_privileges.sql`. `authenticated` no longer holds a table wide UPDATE on `profiles`; it holds a named grant on the columns a person answers about themselves, and `plan`, `applications_used`, `applications_cap` and `attested_at` are writable only by the service role. Closes [issue #2](https://github.com/ALLENDE123X/jobinno/issues/2).
6. **One lint warning survives:** an unused `_signals` binding in `lib/fill-application-form.ts`. Left alone rather than silently edited, since touching ported code outside a ticket's scope is how a port stops being reviewable.
7. **Two columns actinno had have no Jobinno equivalent.** `candidates.target_title` and `candidates.pay_min` were search preferences; `candidates.linkedin_url` was the profile URL an application form asks for by name. JOB-004 dropped all three from `CandidateRecord` rather than hard wiring them to null, so that the day a column is added is a compile error at every site that should start reading it. Until then a title and a pay floor have to be supplied on the `job-search/requested` event, and a LinkedIn URL comes from the resume text or from nowhere. Closing this is a `profiles` migration plus three fields on the intake form.
8. **`profiles.applications_used` is written by nothing.** `claimApplicationRow` enforces `applications_cap` against a live count of the person's `applications` rows instead, because a guard reading a counter nobody increments is not a guard. Whichever ticket owns billing owns making the column true or removing it.

## `lib/future-gmail/` is unwired V2 reference code

Four modules that implement the emailed security code flow. Nothing in the running app calls them. They are kept because that flow is what makes automated account creation possible, and it is hard to get right.

**Do not wire this up without a ticket that explicitly asks for it.** It reads a real person's mailbox, which is a real privacy surface and needs a deliberate decision. Do not delete it to tidy up either. See `lib/future-gmail/README.md` for the two compile time imports that still cross the boundary.

## Ticket and PR protocol

* One ticket, one branch, one PR. Aim for under 300 lines and under 5 files. Split anything bigger.
* Branch naming: `job-XXX-short-description`.
* Before opening the PR: `npm run typecheck`, `npm run lint`, and `npm test` all pass locally. CI has to be green before the PR is reviewable.
* The PR description says what changed, what you verified, and what you deliberately left undone. If you left a known type error or a TODO behind, name it there. A reviewer finding an unmentioned one is worse than the error itself.
* Then stop. Do not merge. See HARD STOP 1.

## Conventions

* Match the patterns already in the file you are editing. The ported modules have a consistent house style and it is worth preserving.
* Secrets live in `.env.local` and in the deployment environment. Never in the repository. `.env.example` documents the shape and is the only env file that gets committed.
* Add every new env var to `.env.example` in the same PR that introduces it, under the right heading.
* Validate every LLM response with zod before trusting it. Fail closed with a typed reason when a key is missing. The ported modules already do this; copy the pattern rather than inventing a new one.
* Anything that writes to `applications.status` uses the values in `lib/application-status.ts`. Do not add a second competing enum. Anything that records *why* a run stopped writes a `skip_log` row through `lib/application-records.ts`, with a reason from the closed set in `lib/db/schema.ts`. There is no free text error column and one should not be added: skip and log, do not pause and wait.
* A new column on `profiles` is not writable by `authenticated` until a migration grants it by name, because the table wide UPDATE grant is gone (see `drizzle/0003_profiles_column_privileges.sql`). Decide which side of that line the column is on in the ticket that adds it, and grant it there if it belongs to the person rather than to us.
* `drizzle-kit migrate` can fail against Supabase without printing anything. `db.<ref>.supabase.co` resolves to an IPv6 address only, confirm with `host db.<ref>.supabase.co`, and a machine with no IPv6 route cannot reach it. When that happens the command prints "applying migrations..." and exits 1 with no error text at all, which looks exactly like a successful no op. That is how `drizzle/0005_profiles_stripe_customer_id.sql` shipped in a merged looking state while the column never existed in production, found during the JOB-010 review on PR #9. CI cannot catch this either: `.github/workflows/ci.yml` runs `drizzle-kit push` against a throwaway container and applies `drizzle/0003_profiles_column_privileges.sql` by name, but it never runs the numbered migration files in order, so a migration that sits in `drizzle/` and was never actually applied to production stays invisible to CI forever. Work around it by migrating through the IPv4 session mode pooler instead of the direct host: rewrite `DATABASE_URL` from `postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres` to `postgresql://postgres.<ref>:PASSWORD@aws-0-us-west-2.pooler.supabase.com:5432/postgres`. The username becomes `postgres.<project ref>`, and this project's pooler region is `aws-0-us-west-2`; `aws-1-us-west-2` answers "tenant or user not found". Session mode on port 5432 supports DDL, so `drizzle-kit migrate` runs normally through it and records into `drizzle.__drizzle_migrations` correctly. After any migration, confirm the change actually landed by querying the live database, `information_schema.columns` or `information_schema.column_privileges`, since a green CI run proves nothing about production schema state.
* `submitted` is terminal and can never be undone. `submission_unconfirmed` means the button was clicked and the result is unknown, and it must never be retried automatically. Preserve both properties in anything that touches the submit path.

## Key refs

* Repository: `ALLENDE123X/jobinno`, private.
* Ported from: `/Users/pranavlende/code/actinno`. Read only, always.
* Sibling project whose conventions this file adapts: `ALLENDE123X/propinno`.
* Cross session memory: `/Users/pranavlende/claude-memory/projects/startup/`. See HARD STOP 11.
* Env: see `.env.example`, which splits variables into the ones code reads today and the ones provisioned ahead of the tickets that need them.
