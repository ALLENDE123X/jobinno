/**
 * The creator self serve signup page (JOB-042).
 *
 * A creator lands here from a link Pranav or Courtney sends directly, so
 * unlike `/login` there is no session check and no redirect: a signed in
 * visitor and a signed out one see the same form, because holding a Jobinno
 * account has nothing to do with joining the affiliate program.
 *
 * Server component wrapping a client one, on the same split `app/login/page.tsx`
 * uses for the same reason: `PageShell`, the header and the surrounding page
 * need nothing that has to run in the browser, so only the form itself is a
 * client component.
 */

import { PageShell } from "@/components/page-shell";

import { CreatorSignupForm } from "./creator-signup-form";

export default function CreatorSignupPage() {
  return (
    <PageShell>
      <main className="relative flex flex-1 items-center justify-center px-4 py-16 sm:px-6">
        <CreatorSignupForm />
      </main>
    </PageShell>
  );
}
