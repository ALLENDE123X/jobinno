// @vitest-environment node
/**
 * JOB-175. The default model driving Stagehand's act, extract, and observe
 * calls is Fireworks hosted DeepSeek V4 Flash, replacing the previous
 * openai/gpt-5.6-luna default. The switch itself is the deliverable; live
 * end to end validation against a real form fill is scheduled with the
 * JOB-207, JOB-211, JOB-212 targets.
 *
 * These tests anchor the two things a silent regression would hide: the
 * live verified Fireworks slug the adapter and the session module both
 * agree on, and the env var override that lets a rollback or an A/B swap
 * happen through a Vercel dashboard edit rather than a code deploy. No
 * Stagehand session opens here; the model resolver is a pure string
 * function on an injected env, on purpose.
 */
import { describe, expect, it } from "vitest";

import { FIREWORKS_DEEPSEEK_MODEL } from "@/lib/fireworks-client-llm";
import { STAGEHAND_MODEL, resolveStagehandModel } from "@/lib/stagehand-session";

describe("STAGEHAND_MODEL", () => {
  it("names the Fireworks DeepSeek V4 Flash slug the adapter was live verified against", () => {
    // The literal string is repeated on purpose so a silent rename in the
    // adapter shows up here as a failing assertion rather than as a passing
    // identity check that hides the drift.
    expect(FIREWORKS_DEEPSEEK_MODEL).toBe(
      "accounts/fireworks/models/deepseek-v4-flash-0731"
    );
    expect(STAGEHAND_MODEL).toBe(FIREWORKS_DEEPSEEK_MODEL);
  });

  it("routes through the Fireworks ClientLLM adapter, not Stagehand's built in provider path", () => {
    // Every accounts/fireworks/ slug is picked up by the prefix check in
    // openBrowserSession; a slug that ever loses the prefix would silently
    // fall through to the OpenAI fallback path instead.
    expect(STAGEHAND_MODEL.startsWith("accounts/fireworks/")).toBe(true);
  });
});

describe("resolveStagehandModel", () => {
  it("defaults to the Fireworks DeepSeek slug when STAGEHAND_MODEL is unset", () => {
    expect(resolveStagehandModel({})).toBe(FIREWORKS_DEEPSEEK_MODEL);
  });

  it("reads STAGEHAND_MODEL from the env when it is set", () => {
    // The override lets a Vercel dashboard edit swap builds without a code
    // deploy. A different Fireworks build stays inside the Fireworks path
    // because the routing checks the accounts/fireworks/ prefix.
    expect(
      resolveStagehandModel({
        STAGEHAND_MODEL: "accounts/fireworks/models/deepseek-v4-flash-0813",
      })
    ).toBe("accounts/fireworks/models/deepseek-v4-flash-0813");
  });

  it("treats a blank or whitespace only value as unset rather than as an override", () => {
    // A copied .env.local sometimes carries a padded value or an empty one;
    // the resolver should fall back to the default rather than pass an
    // empty string into Stagehand's own schema validator.
    expect(resolveStagehandModel({ STAGEHAND_MODEL: "" })).toBe(
      FIREWORKS_DEEPSEEK_MODEL
    );
    expect(resolveStagehandModel({ STAGEHAND_MODEL: "   " })).toBe(
      FIREWORKS_DEEPSEEK_MODEL
    );
  });

  it("trims a value that a copied .env.local left padded", () => {
    expect(
      resolveStagehandModel({
        STAGEHAND_MODEL: "  accounts/fireworks/models/deepseek-v4-flash-0731  ",
      })
    ).toBe(FIREWORKS_DEEPSEEK_MODEL);
  });
});
