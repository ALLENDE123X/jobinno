/**
 * JOB-277. Covers the routing that decides whether a run takes the agent
 * fill path or the legacy widget fill path. The three branches under test
 * are exactly the ones an operator can reach by toggling the two env vars.
 */

import { describe, expect, it, vi } from "vitest";

import {
  AgentFillNotImplementedError,
  dispatchApplicationFill,
  runAgentFill,
  shouldUseAgentFillForAts,
} from "@/lib/agent";
import type {
  SubmitApplicationInput,
  SubmitApplicationResult,
} from "@/lib/submit-application";

const stubResult: SubmitApplicationResult = {
  jobApplicationId: "app_test",
  status: "form_filled",
  submitted: false,
  submitAttempted: false,
  confirmationRef: null,
  confirmation: null,
  securityCode: null,
  approval: { approved: false, gate: "auto", detail: "test stub" },
  submitControlLabel: null,
  fill: null,
  finalUrl: "https://example.test",
  pageTitle: "test",
  screenshotPath: null,
  blockedReason: null,
  unconfirmedReason: null,
  rowUpdated: false,
};

const input: SubmitApplicationInput = {
  jobApplicationId: "app_test",
  requiresCoverLetter: false,
};

describe("shouldUseAgentFillForAts", () => {
  it("returns false when USE_AGENT_FILL is unset", () => {
    expect(
      shouldUseAgentFillForAts("greenhouse", {
        USE_AGENT_FILL_ATS: "greenhouse",
      })
    ).toBe(false);
  });

  it("returns false when USE_AGENT_FILL is not the literal string 'true'", () => {
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      expect(
        shouldUseAgentFillForAts("greenhouse", {
          USE_AGENT_FILL: value,
          USE_AGENT_FILL_ATS: "greenhouse",
        })
      ).toBe(false);
    }
  });

  it("returns false when the flag is on but the allowlist is empty", () => {
    expect(
      shouldUseAgentFillForAts("greenhouse", {
        USE_AGENT_FILL: "true",
        USE_AGENT_FILL_ATS: "",
      })
    ).toBe(false);
    expect(
      shouldUseAgentFillForAts("greenhouse", {
        USE_AGENT_FILL: "true",
        USE_AGENT_FILL_ATS: ",,",
      })
    ).toBe(false);
  });

  it("returns false when the flag is on but the ats is not on the allowlist", () => {
    expect(
      shouldUseAgentFillForAts("workday", {
        USE_AGENT_FILL: "true",
        USE_AGENT_FILL_ATS: "greenhouse,lever",
      })
    ).toBe(false);
  });

  it("returns true when the flag is on and the ats is on the allowlist", () => {
    expect(
      shouldUseAgentFillForAts("greenhouse", {
        USE_AGENT_FILL: "true",
        USE_AGENT_FILL_ATS: "greenhouse,lever",
      })
    ).toBe(true);
  });

  it("tolerates whitespace around allowlist entries", () => {
    expect(
      shouldUseAgentFillForAts("lever", {
        USE_AGENT_FILL: "true",
        USE_AGENT_FILL_ATS: "  greenhouse ,  lever ",
      })
    ).toBe(true);
  });
});

describe("dispatchApplicationFill", () => {
  it("calls the legacy path when the flag is off", async () => {
    const legacy = vi.fn().mockResolvedValue(stubResult);
    const agent = vi.fn().mockResolvedValue(stubResult);

    const result = await dispatchApplicationFill(input, "greenhouse", {
      legacy,
      agent,
      env: { USE_AGENT_FILL: "false", USE_AGENT_FILL_ATS: "greenhouse" },
    });

    expect(legacy).toHaveBeenCalledOnce();
    expect(legacy).toHaveBeenCalledWith(input);
    expect(agent).not.toHaveBeenCalled();
    expect(result).toBe(stubResult);
  });

  it("calls the legacy path when the flag is on but the ats is not on the allowlist", async () => {
    const legacy = vi.fn().mockResolvedValue(stubResult);
    const agent = vi.fn().mockResolvedValue(stubResult);

    await dispatchApplicationFill(input, "workday", {
      legacy,
      agent,
      env: { USE_AGENT_FILL: "true", USE_AGENT_FILL_ATS: "greenhouse,lever" },
    });

    expect(legacy).toHaveBeenCalledOnce();
    expect(agent).not.toHaveBeenCalled();
  });

  it("calls the agent path when the flag is on and the ats is on the allowlist", async () => {
    const legacy = vi.fn().mockResolvedValue(stubResult);
    const agent = vi.fn().mockResolvedValue(stubResult);

    await dispatchApplicationFill(input, "greenhouse", {
      legacy,
      agent,
      env: { USE_AGENT_FILL: "true", USE_AGENT_FILL_ATS: "greenhouse,lever" },
    });

    expect(agent).toHaveBeenCalledOnce();
    expect(agent).toHaveBeenCalledWith(input);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("propagates the not implemented throw from the default agent", async () => {
    const legacy = vi.fn().mockResolvedValue(stubResult);

    await expect(
      dispatchApplicationFill(input, "greenhouse", {
        legacy,
        // No `agent` supplied so the routing falls through to the real
        // `runAgentFill` stub, which throws.
        env: { USE_AGENT_FILL: "true", USE_AGENT_FILL_ATS: "greenhouse" },
      })
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("runAgentFill on its own always throws AgentFillNotImplementedError", async () => {
    await expect(runAgentFill(input)).rejects.toBeInstanceOf(
      AgentFillNotImplementedError
    );
  });
});
