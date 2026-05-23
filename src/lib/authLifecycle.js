export const AUTH_INVALIDATION_REASONS = Object.freeze({
  DEVICE_REVOKED: 'device_revoked',
  SERVER_SESSION_INVALID: 'server_session_invalid',
});

/**
 * Canonical auth/device/vault lifecycle states.
 *
 * The exhaustive set the UI may render. The legacy boolean fields exported by
 * `useAuth` (`needsUnlock`, `hasSession`, `needsPinSetup`, ...) remain
 * available for compatibility; new code should read `lifecycle` instead.
 *
 * Cross-reference: `hush-web/docs/security/auth-device-lifecycle.md`.
 */
export const AUTH_LIFECYCLE_STATES = Object.freeze({
  BOOTING: 'booting',
  UNAUTHENTICATED: 'unauthenticated',
  LOCKED: 'locked',
  PIN_SETUP_REQUIRED: 'pin_setup_required',
  GUEST_AUTHORIZED: 'guest_authorized',
  AUTHORIZED: 'authorized',
  RECOVERY_REQUIRED: 'recovery_required',
  REVOKED: 'revoked',
  WIPING: 'wiping',
  WIPED: 'wiped',
});

export const AUTH_LIFECYCLE_ACTIONS = Object.freeze({
  BLOCK_REVOKED_DEVICE_UNLOCK: 'block_revoked_device_unlock',
  CLEAR_STALE_LOCAL_VAULT_MARKER: 'clear_stale_local_vault_marker',
  DESTROY_REVOKED_DEVICE_STATE: 'destroy_revoked_device_state',
  DISCOVER_LOCAL_VAULT: 'discover_local_vault',
  INVALIDATE_SERVER_SESSION: 'invalidate_server_session',
  KEEP_AUTHENTICATED_SESSION_LOCKED: 'keep_authenticated_session_locked',
  LOCK_LOCAL_VAULT: 'lock_local_vault',
  REJECT_WRONG_PIN: 'reject_wrong_pin',
  RESET_LOCAL_AUTH_STATE: 'reset_local_auth_state',
  RESTORE_LOCKED_LOCAL_VAULT: 'restore_locked_local_vault',
  RESTORE_UNLOCKED_SESSION: 'restore_unlocked_session',
  UNLOCK_LOCAL_VAULT: 'unlock_local_vault',
  WIPE_LOCAL_VAULT_AFTER_PIN_FAILURES: 'wipe_local_vault_after_pin_failures',
});

export const LOCAL_AUTH_RESET_REASONS = Object.freeze({
  BROADCAST_LOGOUT: 'broadcast_logout',
  DEVICE_REVOKED: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED,
  LOGOUT: 'logout',
});

const LOCAL_AUTH_RESET_REASON_SET = new Set(Object.values(LOCAL_AUTH_RESET_REASONS));

export const VAULT_STATES = Object.freeze({
  NONE: 'none',
  LOCKED: 'locked',
  UNLOCKED: 'unlocked',
});

/**
 * Returns the canonical invalidation reason used by the auth lifecycle.
 *
 * @param {string|undefined|null} reason
 * @returns {string}
 */
export function normalizeAuthInvalidationReason(reason) {
  if (reason === AUTH_INVALIDATION_REASONS.DEVICE_REVOKED) {
    return AUTH_INVALIDATION_REASONS.DEVICE_REVOKED;
  }
  return AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID;
}

/**
 * Plans the boot transition when no JWT is present.
 *
 * @param {{ reason?: string }|null|undefined} authInvalidation
 * @returns {{
 *   action: string,
 *   shouldDestroyLocalDeviceState: boolean,
 *   shouldContinueVaultDiscovery: boolean,
 *   nextVaultState: string|null,
 *   nextHasLocalVault: boolean|null,
 * }}
 */
