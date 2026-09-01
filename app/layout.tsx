import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

import { AnalyticsProvider } from "@/components/analytics";
import { FeedbackWidget } from "@/components/feedback-widget";
import { ThemeProvider } from "@/components/theme";

// JOB-328. Meta Pixel base code, gated on the pixel id being set. Read once
// at module scope so a redeploy is what changes it; the pixel id is a
// build-time constant on purpose (see lib/analytics/meta-pixel-client.ts).
const META_PIXEL_ID = (process.env.NEXT_PUBLIC_META_PIXEL_ID ?? "").trim();

/**
 * The variable is `--font-sans` and not `--font-geist-sans` on purpose. The
 * `@theme inline` block in `globals.css` maps Tailwind's `font-sans` to
 * `var(--font-sans)`, and while nothing defined that name the whole app was
 * quietly falling back to the browser default rather than to Geist (JOB-016).
 *
 * The class that carries the variables also has to sit on `<html>` rather than
 * on `<body>`, because the same stylesheet applies `font-sans` to `html`. A
 * variable declared one level lower is not in scope where it is read, so the
 * declaration resolved to nothing and every page rendered in Times.
 */
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Jobinno: you sleep, AI applies",
  description:
    "An autonomous job application agent for CS interns and new grads. One resume and one short intake, then it fills and submits the real application forms for you.",
  icons: {
    icon: [
      { url: "/favicon-light-32.png", sizes: "32x32", media: "(prefers-color-scheme: light)" },
      { url: "/favicon-light-16.png", sizes: "16x16", media: "(prefers-color-scheme: light)" },
      { url: "/favicon-dark-32.png", sizes: "32x32", media: "(prefers-color-scheme: dark)" },
      { url: "/favicon-dark-16.png", sizes: "16x16", media: "(prefers-color-scheme: dark)" },
    ],
    apple: "/apple-icon-180.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `suppressHydrationWarning` is what next-themes asks for: it writes the
    // theme class onto <html> before React hydrates, so the server markup and
    // the first client markup differ on this element by design.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">
        {/* JOB-328. Meta Pixel base code. Renders only when the pixel id is
            set; every deployment that has not yet had the env var set on
            Vercel emits nothing at all, so this is safe to ship ahead of the
            configuration change. `strategy="afterInteractive"` is Meta's own
            recommended install pattern: the loader stub assigns window.fbq
            synchronously and queues track calls until the real library
            arrives, so a call from a client component's useEffect that runs
            after hydration is safe. The paired secret is
            META_CAPI_ACCESS_TOKEN and never appears in this bundle. */}
        {META_PIXEL_ID !== "" ? (
          <Script id="meta-pixel" strategy="afterInteractive">
            {`!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${META_PIXEL_ID}');
fbq('track', 'PageView');`}
          </Script>
        ) : null}
        {/* Outermost of the two providers because it is the one that has to see
            every route change, including the ones that happen before a theme
            has resolved. It renders nothing and no op's entirely when no
            PostHog key is configured (JOB-014). */}
        <AnalyticsProvider>
          <ThemeProvider>
            {children}
            {/* Layout level on purpose: the feedback button belongs on every
                page, not on the ones somebody remembered to add it to. */}
            <FeedbackWidget />
          </ThemeProvider>
        </AnalyticsProvider>
      </body>
    </html>
  );
}
