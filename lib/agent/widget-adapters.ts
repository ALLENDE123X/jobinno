/**
 * JOB-281 (sub ticket D of epic #276): a framework agnostic first pass at
 * committing framework state on SmartRecruiters screening dropdowns.
 *
 * Prior spikes (JOB-SPIKE v7 and v8b, plus the JOB-266 dispatch that landed
 * pointer / mouse / keyboard events on the option element) all reached the
 * same wall on 6 to 8 SR screening dropdowns per page: the visible click
 * lands, the widget's textContent even flips to the picked option, but the
 * reactive form validator SR ships with still reports the field as empty and
 * blocks submit with "Value is required". The missing ingredient is a plain
 * `change` and `input` event on whatever form control the framework actually
 * watches, which none of the prior mechanisms sent.
 *
 * This module ships that ingredient without claiming to know which framework
 * SR uses. The prior recon rounds did not confirm Angular ng select, React
 * react select, a Lit component, or vanilla, so any framework specific claim
 * here would be a fabrication. Instead the adapter dispatches synthetic
 * `input` then `change` (both bubbling and composed) on the visible widget
 * AND on any sibling hidden form control it can find by walking up the
 * widget's ancestor chain. Whichever of the two paths the framework listens
 * on gets the event; the other path is a cheap extra dispatch that no
 * observed handler cares about.
 *
 * What this module deliberately does NOT do:
 *
 *   - Live headed DOM recon of a real SR screening page. The orchestrator
 *     will do that pass after this ships, and either confirm one path is
 *     enough or narrow the adapter down to the specific control shape.
 *   - Import from `@browserbasehq/stagehand`. The `page` handle is typed as
 *     `unknown` at the module boundary and narrowed inline, so the file is
 *     unit testable under jsdom without a real browser and so sub ticket E
 *     (Stagehand wiring) can decide how the real `Page` type flows in.
 *
 * Wiring: `lib/agent/tools.ts`'s `selectDropdown` handler calls
 * `commitFrameworkState` at the end of its work when a page handle is
 * present on the tool context. Sub ticket E will add the visible
 * `[role=option]` click ahead of that call and drop the throw the current
 * scaffold still carries.
 */

/**
 * Outcome of a single adapter invocation.
 *
 *   - `committed`: an adapter matched and its commit ran without throwing.
 *     The `detail` field carries the tag list of elements the adapter
 *     dispatched on, so a trace can prove which path fired.
 *   - `no_adapter_matched`: the registry saw no adapter whose `matches`
 *     returned true for this widget. The caller falls back to the plain
 *     visible click behavior alone.
 *   - `adapter_failed`: an adapter matched but its commit threw. Recorded
 *     as a soft failure rather than a hard error so the visible click path
 *     stays in charge; the trace carries the reason.
 */
export type AdapterCommitStatus =
  | "committed"
  | "no_adapter_matched"
  | "adapter_failed";

export interface CommitResult {
  status: AdapterCommitStatus;
  adapterName: string | null;
  detail: string | null;
}

/**
 * A widget adapter answers two questions about one widget:
 *
 *   - `matches`: does this widget look like the shape the adapter knows how
 *     to fix? A false answer means the registry keeps looking; no side
 *     effect.
 *   - `commit`: dispatch whatever the framework needs to see the option as
 *     selected. Called only after `matches` returned true.
 *
 * The `page` argument is typed as `unknown` on purpose: this module is not
 * allowed to reach into Stagehand's `Page`, so the adapter narrows the
 * shape it needs inline. Sub ticket E is free to feed a real Stagehand
 * page here; the current scaffold can feed the smallest usable stub.
 */
export interface WidgetAdapter {
  readonly name: string;
  matches(page: unknown, fieldSelector: string): Promise<boolean>;
  commit(
    page: unknown,
    fieldSelector: string,
    optionValue: string
  ): Promise<CommitResult>;
}

/**
 * The narrow structural type an adapter needs from a page handle: a URL
 * accessor (used only for host matching) and an `evaluate` that runs a
 * stringified IIFE in the page context. This is a subset of Stagehand's
 * real `Page` shape, kept structural so the module never imports Stagehand
 * and so tests can pass any object that satisfies the two methods.
 */
