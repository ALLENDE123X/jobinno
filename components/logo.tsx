"use client";

/**
 * The Jobinno mark, swapping color variant with the resolved theme.
 *
 * Same mounted guard as `ThemeToggle` in `components/theme.tsx`, for the same
 * reason: before hydration the client does not yet know which theme resolved,
 * and picking one variant first produces a visible flip on every load. The
 * light variant renders as the placeholder since it matches the server's
 * pre-hydration markup.
 */

import { useEffect, useState } from "react";
import Image from "next/image";
import { useTheme } from "next-themes";

export function Logo({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme } = useTheme();

  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <Image
      src={isDark ? "/nav-logo-dark.png" : "/nav-logo-light.png"}
      alt="Jobinno"
      width={28}
      height={28}
      priority
      className={className}
    />
  );
}
