// @vitest-environment node
/**
 * JOB-212. `humanizedSleep` gates every dwell added by the humanized-timing
 * pass. The default is OFF — the delays are opt-in via
 * `JOBINNO_HUMANIZE_TIMINGS=on` — because main auto-deploys to prod and a
 * default-on humanization would add ~30 to 60 seconds per run for every real
 * user before we have measured whether it actually moves the anti-spam signal.
 *
 * Two properties this file has to hold, or the whole thing is either useless
 * (an "on" run doesn't wait) or wrong (a bare merge to main starts waiting in
 * prod without a flip).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { HUMANIZE_TIMINGS, humanizedSleep } from "@/lib/humanized-delays";

describe("humanizedSleep", () => {
  afterEach(() => {
    delete process.env.JOBINNO_HUMANIZE_TIMINGS;
    vi.restoreAllMocks();
  });

  it("returns immediately with no wait and no setTimeout when the env var is unset (default off)", async () => {
    // Belt-and-braces: no env var set on entry (the afterEach cleared it), and
    // a `setTimeout` spy that would fire if the helper reached its wait.
    delete process.env.JOBINNO_HUMANIZE_TIMINGS;
    const spy = vi.spyOn(globalThis, "setTimeout");
    const started = Date.now();
    await humanizedSleep("readthrough", 20_000, 45_000);
    const elapsed = Date.now() - started;
    // A small tolerance rather than a hard 0: node's event loop can spend a
    // few milliseconds between two `Date.now()` calls even with nothing
    // awaited in between, especially under a test runner with hooks.
    expect(elapsed).toBeLessThan(50);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns immediately when the env var is set to an explicit disable value", async () => {
    // `off`, `0`, `false`, and empty are all treated as disabled — a
    // mis-spelled value fails safe to off, not on.
    for (const value of ["off", "0", "false", "", "OFF", "no", "disabled"]) {
      process.env.JOBINNO_HUMANIZE_TIMINGS = value;
      const spy = vi.spyOn(globalThis, "setTimeout");
      const started = Date.now();
      await humanizedSleep("readthrough", 20_000, 45_000);
      expect(Date.now() - started).toBeLessThan(50);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("waits for a duration inside the requested [min, max] range when JOBINNO_HUMANIZE_TIMINGS=on", async () => {
    process.env.JOBINNO_HUMANIZE_TIMINGS = "on";
    // Intercept the exact ms the helper asks for, and resolve the timer
    // instantly. A real 5–12s wait would slow the suite for no test signal;
    // what matters is the number the helper picks, not that node actually
    // sleeps that long.
    const captured: number[] = [];
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: (...args: unknown[]) => void, ms?: number) => {
        captured.push(typeof ms === "number" ? ms : 0);
        // Fire on the microtask queue so the awaiter continues.
        queueMicrotask(() => fn());
        return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
      }) as typeof globalThis.setTimeout);

    // Run the field-jitter dwell against its own configured window many times
    // so a single fluky pick can't paper over an off-by-one on either bound.
    const [minMs, maxMs] = HUMANIZE_TIMINGS.fieldJitterMs;
    for (let i = 0; i < 40; i++) {
      await humanizedSleep("field_jitter", minMs, maxMs);
    }

    spy.mockRestore();
    expect(captured.length).toBe(40);
    for (const ms of captured) {
      expect(ms).toBeGreaterThanOrEqual(minMs);
      expect(ms).toBeLessThanOrEqual(maxMs);
    }
  });

  it("also accepts `1` and `true` as enable values", async () => {
    for (const value of ["1", "true", "TRUE", " on ", "On"]) {
      process.env.JOBINNO_HUMANIZE_TIMINGS = value;
      const captured: number[] = [];
      const spy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation(((fn: (...args: unknown[]) => void, ms?: number) => {
          captured.push(typeof ms === "number" ? ms : 0);
          queueMicrotask(() => fn());
          return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
        }) as typeof globalThis.setTimeout);
      await humanizedSleep("field_jitter", 800, 3_000);
      spy.mockRestore();
      expect(captured.length).toBe(1);
      expect(captured[0]).toBeGreaterThanOrEqual(800);
      expect(captured[0]).toBeLessThanOrEqual(3_000);
    }
  });

  it("respects each reason's own bounds in HUMANIZE_TIMINGS", async () => {
    // A guardrail on the config, not the helper: an accidental edit that
    // swaps `readthroughMs = [20_000, 45_000]` for `[20, 45]` would let a
    // "read-through" dwell fire in 30 ms, which is exactly the timing shape
    // this whole ticket exists to defend against.
    const [rMin, rMax] = HUMANIZE_TIMINGS.readthroughMs;
    const [jMin, jMax] = HUMANIZE_TIMINGS.fieldJitterMs;
    const [pMin, pMax] = HUMANIZE_TIMINGS.presubmitReviewMs;
    expect(rMin).toBe(20_000);
    expect(rMax).toBe(45_000);
    expect(jMin).toBe(800);
    expect(jMax).toBe(3_000);
    expect(pMin).toBe(5_000);
    expect(pMax).toBe(12_000);
  });
});
