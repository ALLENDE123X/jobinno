# `lib/future-gmail/`: V2 reference code

Nothing in this folder is wired into the running app. It is kept deliberately, not by accident, and it should not be deleted.

## What it is

Four modules ported from actinno that together implement the emailed security code flow.

* `gmail-client.ts` builds the OAuth client and checks credentials against the Gmail API.
* `gmail-verification-listener.ts` polls a mailbox, matches a message to a pending application, extracts the code or the link, and emits an Inngest event.
* `gmail-auth-cli.ts` runs the one time consent flow that mints the refresh token.
* `verification-listener-cli.ts` runs the listener locally against a real mailbox.

## Why it is kept

Some job boards will not let anyone apply without an account first, and creating that account means receiving a security code by email and typing it back into the page. Jobinno V1 does not create accounts, so nothing here runs.

The moment automated account creation ships, this is the flow that makes it work, and it is genuinely hard to get right. It has to match a message to the right pending application, refuse to open a link from a sender that cannot speak for the board, and treat a code as single use so that a retry never burns one twice. That work is done and tested against real mailboxes. Rewriting it later from memory would be slower and worse than keeping it here.

## It still names a table that does not exist

`gmail-verification-listener.ts` reads `job_applications`, which is actinno's table and was never created in Jobinno. JOB-004 repointed every other ported module at the real schema and deliberately did not repoint this one.

Not an oversight, and not laziness. The query it makes is for rows sitting at `awaiting_verification`, waiting for a mail to arrive, and Jobinno's schema has no such state to find: the rule is skip and log, not pause and wait, so a run that hits a verification gate is given a terminal status and a `skip_log` row with reason `verification_required`. There is nothing for this listener to poll on behalf of. Translating the query would produce something that compiles, runs, and returns nothing, which is worse than something that plainly refers to a world this repository does not have yet.

The ticket that brings automated account creation back owns both halves: the state this listener waits on, and the query that finds it.

## The two threads that still reach in here

The folder is unwired at runtime but not fully isolated at compile time. Two imports cross the boundary, and both are constants rather than behavior.

1. `lib/fill-application-form.ts` imports `allowedSenderDomains`, the single source of truth for which domains may speak for a given board. It lives here because the listener needs it most, and keeping two copies of an allowlist is how an allowlist drifts.
2. ~~`inngest/job-application-pipeline.ts` imports `VERIFICATION_EVENT_NAME` and `VerificationEventData`.~~ Gone with JOB-004, which removed the conditional wait those constants existed for. One thread now instead of two, and the pipeline no longer pulls `googleapis` into the Inngest serve route's module graph.

The remaining import does not start a mailbox poll. It does pull `googleapis` in, which costs a second or so of startup wherever `fill-application-form.ts` is loaded.

One thread now runs the other way: `gmail-verification-listener.ts` imports `assertSupabaseProject` from `lib/supabase-project-guard.ts`, which JOB-002 lifted out of the four copies that used to sit inline. It is a check, not a client, and it opens nothing.

## Rules

* **Do not wire this up without a ticket that explicitly asks for it.** It reads a real person's mailbox. That is a meaningful privacy surface and it needs a deliberate decision, not a passing import.
* **Do not delete it to tidy up.** If it ever genuinely has to go, that is its own ticket with its own reasoning.
* The `GOOGLE_OAUTH_*` variables in `.env.example` exist only for this folder. Leaving them blank breaks nothing.
