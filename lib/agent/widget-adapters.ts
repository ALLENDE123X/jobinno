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
 * AND on any sibling hidden form control it can find inside the widget's
 * own field group. Whichever of the two paths the framework listens on gets
 * the event; the other path is a cheap extra dispatch that no observed
 * handler cares about.
 *
 * The scope of the hidden control search is deliberately narrow. The first
 * revision walked up the widget's ancestor chain calling `querySelectorAll`
 * on every ancestor up to 6 levels; the JOB-281 red team pointed out that
 * once the walk reached the surrounding `<form>` the query returned every
 * hidden input and every `<select>` in the form, so the commit was
 * silently overwriting sibling screening dropdowns and CSRF tokens. The
 * current commit script instead scopes to `closest('[data-field], .sr-
 * field, fieldset')` with a fallback to the widget's direct parent's
 * direct children only; see `commitScript` below for the exact rules.
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
  /**
   * JOB-317: set by adapters that can prove, by reading the widget's own
   * state back after the commit, whether the framework actually accepted
   * the value. `true` means the readback showed the committed value in the
   * widget's reactive state; `false` means the commit ran but the state
   * readback did not show it; absent means the adapter has no state
   * readback to offer (the JOB-281 event dispatch adapter, for example,
   * can only prove events fired, not that anything listened).
   */
  stateVerified?: boolean;
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
export interface PageLike {
  url?: () => string | Promise<string>;
  evaluate: (fn: string, ...args: unknown[]) => Promise<unknown>;
}

export function isPageLike(value: unknown): value is PageLike {
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
 * True when the URL is served from a `smartrecruiters.com` host or one of its
 * subdomains (`jobs.smartrecruiters.com`, `careers.<company>.smartrecruiters
 * .com`, `apply.smartrecruiters.com`, and any other subdomain the ATS uses).
 *
 * Uses `URL.hostname` with a trailing dot boundary rather than a `String
 * .includes` on the raw URL, because the substring form false positives on a
 * path or query string that happens to contain the phrase, for example
 * `https://evil.example/redirect?to=smartrecruiters.com`. The parse also
 * discards ports, credentials, fragments, and the rest of the URL noise, so
 * only the host contributes to the decision.
 */
function isSmartRecruitersUrl(url: string): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "smartrecruiters.com" || host.endsWith(".smartrecruiters.com");
}

/**
 * Escapes a string for safe embedding in the JS source we hand to
 * `page.evaluate` as a double quoted literal. The set covered:
 *
 *   - Backslash, which has to run first so later replacements do not double
 *     escape their own inserts.
 *   - The double quote that closes the literal.
 *   - Newline (`\n`) and carriage return (`\r`), which terminate a string
 *     literal in JS source.
 *   - U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR). These are
 *     valid in JS string values but are illegal inside a string literal in
 *     JS source; leaving one raw turns the injected script into a parse
 *     error. See ECMA-262 12.9.4 for the exact rule.
 *
 * Single quotes and backticks do not need escaping because the wrapper this
 * function returns is a double quoted literal; they are ordinary characters
 * inside that literal. Kept local rather than reused from
 * `lib/form-fields.ts`'s helpers so this module has no dependency edge back
 * into the ported code.
 */
export function jsLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    // U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are
    // valid inside a JS string VALUE but illegal inside a JS string
    // LITERAL in source. Written as \uXXXX inside the regex literal so
    // the source of this file never carries the raw code points.
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `"${escaped}"`;
}

/**
 * JS source that defines the in page `resolveWidget(start)` helper. Given
 * an arbitrary starting element, walks up the ancestor chain (up to 6
 * levels) and returns the nearest `[role=combobox]` or `[role=listbox]`
 * ancestor, or the start element itself if it already has that role.
 * Falls back to a descendant search when neither the start element nor
 * any ancestor is a widget, which handles selectors that name an outer
 * wrapper. Returns null when no widget is found.
 *
 * Shared source that both `matchScript` and `commitScript` inline into
 * their IIFEs, so a caller that passes a descendant selector like
 * `#q1-listbox` or a `.sr-field__label` class inside the widget resolves
 * to the SAME widget in both places. Without this parity (JOB-281 round
 * two red team MAJOR-1), `matches` would accept the widget while
 * `commit` would fire `input` / `change` on the descendant, and any
 * delegated handler that listens for `event.target === widget` would
 * never see the event; the fallback sibling scope would also be
 * anchored at the descendant's parent rather than at the widget's, so a
 * hidden `<select>` a level up from the descendant could be missed.
 */
