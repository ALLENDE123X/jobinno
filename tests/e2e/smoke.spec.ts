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
 * ── JOB-031 / JOB-032 ────────────────────────────────────────────────────────
 * JOB-031 first gated the site by rewriting every request to `/` to a
 * separate, much shorter waitlist page, which made the two tests below false:
 * `app/page.tsx` was unreachable. They were skipped rather than deleted
 * because the marketing page itself was untouched underneath, and JOB-032
 * proves that out: it folded the waitlist form into the top of `app/page.tsx`
 * instead of rewriting away from it, so `/` renders this file directly again
 * and both assertions are back to being exactly right, unskipped below.
 */
test(
  "the app serves its home page",
  async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBeLessThan(400);
    await expect(
      page.getByRole("heading", { level: 1, name: "You sleep. AI applies." })
    ).toBeVisible();
  }
);

test(
  "the landing page states the three real plans",
  async ({ page }) => {
    await page.goto("/#pricing");

    await expect(page.getByText("$0", { exact: true })).toBeVisible();
    await expect(page.getByText("3 applications, total")).toBeVisible();

    await expect(page.getByText("$29", { exact: true })).toBeVisible();
    await expect(page.getByText("150 applications every month")).toBeVisible();

    await expect(page.getByText("$99", { exact: true })).toBeVisible();
    await expect(
      page.getByText("500 applications, valid 6 months")
    ).toBeVisible();
  }
);

/**
 * JOB-031's gate, from the outside, updated for JOB-032's redesign — checked
 * from a real browser hitting the real routes, not by reading the middleware
 * source. `/` now renders the real landing page with the waitlist form added
 * at the top rather than a separate page replacing it entirely, so this
 * checks for both: the new banner, and that the original page underneath is
 * still exactly what it was. `/dashboard` still redirects to `/`, same as
 * before, and lands on that same combined page.
 */
test("the waitlist gate adds the waitlist form to / and redirects everything else there", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "Join the waitlist" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "You sleep. AI applies." })
  ).toBeVisible();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "Join the waitlist" })
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
