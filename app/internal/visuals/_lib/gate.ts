/**
 * JOB-365. The only thing standing between these 15 mock pages and the live
 * product surface. Every one of them renders fabricated data meant for a
 * screenshot, never for a real visitor, so `[slug]/page.tsx` calls
 * `assertMockPagesAllowed()` before it renders anything.
 *
 * Two ways in, matching the ticket's own wording exactly:
 *
 *   1. `NEXT_PUBLIC_ALLOW_MOCK_PAGES=1` in the environment. This is what
 *      `scripts/capture-visuals.ts` sets on the dev server it spawns, and
 *      it is the only thing a local `npm run dev` needs to preview a page
 *      by hand.
 *   2. An `Authorization` header matching `INTERNAL_VISUALS_AUTH_TOKEN`.
 *      Kept as an env var rather than a literal string baked into source so
 *      a token never sits in git history; unset (the default) simply means
 *      this path can never match, which is the safe default in production
 *      until someone deliberately provisions one.
 *
 * Neither one is on by default, so a production deploy with nothing set
 * 404s on every one of these routes, which `notFound()` guarantees by
 * throwing the framework's own not found signal rather than returning a
 * rendered "forbidden" page that would itself be one more surface to keep
 * off the live product.
 */

import { headers } from "next/headers";
import { notFound } from "next/navigation";

export async function assertMockPagesAllowed(): Promise<void> {
  if (process.env.NEXT_PUBLIC_ALLOW_MOCK_PAGES === "1") {
    return;
  }

  const expectedToken = process.env.INTERNAL_VISUALS_AUTH_TOKEN;
  if (expectedToken) {
    const authHeader = (await headers()).get("authorization");
    if (authHeader === `Bearer ${expectedToken}`) {
      return;
    }
  }

  notFound();
}
