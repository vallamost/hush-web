// Stale-server detection.
//
// The server advertises its `server_version` in the public handshake. This
// module decides whether an instance is running a server older than the
// client-recommended minimum and, when so, raises a non-blocking notice.
//
// Why non-blocking (unlike src/lib/updateRequired.ts): an old-but-running
// server still serves end-to-end encrypted chat. Locking the user out would
// punish them for an operator's deferred upgrade. Instead we surface a
// dismissible banner advising them to ask the admin to update, and let the
// session continue. This module never throws and never touches the vault,
// MLS state, credentials, or the instance origin (see CORE-INVARIANTS:
// Federation, Instance Routing, and Credential Boundaries).

import { compareSemverStrings } from "./clientVersion";

/**
 * Lowest server version this client considers current. Servers below this
 * (or advertising no version at all) are flagged as stale. Bump in lockstep
 * with the server release that ships fixes this client expects.
 */
export const MIN_RECOMMENDED_SERVER_VERSION = "0.2.0";

/** DOM event name for the non-blocking stale-server notice. */
export const STALE_SERVER_EVENT = "hush:server-stale";

export type StaleServerReason = "below-recommended" | "missing-envelope";

export interface StaleServerDetail {
  /** Host of the instance whose server is stale, for the banner copy. */
  instanceHost: string | null;
  /** The server's advertised version, or null when it advertised none. */
  serverVersion: string | null;
  /** The version this client recommends the server be at or above. */
  recommended: string;
  /** Why the server was flagged, for telemetry and banner copy. */
  reason: StaleServerReason;
}

/** Minimal shape of the handshake fields this module reads. */
interface HandshakeShape {
  server_version?: string | null;
}

/**
 * Returns true when `serverVersion` is older than `recommended`, missing, or
 * unparseable. A missing or unparseable version means a pre-envelope or very
 * old server, which is treated as stale.
 */
export function isServerStale(
  serverVersion: string | null | undefined,
  recommended: string = MIN_RECOMMENDED_SERVER_VERSION,
): boolean {
  if (!serverVersion) return true;
  const cmp = compareSemverStrings(serverVersion, recommended);
  if (cmp === null) return true;
  return cmp < 0;
}

/**
 * Inspect a handshake and, when the server is stale, dispatch the global
 * non-blocking `hush:server-stale` event and return the detail. Returns null
 * for a current server. Tolerates a null, undefined, or malformed handshake
 * without throwing, so a failure here can never block instance boot.
 */
export function evaluateServerStaleness(
  handshake: HandshakeShape | null | undefined,
  instanceHost: string | null = null,
): StaleServerDetail | null {
  const rawVersion = handshake?.server_version;
  const serverVersion = typeof rawVersion === "string" ? rawVersion : null;

  if (!isServerStale(serverVersion)) return null;

  const detail: StaleServerDetail = {
    instanceHost,
    serverVersion,
    recommended: MIN_RECOMMENDED_SERVER_VERSION,
    reason: serverVersion ? "below-recommended" : "missing-envelope",
  };

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<StaleServerDetail>(STALE_SERVER_EVENT, { detail }),
    );
  }
  return detail;
}

// Dismissal persistence. A dismissal is scoped to instance host + recommended
// version, so the banner stays quiet for an instance the user acknowledged but
// re-appears once this client recommends a newer server than before.

/** Storage key holding the JSON array of dismissed stale-server scopes. */
export const DISMISSED_STORAGE_KEY = "hush.staleServer.dismissed";

/** Minimal storage contract so tests can inject an in-memory fake. */
export interface StaleServerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Stable per-instance, per-recommended dismissal scope. */
export function dismissScope(detail: StaleServerDetail): string {
  return `${detail.instanceHost ?? "?"}@${detail.recommended}`;
}

function readDismissed(storage: StaleServerStorage): Set<string> {
  const raw = storage.getItem(DISMISSED_STORAGE_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

/** True when this exact instance + recommended scope was already dismissed. */
export function isStaleDismissed(
  detail: StaleServerDetail,
  storage: StaleServerStorage,
): boolean {
  return readDismissed(storage).has(dismissScope(detail));
}

/** Persist a dismissal for this instance + recommended scope. Idempotent. */
export function markStaleDismissed(
  detail: StaleServerDetail,
  storage: StaleServerStorage,
): void {
  const scope = dismissScope(detail);
  const current = readDismissed(storage);
  if (current.has(scope)) return;
  current.add(scope);
  try {
    storage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...current]));
  } catch {
    /* storage unavailable (private mode/quota); dismissal is best-effort */
  }
}
