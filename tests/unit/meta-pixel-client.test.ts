/**
 * JOB-328. The browser side pixel wrapper's no op and warn contracts.
 *
 * Two properties matter and neither is "the event went out". This test
 * exists to prove the wrapper cannot break a caller under normal misconfig:
 *
 *  · When `NEXT_PUBLIC_META_PIXEL_ID` is unset, trackMetaPixelEvent must
 *    return without calling window.fbq. Every deployment before Pranav
 *    provisions the env vars is this case.
 *  · When window.fbq is missing (loader blocked, or the base code has not
 *    finished loading yet), trackMetaPixelEvent must return without
 *    throwing. Any exception here would bubble into a useEffect on the
 *    login page and break the sign in form for one paint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  META_EVENT,
  metaPixelId,
  resetMetaPixelWarningsForTests,
  trackMetaPixelEvent,
} from "@/lib/analytics/meta-pixel-client";

const REAL_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetMetaPixelWarningsForTests();
  // Reset window.fbq between cases.
  delete (window as unknown as { fbq?: unknown }).fbq;
});

afterEach(() => {
  vi.restoreAllMocks();
  restore("NEXT_PUBLIC_META_PIXEL_ID", REAL_PIXEL_ID);
  delete (window as unknown as { fbq?: unknown }).fbq;
});

describe("metaPixelId", () => {
  it("returns the trimmed id when NEXT_PUBLIC_META_PIXEL_ID is set", () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "  1234567890  ";
    expect(metaPixelId()).toBe("1234567890");
  });

  it("returns null when unset", () => {
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    expect(metaPixelId()).toBeNull();
  });

  it("returns null when empty string", () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "";
    expect(metaPixelId()).toBeNull();
  });

  it("returns null when only whitespace", () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "   ";
    expect(metaPixelId()).toBeNull();
  });
});

describe("trackMetaPixelEvent", () => {
  it("no ops when pixel id is unset and never touches window.fbq", () => {
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    const fbq = vi.fn();
    (window as unknown as { fbq: unknown }).fbq = fbq;

    trackMetaPixelEvent(META_EVENT.LEAD);

    expect(fbq).not.toHaveBeenCalled();
  });

  it("warns exactly once when pixel id is unset across many calls", () => {
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    trackMetaPixelEvent(META_EVENT.LEAD);
    trackMetaPixelEvent(META_EVENT.PURCHASE);
    trackMetaPixelEvent(META_EVENT.COMPLETE_REGISTRATION);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("no ops when window.fbq is missing and does not throw", () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "1234567890";
    delete (window as unknown as { fbq?: unknown }).fbq;

    expect(() => trackMetaPixelEvent(META_EVENT.LEAD)).not.toThrow();
  });

  it("calls window.fbq('track', name) when configured and fbq exists", () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "1234567890";
    const fbq = vi.fn();
    (window as unknown as { fbq: unknown }).fbq = fbq;

    trackMetaPixelEvent(META_EVENT.LEAD);

    expect(fbq).toHaveBeenCalledTimes(1);
    expect(fbq).toHaveBeenCalledWith("track", "Lead");
  });

  it("passes params through when provided", () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "1234567890";
    const fbq = vi.fn();
    (window as unknown as { fbq: unknown }).fbq = fbq;

    trackMetaPixelEvent(META_EVENT.PURCHASE, { value: 29, currency: "usd" });

    expect(fbq).toHaveBeenCalledWith("track", "Purchase", {
      value: 29,
      currency: "usd",
    });
  });

  it("swallows an error thrown by fbq itself and does not propagate", () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "1234567890";
    const fbq = vi.fn(() => {
      throw new Error("fbq blew up");
    });
    (window as unknown as { fbq: unknown }).fbq = fbq;

    expect(() => trackMetaPixelEvent(META_EVENT.LEAD)).not.toThrow();
  });
});
