/**
 * Tests for stale-server detection. The client reads the server's advertised
 * `server_version` from the handshake and decides whether the instance is
 * running a server older than the client-recommended minimum. Unlike the
 * Update Required path, staleness is non-blocking: it raises a dismissible
 * notice and never throws, so an old-but-working instance stays usable.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MIN_RECOMMENDED_SERVER_VERSION,
  STALE_SERVER_EVENT,
  type StaleServerDetail,
  type StaleServerStorage,
  isServerStale,
  evaluateServerStaleness,
  dismissScope,
  isStaleDismissed,
  markStaleDismissed,
} from "./staleServer";

function memoryStorage(): StaleServerStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

const staleDetail: StaleServerDetail = {
  instanceHost: "chat.example.tld",
  serverVersion: "0.1.0",
  recommended: "0.2.0",
  reason: "below-recommended",
};

function captureStaleEvents(): StaleServerDetail[] {
  const seen: StaleServerDetail[] = [];
  const handler = (ev: Event) => {
    seen.push((ev as CustomEvent<StaleServerDetail>).detail);
  };
  window.addEventListener(STALE_SERVER_EVENT, handler);
  afterEach(() => window.removeEventListener(STALE_SERVER_EVENT, handler));
  return seen;
}

describe("isServerStale", () => {
  it("flags a server below the recommended version", () => {
    expect(isServerStale("0.1.0")).toBe(true);
  });

  it("does not flag a server at the recommended version", () => {
    expect(isServerStale(MIN_RECOMMENDED_SERVER_VERSION)).toBe(false);
  });

  it("does not flag a server newer than the recommended version", () => {
    expect(isServerStale("0.3.0")).toBe(false);
  });

  it("treats a missing server version as stale (pre-envelope server)", () => {
    expect(isServerStale(null)).toBe(true);
    expect(isServerStale(undefined)).toBe(true);
    expect(isServerStale("")).toBe(true);
  });

  it("treats an unparseable server version as stale", () => {
    expect(isServerStale("dev")).toBe(true);
    expect(isServerStale("garbage")).toBe(true);
  });

  it("tolerates a leading v prefix on the server version", () => {
    expect(isServerStale("v0.1.0")).toBe(true);
    expect(isServerStale("v0.2.0")).toBe(false);
  });
});

describe("evaluateServerStaleness", () => {
  it("dispatches a non-blocking notice and returns detail when stale", () => {
    const events = captureStaleEvents();
    const detail = evaluateServerStaleness(
      { server_version: "0.1.0" },
      "chat.example.tld",
    );
    expect(detail).not.toBeNull();
    expect(detail?.reason).toBe("below-recommended");
    expect(detail?.serverVersion).toBe("0.1.0");
    expect(detail?.instanceHost).toBe("chat.example.tld");
    expect(events).toHaveLength(1);
    expect(events[0].recommended).toBe(MIN_RECOMMENDED_SERVER_VERSION);
  });

  it("reports missing-envelope when the server advertises no version", () => {
    const events = captureStaleEvents();
    const detail = evaluateServerStaleness({}, "chat.example.tld");
    expect(detail?.reason).toBe("missing-envelope");
    expect(events).toHaveLength(1);
  });

  it("returns null and dispatches nothing for a current server", () => {
    const events = captureStaleEvents();
    const detail = evaluateServerStaleness(
      { server_version: MIN_RECOMMENDED_SERVER_VERSION },
      "chat.example.tld",
    );
    expect(detail).toBeNull();
    expect(events).toHaveLength(0);
  });

  it("never throws on a null or malformed handshake", () => {
    expect(() => evaluateServerStaleness(null)).not.toThrow();
    expect(() => evaluateServerStaleness(undefined)).not.toThrow();
    expect(() =>
      evaluateServerStaleness({ server_version: 123 as unknown as string }),
    ).not.toThrow();
  });
});

describe("stale-server dismissal persistence", () => {
  it("is not dismissed until marked", () => {
    const storage = memoryStorage();
    expect(isStaleDismissed(staleDetail, storage)).toBe(false);
    markStaleDismissed(staleDetail, storage);
    expect(isStaleDismissed(staleDetail, storage)).toBe(true);
  });

  it("scopes dismissal to instance host and recommended version", () => {
    const storage = memoryStorage();
    markStaleDismissed(staleDetail, storage);
    // Same instance, but this client now recommends a newer server: re-notify.
    expect(
      isStaleDismissed({ ...staleDetail, recommended: "0.3.0" }, storage),
    ).toBe(false);
    // Different instance: independent dismissal.
    expect(
      isStaleDismissed({ ...staleDetail, instanceHost: "other.tld" }, storage),
    ).toBe(false);
  });

  it("derives a stable scope string", () => {
    expect(dismissScope(staleDetail)).toBe("chat.example.tld@0.2.0");
    expect(dismissScope({ ...staleDetail, instanceHost: null })).toBe("?@0.2.0");
  });

  it("markStaleDismissed is idempotent and survives unavailable storage", () => {
    const storage = memoryStorage();
    markStaleDismissed(staleDetail, storage);
    expect(() => markStaleDismissed(staleDetail, storage)).not.toThrow();
    const broken: StaleServerStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => markStaleDismissed(staleDetail, broken)).not.toThrow();
  });
});
