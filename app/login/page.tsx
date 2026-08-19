/**
 * The sign in page. Server side so that an `error` handed back by
 * `app/auth/callback/route.ts` is rendered on the first paint rather than after
 * a client component has mounted and gone looking for it.
 */

import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = params.error;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LoginForm initialError={typeof error === "string" ? error : undefined} />
    </main>
  );
}
