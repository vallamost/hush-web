import { describe, expect, it } from 'vitest';
import {
  AUTH_INVALIDATION_REASONS,
  AUTH_LIFECYCLE_ACTIONS,
  AUTH_LIFECYCLE_STATES,
  LOCAL_AUTH_RESET_REASONS,
  VAULT_STATES,
  deriveAuthLifecycle,
  normalizeAuthInvalidationReason,
  planInvalidatedSession,
  planAuthenticatedSessionFetchFailure,
  planAuthenticatedVaultBoot,
  planLocalAuthReset,
  planLocalVaultLock,
  planNoTokenLocalVaultBoot,
  planNoTokenStartup,
  planPinFailure,
  planVaultUnlockAttempt,
} from './authLifecycle';

describe('authLifecycle', () => {
  it('normalizes unknown invalidation reasons to recoverable server invalidation', () => {
    expect(normalizeAuthInvalidationReason('network_stale')).toBe(
      AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID,
    );
  });

  it('normalizes empty invalidation reasons to recoverable server invalidation', () => {
    expect(normalizeAuthInvalidationReason(null)).toBe(
      AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID,
    );
    expect(normalizeAuthInvalidationReason('')).toBe(
      AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID,
    );
  });

  it('plans destructive boot when a revoked-device tombstone exists', () => {
    const plan = planNoTokenStartup({
      reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED,
    });

    expect(plan).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.DESTROY_REVOKED_DEVICE_STATE,
      shouldDestroyLocalDeviceState: true,
      shouldContinueVaultDiscovery: false,
      nextVaultState: VAULT_STATES.NONE,
      nextHasLocalVault: false,
    });
  });

  it('allows normal vault discovery when no revoked-device tombstone exists', () => {
    const plan = planNoTokenStartup({
      reason: AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID,
    });

    expect(plan.shouldDestroyLocalDeviceState).toBe(false);
    expect(plan.shouldContinueVaultDiscovery).toBe(true);
    expect(plan.nextVaultState).toBeNull();
  });

  it('plans locked recovery when no-token boot finds a vault', () => {
    expect(planNoTokenLocalVaultBoot({ vaultExists: true })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.RESTORE_LOCKED_LOCAL_VAULT,
      shouldClearVaultMarker: false,
      nextVaultState: VAULT_STATES.LOCKED,
      nextHasLocalVault: true,
    });
  });

  it('plans locked recovery when no-token vault check fails', () => {
    expect(planNoTokenLocalVaultBoot({ vaultCheckFailed: true })).toMatchObject({
      action: AUTH_LIFECYCLE_ACTIONS.RESTORE_LOCKED_LOCAL_VAULT,
      nextVaultState: VAULT_STATES.LOCKED,
      nextHasLocalVault: true,
    });
  });

  it('plans locked recovery when no-token boot has an auth invalidation marker', () => {
    expect(planNoTokenLocalVaultBoot({ hasAuthInvalidation: true })).toMatchObject({
      action: AUTH_LIFECYCLE_ACTIONS.RESTORE_LOCKED_LOCAL_VAULT,
      nextVaultState: VAULT_STATES.LOCKED,
      nextHasLocalVault: true,
    });
  });

  it('plans stale marker cleanup when no-token boot finds no vault', () => {
    expect(planNoTokenLocalVaultBoot({ vaultExists: false })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.CLEAR_STALE_LOCAL_VAULT_MARKER,
      shouldClearVaultMarker: true,
      nextVaultState: VAULT_STATES.NONE,
      nextHasLocalVault: false,
    });
  });

  it('plans authenticated boot without vault evidence as unlocked without local vault', () => {
    expect(planAuthenticatedVaultBoot({ hasVaultEvidence: false })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.RESTORE_UNLOCKED_SESSION,
      shouldClearVaultMarker: false,
      nextVaultState: VAULT_STATES.UNLOCKED,
      nextHasLocalVault: false,
    });
  });

  it('plans authenticated boot with an encrypted vault blob as locked', () => {
    expect(planAuthenticatedVaultBoot({
      hasVaultEvidence: true,
      hasEncryptedVaultBlob: true,
    })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.RESTORE_LOCKED_LOCAL_VAULT,
      shouldClearVaultMarker: false,
      nextVaultState: VAULT_STATES.LOCKED,
      nextHasLocalVault: true,
    });
  });

  it('plans authenticated boot with a stale vault marker as unlocked', () => {
    expect(planAuthenticatedVaultBoot({
      hasVaultEvidence: true,
      hasEncryptedVaultBlob: false,
    })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.CLEAR_STALE_LOCAL_VAULT_MARKER,
      shouldClearVaultMarker: true,
      nextVaultState: VAULT_STATES.UNLOCKED,
      nextHasLocalVault: false,
    });
  });

  it('plans authenticated boot vault-check failure as locked', () => {
    expect(planAuthenticatedVaultBoot({
      hasVaultEvidence: true,
      vaultCheckFailed: true,
    })).toMatchObject({
      action: AUTH_LIFECYCLE_ACTIONS.RESTORE_LOCKED_LOCAL_VAULT,
      nextVaultState: VAULT_STATES.LOCKED,
      nextHasLocalVault: true,
    });
  });

  it('keeps authenticated session locked after /me fetch failure', () => {
    expect(planAuthenticatedSessionFetchFailure({ hasVaultMarker: true })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.KEEP_AUTHENTICATED_SESSION_LOCKED,
      nextVaultState: VAULT_STATES.LOCKED,
      nextHasLocalVault: true,
    });
    expect(planAuthenticatedSessionFetchFailure({ hasVaultMarker: false })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.KEEP_AUTHENTICATED_SESSION_LOCKED,
      nextVaultState: VAULT_STATES.LOCKED,
      nextHasLocalVault: false,
    });
  });

  it('keeps a recoverable local vault locked after generic session invalidation', () => {
    const plan = planInvalidatedSession(
      AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID,
      { hasRecoverableVault: true },
    );

    expect(plan).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.INVALIDATE_SERVER_SESSION,
      reason: AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID,
      shouldDestroyLocalDeviceState: false,
      shouldPersistInvalidation: true,
      nextVaultState: VAULT_STATES.LOCKED,
      nextHasLocalVault: true,
    });
  });

  it('destroys local device state after device revocation', () => {
    const plan = planInvalidatedSession(
      AUTH_INVALIDATION_REASONS.DEVICE_REVOKED,
      { hasRecoverableVault: true },
    );

    expect(plan).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.DESTROY_REVOKED_DEVICE_STATE,
      reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED,
      shouldDestroyLocalDeviceState: true,
      shouldPersistInvalidation: true,
      nextVaultState: VAULT_STATES.NONE,
      nextHasLocalVault: false,
    });
  });

  it('blocks PIN unlock when a revoked-device tombstone exists', () => {
    expect(planVaultUnlockAttempt({
      reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED,
    })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.BLOCK_REVOKED_DEVICE_UNLOCK,
      shouldDestroyLocalDeviceState: true,
      reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED,
    });
  });

  it('blocks PIN unlock when any invalidation source reports device revocation', () => {
    expect(
      planVaultUnlockAttempt(
        { reason: AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID },
        { reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED },
      ),
    ).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.BLOCK_REVOKED_DEVICE_UNLOCK,
      shouldDestroyLocalDeviceState: true,
      reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED,
    });

    expect(
      planVaultUnlockAttempt(
        { reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED },
        { reason: AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID },
      ),
    ).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.BLOCK_REVOKED_DEVICE_UNLOCK,
      shouldDestroyLocalDeviceState: true,
      reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED,
    });
  });

  it('allows PIN unlock when no revoked-device tombstone exists', () => {
    expect(planVaultUnlockAttempt({
      reason: AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID,
    })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.UNLOCK_LOCAL_VAULT,
      shouldDestroyLocalDeviceState: false,
      reason: null,
    });
  });

  it('plans a local vault lock without destructive local state changes', () => {
    expect(planLocalVaultLock()).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.LOCK_LOCAL_VAULT,
      shouldClearIdentity: true,
      shouldClearSessionKeys: true,
      shouldClearTranscriptCache: true,
      nextVaultState: VAULT_STATES.LOCKED,
    });
  });

  it('plans wrong-PIN rejection before the failure threshold', () => {
    expect(planPinFailure({ chargedCount: 3, maxFailures: 10 })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.REJECT_WRONG_PIN,
      shouldWipeLocalVault: false,
      shouldClearSession: false,
      nextVaultState: null,
      nextHasLocalVault: null,
      remainingAttempts: 7,
      errorCode: 'WRONG_PIN',
      errorMessage: 'incorrect PIN (7 attempts remaining)',
    });
  });

  it('plans local vault wipe at the PIN failure threshold', () => {
    expect(planPinFailure({ chargedCount: 10, maxFailures: 10 })).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.WIPE_LOCAL_VAULT_AFTER_PIN_FAILURES,
      shouldWipeLocalVault: true,
      shouldClearSession: true,
      nextVaultState: VAULT_STATES.NONE,
      nextHasLocalVault: false,
      remainingAttempts: 0,
      errorCode: 'VAULT_WIPED',
      errorMessage: 'vault wiped after too many failed PIN attempts',
    });
  });

  it('rejects invalid PIN failure counters', () => {
    expect(() => planPinFailure({ chargedCount: -1, maxFailures: 10 })).toThrow(TypeError);
    expect(() => planPinFailure({ chargedCount: 1, maxFailures: 0 })).toThrow(TypeError);
  });

  it('plans a full local auth reset', () => {
    expect(planLocalAuthReset(LOCAL_AUTH_RESET_REASONS.LOGOUT)).toEqual({
      action: AUTH_LIFECYCLE_ACTIONS.RESET_LOCAL_AUTH_STATE,
      reason: LOCAL_AUTH_RESET_REASONS.LOGOUT,
      shouldClearIdentity: true,
      nextToken: null,
      nextUser: null,
      nextVaultState: VAULT_STATES.NONE,
      nextHasLocalVault: false,
      nextNeedsPinSetup: false,
      nextIsGuest: false,
      nextGuestExpiresAt: null,
      nextError: null,
      nextLoading: false,
      shouldClearAuthQueries: true,
      shouldClearGuestTimers: true,
      shouldClearPinSetupStorage: true,
      shouldClearSession: false,
      shouldClearTranscriptCache: true,
      shouldClearVaultTimeoutEffects: true,
    });
  });

  it('plans broadcast logout without destructive local transcript cleanup', () => {
    expect(planLocalAuthReset(LOCAL_AUTH_RESET_REASONS.BROADCAST_LOGOUT)).toMatchObject({
      reason: LOCAL_AUTH_RESET_REASONS.BROADCAST_LOGOUT,
      nextLoading: null,
      shouldClearAuthQueries: true,
      shouldClearGuestTimers: true,
      shouldClearSession: true,
      shouldClearTranscriptCache: false,
      shouldClearVaultTimeoutEffects: true,
    });
  });

  it('plans revoked-device reset with destructive local cleanup', () => {
    expect(planLocalAuthReset(LOCAL_AUTH_RESET_REASONS.DEVICE_REVOKED)).toMatchObject({
      reason: LOCAL_AUTH_RESET_REASONS.DEVICE_REVOKED,
      nextLoading: null,
      shouldClearAuthQueries: true,
      shouldClearGuestTimers: true,
      shouldClearSession: true,
      shouldClearTranscriptCache: true,
      shouldClearVaultTimeoutEffects: true,
    });
  });

  it('rejects unknown local auth reset reasons', () => {
    expect(() => planLocalAuthReset('logoff')).toThrow(TypeError);
  });
});

