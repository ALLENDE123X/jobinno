#!/usr/bin/env node
/**
 * JOB-029 (issue #47) regression check.
 *
 * Nothing in CI ever actually ran a `lib/*-cli.ts` entrypoint through `tsx`
 * before this ticket — `npm run typecheck` is pure type checking with no
 * runtime module resolution, `npm run lint` never executes anything, and
 * `npm test` runs under Vitest's own module transform, not `tsx`. That gap is
 * exactly how every browser-touching CLI (`fill-form-cli.ts`,
 * `submit-application-cli.ts`, and `scripts/browserbase-reap-lag.ts` on its
 * own branch) got to crash on startup with
 * `Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in
 * node_modules/@browserbasehq/stagehand/package.json` without anything red
 * in CI. See `lib/stagehand-session.ts`'s `loadStagehandRuntime` for the full
 * diagnosis of why that happened and why a dynamic `import()` fixes it.
 *
 * This script actually invokes `tsx` against each affected CLI and fails the
 * build if that resolution crash reappears anywhere in its output — a
 * regression back to a top-level `import` of `@browserbasehq/stagehand`
 * anywhere in the module graph these CLIs load would be caught here.
 *
 * Deliberately plain Node (no TypeScript, no `tsx` needed to run *this*
 * file): the thing under test is whether tsx can resolve these CLIs' own
 * dependencies, so the checker doing the checking should not add another
 * layer of the same tool.
 *
 * Deliberately does NOT supply `--application`, `--candidate`, credentials,
 * or any other required input. Every affected CLI validates its own
 * arguments and required env vars before it ever reaches the browser-session
 * code that needs `@browserbasehq/stagehand`, so a non-zero exit here is
 * normal and expected — see each CLI's own usage output. What this refuses
 * to accept is the resolution crash itself, at any point in stdout/stderr,
 * or the process failing to start at all.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Every `lib/*-cli.ts` that reaches `@browserbasehq/stagehand` through
// `lib/stagehand-session.ts`, and so shares the one fix this checks.
const CLIS_TO_CHECK = ["lib/fill-form-cli.ts", "lib/submit-application-cli.ts"];

const RESOLUTION_CRASH_MARKER = "ERR_PACKAGE_PATH_NOT_EXPORTED";

let failed = false;

for (const cli of CLIS_TO_CHECK) {
  const result = spawnSync("npx", ["tsx", cli], {
    cwd: repoRoot,
    input: "",
    encoding: "utf8",
    timeout: 60_000,
  });

  if (result.error) {
    failed = true;
    console.error(`FAIL ${cli}: could not even start tsx (${result.error.message}).`);
    continue;
  }

  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (combined.includes(RESOLUTION_CRASH_MARKER)) {
    failed = true;
    console.error(
      `FAIL ${cli}: tsx failed to resolve an ESM-only dependency ` +
        `(${RESOLUTION_CRASH_MARKER}) — see issue #47 / JOB-029.`
    );
    console.error(combined);
    continue;
  }

  console.log(`OK   ${cli}: dependencies resolved cleanly under tsx (exit ${result.status}).`);
}

if (failed) {
  console.error("\nJOB-029 tsx CLI resolution check failed.");
  process.exit(1);
}

console.log("\nAll tsx CLI entrypoints resolved their dependencies cleanly.");