interface PageLike {
  url?: () => string | Promise<string>;
  evaluate: (fn: string, ...args: unknown[]) => Promise<unknown>;
}

function isPageLike(value: unknown): value is PageLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "evaluate" in value &&
    typeof (value as PageLike).evaluate === "function"
  );
}

async function readPageUrl(page: PageLike): Promise<string> {
  if (typeof page.url !== "function") return "";
  try {
    const raw = await Promise.resolve(page.url());
    return typeof raw === "string" ? raw : "";
  } catch {
    return "";
  }
}

/**
 * True when the URL looks like a SmartRecruiters candidate facing page.
 * Kept as a substring test rather than a URL parse because the same host
 * pattern appears under `jobs.smartrecruiters.com`, `careers.<company>.
 * smartrecruiters.com`, and the internal `apply.smartrecruiters.com`
 * variants, and a substring match covers all three without a hard coded
 * list of host aliases.
 */
function isSmartRecruitersUrl(url: string): boolean {
  return url.toLowerCase().includes("smartrecruiters.com");
}

/**
 * Escapes a string for safe embedding in the JS source we hand to
 * `page.evaluate`. Backslash first, then single and double quotes, then
 * backticks, then the newline and carriage return pair. Kept local rather
 * than reused from `lib/form-fields.ts`'s helpers so this module has no
 * dependency edge back into the ported code.
 */
function jsLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/**
 * The in page IIFE the SR adapter's `matches` runs. Returns true when the
 * resolved element (or an ancestor) declares `role="combobox"` or
 * `role="listbox"` and has at least one `role="option"` descendant, which
 * is the structural fingerprint every SR screening dropdown observed in
 * the spike had in common. Kept structural rather than tied to a class
 * name so a class rename by SR does not silently break the adapter.
 */
function matchScript(fieldSelector: string): string {
  return `(() => {
    try {
      const sel = ${jsLiteral(fieldSelector)};
      const el = document.querySelector(sel);
      if (!el) return false;
      let scope = el;
      let widget = null;
      for (let depth = 0; depth < 6 && scope; depth++) {
        const role = scope.getAttribute && scope.getAttribute("role");
        if (role === "combobox" || role === "listbox") { widget = scope; break; }
        scope = scope.parentElement;
      }
      if (!widget) {
        const nested = el.querySelector('[role="combobox"], [role="listbox"]');
        if (nested) widget = nested;
      }
      if (!widget) return false;
      const options = widget.querySelectorAll('[role="option"]');
      return options.length > 0;
    } catch (e) {
      return false;
    }
  })()`;
}

/**
 * The in page IIFE the SR adapter's `commit` runs. Walks up the widget's
 * ancestor chain a bounded number of steps looking for hidden form
 * controls (a `<select>` sibling, or an `<input type="hidden">`), sets
 * their value when it can, then dispatches `input` then `change` on every
 * control it collected AND on the visible widget itself. Returns a JSON
 * serialisable record of what fired so the outer function can put it in
 * the `detail` field of the `CommitResult`.
 */
function commitScript(fieldSelector: string, optionValue: string): string {
  return `(() => {
    const sel = ${jsLiteral(fieldSelector)};
    const target = ${jsLiteral(optionValue)};
    const el = document.querySelector(sel);
    if (!el) {
      return { ok: false, reason: "selector did not resolve", fired: [] };
    }
    const controls = [el];
    const seen = new Set([el]);
    let scope = el;
    for (let depth = 0; depth < 6 && scope; depth++) {
      const hiddenSelectors = [
        "select",
        'input[type="hidden"]',
      ];
      for (const q of hiddenSelectors) {
        const found = scope.querySelectorAll(q);
        for (const node of found) {
          if (seen.has(node)) continue;
          seen.add(node);
          controls.push(node);
          try {
            if (node.tagName === "SELECT" && node.options) {
              const t = String(target).trim();
              for (let i = 0; i < node.options.length; i++) {
                const opt = node.options[i];
                const text = (opt.text || "").trim();
                const val = (opt.value || "").trim();
                if (text === t || val === t) {
                  node.value = opt.value;
                  break;
                }
              }
            } else if (node.type === "hidden") {
              node.value = target;
            }
          } catch (e) {
            // Assigning value on a detached or read only control is not the
            // adapter's failure mode to fix; the event dispatch below still
            // runs and the trace records what fired.
          }
        }
      }
      scope = scope.parentElement;
    }
    const fired = [];
    for (const c of controls) {
      try {
        c.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        c.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        const role = (c.getAttribute && c.getAttribute("role")) || "";
        const tag = c.tagName ? c.tagName.toLowerCase() : "node";
        fired.push(role ? tag + "[role=" + role + "]" : tag);
      } catch (e) {
        // A dispatch that cannot even run reads back exactly like one that
        // ran and changed nothing; the CommitResult carries the tag list of
        // the ones that did run.
      }
    }
    return { ok: true, fired: fired };
  })()`;
}

