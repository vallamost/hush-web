/**
 * Test/dev-only E2EE diagnostic surface for the Playwright media suite
 * (HUSHHQ-107). Exposes counters/epoch/index ONLY: never frame keys, exporter
 * secrets, private keys, or plaintext (CORE-INVARIANTS voice/MLS). Attached to
 * window only when the diag flag is set, so production bundles never define it.
 */

const AES_KEY_INDEX_MODULUS = 256;

/** @returns {boolean} true when the build/runtime opted into diagnostics. */
export function isE2eeDiagnosticsEnabled() {
  try {
    return import.meta.env?.VITE_E2E_DIAG === '1';
  } catch {
    return false;
  }
}

/**
 * Installs window.__hushE2eeStats when enabled. Idempotent.
 * @param {boolean} enabled
 */
export function installE2eeDiagnostics(enabled) {
  if (!enabled) return;
  if (typeof window === 'undefined') return;
  if (window.__hushE2eeStats) return;
  window.__hushE2eeStats = {
    decryptFailures: 0,
    mediaKeyEpoch: -1,
    keyIndex: -1,
    lastError: null,
  };
}

/** Records the MLS epoch a freshly applied media key derives from. */
export function recordKeyEpoch(epoch) {
  const stats = typeof window !== 'undefined' && window.__hushE2eeStats;
  if (!stats) return;
  stats.mediaKeyEpoch = epoch;
  stats.keyIndex = epoch % AES_KEY_INDEX_MODULUS;
}

/** Records a FrameCryptor decrypt failure. errorName must contain no key material. */
export function recordDecryptFailure(errorName) {
  const stats = typeof window !== 'undefined' && window.__hushE2eeStats;
  if (!stats) return;
  stats.decryptFailures += 1;
  stats.lastError = String(errorName ?? 'unknown');
}