function widgetResolverSource(): string {
  return `
    const resolveWidget = (start) => {
      let scope = start;
      for (let depth = 0; depth < 6 && scope; depth++) {
        const r = scope.getAttribute && scope.getAttribute("role");
        if (r === "combobox" || r === "listbox") return scope;
        scope = scope.parentElement;
      }
      if (start && start.querySelector) {
        const nested = start.querySelector('[role="combobox"], [role="listbox"]');
        if (nested) return nested;
      }
      return null;
    };
  `;
}

/**
 * The in page IIFE the SR adapter's `matches` runs. Returns true when the
 * resolved element:
 *
 *   1. Sits inside (or is itself) an ARIA combobox / listbox widget that
 *      exposes at least one `role="option"` descendant. That covers the
 *      structural fingerprint every SR screening dropdown observed in the
 *      spike had in common.
 *   2. Additionally lives inside an `.sr-field` wrapper (or names an
 *      `aria-labelledby` target that itself carries the SR screening label
 *      class). SR's country picker, state picker, autocomplete, and share
 *      widget all satisfy condition 1 on a SR host; without condition 2 the
 *      adapter would fire on those too, which is exactly the false positive
 *      surface the red team flagged. `.sr-field` is what SR wraps every
 *      screening question in on the observed fixtures; if a future recon
 *      finds a tighter discriminator this predicate can narrow further
 *      without touching the callers.
 *
 * Kept structural rather than tied to a specific label string so a copy
 * change by SR does not silently break the adapter.
 */
function matchScript(fieldSelector: string): string {
  return `(() => {
    try {
      ${widgetResolverSource()}
      const sel = ${jsLiteral(fieldSelector)};
      const el = document.querySelector(sel);
      if (!el) return false;
      const widget = resolveWidget(el);
      if (!widget) return false;
      const options = widget.querySelectorAll('[role="option"]');
      if (options.length === 0) return false;
      // Screening question discriminator: an .sr-field wrapper anywhere up
      // the ancestor chain of the widget, OR an aria-labelledby target
      // that itself sits inside a .sr-field. Without this the adapter
      // matches every combobox on smartrecruiters.com (country picker,
      // state picker, autocomplete, share widget).
      const inSrField = widget.closest && widget.closest(".sr-field") !== null;
      let labelInSrField = false;
      const labelledBy = widget.getAttribute && widget.getAttribute("aria-labelledby");
      if (labelledBy) {
        for (const id of labelledBy.split(/\\s+/)) {
          if (!id) continue;
          const labelEl = document.getElementById(id);
          if (labelEl && labelEl.closest && labelEl.closest(".sr-field")) {
            labelInSrField = true;
            break;
          }
        }
      }
      return inSrField || labelInSrField;
    } catch (e) {
      return false;
    }
  })()`;
}

