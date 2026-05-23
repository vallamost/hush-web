/**
 * useBootController - single source of truth for the app startup sequence.
 *
 * Derives one atomic bootState from useAuth (vault/session/PIN-setup state)
 * and useInstances (guild loading). Every rendering decision in the app flows
 * from this state. No other component independently checks auth, vault, or
 * guild loading to decide what to display.
 *
 * Boot states (sequential, deterministic):
 *
 *   'loading'             - auth is rehydrating (IDB/JWT check in progress)
 *   'needs_login'         - no session, no vault - show login/register
 *   'needs_pin'           - vault exists but locked - show PIN screen
 *   'pin_setup'           - just registered/recovered, PIN setup prompt before proceeding
 *   'transparency_error'  - authenticated + unlocked, but own-key transparency
 *                           verification failed; block the app with a
 *                           full-screen security failure UI
 *   'ready'               - authenticated, identity key available, instances booting
 *   'booted'              - authenticated, instances connected, guilds loaded
 *
 * Priority: needs_pin > pin_setup > transparency_error > ready > booted. A
 * non-null `transparencyError` must not preempt the local vault/PIN state.
 *
 * The BootController is exposed via context so AppContent can consume a single
 * boot-state value without duplicating auth/loading checks.
 *
 * @module useBootController
 */

import { createContext, useContext, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useInstanceContext } from '../contexts/InstanceContext.jsx';
import { AUTH_LIFECYCLE_STATES } from '../lib/authLifecycle.js';

const BootContext = createContext(null);

/**
 * Provider that runs the boot state machine. Mount inside AuthProvider and
 * InstanceProvider so the underlying hooks are available.
 *
 * @param {{ children: React.ReactNode }} props
 */
export function BootProvider({ children }) {
  const {
    loading: authLoading,
    needsUnlock,
    hasSession,
    needsPinSetup,
    transparencyError,
    lifecycle,
    user,
  } = useAuth();

  const {
    guildsLoaded,
    mergedGuilds,
  } = useInstanceContext();

  const bootState = useMemo(() => {
    // Lifecycle gates first: destructive / recovery-required states must
    // never reach the authenticated route tree, even if some legacy
    // boolean lags behind. See
    // `hush-web/docs/security/auth-device-lifecycle.md` for the contract.
    if (lifecycle === AUTH_LIFECYCLE_STATES.WIPING) return 'loading';
    if (
      lifecycle === AUTH_LIFECYCLE_STATES.REVOKED
      || lifecycle === AUTH_LIFECYCLE_STATES.WIPED
      || lifecycle === AUTH_LIFECYCLE_STATES.RECOVERY_REQUIRED
    ) {
      return 'needs_login';
    }

    // Step 1: auth still rehydrating - block everything.
    if (authLoading) return 'loading';

    // Step 1b/2: vault locked - need PIN before anything else.
    if (needsUnlock) return 'needs_pin';

    // No vault and not authenticated - need login/register.
    if (!hasSession) return 'needs_login';

    // Authenticated. Check if post-registration PIN setup is pending.
    if (needsPinSetup) return 'pin_setup';

    // Step 2b: own-key transparency verification failed. Block the
    // whole authenticated route tree behind a full-screen security
    // failure surface. Runs AFTER vault/PIN so the user is never
    // shown the integrity failure ahead of resolving local state.
    if (transparencyError) return 'transparency_error';

    // Step 3: wait for instance boot to finish.
    if (!guildsLoaded) return 'ready';

    return 'booted';
  }, [authLoading, needsUnlock, hasSession, needsPinSetup, transparencyError, lifecycle, guildsLoaded]);

  const value = useMemo(() => ({
    bootState,
    user,
    mergedGuilds,
    guildsLoaded,
  }), [bootState, user, mergedGuilds, guildsLoaded]);

  return (
    <BootContext.Provider value={value}>
      {children}
    </BootContext.Provider>
  );
}

/**
 * Consumes the boot state from the nearest BootProvider.
 *
 * @returns {{
 *   bootState: 'loading' | 'needs_login' | 'needs_pin' | 'pin_setup' | 'transparency_error' | 'ready' | 'booted',
 *   user: object | null,
 *   mergedGuilds: Array<object>,
 *   guildsLoaded: boolean,
 * }}
 */
export function useBootController() {
  const ctx = useContext(BootContext);
  if (!ctx) {
    throw new Error('useBootController must be used within BootProvider');
  }
  return ctx;
}
