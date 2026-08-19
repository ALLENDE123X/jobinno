"use client";

/**
 * Dark mode wiring (JOB-016).
 *
 * `app/globals.css` declares the dark palette behind a `.dark` class variant,
 * so something has to put that class on `<html>`. `next-themes` does it, and
 * doing it with `defaultTheme="system"` means the operating system preference
 * is honoured before anyone touches the toggle.
 *
 * The toggle renders a fixed size placeholder until it has mounted. Before
 * hydration the client does not yet know which theme resolved, and rendering
 * the wrong icon first produces a visible flip on every load.
 */

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";

import { Button } from "@/components/ui/button";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className="size-9" aria-hidden />;
  }

  const isDark = resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />}
    </Button>
  );
}