export function planNoTokenStartup(authInvalidation) {
  if (authInvalidation?.reason === AUTH_INVALIDATION_REASONS.DEVICE_REVOKED) {
    return {
      action: AUTH_LIFECYCLE_ACTIONS.DESTROY_REVOKED_DEVICE_STATE,
      shouldDestroyLocalDeviceState: true,
      shouldContinueVaultDiscovery: false,
      nextVaultState: VAULT_STATES.NONE,
      nextHasLocalVault: false,
    };
  }

  return {
    action: AUTH_LIFECYCLE_ACTIONS.DISCOVER_LOCAL_VAULT,
    shouldDestroyLocalDeviceState: false,
    shouldContinueVaultDiscovery: true,
    nextVaultState: null,
    nextHasLocalVault: null,
  };
}

/**
 * Plans a no-token boot after local vault presence has been checked.
 *
 * This covers both localStorage marker checks and IndexedDB recovery checks.
 * The caller still owns marker writes/deletes because the exact key is a
 * storage concern, but the visible auth state is decided here.
 *
 * @param {{
 *   hasAuthInvalidation?: boolean,
 *   vaultExists?: boolean,
 *   vaultCheckFailed?: boolean,
 * }} input
 * @returns {{
 *   action: string,
 *   shouldClearVaultMarker: boolean,
 *   nextVaultState: string,
 *   nextHasLocalVault: boolean,
 * }}
 */
export function planNoTokenLocalVaultBoot({
  hasAuthInvalidation = false,
  vaultExists = false,
  vaultCheckFailed = false,
} = {}) {
  if (hasAuthInvalidation || vaultExists || vaultCheckFailed) {
    return {
      action: AUTH_LIFECYCLE_ACTIONS.RESTORE_LOCKED_LOCAL_VAULT,
      shouldClearVaultMarker: false,
      nextVaultState: VAULT_STATES.LOCKED,
      nextHasLocalVault: true,
    };
  }

  return {
    action: AUTH_LIFECYCLE_ACTIONS.CLEAR_STALE_LOCAL_VAULT_MARKER,
    shouldClearVaultMarker: true,
    nextVaultState: VAULT_STATES.NONE,
    nextHasLocalVault: false,
  };
}

/**
 * Plans an authenticated boot after vault marker/IDB evidence is known.
 *
 * @param {{
 *   hasVaultEvidence?: boolean,
 *   hasEncryptedVaultBlob?: boolean,
 *   vaultCheckFailed?: boolean,
 * }} input
 * @returns {{
 *   action: string,
 *   shouldClearVaultMarker: boolean,
 *   nextVaultState: string,
 *   nextHasLocalVault: boolean,
 * }}
 */
export function planAuthenticatedVaultBoot({
  hasVaultEvidence = false,
  hasEncryptedVaultBlob = false,
  vaultCheckFailed = false,
} = {}) {
  if (!hasVaultEvidence) {
    return {
      action: AUTH_LIFECYCLE_ACTIONS.RESTORE_UNLOCKED_SESSION,
      shouldClearVaultMarker: false,
      nextVaultState: VAULT_STATES.UNLOCKED,
      nextHasLocalVault: false,
    };
  }

  if (hasEncryptedVaultBlob || vaultCheckFailed) {
    return {
      action: AUTH_LIFECYCLE_ACTIONS.RESTORE_LOCKED_LOCAL_VAULT,
      shouldClearVaultMarker: false,
      nextVaultState: VAULT_STATES.LOCKED,
      nextHasLocalVault: true,
    };
  }

  return {
    action: AUTH_LIFECYCLE_ACTIONS.CLEAR_STALE_LOCAL_VAULT_MARKER,
    shouldClearVaultMarker: true,
    nextVaultState: VAULT_STATES.UNLOCKED,
    nextHasLocalVault: false,
  };
}

/**
 * Plans authenticated startup when `/api/auth/me` cannot be reached.
 *
 * Existing behavior keeps the JWT and lands on a locked state while the network
 * is unavailable. The local vault flag still reflects marker presence.
 *
 * @param {{ hasVaultMarker?: boolean }} input
 * @returns {{
 *   action: string,
 *   nextVaultState: string,
 *   nextHasLocalVault: boolean,
 * }}
 */
