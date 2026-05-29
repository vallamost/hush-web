// Post-handshake compatibility check.
//
// Called after every `getHandshake` (boot + per-instance reconnect). Inspects
// the handshake payload for two breaking conditions:
//
//   1. The server's `min_client_version` is newer than this client's
//      semantic version. The client should not attempt any further protocol
//      work; an Update Required dialog is raised.
//
//   2. The server advertises a `current_mls_ciphersuite` that does not match
//      the client's `CURRENT_MLS_CIPHERSUITE`. Continuing would risk MLS
//      state corruption on either side, so we raise Update Required.
//
// `evaluateHandshakeCompatibility` is synchronous and side-effect-only: it
// dispatches the global `hush:update-required` event and returns the reason
// (or null). The dispatch happens before any caller can throw, so the
// dialog still surfaces under a fail-closed boot path.
//
// `assertHandshakeCompatible` is the boot-side helper that pairs the
// dispatch with a fail-closed throw of `HandshakeCompatibilityError`.
// Every code path that opens auth/WS for an instance MUST go through it.

import { getHandshake } from "./api";
import { CLIENT_VERSION, isClientBelowMinimum } from "./clientVersion";
import { CURRENT_MLS_CIPHERSUITE } from "./mlsCiphersuite";
import { requestUpdate } from "./updateRequired";
import { evaluateServerStaleness } from "./staleServer";

export type HandshakeCompatibilityReason =
  | "min-client-version"
  | "ciphersuite-mismatch";

/**
 * Thrown by `assertHandshakeCompatible` when the server handshake fails the
 * compatibility check. Carries the dispatched reason so boot callers can
 * skip auth/WS work and outer fallback paths can detect the mismatch
 * without string-sniffing the error message.
 */
export class HandshakeCompatibilityError extends Error {
  readonly reason: HandshakeCompatibilityReason;

  constructor(reason: HandshakeCompatibilityReason) {
    super(`Update required (${reason})`);
    this.name = "HandshakeCompatibilityError";
    this.reason = reason;
  }
}

/**
 * Type guard for callers that catch a generic `unknown` and need to branch
 * the fallback path on compatibility mismatches.
 */
export function isHandshakeCompatibilityError(
  err: unknown,
): err is HandshakeCompatibilityError {
  return err instanceof HandshakeCompatibilityError;
}

interface HandshakeShape {
  min_client_version?: string | null;
  current_mls_ciphersuite?: number | null;
}

/**
 * Inspect a handshake response and dispatch `hush:update-required` when any
 * compatibility constraint fails.
 *
 * Returns the dispatched reason (or null) so callers can chain telemetry.
 *
 * Tolerant of:
 *   - Missing fields (pre-X-Wing server, older deployment): no event.
 *   - Unparseable `min_client_version`: no event.
 * Failing closed on these would lock users out of older instances during
 * staged rollouts.
 */
export function evaluateHandshakeCompatibility(
  handshake: HandshakeShape | null | undefined,
): HandshakeCompatibilityReason | null {
  if (!handshake) return null;

  if (isClientBelowMinimum(handshake.min_client_version)) {
    requestUpdate({
      reason: "min-client-version",
      context: {
        required: handshake.min_client_version,
        running: CLIENT_VERSION,
      },
    });
    return "min-client-version";
  }

  const declared = handshake.current_mls_ciphersuite;
  if (
    declared !== undefined &&
    declared !== null &&
    declared !== CURRENT_MLS_CIPHERSUITE
  ) {
    requestUpdate({
      reason: "ciphersuite-mismatch",
      context: {
        server: declared,
        client: CURRENT_MLS_CIPHERSUITE,
      },
    });
    return "ciphersuite-mismatch";
  }

  return null;
}

/**
 * Best-effort host extraction for the stale-server notice copy. Returns null
 * when `instanceUrl` cannot be parsed; the notice still renders generically.
 */
function hostFromInstanceUrl(instanceUrl: string): string | null {
  try {
    return new URL(instanceUrl).host;
  } catch {
    return null;
  }
}

/**
 * Boot-side guard. Fetches the public handshake for `instanceUrl`, runs the
 * compatibility check, and throws `HandshakeCompatibilityError` when the
 * server is incompatible. On success returns the raw handshake payload so
 * callers can persist it as part of per-instance runtime state.
 *
 * MUST be called before any auth/WS work for an instance.
 *
 * @throws {HandshakeCompatibilityError} when the handshake reports an
 *   incompatible `min_client_version` or `current_mls_ciphersuite`.
 */
export async function assertHandshakeCompatible(
  instanceUrl: string,
): Promise<HandshakeShape> {
  const handshake = (await getHandshake(instanceUrl)) as HandshakeShape;
  const mismatch = evaluateHandshakeCompatibility(handshake);
  if (mismatch) {
    throw new HandshakeCompatibilityError(mismatch);
  }
  // Non-blocking: an old but compatible server still serves chat. Raise a
  // dismissible notice (never throws) so the user can ask their admin to
  // update, without locking them out of a working instance.
  evaluateServerStaleness(
    handshake as { server_version?: string | null },
    hostFromInstanceUrl(instanceUrl),
  );
  return handshake;
}