/**
 * The in page IIFE the SR adapter's `commit` runs. Scopes the hidden form
 * control search to the widget's own field group and dispatches `input`
 * then `change` on every control it collected AND on the visible widget
 * itself. Returns a JSON serialisable record of what fired so the outer
 * function can put it in the `detail` field of the `CommitResult`.
 *
 * Widget resolution parity, per the JOB-281 round two red team MAJOR-1
 * finding: the raw element `document.querySelector(sel)` returns is not
 * always the widget itself. When the caller (currently sub ticket E, the
 * `selectDropdown` wiring in `lib/agent/tools.ts`) passes a selector that
 * points at a descendant like `#q1-listbox`, `.sr-field__label`, or a
 * `[role=option]` inside the widget, the raw element is that descendant.
 * The prior revision used the raw element as both the visible control
 * target AND the anchor for the fallback sibling scope, which meant:
 *
 *   - Delegated handlers listening for `event.target === widget` never
 *     saw the `input` / `change` this script dispatched, because the
 *     event fired on the descendant.
 *   - The fallback sibling scope was anchored at the descendant's parent,
 *     so a hidden `<select>` a level up from the descendant could be
 *     missed entirely.
 *
 * The fix resolves the widget the same way `matchScript` does (see
 * `widgetResolverSource`) and uses that widget as both the visible
 * control target and the fallback sibling anchor. When no widget is
 * found, the raw element still serves as anchor, which preserves the
 * prior behavior for callers that happen to pass a non widget selector.
 *
 * Scoping strategy, per the JOB-281 round one red team BLOCKING finding:
 *
 *   Prior revision walked up 6 ancestor levels calling
 *   `querySelectorAll("select" | "input[type=hidden]")` at each level. Once
 *   the walk reached the surrounding `<form>`, those queries returned
 *   every hidden input and every `<select>` in the whole form, and the
 *   loop unconditionally wrote the target value into every hidden input it
 *   collected. That silently overwrote CSRF tokens and answered sibling
 *   screening dropdowns whose options happened to include the same text.
 *
 * The fix scopes the search two ways, in order of preference:
 *
 *   (b) Semantic field group: `anchor.closest('[data-field], .sr-field')`.
 *       When the widget lives inside a wrapper the form author explicitly
 *       marked as one field, that wrapper is the scope. This is the case
 *       on the SR screening pages the adapter targets (`.sr-field` wraps
 *       each question and its hidden native control). `<fieldset>` was in
 *       this list in the round one fix but was removed in round two
 *       (MINOR-1): a `<fieldset>` in real HTML commonly groups many
 *       questions plus form level controls (CSRF, hidden mirrors for
 *       sibling questions), so treating it as a per question wrapper
 *       reopens the exact shape of the original BLOCKING bug on any form
 *       that uses `<fieldset>` at form root rather than per question.
 *       `.sr-field` and `[data-field]` are explicit per question markers
 *       and are safe.
 *   (a) Fallback: the widget's DIRECT parent's DIRECT children only. No
 *       ancestor walk, no descendant queries, no querySelectorAll of any
 *       ancestor subtree. Just the immediate siblings of the widget.
 *
 * Neither branch ever climbs to the surrounding form, so a hidden CSRF
 * input or an unrelated screening dropdown elsewhere in the same form is
 * never touched. If SR ships a screening question outside a `.sr-field`
 * wrapper and the fallback path proves too narrow, the semantic list in
 * (b) is the single place to widen.
 *
 * Note for a later ticket (M-3 in the red team report): direct
 * `node.value = target` plus a native `Event(...)` dispatch is enough to
 * wake plain listeners and Angular's `ngModelChange`, but React controlled
 * inputs check their `_valueTracker` cache and skip `onChange` when the
 * cached value equals the new one. If the orchestrator's live recon later
 * reveals SR ships a react-select or another React controlled dropdown as
 * the hidden control, the workaround is
 * `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
 * .set.call(node, value)` (and the analogous descriptor for `<select>`)
 * before the dispatch. Deliberately not shimmed here because a
 * framework specific shim on a framework the recon has not yet confirmed
 * would only add a maintenance burden.
 */