export function planAuthenticatedSessionFetchFailure({ hasVaultMarker = false } = {}) {
  return {
    action: AUTH_LIFECYCLE_ACTIONS.KEEP_AUTHENTICATED_SESSION_LOCKED,
    nextVaultState: VAULT_STATES.LOCKED,
    nextHasLocalVault: Boolean(hasVaultMarker),
  };
}

/**
 * Plans the transition after the active server session becomes invalid.
 *
 * @param {string|undefined|null} reason
 * @param {{ hasRecoverableVault: boolean }} options
 * @returns {{
 *   action: string,
 *   reason: string,
 *   shouldDestroyLocalDeviceState: boolean,
 *   shouldPersistInvalidation: boolean,
 *   nextVaultState: string,
 *   nextHasLocalVault: boolean,
 * }}
 */
export function planInvalidatedSession(reason, { hasRecoverableVault }) {
  const normalizedReason = normalizeAuthInvalidationReason(reason);

  if (normalizedReason === AUTH_INVALIDATION_REASONS.DEVICE_REVOKED) {
    return {
      action: AUTH_LIFECYCLE_ACTIONS.DESTROY_REVOKED_DEVICE_STATE,
      reason: normalizedReason,
      shouldDestroyLocalDeviceState: true,
      shouldPersistInvalidation: true,
      nextVaultState: VAULT_STATES.NONE,
      nextHasLocalVault: false,
    };
  }

  return {
    action: AUTH_LIFECYCLE_ACTIONS.INVALIDATE_SERVER_SESSION,
    reason: normalizedReason,
    shouldDestroyLocalDeviceState: false,
    shouldPersistInvalidation: true,
    nextVaultState: hasRecoverableVault ? VAULT_STATES.LOCKED : VAULT_STATES.NONE,
    nextHasLocalVault: Boolean(hasRecoverableVault),
  };
}

/**
 * Plans a user-initiated local vault unlock attempt.
 *
 * A revoked-device tombstone is a hard local boundary. Unlocking the vault
 * from that state would let a revoked browser mint a new session from stale
 * IndexedDB data, so the caller must destroy local device state before any PIN
 * verification or challenge-response runs.
 *
 * Any vault-unlock path must call this planner before opening local vault
 * storage. The planner accepts multiple invalidation sources so a revoked
 * signal cannot be hidden by a stale recoverable marker from another source.
 *
 * @param {...({ reason?: string }|null|undefined)} authInvalidations
 * @returns {{
 *   action: string,
 *   shouldDestroyLocalDeviceState: boolean,
 *   reason: string|null,
 * }}
 */
export function planVaultUnlockAttempt(...authInvalidations) {
  const hasRevokedDeviceSignal = authInvalidations.some(
    (authInvalidation) => authInvalidation?.reason === AUTH_INVALIDATION_REASONS.DEVICE_REVOKED,
  );

  if (hasRevokedDeviceSignal) {
    return {
      action: AUTH_LIFECYCLE_ACTIONS.BLOCK_REVOKED_DEVICE_UNLOCK,
      shouldDestroyLocalDeviceState: true,
      reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED,
    };
  }

  return {
    action: AUTH_LIFECYCLE_ACTIONS.UNLOCK_LOCAL_VAULT,
    shouldDestroyLocalDeviceState: false,
    reason: null,
  };
}

/**
 * Plans a non-destructive local vault lock.
 *
 * The caller owns the storage side effects because browser and desktop session
 * stores differ, but the lifecycle result must be identical for timeout and
 * manual locks: private material leaves memory and the UI returns to PIN entry.
 *
 * @returns {{
 *   action: string,
 *   shouldClearIdentity: boolean,
 *   shouldClearSessionKeys: boolean,
 *   shouldClearTranscriptCache: boolean,
 *   nextVaultState: string,
 * }}
 */
