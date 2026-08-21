/**
 * JOB-023. The sign in form never shows a person a message written for a
 * developer.
 *
 * ── The bug this locks down ─────────────────────────────────────────────────
 * `authCallbackUrlFor` throws a paragraph naming `AUTH_REDIRECT_ALLOWLIST`,
 * `supabase/config.toml` and the command that pushes it. That is the right
 * message for whoever has to widen the allowlist. The form caught it and put
 * `error.message` straight into the markup, so it was also the message shown to
 * a real person on `www.jobinno.app` who was trying to make an account.
 *
 * The allowlist entry for `www` fixes tonight's instance. This file fixes the
 * shape of it, because the next origin that is not on the list throws the same
 * paragraph, and a Vercel preview deployment is already one such origin.
 *
 * So the assertions are deliberately about what is absent. Checking that the
 * calm sentence appears would still pass if the paragraph were appended below
 * it, and it is the paragraph that is the problem.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `vi.hoisted` because `vi.mock` factories are lifted above everything else in
 * the file. These have to exist by the time a factory runs, and a plain `const`
 * declared below would not.
 */
const stubs = vi.hoisted(() => ({
  signInWithOtp: vi.fn(),
  /** Swapped per test to choose which failure the form has to survive. */
  origin: "https://jobinno-git-preview.vercel.app",
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithOtp: stubs.signInWithOtp } }),
}));

vi.mock("@/components/analytics", () => ({
  captureClientEvent: vi.fn(),
}));

/**
 * The real safeguard, pointed at whichever origin the test chose, so the string
 * under test is the one the module actually produces rather than a copy of it
 * that could drift out of date.
 */
vi.mock("@/lib/auth/redirect-urls", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/redirect-urls")>();
  return { ...actual, authCallbackUrlFor: () => actual.authCallbackUrlFor(stubs.origin) };
});

const { LoginForm } = await import("@/app/login/login-form");
const { captureClientEvent } = await import("@/components/analytics");
const { PRODUCTION_ORIGIN } = await import("@/lib/auth/redirect-urls");

const CALM_COPY =
  "Something went wrong sending your sign in link. Please try again in a moment.";

/** Every internal detail that has no business on a sign in page. */
const LEAKED_INTERNALS = [
  "AUTH_REDIRECT_ALLOWLIST",
  "additional_redirect_urls",
  "supabase/config.toml",
  "supabase:auth-config",
  "redirect allowlist",
  "Site URL",
  "localhost:3000",
  "/auth/callback",
];

async function submitAnEmail() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "courtney@example.com" },
  });
  const form = screen
    .getByRole("button", { name: "Email me a link" })
    .closest("form");
  fireEvent.submit(form!);
  await screen.findByRole("alert");
  return () => screen.getByRole("alert").textContent;
}

describe("the sign in form's failure copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.origin = "https://jobinno-git-preview.vercel.app";
    stubs.signInWithOtp.mockResolvedValue({ error: null });
    // The form is a client component, so its log lands in the browser console.
    // Silenced here so an expected failure does not print as noise, and spied
    // on so the test can prove the detail still goes somewhere.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("when the origin is not allowlisted", () => {
    it("shows calm copy rather than the safeguard paragraph", async () => {
      render(<LoginForm />);
      const alertText = await submitAnEmail();

      for (const internal of LEAKED_INTERNALS) {
        expect(alertText()).not.toContain(internal);
      }
      expect(alertText()).toBe(CALM_COPY);
    });

    it("never reaches Supabase, because the origin was refused first", async () => {
      render(<LoginForm />);
      await submitAnEmail();

      expect(stubs.signInWithOtp).not.toHaveBeenCalled();
    });

    it("still hands the developer the full reason, in the console", async () => {
      render(<LoginForm />);
      await submitAnEmail();

      const logged = vi
        .mocked(console.error)
        .mock.calls.flat()
        .map((entry) => (entry instanceof Error ? entry.message : String(entry)))
        .join(" ");

      expect(logged).toContain("redirect allowlist");
      expect(logged).toContain("AUTH_REDIRECT_ALLOWLIST");
    });

    it("counts the refusal in the funnel instead of losing it", async () => {
      render(<LoginForm />);
      await submitAnEmail();

      expect(captureClientEvent).toHaveBeenCalledWith("magic_link_requested", {
        outcome: "refused",
      });
    });
  });

  describe("when Supabase itself refuses to send", () => {
    beforeEach(() => {
      // An allowlisted origin, so the request gets as far as Supabase and the
      // failure under test is Supabase's own.
      stubs.origin = PRODUCTION_ORIGIN;
      // What real people were shown tonight once the built in mailer hit its
      // limit. Accurate about our mail provider, meaningless to a candidate.
      stubs.signInWithOtp.mockResolvedValue({
        error: { message: "email rate limit exceeded" },
      });
    });

    it("does not repeat Supabase's wording back to the reader", async () => {
      render(<LoginForm />);
      const alertText = await submitAnEmail();

      await waitFor(() => expect(alertText()).toBe(CALM_COPY));
      expect(alertText()).not.toContain("rate limit");
    });

    it("logs what Supabase actually said", async () => {
      render(<LoginForm />);
      await submitAnEmail();

      const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
      expect(logged).toContain("email rate limit exceeded");
    });
  });

  it("keeps the one message a reader can act on", async () => {
    render(<LoginForm />);
    const form = screen
      .getByRole("button", { name: "Email me a link" })
      .closest("form");
    fireEvent.submit(form!);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Enter your email address."
    );
    expect(stubs.signInWithOtp).not.toHaveBeenCalled();
  });
});