function commitScript(fieldSelector: string, optionValue: string): string {
  return `(() => {
    ${widgetResolverSource()}
    const sel = ${jsLiteral(fieldSelector)};
    const target = ${jsLiteral(optionValue)};
    const el = document.querySelector(sel);
    if (!el) {
      return { ok: false, reason: "selector did not resolve", fired: [] };
    }
    // Round two MAJOR-1: resolve the widget with the same rule matchScript
    // uses, so a descendant selector (for example an id on the listbox or
    // a class on a label inside the widget) still fires events on the
    // widget and still anchors the fallback sibling scope at the widget's
    // parent rather than the descendant's. When no widget is found the
    // raw element is the anchor, which preserves the prior behavior for
    // non widget callers.
    const widget = resolveWidget(el);
    const anchor = widget || el;
    const controls = [anchor];
    const seen = new Set([anchor]);

    // Option (b): a semantic field group wrapper is the preferred scope.
    // Kept intentionally narrow to explicit per question markers; see the
    // block comment above for why fieldset is deliberately absent from
    // the CSS list.
    const fieldGroup = (anchor.closest && anchor.closest('[data-field], .sr-field')) || null;

    const acceptControl = (node) => {
      if (!node || node === anchor || seen.has(node)) return;
      const tag = node.tagName || "";
      const isSelect = tag === "SELECT";
      const isHiddenInput = tag === "INPUT" && (node.getAttribute && node.getAttribute("type") === "hidden");
      if (!isSelect && !isHiddenInput) return;
      seen.add(node);
      controls.push(node);
      try {
        if (isSelect && node.options) {
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
        } else if (isHiddenInput) {
          node.value = target;
        }
      } catch (e) {
        // Assigning value on a detached or read only control is not the
        // adapter's failure mode to fix; the event dispatch below still
        // runs and the trace records what fired.
      }
    };

    if (fieldGroup) {
      // Scope: the semantic wrapper only. Descendant query is safe here
      // because the wrapper is bounded to one question.
      const found = fieldGroup.querySelectorAll('select, input[type="hidden"]');
      for (const node of found) acceptControl(node);
    } else {
      // Option (a) fallback: the widget's direct parent's direct children.
      // No descendant query, no ancestor walk. Only the widget's
      // immediate siblings can enter the control set.
      const parent = anchor.parentElement;
      if (parent) {
        const kids = parent.children;
        for (let i = 0; i < kids.length; i++) acceptControl(kids[i]);
      }
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
 * JOB-317: shared in page source that resolves the actual `spl-` component
 * host from whatever element a field selector lands on, by feature
 * detecting the component's own commit surface rather than by tag name.
 *
 * Why feature detection. The 2026-08-31 recon against the live OneClick
 * bundle (Wabtec publication, real production JS) decompiled the
 * `spl-multiselect-autocomplete` component JOB-266 fought and found its
 * commit pipeline is a set of public prototype methods:
 *
 *   handleOptionSelect(event)  reads event.detail.value (an option id) and
 *                              event.detail.selected, flips
 *                              selectedOptionsDictionary, then calls
 *                              handleChange(getValue())
 *   handleChange(value)        assigns the reactive `value` property
 *                              (which writes the `__value` backing field
 *                              JOB-266 inspected), runs validate(), and
 *                              dispatches the `spl-change` CustomEvent
 *   markAsTouched()            dispatches the `spl-touched` event
 *
 * Zone.js listener bookkeeping on the same live page shows Angular
 * subscribes to exactly `spl-change` and `spl-touched` on every mounted
 * `spl-` control (own properties named `__zone_symbol__spl-changefalse`
 * and so on, plus `__ngContext__` on the host). So the reactive form
 * validator that blocks submit with "Value is required" is fed by the
 * event this pipeline dispatches, and calling the pipeline directly is the
 * layer ABOVE the click plumbing that all six JOB-266 mechanisms (and both
 * pivot spike models) failed to penetrate from below.
 *
 * Tag names are minified build artifacts and component variants exist
 * (`spl-select`, `spl-checkbox` share the same base class), so the
 * resolver asks each candidate whether it exposes the commit surface
 * instead of matching names: `handleOptionSelect` plus `updateSelection`
 * marks the multiselect shape, `handleChange` plus `emitChangeEvent`
 * marks the base field shape. That is the per instance decision this
 * ticket exists to make.
 */
function splHostResolverSource(): string {
  return `
    const isMultiselectHost = (n) => !!n && typeof n.handleOptionSelect === "function" && typeof n.updateSelection === "function";
    const isBaseFieldHost = (n) => !!n && typeof n.handleChange === "function" && typeof n.emitChangeEvent === "function";
    const isSplHost = (n) => isMultiselectHost(n) || isBaseFieldHost(n);
    const resolveSplHost = (start) => {
      let scope = start;
      for (let depth = 0; depth < 8 && scope; depth++) {
        if (isSplHost(scope)) return scope;
        scope = scope.parentElement;
      }
      if (start && start.querySelectorAll) {
        const all = start.querySelectorAll("*");
        const budget = Math.min(all.length, 400);
        for (let i = 0; i < budget; i++) {
          const n = all[i];
          if (n.tagName && n.tagName.indexOf("-") >= 0 && isSplHost(n)) return n;
        }
      }
      return null;
    };
  `;
}

function splMatchScript(fieldSelector: string): string {
  return `(() => {
    try {
      ${splHostResolverSource()}
      const sel = ${jsLiteral(fieldSelector)};
      const el = document.querySelector(sel);
      if (!el) return false;
      return resolveSplHost(el) !== null;
    } catch (e) {
      return false;
    }
  })()`;
}

/**
 * The in page IIFE the spl state adapter's `commit` runs. Probes THIS
 * widget instance, picks the commit path its shape supports, applies it,
 * and reads the widget's own reactive state back so the caller gets a
 * verified yes or no rather than a hopeful event dispatch.
 *
 * Multiselect shape, in order:
 *
 *   1. Find the option whose label or value equals the target (trimmed,
 *      case insensitive) across every option store the instance exposes:
 *      `options`, `optionsDictionary`, `_optionsToRender`, and
 *      `dynamicOptions`. The instance decides which of those are
 *      populated; the adapter does not assume.
 *   2. If none match and the instance allows custom values and carries an
 *      `optionFactory`, build the option through the factory. This is the
 *      component's own custom value path, not an invention: the factory is
 *      supplied by SR's Angular wrapper and is what a typed in custom
 *      value goes through on a real interaction.
 *   3. Seed `optionsDictionary[id]` when absent. The live recon showed
 *      `getValue()` maps selected ids through `optionsDictionary`, and an
 *      option the dropdown never rendered may not be registered there yet;
 *      without the seed the commit computes an empty value and the
 *      component's own value watcher then wipes the selection.
 *   4. Call `handleOptionSelect` with a CustomEvent shaped exactly like
 *      the one the component's own option rows dispatch:
 *      `detail: { value: optionId, selected: false }` (`selected` is the
 *      option's state BEFORE the interaction, so `false` means select).
 *   5. `markAsTouched()` when exposed, mirroring the blur a real
 *      interaction ends with, so touched gated validators run.
 *
 * Base field shape (single selects, checkboxes, anything on the shared
 * form field base class): `handleChange(target)` then `markAsTouched()`.
 *
 * Never invents a value: the only value that can land is the target the
 * caller chose, and when no option store entry (and no custom value
 * factory) matches it, the script reports failure with what it searched
 * rather than picking something close. HARD STOP 9 applies to widget
 * plumbing too.
 *
 * Verification: `handleChange` assigns `value` synchronously, so the
 * script reads `host.value` right after the call and reports whether the
 * target (or the matched option's value) is present. That readback is the
 * `stateVerified` field on the CommitResult.
 */
function splCommitScript(fieldSelector: string, optionValue: string): string {
  return `(() => {
    ${splHostResolverSource()}
    const sel = ${jsLiteral(fieldSelector)};
    const target = ${jsLiteral(optionValue)};
    const el = document.querySelector(sel);
    if (!el) {
      return { ok: false, reason: "selector did not resolve", stateVerified: false };
    }
    const host = resolveSplHost(el);
    if (!host) {
      return { ok: false, reason: "no spl component host found", stateVerified: false };
    }
    const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();
    const safeJson = (v) => {
      try {
        const s = JSON.stringify(v);
        return s === undefined ? "undefined" : s;
      } catch (e) {
        return "[unserializable]";
      }
    };
    const zoneEvents = [];
    try {
      for (const p of Object.getOwnPropertyNames(host)) {
        const m = p.match(/^__zone_symbol__(.+?)(?:true|false)$/);
        if (m) zoneEvents.push(m[1]);
      }
    } catch (e) {}
    const probe = {
      tag: host.tagName ? host.tagName.toLowerCase() : "unknown",
      shape: isMultiselectHost(host) ? "multiselect" : "baseField",
      ngContext: "__ngContext__" in host,
      zoneEvents: zoneEvents,
    };
    const before = safeJson(host.value);
    const valueContains = (v) => {
      const current = host.value;
      if (Array.isArray(current)) return current.some((x) => norm(x) === norm(v));
      return norm(current) === norm(v);
    };
    let path = "";
    let reason = "";
    let matched = null;
    try {
      if (probe.shape === "multiselect") {
        const stores = [];
        if (Array.isArray(host.options)) stores.push(["options", host.options]);
        if (host.optionsDictionary && typeof host.optionsDictionary === "object") {
          stores.push(["optionsDictionary", Object.values(host.optionsDictionary)]);
        }
        if (Array.isArray(host._optionsToRender)) stores.push(["_optionsToRender", host._optionsToRender]);
        if (Array.isArray(host.dynamicOptions)) stores.push(["dynamicOptions", host.dynamicOptions]);
        const searched = [];
        for (const [storeName, entries] of stores) {
          searched.push(storeName + "(" + entries.length + ")");
          for (const opt of entries) {
            if (!opt) continue;
            if (norm(opt.label) === norm(target) || norm(opt.value) === norm(target)) {
              matched = opt;
              path = "handleOptionSelect via " + storeName;
              break;
            }
          }
          if (matched) break;
        }
        if (!matched && host.allowCustomValues && typeof host.optionFactory === "function") {
          try {
            const custom = host.optionFactory(target);
            if (custom && (custom.id !== undefined || custom.label !== undefined)) {
              matched = custom;
              path = "handleOptionSelect via optionFactory custom value";
            }
          } catch (e) {
            reason = "optionFactory threw: " + String(e && e.message ? e.message : e);
          }
        }
        if (!matched) {
          return {
            ok: false,
            stateVerified: false,
            probe: probe,
            before: before,
            reason: reason || ("no option matched the target across " + (searched.join(", ") || "no populated option stores")),
          };
        }
        if (matched.id === undefined || matched.id === null) {
          // The option factory contract allows a label only option with no
          // id. The dictionary keyed pipeline cannot address that, so use
          // the component's value array path instead: handleChange assigns
          // the reactive value, validates, and emits, and the component's
          // own value watcher re derives the tags.
          const nextValue = Array.isArray(host.value) ? host.value.slice() : [];
          const v = matched.value !== undefined ? matched.value : target;
          if (!nextValue.some((x) => norm(x) === norm(v))) nextValue.push(v);
          path = path + " then handleChange with value array (option had no id)";
          host.handleChange(nextValue);
        } else {
          if (!host.optionsDictionary || typeof host.optionsDictionary !== "object") {
            host.optionsDictionary = {};
          }
          if (!host.optionsDictionary[matched.id]) {
            host.optionsDictionary[matched.id] = matched;
          }
          const alreadySelected =
            !!host.selectedOptionsDictionary && host.selectedOptionsDictionary[matched.id] === true;
          if (!alreadySelected) {
            host.handleOptionSelect(
              new CustomEvent("agent-state-commit", {
                detail: { value: matched.id, selected: false },
              })
            );
          } else {
            path = path + " (already selected)";
          }
        }
      } else {
        path = "handleChange";
        host.handleChange(target);
      }
      if (typeof host.markAsTouched === "function") {
        try { host.markAsTouched(); } catch (e) {}
      }
    } catch (e) {
      return {
        ok: false,
        stateVerified: false,
        probe: probe,
        before: before,
        reason: "commit path threw: " + String(e && e.message ? e.message : e),
      };
    }
    const verified =
      valueContains(target) || (matched !== null && valueContains(matched.value));
    return {
      ok: true,
      stateVerified: verified,
      probe: probe,
      path: path,
      before: before,
      after: safeJson(host.value),
    };
  })()`;
}

interface SplCommitScriptResult {
  ok: boolean;
  stateVerified: boolean;
  reason?: string;
  path?: string;
  before?: string;
  after?: string;
  probe?: {
    tag?: string;
    shape?: string;
    ngContext?: boolean;
    zoneEvents?: string[];
  };
}

function coerceSplCommitScriptResult(
  value: unknown
): SplCommitScriptResult | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    ok: record.ok === true,
    stateVerified: record.stateVerified === true,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    path: typeof record.path === "string" ? record.path : undefined,
    before: typeof record.before === "string" ? record.before : undefined,
    after: typeof record.after === "string" ? record.after : undefined,
    probe:
      typeof record.probe === "object" && record.probe !== null
        ? (record.probe as SplCommitScriptResult["probe"])
        : undefined,
  };
}

function describeProbe(probe: SplCommitScriptResult["probe"]): string {
  if (!probe) return "no probe data";
  const zone =
    probe.zoneEvents && probe.zoneEvents.length > 0
      ? probe.zoneEvents.join("+")
      : "none";
  return `${probe.tag ?? "unknown"} shape=${probe.shape ?? "unknown"} ngContext=${
    probe.ngContext === true
  } zoneListeners=${zone}`;
}

/**
 * JOB-317: the second SR adapter. Commits a screening dropdown by driving
 * the `spl-` component's own public commit pipeline (see the block comment
 * on `splHostResolverSource` for the decompiled pipeline and the live
 * evidence) instead of dispatching events at the click plumbing below it.
 *
 * Registered AHEAD of `SRScreeningDropdownAdapter` because its `matches`
 * is strictly narrower: it requires an actual component instance exposing
 * the commit surface, which no plain ARIA fixture and no non SR widget
 * satisfies. When the state paths fail on a matched instance, `commit`
 * falls back to the JOB-281 event dispatch adapter so the production
 * behavior that shipped before this ticket is preserved on exactly the
 * inputs it used to receive.
 */
export class SRSplStateCommitAdapter implements WidgetAdapter {
  readonly name = "SRSplStateCommitAdapter";

  async matches(page: unknown, fieldSelector: string): Promise<boolean> {
    if (!isPageLike(page)) return false;
    const url = await readPageUrl(page);
    if (!isSmartRecruitersUrl(url)) return false;
    try {
      const result = await page.evaluate(splMatchScript(fieldSelector));
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
        stateVerified: false,
      };
    }
    let parsed: SplCommitScriptResult | null = null;
    let failureDetail: string;
    try {
      const raw = await page.evaluate(
        splCommitScript(fieldSelector, optionValue)
      );
      parsed = coerceSplCommitScriptResult(raw);
      if (parsed && parsed.ok) {
        return {
          status: "committed",
          adapterName: this.name,
          stateVerified: parsed.stateVerified,
          detail:
            `${parsed.path ?? "unknown path"}; ${describeProbe(parsed.probe)}; ` +
            `value before=${parsed.before ?? "?"} after=${parsed.after ?? "?"}; ` +
            `stateVerified=${parsed.stateVerified}`,
        };
      }
      failureDetail = parsed
        ? `${parsed.reason ?? "state commit reported failure"}; ${describeProbe(parsed.probe)}`
        : "commit script returned an unexpected shape";
    } catch (error) {
      failureDetail = error instanceof Error ? error.message : String(error);
    }
    // The state paths could not commit this instance. Fall back to the
    // JOB-281 event dispatch adapter so a widget this adapter matched but
    // could not drive still gets the behavior production shipped before
    // this ticket, and record both halves in the detail so the trace
    // shows exactly what was tried.
    const fallback = await new SRScreeningDropdownAdapter().commit(
      page,
      fieldSelector,
      optionValue
    );
    return {
      status: fallback.status,
      adapterName: this.name,
      stateVerified: false,
      detail:
        `state commit failed (${failureDetail}); ` +
        `fell back to event dispatch: ${fallback.detail ?? "no detail"}`,
    };
  }
}

/**
 * The registered adapters, in the order the registry consults them. Kept
 * as a factory rather than a constant so tests can instantiate a fresh
 * adapter per call and so a future ticket can plug a config or a runtime
 * override in without churning every call site.
 *
 * JOB-317 ordering: the state commit adapter runs first because its match
 * is strictly narrower (a real component instance exposing the commit
 * surface); the JOB-281 event dispatch adapter keeps serving every ARIA
 * shaped widget the narrower match declines, unchanged.
 */
export function getRegisteredAdapters(): readonly WidgetAdapter[] {
  return [new SRSplStateCommitAdapter(), new SRScreeningDropdownAdapter()];
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