export function planLocalVaultLock() {
  return {
    action: AUTH_LIFECYCLE_ACTIONS.LOCK_LOCAL_VAULT,
    shouldClearIdentity: true,
    shouldClearSessionKeys: true,
    shouldClearTranscriptCache: true,
    nextVaultState: VAULT_STATES.LOCKED,
  };
}

/**
 * Plans the outcome of a failed PIN decrypt attempt.
 *
 * @param {{ chargedCount: number, maxFailures: number }} input
 * @returns {{
 *   action: string,
 *   shouldWipeLocalVault: boolean,
 *   shouldClearSession: boolean,
 *   nextVaultState: string|null,
 *   nextHasLocalVault: boolean|null,
 *   remainingAttempts: number,
 *   errorCode: string,
 *   errorMessage: string,
 * }}
 */
export function planPinFailure({ chargedCount, maxFailures }) {
  if (!Number.isInteger(chargedCount) || chargedCount < 0) {
    throw new TypeError('chargedCount must be a non-negative integer');
  }
  if (!Number.isInteger(maxFailures) || maxFailures <= 0) {
    throw new TypeError('maxFailures must be a positive integer');
  }

  const remainingAttempts = Math.max(maxFailures - chargedCount, 0);
  if (remainingAttempts === 0) {
    return {
      action: AUTH_LIFECYCLE_ACTIONS.WIPE_LOCAL_VAULT_AFTER_PIN_FAILURES,
      shouldWipeLocalVault: true,
      shouldClearSession: true,
      nextVaultState: VAULT_STATES.NONE,
      nextHasLocalVault: false,
      remainingAttempts,
      errorCode: 'VAULT_WIPED',
      errorMessage: 'vault wiped after too many failed PIN attempts',
    };
  }

  return {
    action: AUTH_LIFECYCLE_ACTIONS.REJECT_WRONG_PIN,
    shouldWipeLocalVault: false,
    shouldClearSession: false,
    nextVaultState: null,
    nextHasLocalVault: null,
    remainingAttempts,
    errorCode: 'WRONG_PIN',
    errorMessage: `incorrect PIN (${remainingAttempts} attempts remaining)`,
  };
}

/**
 * Plans the in-memory state reset after local auth is no longer trusted.
 *
 * @param {string} reason
 * @returns {{
 *   action: string,
 *   reason: string,
 *   shouldClearIdentity: boolean,
 *   nextToken: null,
 *   nextUser: null,
 *   nextVaultState: string,
 *   nextHasLocalVault: boolean,
 *   nextNeedsPinSetup: boolean,
 *   nextIsGuest: boolean,
 *   nextGuestExpiresAt: null,
 *   nextError: null,
 *   nextLoading: boolean|null,
 *   shouldClearAuthQueries: boolean,
 *   shouldClearGuestTimers: boolean,
 *   shouldClearPinSetupStorage: boolean,
 *   shouldClearSession: boolean,
 *   shouldClearTranscriptCache: boolean,
 *   shouldClearVaultTimeoutEffects: boolean,
 * }}
 */
