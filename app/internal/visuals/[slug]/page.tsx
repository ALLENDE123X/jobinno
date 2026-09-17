/**
 * JOB-365. The 15 mock visuals `/scripts-jobinno` composites into beat 4 of a
 * reel all render through this one dynamic route. `_lib/gate.ts` decides
 * whether the request may see anything at all; `_lib/registry.tsx` decides
 * which of the 15 components a valid slug maps to. An unknown slug 404s the
 * same way a disallowed request does, so this route never confirms which
 * slugs exist to a caller it has not already let in.
 *
 * `dynamic = "force-dynamic"` because `assertMockPagesAllowed()` reads
 * request headers, which Next.js would otherwise want to statically
 * prerender away.
 *
 * JOB-365 followup: also reads a `capture` query param and hands it down
 * through `CaptureProvider` so a client component anywhere under `<Page />`
 * can tell a `scripts/capture-visuals.ts` screenshot run apart from a person
 * previewing the page. See `_lib/capture-context.tsx` for why this exists
 * (the `NumberTicker` settle race that produced a wrong digit in
 * `money-time-saved-counter.png`).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isVisualSlug } from "@/lib/internal-visuals-slugs";

import { VisualFrame } from "../_components/visual-frame";
import { CaptureProvider } from "../_lib/capture-context";
import { assertMockPagesAllowed } from "../_lib/gate";
import { VISUAL_PAGES } from "../_lib/registry";

export const dynamic = "force-dynamic";

// Renders the literal `<meta name="robots" content="noindex, nofollow" />`
// the ticket asks for. These pages must never be indexed even if the gate
// that keeps them off production is ever misconfigured.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function VisualPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await assertMockPagesAllowed();

  const { slug } = await params;
  if (!isVisualSlug(slug)) {
    notFound();
  }

  const sp = await searchParams;
  const capture = sp.capture === "1";

  const Page = VISUAL_PAGES[slug];
  return (
    <VisualFrame>
      <CaptureProvider capture={capture}>
        <Page />
      </CaptureProvider>
    </VisualFrame>
  );
}
