/**
 * JOB-281. Cases for the `selectDropdown` tool handler after the widget
 * adapter registry landed. Two branches to cover:
 *
 *   - a call whose `ToolContext` carries a `page` handle: the handler
 *     dispatches through `commitFrameworkState` and returns the
 *     `CommitResult` unchanged.
 *   - a call whose context carries no page: the handler preserves the pre
 *     sub ticket E scaffold behavior and throws
 *     `AgentFillNotImplementedError`, which is the shape the routing tests
 *     already assert against.
 *
 * Zod validation still runs first regardless of which branch the call is
 * on; a `ZodError` on invalid input has priority over the adapter path.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { AgentFillNotImplementedError } from "@/lib/agent";
import {
  UNRESOLVED_INTAKE_FACT,
  selectDropdown,
  type ToolContext,
} from "@/lib/agent/tools";

const SR_URL = "https://jobs.smartrecruiters.com/example/1";

interface FakePage {
  url: () => string;
  evaluate: (fn: string) => Promise<unknown>;
}

function fakePage(url: string): FakePage {
  return {
    url: () => url,
    evaluate: async (fn: string) => {
      return eval(fn);
    },
  };
}

const emptyContext: ToolContext = {
  resolveIntakeFactValue: () => UNRESOLVED_INTAKE_FACT,
};

function pageContext(page: unknown): ToolContext {
  return {
    resolveIntakeFactValue: () => UNRESOLVED_INTAKE_FACT,
    page,
  };
}

function mountSrScreeningFixture(): void {
  document.body.innerHTML = `
    <form>
      <div class="sr-field">
        <div id="q1" role="combobox" aria-expanded="false" aria-haspopup="listbox">
          <ul role="listbox">
            <li role="option">Yes</li>
            <li role="option">No</li>
          </ul>
        </div>
        <select id="q1-hidden">
          <option value="">--</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </div>
    </form>
  `;
}

describe("selectDropdown", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("invokes the adapter path and returns a CommitResult when a page is on the context", async () => {
    mountSrScreeningFixture();
    const result = await selectDropdown(
      { fieldId: "#q1", label: "Screening question", optionValue: "Yes" },
      pageContext(fakePage(SR_URL))
    );
    expect(result.status).toBe("committed");
    expect(result.adapterName).toBe("SRScreeningDropdownAdapter");
  });

  it("returns no_adapter_matched when the URL is outside SmartRecruiters", async () => {
    mountSrScreeningFixture();
    const result = await selectDropdown(
      { fieldId: "#q1", label: "Screening question", optionValue: "Yes" },
      pageContext(fakePage("https://boards.greenhouse.io/example/jobs/1"))
    );
    expect(result.status).toBe("no_adapter_matched");
    expect(result.adapterName).toBeNull();
  });

  it("throws AgentFillNotImplementedError when the context carries no page", async () => {
    await expect(
      selectDropdown(
        { fieldId: "#q1", label: "Screening question", optionValue: "Yes" },
        emptyContext
      )
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
  });

  it("rejects an empty optionValue at zod validation before touching the adapter path", async () => {
    await expect(
      selectDropdown(
        { fieldId: "#q1", label: "Screening question", optionValue: "" },
        pageContext(fakePage(SR_URL))
      )
    ).rejects.toThrowError(/optionValue is required/);
  });
});
