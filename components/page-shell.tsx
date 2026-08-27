/**
 * The background, brand mark and theme toggle shared by every signed in or
 * mid signup page (JOB-018).
 *
 * `app/page.tsx` earns its polish from a `DotPattern` behind the hero, a
 * `Logo` and `ThemeToggle` in a sticky header, and a wide content rail. Login,
 * onboarding and the dashboard had none of that: three different blank pages
 * with a bare card in the middle and no way to tell you were still using the
 * same product. This is the one place that look now lives, used identically
 * by all three so a person moving from sign up to intake to their
 * applications never sees the product change its mind about what it looks
 * like.
 *
 * A server component. `Logo` and `ThemeToggle` are each already their own
 * client component (`components/logo.tsx`, `components/theme.tsx`), so
 * nothing here needs `"use client"` to render them.
 *
 * Every page that uses this owns its own `<main>`. This file renders the
 * header and the background region around it, not a landmark of its own,
 * so a page never ends up with two `<main>` elements.
 */

import Link from "next/link";

import { Logo } from "@/components/logo";
import { SettingsLink } from "@/components/settings-link";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme";
import { DotPattern } from "@/components/ui/dot-pattern";

export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 shrink-0 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <Logo />
            Jobinno
          </Link>
          {/*
            SettingsLink and SignOutButton each self-hide when there is no
            session, so this same group renders correctly on `/login` (both
            absent) and on `/dashboard` (both present) without a prop
            threaded through. See components/settings-link.tsx.
          */}
          <div className="flex items-center gap-2">
            <SettingsLink />
            <SignOutButton />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/*
        Same trick as the landing hero in `app/page.tsx`: `DotPattern` fills
        the nearest `relative` ancestor, and the radial mask fades it toward
        the edges instead of tiling flatly across the page. The page's own
        `<main>` needs `relative` in its className too, so it paints above the
        pattern rather than behind it: an absolutely positioned element is a
        positioned descendant, which paints after a plain, non positioned
        block in source order unless that block is positioned as well.
      */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <DotPattern className="opacity-60 [mask-image:radial-gradient(650px_circle_at_50%_0%,white,transparent)]" />
        {children}
      </div>
    </div>
  );
}
