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
 * current commit script instead scopes to explicit per question wrappers
 * (`[data-field]` or `.sr-field`) with a fallback to the widget's direct
 * parent's direct children only; see the block comment above `commitScript`
 * below for the exact rules and for why `<fieldset>` is deliberately not
 * in that list.
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
function jsLiteral(value: string): string {
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
 *
 * The descendant fallback requires EXACTLY ONE widget match (JOB-293
 * MINOR-1 follow up). Prior revision returned the first match from
 * `querySelector`, so a caller that passed an outer wrapper selector
 * naming two sibling comboboxes (for example an `.sr-field-group`
 * containing two screening questions) would silently pick one at random
 * and dispatch events on the wrong screening question. The new rule
 * collects every match under the start element and returns the sole
 * element only when there is exactly one; on ambiguity the resolver
 * returns null, which lets `commit` surface `adapter_failed` instead
 * of quietly writing to an arbitrary widget. Every current caller
 * (see `selectDropdown` in `lib/agent/tools.ts`) passes a per field
 * selector where at most one widget is in scope, so the tightened
 * rule keeps the single widget case working and only fires on the
 * ambiguous case no caller is meant to hit.
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
      if (start && start.querySelectorAll) {
        const nested = start.querySelectorAll('[role="combobox"], [role="listbox"]');
        if (nested.length === 1) return nested[0];
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
    // parent rather than the descendant's.
    //
    // JOB-293 MINOR-1 follow up: when the selector names an outer wrapper
    // that contains more than one widget, or names something with no
    // widget at all, resolveWidget returns null. Fail closed here rather
    // than falling back to the raw element as anchor: firing events on a
    // wrapper and blindly writing to whatever hidden controls happen to
    // sit under it is exactly the arbitrary widget shape the ticket
    // exists to prevent. The caller sees adapter_failed and the visible
    // click path stays in charge.
    const widget = resolveWidget(el);
    if (!widget) {
      return { ok: false, reason: "no unique widget resolved from selector", fired: [] };
    }
    const anchor = widget;
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
