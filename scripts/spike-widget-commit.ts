/**
 * JOB-317. Headed reproduction of the SmartRecruiters spl-multiselect
 * state commit against the REAL production OneClick bundle, replayable on
 * demand. This is the widget commit half of the ticket's live verify:
 * it proves the SRSplStateCommitAdapter's commit pipeline moves the exact
 * internals (`__value`, `tags`, `selectedOptionsDictionary`) that JOB-266
 * found frozen after six event level mechanisms, and that the `spl-change`
 * CustomEvent Angular subscribes to fires with the committed value.
 *
 * What it does:
 *
 *   1. Opens a real Chromium (headed by default; DataDome fronts
 *      jobs.smartrecruiters.com and blocks plain HTTP clients, so a real
 *      browser is the only way to load the production bundle).
 *   2. Navigates to a public OneClick posting page. No form is filled and
 *      nothing is submitted; the page is only a vehicle for the bundle,
 *      which defines the spl-multiselect-autocomplete custom element.
 *   3. Mounts a probe instance of that real component, off screen, with a
 *      Bertelsmann shaped option list and the optionFactory SR's own
 *      Angular wrapper supplies on a real screening step.
 *   4. Runs the shipped adapter (`commitFrameworkState`, the same entry
 *      `selectDropdown` calls) against the probe and prints the
 *      CommitResult plus the component's own state readback.
 *
 * What it deliberately does not do: reach the real screening step of a
 * real posting. That page sits behind step one of a real application,
 * which means submitting a real person's data to a real employer; that
 * live verify belongs to the orchestrator's batch run, not to a spike
 * script. See the PR body's Live-verify section for what was and was not
 * proven.
 *
 * Run: npx tsx scripts/spike-widget-commit.ts [--url <oneclick-url>] [--headless]
 */

import { chromium } from "@playwright/test";

import { commitFrameworkState } from "../lib/agent/widget-adapters";

const DEFAULT_URL =
  "https://jobs.smartrecruiters.com/oneclick-ui/company/Wabtec/publication/122f678a-4e7b-485c-9b91-4fe957e91391?dcr_ci=Wabtec";

const PROBE_ID = "agent-spike-probe";

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const url = argValue("--url") ?? DEFAULT_URL;
  const headless = process.argv.includes("--headless");

  console.log(`[spike] launching chromium (headless=${headless})`);
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();
  try {
    console.log(`[spike] navigating to ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const defined = await page
      .waitForFunction(
        () => customElements.get("spl-multiselect-autocomplete") !== undefined,
        undefined,
        { timeout: 30_000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!defined) {
      const title = await page.title();
      throw new Error(
        `spl-multiselect-autocomplete never became defined. Page title was ` +
          `"${title}". A DataDome challenge page or a non OneClick posting ` +
          `both look like this; try another posting URL.`
      );
    }
    console.log("[spike] production bundle loaded, component defined");

    await page.evaluate(
      `(() => {
        const opts = [
          { id: "o1", value: "United States", label: "United States" },
          { id: "o2", value: "Germany", label: "Germany" },
          { id: "o3", value: "Open to all locations", label: "Open to all locations" },
        ];
        const host = document.createElement("spl-multiselect-autocomplete");
        host.id = ${JSON.stringify(PROBE_ID)};
        host.setAttribute("style", "position:fixed;left:-9999px;top:0");
        host.options = opts;
        host.name = "agent_spike";
        host.optionFactory = (v) =>
          opts.find((o) => o.value === v) || { id: "custom_" + String(v), value: v, label: String(v) };
        window.__spikeChanges = [];
        host.addEventListener("spl-change", (ev) => {
          window.__spikeChanges.push({ type: ev.type, value: ev.detail && ev.detail.value });
        });
        document.body.appendChild(host);
      })()`
    );
    // Give Lit a beat to run the connected lifecycle before committing.
    await page.waitForTimeout(300);

    const result = await commitFrameworkState(
      page,
      `#${PROBE_ID}`,
      "Open to all locations"
    );
    console.log("[spike] CommitResult:", JSON.stringify(result, null, 2));

    await page.waitForTimeout(300);
    const readback = await page.evaluate(
      `(() => {
        const host = document.getElementById(${JSON.stringify(PROBE_ID)});
        return {
          value: host.value,
          internalValue: host.__value,
          tags: (host.tags || []).map((t) => t.label),
          selectedOptionsDictionary: host.selectedOptionsDictionary,
          splChangeEvents: window.__spikeChanges,
        };
      })()`
    );
    console.log("[spike] component state readback:", JSON.stringify(readback, null, 2));

    const record = readback as {
      internalValue?: unknown;
      splChangeEvents?: unknown[];
    };
    const committed =
      Array.isArray(record.internalValue) &&
      record.internalValue.includes("Open to all locations") &&
      Array.isArray(record.splChangeEvents) &&
      record.splChangeEvents.length > 0;
    if (committed && result.status === "committed" && result.stateVerified) {
      console.log(
        "[spike] VERDICT: state commit landed. __value holds the option, " +
          "spl-change fired, adapter reported stateVerified=true."
      );
    } else {
      console.log(
        "[spike] VERDICT: state commit DID NOT land as expected; read the " +
          "CommitResult detail and the readback above."
      );
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("[spike] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
