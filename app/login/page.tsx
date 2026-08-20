/**
 * The sign in page. Server side so that an `error` handed back by
 * `app/auth/callback/route.ts` is rendered on the first paint rather than after
 * a client component has mounted and gone looking for it.
 */

import { PageShell } from "@/components/page-shell";

import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = params.error;

  return (
    <PageShell>
      <main className="relative flex flex-1 items-center justify-center px-4 py-16 sm:px-6">
        <LoginForm initialError={typeof error === "string" ? error : undefined} />
      </main>
    </PageShell>
  );
}
