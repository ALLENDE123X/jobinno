/**
 * /permissions — the Gmail scope disclosure JOB-245 first shipped on the
 * landing page itself. Moved here in JOB-306 to keep the marketing surface
 * focused on conversion copy while preserving the disclosure a Google OAuth
 * reviewer expects to see against gmail.readonly (this page + /privacy
 * around line 136 in `app/privacy/page.tsx` are the two places the same
 * distinction between what the permission grants and what the code reads is
 * spelled out).
 *
 * A server component. No interactivity to add; the copy is the whole page.
 * Linked from the landing footer (`app/page.tsx`) and reachable at
 * `jobinno.app/permissions`.
 */

import Link from "next/link";

import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme";

export default function PermissionsPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <Logo />
            Jobinno
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto w-full max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Permissions
          </h1>

          <p className="mt-6 text-base text-pretty text-muted-foreground">
            Some job boards require creating an account before you can apply,
            which means receiving a security code by email. Jobinno can
            optionally connect to Gmail to read just that verification code
            for the boards that need it. The Gmail permission itself is
            broader than that: Google labels it &quot;View your email
            messages and settings&quot; on the consent screen, and that
            covers your whole inbox. Jobinno&apos;s code is written to
            restrict itself to reading that one verification code and
            nothing else in your inbox. This capability is not live yet:
            connecting Gmail today stores the refresh token for when it
            ships, and the app does not open any messages until then.
          </p>
        </div>
      </main>

      <footer className="border-t px-4 py-10 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 text-sm text-muted-foreground sm:flex-row">
          <div className="flex flex-col items-center gap-1 sm:items-start">
            <p className="font-medium text-foreground">Jobinno</p>
            <p className="text-xs">Operated by Pranav Lende</p>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="underline underline-offset-3 hover:text-foreground"
            >
              Home
            </Link>
            <Link
              href="/privacy"
              className="underline underline-offset-3 hover:text-foreground"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="underline underline-offset-3 hover:text-foreground"
            >
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
