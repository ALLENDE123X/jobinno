import { expect, test } from "@playwright/test";

/**
 * Started as JOB-001 scaffolding, extended by JOB-016 now that there is a real
 * page to drive.
 *
 * The pricing assertion is the one worth having. Those three numbers are the
 * actual commercial terms, they are duplicated in the page rather than read
 * from anywhere, and a wrong one on a public page is a promise we did not mean
 * to make. Everything else here is a smoke check.
 */
test("the app serves its home page", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(400);
  await expect(
    page.getByRole("heading", { level: 1, name: "You sleep. It applies." })
  ).toBeVisible();
});

test("the landing page states the three real plans", async ({ page }) => {
  await page.goto("/#pricing");

  await expect(page.getByText("$0", { exact: true })).toBeVisible();
  await expect(page.getByText("10 applications, total")).toBeVisible();

  await expect(page.getByText("$29", { exact: true })).toBeVisible();
  await expect(page.getByText("150 applications every month")).toBeVisible();

  await expect(page.getByText("$99", { exact: true })).toBeVisible();
  await expect(
    page.getByText("500 applications, valid 6 months")
  ).toBeVisible();
});

test("the feedback widget is reachable from the page", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Send feedback" }).click();

  await expect(
    page.getByRole("heading", { name: "Tell us what you found" })
  ).toBeVisible();
  await expect(page.getByLabel("What happened")).toBeVisible();
});
