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
  signInWithOAuth: vi.fn(),
  /** Swapped per test to choose which failure the form has to survive. */
  origin: "https://jobinno-git-preview.vercel.app",
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signInWithOtp: stubs.signInWithOtp,
      signInWithOAuth: stubs.signInWithOAuth,
    },
  }),
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
    stubs.signInWithOAuth.mockResolvedValue({ error: null });
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
        method: "email",
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

/**
 * JOB-307. The Google OAuth button is the primary CTA and shares the sign in
 * form's failure copy: `authCallbackUrlFor` throws the same paragraph if the
 * origin is not allowlisted, and Supabase can hand back the same operator
 * shaped strings, so the same one sentence collapses both.
 */
describe("the Continue with Google button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.origin = PRODUCTION_ORIGIN;
    stubs.signInWithOtp.mockResolvedValue({ error: null });
    stubs.signInWithOAuth.mockResolvedValue({ error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders above the email form as the primary call to action", () => {
    render(<LoginForm />);

    const googleButton = screen.getByRole("button", {
      name: "Continue with Google",
    });
    const emailButton = screen.getByRole("button", { name: "Email me a link" });

    // `compareDocumentPosition` reads the DOM order rather than a class, so a
    // later reshuffle that puts Google below by accident still fails this.
    expect(
      googleButton.compareDocumentPosition(emailButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("hands Supabase the provider and the allowlisted callback URL", async () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(stubs.signInWithOAuth).toHaveBeenCalledTimes(1));
    expect(stubs.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: `${PRODUCTION_ORIGIN}/auth/callback` },
    });
  });

  it("counts the click in the funnel with method=google", async () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() =>
      expect(captureClientEvent).toHaveBeenCalledWith("magic_link_requested", {
        outcome: "sent",
        method: "google",
      })
    );
  });

  it("shows the same calm copy on a Supabase failure and files it as refused", async () => {
    stubs.signInWithOAuth.mockResolvedValueOnce({
      error: { message: "provider disabled" },
    });
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(CALM_COPY);
    expect(captureClientEvent).toHaveBeenCalledWith("magic_link_requested", {
      outcome: "refused",
      method: "google",
    });
  });

  it("collapses an allowlist rejection to the same one sentence", async () => {
    stubs.origin = "https://jobinno-git-preview.vercel.app";
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(CALM_COPY);
    for (const internal of LEAKED_INTERNALS) {
      expect(alert.textContent).not.toContain(internal);
    }
    expect(stubs.signInWithOAuth).not.toHaveBeenCalled();
    expect(captureClientEvent).toHaveBeenCalledWith("magic_link_requested", {
      outcome: "refused",
      method: "google",
    });
  });

  it("carries the primary continuation copy above the two auth CTAs (JOB-327)", () => {
    // Funnel analysis of the ad click drop off (2026-09-01) attributed the
    // top of the signup loss to a login shell that stripped every trust cue
    // the landing built. Locking the five above the CTAs pieces in one test
    // makes it obvious the moment any of them regress: the H1 that echoes
    // the landing's "Queue tonight's applications" hook, a three step
    // preview of the flow, the Gmail scope sentence, the free tier chip,
    // and the Terms and Privacy pair inline. A screenreader label on the
    // three step list gives us one stable anchor for the strip without
    // pinning the icon markup itself.
    render(<LoginForm />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("One step to tonight's applications.");

    const flow = screen.getByRole("list", { name: "What happens next" });
    const steps = flow.textContent ?? "";
    expect(steps).toContain("Sign in");
    expect(steps).toContain("3 minute intake");
    expect(steps).toContain("First 3 applications go out tonight");

    expect(screen.getByTestId("login-gmail-scope-chip").textContent).toBe(
      "Read only Gmail access is requested later, not on this screen."
    );
    expect(screen.getByTestId("login-free-tier-chip").textContent).toBe(
      "Free tier: 3 applications. No card required."
    );

    // Terms and Privacy are inline under the buttons, both linking to the
    // pages that already exist on the marketing surface. The test asserts
    // both are present and pointed at those routes so a later edit that
    // drops either one or points one at the wrong route fails here.
    const termsLink = screen.getByRole("link", { name: "Terms" });
    const privacyLink = screen.getByRole("link", { name: "Privacy" });
    expect(termsLink.getAttribute("href")).toBe("/terms");
    expect(privacyLink.getAttribute("href")).toBe("/privacy");
  });

  it("labels the divider between the two paths so the email path reads as the fallback", () => {
    // JOB-327 reweights the two paths: Google is the full width primary and
    // the emailed link is a secondary path below a divider whose label
    // spells out what the second path is for. The old divider said just
    // "or", which invited a coin flip between the two.
    render(<LoginForm />);

    expect(screen.getByText("or use email instead")).toBeTruthy();
  });

  it("disables both buttons while the OAuth handoff is in flight", async () => {
    let resolveOAuth: (value: { error: null }) => void = () => {};
    stubs.signInWithOAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOAuth = resolve;
      })
    );
    render(<LoginForm />);

    const googleButton = screen.getByRole("button", {
      name: "Continue with Google",
    });
    fireEvent.click(googleButton);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Redirecting" })
      ).toBeDisabled()
    );
    // Same shared status flips the email button's own label to "Sending", so
    // there is no way for someone to click either path while the redirect to
    // Google is in flight.
    expect(screen.getByRole("button", { name: "Sending" })).toBeDisabled();

    resolveOAuth({ error: null });
  });
});
