/**
 * E2eTestAuthBridge — test-only programmatic entry to the REAL register + PIN
 * flow, for the Playwright media suite (HUSHHQ-107).
 *
 * Why this exists: hush-web is an E2EE client. A server-minted JWT is NOT enough
 * to reach the authenticated, MLS-capable app: the boot controller gates on a
 * real local vault (PIN-protected BIP39 identity). So the media suite must
 * establish a genuine client identity. This bridge exposes
 * `window.__hushTestAuth.registerAndUnlock(...)`, which calls the REAL
 * `useAuth().performRegister` + `setPIN`. It fakes nothing: registration derives
 * a real BIP39 identity, uploads real MLS keypackages, and `setPIN` writes the
 * real encrypted vault. Only the onboarding UI clicks are bypassed.
 *
 * Security (CORE-INVARIANTS Auth/Vault): the bridge is gated by VITE_E2E_DIAG
 * (isE2eeDiagnosticsEnabled). When the flag is off it renders null and never
 * touches `window`, so production bundles never expose `__hushTestAuth`. No key
 * material crosses the bridge: it triggers the real flow and returns only the
 * server-assigned userId.
 */
import { useEffect, useRef } from 'react';

import { useAuth } from '../../contexts/AuthContext';
import { isE2eeDiagnosticsEnabled } from '../../lib/e2eeDiagnostics.js';
import { generateIdentityMnemonic } from '../../lib/bip39Identity.js';

const REGISTER_SETTLE_TIMEOUT_MS = 5000;
const REGISTER_SETTLE_POLL_MS = 20;

/**
 * Renders nothing. When VITE_E2E_DIAG is set, installs
 * `window.__hushTestAuth.registerAndUnlock({ username, displayName, pin,
 * instanceUrl }) -> { userId }` for the duration of the mount.
 */
export function E2eTestAuthBridge() {
  const enabled = isE2eeDiagnosticsEnabled();
  const auth = useAuth();

  // Refs refreshed every render so the once-installed bridge closure always
  // calls the latest callbacks. setPIN is recreated when `user` changes (it
  // closes over the authenticated user), so registerAndUnlock waits for the
  // post-register render before invoking it.
  const performRegisterRef = useRef(auth.performRegister);
  const setPINRef = useRef(auth.setPIN);
  const unlockVaultRef = useRef(auth.unlockVault);
  const userIdRef = useRef(auth.user?.id ?? null);
  performRegisterRef.current = auth.performRegister;
  setPINRef.current = auth.setPIN;
  unlockVaultRef.current = auth.unlockVault;
  userIdRef.current = auth.user?.id ?? null;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    const waitForUser = async (expectedId) => {
      const deadline = Date.now() + REGISTER_SETTLE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (userIdRef.current === expectedId) return;
        await new Promise((resolve) => setTimeout(resolve, REGISTER_SETTLE_POLL_MS));
      }
      throw new Error('e2eTestAuth: registered user did not settle in time');
    };

    window.__hushTestAuth = {
      async registerAndUnlock({ username, displayName, pin, instanceUrl }) {
        const mnemonic = generateIdentityMnemonic();
        const { user } = await performRegisterRef.current(
          username,
          displayName ?? username,
          mnemonic,
          undefined,
          instanceUrl ?? '',
        );
        // setPIN throws without an authenticated user; wait for the post-
        // register render so setPINRef closes over the freshly-set user.
        await waitForUser(user.id);
        await setPINRef.current(pin);
        return { userId: user.id };
      },
      // Unlocks the existing local vault after a full page reload (a reload
      // drops the in-memory identity, so the app returns to needs_pin). Used by
      // the media spec when it navigates to the channel deep-link.
      async unlock(pin) {
        await unlockVaultRef.current(pin);
      },
    };

    return () => {
      delete window.__hushTestAuth;
    };
  }, [enabled]);

  return null;
}
