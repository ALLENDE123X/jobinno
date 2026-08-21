import { expect, test } from "@playwright/test";

/**
 * Started as JOB-001 scaffolding, extended by JOB-016 now that there is a real
 * page to drive.
 *
 * The pricing assertion is the one worth having. Those three numbers are the
 * actual commercial terms, they are duplicated in the page rather than read
 * from anywhere, and a wrong one on a public page is a promise we did not mean
 * to make. Everything else here is a smoke check.
 *
 * ── JOB-031 ───────────────────────────────────────────────────────────────
 * Both tests below assert on `app/page.tsx`, and while the waitlist gate is
 * active every request to `/` is rewritten to the waitlist page instead —
 * that is the gate working correctly, not a regression in either test. They
 * stay in the file rather than being deleted because the marketing page
 * itself is untouched and both assertions are exactly right again the moment
 * `lib/waitlist-gate.ts`'s gate is reverted; deleting them now would just
 * mean rewriting them from scratch later. `test.skip` records why, in the one
 * place someone reverting the gate would already be looking.
 */
test.skip(
  "the app serves its home page",
  async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBeLessThan(400);
    await expect(
      page.getByRole("heading", { level: 1, name: "You sleep. AI applies." })
    ).toBeVisible();
  }
);

test.skip(
  "the landing page states the three real plans",
  async ({ page }) => {
    await page.goto("/#pricing");

    await expect(page.getByText("$0", { exact: true })).toBeVisible();
    await expect(page.getByText("10 applications, total")).toBeVisible();

    await expect(page.getByText("$29", { exact: true })).toBeVisible();
    await expect(page.getByText("150 applications every month")).toBeVisible();

    await expect(page.getByText("$99", { exact: true })).toBeVisible();
    await expect(
      page.getByText("500 applications, valid 6 months")
    ).toBeVisible();
  }
);

/**
 * JOB-031's gate, from the outside — the counterpart to the two skipped tests
 * above. Same reasoning as `the dashboard sends a signed out visitor to sign
 * in` below: checked from a real browser hitting the real routes, not by
 * reading the middleware source.
 */
test("the waitlist gate serves the waitlist at / and redirects everything else there", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "An AI agent that applies to jobs for you." })
  ).toBeVisible();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "An AI agent that applies to jobs for you." })
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

/**
 * JOB-009. The dashboard's gate, from the outside.
 *
 * The page checks the session itself rather than leaving it to middleware, and
 * this is the assertion that says so from a browser with no cookies. A
 * dashboard that renders for a signed out visitor would be a dashboard that
 * renders somebody's application history to a stranger.
 *
 * The timeout is raised deliberately. CI points the app at a Supabase URL with
 * nothing behind it, so `getUser()` spends its retry budget before answering
 * that there is no session, and the answer is still the right one.
 *
 * JOB-031: skipped for the same reason as the two tests above — while the
 * waitlist gate is active `/dashboard` redirects to `/`, not `/login`, which
 * the gate test above already covers. This is exactly right again once the
 * gate is reverted.
 */
test.skip(
  "the dashboard sends a signed out visitor to sign in",
  async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText("Sign in to Jobinno")).toBeVisible();
  }
);
