/**
 * BIP39 auth hook: challenge-response authentication, vault PIN management,
 * vault timeout, and scorched-earth logout.
 *
 * Auth flow:
 *   1. Derive keypair from mnemonic via bip39Identity.mnemonicToIdentityKey
 *   2. Request challenge nonce via api.requestChallenge
 *   3. Sign the v2 challenge payload via bip39Identity.signAuthChallengeV2
 *   4. Submit signature via api.verifyChallenge → receive JWT
 *
 * Vault states:
 *   'none'     - no vault exists, show login/register UI
 *   'locked'   - vault exists but PIN not entered
 *   'unlocked' - private key in memory, JWT valid
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  mnemonicToIdentityKey,
  signAuthChallengeV2,
  signTransparencyEntry,
} from '../lib/bip39Identity';
import {
  encryptVault,
  decryptVaultAndExportKey,
  decryptVaultWithRawKey,
  openVaultStore,
  saveEncryptedKey,
  loadEncryptedKey,
  deleteVaultDatabase,
  getVaultConfig,
  setVaultConfig,
  bytesToHex,
  hexToBytes as vaultHexToBytes,
  saveSaltToIDB,
  saveVaultMarkerToIDB,
  checkVaultExistsInIDB,
  loadVaultMarkerFromIDB,
  loadPinAttemptsFromIDB,
  savePinAttemptsToIDB,
  clearPinAttemptsFromIDB,
  isLegacyVaultBlob,
} from '../lib/identityVault';
import {
  storeVaultSessionKey,
  retrieveVaultSessionKey,
  clearVaultSessionKey,
} from '../lib/desktopVaultBridge';
import {
  sealIdentityIntoSession,
  getSessionKeyIfAlive,
  readWrappedIdentity,
  unwrapIdentity,
  clearSessionKey as clearVaultSessionStore,
  markAlive as markVaultSessionAlive,
  isMarkerAlive as isVaultSessionMarkerAlive,
  createVaultSessionPresence,
} from '../lib/vaultSessionKey';
import {
  clearPersistedInactivityDeadline,
  persistInactivityDeadline,
  readPersistedInactivityDeadline,
  shouldBlockNumericVaultSessionResume,
} from '../lib/vaultInactivityDeadline';
import { resolveReauthInstanceUrl } from '../lib/reauthInstance';
import {
  AUTH_INVALIDATION_REASONS,
  LOCAL_AUTH_RESET_REASONS,
  deriveAuthLifecycle,
  planAuthenticatedSessionFetchFailure,
  planAuthenticatedVaultBoot,
  planInvalidatedSession,
  planLocalAuthReset,
  planLocalVaultLock,
  planNoTokenLocalVaultBoot,
  planNoTokenStartup,
  planPinFailure,
  planVaultUnlockAttempt,
} from '../lib/authLifecycle';
import {
  openHistoryStore,
  importHistorySnapshot,
} from '../lib/mlsStore';
import {
  importAndReprotectTranscriptBlob,
  importAndReprotectTranscriptRows,
  loadTranscriptCacheFromDisk,
  clearTranscriptCache,
  deleteTranscriptDatabase,
  setTranscriptCache,
} from '../lib/transcriptVault';
import {
  importGuildMetadataKeySnapshot,
  openGuildMetadataKeyStore,
} from '../lib/guildMetadataKeyStore';
import {
  fetchWithAuth,
  uploadKeyPackagesAfterAuth,
  requestChallenge,
  verifyChallenge,
  registerWithPublicKey,
  requestGuestSession,
  resolveAuthAudience,
} from '../lib/api';
import {
  HOSTED_AUTH_INSTANCE_URL,
  getActiveAuthInstanceUrlSync,
  markAuthInstanceUsed,
  normalizeInstanceUrl,
} from '../lib/authInstanceStore';
import { queryClient } from '../lib/queryClient';
import { invalidateDeviceKeysQueries } from './useDeviceKeys';
// Used to repair missing or malformed public-key vault markers after storage
// eviction. The encrypted vault stores the private seed; the public key is
// recoverable from that seed and should never be represented as null.
import * as ed from '@noble/ed25519';

// ── JWT utilities ─────────────────────────────────────────────────────────────

/**
 * Decodes a JWT payload without verifying the signature.
 * Used client-side only to read claims (expiry, is_guest) that were already
 * signed by the trusted server - signature verification is the server's job.
 *
 * @param {string} token - JWT string
 * @returns {object | null} Parsed payload claims, or null on error
 */
