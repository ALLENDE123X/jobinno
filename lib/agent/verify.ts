/**
 * JOB-283 (sub ticket F of #276): pre submit verification reads SR's own
 * validation state.
 *
 * The pre submit pass has two halves. The first is the readback diff from
 * sub ticket B, which confirms every field the agent filled against the
 * fact catalog. The second, implemented here, decides whether the form
 * itself considers itself valid. JOB-SPIKE v7 and v8b both had the agent
 * report success and pass the readback while SR was tracking required
 * fields at the Angular form control layer rather than as native HTML
 * required attributes on the inputs. The native `.required` scan saw no
 * unfilled inputs, cleared the run to click submit, and SR blocked the
 * submission, failing the run after the fact. This module makes verify
 * authoritative by reading the markers SR's own post validation DOM pass
 * renders, not the native attribute list.
 *
 * What this module deliberately is not. It is not the submit click: the
 * real submit button stays behind the agent loop's post verify path, and
 * nothing here navigates or submits. It is not a generic form validation
 * pass: the marker vocabulary is SR OneClick specific, and Breezy or
 * Greenhouse error markers layer in through later sub tickets once a real
 * failure mode proves they need them. It is not a widget adapter change;
 * sub ticket D owns those.
 *
 * Why the interface is minimal. This logic needs five facts from the page:
 * the url, a way to coax SR's validators into running, a way to wait for
 * them to render, a scan of the resulting error markers, and a captcha
 * check. None of those require a Playwright import to express, and pulling
 * Stagehand or Playwright into this module would drag the whole browser
 * stack into every test that only exercises verify. So the dependencies
 * are injected as `PreSubmitVerifyPage`, the same minimal interface
 * pattern `readback.ts` establishes with `AgentSnapshotSource`. Sub ticket
 * E implements this interface over a real Stagehand page; the tests in
 * this ticket hand in fixtures that answer the five calls from plain
 * arrays.
 *
 * Why the marker scan lives in the injected page. The concrete markers SR
 * renders are a fixture discovery problem, not a code problem: `[image:
 * Error]` icons in the a11y tree, `StaticText: "Value is required"` rows
 * next to the offending field, a `.error-message` node, an
 * `aria-invalid="true"` attribute, or a combination depending on the
 * OneClick variant (Bertelsmann, Vodafone, DHL). On the day a variant
 * renders a marker this file does not enumerate, finding it belongs to
 * the E adapter, which owns every selector string. This module owns only
 * the orchestration: read the candidate markers the adapter surfaced and
 * turn them into a verdict.
 *
 * Why the shape uses a status enum rather than `ok: boolean`. The
 * scaffold returned `{ ok: true }` or `{ ok: false; reason }`. A boolean
 * cannot express the three outcomes a submit guard actually has: cleared
 * to submit, blocked by field errors the agent loop can fix on its next
 * turn, or blocked by a captcha the agent cannot fix by refilling. Tagging
 * the union on `status` keeps each outcome's payload attached to the
 * outcome that produced it, and a `switch` on `status` in the agent loop
 * cannot forget the `captcha_blocked` arm the way an `if (ok)` boolean
 * check can.
 */

/**
 * The default milliseconds `preSubmitVerify` waits after the probe for
 * SR's async validators to render their markers. SR's Angular validation
 * is event driven, not synchronous: a marker scan before the render window
 * is empty by definition and would clear a form that is about to fail. The
 * constant is exported so sub ticket E and the agent loop can read the
 * module's own default instead of duplicating the number.
 */
export const PRE_SUBMIT_VERIFY_DEFAULT_WAIT_MS = 500;

/**
 * One structured field error the verification pass returns. Structured for
 * the agent loop's next turn feedback:
 *
 *  - `fieldSelector` addresses the field for a retry that sets its value.
 *    It maps back to the snapshot the B module builds: the `FieldNode.ref`
 *    the readback parser assigned when the E adapter can map the marker
 *    element to the matching a11y node, or a CSS selector the adapter
 *    synthesizes when it cannot.
 *  - `siblingLabel` is the visible label text sitting next to the errored
 *    field, so the LLM can point at the field by sight.
 *  - `errorText` is the message SR rendered, such as `Value is required`.
 */
export type VerifyError = {
  fieldSelector: string;
  siblingLabel: string;
  errorText: string;
};

/**
 * The verdict of the pre submit verification pass. A discriminated union
 * so each outcome carries exactly its own payload:
 *
 *  - `pass` means the marker scan came back empty and the run is cleared
 *    to click the real submit button.
 *  - `fail` means at least one SR error marker is present; the agent loop
 *    feeds `errors` into its next turn's prompt and retries the marked
 *    fields rather than submitting.
 *  - `captcha_blocked` means a captcha widget is on the page. This is not
 *    a field state the agent can fix by refilling, so it gets its own arm
 *    and never folds into `pass`.
 */
export type VerifyResult =
  | { status: "pass" }
  | { status: "fail"; errors: VerifyError[] }
  | { status: "captcha_blocked" };

