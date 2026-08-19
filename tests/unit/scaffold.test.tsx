/**
 * Proves the test harness itself works. Not a test of any product behaviour.
 *
 * Three things break silently in a fresh Vitest setup and are miserable to
 * diagnose from a real test's failure: jsdom not being the environment, the
 * jest-dom matchers not being registered by `vitest.setup.ts`, and the `@`
 * alias not resolving the way it does under Next.js. This asserts all three, so
 * that the first real test to fail fails for its own reasons.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { APPLICATION_STATUS } from "@/lib/application-status";
import { cn } from "@/lib/utils";

describe("test harness", () => {
  it("runs in a DOM environment", () => {
    expect(typeof document).toBe("object");
  });

  it("has the jest-dom matchers registered", () => {
    render(<p>filled</p>);
    // `toBeInTheDocument` comes from @testing-library/jest-dom. If
    // vitest.setup.ts did not load, this line throws rather than fails.
    expect(screen.getByText("filled")).toBeInTheDocument();
  });

  it("resolves the @ alias the same way Next.js does", () => {
    expect(APPLICATION_STATUS.SUBMITTED).toBe("submitted");
    expect(cn("a", "b")).toBe("a b");
  });
});