// HUSHHQ-15: canonical auth/device/vault lifecycle derivation.
// See `hush-web/docs/security/auth-device-lifecycle.md` for the contract.
describe('deriveAuthLifecycle', () => {
  it('returns booting while auth is rehydrating', () => {
    expect(deriveAuthLifecycle({ loading: true })).toBe(
      AUTH_LIFECYCLE_STATES.BOOTING,
    );
  });

  it('returns unauthenticated for a clean session-free snapshot', () => {
    expect(deriveAuthLifecycle({})).toBe(AUTH_LIFECYCLE_STATES.UNAUTHENTICATED);
  });

  it('returns authorized for a live session with unlocked vault', () => {
    expect(
      deriveAuthLifecycle({
        hasToken: true,
        hasUser: true,
        hasLocalVault: true,
        isVaultUnlocked: true,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.AUTHORIZED);
  });

  it('returns authorized for a live session without a local vault', () => {
    expect(
      deriveAuthLifecycle({
        hasToken: true,
        hasUser: true,
        hasLocalVault: false,
        isVaultUnlocked: false,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.AUTHORIZED);
  });

  it('returns locked for a live session whose vault is still locked', () => {
    expect(
      deriveAuthLifecycle({
        hasToken: true,
        hasUser: true,
        hasLocalVault: true,
        isVaultUnlocked: false,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.LOCKED);
  });

  it('returns pin_setup_required when a session exists but PIN setup is pending', () => {
    expect(
      deriveAuthLifecycle({
        hasToken: true,
        hasUser: true,
        needsPinSetup: true,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.PIN_SETUP_REQUIRED);
  });

  it('returns guest_authorized for a live guest session', () => {
    expect(
      deriveAuthLifecycle({
        hasToken: true,
        hasUser: true,
        isGuest: true,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.GUEST_AUTHORIZED);
  });

  it('returns locked for a no-token boot that found a recoverable vault', () => {
    expect(
      deriveAuthLifecycle({
        hasToken: false,
        hasUser: false,
        hasLocalVault: true,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.LOCKED);
  });

  it('returns revoked when a device-revoked tombstone is present', () => {
    expect(
      deriveAuthLifecycle({
        authInvalidation: { reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED },
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.REVOKED);
  });

  it('keeps the device-revoked tombstone sticky even with a live session', () => {
    // A revoked tombstone is sticky and destructive. A stale in-memory
    // session/JWT must not promote it back to authorized.
    expect(
      deriveAuthLifecycle({
        hasToken: true,
        hasUser: true,
        hasLocalVault: true,
        isVaultUnlocked: true,
        authInvalidation: { reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED },
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.REVOKED);
  });

  it('cannot be downgraded from revoked to server_session_invalid', () => {
    // Two competing invalidation signals: the older device_revoked tombstone
    // must outrank a later generic server_session_invalid.
    expect(
      deriveAuthLifecycle({
        authInvalidation: { reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED },
        hasLocalVault: true,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.REVOKED);

    expect(
      deriveAuthLifecycle({
        authInvalidation: { reason: AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID },
        hasLocalVault: true,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.LOCKED);
  });

  it('returns locked after server_session_invalid when a recoverable vault remains', () => {
    expect(
      deriveAuthLifecycle({
        authInvalidation: { reason: AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID },
        hasLocalVault: true,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.LOCKED);
  });

  it('returns recovery_required after server_session_invalid with no recoverable vault', () => {
    expect(
      deriveAuthLifecycle({
        authInvalidation: { reason: AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID },
        hasLocalVault: false,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.RECOVERY_REQUIRED);
  });

  it('returns wiping while a destructive vault wipe is in progress', () => {
    // wipeInFlight outranks normal session signals, including a live session.
    expect(
      deriveAuthLifecycle({
        wipeInFlight: true,
        hasToken: true,
        hasUser: true,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.WIPING);
  });

  it('keeps device_revoked above an in-flight wipe', () => {
    expect(
      deriveAuthLifecycle({
        wipeInFlight: true,
        authInvalidation: { reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED },
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.REVOKED);
  });

  it('returns wiped (sticky) immediately after a destructive wipe completes', () => {
    expect(
      deriveAuthLifecycle({
        hasLocalVault: false,
        wipedSticky: true,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.WIPED);
  });

  it('falls through to unauthenticated after the wiped marker clears', () => {
    expect(
      deriveAuthLifecycle({
        hasLocalVault: false,
        wipedSticky: false,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.UNAUTHENTICATED);
  });

  it('a max-PIN-failure wipe plan produces inputs that do not preserve a PIN-resumable vault', () => {
    // After the planner says "wipe", the caller is expected to:
    //   - hasLocalVault: false
    //   - clear authInvalidation (no session_invalid promotion)
    //   - clear isVaultUnlocked
    // The canonical lifecycle must then land in wiped (if the sticky
    // marker is set) or unauthenticated, NEVER locked.
    const wipePlan = planPinFailure({ chargedCount: 10, maxFailures: 10 });
    expect(wipePlan.shouldWipeLocalVault).toBe(true);
    expect(wipePlan.nextHasLocalVault).toBe(false);
    expect(wipePlan.nextVaultState).toBe(VAULT_STATES.NONE);

    // Snapshot reflecting the post-wipe state with the sticky marker.
    expect(
      deriveAuthLifecycle({
        hasLocalVault: wipePlan.nextHasLocalVault,
        wipedSticky: true,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.WIPED);

    // Same post-wipe state without the sticky marker collapses to unauth.
    expect(
      deriveAuthLifecycle({
        hasLocalVault: wipePlan.nextHasLocalVault,
        wipedSticky: false,
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.UNAUTHENTICATED);

    // Crucially: even if a stale server_session_invalid lingered, the
    // post-wipe snapshot must NOT route back to a PIN-resumable locked
    // vault, because hasLocalVault is false.
    expect(
      deriveAuthLifecycle({
        hasLocalVault: wipePlan.nextHasLocalVault,
        authInvalidation: { reason: AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID },
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.RECOVERY_REQUIRED);
  });

  it('a no-token boot with a persisted device_revoked tombstone returns revoked, not locked', () => {
    // Even if a leftover IDB vault blob still exists, a no-token boot
    // with a device_revoked tombstone must not surface the PIN screen.
    // The lifecycle returns revoked; the consumer is then required to
    // run destructive cleanup.
    expect(
      deriveAuthLifecycle({
        loading: false,
        hasToken: false,
        hasUser: false,
        hasLocalVault: true,
        authInvalidation: { reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED },
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.REVOKED);

    // Same snapshot with no remaining vault still reports revoked
    // until the consumer clears the tombstone.
    expect(
      deriveAuthLifecycle({
        loading: false,
        hasToken: false,
        hasUser: false,
        hasLocalVault: false,
        authInvalidation: { reason: AUTH_INVALIDATION_REASONS.DEVICE_REVOKED },
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.REVOKED);
  });

  it('treats null / undefined authInvalidation as no signal', () => {
    expect(
      deriveAuthLifecycle({ hasToken: true, hasUser: true, authInvalidation: null }),
    ).toBe(AUTH_LIFECYCLE_STATES.AUTHORIZED);
    expect(
      deriveAuthLifecycle({ hasToken: true, hasUser: true, authInvalidation: undefined }),
    ).toBe(AUTH_LIFECYCLE_STATES.AUTHORIZED);
  });

  it('rejects an unknown invalidation reason by treating it as no signal', () => {
    // Unknown reasons must not be silently coerced to revoked. Lifecycle
    // surface should fall through to the standard session/vault logic.
    expect(
      deriveAuthLifecycle({
        hasToken: true,
        hasUser: true,
        authInvalidation: { reason: 'something_else' },
      }),
    ).toBe(AUTH_LIFECYCLE_STATES.AUTHORIZED);
  });

  it('exposes the complete canonical state set including the HUSHHQ-15 minimum', () => {
    // Tripwire: future edits must not silently delete a state from
    // the canonical surface. Every state required by HUSHHQ-15 plus
    // the unambiguous internal states must remain exported.
    const required = [
      'booting',
      'unauthenticated',
      'locked',
      'pin_setup_required',
      'guest_authorized',
      'authorized',
      'recovery_required',
      'revoked',
      'wiping',
      'wiped',
    ];
    for (const value of required) {
      expect(Object.values(AUTH_LIFECYCLE_STATES)).toContain(value);
    }
  });
});
