import { expect, test } from "@playwright/test";

/**
 * Scaffolding (JOB-001). One spec, so that the conditional e2e job in CI has
 * something to run: Playwright exits non zero when it finds no tests at all,
 * which would make the job red on the first PR that triggers it.
 *
 * Replace or extend this once there is a real page worth driving.
 */
test("the app serves its home page", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(400);
  await expect(page.locator("body")).toBeVisible();
});