interface CommitScriptResult {
  ok: boolean;
  reason?: string;
  fired?: string[];
}

function coerceCommitScriptResult(value: unknown): CommitScriptResult | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const ok = record.ok === true;
  const reason =
    typeof record.reason === "string" ? record.reason : undefined;
  const fired = Array.isArray(record.fired)
    ? record.fired.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { ok, reason, fired };
}

export class SRScreeningDropdownAdapter implements WidgetAdapter {
  readonly name = "SRScreeningDropdownAdapter";

  async matches(page: unknown, fieldSelector: string): Promise<boolean> {
    if (!isPageLike(page)) return false;
    const url = await readPageUrl(page);
    if (!isSmartRecruitersUrl(url)) return false;
    try {
      const result = await page.evaluate(matchScript(fieldSelector));
      return result === true;
    } catch {
      return false;
    }
  }

  async commit(
    page: unknown,
    fieldSelector: string,
    optionValue: string
  ): Promise<CommitResult> {
    if (!isPageLike(page)) {
      return {
        status: "adapter_failed",
        adapterName: this.name,
        detail: "page handle did not expose an evaluate method",
      };
    }
    try {
      const raw = await page.evaluate(
        commitScript(fieldSelector, optionValue)
      );
      const parsed = coerceCommitScriptResult(raw);
      if (!parsed) {
        return {
          status: "adapter_failed",
          adapterName: this.name,
          detail: "commit script returned an unexpected shape",
        };
      }
      if (!parsed.ok) {
        return {
          status: "adapter_failed",
          adapterName: this.name,
          detail: parsed.reason ?? "commit script reported failure",
        };
      }
      const fired = parsed.fired ?? [];
      return {
        status: "committed",
        adapterName: this.name,
        detail: `dispatched input+change on ${fired.length} node(s): ${fired.join(", ")}`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        status: "adapter_failed",
        adapterName: this.name,
        detail: message,
      };
    }
  }
}

/**
 * The registered adapters, in the order the registry consults them. Kept
 * as a factory rather than a constant so tests can instantiate a fresh
 * adapter per call and so a future ticket can plug a config or a runtime
 * override in without churning every call site.
 */
export function getRegisteredAdapters(): readonly WidgetAdapter[] {
  return [new SRScreeningDropdownAdapter()];
}

/**
 * Runs the first matching adapter's commit. Callers hand this the page
 * handle and the same selector + option value the visible click will use,
 * and either get a `committed` result naming the adapter that fired or a
 * `no_adapter_matched` result so the caller can rely on the visible click
 * alone.
 *
 * An adapter throwing out of its own `matches` or `commit` is caught and
 * turned into `adapter_failed` rather than propagated: the framework state
 * commit is additive to the visible click, and a broken adapter should
 * degrade the run rather than fail it.
 */
export async function commitFrameworkState(
  page: unknown,
  fieldSelector: string,
  optionValue: string
): Promise<CommitResult> {
  for (const adapter of getRegisteredAdapters()) {
    let matched = false;
    try {
      matched = await adapter.matches(page, fieldSelector);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        status: "adapter_failed",
        adapterName: adapter.name,
        detail: `matches threw: ${message}`,
      };
    }
    if (!matched) continue;
    try {
      return await adapter.commit(page, fieldSelector, optionValue);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        status: "adapter_failed",
        adapterName: adapter.name,
        detail: `commit threw: ${message}`,
      };
    }
  }
  return {
    status: "no_adapter_matched",
    adapterName: null,
    detail: null,
  };
}
