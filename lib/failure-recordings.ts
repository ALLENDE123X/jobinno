/**
 * JOB-027. Turns a `skip_log` failure into a Gemini play-by-play of the
 * Browserbase recording it happened in.
 *
 * ── Where the session id comes from ─────────────────────────────────────────
 * Going forward, `raw_context.browserbaseSessionId` carries it directly —
 * `submit-application.ts` and `fill-application-form.ts` stamp it at the point
 * a session opens, before anything can fail. For rows written before that
 * existed, there is no reliable link: up to `BROWSERBASE_DEFAULT_CONCURRENCY`
 * sessions run at once, so two failures a few seconds apart can belong to two
 * different sessions and a bare timestamp cannot tell them apart.
 * `resolveSessionId` below does the best it honestly can for those rows — it
 * narrows by the time window the session was live, then disambiguates by
 * checking which candidate's own network log actually visited the platform
 * the failure was filed against, via the same `matchAtsHost` the rest of the
 * pipeline uses to tell ATS platforms apart. When more than one candidate
 * still passes that check, it says so rather than guessing.
 *
 * ── Why the video and not the rrweb replay ──────────────────────────────────
 * Browserbase deprecated the rrweb-based DOM replay; the Session Replay API is
 * its replacement and returns an HLS manifest whose segment URLs are already
 * pre-signed, so muxing to a single mp4 is a local `ffmpeg` call away — see
 * `downloadReplay`. That mp4 is what actually gets sent to Gemini: a model
 * that can watch a login flow or a captcha wall is a much better read on "what
 * happened" than a page's own DOM mutations would be.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { and, desc, eq, gte, lte } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { skipLog, type SkipReason } from "@/lib/db/schema";
import { matchAtsHost } from "@/lib/ats-boards";

export type RecordingsDatabase = ReturnType<typeof db>;

const BROWSERBASE_API = "https://api.browserbase.com/v1";

/** How far the best-effort matcher will look either side of a failure's timestamp. */
const MATCH_WINDOW_MS = 10 * 60 * 1000;

/** How many recent sessions the best-effort matcher pulls once per run, not once per failure. */
const SESSION_LIST_LIMIT = 200;

export type FailureRecord = {
  id: string;
  applicationId: string | null;
  jobId: string;
  ats: string;
  reason: SkipReason;
  message: string;
  createdAt: Date;
  /** Present only on rows written after JOB-027 wired the session id through. */
  recordedSessionId: string | null;
};

/**
 * Failures in the window, newest first. Reads `skip_log` directly rather than
 * through `loadSkipRollup`: that module aggregates for a rate, this one wants
 * the individual rows to fetch recordings for.
 */
export async function listRecentFailures(
  options: {
    days: number;
    reason?: SkipReason;
    ats?: string;
    limit?: number;
    now?: Date;
    database?: RecordingsDatabase;
  }
): Promise<FailureRecord[]> {
  const database = options.database ?? db();
  const now = options.now ?? new Date();
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - options.days);

  const conditions = [gte(skipLog.createdAt, since), lte(skipLog.createdAt, now)];
  if (options.reason !== undefined) conditions.push(eq(skipLog.reason, options.reason));
  if (options.ats !== undefined) conditions.push(eq(skipLog.ats, options.ats));

  const rows = await database
    .select({
      id: skipLog.id,
      applicationId: skipLog.applicationId,
      jobId: skipLog.jobId,
      ats: skipLog.ats,
      reason: skipLog.reason,
      rawContext: skipLog.rawContext,
      createdAt: skipLog.createdAt,
    })
    .from(skipLog)
    .where(and(...conditions))
    // Newest first, so `limit` keeps the N most recent failures in the
    // window rather than the N oldest. `.reverse()` below puts the kept rows
    // back in chronological order for the caller.
    .orderBy(desc(skipLog.createdAt))
    .limit(options.limit ?? 50);

  return rows
    .map((row) => {
      const context = (row.rawContext ?? {}) as { message?: unknown; browserbaseSessionId?: unknown };
      return {
        id: row.id,
        applicationId: row.applicationId,
        jobId: row.jobId,
        ats: row.ats,
        reason: row.reason as SkipReason,
        message: typeof context.message === "string" ? context.message : "",
        createdAt: row.createdAt,
        recordedSessionId:
          typeof context.browserbaseSessionId === "string" ? context.browserbaseSessionId : null,
      };
    })
    .reverse();
}