/**
 * One raw marker the page adapter surfaced. `preSubmitVerify` scans these
 * before building a `fail` verdict, collapsing duplicates so the error
 * list the agent loop consumes has one row per field. The shape matches
 * `VerifyError` so the E adapter can return its own rows unchanged; the
 * module copies them into plain result objects (see `dedupeMarkers`) so
 * the outgoing list is JSON serializable by construction.
 */
export interface ErrorMarkerCandidate {
  fieldSelector: string;
  siblingLabel: string;
  errorText: string;
}

/**
 * Overrides for one verification pass.
 *
 *  - `probeWaitMs` replaces the default wait after the probe. Tests pass
 *    0 to skip the real sleep; production keeps the default because SR's
 *    markers only render after the async validation pass runs.
 */
export interface PreSubmitVerifyOptions {
  probeWaitMs?: number;
}

/**
 * The read only surface the verification pass needs from the page. Minimal
 * by design, and deliberately free of Stagehand or Playwright types, so
 * the tests in this ticket pass fixtures directly and the eventual E
 * adapter implements the same five methods over a real Playwright page.
 *
 *  - `url` reads the current address. The module does not call it during
 *    the probe, so a fixture that changes its url when a real submit fires
 *    can prove the pass never navigated (the probe must not submit).
 *  - `probeValidation` does the single blur and focus cycle over every
 *    field, whatever the E adapter needs to surface SR's error markers.
 *    Called exactly once.
 *  - `waitForValidation` sleeps long enough for SR's async validators to
 *    render their markers after the probe.
 *  - `scanErrorMarkers` returns every SR error marker currently in the
 *    DOM.
 *  - `detectCaptcha` answers whether a captcha widget is rendered. SR
 *    throws a Cloudflare Turnstile or hCaptcha iframe when a session is
 *    flagged; the adapter looks for a turnstile or hcaptcha iframe, or a
 *    reCAPTCHA marker, the same way the a11y tree names them.
 */
export interface PreSubmitVerifyPage {
  url: () => string | Promise<string>;
  probeValidation: () => void | Promise<void>;
  waitForValidation: (ms: number) => void | Promise<void>;
  scanErrorMarkers: () =>
    | ErrorMarkerCandidate[]
    | Promise<ErrorMarkerCandidate[]>;
  detectCaptcha: () => boolean | Promise<boolean>;
}

/**
 * Run the pre submit verification pass. Returns the verdict and, on a
 * `fail`, the structured error list for the agent loop's next turn.
 *
 * Order of operations:
 *
 *  1. A captcha check before anything else. A captcha already on the page
 *     means no probe should run at all: there is nothing to validate, and
 *     blurring every field on a flagged session is wasted motion.
 *  2. The single probe pass, which the E adapter implements as a blur and
 *     focus cycle over every field.
 *  3. The wait for SR's async validators to render. The default is
 *     `PRE_SUBMIT_VERIFY_DEFAULT_WAIT_MS`.
 *  4. A second captcha check, because the probe can surface a captcha: SR
 *     flags some sessions only after interaction.
 *  5. The marker scan. Empty means `pass`; otherwise `fail` with one
 *     deduplicated error entry per field.
 *
 * The function never clicks the real submit button and never navigates,
 * which the tests assert by handing in a fixture whose url would change on
 * a submit click and proving it does not.
 */
export async function preSubmitVerify(
  page: PreSubmitVerifyPage,
  options: PreSubmitVerifyOptions = {}
): Promise<VerifyResult> {
  const probeWaitMs =
    options.probeWaitMs ?? PRE_SUBMIT_VERIFY_DEFAULT_WAIT_MS;

  if (await page.detectCaptcha()) {
    return { status: "captcha_blocked" };
  }

  await page.probeValidation();

  await page.waitForValidation(probeWaitMs);

  if (await page.detectCaptcha()) {
    return { status: "captcha_blocked" };
  }

  const markers = await page.scanErrorMarkers();
  if (markers.length === 0) {
    return { status: "pass" };
  }

  return { status: "fail", errors: dedupeMarkers(markers) };
}

/**
 * Collapse the raw marker list to one entry per field. SR renders more
 * than one marker for the same unfilled field (the `StaticText: "Value is
 * required"` row and the `[image: Error]` icon both point at the same
 * input), so a naive scan would hand the agent loop duplicate rows for one
 * field. Keep the first row the adapter returned, which in practice is the
 * informative message rather than the bare icon. Returns fresh plain
 * objects, so every entry in the outgoing list is JSON serializable even
 * if a future adapter hands back a rich marker instance.
 */
function dedupeMarkers(markers: ErrorMarkerCandidate[]): VerifyError[] {
  const seen = new Set<string>();
  const out: VerifyError[] = [];
  for (const marker of markers) {
    if (seen.has(marker.fieldSelector)) continue;
    seen.add(marker.fieldSelector);
    out.push({
      fieldSelector: marker.fieldSelector,
      siblingLabel: marker.siblingLabel,
      errorText: marker.errorText,
    });
  }
  return out;
}