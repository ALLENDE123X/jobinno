/**
 * JOB-317. Cases for the six tool handlers the scaffold left throwing.
 * The fake page follows the convention tools-select-dropdown.test.ts and
 * widget-adapters.test.ts established: `evaluate` runs the script string
 * through `eval` against this file's jsdom document, which is close enough
 * to Stagehand's run this in the page contract to exercise every in page
 * script without a browser. The scaffold contract is pinned too: a context
 * missing the capability a handler needs (page handle or wiring hook)
 * still throws `AgentFillNotImplementedError`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentFillNotImplementedError } from "@/lib/agent";
import {
  ExcludedFieldError,
  UNRESOLVED_INTAKE_FACT,
  addRepeatingSectionEntry,
  markFieldUnanswerable,
  requestVerifyBeforeSubmit,
  setFieldValue,
  toggleCheckbox,
  uploadFile,
  type ToolContext,
  type UnanswerableFieldRecord,
  type VerifyRequestRecord,
} from "@/lib/agent/tools";

interface FakePage {
  url: () => string;
  evaluate: (fn: string) => Promise<unknown>;
}

function fakePage(): FakePage {
  return {
    url: () => "https://jobs.smartrecruiters.com/example/1",
    evaluate: async (fn: string) => {
      return eval(fn);
    },
  };
}

const emptyContext: ToolContext = {
  resolveIntakeFactValue: () => UNRESOLVED_INTAKE_FACT,
};

function pageContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    resolveIntakeFactValue: () => UNRESOLVED_INTAKE_FACT,
    page: fakePage(),
    ...overrides,
  };
}

describe("setFieldValue", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("fills a text input through the native setter and fires input and change", async () => {
    document.body.innerHTML = `<input id="first" type="text" />`;
    const events: string[] = [];
    const input = document.querySelector("#first") as HTMLInputElement;
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    const result = await setFieldValue(
      {
        fieldId: "#first",
        label: "First name",
        value: "Ada",
        sourceHint: "fabricated",
        intakeFactPath: null,
      },
      pageContext()
    );

    expect(result.ok).toBe(true);
    expect(result.readBack).toBe("Ada");
    expect(input.value).toBe("Ada");
    expect(events).toEqual(["input", "change"]);
  });

  it("leaves a React value tracker cache stale so the change registers", async () => {
    // React controlled inputs cache the last value they saw; the handler
    // must write through the prototype setter and reset the cache to the
    // prior value so the dispatched input event reads as a change.
    document.body.innerHTML = `<input id="rc" type="text" value="old" />`;
    const input = document.querySelector("#rc") as HTMLInputElement & {
      _valueTracker?: { setValue: (v: string) => void; getValue: () => string };
    };
    let tracked = "old";
    input._valueTracker = {
      setValue: (v: string) => {
        tracked = v;
      },
      getValue: () => tracked,
    };

    const result = await setFieldValue(
      {
        fieldId: "#rc",
        label: "City",
        value: "San Francisco",
        sourceHint: "fabricated",
        intakeFactPath: null,
      },
      pageContext()
    );

    expect(result.ok).toBe(true);
    expect(input.value).toBe("San Francisco");
    // The tracker holds the pre change value, which is what makes React's
    // own change detection fire on the dispatched event.
    expect(tracked).toBe("old");
  });

  it("selects a native select option by display text", async () => {
    document.body.innerHTML = `
      <select id="country">
        <option value="">--</option>
        <option value="us">United States</option>
        <option value="ca">Canada</option>
      </select>
    `;
    const result = await setFieldValue(
      {
        fieldId: "#country",
        label: "Country",
        value: "United States",
        sourceHint: "fabricated",
        intakeFactPath: null,
      },
      pageContext()
    );
    expect(result.ok).toBe(true);
    expect(result.readBack).toBe("United States");
    const select = document.querySelector("#country") as HTMLSelectElement;
    expect(select.value).toBe("us");
  });

  it("reports ok false when no select option matches, without guessing", async () => {
    document.body.innerHTML = `
      <select id="country">
        <option value="us">United States</option>
      </select>
    `;
    const result = await setFieldValue(
      {
        fieldId: "#country",
        label: "Country",
        value: "Atlantis",
        sourceHint: "fabricated",
        intakeFactPath: null,
      },
      pageContext()
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no option matched");
    const select = document.querySelector("#country") as HTMLSelectElement;
    expect(select.value).toBe("us");
  });

  it("reports ok false when the selector does not resolve", async () => {
    const result = await setFieldValue(
      {
        fieldId: "#missing",
        label: "First name",
        value: "Ada",
        sourceHint: "fabricated",
        intakeFactPath: null,
      },
      pageContext()
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("did not resolve");
  });

  it("still throws AgentFillNotImplementedError when the context carries no page", async () => {
    await expect(
      setFieldValue(
        {
          fieldId: "#first",
          label: "First name",
          value: "Ada",
          sourceHint: "fabricated",
          intakeFactPath: null,
        },
        emptyContext
      )
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
  });

  it("still rejects an excluded fill before touching the page", async () => {
    document.body.innerHTML = `<input id="emp" type="text" />`;
    const page = fakePage();
    const evaluateSpy = vi.spyOn(page, "evaluate");
    await expect(
      setFieldValue(
        {
          fieldId: "#emp",
          label: "Previous Employer",
          value: "Acme Corp",
          sourceHint: "fabricated",
          intakeFactPath: null,
        },
        pageContext({ page })
      )
    ).rejects.toBeInstanceOf(ExcludedFieldError);
    expect(evaluateSpy).not.toHaveBeenCalled();
    const input = document.querySelector("#emp") as HTMLInputElement;
    expect(input.value).toBe("");
  });
});

describe("toggleCheckbox", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("checks a native checkbox through a real click", async () => {
    document.body.innerHTML = `<input id="cb" type="checkbox" />`;
    const events: string[] = [];
    const box = document.querySelector("#cb") as HTMLInputElement;
    box.addEventListener("click", () => events.push("click"));
    box.addEventListener("change", () => events.push("change"));

    const result = await toggleCheckbox(
      { fieldId: "#cb", label: "I agree", checked: true },
      pageContext()
    );

    expect(result.ok).toBe(true);
    expect(result.readBack).toBe("checked");
    expect(box.checked).toBe(true);
    expect(events).toContain("click");
    expect(events).toContain("change");
  });

  it("unchecks a checked native checkbox", async () => {
    document.body.innerHTML = `<input id="cb" type="checkbox" checked />`;
    const result = await toggleCheckbox(
      { fieldId: "#cb", label: "Subscribe", checked: false },
      pageContext()
    );
    expect(result.ok).toBe(true);
    expect(result.readBack).toBe("unchecked");
    const box = document.querySelector("#cb") as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it("does nothing when the checkbox already holds the requested state", async () => {
    document.body.innerHTML = `<input id="cb" type="checkbox" checked />`;
    const events: string[] = [];
    const box = document.querySelector("#cb") as HTMLInputElement;
    box.addEventListener("click", () => events.push("click"));

    const result = await toggleCheckbox(
      { fieldId: "#cb", label: "Subscribe", checked: true },
      pageContext()
    );

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("already");
    expect(events).toEqual([]);
  });

  it("finds a checkbox nested under a wrapper selector", async () => {
    document.body.innerHTML = `
      <div id="row"><label><input id="cb" type="checkbox" /> I agree</label></div>
    `;
    const result = await toggleCheckbox(
      { fieldId: "#row", label: "I agree", checked: true },
      pageContext()
    );
    expect(result.ok).toBe(true);
    const box = document.querySelector("#cb") as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it("toggles an ARIA checkbox and judges it by aria-checked", async () => {
    document.body.innerHTML = `<div id="wc" role="checkbox" aria-checked="false" tabindex="0"></div>`;
    const widget = document.querySelector("#wc") as HTMLElement;
    widget.addEventListener("click", () => {
      widget.setAttribute(
        "aria-checked",
        widget.getAttribute("aria-checked") === "true" ? "false" : "true"
      );
    });
    const result = await toggleCheckbox(
      { fieldId: "#wc", label: "Custom consent", checked: true },
      pageContext()
    );
    expect(result.ok).toBe(true);
    expect(widget.getAttribute("aria-checked")).toBe("true");
  });

  it("reports ok false for an ARIA checkbox that ignores the click", async () => {
    document.body.innerHTML = `<div id="wc" role="checkbox" aria-checked="false"></div>`;
    const result = await toggleCheckbox(
      { fieldId: "#wc", label: "Stubborn widget", checked: true },
      pageContext()
    );
    expect(result.ok).toBe(false);
    expect(result.readBack).toBe("unchecked");
  });

  it("still throws AgentFillNotImplementedError when the context carries no page", async () => {
    await expect(
      toggleCheckbox(
        { fieldId: "#cb", label: "I agree", checked: true },
        emptyContext
      )
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
  });
});

describe("addRepeatingSectionEntry", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("clicks the add control inside the section", async () => {
    document.body.innerHTML = `
      <section id="experience">
        <button id="edit">Edit</button>
        <button id="add">Add another position</button>
        <button id="del">Delete</button>
      </section>
    `;
    let clicked = 0;
    (document.querySelector("#add") as HTMLButtonElement).addEventListener(
      "click",
      () => {
        clicked += 1;
      }
    );

    const result = await addRepeatingSectionEntry(
      { sectionId: "#experience", label: "Experience" },
      pageContext()
    );

    expect(result.ok).toBe(true);
    expect(result.readBack).toBe("Add another position");
    expect(clicked).toBe(1);
  });

  it("uses aria-label when the pressable has no visible text", async () => {
    document.body.innerHTML = `
      <section id="experience">
        <button id="add" aria-label="Add entry"></button>
      </section>
    `;
    const result = await addRepeatingSectionEntry(
      { sectionId: "#experience", label: "Experience" },
      pageContext()
    );
    expect(result.ok).toBe(true);
    expect(result.readBack).toBe("Add entry");
  });

  it("does not click edit or delete controls when nothing reads as add", async () => {
    document.body.innerHTML = `
      <section id="experience">
        <button id="edit">Edit</button>
        <button id="del">Delete</button>
      </section>
    `;
    const clicks: string[] = [];
    document
      .querySelectorAll("button")
      .forEach((b) => b.addEventListener("click", () => clicks.push(b.id)));

    const result = await addRepeatingSectionEntry(
      { sectionId: "#experience", label: "Experience" },
      pageContext()
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no add control found");
    expect(result.detail).toContain("Edit");
    expect(clicks).toEqual([]);
  });

  it("reports ok false when the section selector does not resolve", async () => {
    const result = await addRepeatingSectionEntry(
      { sectionId: "#missing", label: "Experience" },
      pageContext()
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("did not resolve");
  });

  it("still throws AgentFillNotImplementedError when the context carries no page", async () => {
    await expect(
      addRepeatingSectionEntry(
        { sectionId: "#experience", label: "Experience" },
        emptyContext
      )
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
  });
});

describe("uploadFile", () => {
  it("materializes the storage path and hands it to the page's file API", async () => {
    const setInputFiles = vi.fn().mockResolvedValue(undefined);
    const materializeUpload = vi
      .fn()
      .mockResolvedValue("/tmp/agent-run/resume.pdf");
    const page = { ...fakePage(), setInputFiles };

    const result = await uploadFile(
      {
        fieldId: "#resume",
        label: "Resume",
        storagePath: "resumes/user-1/resume.pdf",
      },
      pageContext({ page, materializeUpload })
    );

    expect(materializeUpload).toHaveBeenCalledWith("resumes/user-1/resume.pdf");
    expect(setInputFiles).toHaveBeenCalledWith(
      "#resume",
      "/tmp/agent-run/resume.pdf"
    );
    expect(result.ok).toBe(true);
    expect(result.readBack).toBe("/tmp/agent-run/resume.pdf");
  });

  it("falls back to the locator flavored file API", async () => {
    const setInputFiles = vi.fn().mockResolvedValue(undefined);
    const locator = vi.fn().mockReturnValue({ setInputFiles });
    const materializeUpload = vi
      .fn()
      .mockResolvedValue("/tmp/agent-run/resume.pdf");
    const page = { ...fakePage(), locator };

    const result = await uploadFile(
      {
        fieldId: "#resume",
        label: "Resume",
        storagePath: "resumes/user-1/resume.pdf",
      },
      pageContext({ page, materializeUpload })
    );

    expect(locator).toHaveBeenCalledWith("#resume");
    expect(setInputFiles).toHaveBeenCalledWith("/tmp/agent-run/resume.pdf");
    expect(result.ok).toBe(true);
  });

  it("reports ok false when the page exposes no file API", async () => {
    const materializeUpload = vi
      .fn()
      .mockResolvedValue("/tmp/agent-run/resume.pdf");
    const result = await uploadFile(
      {
        fieldId: "#resume",
        label: "Resume",
        storagePath: "resumes/user-1/resume.pdf",
      },
      pageContext({ materializeUpload })
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no file input API");
  });

  it("throws AgentFillNotImplementedError when the materializer is absent", async () => {
    await expect(
      uploadFile(
        {
          fieldId: "#resume",
          label: "Resume",
          storagePath: "resumes/user-1/resume.pdf",
        },
        pageContext()
      )
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
  });

  it("throws AgentFillNotImplementedError when the context carries no page", async () => {
    await expect(
      uploadFile(
        {
          fieldId: "#resume",
          label: "Resume",
          storagePath: "resumes/user-1/resume.pdf",
        },
        emptyContext
      )
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
  });
});

describe("markFieldUnanswerable", () => {
  it("hands the record to the loop wiring and returns it", async () => {
    const received: UnanswerableFieldRecord[] = [];
    const result = await markFieldUnanswerable(
      {
        fieldId: "#visa",
        label: "Do you require sponsorship?",
        reason: "no sponsorship fact in the catalog",
      },
      {
        resolveIntakeFactValue: () => UNRESOLVED_INTAKE_FACT,
        onFieldUnanswerable: (record) => received.push(record),
      }
    );
    expect(received).toEqual([
      {
        fieldId: "#visa",
        label: "Do you require sponsorship?",
        reason: "no sponsorship fact in the catalog",
      },
    ]);
    expect(result).toEqual(received[0]);
  });

  it("fails closed when the wiring hook is absent", async () => {
    // HARD STOP 9's safety valve must never be silently swallowed: a loop
    // that forgot to wire the hook gets a throw, not a lost signal.
    await expect(
      markFieldUnanswerable(
        {
          fieldId: "#visa",
          label: "Do you require sponsorship?",
          reason: "no sponsorship fact in the catalog",
        },
        emptyContext
      )
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
  });
});

describe("requestVerifyBeforeSubmit", () => {
  it("hands the note to the loop wiring and returns it", async () => {
    const received: VerifyRequestRecord[] = [];
    const result = await requestVerifyBeforeSubmit(
      { note: "all required fields filled, ready for verify" },
      {
        resolveIntakeFactValue: () => UNRESOLVED_INTAKE_FACT,
        onVerifyRequested: (record) => received.push(record),
      }
    );
    expect(received).toEqual([
      { note: "all required fields filled, ready for verify" },
    ]);
    expect(result).toEqual(received[0]);
  });

  it("fails closed when the wiring hook is absent", async () => {
    await expect(
      requestVerifyBeforeSubmit({ note: "ready" }, emptyContext)
    ).rejects.toBeInstanceOf(AgentFillNotImplementedError);
  });
});