type BrowserbaseSessionSummary = { id: string; status: string; createdAt: string; updatedAt: string };

async function fetchJson<T>(url: string, apiKey: string): Promise<T> {
  const response = await fetch(url, { headers: { "x-bb-api-key": apiKey } });
  if (!response.ok) {
    throw new Error(`Browserbase ${url} → HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** The document URLs a session's own CDP network log actually visited. */
async function documentUrlsForSession(sessionId: string, apiKey: string): Promise<string[]> {
  type LogEntry = { request?: { params?: { documentURL?: string; url?: string } } };
  const entries = await fetchJson<LogEntry[]>(`${BROWSERBASE_API}/sessions/${sessionId}/logs`, apiKey);
  const urls = new Set<string>();
  for (const entry of entries) {
    const url = entry.request?.params?.documentURL ?? entry.request?.params?.url;
    if (typeof url === "string") urls.add(url);
  }
  return [...urls];
}

export type SessionMatch =
  | { kind: "recorded"; sessionId: string }
  | { kind: "matched"; sessionId: string }
  | { kind: "ambiguous"; candidateSessionIds: string[] }
  | { kind: "none" };

/**
 * Which Browserbase session a failure belongs to.
 *
 * `sessions` is the caller's own recent-sessions list, fetched once per run —
 * see `listRecentSessions` — so scanning N failures costs one list call plus
 * one `/logs` call per genuinely overlapping candidate, not N list calls.
 */
export async function resolveSessionId(
  failure: FailureRecord,
  sessions: readonly BrowserbaseSessionSummary[],
  options: { apiKey: string }
): Promise<SessionMatch> {
  if (failure.recordedSessionId !== null) {
    return { kind: "recorded", sessionId: failure.recordedSessionId };
  }

  const failureTime = failure.createdAt.getTime();
  const overlapping = sessions.filter((session) => {
    const start = new Date(session.createdAt).getTime() - MATCH_WINDOW_MS;
    const end = new Date(session.updatedAt).getTime() + MATCH_WINDOW_MS;
    return failureTime >= start && failureTime <= end;
  });

  if (overlapping.length === 0) return { kind: "none" };
  if (overlapping.length === 1) return { kind: "matched", sessionId: overlapping[0].id };

  const onPlatform: string[] = [];
  for (const session of overlapping) {
    const urls = await documentUrlsForSession(session.id, options.apiKey);
    const visitedFailurePlatform = urls.some((url) => {
      try {
        return matchAtsHost(new URL(url).hostname)?.ats === failure.ats;
      } catch {
        return false;
      }
    });
    if (visitedFailurePlatform) onPlatform.push(session.id);
  }

  if (onPlatform.length === 1) return { kind: "matched", sessionId: onPlatform[0] };
  if (onPlatform.length > 1) return { kind: "ambiguous", candidateSessionIds: onPlatform };
  return { kind: "ambiguous", candidateSessionIds: overlapping.map((session) => session.id) };
}

/** Recent sessions, fetched once per run for `resolveSessionId` to filter in memory. */
export async function listRecentSessions(options: {
  apiKey: string;
}): Promise<BrowserbaseSessionSummary[]> {
  return await fetchJson<BrowserbaseSessionSummary[]>(
    `${BROWSERBASE_API}/sessions?limit=${SESSION_LIST_LIMIT}`,
    options.apiKey
  );
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/**
 * Downloads every page of a session's replay and muxes it into one mp4 at
 * `outPath`. Segment URLs inside the manifest are already pre-signed by
 * Browserbase's CDN, so only the manifest itself needs the API key — `ffmpeg`
 * fetches the segments directly once it has a local copy of the manifest.
 */
export async function downloadReplay(
  sessionId: string,
  outPath: string,
  options: { apiKey: string }
): Promise<{ pageCount: number; durationMs: number }> {
  type ReplayMeta = { pages: { pageId: string; startTimeMs: number; endTimeMs: number }[] };
  const meta = await fetchJson<ReplayMeta>(`${BROWSERBASE_API}/sessions/${sessionId}/replays`, options.apiKey);
  if (meta.pages.length === 0) {
    throw new Error(`Session ${sessionId} has no replay pages — recordSession was likely off.`);
  }

  await mkdir(dirname(outPath), { recursive: true });

  // One mp4 per page, concatenated, rather than one manifest for the whole
  // session: Browserbase splits a page navigation into a new page id, and
  // `ffmpeg` cannot mux two manifests whose segments start over at t=0 into a
  // single continuous timeline without a re-encode this script has no need for.
  const partPaths: string[] = [];
  for (const page of meta.pages) {
    const manifest = await fetch(`${BROWSERBASE_API}/sessions/${sessionId}/replays/${page.pageId}`, {
      headers: { "x-bb-api-key": options.apiKey },
    });
    if (!manifest.ok) throw new Error(`Replay manifest for page ${page.pageId} → HTTP ${manifest.status}`);
    const manifestPath = `${outPath}.${page.pageId}.m3u8`;
    await writeFile(manifestPath, await manifest.text());
    const partPath = `${outPath}.${page.pageId}.mp4`;
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto",
      "-i",
      manifestPath,
      "-c",
      "copy",
      partPath,
    ]);
    await unlink(manifestPath);
    partPaths.push(partPath);
  }

  if (partPaths.length === 1) {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", partPaths[0], "-c", "copy", outPath]);
    await unlink(partPaths[0]);
  } else {
    const listPath = `${outPath}.concat.txt`;
    await writeFile(listPath, partPaths.map((path) => `file '${path}'`).join("\n"));
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      outPath,
    ]);
    await unlink(listPath);
    await Promise.all(partPaths.map((path) => unlink(path)));
  }

  const last = meta.pages[meta.pages.length - 1];
  return { pageCount: meta.pages.length, durationMs: last.endTimeMs };
}

const GEMINI_API = "https://generativelanguage.googleapis.com";

/**
 * Uploads a video and asks Gemini for a play-by-play of what happened and why
 * the run stopped. Uses the File API (resumable upload) rather than inlining
 * the video as base64: these recordings run tens of megabytes and the inline
 * request-body limit is far below that.
 */
export async function analyzeFailureVideo(
  videoPath: string,
  failure: FailureRecord,
  options: { apiKey: string; model?: string }
): Promise<string> {
  const model = options.model ?? "gemini-2.5-pro";
  const bytes = await readFile(videoPath);

  const start = await fetch(`${GEMINI_API}/upload/v1beta/files?key=${options.apiKey}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": "video/mp4",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: `skip_log-${failure.id}` } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || uploadUrl === null) {
    throw new Error(`Gemini file upload could not start: HTTP ${start.status}: ${await start.text()}`);
  }

  const finish = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!finish.ok) {
    throw new Error(`Gemini file upload could not finish: HTTP ${finish.status}: ${await finish.text()}`);
  }
  const uploaded = (await finish.json()) as { file: { uri: string; mimeType: string } };

  const prompt =
    `You are watching a screen recording of an automated job-application agent filling out ` +
    `a form on ${failure.ats}. The run stopped with reason "${failure.reason}" and this message ` +
    `from the pipeline: "${failure.message}".\n\n` +
    `Give a play-by-play of what the recording actually shows, in the order it happens: what ` +
    `page loaded, what the agent clicked or typed, and the exact moment things went wrong. Then ` +
    `state your own diagnosis of the root cause — agree or disagree with the pipeline's stated ` +
    `reason, and say why. End with one concrete, specific suggestion for what would need to ` +
    `change in the automation to avoid this failure next time, or state plainly if nothing short ` +
    `of accepting the failure would fix it (e.g. genuine anti-bot detection).`;

  const generate = await fetch(
    `${GEMINI_API}/v1beta/models/${model}:generateContent?key=${options.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { file_data: { file_uri: uploaded.file.uri, mime_type: uploaded.file.mimeType } },
              { text: prompt },
            ],
          },
        ],
      }),
    }
  );
  if (!generate.ok) {
    throw new Error(`Gemini generateContent failed: HTTP ${generate.status}: ${await generate.text()}`);
  }
  const result = (await generate.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  if (text === "") throw new Error(`Gemini returned no analysis text: ${JSON.stringify(result)}`);
  return text;
}