/**
 * Pure derivation of the canonical auth/device/vault lifecycle state from a
 * snapshot of observable hook state.
 *
 * No side effects, no storage reads, no network. The caller (`useAuth`) is
 * responsible for keeping the snapshot consistent with the underlying storage
 * actions emitted by the other planners in this module.
 *
 * Priority (first match wins):
 *  1. `authInvalidation.reason === device_revoked` → `revoked` (sticky)
 *  2. `wipeInFlight`                          → `wiping`
 *  3. `loading`                               → `booting`
 *  4. Live session (`hasToken && hasUser`):
 *       - `needsPinSetup`                     → `pin_setup_required`
 *       - `isGuest`                           → `guest_authorized`
 *       - `hasLocalVault && !isVaultUnlocked` → `locked`
 *       - otherwise                           → `authorized`
 *  5. No live session:
 *       - `authInvalidation.reason === server_session_invalid`:
 *           - `hasLocalVault`                  → `locked` (PIN retry recovers)
 *           - else                             → `recovery_required`
 *       - `hasLocalVault`                     → `locked`
 *       - `wipedSticky`                       → `wiped`
 *       - else                                → `unauthenticated`
 *
 * A `device_revoked` tombstone outranks every later signal so a stale
 * `server_session_invalid` cannot downgrade it into a recoverable state.
 *
 * @param {{
 *   loading?: boolean,
 *   hasToken?: boolean,
 *   hasUser?: boolean,
 *   hasLocalVault?: boolean,
 *   isVaultUnlocked?: boolean,
 *   authInvalidation?: { reason?: string }|null,
 *   needsPinSetup?: boolean,
 *   isGuest?: boolean,
 *   wipeInFlight?: boolean,
 *   wipedSticky?: boolean,
 * }} snapshot
 * @returns {string} one of AUTH_LIFECYCLE_STATES
 */
export function deriveAuthLifecycle(snapshot = {}) {
  const {
    loading = false,
    hasToken = false,
    hasUser = false,
    hasLocalVault = false,
    isVaultUnlocked = false,
    authInvalidation = null,
    needsPinSetup = false,
    isGuest = false,
    wipeInFlight = false,
    wipedSticky = false,
  } = snapshot;

  if (authInvalidation?.reason === AUTH_INVALIDATION_REASONS.DEVICE_REVOKED) {
    return AUTH_LIFECYCLE_STATES.REVOKED;
  }

  if (wipeInFlight) return AUTH_LIFECYCLE_STATES.WIPING;

  if (loading) return AUTH_LIFECYCLE_STATES.BOOTING;

  const hasSession = Boolean(hasToken && hasUser);

  if (hasSession) {
    if (needsPinSetup) return AUTH_LIFECYCLE_STATES.PIN_SETUP_REQUIRED;
    if (isGuest) return AUTH_LIFECYCLE_STATES.GUEST_AUTHORIZED;
    if (hasLocalVault && !isVaultUnlocked) return AUTH_LIFECYCLE_STATES.LOCKED;
    return AUTH_LIFECYCLE_STATES.AUTHORIZED;
  }

  if (authInvalidation?.reason === AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID) {
    if (hasLocalVault) return AUTH_LIFECYCLE_STATES.LOCKED;
    return AUTH_LIFECYCLE_STATES.RECOVERY_REQUIRED;
  }

  if (hasLocalVault) return AUTH_LIFECYCLE_STATES.LOCKED;
  if (wipedSticky) return AUTH_LIFECYCLE_STATES.WIPED;
  return AUTH_LIFECYCLE_STATES.UNAUTHENTICATED;
}

export function planLocalAuthReset(reason = LOCAL_AUTH_RESET_REASONS.LOGOUT) {
  if (!LOCAL_AUTH_RESET_REASON_SET.has(reason)) {
    throw new TypeError(`unknown local auth reset reason: ${reason}`);
  }

  return {
    action: AUTH_LIFECYCLE_ACTIONS.RESET_LOCAL_AUTH_STATE,
    reason,
    shouldClearIdentity: true,
    nextToken: null,
    nextUser: null,
    nextVaultState: VAULT_STATES.NONE,
    nextHasLocalVault: false,
    nextNeedsPinSetup: false,
    nextIsGuest: false,
    nextGuestExpiresAt: null,
    nextError: null,
    nextLoading: reason === LOCAL_AUTH_RESET_REASONS.LOGOUT ? false : null,
    shouldClearAuthQueries: true,
    shouldClearGuestTimers: true,
    shouldClearPinSetupStorage: true,
    shouldClearSession: reason !== LOCAL_AUTH_RESET_REASONS.LOGOUT,
    shouldClearTranscriptCache: reason !== LOCAL_AUTH_RESET_REASONS.BROADCAST_LOGOUT,
    shouldClearVaultTimeoutEffects: true,
  };
}
