// @vitest-environment node
/**
 * JOB-328. The server side CAPI client's contract.
 *
 * ── The ones that matter ────────────────────────────────────────────────────
 * Three properties are being defended here and none of them is "the event
 * was received by Meta":
 *
 *  · The raw email address must never appear on the wire. HARD STOP 9 is
 *    what forbids letting the user's attestation carrying data leak, and
 *    Meta's own docs name SHA-256 of the lowercased trimmed email as the
 *    canonical identifier for this exact reason.
 *  · When either env var is unset, no fetch is issued and no exception is
 *    thrown. Every deployment before Pranav provisioned the vars is this
 *    case, and the callers (`submitIntake`, the Stripe webhook) are on paths
 *    that cannot afford a throw.
 *  · When Meta responds with an error or fetch fails outright, the caller
 *    still gets a resolved promise. Analytics is the least important thing
 *    happening on any path that fires an event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashEmail,
  metaCapiConfig,
  resetMetaCapiWarningForTests,
  sendMetaCapiEvent,
} from "@/lib/analytics/meta-conversions-api";
import { META_EVENT } from "@/lib/analytics/meta-pixel-client";

const REAL_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID;
const REAL_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetMetaCapiWarningForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  restore("NEXT_PUBLIC_META_PIXEL_ID", REAL_PIXEL_ID);
  restore("META_CAPI_ACCESS_TOKEN", REAL_TOKEN);
});

describe("hashEmail", () => {
  it("lowercases and trims before hashing so 'Alice@Example.com' hashes as 'alice@example.com'", () => {
    expect(hashEmail("Alice@Example.com")).toBe(
      hashEmail("alice@example.com"),
    );
    expect(hashEmail("  alice@example.com  ")).toBe(
      hashEmail("alice@example.com"),
    );
  });

  it("produces a 64 character hex string (SHA-256)", () => {
    const digest = hashEmail("alice@example.com");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the RFC 6234 SHA-256 of the lowercased trimmed value", () => {
    // Precomputed: printf 'alice@example.com' | shasum -a 256
    expect(hashEmail("alice@example.com")).toBe(
      "ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976",
    );
  });
});

describe("metaCapiConfig", () => {
  it("returns null when the pixel id is unset", () => {
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    process.env.META_CAPI_ACCESS_TOKEN = "tok";
    expect(metaCapiConfig()).toBeNull();
  });

  it("returns null when the access token is unset", () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "id";
    delete process.env.META_CAPI_ACCESS_TOKEN;
    expect(metaCapiConfig()).toBeNull();
  });

  it("returns both when set", () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "id";
    process.env.META_CAPI_ACCESS_TOKEN = "tok";
    expect(metaCapiConfig()).toEqual({ pixelId: "id", accessToken: "tok" });
  });
});

describe("sendMetaCapiEvent", () => {
  it("no ops without fetching when env is unconfigured", async () => {
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    delete process.env.META_CAPI_ACCESS_TOKEN;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      sendMetaCapiEvent({
        eventName: META_EVENT.LEAD,
        email: "alice@example.com",
      }),
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("warns exactly once on repeated unconfigured calls", async () => {
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    delete process.env.META_CAPI_ACCESS_TOKEN;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendMetaCapiEvent({ eventName: META_EVENT.LEAD });
    await sendMetaCapiEvent({ eventName: META_EVENT.PURCHASE });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("POSTs to the Meta endpoint with the hashed email, never the raw one", async () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "111222";
    process.env.META_CAPI_ACCESS_TOKEN = "secret_token";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await sendMetaCapiEvent({
      eventName: META_EVENT.COMPLETE_REGISTRATION,
      email: "Alice@Example.com",
      eventId: "intake_user_abc",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/111222/events");
    expect(String(url)).toContain("graph.facebook.com");

    const bodyText = String((init as RequestInit).body);
    expect(bodyText).not.toContain("Alice@Example.com");
    expect(bodyText).not.toContain("alice@example.com");
    // The precomputed SHA-256 hex of the normalized email must be present.
    expect(bodyText).toContain(hashEmail("alice@example.com"));

    const body = JSON.parse(bodyText) as {
      data: Array<{
        event_name: string;
        event_id?: string;
        user_data: { em?: string[] };
        action_source: string;
      }>;
      access_token: string;
    };
    expect(body.access_token).toBe("secret_token");
    expect(body.data[0].event_name).toBe("CompleteRegistration");
    expect(body.data[0].event_id).toBe("intake_user_abc");
    expect(body.data[0].action_source).toBe("website");
    expect(body.data[0].user_data.em).toEqual([hashEmail("alice@example.com")]);
  });

  it("omits user_data.em when no email is provided", async () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "111222";
    process.env.META_CAPI_ACCESS_TOKEN = "tok";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await sendMetaCapiEvent({ eventName: META_EVENT.PURCHASE, value: 12, currency: "usd" });

    const bodyText = String(
      (fetchSpy.mock.calls[0][1] as RequestInit).body,
    );
    const body = JSON.parse(bodyText) as {
      data: Array<{
        user_data: Record<string, unknown>;
        custom_data?: { value?: number; currency?: string };
      }>;
    };
    expect(body.data[0].user_data.em).toBeUndefined();
    expect(body.data[0].custom_data?.value).toBe(12);
    expect(body.data[0].custom_data?.currency).toBe("usd");
  });

  it("resolves without throwing when Meta responds with an error", async () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "111222";
    process.env.META_CAPI_ACCESS_TOKEN = "tok";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"error":{"message":"bad token"}}', { status: 400 }),
    );

    await expect(
      sendMetaCapiEvent({ eventName: META_EVENT.LEAD }),
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing when fetch itself rejects", async () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "111222";
    process.env.META_CAPI_ACCESS_TOKEN = "tok";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(
      sendMetaCapiEvent({ eventName: META_EVENT.LEAD }),
    ).resolves.toBeUndefined();
  });
});