function parseJwtClaims(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // Base64url → base64 → JSON
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Guest session warning shown 5 minutes before expiry. */
const GUEST_EXPIRY_WARNING_MS = 5 * 60 * 1000;
const AUTH_OWNED_QUERY_ROOTS = [['servers'], ['auth']];

// ── Module-level constants ───────────────────────────────────────────────────

export const JWT_KEY = 'hush_jwt';
export const HOME_INSTANCE_KEY = 'hush_home_instance';

function clearAuthOwnedQueryCache() {
  AUTH_OWNED_QUERY_ROOTS.forEach((queryKey) => {
    queryClient.removeQueries({ queryKey });
  });
}

// ── Per-instance JWT storage ─────────────────────────────────────────────────

/**
 * Derives the sessionStorage key for a given instance URL. Returns
 * `null` when the URL cannot be parsed so callers FAIL CLOSED instead
 * of silently routing to the legacy global `hush_jwt` key. The legacy
 * global key is only ever read by `getLocalToken` (active-instance
 * migration); explicit per-instance lookups must never fall back to
 * it because the same token would otherwise be sent to a different
 * origin than the user authenticated against.
 *
 * @param {string} instanceUrl
 * @returns {string|null}
 */
function jwtKeyForInstance(instanceUrl) {
  const normalized = normalizeInstanceUrl(instanceUrl);
  if (!normalized) return null;
  return `${JWT_KEY}_${new URL(normalized).host}`;
}

function readAndMigrateDesktopRendererToken(activeUrl, activeKey) {
  if (
    typeof window === 'undefined'
    || window.hushDesktop?.isDesktop !== true
    || activeUrl !== HOSTED_AUTH_INSTANCE_URL
    || !activeKey
  ) {
    return null;
  }

  const legacyDesktopKey = `${JWT_KEY}_localhost`;
  const token = sessionStorage.getItem(legacyDesktopKey);
  if (!token) return null;

  sessionStorage.setItem(activeKey, token);
  sessionStorage.removeItem(legacyDesktopKey);
  return token;
}

/**
 * Stores a JWT token keyed by the instance host. Also clears any
 * stale legacy `hush_jwt` so a subsequent unrelated request cannot
 * accidentally pick it up. No-op when the URL is malformed (caller
 * bug — better to drop the write than corrupt the legacy slot).
 *
 * @param {string} instanceUrl - The instance origin
 * @param {string} token - The JWT string to store
 */
export function setInstanceToken(instanceUrl, token) {
  const key = jwtKeyForInstance(instanceUrl);
  if (!key) return;
  sessionStorage.setItem(key, token);
  // Clear stale legacy so it cannot fall back to this same JWT under
  // a different (or no) instance later.
  sessionStorage.removeItem(JWT_KEY);
}

/**
 * Retrieves the JWT token for a given instance. STRICT: never falls
 * back to the legacy global `hush_jwt` key, even when the URL is
 * malformed. Use `getLocalToken` for the active-instance + legacy
 * migration path.
 *
 * @param {string} instanceUrl - The instance origin
 * @returns {string|null}
 */
export function getInstanceToken(instanceUrl) {
  const key = jwtKeyForInstance(instanceUrl);
  if (!key) return null;
  return sessionStorage.getItem(key);
}

/**
 * Explicit-target token helper. Alias for `getInstanceToken` that
 * makes the namespaced-only contract self-documenting at call sites
 * that previously rolled their own `sessionStorage.getItem`. Use this
 * whenever the caller knows the target instance URL up front.
 *
 * @param {string} instanceUrl
 * @returns {string|null}
 */
export function getTokenForInstanceUrl(instanceUrl) {
  return getInstanceToken(instanceUrl);
}

/**
 * Reads the JWT for the currently active auth instance.
 *
 * If a legacy global key (`hush_jwt`) exists AND there is an active
 * auth instance AND no namespaced key, migrate the legacy value to
 * the namespaced key and clear the global. This is the only place
 * the legacy fallback is allowed — every other call site must use
 * `getInstanceToken` / `getTokenForInstanceUrl` so a legacy token
 * cannot be sent to an unrelated instance.
 *
 * Without an active auth instance, the legacy value is still
 * returned for boot-time profile lookups that have no specific
 * target — callers must NOT use the returned value as a Bearer for
 * a cross-instance request.
 *
 * @returns {string|null}
 */
export function getLocalToken() {
  const activeUrl = getActiveAuthInstanceUrlSync();
  const activeKey = activeUrl ? jwtKeyForInstance(activeUrl) : null;
  if (activeKey) {
    const namespaced = sessionStorage.getItem(activeKey);
    if (namespaced) return namespaced;

    const migratedDesktopToken = readAndMigrateDesktopRendererToken(activeUrl, activeKey);
    if (migratedDesktopToken) return migratedDesktopToken;
  }

  // Legacy migration: if the old global key exists, move it to the namespaced key.
  const legacy = sessionStorage.getItem(JWT_KEY);
  if (legacy && activeUrl) {
    setInstanceToken(activeUrl, legacy);
    // setInstanceToken already removes the legacy key.
    return legacy;
  }

  return legacy;
}

const DEVICE_ID_KEY = 'hush_device_id';
const VAULT_USER_KEY_PREFIX = 'hush_vault_user_';
const VAULT_SESSION_FLAG = 'hush_vault_session_alive';
const VAULT_DERIVED_KEY = 'hush_vault_derived_key';
const LEGACY_VAULT_TIMEOUT_KEY = 'hush_vault_timeout';
const PIN_SETUP_PENDING_KEY = 'hush_pin_setup_pending';
const PIN_ATTEMPTS_KEY_PREFIX = 'hush_pin_attempts_';
const AUTH_INVALIDATION_KEY = 'hush_auth_invalidation';
const INACTIVITY_EVENTS = ['mousemove', 'keydown', 'touchstart', 'click'];

/** Progressive delay in ms by failure count threshold. */
const PIN_DELAY_TABLE = [
  { threshold: 9, delayMs: 60_000 },
  { threshold: 7, delayMs: 30_000 },
  { threshold: 5, delayMs: 5_000 },
  { threshold: 3, delayMs: 1_000 },
];

const MAX_PIN_FAILURES = 10;

// ── Module-level helpers ─────────────────────────────────────────────────────

/**
 * Encodes the in-memory identity material into the byte buffer that
 * gets sealed under the vault session key. The format is the bare
 * JSON `{ v: 1, priv: number[], pub: number[] }`; the caller never
 * sees these bytes — they immediately enter `wrapIdentity` and the
 * resulting AES-GCM ciphertext is what lands in IndexedDB.
 *
 * @param {Uint8Array} privateKey
 * @param {Uint8Array} publicKey
 * @returns {Uint8Array}
 */
function encodeIdentityForVaultSession(privateKey, publicKey) {
  const payload = {
    v: 1,
    priv: Array.from(privateKey),
    pub: Array.from(publicKey),
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

/**
 * Best-effort write of the unlocked identity to the per-tab session
 * key store (see `src/lib/vaultSessionKey.ts`). Designed to fail
 * silently — the caller's unlock must succeed even when IDB / WebCrypto
 * are unavailable, so any error is logged and swallowed. Read-side
 * wiring lands in P21 step 3; this helper is the write half.
 *
 * @param {string} userId
 * @param {Uint8Array} privateKey
 * @param {Uint8Array} publicKey
 * @returns {Promise<void>}
 */
async function writeVaultSessionForUnlock(userId, privateKey, publicKey) {
  if (!userId) return;
  try {
    const identityBytes = encodeIdentityForVaultSession(privateKey, publicKey);
    await sealIdentityIntoSession(userId, identityBytes);
    markVaultSessionAlive(userId);
  } catch (err) {
    console.warn('[useAuth] vault session-key write failed (non-fatal):', err);
  }
}

/**
 * Decodes the JSON envelope produced by `encodeIdentityForVaultSession`.
 * Returns null when the bytes do not match the v1 shape — the caller
 * MUST treat that as "no usable session" and fall back to PIN.
 *
 * @param {Uint8Array} bytes
 * @returns {{ privateKey: Uint8Array, publicKey: Uint8Array }|null}
 */
function decodeIdentityFromVaultSession(bytes) {
  try {
    const text = new TextDecoder().decode(bytes);
    const obj = JSON.parse(text);
    if (
      !obj ||
      obj.v !== 1 ||
      !Array.isArray(obj.priv) ||
      !Array.isArray(obj.pub)
    ) {
      return null;
    }
    return {
      privateKey: new Uint8Array(obj.priv),
      publicKey: new Uint8Array(obj.pub),
    };
  } catch {
    return null;
  }
}

/**
 * Attempts to read a previously-sealed identity from the vault session
 * key store and return the decoded keypair. Honours the configured
 * vault timeout policy via `getSessionKeyIfAlive` — if the policy
 * forbids cross-reload resume on this boot (e.g. `refresh`, or
 * `browser_close` with no alive marker and no live sibling tab), the
 * function returns null and the caller falls back to PIN.
 *
 * Best-effort by design: any failure (missing IDB record, tampered
 * bundle, browser without WebCrypto) yields null and a warning rather
 * than throwing, so the boot path still succeeds with a PIN prompt.
 *
 * @param {string} userId
 * @param {{ timeout?: string|number }|null} effectiveConfig
 * @returns {Promise<{ privateKey: Uint8Array, publicKey: Uint8Array }|null>}
 */
async function tryVaultSessionResume(userId, effectiveConfig) {
  if (!userId) return null;
  const policy = effectiveConfig?.timeout ?? 'browser_close';
  try {
    if (shouldBlockNumericVaultSessionResume(userId, policy)) {
      clearPersistedInactivityDeadline(userId);
      await clearVaultSessionStore(userId);
      return null;
    }

    // P21 step 5 — under `browser_close` only, probe sibling tabs via
    // BroadcastChannel when the per-tab marker is missing. The marker
    // catches soft-refresh inside the same tab; the probe catches a
    // fresh tab opening while another tab of this user is still live.
    // Other policies don't need the probe: `never` reuses regardless
    // and `refresh` always wipes.
    let aliveTabExists = false;
    let probe = null;
    if (policy === 'browser_close' && !isVaultSessionMarkerAlive(userId)) {
      // Probe-only mode: a one-shot startup probe must NOT also act as
      // a persistent `alive` responder, otherwise two concurrent
      // fresh-locked tabs would satisfy each other's probe and resume
      // the vault under `browser_close` with no genuinely-unlocked
      // sibling. The unlocked-tab presence below the auth effect
      // keeps default responder behavior.
      probe = createVaultSessionPresence(userId, { respondToJoining: false });
      try {
        aliveTabExists = await probe.joinAndCheckSiblings();
      } finally {
        probe.close();
      }
    }
    const sessionKey = await getSessionKeyIfAlive(userId, policy, {
      aliveTabExists,
    });
    if (!sessionKey) return null;
    const wrapped = await readWrappedIdentity(userId);
    if (!wrapped) return null;
    const identityBytes = await unwrapIdentity(sessionKey, wrapped);
    return decodeIdentityFromVaultSession(identityBytes);
  } catch (err) {
    console.warn('[useAuth] vault session-key resume failed (non-fatal):', err);
    return null;
  }
}

/**
 * Returns or generates a stable per-device UUID stored in localStorage.
 * @returns {string}
 */
export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID?.() ?? `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Clears all JWT keys (namespaced and legacy) from sessionStorage along with
 * the vault session flag.
 * Does NOT wipe vault IDB or localStorage - use performLogout for full wipe.
 */
export function clearSession() {
  // Remove all per-instance JWT keys (hush_jwt and hush_jwt_*).
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith(JWT_KEY)) {
      sessionStorage.removeItem(key);
    }
  }
  sessionStorage.removeItem(VAULT_SESSION_FLAG);
  sessionStorage.removeItem(VAULT_DERIVED_KEY);
  sessionStorage.removeItem(PIN_SETUP_PENDING_KEY);
}

/**
 * Encodes a Uint8Array to a base64 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function isValidEd25519PublicKey(value) {
  return value instanceof Uint8Array && value.length === 32;
}

async function resolveVaultPublicKey(userId, db, privateKey) {
  let storedHex = localStorage.getItem(`${VAULT_USER_KEY_PREFIX}${userId}`);

  if (!storedHex && db) {
    const idbMarker = await loadVaultMarkerFromIDB(db);
    if (typeof idbMarker === 'string' && idbMarker) {
      storedHex = idbMarker;
    }
  }

  if (storedHex) {
    try {
      const publicKey = hexToBytes(storedHex);
      if (isValidEd25519PublicKey(publicKey)) {
        try {
          localStorage.setItem(`${VAULT_USER_KEY_PREFIX}${userId}`, storedHex);
        } catch {
          // localStorage can be unavailable; the in-memory key remains valid.
        }
        return publicKey;
      }
    } catch {
      // Corrupt persisted marker. Fall through and rebuild from the seed.
    }
  }

  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const repairedHex = bytesToHex(publicKey);
  try {
    localStorage.setItem(`${VAULT_USER_KEY_PREFIX}${userId}`, repairedHex);
  } catch {
    // localStorage can be unavailable; IDB backup below is best-effort.
  }
  if (db) {
    try {
      await saveVaultMarkerToIDB(db, repairedHex);
    } catch {
      // Marker repair is non-fatal for the current unlocked session.
    }
  }
  return publicKey;
}

/**
 * Returns the delay in ms to impose before accepting the next PIN attempt,
 * based on the number of prior failures.
 * @param {number} failureCount
 * @returns {number} ms to wait (0 if under threshold)
 */
function pinDelayMs(failureCount) {
  for (const { threshold, delayMs } of PIN_DELAY_TABLE) {
    if (failureCount >= threshold) return delayMs;
  }
  return 0;
}

/**
 * Parses the legacy global vault-timeout selector value into the normalized
 * timeout shape used by identityVault config.
 *
 * @param {string|null} raw
 * @returns {'browser_close'|'refresh'|'never'|number|null}
 */
function parseLegacyVaultTimeout(raw) {
  switch (raw) {
    case 'browser_close':
    case 'refresh':
    case 'never':
      return raw;
    case '1m':
      return 1;
    case '15m':
      return 15;
    case '30m':
      return 30;
    case '1h':
      return 60;
    case '4h':
      return 240;
    default:
      return null;
  }
}

function loadLegacyPinAttempts(userId) {
  const raw = localStorage.getItem(`${PIN_ATTEMPTS_KEY_PREFIX}${userId}`);
  if (!raw) return { count: 0, lastAttemptAt: null };
  try {
    return normalizePinAttempts(JSON.parse(raw));
  } catch {
    return { count: 0, lastAttemptAt: null };
  }
}

function normalizePinAttempts(record) {
  if (!record || typeof record !== 'object') {
    return { count: 0, lastAttemptAt: null };
  }
  const count = Number.isFinite(record.count)
    ? Math.max(0, Math.floor(record.count))
    : 0;
  const lastAttemptAt = typeof record.lastAttemptAt === 'string'
    ? record.lastAttemptAt
    : null;
  return { count, lastAttemptAt };
}

/**
 * Loads the PIN attempt record from the vault DB for a user. Legacy
 * localStorage records are migrated once, then removed.
 * @param {string} userId
 * @returns {Promise<{ count: number, lastAttemptAt: string|null }>}
 */
export async function loadPinAttempts(userId) {
  let db = null;
  try {
    db = await openVaultStore(userId);
    const record = await loadPinAttemptsFromIDB(db);
    if (record.count > 0) return record;

    const legacy = loadLegacyPinAttempts(userId);
    if (legacy.count > 0) {
      await savePinAttemptsToIDB(db, legacy);
      localStorage.removeItem(`${PIN_ATTEMPTS_KEY_PREFIX}${userId}`);
      return legacy;
    }
    return record;
  } catch {
    return loadLegacyPinAttempts(userId);
  } finally {
    db?.close?.();
  }
}

/**
 * Resets the PIN attempt counter for a user after successful unlock.
 * @param {string} userId
 */
async function clearPinAttempts(userId, existingDb = null) {
  if (existingDb) {
    await clearPinAttemptsFromIDB(existingDb);
  } else {
    const db = await openVaultStore(userId);
    try {
      await clearPinAttemptsFromIDB(db);
    } finally {
      db.close();
    }
  }
  localStorage.removeItem(`${PIN_ATTEMPTS_KEY_PREFIX}${userId}`);
}

/**
 * Returns the first local vault marker userId, if any.
 *
 * The marker is non-secret metadata stored in localStorage. It indicates that
 * this browser profile has seen a Hush identity for that user, but startup
 * still needs to verify whether an encrypted vault blob actually exists.
 *
 * @returns {string|null}
 */
function findVaultMarkerUserId() {
  const key = Object.keys(localStorage)
    .find((candidate) =>
      candidate.startsWith(VAULT_USER_KEY_PREFIX)
      && !candidate.endsWith('_last_user')
      && localStorage.getItem(candidate),
    );

  if (!key) return null;
  return key.slice(VAULT_USER_KEY_PREFIX.length);
}

/**
 * Returns true when a server response proves that this local vault can no
 * longer authenticate against the active instance without a fresh recovery or
 * registration flow. Network failures and local decrypt failures are excluded:
 * they must not force users out of their PIN path.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isServerSessionInvalidationError(err) {
  const status = Number(err?.status);
  const message = String(err?.message || '');
  if (status === 404) return true;
  if (status === 403) {
    return /account\s*banned|registration\s*blocked|device\s*revoked/i.test(message);
  }
  if (status !== 401) return false;
  return /user\s*not\s*found|unknown\s*public\s*key|device\s*revoked|session\s*invalid|authentication\s*failed/i.test(message);
}

/**
 * Returns true only for errors produced by local vault decryption with an
 * incorrect PIN/passphrase. Server auth errors and storage corruption must not
 * consume PIN attempts or trigger local vault wipe.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isVaultDecryptFailure(err) {
  const name = String(err?.name || '');
  const message = String(err?.message || '');
  return name === 'OperationError' || /decrypt|decryption|operationerror/i.test(message);
}

/**
 * Builds a stable auth-invalidation payload suitable for localStorage and
 * React state. The payload is not secret; it only explains why the local
 * vault is being bypassed as the primary boot surface.
 *
 * @param {string} reason
 * @returns {{ reason: string, at: string }}
 */
function createAuthInvalidation(reason) {
  return {
    reason,
    at: new Date().toISOString(),
  };
}

/**
 * Reads the persisted auth invalidation marker, if present.
 *
 * @returns {{ reason: string, at?: string }|null}
 */
function readPersistedAuthInvalidation() {
  try {
    const raw = localStorage.getItem(AUTH_INVALIDATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.reason === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function deleteIndexedDbDatabase(databaseName) {
  if (!databaseName || typeof indexedDB === 'undefined') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function deleteRevokedDeviceDatabases(userId, deviceId) {
  if (!userId) return;

  const targets = new Set([
    `hush-vault-${userId}`,
    `hush-vault-session-${userId}`,
    `hush-transcript-${userId}`,
    'hush-link-archive-exports',
  ]);

  if (deviceId) {
    targets.add(`hush-mls-${userId}-${deviceId}`);
    targets.add(`hush-mls-history-${userId}-${deviceId}`);
    targets.add(`hush-guild-metadata-${userId}-${deviceId}`);
  }

  if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
    try {
      const databases = await indexedDB.databases();
      for (const db of databases) {
        const name = db?.name;
        if (!name) continue;
        const belongsToUser = name.includes(userId);
        const belongsToDevice = deviceId ? name.includes(deviceId) : false;
        if (name.startsWith('hush-') && (belongsToUser || belongsToDevice)) {
          targets.add(name);
        }
      }
    } catch {
      // Database enumeration is optional. Known deterministic names above
      // still cover the critical auth/vault/MLS stores.
    }
  }

  await Promise.allSettled([...targets].map(deleteIndexedDbDatabase));
}

// ── Main hook ────────────────────────────────────────────────────────────────

/**
 * BIP39 auth hook providing challenge-response login, vault PIN management,
 * vault timeout, and scorched-earth logout.
 *
 * @returns {{
 *   user: object|null,
 *   token: string|null,
 *   vaultState: 'none'|'locked'|'unlocked',
 *   hasVault: boolean,
 *   hasSession: boolean,
 *   isVaultUnlocked: boolean,
 *   needsUnlock: boolean,
 *   isKnownBrowserProfile: boolean,
 *   isAuthenticated: boolean,
 *   loading: boolean,
 *   error: Error|null,
 *   authInvalidation: { reason: string, at?: string }|null,
 *   needsPinSetup: boolean,
 *   lifecycle: string,
 *   isGuest: boolean,
 *   guestExpiresAt: string|null,
 *   voiceDisconnectRef: React.MutableRefObject<(() => void)|null>,
 *   performChallengeResponse: (privateKey: Uint8Array, publicKey: Uint8Array, baseUrl?: string) => Promise<void>,
 *   performRegister: (username: string, displayName: string, mnemonic: string, inviteCode?: string, baseUrl?: string) => Promise<void>,
 *   performRecovery: (mnemonic: string, revokeOtherDevices?: boolean, baseUrl?: string) => Promise<void>,
 *   completeDeviceLink: (bundle: { rootPrivateKey: Uint8Array, rootPublicKey: Uint8Array, historySnapshot?: object|null }, baseUrl?: string) => Promise<void>,
 *   performGuestAuth: () => Promise<{ user: object }>,
 *   unlockVault: (pin: string) => Promise<void>,
 *   lockVault: () => void,
 *   setPIN: (pin: string) => Promise<void>,
 *   skipPinSetup: () => void,
 *   performLogout: () => Promise<void>,
 *   clearError: () => void,
 *   clearAuthInvalidation: () => void,
 * }}
 */
export function useAuth() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [vaultState, setVaultState] = useState('none');
  const [hasLocalVault, setHasLocalVault] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsPinSetup, setNeedsPinSetupState] = useState(
    () => sessionStorage.getItem(PIN_SETUP_PENDING_KEY) === '1',
  );
  const [authInvalidation, setAuthInvalidation] = useState(
    () => readPersistedAuthInvalidation(),
  );

  /**
   * Set when transparency log verification detects a key mismatch.
   * Non-null value blocks the app UI - see transparencyError in the return value.
   *
   * Owned here so any component in the tree can read the error via useAuth().
   * Set externally by ServerLayout after fetching handshakeData and running
   * TransparencyVerifier.verifyOwnKey().
   */
  const [transparencyError, setTransparencyError] = useState(null);

  /** True when the current session is a guest (short-lived, no BIP39 identity). */
  const [isGuest, setIsGuest] = useState(false);
  /**
   * ISO timestamp of guest session expiry. Non-null only when isGuest === true.
   * Used by the UI to display the expiry countdown.
   */
  const [guestExpiresAt, setGuestExpiresAt] = useState(null);

  // In-memory identity key - never persisted to any storage as plaintext.
  const identityKeyRef = useRef(null);

  // Tracks the current user id so lock/timeout callbacks can clear the desktop session key.
  const currentUserIdRef = useRef(null);

  // Inactivity timer handle.
  const inactivityTimerRef = useRef(null);

  // Guest session expiry timers.
  const guestWarningTimerRef = useRef(null);
  const guestExpiryTimerRef = useRef(null);

  /**
   * Optional voice-disconnect callback. Set by the voice layer so that guest
   * expiry can cleanly disconnect an active call before redirecting.
   *
   * Pattern: voiceDisconnectRef.current = () => room.disconnect()
   * Clear on voice component unmount: voiceDisconnectRef.current = null
   */
  const voiceDisconnectRef = useRef(null);

  const hasSession = Boolean(token && user);
  const isAuthenticated = hasSession;
  const isVaultUnlocked = vaultState === 'unlocked' && Boolean(identityKeyRef.current?.privateKey);
  const hasVault = hasLocalVault || vaultState === 'locked' || (vaultState === 'unlocked' && !isGuest);
  // An `authInvalidation` marker only short-circuits the PIN gate when
  // there is no live JWT/user session left. With a session still
  // present, a stale or locally-planted marker must NOT route an
  // authenticated browser into the app while the local vault is locked
  // - PIN unlock has to run first.
  // CORE-INVARIANTS - Authentication, Vault, and Device Identity:
  // PIN policy and vault session policy remain enforceable.
  const shouldBypassUnlockForInvalidation = Boolean(authInvalidation && !hasSession);
  const needsUnlock =
    hasVault && !isVaultUnlocked && !shouldBypassUnlockForInvalidation;
  const isKnownBrowserProfile = hasVault;

  // Canonical lifecycle value. Single pure derivation from observable hook
  // state; legacy boolean fields above stay consistent with this (they are
  // computed from the same inputs). See
  // `hush-web/docs/security/auth-device-lifecycle.md` for the state set,
  // transitions, and rendering contract.
  const lifecycle = deriveAuthLifecycle({
    loading,
    hasToken: Boolean(token),
    hasUser: Boolean(user),
    hasLocalVault: hasVault,
    isVaultUnlocked,
    authInvalidation,
    needsPinSetup,
    isGuest,
  });

  const clearError = useCallback(() => setError(null), []);
  const clearAuthInvalidation = useCallback(() => {
    localStorage.removeItem(AUTH_INVALIDATION_KEY);
    setAuthInvalidation(null);
  }, []);
  const setPinSetupPendingState = useCallback((pending) => {
    setNeedsPinSetupState(pending);
    if (pending) {
      sessionStorage.setItem(PIN_SETUP_PENDING_KEY, '1');
      return;
    }
    sessionStorage.removeItem(PIN_SETUP_PENDING_KEY);
  }, []);
  const requirePinSetup = useCallback(() => setPinSetupPendingState(true), [setPinSetupPendingState]);
  const clearPinSetup = useCallback(() => setPinSetupPendingState(false), [setPinSetupPendingState]);

  // ── Guest session timers ───────────────────────────────────────────────────

  /**
   * Cancels any running guest warning/expiry timers. Safe to call multiple times.
   */
  const clearGuestTimers = useCallback(() => {
    if (guestWarningTimerRef.current != null) {
      clearTimeout(guestWarningTimerRef.current);
      guestWarningTimerRef.current = null;
    }
    if (guestExpiryTimerRef.current != null) {
      clearTimeout(guestExpiryTimerRef.current);
      guestExpiryTimerRef.current = null;
    }
  }, []);

  /**
   * Schedules a 5-minute warning and expiry action for a guest session.
   *
   * At T-5 minutes: emits a 'guest_expiry_warning' CustomEvent on window so
   *   any component can show a persistent toast.
   * At T-0: disconnects voice (if registered), clears local auth state,
   *   and redirects to /register (BIP39 onboarding).
   *
   * @param {number} expiresAtMs - Unix timestamp in milliseconds
   */
  const startGuestExpiryTimers = useCallback((expiresAtMs) => {
    clearGuestTimers();

    const now = Date.now();
    const totalMs = expiresAtMs - now;
    if (totalMs <= 0) return; // Already expired.

    const warningMs = totalMs - GUEST_EXPIRY_WARNING_MS;

    if (warningMs > 0) {
      guestWarningTimerRef.current = setTimeout(() => {
        window.dispatchEvent(new CustomEvent('hush_guest_expiry_warning', {
          detail: { expiresAt: new Date(expiresAtMs).toISOString() },
        }));
      }, warningMs);
    } else {
      // Less than 5 minutes remaining - show warning immediately.
      window.dispatchEvent(new CustomEvent('hush_guest_expiry_warning', {
        detail: { expiresAt: new Date(expiresAtMs).toISOString() },
      }));
    }

    guestExpiryTimerRef.current = setTimeout(() => {
      // 1. Disconnect voice if active.
      if (voiceDisconnectRef.current) {
        try { voiceDisconnectRef.current(); } catch { /* ignore */ }
      }

      // 2. Show expiry toast (via CustomEvent - decoupled from any toast lib).
      window.dispatchEvent(new CustomEvent('hush_guest_session_expired'));

      // 3. Clear auth state (silent - no BroadcastChannel; guest has no other tabs).
      clearSession();
      setToken(null);
      setUser(null);
      setVaultState('none');
      setHasLocalVault(false);
      setIsGuest(false);
      setGuestExpiresAt(null);
      clearGuestTimers();

      // 4. Redirect to BIP39 registration (not login - guests have no account).
      if (typeof window !== 'undefined') {
        window.location.href = '/register';
      }
    }, totalMs);
  }, [clearGuestTimers]);

  // ── Inactivity timer ───────────────────────────────────────────────────────

  /**
   * Clears the running inactivity timer.
   */
  const clearInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current != null) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  }, []);

  /**
   * Clears the persisted inactivity deadline used to enforce numeric vault
   * timeouts across background/foreground transitions.
   */
  const clearInactivityDeadline = useCallback(() => {
    const userId = currentUserIdRef.current;
    inactivityDeadlineRef.current = null;
    clearPersistedInactivityDeadline(userId);
  }, []);

  /**
   * Persists the absolute deadline for the active numeric vault timeout.
   *
   * @param {number} deadlineMs
   */
  const setInactivityDeadline = useCallback((deadlineMs) => {
    const userId = currentUserIdRef.current;
    inactivityDeadlineRef.current = deadlineMs;
    persistInactivityDeadline(userId, deadlineMs);
  }, []);

  /**
   * Reads the current inactivity deadline from memory or sessionStorage.
   *
   * @returns {number|null}
   */
  const getInactivityDeadline = useCallback(() => {
    if (typeof inactivityDeadlineRef.current === 'number') {
      return inactivityDeadlineRef.current;
    }

    const userId = currentUserIdRef.current;
    const deadlineMs = readPersistedInactivityDeadline(userId);
    if (deadlineMs == null) return null;

    inactivityDeadlineRef.current = deadlineMs;
    return deadlineMs;
  }, []);

  /**
   * Applies a hard vault lock caused by inactivity expiry.
   *
   * Clears the derived AES key so a reload cannot auto-unlock after the vault
   * has timed out.
   */
  const lockVaultForTimeout = useCallback(() => {
    const transition = planLocalVaultLock();
    if (transition.shouldClearIdentity) {
      identityKeyRef.current = null;
    }
    if (transition.shouldClearSessionKeys) {
      sessionStorage.removeItem(VAULT_DERIVED_KEY);
    }
    clearInactivityDeadline();
    if (transition.shouldClearTranscriptCache) {
      clearTranscriptCache();
    }
    const userId = currentUserIdRef.current;
    if (userId && transition.shouldClearSessionKeys) {
      clearVaultSessionKey(userId).catch(() => {});
      // P21 step 4 — drop the cross-reload session key store too, so
      // the next reload requires PIN re-entry as the timeout intends.
      // Without this the boot path would happily resume from the IDB
      // record and defeat the inactivity policy.
      clearVaultSessionStore(userId).catch(() => {});
    }
    setVaultState(transition.nextVaultState);
  }, [clearInactivityDeadline]);

  /**
   * Arms the inactivity timer to fire at the given absolute deadline.
   *
   * @param {number} deadlineMs
   */
  const startInactivityTimer = useCallback((deadlineMs) => {
    clearInactivityTimer();

    const remainingMs = Math.max(deadlineMs - Date.now(), 0);
    if (remainingMs === 0) {
      lockVaultForTimeout();
      return;
    }

    inactivityTimerRef.current = setTimeout(() => {
      lockVaultForTimeout();
    }, remainingMs);
  }, [clearInactivityTimer, lockVaultForTimeout]);

  // ── Vault configuration helpers ────────────────────────────────────────────

  /**
   * Applies the vault timeout policy for the given user after unlock.
   * @param {string} userId
   */
  /**
   * Ref for the beforeunload handler used by the 'refresh' vault timeout
   * policy. Stored in a ref so it can be removed on vault lock or unmount.
   */
  const beforeUnloadRef = useRef(null);
  const inactivityResetRef = useRef(null);
  const inactivityResumeRef = useRef(null);
  const inactivityDeadlineRef = useRef(null);

  /**
   * Clears all window-level side effects associated with the active vault
   * timeout policy so a new policy can be applied cleanly.
   */
  const clearVaultTimeoutEffects = useCallback(() => {
    clearInactivityTimer();
    clearInactivityDeadline();
    if (beforeUnloadRef.current) {
      window.removeEventListener('beforeunload', beforeUnloadRef.current);
      beforeUnloadRef.current = null;
    }
    if (inactivityResetRef.current) {
      INACTIVITY_EVENTS.forEach((ev) => {
        window.removeEventListener(ev, inactivityResetRef.current);
      });
      inactivityResetRef.current = null;
    }
    if (inactivityResumeRef.current) {
      document.removeEventListener('visibilitychange', inactivityResumeRef.current);
      window.removeEventListener('focus', inactivityResumeRef.current);
      window.removeEventListener('pageshow', inactivityResumeRef.current);
      inactivityResumeRef.current = null;
    }
  }, [clearInactivityDeadline, clearInactivityTimer]);

  const applyLocalAuthResetPlan = useCallback((transition) => {
    if (transition.shouldClearIdentity) {
      identityKeyRef.current = null;
    }
    if (transition.shouldClearVaultTimeoutEffects) {
      clearVaultTimeoutEffects();
    }
    if (transition.shouldClearGuestTimers) {
      clearGuestTimers();
    }
    if (transition.shouldClearTranscriptCache) {
      clearTranscriptCache();
    }
    if (transition.shouldClearAuthQueries) {
      clearAuthOwnedQueryCache();
    }
    if (transition.shouldClearSession) {
      clearSession();
    }
    setToken(transition.nextToken);
    setUser(transition.nextUser);
    setVaultState(transition.nextVaultState);
    setHasLocalVault(transition.nextHasLocalVault);
    setNeedsPinSetupState(transition.nextNeedsPinSetup);
    setIsGuest(transition.nextIsGuest);
    setGuestExpiresAt(transition.nextGuestExpiresAt);
    setError(transition.nextError);
    if (transition.shouldClearPinSetupStorage) {
      sessionStorage.removeItem(PIN_SETUP_PENDING_KEY);
    }
    if (transition.nextLoading !== null) {
      setLoading(transition.nextLoading);
    }
  }, [clearGuestTimers, clearVaultTimeoutEffects]);

  const applyBootVaultPlan = useCallback((transition) => {
    setHasLocalVault(transition.nextHasLocalVault);
    setVaultState(transition.nextVaultState);
  }, []);

  const destroyRevokedDeviceLocalState = useCallback((reason = AUTH_INVALIDATION_REASONS.DEVICE_REVOKED) => {
    const userId =
      currentUserIdRef.current
      ?? localStorage.getItem(`${VAULT_USER_KEY_PREFIX}_last_user`)
      ?? findVaultMarkerUserId();
    const deviceId = localStorage.getItem(DEVICE_ID_KEY);

    const existingInvalidation = readPersistedAuthInvalidation();
    if (existingInvalidation?.reason !== reason) {
      const nextInvalidation = createAuthInvalidation(reason);
      localStorage.setItem(AUTH_INVALIDATION_KEY, JSON.stringify(nextInvalidation));
      setAuthInvalidation(nextInvalidation);
    }

    const resetPlan = planLocalAuthReset(reason);

    if (userId) {
      clearPersistedInactivityDeadline(userId);
      clearVaultSessionKey(userId).catch(() => {});
      clearVaultSessionStore(userId).catch(() => {});
      deleteVaultDatabase(userId).catch(() => {});
      deleteTranscriptDatabase(userId).catch(() => {});
      deleteRevokedDeviceDatabases(userId, deviceId).catch((err) => {
        console.warn('[useAuth] revoked-device local database cleanup failed:', err);
      });

      localStorage.removeItem(`${VAULT_USER_KEY_PREFIX}${userId}`);
      localStorage.removeItem(`${VAULT_USER_KEY_PREFIX}_last_user`);
      localStorage.removeItem(`${PIN_ATTEMPTS_KEY_PREFIX}${userId}`);
      localStorage.removeItem(`hush_vault_config_${userId}`);
    }

    localStorage.removeItem(DEVICE_ID_KEY);
    localStorage.removeItem(LEGACY_VAULT_TIMEOUT_KEY);
    applyLocalAuthResetPlan(resetPlan);
  }, [applyLocalAuthResetPlan]);

  const markServerSessionInvalidated = useCallback((reason = AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID) => {
    // Sticky revocation: once a `device_revoked` tombstone is written, no
    // subsequent server-session-invalid signal can downgrade it. The
    // revocation is a device trust boundary; a later 401 from the same
    // server about the now-revoked device must not weaken the marker into
    // a recoverable-session tombstone that leaves the local vault around.
    const persisted = readPersistedAuthInvalidation();
    const effectiveReason =
      persisted?.reason === AUTH_INVALIDATION_REASONS.DEVICE_REVOKED
        ? AUTH_INVALIDATION_REASONS.DEVICE_REVOKED
        : reason;
    const hasRecoverableVault = Boolean(findVaultMarkerUserId());
    const transition = planInvalidatedSession(effectiveReason, { hasRecoverableVault });

    if (transition.shouldDestroyLocalDeviceState) {
      destroyRevokedDeviceLocalState(transition.reason);
      return;
    }

    const nextInvalidation = createAuthInvalidation(transition.reason);
    localStorage.setItem(AUTH_INVALIDATION_KEY, JSON.stringify(nextInvalidation));
    setAuthInvalidation(nextInvalidation);

    identityKeyRef.current = null;
    sessionStorage.removeItem(VAULT_DERIVED_KEY);
    clearVaultTimeoutEffects();
    clearTranscriptCache();
    clearAuthOwnedQueryCache();
    clearSession();
    setToken(null);
    setUser(null);
    setHasLocalVault(transition.nextHasLocalVault);
    setVaultState(transition.nextVaultState);
    clearPinSetup();
  }, [clearPinSetup, clearVaultTimeoutEffects, destroyRevokedDeviceLocalState]);

  /**
   * Returns the effective per-user vault config. If the old global timeout key
   * is still present, migrate it into the per-user config on first read.
   *
   * @param {string} userId
   * @returns {{ timeout: string|number, pinType: string }|null}
   */
  const getEffectiveVaultConfig = useCallback((userId) => {
    const existing = getVaultConfig(userId);
    if (existing?.timeout !== undefined) {
      return existing;
    }

    const legacyTimeout = parseLegacyVaultTimeout(localStorage.getItem(LEGACY_VAULT_TIMEOUT_KEY));
    if (legacyTimeout == null) {
      return existing;
    }

    const migrated = {
      timeout: legacyTimeout,
      pinType: existing?.pinType ?? 'pin',
    };
    setVaultConfig(userId, migrated);
    localStorage.removeItem(LEGACY_VAULT_TIMEOUT_KEY);
    return migrated;
  }, []);

  const applyVaultTimeout = useCallback((userId) => {
    clearVaultTimeoutEffects();
    const config = getEffectiveVaultConfig(userId);
    const timeout = config?.timeout ?? 'browser_close';

    // The wrapping key is no longer persisted to browser storage (ans23 / F3),
    // so every full-page reload re-locks the vault by construction. The
    // remaining policy choice is what to do with the in-memory key while
    // the page stays open: keep it (browser_close / never), drop it on
    // unload (refresh), or drop it after idle (numeric).
    if (timeout === 'browser_close' || timeout === 'never') {
      return;
    }

    if (timeout === 'refresh') {
      // Drop in-memory identity on page unload so a same-process navigation
      // re-locks. On desktop the PIN-derived vault session key can also
      // live in the Electron main process across renderer reloads via
      // desktopVaultBridge; without clearing it here, the 'refresh'
      // policy would be silently downgraded by desktop auto-unlock after
      // the next reload. Fire-and-forget: any bridge error must not
      // block the unload event.
      // CORE-INVARIANTS - Authentication, Vault, and Device Identity +
      // "Desktop and web must behave as one product": refresh-lock
      // policy must hold on both runtimes.
      const handler = () => {
        identityKeyRef.current = null;
        try {
          clearVaultSessionKey(userId)?.catch?.(() => {});
        } catch {
          /* unload must not throw */
        }
      };
      window.addEventListener('beforeunload', handler);
      beforeUnloadRef.current = handler;
      return;
    }

    if (typeof timeout === 'number' && timeout > 0) {
      const timeoutMs = timeout * 60 * 1000;
      const resetTimer = () => {
        if (document.visibilityState === 'hidden') return;
        const deadlineMs = Date.now() + timeoutMs;
        setInactivityDeadline(deadlineMs);
        startInactivityTimer(deadlineMs);
      };
      const handleResume = () => {
        if (document.visibilityState === 'hidden') return;
        const deadlineMs = getInactivityDeadline();
        if (deadlineMs == null) {
          resetTimer();
          return;
        }
        if (Date.now() >= deadlineMs) {
          lockVaultForTimeout();
          return;
        }
        startInactivityTimer(deadlineMs);
      };

      resetTimer();
      INACTIVITY_EVENTS.forEach(ev => window.addEventListener(ev, resetTimer, { passive: true }));
      document.addEventListener('visibilitychange', handleResume);
      window.addEventListener('focus', handleResume);
      window.addEventListener('pageshow', handleResume);
      inactivityResetRef.current = resetTimer;
      inactivityResumeRef.current = handleResume;

      // Cleanup when vault locks or component unmounts is handled by the
      // useEffect that subscribes to vaultState changes.
      return resetTimer;
    }
  }, [
    clearVaultTimeoutEffects,
    getEffectiveVaultConfig,
    getInactivityDeadline,
    lockVaultForTimeout,
    setInactivityDeadline,
    startInactivityTimer,
  ]);

  // ── Core auth completion ───────────────────────────────────────────────────

  /**
   * Shared post-auth finalisation: upload MLS KeyPackages, persist JWT, update state.
   * For guest sessions (no user object): pass { token, guestId, expiresAt } and
   * set user to a synthetic guest object.
   *
   * @param {{ token: string, user?: object, guestId?: string, expiresAt?: string }} data
   * @param {string} [baseUrl]
   */
  const publishAuthenticatedSession = useCallback((jwt, user, baseUrl = '') => {
    clearGuestTimers();
    clearAuthInvalidation();
    setIsGuest(false);
    setGuestExpiresAt(null);
    // Prefer the namespaced path: `setInstanceToken` also clears the
    // legacy `hush_jwt` so a later cross-instance request cannot
    // accidentally pick it up. Fall back to the legacy slot only when
    // no `baseUrl` is known (true active/local boot path).
    if (baseUrl) {
      setInstanceToken(baseUrl, jwt);
    } else {
      sessionStorage.setItem(JWT_KEY, jwt);
    }
    currentUserIdRef.current = user.id;
    setToken(jwt);
    setUser(user);
  }, [clearGuestTimers, clearAuthInvalidation]);

  const prepareAuthenticatedSession = useCallback(async (data, baseUrl = '') => {
    const { token: jwt, user: u } = data;
    if (!jwt) throw new Error('invalid auth response');
    if (!u?.id) throw new Error('invalid auth response');

    const deviceId = getDeviceId();
    await uploadKeyPackagesAfterAuth(jwt, u.id, deviceId, {}, baseUrl);
    return { token: jwt, user: u };
  }, []);

  const finishAuth = useCallback(async (data, baseUrl = '') => {
    const { token: jwt, user: u } = data;
    if (!jwt) throw new Error('invalid auth response');

    // Guest auth path: no persisted user, no KeyPackage upload.
    const claims = parseJwtClaims(jwt);
    if (claims?.is_guest) {
      clearAuthInvalidation();
      if (baseUrl) {
        setInstanceToken(baseUrl, jwt);
      } else {
        sessionStorage.setItem(JWT_KEY, jwt);
      }
      setToken(jwt);
      // Build a synthetic guest user object so isAuthenticated returns true.
      const guestUser = {
        id: claims.sub,
        username: claims.sub,
        displayName: 'Guest',
        role: 'guest',
      };
      currentUserIdRef.current = guestUser.id;
      setUser(guestUser);
      setIsGuest(true);
      clearPinSetup();
      const expiresAtIso = data.expiresAt ?? (claims.exp ? new Date(claims.exp * 1000).toISOString() : null);
      setGuestExpiresAt(expiresAtIso);
      if (expiresAtIso) {
        startGuestExpiryTimers(new Date(expiresAtIso).getTime());
      }
      return { token: jwt, user: guestUser };
    }

    const result = await prepareAuthenticatedSession(data, baseUrl);
    publishAuthenticatedSession(result.token, result.user, baseUrl);
    return result;
  }, [startGuestExpiryTimers, clearPinSetup, clearAuthInvalidation, prepareAuthenticatedSession, publishAuthenticatedSession]);

  // ── Challenge-response login ───────────────────────────────────────────────

  /**
   * Performs the full BIP39 challenge-response authentication flow.
   * Encodes the public key as base64, requests a nonce, signs it, submits.
   *
   * @param {Uint8Array} privateKey - 32-byte Ed25519 seed.
   * @param {Uint8Array} publicKey - 32-byte Ed25519 public key.
   * @param {string} [baseUrl] - Optional auth instance base URL.
   */
  const performChallengeResponse = useCallback(async (privateKey, publicKey, baseUrl = '') => {
    const deviceId = getDeviceId();
    const publicKeyBase64 = toBase64(publicKey);

    // Bind the challenge signature to the exact API origin we are
    // authenticating to (auth challenge v2). Without an audience the
    // signature is a cross-instance oracle: a malicious instance could
    // relay this nonce from the legitimate home instance and redeem
    // the returned signature there. Fail closed if we can't resolve a
    // canonical origin rather than fall back to a raw-nonce signature.
    const audience = resolveAuthAudience(baseUrl);
    if (!audience) {
      throw new Error('Cannot determine auth instance origin for challenge.');
    }

    const { nonce } = await requestChallenge(publicKeyBase64, baseUrl);

    const signature = await signAuthChallengeV2(nonce, audience, privateKey);
    const signatureBase64 = toBase64(signature);

    const data = await verifyChallenge(publicKeyBase64, nonce, signatureBase64, deviceId, baseUrl, audience);

    // Keep private key in memory for vault lock/unlock, not in any storage.
    identityKeyRef.current = { privateKey, publicKey };

    const { token: jwt, user: u } = await finishAuth(data, baseUrl);

    // Mark vault key presence using public key hex (no secret material).
    localStorage.setItem(`${VAULT_USER_KEY_PREFIX}${u.id}`, bytesToHex(publicKey));
    setHasLocalVault(true);
    // Hydrate the in-memory transcript cache from the per-user encrypted
    // transcript IDB BEFORE exposing vaultState='unlocked', so any consumer
    // that mounts as soon as the vault unlocks (Room route gating, Chat
    // initial loadHistory) sees the inherited rows on first render.
    try {
      await loadTranscriptCacheFromDisk({ userId: u.id, rootPrivateKey: privateKey });
    } catch (err) {
      console.warn('[useAuth] transcript cache load failed:', err);
      clearTranscriptCache();
    }
    setVaultState('unlocked');
    applyVaultTimeout(u.id);
    // P21 step 2 — best-effort write of the unlocked identity into the
    // vault session key store so future boots can resume without PIN
    // under the configured policy.
    void writeVaultSessionForUnlock(u.id, privateKey, publicKey);
    return { token: jwt, user: u };
  }, [finishAuth, applyVaultTimeout]);

  // ── Register ───────────────────────────────────────────────────────────────

  /**
   * Registers a new account from a BIP39 mnemonic, then authenticates.
   * PIN setup is deferred to first vault lock (user decision).
   *
   * @param {string} username
   * @param {string} displayName
   * @param {string} mnemonic - 12-word BIP39 mnemonic.
   * @param {string} [inviteCode] - Optional invite code.
   * @param {string} [baseUrl] - Optional auth instance base URL.
   */
  const performRegister = useCallback(async (username, displayName, mnemonic, inviteCode, baseUrl = '') => {
    setLoading(true);
    setError(null);
    try {
      const { privateKey, publicKey } = await mnemonicToIdentityKey(mnemonic);
      const deviceId = getDeviceId();
      const publicKeyBase64 = toBase64(publicKey);

      // Sign a transparency entry so the server can append it to the log.
      // The server ignores transparency_sig if the instance has no log configured.
      const transparencyTs = Math.floor(Date.now() / 1000);
      let transparencySigBase64 = null;
      try {
        const { signature } = await signTransparencyEntry(
          privateKey,
          'register',
          publicKey,
          null,
          transparencyTs,
        );
        transparencySigBase64 = toBase64(signature);
      } catch (sigErr) {
        // Non-fatal: log warning and proceed without transparency sig.
        console.warn('[transparency] Failed to sign registration entry:', sigErr);
      }

      const data = await registerWithPublicKey(
        username,
        displayName,
        publicKeyBase64,
        deviceId,
        inviteCode,
        baseUrl,
        transparencySigBase64,
        transparencySigBase64 ? transparencyTs : null,
      );

      identityKeyRef.current = { privateKey, publicKey };

      const { user: u } = await finishAuth(data, baseUrl);

      localStorage.setItem(`${VAULT_USER_KEY_PREFIX}${u.id}`, bytesToHex(publicKey));
      setHasLocalVault(true);
      requirePinSetup();
      setVaultState('unlocked');
      localStorage.setItem(HOME_INSTANCE_KEY, baseUrl || window.location.origin);
      applyVaultTimeout(u.id);
      // P21 step 2 — write the unlocked identity into the vault session
      // key store. Mirrors the call in performChallengeResponse so the
      // first-registration unlock has the same cross-reload affordance
      // as a returning sign-in.
      void writeVaultSessionForUnlock(u.id, privateKey, publicKey);
      return { user: u };
    } catch (err) {
      setError(err);
      clearSession();
      setToken(null);
      setUser(null);
      setVaultState('none');
      setHasLocalVault(false);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [finishAuth, applyVaultTimeout, requirePinSetup]);

  // ── Recovery ───────────────────────────────────────────────────────────────

  /**
   * Recovers account access from a mnemonic by performing challenge-response.
   * Optionally revokes all other registered device keys.
   *
   * @param {string} mnemonic - 12-word BIP39 mnemonic.
   * @param {boolean} [revokeOtherDevices=false]
   * @param {string} [baseUrl] - Optional auth instance base URL.
   */
  const performRecovery = useCallback(async (mnemonic, revokeOtherDevices = false, baseUrl = '') => {
    setLoading(true);
    setError(null);
    try {
      const { privateKey, publicKey } = await mnemonicToIdentityKey(mnemonic);

      const authResult = await performChallengeResponse(privateKey, publicKey, baseUrl);

      if (revokeOtherDevices) {
        const jwt = getLocalToken();
        const deviceId = getDeviceId();
        const { listDeviceKeys, revokeDeviceKey } = await import('../lib/api');
        // Scope the device-list read and bulk revoke to the recovery
        // instance. Without baseUrl, the API helpers fall back to the
        // current origin which may not be the home instance the token
        // was minted against — the cache invalidation below would then
        // mark the wrong origin's cache stale.
        const devices = await listDeviceKeys(jwt, baseUrl);
        await Promise.allSettled(
          devices
            .filter(d => d.deviceId !== deviceId)
            .map(d => revokeDeviceKey(jwt, d.deviceId, baseUrl)),
        );
        // Mark cached device-key queries stale so any settings panel mounted
        // after recovery re-fetches the post-revoke list instead of reading
        // pre-revoke entries from cache.
        await invalidateDeviceKeysQueries();
      }
      requirePinSetup();
      localStorage.setItem(HOME_INSTANCE_KEY, baseUrl || window.location.origin);
      // Signal post-recovery wizard to appear once the authenticated route tree mounts.
      localStorage.setItem('hush_post_recovery_wizard', '1');
      return authResult;
    } catch (err) {
      setError(err);
      clearSession();
      setToken(null);
      setUser(null);
      setVaultState('none');
      setHasLocalVault(false);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [performChallengeResponse, requirePinSetup]);

  // ── Device linking ────────────────────────────────────────────────────────

  /**
   * Completes a device-link handoff using the transferred root key material.
   *
   * The new device authenticates with the transferred root key, uploads its own
   * MLS credential/key packages, imports the read-only history snapshot, and
   * then requires the user to set a fresh local PIN.
   *
   * @param {{ rootPrivateKey: Uint8Array, rootPublicKey: Uint8Array, historySnapshot?: object|null }} bundle
   * @param {string} [baseUrl] - Optional auth instance base URL.
   * @returns {Promise<{ user: object }>}
   */
  const completeDeviceLink = useCallback(async (bundle, baseUrl = '') => {
    setLoading(true);
    setError(null);

    let historyDb = null;
    try {
      if (!bundle?.rootPrivateKey || !bundle?.rootPublicKey) {
        throw new Error('invalid device link bundle');
      }

      // Resolve the trusted auth-instance base URL for this link.
      //
      // SECURITY: A device-link bundle is transferred from the OLD
      // device and `bundle.instanceUrl` is therefore attacker- or
      // confusion-controlled from this device's point of view. The
      // NEW device polled / selected its own instance during the
      // link request; that caller-provided `baseUrl` is the only
      // value this device has ever explicitly trusted. We MUST
      // prefer it over the bundle field, and we MUST fail closed
      // when both are present and disagree after origin
      // normalization — otherwise challenge-response, JWT storage,
      // key-package upload, and post-auth calls could all be
      // redirected to a different instance than the user picked.
      //
      // CORE-INVARIANTS - "Authentication, Vault, and Device
      // Identity" + "Instance boundaries must never leak
      // credentials" + "Device linking".
      const expectedAuthBaseUrl = normalizeInstanceUrl(baseUrl);
      const bundleAuthBaseUrl = normalizeInstanceUrl(bundle.instanceUrl);
      if (
        expectedAuthBaseUrl &&
        bundleAuthBaseUrl &&
        expectedAuthBaseUrl !== bundleAuthBaseUrl
      ) {
        throw new Error(
          'Device link instance mismatch. Restart the link from this device.',
        );
      }
      // Prefer the caller-provided selected instance. Fall back to
      // the bundle field only for legacy / internal callers that
      // omit `baseUrl` (in which case there is no second source to
      // disagree with). Last-ditch `''` keeps the legacy
      // empty-string contract for callers that pass neither.
      const authBaseUrl =
        expectedAuthBaseUrl || bundleAuthBaseUrl || baseUrl || bundle.instanceUrl || '';
      const deviceId = getDeviceId();
      const publicKeyBase64 = toBase64(bundle.rootPublicKey);

      // Audience-bind the device-link verification signature to the
      // resolved home/selected instance so a relay attack cannot trade
      // the signature for a JWT on a different instance. See
      // performChallengeResponse for the threat-model details.
      const audience = resolveAuthAudience(authBaseUrl);
      if (!audience) {
        throw new Error('Cannot determine auth instance origin for device link verification.');
      }
      const { nonce } = await requestChallenge(publicKeyBase64, authBaseUrl);
      const signature = await signAuthChallengeV2(nonce, audience, bundle.rootPrivateKey);
      const signatureBase64 = toBase64(signature);
      const data = await verifyChallenge(publicKeyBase64, nonce, signatureBase64, deviceId, authBaseUrl, audience);

      // Keep private key in memory for vault lock/unlock, not in any storage.
      identityKeyRef.current = { privateKey: bundle.rootPrivateKey, publicKey: bundle.rootPublicKey };

      const authResult = await prepareAuthenticatedSession(data, authBaseUrl);

      if (authResult?.user?.id) {
        if (bundle.historySnapshot) {
          historyDb = await openHistoryStore(authResult.user.id, deviceId);
          await importHistorySnapshot(historyDb, bundle.historySnapshot);
        }
        if (bundle.guildMetadataKeySnapshot) {
          const metadataDb = await openGuildMetadataKeyStore(authResult.user.id, getDeviceId());
          try {
            await importGuildMetadataKeySnapshot(metadataDb, bundle.guildMetadataKeySnapshot);
          } finally {
            metadataDb.close();
          }
        }
        // Decrypt the inbound encrypted transcript blob, re-encrypt it under a
        // freshly-random nonce, and persist it to this device's transcript IDB.
        // The decryption key is derived from the transferred root identity, so
        // the OLD device's PIN is never required here. The re-encrypted bytes
        // are what live at rest locally; the in-memory cache is seeded eagerly
        // from the SAME rows BEFORE we publish the auth session, so the very
        // first Chat render after link can already serve inherited transcripts
        // from the in-memory cache without a fire-and-forget race.
        if (bundle.transcriptPersistedAtRest) {
          // Streaming-importer path (slice 11): downloadArchiveSession
          // already wrote V3 frames to the per-user IDB and seeded the
          // in-memory cache via beginTranscriptCacheStream /
          // appendTranscriptCacheRows / finalizeTranscriptCacheStream.
          // Nothing more to do here — explicitly do NOT call
          // clearTranscriptCache or setTranscriptCache, which would
          // wipe out the cache state the importer just installed.
          console.info('[completeDeviceLink] transcript already persisted at rest by streaming importer');
        } else if (Array.isArray(bundle.transcriptRows)) {
          // Streaming-import path: the NEW-device pipeline decoded
          // the V3 framed transcript wire format frame-by-frame and
          // handed us the rows directly. Skip the whole-blob decrypt
          // and re-encrypt straight to the at-rest V2 blob.
          console.info(
            '[completeDeviceLink] inbound transcript rows present (streamed)',
            { rowCount: bundle.transcriptRows.length },
          );
          try {
            const importedRows = await importAndReprotectTranscriptRows({
              userId: authResult.user.id,
              rootPrivateKey: bundle.rootPrivateKey,
              rows: bundle.transcriptRows,
            });
            const sampleIds = importedRows.slice(0, 3).map((r) => r.messageId);
            console.info(
              '[completeDeviceLink] streamed transcript rows imported + re-protected',
              { rowCount: importedRows.length, firstIds: sampleIds },
            );
            setTranscriptCache(authResult.user.id, importedRows);
          } catch (err) {
            console.warn('[completeDeviceLink] streamed transcript rows import failed (link still succeeds):', err);
            clearTranscriptCache();
          }
        } else if (bundle.transcriptBlob) {
          console.info(
            '[completeDeviceLink] inbound transcript blob present',
            { byteLength: bundle.transcriptBlob.byteLength },
          );
          try {
            const importedRows = await importAndReprotectTranscriptBlob({
              userId: authResult.user.id,
              rootPrivateKey: bundle.rootPrivateKey,
              inboundBlob: bundle.transcriptBlob,
            });
            const sampleIds = importedRows.slice(0, 3).map((r) => r.messageId);
            console.info(
              '[completeDeviceLink] transcript blob imported + re-protected',
              { rowCount: importedRows.length, firstIds: sampleIds },
            );
            // Eager seed: bumps cache generation so any later stale hydrate
            // won't replace this fresh data.
            setTranscriptCache(authResult.user.id, importedRows);
          } catch (err) {
            console.warn('[completeDeviceLink] transcript blob import failed (link still succeeds):', err);
            // Make sure no stale cache from a previous user lingers.
            clearTranscriptCache();
          }
        } else {
          console.warn('[completeDeviceLink] no transcript blob in inbound bundle — old device exported nothing');
          // No inherited blob — guarantee no stale cache from a previous user.
          clearTranscriptCache();
        }
      }

      await markAuthInstanceUsed(authBaseUrl);
      publishAuthenticatedSession(authResult.token, authResult.user, authBaseUrl);
      localStorage.setItem(`${VAULT_USER_KEY_PREFIX}${authResult.user.id}`, bytesToHex(bundle.rootPublicKey));
      setHasLocalVault(true);
      setVaultState('unlocked');
      applyVaultTimeout(authResult.user.id);
      requirePinSetup();
      // P21 step 2 — write the unlocked identity from the device-link
      // bundle into the vault session key store. The keypair travelled
      // through the encrypted bundle, not via PIN, so without this the
      // newly-linked device would re-prompt for PIN on its first
      // reload even under `never`.
      void writeVaultSessionForUnlock(
        authResult.user.id,
        bundle.rootPrivateKey,
        bundle.rootPublicKey,
      );
      return authResult;
    } catch (err) {
      setError(err);
      clearSession();
      setToken(null);
      setUser(null);
      setVaultState('none');
      setHasLocalVault(false);
      identityKeyRef.current = null;
      throw err;
    } finally {
      try {
        historyDb?.close();
      } catch {
        // Ignore close errors for best-effort cleanup.
      }
      setLoading(false);
    }
  }, [applyVaultTimeout, prepareAuthenticatedSession, publishAuthenticatedSession, requirePinSetup]);

  // ── Guest auth ─────────────────────────────────────────────────────────────

  /**
   * Starts an ephemeral guest session: calls POST /api/auth/guest and sets
   * in-memory auth state. No vault, no BIP39 identity - guests have a
   * short-lived JWT and are redirected to registration on expiry.
   *
   * @returns {Promise<{ user: object }>}
   */
  const performGuestAuth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await requestGuestSession();
      const result = await finishAuth(data);
      setVaultState('unlocked'); // Guests have no vault but are "unlocked" to use the app.
      return { user: result.user };
    } catch (err) {
      setError(err);
      setToken(null);
      setUser(null);
      setVaultState('none');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [finishAuth]);

  // ── Vault PIN management ───────────────────────────────────────────────────

  /**
   * Attempts to unlock the vault with a PIN.
   * Applies progressive delays on failure and wipes vault after MAX_PIN_FAILURES.
   *
   * @param {string} pin
   */
  const unlockVault = useCallback(async (pin) => {
    const unlockPlan = planVaultUnlockAttempt(
      readPersistedAuthInvalidation(),
      authInvalidation,
    );
    if (unlockPlan.shouldDestroyLocalDeviceState) {
      destroyRevokedDeviceLocalState(unlockPlan.reason);
      const revokedError = new Error('device was revoked');
      revokedError.code = 'DEVICE_REVOKED';
      throw revokedError;
    }

    const userId = user?.id ?? localStorage.getItem(`${VAULT_USER_KEY_PREFIX}_last_user`);
    if (!userId) throw new Error('no active vault user');

    let privateKey;
    let rawKeyHex;
    let publicKey;
    let chargedCount = 0;
    let db = null;

    try {
      db = await openVaultStore(userId);
      const blob = await loadEncryptedKey(db);
      if (!blob) {
        throw new Error('vault is empty');
      }

      let attempts = await loadPinAttemptsFromIDB(db);
      if (attempts.count === 0) {
        const legacy = loadLegacyPinAttempts(userId);
        if (legacy.count > 0) attempts = legacy;
      }
      const delay = pinDelayMs(attempts.count);
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      chargedCount = attempts.count + 1;
      await savePinAttemptsToIDB(db, {
        count: chargedCount,
        lastAttemptAt: new Date().toISOString(),
      });
      localStorage.removeItem(`${PIN_ATTEMPTS_KEY_PREFIX}${userId}`);

      ({ privateKey, rawKeyHex } = await decryptVaultAndExportKey(blob, pin));
      await clearPinAttempts(userId, db);
      if (isLegacyVaultBlob(blob)) {
        await saveEncryptedKey(db, await encryptVault(privateKey, pin));
      }

      publicKey = await resolveVaultPublicKey(userId, db, privateKey);
    } catch (err) {
      if (!isVaultDecryptFailure(err)) {
        throw err;
      }

      const failurePlan = planPinFailure({
        chargedCount,
        maxFailures: MAX_PIN_FAILURES,
      });

      if (failurePlan.shouldWipeLocalVault) {
        db?.close?.();
        db = null;
        await deleteVaultDatabase(userId);
        if (failurePlan.shouldClearSession) {
          clearSession();
        }
        localStorage.removeItem(`${VAULT_USER_KEY_PREFIX}${userId}`);
        localStorage.removeItem(`${PIN_ATTEMPTS_KEY_PREFIX}${userId}`);
        setToken(null);
        setUser(null);
        setVaultState(failurePlan.nextVaultState);
        setHasLocalVault(failurePlan.nextHasLocalVault);
        identityKeyRef.current = null;

        const wipeError = new Error(failurePlan.errorMessage);
        wipeError.code = failurePlan.errorCode;
        throw wipeError;
      }

      const wrongPinError = new Error(failurePlan.errorMessage);
      wrongPinError.code = failurePlan.errorCode;
      wrongPinError.cause = err;
      throw wrongPinError;
    } finally {
      db?.close?.();
    }

    // The derived wrapping key is NOT persisted to browser storage — any
    // same-origin script could read it from sessionStorage. In the desktop
    // app the key is sent to main-process memory via IPC instead, where it
    // is unreachable from renderer scripts (contextIsolation + no nodeIntegration).
    // In the browser this call is a no-op.
    try {
      await storeVaultSessionKey(userId, rawKeyHex);
    } catch {
      // Non-fatal: desktop session continuity won't work on next reload,
      // but the current unlock session is unaffected.
    }

    identityKeyRef.current = { privateKey, publicKey };
    setHasLocalVault(true);

    // If no JWT (tab was closed, sessionStorage wiped), re-authenticate
    // with challenge-response to get a fresh session.
    const existingJwt = getLocalToken();
    if (!existingJwt && publicKey && privateKey) {
      const reauthBaseUrl = resolveReauthInstanceUrl();
      try {
        const authResult = await performChallengeResponse(privateKey, publicKey, reauthBaseUrl);
        // performChallengeResponse sets token, user, vaultState='unlocked', applyVaultTimeout.
        return authResult;
      } catch (err) {
        if (isServerSessionInvalidationError(err)) {
          markServerSessionInvalidated(AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID);
          const invalidatedError = new Error('server session no longer recognizes this local vault');
          invalidatedError.code = 'SERVER_SESSION_INVALIDATED';
          invalidatedError.cause = err;
          throw invalidatedError;
        }
        throw err;
      }
    }

    clearPinSetup();
    // Hydrate transcript cache BEFORE exposing vaultState='unlocked' so
    // first render after PIN unlock can serve inherited rows.
    try {
      await loadTranscriptCacheFromDisk({ userId, rootPrivateKey: privateKey });
    } catch (loadErr) {
      console.warn('[useAuth] transcript cache load failed:', loadErr);
      clearTranscriptCache();
    }
    setVaultState('unlocked');
    applyVaultTimeout(userId);
    // P21 step 2 — re-seal the unlocked identity into the vault
    // session key store. PIN unlock is the most common steady-state
    // unlock path; without this, the IDB record stays stale across
    // multi-day sessions and the boot read in step 3 would fall
    // back to PIN even when the user expects `never` semantics.
    // Fire-and-forget: this write must not block the unlock UX, and
    // writeVaultSessionForUnlock already swallows its own failures.
    if (publicKey) {
      void writeVaultSessionForUnlock(userId, privateKey, publicKey);
    }
    return undefined;
  }, [
    user,
    applyVaultTimeout,
    authInvalidation,
    clearPinSetup,
    destroyRevokedDeviceLocalState,
    markServerSessionInvalidated,
    performChallengeResponse,
  ]);

  /**
   * Locks the vault by clearing the in-memory private key.
   * Does NOT delete vault IDB data - use performLogout for full wipe.
   */
  const lockVault = useCallback(() => {
    const transition = planLocalVaultLock();
    if (transition.shouldClearIdentity) {
      identityKeyRef.current = null;
    }
    if (transition.shouldClearSessionKeys) {
      sessionStorage.removeItem(VAULT_DERIVED_KEY);
    }
    clearVaultTimeoutEffects();
    if (transition.shouldClearTranscriptCache) {
      clearTranscriptCache();
    }
    const userId = currentUserIdRef.current;
    if (userId && transition.shouldClearSessionKeys) {
      clearVaultSessionKey(userId).catch(() => {});
      // P21 step 4 — manual lock must invalidate the cross-reload
      // session key store so the next reload prompts for PIN. Without
      // this, the user would press "Lock" then a reload would silently
      // resume — defeating the user's intent.
      clearVaultSessionStore(userId).catch(() => {});
    }
    setVaultState(transition.nextVaultState);
  }, [clearVaultTimeoutEffects]);

  /**
   * Encrypts the current in-memory private key with a PIN and saves it to vault IDB.
   * Call this from settings UI when the user first sets or changes their PIN.
   *
   * @param {string} pin
   */
  const setPIN = useCallback(async (pin) => {
    if (!identityKeyRef.current?.privateKey) {
      throw new Error('no identity key in memory - must be unlocked first');
    }
    if (!user?.id) throw new Error('no authenticated user');

    const blob = await encryptVault(identityKeyRef.current.privateKey, pin);
    const db = await openVaultStore(user.id);
    await saveEncryptedKey(db, blob);

    // Back up PBKDF2 salt and vault marker to IDB so they survive
    // localStorage eviction on iOS non-Safari browsers.
    const saltHex = localStorage.getItem('hush_vault_salt');
    if (saltHex) {
      await saveSaltToIDB(db, vaultHexToBytes(saltHex));
    }
    const pubKeyHex = localStorage.getItem(`${VAULT_USER_KEY_PREFIX}${user.id}`);
    if (pubKeyHex) {
      await saveVaultMarkerToIDB(db, pubKeyHex);
    }

    db.close();
    setHasLocalVault(true);
    clearPinSetup();
    // P21 step 4 — rotate the cross-reload session key on PIN change.
    // Wipe the old IDB record (any stolen copy from before the PIN
    // change is now useless) and re-seal under a fresh CryptoKey.
    // For first-time PIN setup the wipe is a no-op and the re-seal
    // just refreshes whatever the unlock path already wrote.
    // Sequenced so the wipe completes before re-seal — without that,
    // `sealIdentityIntoSession` would reuse the existing CryptoKey
    // and the rotation would be a no-op. Fire-and-forget so the PIN
    // submit UX never blocks on IDB.
    const userIdSnapshot = user.id;
    const privateKeySnapshot = identityKeyRef.current.privateKey;
    const publicKeySnapshot = identityKeyRef.current.publicKey;
    clearVaultSessionStore(userIdSnapshot)
      .catch(() => {})
      .then(() =>
        writeVaultSessionForUnlock(
          userIdSnapshot,
          privateKeySnapshot,
          publicKeySnapshot,
        ),
      )
      .catch(() => {});
  }, [user, clearPinSetup]);

  /**
   * Dismisses the post-auth PIN-setup prompt while keeping the current
   * authenticated session unlocked.
   */
  const skipPinSetup = useCallback(() => {
    clearPinSetup();
  }, [clearPinSetup]);

  /**
   * Updates the persisted vault timeout policy for the current user and
   * reapplies it immediately when the vault is already unlocked.
   *
   * @param {'browser_close'|'refresh'|'never'|number} timeout
   */
  const updateVaultTimeout = useCallback((timeout) => {
    if (!user?.id) return;

    const current = getEffectiveVaultConfig(user.id);
    setVaultConfig(user.id, {
      timeout,
      pinType: current?.pinType ?? 'pin',
    });
    localStorage.removeItem(LEGACY_VAULT_TIMEOUT_KEY);

    if (vaultState === 'unlocked') {
      applyVaultTimeout(user.id);
    }
  }, [applyVaultTimeout, getEffectiveVaultConfig, user?.id, vaultState]);

  // ── Scorched-earth logout ──────────────────────────────────────────────────

  /**
   * Performs a full scorched-earth logout per IDEN-08:
   *   1. POST /api/auth/logout (best-effort)
   *   2. BroadcastChannel message to other tabs
   *   3. Delete all hush IDB databases
   *   4. Clear localStorage and sessionStorage
   *   5. Unregister all service workers
   *   6. Clear Cache API
   *   7. Reset all in-memory state
   */
  const performLogout = useCallback(async () => {
    setLoading(true);

    const jwt = getLocalToken();
    const userId = user?.id;
    const resetPlan = planLocalAuthReset(LOCAL_AUTH_RESET_REASONS.LOGOUT);

    // 1. Best-effort server logout.
    if (jwt) {
      try {
        await fetchWithAuth(jwt, '/api/auth/logout', { method: 'POST' });
      } catch {
        // Ignore - local wipe proceeds regardless.
      }
    }

    // 2. Notify other tabs.
    try {
      const bc = new BroadcastChannel('hush_auth');
      bc.postMessage({ type: 'hush_logout' });
      bc.close();
    } catch {
      // BroadcastChannel may not be available in all environments.
    }

    // 3. Clear desktop vault session key (no-op in browser).
    if (userId) clearVaultSessionKey(userId).catch(() => {});

    // 3b. P21 step 4 — clear the cross-reload vault session key
    // store. Without this, the IDB session DB and the per-tab marker
    // would survive scorched-earth logout and leak the previous
    // user's session to whoever opens the tab next. Fire-and-forget:
    // sessionStorage.clear at step 4 below already wipes the marker,
    // and the wider IDB wipe handles any leftover DB.
    if (userId) {
      clearVaultSessionStore(userId).catch(() => {});
    }

    // 4. Delete all hush IDB databases.
    const deviceId = getDeviceId();
    const deleteTargets = [];

    if (userId) {
      deleteTargets.push(
        deleteVaultDatabase(userId).catch(() => undefined),
        new Promise(resolve => {
          const req = indexedDB.deleteDatabase(`hush-mls-${userId}-${deviceId}`);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
        deleteTranscriptDatabase(userId).catch(() => undefined),
      );
    }
    if (resetPlan.shouldClearTranscriptCache) {
      clearTranscriptCache();
    }
    if (resetPlan.shouldClearAuthQueries) {
      // Clear server-state caches before slower IDB deletion settles. Any
      // concurrent auth-owned query remount should see missing auth state and
      // remain disabled rather than reusing stale data.
      clearAuthOwnedQueryCache();
    }

    await Promise.allSettled(deleteTargets);

    // 4. Clear web storage.
    localStorage.clear();
    sessionStorage.clear();

    // 5. Unregister service workers.
    if ('serviceWorker' in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.allSettled(registrations.map(r => r.unregister()));
      } catch {
        // Ignore.
      }
    }

    // 6. Clear Cache API.
    if ('caches' in window) {
      try {
        const cacheNames = await caches.keys();
        await Promise.allSettled(cacheNames.map(name => caches.delete(name)));
      } catch {
        // Ignore.
      }
    }

    // 7. Reset in-memory state.
    applyLocalAuthResetPlan(resetPlan);
  }, [user, applyLocalAuthResetPlan]);

  // ── Keep currentUserIdRef in sync with user state ─────────────────────────

  useEffect(() => {
    currentUserIdRef.current = user?.id ?? null;
  }, [user]);

  // ── Desktop auto-unlock ────────────────────────────────────────────────────

  /**
   * Attempts to auto-unlock the vault using the main-process session key.
   * Desktop-only; returns false immediately in browser context (bridge is a no-op).
   *
   * When existingJwt is null (sessionStorage cleared on reload), performs a
   * full challenge-response to obtain a fresh JWT. When existingJwt is present,
   * unlocks in-memory only and re-uses the existing session.
   *
   * @param {string} userId
   * @param {string|null} existingJwt
   * @returns {Promise<boolean>} true if vault was auto-unlocked
   */
  const tryDesktopAutoUnlock = useCallback(async (userId, existingJwt) => {
    const rawKeyHex = await retrieveVaultSessionKey(userId);
    if (!rawKeyHex) return false;

    let db = null;
    try {
      db = await openVaultStore(userId);
      const blob = await loadEncryptedKey(db);

      if (!blob) {
        clearVaultSessionKey(userId).catch(() => {});
        return false;
      }

      const privateKey = await decryptVaultWithRawKey(blob, rawKeyHex);
      const publicKey = await resolveVaultPublicKey(userId, db, privateKey);

      if (!existingJwt) {
        const reauthBaseUrl = resolveReauthInstanceUrl();
        // performChallengeResponse handles identityKeyRef, token, user,
        // vaultState, transcript cache, and applyVaultTimeout.
        await performChallengeResponse(privateKey, publicKey, reauthBaseUrl);
        return true;
      }

      // JWT still valid — unlock in memory only.
      identityKeyRef.current = { privateKey, publicKey };
      setHasLocalVault(true);
      clearPinSetup();
      try {
        await loadTranscriptCacheFromDisk({ userId, rootPrivateKey: privateKey });
      } catch (cacheErr) {
        console.warn('[useAuth] desktop auto-unlock: transcript cache load failed:', cacheErr);
        clearTranscriptCache();
      }
      setVaultState('unlocked');
      applyVaultTimeout(userId);
      // P21 step 2 — desktop auto-unlock keeps a freshly-resealed
      // session-key bundle on disk so the read path in step 3 has a
      // current entry even when the user never pressed a PIN this
      // launch (Electron + secure-storage gate). Fire-and-forget:
      // see notes on the performChallengeResponse call.
      if (publicKey) {
        void writeVaultSessionForUnlock(userId, privateKey, publicKey);
      }
      return true;
    } catch (err) {
      console.warn('[useAuth] desktop auto-unlock failed:', err);
      clearVaultSessionKey(userId).catch(() => {});
      return false;
    } finally {
      db?.close?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [performChallengeResponse, applyVaultTimeout, clearPinSetup]);

  // ── Vault session-key auto-unlock (P21 step 3) ────────────────────────────

  /**
   * Attempts to resume an unlocked vault from the cross-reload session
   * key store (`src/lib/vaultSessionKey.ts`). Honours the configured
   * vault timeout policy:
   *
   *   - `never`         — reuse IDB record on every boot.
   *   - `browser_close` — reuse only when the per-tab alive marker is
   *                       still set (soft refresh in the same tab) or
   *                       a sibling tab signals liveness (refcount
   *                       wiring lands later in P21).
   *   - `refresh`       — never reuse; the boot wipe in step 4 will
   *                       clear the IDB record.
   *   - numeric         — reuse if the inactivity deadline > now.
   *
   * When `existingJwt` is null (sessionStorage cleared by tab close),
   * the helper hands the unwrapped keypair to `performChallengeResponse`
   * to mint a fresh JWT. When the JWT survived (soft refresh), the
   * helper unlocks in-memory only.
   *
   * Best-effort: any failure → returns false → caller falls back to
   * PIN.
   *
   * @param {string} userId
   * @param {string|null} existingJwt
   * @returns {Promise<boolean>} true if vault was auto-unlocked
   */
  const tryVaultSessionAutoUnlock = useCallback(async (userId, existingJwt) => {
    if (!userId) return false;
    const config = getEffectiveVaultConfig(userId);
    const policy = config?.timeout ?? 'browser_close';
    if (policy === 'refresh') {
      // P21 step 4 — under `refresh` the policy explicitly demands a
      // fresh PIN on every reload, so wipe the IDB record proactively.
      // Otherwise it would persist as dead disk data, and a switch
      // *to* `refresh` from a more permissive policy could leave a
      // stale entry sitting until the next sign-out.
      clearVaultSessionStore(userId).catch(() => {});
      return false;
    }

    const identity = await tryVaultSessionResume(userId, config);
    if (!identity) return false;
    const { privateKey, publicKey } = identity;

    if (!existingJwt) {
      if (!publicKey) return false;
      try {
        const reauthBaseUrl = resolveReauthInstanceUrl();
        // performChallengeResponse owns identityKeyRef, token, user,
        // vaultState, transcript cache hydration, applyVaultTimeout,
        // and re-seals the session key store on its way out.
        await performChallengeResponse(privateKey, publicKey, reauthBaseUrl);
        return true;
      } catch (err) {
        console.warn('[useAuth] vault session-key challenge-response failed:', err);
        return false;
      }
    }

    // JWT still valid — unlock in memory only.
    identityKeyRef.current = { privateKey, publicKey };
    setHasLocalVault(true);
    clearPinSetup();
    try {
      await loadTranscriptCacheFromDisk({ userId, rootPrivateKey: privateKey });
    } catch (cacheErr) {
      console.warn(
        '[useAuth] vault session-key auto-unlock: transcript cache load failed:',
        cacheErr,
      );
      clearTranscriptCache();
    }
    setVaultState('unlocked');
    applyVaultTimeout(userId);
    // Refresh the marker + IDB record so the next reload sees a
    // current entry. Fire-and-forget — see notes on
    // performChallengeResponse.
    if (publicKey) {
      void writeVaultSessionForUnlock(userId, privateKey, publicKey);
    }
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [performChallengeResponse, applyVaultTimeout, clearPinSetup, getEffectiveVaultConfig]);

  // ── Startup: session rehydration ──────────────────────────────────────────

  useEffect(() => {
    const stored = getLocalToken();

    if (!stored) {
      clearPinSetup();

      const startupPlan = planNoTokenStartup(authInvalidation);
      if (startupPlan.shouldDestroyLocalDeviceState) {
        destroyRevokedDeviceLocalState(AUTH_INVALIDATION_REASONS.DEVICE_REVOKED);
        setHasLocalVault(startupPlan.nextHasLocalVault);
        setVaultState(startupPlan.nextVaultState);
        setLoading(false);
        return undefined;
      }

      // No JWT - but vault may still exist (tab closed, sessionStorage wiped).
      // Check localStorage for vault marker. If found, show PIN unlock;
      // after unlock, challenge-response auth gets a fresh JWT.
      const vaultUserId = findVaultMarkerUserId();
      if (vaultUserId) {
        localStorage.setItem(`${VAULT_USER_KEY_PREFIX}_last_user`, vaultUserId);

        if (authInvalidation) {
          applyBootVaultPlan(planNoTokenLocalVaultBoot({
            hasAuthInvalidation: true,
            vaultExists: true,
          }));
          setLoading(false);
          return undefined;
        }

        // Verify the vault actually has an encrypted key (PIN was set).
        // If registration completed but PIN was never set (iOS killed page
        // before PIN setup), the vault marker exists but no encrypted blob.
        // In that case, fall through to 'none' so the user can re-register/recover.
        let idbCheckCancelled = false;
        (async () => {
          try {
            const result = await checkVaultExistsInIDB(vaultUserId);
            if (idbCheckCancelled) return;
            if (result.exists) {
              // Try the vault session-key store first — under `never`
              // / `browser_close` (with marker) / numeric (within
              // deadline), this resumes unlocked without PIN. Falls
              // back to desktop auto-unlock, then PIN.
              let unlocked = await tryVaultSessionAutoUnlock(vaultUserId, null);
              if (idbCheckCancelled) return;
              if (!unlocked) {
                unlocked = await tryDesktopAutoUnlock(vaultUserId, null);
                if (idbCheckCancelled) return;
              }
              if (!unlocked) {
                applyBootVaultPlan(planNoTokenLocalVaultBoot({ vaultExists: true }));
              }
            } else {
              // Vault marker set during registration but PIN never set - clear stale marker.
              const bootPlan = planNoTokenLocalVaultBoot({ vaultExists: false });
              if (bootPlan.shouldClearVaultMarker) {
                localStorage.removeItem(`${VAULT_USER_KEY_PREFIX}${vaultUserId}`);
              }
              applyBootVaultPlan(bootPlan);
            }
          } catch {
            if (!idbCheckCancelled) {
              applyBootVaultPlan(planNoTokenLocalVaultBoot({ vaultCheckFailed: true }));
            }
          }
          if (!idbCheckCancelled) setLoading(false);
        })();
        return () => { idbCheckCancelled = true; };
      }

      // localStorage marker missing - iOS non-Safari browsers may have evicted
      // localStorage while IndexedDB survives. Check IDB for vault existence.
      // Also try to find userId from the last_user hint in localStorage.
      const lastUser = localStorage.getItem(`${VAULT_USER_KEY_PREFIX}_last_user`);
      let idbCancelled = false;
      (async () => {
        try {
          // Try known userId first, then scan IDB databases for vault pattern.
          const candidates = lastUser ? [lastUser] : [];

          // indexedDB.databases() returns all IDB databases - scan for vault DBs.
          if (!candidates.length && typeof indexedDB.databases === 'function') {
            const dbs = await indexedDB.databases();
            for (const db of dbs) {
              const match = db.name?.match(/^hush-vault-(.+)$/);
              if (match) candidates.push(match[1]);
            }
          }

          if (idbCancelled) return;

          for (const userId of candidates) {
            const result = await checkVaultExistsInIDB(userId);
            if (idbCancelled) return;
            if (result.exists) {
              if (authInvalidation) {
                applyBootVaultPlan(planNoTokenLocalVaultBoot({
                  hasAuthInvalidation: true,
                  vaultExists: true,
                }));
                setLoading(false);
                return;
              }
              // Vault found in IDB - restore localStorage markers from IDB backup.
              if (result.publicKeyHex) {
                localStorage.setItem(`${VAULT_USER_KEY_PREFIX}${userId}`, result.publicKeyHex);
              }
              localStorage.setItem(`${VAULT_USER_KEY_PREFIX}_last_user`, userId);
              let unlocked = await tryVaultSessionAutoUnlock(userId, null);
              if (idbCancelled) return;
              if (!unlocked) {
                unlocked = await tryDesktopAutoUnlock(userId, null);
                if (idbCancelled) return;
              }
              if (!unlocked) {
                applyBootVaultPlan(planNoTokenLocalVaultBoot({ vaultExists: true }));
              }
              setLoading(false);
              return;
            }
          }
        } catch {
          // IDB check failed - fall through to no-vault state.
        }

        if (!idbCancelled) {
          if (getLocalToken()) {
            setLoading(false);
            return;
          }
          // No vault at all - show login/register.
          setLoading(false);
          applyBootVaultPlan(planNoTokenLocalVaultBoot({ vaultExists: false }));
        }
      })();
      // eslint-disable-next-line no-return-assign
      return () => { idbCancelled = true; };
    }

    let cancelled = false;

    (async () => {
      try {
        const res = await fetchWithAuth(stored, '/api/auth/me');
        if (cancelled) return;

        if (res.status === 401) {
          markServerSessionInvalidated(AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID);
          return;
        }

        if (!res.ok) {
          // Transient error - keep session alive, fall through to state check.
          setToken(stored);
          // State determined below.
        } else {
          const u = await res.json();
          if (cancelled) return;
          setToken(stored);
          setUser(u);

          let vaultPublicKeyHex = localStorage.getItem(`${VAULT_USER_KEY_PREFIX}${u.id}`);
          let idbVaultCheck = null;
          if (!vaultPublicKeyHex) {
            idbVaultCheck = await checkVaultExistsInIDB(u.id);
            if (cancelled) return;
            if (idbVaultCheck.publicKeyHex) {
              vaultPublicKeyHex = idbVaultCheck.publicKeyHex;
              try {
                localStorage.setItem(`${VAULT_USER_KEY_PREFIX}${u.id}`, vaultPublicKeyHex);
              } catch {
                // IDB backup is enough to detect the local vault on this boot.
              }
            }
          }

          if (vaultPublicKeyHex || idbVaultCheck?.exists) {
            setHasLocalVault(true);
            // The wrapping key is no longer cached in browser storage
            // (see ans23 / F3). Any leftover entry from a previous
            // install is purged here so it cannot be read by anything
            // running on this origin.
            sessionStorage.removeItem(VAULT_DERIVED_KEY);

            // Trigger one-shot migration of the legacy global vault
            // timeout key into the per-user config. Run eagerly here so
            // the user's existing timeout preference is preserved regardless
            // of whether the vault auto-unlocks (desktop) or waits for PIN.
            getEffectiveVaultConfig(u.id);

            // Always require PIN re-entry: verify the vault blob actually
            // exists before showing the PIN screen. The vault marker
            // (public key hex) is written during registration, but the
            {
              // No derived key persistence by design - verify the vault blob
              // actually exists before showing PIN screen. The vault marker
              // (public key hex) is written during registration, but the
              // encrypted blob is only created when the user sets a PIN. If
              // they skipped PIN setup, the marker exists but the vault is empty.
              try {
                const db = await openVaultStore(u.id);
                const blob = await loadEncryptedKey(db);
                db.close();
                if (cancelled) return;
                if (blob) {
                  let unlocked = await tryVaultSessionAutoUnlock(u.id, stored);
                  if (cancelled) return;
                  if (!unlocked) {
                    unlocked = await tryDesktopAutoUnlock(u.id, stored);
                    if (cancelled) return;
                  }
                  if (!unlocked) {
                    clearPinSetup();
                    applyBootVaultPlan(planAuthenticatedVaultBoot({
                      hasVaultEvidence: true,
                      hasEncryptedVaultBlob: true,
                    }));
                  }
                } else {
                  // Stale marker - PIN was never set. Clear it.
                  const bootPlan = planAuthenticatedVaultBoot({
                    hasVaultEvidence: true,
                    hasEncryptedVaultBlob: false,
                  });
                  if (bootPlan.shouldClearVaultMarker) {
                    localStorage.removeItem(`${VAULT_USER_KEY_PREFIX}${u.id}`);
                  }
                  applyBootVaultPlan(bootPlan);
                }
              } catch {
                if (!cancelled) {
                  const bootPlan = planAuthenticatedVaultBoot({
                    hasVaultEvidence: true,
                    vaultCheckFailed: true,
                  });
                  applyBootVaultPlan(bootPlan);
                  clearPinSetup();
                }
              }
            }
          } else {
            // Authenticated via JWT but no vault set up yet (PIN never configured).
            applyBootVaultPlan(planAuthenticatedVaultBoot({ hasVaultEvidence: false }));
          }
        }
      } catch {
        // Network error - keep token, keep as locked if vault exists.
        setToken(stored);
        applyBootVaultPlan(planAuthenticatedSessionFetchFailure({
          hasVaultMarker: Boolean(findVaultMarkerUserId()),
        }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    applyBootVaultPlan,
    authInvalidation,
    clearPinSetup,
    destroyRevokedDeviceLocalState,
    markServerSessionInvalidated,
  ]);

  // ── Request persistent storage ───────────────────────────────────────────
  // Opt out of best-effort eviction on iOS. Without this, non-Safari browsers
  // (Chrome iOS, Google in-app) may lose localStorage and IDB under memory
  // pressure because WKWebView apps get lower storage quotas.

  useEffect(() => {
    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => { /* best-effort */ });
    }
  }, []);

  // ── Vault session presence (P21 step 5) ───────────────────────────────────
  //
  // Holds a BroadcastChannel open for the lifetime of an unlocked tab so
  // other tabs of the same user can probe "is anyone alive?" before the
  // vault-session boot resume. Without this, a fresh tab opening under
  // `browser_close` while another tab is already unlocked would miss the
  // sibling and force a PIN prompt — defeating the policy's "stays
  // unlocked while any tab of mine is open" promise.
  //
  // Skipped under Vitest: keeping ~60 BroadcastChannels open across the
  // useAuth test suite (one per renderHook → vaultState=unlocked
  // transition) measurably slowed the fire-and-forget IDB seal in
  // jsdom. The boot probe in `tryVaultSessionResume` is unit-tested
  // directly against `createVaultSessionPresence`, so production
  // semantics stay covered.
  useEffect(() => {
    if (vaultState !== 'unlocked' || !user?.id) return;
    if (
      typeof import.meta !== 'undefined' &&
      import.meta.env?.MODE === 'test'
    ) {
      return;
    }
    const presence = createVaultSessionPresence(user.id);
    const onPageHide = () => presence.close();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      presence.close();
    };
  }, [vaultState, user?.id]);

  // ── Visibility change re-verification ─────────────────────────────────────

  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      const stored = getLocalToken();
      if (!stored) return;

      try {
        const res = await fetchWithAuth(stored, '/api/auth/me');
        if (res.status === 401) {
          markServerSessionInvalidated(AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID);
          window.location.href = '/';
        }
      } catch {
        // Network error - don't log out, user may be offline.
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [markServerSessionInvalidated]);

  // ── Inactivity cleanup on vault lock / guest timer cleanup on unmount ──────

  useEffect(() => {
    if (vaultState !== 'unlocked') {
      clearVaultTimeoutEffects();
    }
  }, [vaultState, clearVaultTimeoutEffects]);

  useEffect(() => {
    return () => {
      // Cancel guest timers when the hook unmounts (e.g. during tests or
      // full page navigation) to prevent state updates on unmounted components.
      clearGuestTimers();
    };
  }, [clearGuestTimers]);

  // ── BroadcastChannel logout listener ─────────────────────────────────────

  useEffect(() => {
    let bc;
    try {
      bc = new BroadcastChannel('hush_auth');
      bc.onmessage = (event) => {
        if (event.data?.type === 'hush_logout') {
          const resetPlan = planLocalAuthReset(LOCAL_AUTH_RESET_REASONS.BROADCAST_LOGOUT);
          applyLocalAuthResetPlan(resetPlan);
        }
        if (event.data?.type === 'hush_device_revoked') {
          destroyRevokedDeviceLocalState(AUTH_INVALIDATION_REASONS.DEVICE_REVOKED);
        }
      };
    } catch {
      // BroadcastChannel unavailable.
    }
    return () => { try { bc?.close(); } catch { /* noop */ } };
  }, [applyLocalAuthResetPlan, destroyRevokedDeviceLocalState]);

  // ── Forced logout on device revocation ───────────────────────────────────
  // The server returns 401 "device revoked" on any authenticated HTTP call
  // and closes any active WS with policy-violation 1008 + "device revoked".
  // Both surfaces dispatch a window 'hush_auth_invalid' event (api.js +
  // ws.js). React to it by tearing down the trusted session. Generic
  // server invalidation preserves a local vault for recovery; device_revoked
  // is destructive and must not leave a PIN-resumable identity behind.
  useEffect(() => {
    function handleAuthInvalid(event) {
      const reason = event?.detail?.reason || AUTH_INVALIDATION_REASONS.SERVER_SESSION_INVALID;
      console.warn('[useAuth] forced logout due to server invalidation signal', { reason });
      markServerSessionInvalidated(reason);
      if (reason === AUTH_INVALIDATION_REASONS.DEVICE_REVOKED) {
        try {
          const bc = new BroadcastChannel('hush_auth');
          bc.postMessage({ type: 'hush_device_revoked' });
          bc.close();
        } catch {
          // BroadcastChannel unavailable.
        }
      }
    }
    if (typeof window === 'undefined') return undefined;
    window.addEventListener('hush_auth_invalid', handleAuthInvalid);
    return () => window.removeEventListener('hush_auth_invalid', handleAuthInvalid);
  }, [markServerSessionInvalidated]);

  return {
    user,
    token,
    vaultState,
    hasVault,
    hasSession,
    isVaultUnlocked,
    needsUnlock,
    isKnownBrowserProfile,
    isAuthenticated,
    loading,
    error,
    authInvalidation,
    needsPinSetup,
    // Canonical auth/device/vault lifecycle. Prefer this over the legacy
    // booleans for new code. See
    // `hush-web/docs/security/auth-device-lifecycle.md`.
    lifecycle,
    performChallengeResponse,
    performRegister,
    performRecovery,
    completeDeviceLink,
    performGuestAuth,
    unlockVault,
    lockVault,
    setPIN,
    updateVaultTimeout,
    skipPinSetup,
    performLogout,
    clearError,
    clearAuthInvalidation,
    // Ref to the in-memory identity keypair. Used by useInstances for
    // challenge-response auth on remote instances. Never serialized.
    identityKeyRef,
    // Transparency log error state. Set externally by ServerLayout when
    // TransparencyVerifier.verifyOwnKey() detects a key mismatch.
    // Non-null value blocks the app UI (hard-fail policy).
    transparencyError,
    setTransparencyError,
    // Guest session state. isGuest=true for ephemeral guest sessions;
    // guestExpiresAt is an ISO timestamp string for countdown display.
    isGuest,
    guestExpiresAt,
    // Voice disconnect hook. Voice components should set:
    //   voiceDisconnectRef.current = () => room.disconnect()
    // and clear it on unmount. Used by guest expiry to clean up the call.
    voiceDisconnectRef,
    // Legacy aliases preserved for compatibility with existing consumers.
    isLoading: loading,
  };
}

// ── Local hex helpers (mirrors identityVault.hexToBytes without import cycle) ─

/**
 * Converts a hex string to a Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return result;
}
