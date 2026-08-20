// @vitest-environment node
/**
 * JOB-020. Somebody already signed in who visits `/login` or `/` should land
 * on `/dashboard` instead of the sign in form or the marketing pitch.
 *
 * ── Why this drives the page functions directly ─────────────────────────────
 * Same approach as `tests/unit/billing-checkout-route.test.ts`: `@/lib/supabase/
 * server` is mocked with `vi.doMock`, the page is imported after the mock is in
 * place, and the exported function is called directly with the same shape of
 * props Next.js hands it. Neither page needs a real request, a real session or
 * a browser, so there is nothing an end to end test would prove that this does
 * not.
 *
 * ── What the assertion looks like ───────────────────────────────────────────
 * `next/navigation`'s `redirect()` is not mocked. It really does throw, tagged
 * with a `digest` that names the destination, and that is the mechanism Next
 * itself relies on to turn a thrown value into a response. Catching it and
 * reading `digest` is therefore the direct way to prove a redirect fired and
 * where it went, and a resolved call with no throw is the direct way to prove
 * one did not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BILLING_ERROR_PARAM } from "@/lib/billing/plans";

const USER_ID = "11111111-2222-3333-4444-555555555555";
const EMAIL = "someone@university.edu";

const createServerClient = vi.fn();

/** Just enough Supabase to answer "who is this", matching the checkout test. */
function supabaseStub(signedIn: boolean) {
  return {
    auth: {
      async getUser() {
        return {
          data: { user: signedIn ? { id: USER_ID, email: EMAIL } : null },
        };
      },
    },
  };
}

/** The destination `redirect()` threw for, or null if `error` is not one. */
function redirectDestination(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const digest = (error as { digest?: unknown }).digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) {
    return null;
  }
  return digest.split(";")[2] ?? null;
}

/**
 * Walks a returned element tree looking for one of a given component type,
 * without rendering anything. A page function returns a tree of plain React
 * elements, and `LoginForm` and friends are themselves unrendered elements in
 * it, so their props are readable directly.
 */
function findElement(
  node: unknown,
  matches: (element: { type: unknown; props: Record<string, unknown> }) => boolean
): { type: unknown; props: Record<string, unknown> } | null {
  if (!node || typeof node !== "object") return null;

  if ("type" in node && "props" in node) {
    const element = node as { type: unknown; props: Record<string, unknown> };
    if (matches(element)) return element;
    return findElement(element.props?.children, matches);
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, matches);
      if (found) return found;
    }
  }

  return null;
}

describe("a signed in visitor is sent to /dashboard instead of shown /login or / again", () => {
  beforeEach(() => {
    vi.resetModules();
    createServerClient.mockReset();

    vi.doMock("@/lib/supabase/server", () => ({
      createServerClient,
      createServiceRoleClient: vi.fn(),
      RESUMES_BUCKET: "resumes",
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/supabase/server");
  });

  describe("/login", () => {
    it("redirects a signed in visitor to /dashboard without rendering the form", async () => {
      createServerClient.mockResolvedValue(supabaseStub(true));

      const { default: LoginPage } = await import("@/app/login/page");

      let caught: unknown;
      try {
        await LoginPage({ searchParams: Promise.resolve({}) });
      } catch (error) {
        caught = error;
      }

      expect(redirectDestination(caught)).toBe("/dashboard");
    });

    it("renders the form for a signed out visitor, unaffected by this change", async () => {
      createServerClient.mockResolvedValue(supabaseStub(false));

      const { default: LoginPage } = await import("@/app/login/page");
      const { LoginForm } = await import("@/app/login/login-form");

      const element = await LoginPage({ searchParams: Promise.resolve({}) });

      const form = findElement(element, (el) => el.type === LoginForm);
      expect(form).not.toBeNull();
      expect(form?.props.initialError).toBeUndefined();
    });

    it("still surfaces a failed magic link exchange to a signed out visitor", async () => {
      createServerClient.mockResolvedValue(supabaseStub(false));

      const { default: LoginPage } = await import("@/app/login/page");
      const { LoginForm } = await import("@/app/login/login-form");

      const element = await LoginPage({
        searchParams: Promise.resolve({ error: "Email link is invalid or has expired" }),
      });

      const form = findElement(element, (el) => el.type === LoginForm);
      expect(form?.props.initialError).toBe("Email link is invalid or has expired");
    });
  });

  describe("/ (the landing page)", () => {
    it("redirects a signed in visitor to /dashboard instead of the marketing pitch", async () => {
      createServerClient.mockResolvedValue(supabaseStub(true));

      const { default: Home } = await import("@/app/page");

      let caught: unknown;
      try {
        await Home({ searchParams: Promise.resolve({}) });
      } catch (error) {
        caught = error;
      }

      expect(redirectDestination(caught)).toBe("/dashboard");
    });

    it("renders the landing page for a signed out visitor, unaffected by this change", async () => {
      createServerClient.mockResolvedValue(supabaseStub(false));

      const { default: Home } = await import("@/app/page");

      let caught: unknown;
      let element: unknown;
      try {
        element = await Home({ searchParams: Promise.resolve({}) });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeUndefined();
      expect(element).toBeTruthy();
    });

    /**
     * The exception the ticket calls out by name. `app/api/billing/checkout/
     * route.ts` sends an already signed in person, for instance somebody who
     * already holds a paid plan and pressed buy again, back to `/` with
     * `?billing_error=<code>` so `BillingError` can tell them why nothing was
     * charged. A redirect firing here would send that person straight past the
     * message and they would never see it, which is exactly the regression
     * this test exists to catch.
     */
    it("does not redirect a signed in visitor sent back with a billing_error", async () => {
      createServerClient.mockResolvedValue(supabaseStub(true));

      const { default: Home } = await import("@/app/page");

      let caught: unknown;
      let element: unknown;
      try {
        element = await Home({
          searchParams: Promise.resolve({
            [BILLING_ERROR_PARAM]: "already_subscribed",
          }),
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeUndefined();
      expect(element).toBeTruthy();
    });
  });
});
