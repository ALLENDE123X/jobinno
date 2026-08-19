// @vitest-environment node
/**
 * The guard is the only thing standing between a stale `SUPABASE_URL` and real
 * candidate rows written into another product's database, so it gets tested
 * rather than trusted. No database and no network: it is pure string work.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXPECTED_PROJECT_REF_ENV_VAR,
  assertSupabaseProject,
  supabaseProjectRef,
} from "@/lib/supabase-project-guard";

const JOBINNO = "https://efyubrtiptcsrhfakbwc.supabase.co";
const ACTINNO = "https://oihpglvvzzmjigxrlmfz.supabase.co";

describe("supabaseProjectRef", () => {
  it("reads the ref off a hosted Supabase URL", () => {
    expect(supabaseProjectRef(JOBINNO)).toBe("efyubrtiptcsrhfakbwc");
  });

  it("returns null for a Supabase running locally", () => {
    expect(supabaseProjectRef("http://localhost:54321")).toBeNull();
    expect(supabaseProjectRef("http://127.0.0.1:54321")).toBeNull();
  });

  it("rejects a string that is not a URL", () => {
    expect(() => supabaseProjectRef("efyubrtiptcsrhfakbwc")).toThrow(
      /not a valid URL/
    );
  });
});

describe("assertSupabaseProject", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[EXPECTED_PROJECT_REF_ENV_VAR];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[EXPECTED_PROJECT_REF_ENV_VAR];
    else process.env[EXPECTED_PROJECT_REF_ENV_VAR] = saved;
  });

  it("passes when the URL names the configured project", () => {
    process.env[EXPECTED_PROJECT_REF_ENV_VAR] = "efyubrtiptcsrhfakbwc";
    expect(() => assertSupabaseProject(JOBINNO)).not.toThrow();
  });

  it("refuses another project on the same account", () => {
    process.env[EXPECTED_PROJECT_REF_ENV_VAR] = "efyubrtiptcsrhfakbwc";
    expect(() => assertSupabaseProject(ACTINNO)).toThrow(
      /oihpglvvzzmjigxrlmfz/
    );
  });

  it("refuses to guess when nothing is configured", () => {
    delete process.env[EXPECTED_PROJECT_REF_ENV_VAR];
    expect(() => assertSupabaseProject(JOBINNO)).toThrow(
      new RegExp(`${EXPECTED_PROJECT_REF_ENV_VAR} is not set`)
    );
  });

  it("treats an empty value as unset rather than as a wildcard", () => {
    process.env[EXPECTED_PROJECT_REF_ENV_VAR] = "   ";
    expect(() => assertSupabaseProject(JOBINNO)).toThrow(/is not set/);
  });

  it("always allows a local Supabase, configured or not", () => {
    delete process.env[EXPECTED_PROJECT_REF_ENV_VAR];
    expect(() => assertSupabaseProject("http://localhost:54321")).not.toThrow();
    expect(() => assertSupabaseProject("http://127.0.0.1:54321")).not.toThrow();
  });
});
