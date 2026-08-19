// `.mts`, not `.ts`, and deliberately so: this package.json has no
// "type": "module", so Vite's native config loader treats a `.ts` config as
// CommonJS and warns that the `import` statements below are unsupported. The
// explicit ESM extension is the supported way to say what this file already is.
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}"],
    // Playwright owns `tests/e2e`. Running those specs under Vitest would load
    // `@playwright/test`'s `test`/`expect` into a Vitest worker and fail in a
    // way that reads like a broken suite rather than a misrouted one.
    exclude: ["**/node_modules/**", "**/.next/**", "tests/e2e/**"],
    testTimeout: 20000,
    // Scaffold state: there are no unit tests yet. Drop this once there are —
    // an empty suite passing silently is only acceptable while it is expected.
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
