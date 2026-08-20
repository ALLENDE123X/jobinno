import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { FeedbackWidget } from "@/components/feedback-widget";
import { ThemeProvider } from "@/components/theme";

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
        <ThemeProvider>
          {children}
          {/* Layout level on purpose: the feedback button belongs on every
              page, not on the ones somebody remembered to add it to. */}
          <FeedbackWidget />
        </ThemeProvider>
      </body>
    </html>
  );
}
