// @vitest-environment node
/**
 * JOB-237 — the BambooHR solver bootstrap.
 *
 * `bamboohrSolver` carries no board specific classifier of its own (see its
 * own header for why), so there is no probe or patch function to pin against
 * fixtures the way `tests/unit/recruitee-solver.test.ts` and its siblings do
 * for their boards. What is worth covering here is the registry wiring
 * itself: `lookupSolver("bamboohr")` has to actually return `bamboohrSolver`
 * rather than falling through to `domFallbackSolver`, and the export has to
 * be the `function` declaration the module cycle in `lib/solvers/index.ts`
 * requires, not a `const` arrow binding that could still be `undefined` at
 * the moment `index.ts`'s own object literal is built.
 */
import { describe, expect, it } from "vitest";

import { bamboohrSolver } from "@/lib/solvers/bamboohr";
import { lookupSolver } from "@/lib/solvers/index";

describe("the solver registry", () => {
  it("routes bamboohr through bamboohrSolver", () => {
    expect(lookupSolver("bamboohr")).toBe(bamboohrSolver);
  });
});

describe("bamboohrSolver", () => {
  it("is exported as a real function, not an uninitialised const binding", () => {
    // A `const arrow` bound through the same registry cycle `lever.ts`,
    // `greenhouse.ts`, `workable.ts` and `recruitee.ts` document could still
    // import as `undefined` depending on module evaluation order — this
    // guards the same failure mode those files' `function` declarations
    // exist to avoid, without needing to actually race the import order.
    expect(typeof bamboohrSolver).toBe("function");
    expect(bamboohrSolver.name).toBe("bamboohrSolver");
  });
});
