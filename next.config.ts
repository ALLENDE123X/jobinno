import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Pin Turbopack's workspace root to this checkout. In a parallel worktree
   * setup, Turbopack's auto-detection can pick the outer main-repo directory
   * as the root and serve stale files with no error surfaced (see the note in
   * `startup/MEMORY.md`). Pinning it here makes that impossible.
   */
  turbopack: {
    root: __dirname,
  },
  /**
   * Packages the bundler must leave alone and let Node `require` at runtime.
   *
   * Added by JOB-004, and not a tuning knob: without it `npm run build` fails
   * outright. `app/api/inngest/route.ts` is the first thing under `app/` to
   * import the pipeline, which reaches Stagehand, and Stagehand resolves its
   * bundled browser extension with `new URL("../", import.meta.url)`. Turbopack
   * tries to resolve that as a module specifier, cannot, and stops the build:
   *
   *   Module not found: Can't resolve '../'
   *   ./node_modules/@browserbasehq/stagehand/dist/index.mjs
   *
   * The pattern is a real path relative to the installed package, so the fix is
   * to stop bundling the package rather than to work around the expression. All
   * four listed here are Node only and server only, none of them is reachable
   * from a client component, and every one of them either ships or reads real
   * files on disk, which is the case bundling cannot preserve.
   */
  serverExternalPackages: [
    // Ships a browser extension it locates relative to its own package root.
    "@browserbasehq/stagehand",
    // Reads bundled PDF worker assets the same way.
    "unpdf",
    // Enormous, CommonJS, and loads its API discovery documents at runtime.
    "googleapis",
    // A native-ish socket driver with no business in a browser bundle.
    "postgres",
  ],
};

export default nextConfig;
