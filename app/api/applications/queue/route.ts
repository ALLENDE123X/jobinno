/**
 * GET /api/applications/queue — the queue view's data, as JSON.
 *
 * The page itself (`app/dashboard/queue/page.tsx`) does not need this endpoint
 * to render the first paint: it reads the same data server side through the
 * user's session client. The route exists so the client can poll for the
 * `pending_user_input` rows transitioning back into `discovered` after a
 * person answers, without a full page reload. The client polls every 30
 * seconds while the tab is visible.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * `createServerClient()` reads the caller's cookie. No session is a 401. No
 * user id is ever taken from the request body or query string; there is none
 * to take. The `user_id` filter inside `readApplicationQueue` and the two
 * `applications_select_own` policies on the table both fence the same read.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * The response mirrors `ApplicationQueue` verbatim so the client and the
 * server component share one type. `snake_case` on the escalation question
 * fields is preserved because that is v1-C's persisted shape.
 */

import { NextResponse } from "next/server";

import { readApplicationQueue } from "@/lib/dashboard/queue-data";
import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  try {
    const queue = await readApplicationQueue(supabase, user.id);
    return NextResponse.json(queue, {
      // Never cache: the whole point of this endpoint is the poll seeing a row
      // move.
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    // The message on the thrown Error is already the sanitised sentence.
    // Detail sits in the server log via `failRead`.
    const message =
      error instanceof Error ? error.message : "Could not load your queue right now.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
