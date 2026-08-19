// `@testing-library/jest-dom/vitest` registers the DOM matchers with Vitest's
// `expect` on import — there is no separate `expect.extend(matchers)` call to
// make. Doing both (as some older setups do) registers every matcher twice.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom is shared across tests in a file. Without this, a component rendered by
// one test is still in the document for the next one, and queries that should
// find one element find two.
afterEach(() => {
  cleanup();
});
