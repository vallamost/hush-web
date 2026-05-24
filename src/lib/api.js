/**
 * HTTP client for the Go backend API.
 * Assumes auth token is passed per-request or set elsewhere.
 */

import * as mlsStore from './mlsStore';
import { getActiveAuthInstanceUrlSync, getSelectedAuthInstanceUrlSync } from './authInstanceStore';
import * as hushCrypto from './hushCrypto';
import { getReadableDeviceLabel } from './deviceLabel';
import {
  parseAuthChallengeResponse,
  parseAuthResponse,
  parseDeviceKeys,
  parseDeviceLinkResolvedClaim,
  parseDeviceLinkRequestResponse,
  parseDeviceLinkResult,
  parseFederatedAuthResponse,
  parseGuestSessionResponse,
  parseUsernameAvailabilityResponse,
} from './apiSchemas';
import { readJsonResponse, readJsonResponseOrNull } from './apiJson';
import { uploadKeyPackagesAfterAuth as uploadKeyPackagesAfterAuthImpl } from './uploadKeyPackages';
import { detectSessionInvalidation } from './sessionInvalidationDetector';
import { CURRENT_MLS_CIPHERSUITE, assertHandshakeMLSCiphersuiteMatches } from './mlsCiphersuite';
import { requestUpdate } from './updateRequired';

const USERNAME_CHECK_TIMEOUT_MS = 8000;
const HANDSHAKE_TIMEOUT_MS = 10000;

function resolveAuthBaseUrl(baseUrl = '') {
  return baseUrl || getSelectedAuthInstanceUrlSync();
}

/**
 * Reduces an audience URL to canonical `scheme://host[:port]` form:
 * scheme/host lowercased, default port stripped, no path/query/fragment,
 * no trailing slash. Returns `''` for inputs that lack a usable
 * http(s) scheme + host — callers must treat `''` as "no usable
 * audience" and refuse to sign rather than substituting a default.
 *
 * This mirrors the server's `auth.NormalizeAudience` byte-for-byte so
 * the v2 challenge payload produced on either side matches.
 *
 * @param {string} raw
 * @returns {string} normalized origin, or `''` when input is unusable.
 */
export function normalizeAudience(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return '';
  const host = parsed.hostname.toLowerCase();
  if (!host) return '';
  let port = parsed.port;
  if ((scheme === 'https' && port === '443') || (scheme === 'http' && port === '80')) {
    port = '';
  }
  return port ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
}

/**
 * Derives the canonical audience origin for the BIP39 challenge flow
 * from the same `baseUrl` resolution used by `requestChallenge` /
 * `verifyChallenge`. Returns `''` if no usable origin can be derived
 * (e.g. desktop running without a selected instance). Callers must
 * treat `''` as a hard error — never sign without a real audience.
 *
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function resolveAuthAudience(baseUrl = '') {
  return normalizeAudience(resolveAuthBaseUrl(baseUrl));
}

function resolveFetchBaseUrl(path, baseUrl = '') {
  if (baseUrl || path.startsWith('http')) {
    return baseUrl;
  }
  if (path.startsWith('/api/auth') || (path.startsWith('/api/') && shouldUseActiveInstanceForRelativeApi())) {
    return getActiveAuthInstanceUrlSync();
  }
  return '';
}

function shouldUseActiveInstanceForRelativeApi() {
  if (typeof window === 'undefined') {
    return false;
  }
  if (window.hushDesktop?.isDesktop) {
    return true;
  }
  const protocol = window.location?.protocol;
  return protocol !== 'http:' && protocol !== 'https:';
}

function buildRequestUrl(path, baseUrl = '') {
  if (path.startsWith('http')) {
    return path;
  }
  return `${baseUrl}${path}`;
}

function resolveRequestUrl(path, baseUrl = '') {
  return buildRequestUrl(path, resolveFetchBaseUrl(path, baseUrl));
}

function createNetworkError(operation, targetUrl, err) {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const isConnectivityError = /load failed|failed to fetch|networkerror/i.test(rawMessage);
  const message = isConnectivityError
    ? `${operation} failed. Could not reach ${targetUrl}.`
    : `${operation} failed for ${targetUrl}: ${rawMessage}`;
  const nextError = new Error(message);
  if (err instanceof Error) {
    nextError.cause = err;
  }
  console.error(`[api] ${operation} failed`, { url: targetUrl, err });
  return nextError;
}

function getApiErrorMessage(data, fallback) {
  if (data && typeof data.error === 'string' && data.error.trim()) {
    return data.error;
  }
  return fallback;
}

function createApiHttpError(data, fallback, status) {
  const err = new Error(getApiErrorMessage(data, fallback));
  err.status = status;
  return err;
}

function createFetchSignal(timeoutMs, callerSignal) {
  if (typeof AbortController === 'undefined') {
    return {
      signal: callerSignal,
      cleanup() {},
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let removeCallerAbortListener = null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      const forwardAbort = () => controller.abort();
      callerSignal.addEventListener('abort', forwardAbort, { once: true });
      removeCallerAbortListener = () => {
        callerSignal.removeEventListener('abort', forwardAbort);
      };
    }
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      removeCallerAbortListener?.();
    },
  };
}

/**
 * @param {string} token - JWT
 * @param {string} path - e.g. /api/keys/upload
 * @param {RequestInit} [opts]
 * @param {string} [baseUrl] - Optional base URL for cross-instance calls (e.g. 'https://other.instance.com'). Defaults to '' (relative URL).
 * @returns {Promise<Response>}
 */
export async function fetchWithAuth(token, path, opts = {}, baseUrl = '') {
  const resolvedBaseUrl = resolveFetchBaseUrl(path, baseUrl);
  const url = path.startsWith('http') ? path : `${resolvedBaseUrl}${path}`;
  const headers = new Headers(opts.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(url, { ...opts, headers });
  // Server-session invalidation surface: classify a 401 only when
  // either a structured `error_code` declares it, or the call hit a
  // session-aware endpoint (auth/session/livekit-token) AND the human-
  // readable error matches a narrow pattern. Plain expired tokens, and
  // any 401 from product endpoints (member lookups, channel reads, …)
  // surface to the caller without firing the global event so the UI is
  // not torn down for an unrelated 401.
  if (res.status === 401) {
    try {
      const cloned = res.clone();
      const body = await cloned.json().catch(() => null);
      const detected = detectSessionInvalidation({ path, body });
      if (detected && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('hush_auth_invalid', {
          detail: { reason: detected.reason },
        }));
      }
    } catch { /* ignore — surface the original 401 to the caller */ }
  }
  // Compatibility-failure surface: when the server reports HTTP 426
  // (Upgrade Required) or returns a structured body that flags an MLS
  // ciphersuite mismatch, raise the global Update Required dialog. The
  // response is still returned to the caller so existing error handling
  // continues to work; the dialog is purely additive.
  await maybeDispatchCompatibilityFailure(res, path);
  return res;
}

/**
 * Inspect a runtime API response for known compatibility failures and
 * dispatch the global `hush:update-required` event so the dialog appears.
 *
 * Triggers:
 *   - HTTP 426 Upgrade Required (any endpoint).
 *   - Response body with `error === 'mls_ciphersuite_mismatch'` (the MLS
 *     write boundary on the Go server) — typically a 400 with a structured
 *     body. We tolerate a non-JSON body by silently ignoring it.
 *
 * The function never throws: a compatibility-detection failure must not
 * mask the original response from the caller.
 */
async function maybeDispatchCompatibilityFailure(res, path) {
  if (!res || typeof res !== 'object') return;
  try {
    if (res.status === 426) {
      requestUpdate({ reason: 'api-426', context: { path, status: 426 } });
      return;
    }
    if (res.status >= 400 && typeof res.clone === 'function') {
      const cloned = res.clone();
      const body = await cloned.json().catch(() => null);
      if (body && body.error === 'mls_ciphersuite_mismatch') {
        requestUpdate({
          reason: 'api-mls-ciphersuite-mismatch',
          context: {
            path,
            declared: body.declared,
            current: body.current_ciphersuite,
          },
        });
        return;
      }
      if (
        body &&
        typeof body.error === 'string' &&
        body.error.toLowerCase().includes('ciphersuite is required')
      ) {
        requestUpdate({
          reason: 'api-compat-error',
          context: { path, error: body.error },
        });
      }
    }
  } catch {
    /* never let compat detection break the caller's flow */
  }
}

/**
 * Upload MLS credential (public material only) to the server.
 * @param {string} token - JWT
 * @param {{ deviceId: string, credentialBytes: number[], signingPublicKey: number[] }} body
 * @returns {Promise<void>}
 */
export async function uploadMLSCredential(token, body, baseUrl = '') {
  let res;
  try {
    res = await fetchWithAuth(token, '/api/mls/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ciphersuite: CURRENT_MLS_CIPHERSUITE }),
    }, baseUrl);
  } catch (err) {
    throw createNetworkError('upload MLS credential', resolveRequestUrl('/api/mls/credentials', baseUrl), err);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `upload MLS credential ${res.status}`);
  }
}

/**
 * Upload a batch of MLS KeyPackages to the server.
 * @param {string} token - JWT
 * @param {{ deviceId: string, keyPackages: number[][], expiresAt?: string, lastResort?: boolean }} body
 * @returns {Promise<void>}
 */
export async function uploadMLSKeyPackages(token, body, baseUrl = '') {
  let res;
  try {
    res = await fetchWithAuth(token, '/api/mls/key-packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ciphersuite: CURRENT_MLS_CIPHERSUITE }),
    }, baseUrl);
  } catch (err) {
    throw createNetworkError('upload MLS key packages', resolveRequestUrl('/api/mls/key-packages', baseUrl), err);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `upload MLS key packages ${res.status}`);
  }
}

/**
 * Get the current KeyPackage count for this device from the server.
 * Used by key maintenance to decide whether to replenish KeyPackages.
 * @param {string} token - JWT
 * @param {string} deviceId - Device ID
 * @returns {Promise<number>}
 */
export async function getKeyPackageCount(token, deviceId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/mls/key-packages/count?deviceId=${encodeURIComponent(deviceId)}`, {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `getKeyPackageCount ${res.status}`);
  }
  const data = await res.json();
  return data.count;
}

/**
 * Fetch pre-key bundle(s) for a user (all devices).
 * @param {string} token - JWT
 * @param {string} userId - Target user UUID
 * @returns {Promise<Array<object>>}
 */
export async function getPreKeyBundle(token, userId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/keys/${userId}`, {}, baseUrl);
  if (!res.ok) {
    if (res.status === 404) return [];
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `get prekey bundle ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch pre-key bundle for a user and device.
 * @param {string} token - JWT
 * @param {string} userId - Target user UUID
 * @param {string} deviceId - Target device ID
 * @returns {Promise<object>}
 */
export async function getPreKeyBundleByDevice(token, userId, deviceId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/keys/${userId}/${encodeURIComponent(deviceId)}`, {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `get prekey bundle ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch paginated message history for a channel. Ciphertext is base64; client decrypts locally.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID the channel belongs to
 * @param {string} channelId - Channel UUID
 * @param {{ before?: string, after?: string, limit?: number }} [opts] - before/after: RFC3339 cursor (mutually exclusive); limit: default 50, max 50
 * @returns {Promise<Array<{ id: string, channelId: string, senderId: string, ciphertext: string, timestamp: string }>>}
 */
export async function getChannelMessages(token, serverId, channelId, opts = {}, baseUrl = '') {
  const params = new URLSearchParams();
  if (opts.before) params.set('before', opts.before);
  if (opts.after) params.set('after', opts.after);
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const path = `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages${qs ? `?${qs}` : ''}`;
  const res = await fetchWithAuth(token, path, {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `get messages ${res.status}`);
  }
  return res.json();
}

/**
 * Presign an attachment upload for the given channel. Server validates
 * size + content-type against the same allowlist enforced client-side
 * in `attachmentLimits.ts`. Returns the freshly-minted attachment id
 * plus the upload URL the client must PUT the ciphertext to.
 *
 * @param {string} token
 * @param {string} serverId
 * @param {string} channelId
 * @param {{ size: number, contentType: string }} body
 * @param {string} [baseUrl]
 * @returns {Promise<{ id: string, uploadUrl: string, method: string, headers?: Record<string,string>, expiresAt: string }>}
 */
export async function presignAttachment(token, serverId, channelId, body, baseUrl = '') {
  const path = `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/attachments/presign`;
  const res = await fetchWithAuth(token, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `presign attachment ${res.status}`);
  }
  return res.json();
}

/**
 * Get a presigned download URL for an attachment. Server checks the
 * caller is a member of the attachment's owning channel.
 *
 * @param {string} token
 * @param {string} attachmentId
 * @param {string} [baseUrl]
 * @returns {Promise<{ url: string, expiresAt: string }>}
 */
export async function getAttachmentDownloadUrl(token, attachmentId, baseUrl = '') {
  const path = `/api/attachments/${encodeURIComponent(attachmentId)}/download`;
  const res = await fetchWithAuth(token, path, {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 410) {
      throw new Error(err.error || 'attachment unavailable');
    }
    throw new Error(err.error || `download url ${res.status}`);
  }
  return res.json();
}

/**
 * Soft-delete an attachment. Owner-only on the server. Returns 204 on
 * success; 404 if the row does not exist or the caller is not the
 * owner. Backend best-effort calls Backend.Delete; orphans are reaped
 * by the supervised purger.
 *
 * @param {string} token
 * @param {string} attachmentId
 * @param {string} [baseUrl]
 */
export async function deleteAttachment(token, attachmentId, baseUrl = '') {
  const path = `/api/attachments/${encodeURIComponent(attachmentId)}`;
  const res = await fetchWithAuth(token, path, { method: 'DELETE' }, baseUrl);
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `delete attachment ${res.status}`);
  }
}

/**
 * Search Giphy through the server-side proxy. Hides the user's IP
 * and key from Giphy and returns the upstream response shape verbatim
 * so `@giphy/react-components` Grid can consume it directly. Empty
 * query → trending; non-empty → search. Pagination via `offset`.
 *
 * @param {string} token
 * @param {{ q?: string, offset?: number, limit?: number, baseUrl?: string }} opts
 * @returns {Promise<import("@giphy/js-fetch-api").GifsResult>}
 */
export async function searchGifs(token, opts = {}) {
  const { q = '', offset = 0, limit = 25, baseUrl = '' } = opts;
  const params = new URLSearchParams({
    q,
    offset: String(offset),
    limit: String(limit),
  });
  const path = `/api/gif/search?${params.toString()}`;
  const res = await fetchWithAuth(token, path, {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `gif search ${res.status}`);
  }
  return res.json();
}

/**
 * Get current instance metadata.
 * @param {string} token - JWT
 * @returns {Promise<{ id: string, name: string, iconUrl?: string, ownerId: string, registrationMode: string, serverCreationPolicy: string, createdAt: string, bootstrapped: boolean }>}
 */
export async function getInstance(token, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/instance', {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `get instance ${res.status}`);
  }
  return res.json();
}

/**
 * Update instance metadata (owner-only).
 * @param {string} token - JWT
 * @param {{ name?: string, iconUrl?: string, registrationMode?: string }} body
 * @returns {Promise<void>}
 */
export async function updateInstance(token, body, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/instance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `update instance ${res.status}`);
  }
}

// ── Transparency Log API ──────────────────────────────────────────────────────

/**
 * Fetch Merkle inclusion proofs for all transparency log entries for a public key.
 *
 * Called by TransparencyVerifier to independently verify that key operations
 * were logged correctly by the server.
 *
 * @param {string} token      - JWT for authenticated API calls.
 * @param {string} pubkeyHex  - Hex-encoded 32-byte Ed25519 public key.
 * @param {string} [baseUrl]  - Optional base URL for cross-instance calls.
 * @returns {Promise<{ entries: object[], proofs: object[], treeHead: object }>}
 */
export async function verifyTransparency(token, pubkeyHex, baseUrl = '') {
  const url = `${baseUrl}/api/transparency/verify?pubkey=${encodeURIComponent(pubkeyHex)}`;
  const r = await fetchWithAuth(token, url, {}, '');
  if (!r.ok) throw new Error(`Transparency verify failed: ${r.status}`);
  return r.json();
}

// ── BIP39 Auth API ────────────────────────────────────────────────────────────

/**
 * Request a challenge nonce for a given public key.
 * The server issues a nonce that must be signed with the matching private key.
 *
 * @param {string} publicKeyBase64 - Base64-encoded 32-byte Ed25519 public key.
 * @returns {Promise<{ nonce: string }>} Hex-encoded nonce.
 */
export async function requestChallenge(publicKeyBase64, baseUrl = '') {
  const authBaseUrl = resolveAuthBaseUrl(baseUrl);
  const targetUrl = `${authBaseUrl}/api/auth/challenge`;
  let res;
  try {
    res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: publicKeyBase64 }),
    });
  } catch (err) {
    throw createNetworkError('request challenge', targetUrl, err);
  }
  const data = res.ok
    ? await readJsonResponse(res, 'requestChallenge')
    : await readJsonResponseOrNull(res, 'requestChallenge');
  if (!res.ok) {
    throw createApiHttpError(data, `requestChallenge ${res.status}`, res.status);
  }
  return parseAuthChallengeResponse(data);
}

/**
 * Verify a signed challenge nonce and receive a JWT session token.
 *
 * `audience` is the canonical API origin the v2 signature was produced
 * for. When present it is sent along with `challengeVersion: 2` so the
 * server enforces the audience-bound v2 protocol; when omitted the
 * request stays in the legacy v1 path so older callers that have not
 * been migrated keep working. Migrated callers must always pass it.
 *
 * @param {string} publicKeyBase64 - Base64-encoded Ed25519 public key.
 * @param {string} nonce - Hex nonce from requestChallenge.
 * @param {string} signatureBase64 - Base64-encoded 64-byte Ed25519 signature.
 * @param {string} deviceId - Stable per-device identifier (UUID).
 * @param {string} [baseUrl] - Auth instance base URL. Honored exactly as
 *   given; this function does NOT collapse explicit `baseUrl` to
 *   same-origin.
 * @param {string} [audience] - Canonical API origin the signature was
 *   produced for. Must already be normalized.
 * @returns {Promise<{ token: string, user: object }>}
 */
export async function verifyChallenge(publicKeyBase64, nonce, signatureBase64, deviceId, baseUrl = '', audience = '') {
  const authBaseUrl = resolveAuthBaseUrl(baseUrl);
  const targetUrl = `${authBaseUrl}/api/auth/verify`;
  const body = {
    publicKey: publicKeyBase64,
    nonce,
    signature: signatureBase64,
    deviceId,
    label: getReadableDeviceLabel(),
  };
  if (audience) {
    body.audience = audience;
    body.challengeVersion = 2;
  }
  let res;
  try {
    res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw createNetworkError('verify challenge', targetUrl, err);
  }
  const data = res.ok
    ? await readJsonResponse(res, 'verifyChallenge')
    : await readJsonResponseOrNull(res, 'verifyChallenge');
  if (!res.ok) {
    throw createApiHttpError(data, `verifyChallenge ${res.status}`, res.status);
  }
  return parseAuthResponse(data, 'verifyChallenge');
}

/**
 * Authenticate on a foreign instance as a federated user.
 * Uses the same nonce from /challenge - the server verifies the Ed25519 signature
 * and upserts a federated_identity record instead of a local user.
 *
 * @param {string} publicKeyBase64 - Base64-encoded Ed25519 public key.
 * @param {string} nonce - Hex nonce from /challenge response.
 * @param {string} signatureBase64 - Base64-encoded Ed25519 signature over nonce bytes.
 * @param {string} homeInstance - URL of the user's home instance.
 * @param {string} username - Username on the home instance.
 * @param {string} displayName - Display name on the home instance.
 * @param {string} [baseUrl=''] - Foreign instance base URL.
 * @returns {Promise<{ token: string, federatedIdentity: object }>}
 */
export async function federatedVerify(
  publicKeyBase64,
  nonce,
  signatureBase64,
  homeInstance,
  username,
  displayName,
  baseUrl = '',
) {
  const authBaseUrl = resolveAuthBaseUrl(baseUrl);
  const targetUrl = `${authBaseUrl}/api/auth/federated-verify`;
  let res;
  try {
    res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: publicKeyBase64,
        nonce,
        signature: signatureBase64,
        homeInstance,
        username,
        displayName,
      }),
    });
  } catch (err) {
    throw createNetworkError('federated-verify', targetUrl, err);
  }
  const data = res.ok
    ? await readJsonResponse(res, 'federatedVerify')
    : await readJsonResponseOrNull(res, 'federatedVerify');
  if (!res.ok) {
    throw createApiHttpError(data, `federatedVerify ${res.status}`, res.status);
  }
  return parseFederatedAuthResponse(data);
}

/**
 * Request an ephemeral guest session token.
 * No account is created. The JWT carries is_guest=true and a short expiry.
 *
 * @param {string} [baseUrl='']
 * @returns {Promise<{ token: string, guestId: string, expiresAt: string }>}
 */
export async function requestGuestSession(baseUrl = '') {
  const authBaseUrl = resolveAuthBaseUrl(baseUrl);
  const targetUrl = `${authBaseUrl}/api/auth/guest`;
  let res;
  try {
    res = await fetch(targetUrl, { method: 'POST' });
  } catch (err) {
    throw createNetworkError('request guest session', targetUrl, err);
  }
  const data = res.ok
    ? await readJsonResponse(res, 'requestGuestSession')
    : await readJsonResponseOrNull(res, 'requestGuestSession');
  if (!res.ok) {
    throw createApiHttpError(data, `requestGuestSession ${res.status}`, res.status);
  }
  return parseGuestSessionResponse(data);
}

/**
 * Check if a username is available for registration.
 * @param {string} username
 * @param {string} [baseUrl='']
 * @returns {Promise<boolean>} true if available
 */
export async function checkUsernameAvailable(username, baseUrl = '', signal) {
  const authBaseUrl = baseUrl || getSelectedAuthInstanceUrlSync();
  const targetUrl = `${authBaseUrl}/api/auth/check-username/${encodeURIComponent(username)}`;
  const { signal: fetchSignal, cleanup } = createFetchSignal(USERNAME_CHECK_TIMEOUT_MS, signal);
  let res;
  try {
    res = await fetch(targetUrl, { signal: fetchSignal });
  } catch (err) {
    throw createNetworkError('check username availability', targetUrl, err);
  } finally {
    cleanup();
  }
  if (!res.ok) return false;
  const data = await readJsonResponse(res, 'checkUsernameAvailable');
  return parseUsernameAvailabilityResponse(data).available;
}

/**
 * Register a new account with a BIP39-derived public key.
 *
 * @param {string} username
 * @param {string} displayName
 * @param {string} publicKeyBase64      - Base64-encoded Ed25519 public key.
 * @param {string} deviceId             - Stable per-device identifier (UUID).
 * @param {string} [inviteCode]         - Optional invite code.
 * @param {string} [baseUrl='']         - Optional base URL for cross-instance calls.
 * @param {string} [transparencySig]    - Base64-encoded Ed25519 signature over CBOR entry payload.
 * @param {number} [transparencyTs]     - Unix seconds timestamp used in CBOR entry payload.
 * @returns {Promise<{ token: string, user: object }>}
 */
export async function registerWithPublicKey(
  username,
  displayName,
  publicKeyBase64,
  deviceId,
  inviteCode,
  baseUrl = '',
  transparencySig = null,
  transparencyTs = null,
) {
  const authBaseUrl = resolveAuthBaseUrl(baseUrl);
  const targetUrl = `${authBaseUrl}/api/auth/register`;
  const body = {
    username,
    displayName,
    publicKey: publicKeyBase64,
    deviceId,
    label: getReadableDeviceLabel(),
  };
  if (inviteCode) body.inviteCode = inviteCode;
  if (transparencySig != null) {
    body.transparency_sig = transparencySig;
    body.transparency_ts = transparencyTs;
  }
  let res;
  try {
    res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw createNetworkError('register', targetUrl, err);
  }
  const data = res.ok
    ? await readJsonResponse(res, 'registerWithPublicKey')
    : await readJsonResponseOrNull(res, 'registerWithPublicKey');
  if (!res.ok) {
    throw createApiHttpError(data, `registerWithPublicKey ${res.status}`, res.status);
  }
  return parseAuthResponse(data, 'registerWithPublicKey');
}

/**
 * List all registered device keys for the authenticated user.
 *
 * @param {string} token - JWT
 * @returns {Promise<Array<{ deviceId: string, publicKey: string, createdAt: string, lastSeenAt: string }>>}
 */
export async function listDeviceKeys(token, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/auth/devices', {}, baseUrl);
  const data = res.ok
    ? await readJsonResponse(res, 'listDeviceKeys')
    : await readJsonResponseOrNull(res, 'listDeviceKeys');
  if (!res.ok) {
    throw createApiHttpError(data, `listDeviceKeys ${res.status}`, res.status);
  }
  return parseDeviceKeys(data);
}

/**
 * Revoke a registered device key. The device can no longer authenticate.
 *
 * @param {string} token             - JWT
 * @param {string} deviceId          - Device ID to revoke.
 * @param {string} [baseUrl='']      - Optional base URL for cross-instance calls.
 * @param {string} [transparencySig] - Base64-encoded Ed25519 signature over CBOR entry payload.
 * @param {number} [transparencyTs]  - Unix seconds timestamp used in CBOR entry payload.
 * @returns {Promise<void>}
 */
export async function revokeDeviceKey(token, deviceId, baseUrl = '', transparencySig = null, transparencyTs = null) {
  const body = {};
  if (transparencySig != null) {
    body.transparency_sig = transparencySig;
    body.transparency_ts = transparencyTs;
  }
  const opts = {
    method: 'DELETE',
  };
  if (Object.keys(body).length > 0) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetchWithAuth(token, `/api/auth/devices/${encodeURIComponent(deviceId)}`, opts, baseUrl);
  if (!res.ok) {
    const data = await readJsonResponseOrNull(res, 'revokeDeviceKey');
    throw createApiHttpError(data, `revokeDeviceKey ${res.status}`, res.status);
  }
}

/**
 * Register a new device key certified by an existing authenticated device.
 * Used in the multi-device linking flow (Plan 05).
 *
 * @param {string} token - JWT of the certifying device.
 * @param {string} newDevicePublicKeyBase64 - Base64-encoded Ed25519 public key of the new device.
 * @param {string} certificate - Base64-encoded signature: Sign(IK_existing_priv, IK_new_pub).
 * @param {string} deviceId - Device ID for the new device.
 * @returns {Promise<void>}
 */
/**
 * Register a new device key certified by an existing authenticated device.
 * Used in the multi-device linking flow (Plan 06).
 *
 * @param {string} token - JWT of the certifying device.
 * @param {string} newDevicePublicKeyBase64 - Base64-encoded Ed25519 public key of the new device.
 * @param {string} certificate - Base64-encoded signature: Sign(IK_existing_priv, IK_new_pub).
 * @param {string} deviceId - Device ID for the new device.
 * @param {string} signingDeviceId - Device ID of the certifying (existing) device.
 * @param {string} [label] - Optional human-readable label for the new device.
 * @returns {Promise<void>}
 */
/**
 * Register a new device key certified by an existing authenticated device.
 * Used in the multi-device linking flow (Plan 06).
 *
 * @param {string} token                    - JWT of the certifying device.
 * @param {string} newDevicePublicKeyBase64  - Base64-encoded Ed25519 public key of the new device.
 * @param {string} certificate              - Base64-encoded signature: Sign(IK_existing_priv, IK_new_pub).
 * @param {string} deviceId                 - Device ID for the new device.
 * @param {string} signingDeviceId          - Device ID of the certifying (existing) device.
 * @param {string} [label]                  - Optional human-readable label for the new device.
 * @param {string} [baseUrl='']             - Optional base URL for cross-instance calls.
 * @param {string} [transparencySig]        - Base64-encoded Ed25519 signature over CBOR entry payload.
 * @param {number} [transparencyTs]         - Unix seconds timestamp used in CBOR entry payload.
 * @returns {Promise<void>}
 */
export async function certifyNewDevice(
  token,
  newDevicePublicKeyBase64,
  certificate,
  deviceId,
  signingDeviceId,
  label,
  baseUrl = '',
  transparencySig = null,
  transparencyTs = null,
) {
  const body = {
    devicePublicKey: newDevicePublicKeyBase64,
    certificate,
    deviceId,
    signingDeviceId,
    label,
  };
  if (transparencySig != null) {
    body.transparency_sig = transparencySig;
    body.transparency_ts = transparencyTs;
  }
  const res = await fetchWithAuth(token, '/api/auth/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, baseUrl);
  if (!res.ok) {
    const data = await readJsonResponseOrNull(res, 'certifyNewDevice');
    throw createApiHttpError(data, `certifyNewDevice ${res.status}`, res.status);
  }
}

/**
 * Create a new device-link request from an unauthenticated device.
 *
 * @param {{ devicePublicKey: string, sessionPublicKey: string, deviceId: string, label?: string, instanceUrl?: string }} body
 * @param {string} [baseUrl='']
 * @returns {Promise<{ requestId: string, secret: string, code: string, expiresAt: string }>}
 */
export async function createDeviceLinkRequest(body, baseUrl = '') {
  const authBaseUrl = resolveAuthBaseUrl(baseUrl);
  const requestBody = {
    ...body,
    label: body?.label || getReadableDeviceLabel(),
  };
  const targetUrl = `${authBaseUrl}/api/auth/link-request`;
  let res;
  try {
    res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw createNetworkError('create device link request', targetUrl, err);
  }
  const data = res.ok
    ? await readJsonResponse(res, 'createDeviceLinkRequest')
    : await readJsonResponseOrNull(res, 'createDeviceLinkRequest') ?? {};
  if (!res.ok) throw new Error(data.error || `createDeviceLinkRequest ${res.status}`);
  return parseDeviceLinkRequestResponse(data);
}

/**
 * Resolve a pending device-link request on an authenticated existing device.
 *
 * @param {string} token
 * @param {{ requestId?: string, secret?: string, code?: string }} body
 * @param {string} [baseUrl='']
 * @returns {Promise<{ claimToken: string, requestId: string, deviceId: string, devicePublicKey: string, sessionPublicKey: string, label?: string, instanceUrl?: string, expiresAt: string }>}
 */
export async function resolveDeviceLinkRequest(token, body, baseUrl = '') {
  const targetUrl = resolveRequestUrl('/api/auth/link-resolve', baseUrl);
  let res;
  try {
    res = await fetchWithAuth(token, '/api/auth/link-resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, baseUrl);
  } catch (err) {
    throw createNetworkError('resolve device link request', targetUrl, err);
  }
  const data = res.ok
    ? await readJsonResponse(res, 'resolveDeviceLinkRequest')
    : await readJsonResponseOrNull(res, 'resolveDeviceLinkRequest') ?? {};
  if (!res.ok) throw new Error(data.error || `resolveDeviceLinkRequest ${res.status}`);
  return parseDeviceLinkResolvedClaim(data);
}

/**
 * Verify a claimed device-link request and store the blind relay payload.
 *
 * @param {string} token
 * @param {{ claimToken: string, certificate: string, signingDeviceId: string, relayCiphertext: string, relayIv: string, relayPublicKey: string }} body
 * @param {string} [baseUrl='']
 * @returns {Promise<void>}
 */
export async function verifyDeviceLinkRequest(token, body, baseUrl = '') {
  const targetUrl = resolveRequestUrl('/api/auth/link-verify', baseUrl);
  let res;
  try {
    res = await fetchWithAuth(token, '/api/auth/link-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, baseUrl);
  } catch (err) {
    throw createNetworkError('verify device link request', targetUrl, err);
  }
  if (res.status === 413) {
    throw new Error('Device link payload is too large for the server to accept.');
  }
  const data = res.ok
    ? await readJsonResponse(res, 'verifyDeviceLinkRequest', { allowEmpty: true }) ?? {}
    : await readJsonResponseOrNull(res, 'verifyDeviceLinkRequest') ?? {};
  if (!res.ok) throw new Error(data.error || `verifyDeviceLinkRequest ${res.status}`);
}

/**
 * Consume the blind relay payload for a new device-link request.
 *
 * Returns `{ status: 'pending' }` while the existing device has not yet
 * approved the request.
 *
 * @param {{ requestId: string, secret: string }} body
 * @param {string} [baseUrl='']
 * @returns {Promise<{ status: 'pending' }|{ relayCiphertext: string, relayIv: string, relayPublicKey: string, deviceId: string, instanceUrl?: string }>}
 */
export async function consumeDeviceLinkResult(body, baseUrl = '') {
  const authBaseUrl = resolveAuthBaseUrl(baseUrl);
  const targetUrl = `${authBaseUrl}/api/auth/link-result`;
  let res;
  try {
    res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw createNetworkError('consume device link result', targetUrl, err);
  }
  if (res.status === 202) {
    return { status: 'pending' };
  }
  const data = await readJsonResponse(res, 'consumeDeviceLinkResult');
  if (!res.ok) throw new Error(data.error || `consumeDeviceLinkResult ${res.status}`);
  return parseDeviceLinkResult(data);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch server handshake data (no auth required).
 * Returns server version, API version, KeyPackage low threshold, and other instance metadata.
 * @returns {Promise<{ server_version: string, api_version: string, min_client_version: string, key_package_low_threshold: number }>}
 */
export async function getHandshake(baseUrl = '', signal) {
  const targetUrl = `${baseUrl}/api/handshake`;
  const { signal: fetchSignal, cleanup } = createFetchSignal(HANDSHAKE_TIMEOUT_MS, signal);
  let res;
  try {
    res = await fetch(targetUrl, { signal: fetchSignal });
  } catch (err) {
    throw createNetworkError('handshake', targetUrl, err);
  } finally {
    cleanup();
  }
  if (!res.ok) throw new Error(`handshake failed: ${res.status}`);
  // Route the success body through the shared JSON-boundary helper so a
  // 2xx HTML/empty/malformed response surfaces as a typed
  // `invalid-response-schema` diagnostic instead of a silent crash deep
  // inside boot.
  const data = await readJsonResponse(res, 'getHandshake');
  if (data?.registrationMode !== undefined && data.registration_mode === undefined) {
    data.registration_mode = data.registrationMode;
  }
  if (
    data?.screenShareResolutionCap !== undefined &&
    data.screen_share_resolution_cap === undefined
  ) {
    data.screen_share_resolution_cap = data.screenShareResolutionCap;
  }
  if (
    data?.maxAttachmentBytes !== undefined &&
    data.max_attachment_bytes === undefined
  ) {
    data.max_attachment_bytes = data.maxAttachmentBytes;
  }
  return data;
}

// ── Guild API ─────────────────────────────────────────────────────────────────

/**
 * List all guilds the authenticated user belongs to.
 * @param {string} token - JWT
 * @returns {Promise<Array<{ id: string, name: string, ownerId: string, createdAt: string }>>}
 */
export async function getMyGuilds(token, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/servers', {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `get guilds ${res.status}`);
  }
  return res.json();
}

/**
 * Create a new guild (two-step: POST returns UUID, then PUT uploads encrypted metadata).
 * @param {string} token - JWT
 * @param {string} [encryptedMetadata] - Base64-encoded AES-GCM blob; null on initial creation
 * @param {string} [templateId] - Optional template UUID to use for channel creation
 * @returns {Promise<{ id: string, encryptedMetadata: string|null, permissionLevel: number, createdAt: string }>}
 */
export async function createGuild(token, encryptedMetadata, templateId, baseUrl = '', name = '') {
  const body = {};
  if (encryptedMetadata != null) body.encryptedMetadata = encryptedMetadata;
  if (templateId) body.templateId = templateId;
  if (name) body.name = name;
  const res = await fetchWithAuth(token, '/api/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `create guild ${res.status}`);
  }
  return res.json();
}

/**
 * Update guild encrypted metadata (e.g. after MLS group is set up).
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} encryptedMetadata - Base64-encoded AES-GCM blob
 * @returns {Promise<void>}
 */
export async function updateGuildMetadata(token, serverId, encryptedMetadata, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/servers/${encodeURIComponent(serverId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryptedMetadata }),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `update guild metadata ${res.status}`);
  }
}

/**
 * Voluntarily leave a guild (non-owner members only).
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @returns {Promise<void>}
 */
export async function leaveGuild(token, serverId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/servers/${encodeURIComponent(serverId)}/leave`, {
    method: 'POST',
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `leave guild failed: ${res.status}`);
  }
}

/**
 * Delete a guild (owner only).
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @returns {Promise<void>}
 */
export async function deleteGuild(token, serverId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/servers/${encodeURIComponent(serverId)}`, {
    method: 'DELETE',
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `delete guild ${res.status}`);
  }
}

/**
 * List all channels in a guild.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @returns {Promise<Array<{ id: string, name: string, type: string, parentId?: string, position: number, createdAt: string }>>}
 */
export async function getGuildChannels(token, serverId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/servers/${encodeURIComponent(serverId)}/channels`, {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error || `get channels ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/**
 * Get current LiveKit voice participants for all voice channels in a guild.
 * The response is a bootstrap snapshot; subsequent changes still arrive via
 * `voice_state_update` websocket events.
 *
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} baseUrl - Instance base URL
 * @returns {Promise<{ participantsByChannel: Record<string, Array<{ userId: string, displayName: string }>> }>}
 */
export async function getLiveKitVoiceState(token, serverId, baseUrl = '') {
  const path = `/api/livekit/voice-state?serverId=${encodeURIComponent(serverId)}`;
  const res = await fetchWithAuth(token, path, {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error || `get voice state ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/**
 * Create a channel in a guild (admin+).
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {{ name: string, type: 'text'|'voice'|'category', parentId?: string, position?: number }} body
 * @returns {Promise<object>} Created channel
 */
export async function createGuildChannel(token, serverId, body, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/servers/${encodeURIComponent(serverId)}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `create channel ${res.status}`);
  }
  return res.json();
}

/**
 * Delete a channel in a guild (admin only).
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} channelId - Channel UUID
 * @returns {Promise<void>}
 */
export async function deleteGuildChannel(token, serverId, channelId, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}`,
    { method: 'DELETE' },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `delete channel ${res.status}`);
  }
  // 200 OK ships a `deletedChannelIds` array (single channel for direct
  // deletes, every cascaded child id for category deletes). 204 was the
  // pre-cascade contract; tolerate it so a stale backend doesn't trip
  // the frontend.
  if (res.status === 204) return { deletedChannelIds: [channelId] };
  return res.json().catch(() => ({ deletedChannelIds: [channelId] }));
}

/**
 * Move a channel to a new parent and/or position within a guild (admin only).
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} channelId - Channel UUID
 * @param {{ parentId?: string|null, position: number }} body
 * @returns {Promise<void>}
 */
export async function moveChannel(token, serverId, channelId, body, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/move`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `move channel ${res.status}`);
  }
}

/**
 * List all members of a guild.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @returns {Promise<Array<{ id: string, username: string, displayName: string, role: string, createdAt: string }>>}
 */
export async function getGuildMembers(token, serverId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/servers/${encodeURIComponent(serverId)}/members`, {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error || `get members ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/**
 * Create an invite code for a guild.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {{ maxUses?: number, expiresInHours?: number }} [opts]
 * @returns {Promise<{ code: string, createdBy: string, maxUses: number, expiresAt: string }>}
 */
export async function createGuildInvite(token, serverId, opts = {}, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/servers/${encodeURIComponent(serverId)}/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `create invite ${res.status}`);
  }
  return res.json();
}

/**
 * Resolve an invite code to guild info (public - no auth required).
 * NOTE: Response does NOT include guildName - the guild name is read from the URL fragment.
 * @param {string} code - Invite code
 * @returns {Promise<{ code: string, serverId: string, memberCount: number, expiresAt: string }>}
 */
export async function getInviteInfo(code, baseUrl = '') {
  const res = await fetch(`${baseUrl}/api/invites/${encodeURIComponent(code)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `invite lookup ${res.status}`);
  }
  return res.json();
}

/**
 * Claim an invite code (adds the authenticated user to the guild).
 * NOTE: Response does NOT include guildName - navigation uses serverId only.
 * @param {string} token - JWT
 * @param {string} code - Invite code
 * @returns {Promise<{ serverId: string }>}
 */
export async function claimInvite(token, code, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/invites/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `claim invite ${res.status}`);
  }
  return res.json();
}

// ── Moderation API ───────────────────────────────────────────────────────────

/**
 * Kick a user from a guild.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} userId - Target user UUID
 * @param {string} reason - Required reason string
 * @returns {Promise<void>}
 */
export async function kickUser(token, serverId, userId, reason, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/moderation/kick`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, reason }),
    },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `kick ${res.status}`);
  }
}

/**
 * Ban a user from a guild.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} userId - Target user UUID
 * @param {string} reason - Required reason string
 * @param {number|null} [expiresIn] - Duration in seconds; null = permanent
 * @returns {Promise<void>}
 */
export async function banUser(token, serverId, userId, reason, expiresIn, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/moderation/ban`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, reason, expiresIn: expiresIn ?? null }),
    },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `ban ${res.status}`);
  }
}

/**
 * Mute a user in a guild.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} userId - Target user UUID
 * @param {string} reason - Required reason string
 * @param {number|null} [expiresIn] - Duration in seconds; null = permanent
 * @returns {Promise<void>}
 */
export async function muteUser(token, serverId, userId, reason, expiresIn, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/moderation/mute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, reason, expiresIn: expiresIn ?? null }),
    },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `mute ${res.status}`);
  }
}

/**
 * Unban a user from a guild. Requires admin role.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} userId - Target user UUID
 * @param {string} reason - Required reason string
 * @returns {Promise<void>}
 */
export async function unbanUser(token, serverId, userId, reason, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/moderation/unban`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, reason }),
    },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `unban failed ${res.status}`);
  }
}

/**
 * Unmute a user in a guild. Requires mod+ role.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} userId - Target user UUID
 * @param {string} reason - Required reason string
 * @returns {Promise<void>}
 */
export async function unmuteUser(token, serverId, userId, reason, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/moderation/unmute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, reason }),
    },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `unmute failed ${res.status}`);
  }
}

/**
 * List active bans for a guild. Requires admin role.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @returns {Promise<Array<{ id: string, userId: string, actorId: string, reason: string, createdAt: string, expiresAt?: string }>>}
 */
export async function listBans(token, serverId, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/moderation/bans`,
    {},
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `list bans failed ${res.status}`);
  }
  return res.json();
}

/**
 * List active mutes for a guild. Requires admin role.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @returns {Promise<Array<{ id: string, userId: string, actorId: string, reason: string, createdAt: string, expiresAt?: string }>>}
 */
export async function listMutes(token, serverId, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/moderation/mutes`,
    {},
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `list mutes failed ${res.status}`);
  }
  return res.json();
}

/**
 * Change a user's permission level in a guild.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} userId - Target user UUID
 * @param {number} permissionLevel - Integer: 0=member, 1=mod, 2=admin, 3=owner
 * @returns {Promise<void>}
 */
export async function changePermissionLevel(token, serverId, userId, permissionLevel, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/level`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionLevel }),
    },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `change permission level ${res.status}`);
  }
}

/**
 * @deprecated Use changePermissionLevel instead.
 * Kept for backward compatibility during transition.
 */
export async function changeUserRole(token, serverId, userId, newRole, baseUrl = '') {
  // Map legacy role strings to integer levels
  const levelMap = { member: 0, mod: 1, admin: 2, owner: 3 };
  const level = levelMap[newRole] ?? 0;
  return changePermissionLevel(token, serverId, userId, level, baseUrl);
}

/**
 * Delete a message within a guild (mod action or self-delete).
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {string} messageId - Message UUID
 * @returns {Promise<void>}
 */
export async function deleteMessage(token, serverId, messageId, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/moderation/messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `delete message ${res.status}`);
  }
}

/**
 * Fetch guild audit log entries with optional filters.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {{ limit?: number, offset?: number, action?: string, actorId?: string, targetId?: string }} [opts]
 * @returns {Promise<Array<{ id: string, actorId: string, targetId?: string, action: string, reason: string, metadata?: object, createdAt: string }>>}
 */
export async function getAuditLog(token, serverId, opts = {}, baseUrl = '') {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.offset != null) params.set('offset', String(opts.offset));
  if (opts.action) params.set('action', opts.action);
  if (opts.actorId) params.set('actor_id', opts.actorId);
  if (opts.targetId) params.set('target_id', opts.targetId);
  const qs = params.toString();
  const res = await fetchWithAuth(
    token,
    `/api/servers/${encodeURIComponent(serverId)}/moderation/audit-log${qs ? '?' + qs : ''}`,
    {},
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to load audit log');
  }
  return res.json();
}

// ── System Messages ───────────────────────────────────────────────────────────

/**
 * Fetch paginated system messages for a guild.
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID
 * @param {{ before?: string, limit?: number }} [opts] - before: RFC3339 cursor; limit: default 50
 * @returns {Promise<Array<{ id: string, serverId: string, eventType: string, actorId: string, targetId?: string, reason?: string, metadata?: object, createdAt: string }>>}
 */
export async function getSystemMessages(token, serverId, opts = {}, baseUrl = '') {
  const params = new URLSearchParams();
  if (opts.before) params.set('before', opts.before);
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const path = `/api/servers/${encodeURIComponent(serverId)}/system-messages${qs ? '?' + qs : ''}`;
  const res = await fetchWithAuth(token, path, {}, baseUrl);
  if (!res.ok) throw new Error(`getSystemMessages: ${res.status}`);
  return res.json();
}

// ── Instance Admin ────────────────────────────────────────

/**
 * Search instance users by username prefix (admin+).
 * @param {string} token - JWT
 * @param {string} query - Username prefix to search
 * @returns {Promise<Array<{ id: string, username: string, displayName: string, role: string, createdAt: string, isBanned: boolean, banReason?: string, banExpiresAt?: string }>>}
 */
export async function searchInstanceUsers(token, query, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/instance/users?q=${encodeURIComponent(query)}`, {}, baseUrl);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Search failed');
  return res.json();
}

/**
 * Ban a user at the instance level (admin+).
 * @param {string} token - JWT
 * @param {string} userId - Target user UUID
 * @param {string} reason - Ban reason (required)
 * @param {number|null} [expiresIn] - Duration in seconds; null = permanent
 * @returns {Promise<void>}
 */
export async function instanceBanUser(token, userId, reason, expiresIn, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/instance/bans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, reason, expiresIn: expiresIn ?? null }),
  }, baseUrl);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Ban failed');
}

/**
 * Unban a user at the instance level (admin+).
 * @param {string} token - JWT
 * @param {string} userId - Target user UUID
 * @param {string} reason - Unban reason (required)
 * @returns {Promise<void>}
 */
export async function instanceUnbanUser(token, userId, reason, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/instance/unban', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, reason }),
  }, baseUrl);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Unban failed');
}

/**
 * Fetch instance-level audit log entries (owner only).
 * @param {string} token - JWT
 * @param {{ limit?: number, offset?: number, action?: string, targetId?: string }} [opts]
 * @returns {Promise<Array<{ id: string, actorId: string, targetId?: string, action: string, reason: string, metadata?: object, createdAt: string }>>}
 */
export async function getInstanceAuditLog(token, opts = {}, baseUrl = '') {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.offset != null) params.set('offset', String(opts.offset));
  if (opts.action) params.set('action', opts.action);
  if (opts.targetId) params.set('target_id', opts.targetId);
  const qs = params.toString();
  const res = await fetchWithAuth(token, `/api/instance/audit-log${qs ? '?' + qs : ''}`, {}, baseUrl);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load audit log');
  return res.json();
}

/**
 * Update instance configuration (owner only).
 * @param {string} token - JWT
 * @param {{ registrationMode?: string, serverCreationPolicy?: string }} updates
 * @returns {Promise<void>}
 */
export async function updateInstanceConfig(token, updates, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/instance', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  }, baseUrl);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Config update failed');
}

// ── Server Templates ─────────────────────────────────────────────────────────

/**
 * List all server templates (owner only).
 * @param {string} token - JWT
 * @returns {Promise<Array<{ id: string, name: string, channels: Array, isDefault: boolean, position: number }>>}
 */
export async function listServerTemplates(token, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/instance/server-templates', {}, baseUrl);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load templates');
  return res.json();
}

/**
 * Create a new server template (owner only).
 * @param {string} token - JWT
 * @param {{ name: string, channels: Array, isDefault: boolean }} body
 * @returns {Promise<object>} Created template
 */
export async function createServerTemplate(token, body, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/instance/server-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, baseUrl);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to create template');
  return res.json();
}

/**
 * Update a server template (owner only).
 * @param {string} token - JWT
 * @param {string} id - Template UUID
 * @param {{ name: string, channels: Array, isDefault: boolean }} body
 * @returns {Promise<void>}
 */
export async function updateServerTemplate(token, id, body, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/instance/server-templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, baseUrl);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to update template');
}

/**
 * Delete a server template (owner only, cannot delete default).
 * @param {string} token - JWT
 * @param {string} id - Template UUID
 * @returns {Promise<void>}
 */
export async function deleteServerTemplate(token, id, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/instance/server-templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }, baseUrl);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to delete template');
}

// ── Call after Go backend register/login ──────────────────────────────────────

/**
 * Call after Go backend register/login. Generates MLS credential + KeyPackages,
 * persists private keys locally, and uploads public material to the server.
 * @param {string} token - JWT from auth response
 * @param {string} userId - Current user UUID
 * @param {string} deviceId - Stable device ID (e.g. from localStorage or generated once)
 * @param {object} [deps] - Optional deps for testing: { mlsStore, crypto, uploadCredential, uploadKeyPackages }
 */
export async function uploadKeyPackagesAfterAuth(token, userId, deviceId, deps = {}, baseUrl = '') {
  const resolvedBaseUrl = resolveAuthBaseUrl(baseUrl);

  // Verify the instance is on the same OpenMLS ciphersuite as this client before
  // we generate or upload any MLS state. A mismatched server would either reject
  // the upload (current servers) or silently mislabel it (pre-fix servers).
  // Throws MLSCiphersuiteMismatchError on conflict; missing field tolerated.
  const getHandshakeFn = deps.getHandshake ?? ((b) => getHandshake(b));
  try {
    const handshake = await getHandshakeFn(resolvedBaseUrl);
    assertHandshakeMLSCiphersuiteMatches(handshake);
  } catch (err) {
    if (err && err.name === 'MLSCiphersuiteMismatchError') throw err;
    // Network / parse failures are not fatal here: the server-side validator
    // will still reject a mismatched upload. Skip the early check rather than
    // block authentication on a transient handshake failure.
  }

  await uploadKeyPackagesAfterAuthImpl(token, userId, deviceId, {
    mlsStore: deps.mlsStore ?? mlsStore,
    crypto: deps.crypto ?? hushCrypto,
    uploadCredential: deps.uploadCredential ?? ((t, b) => uploadMLSCredential(t, b, resolvedBaseUrl)),
    uploadKeyPackages: deps.uploadKeyPackages ?? ((t, b) => uploadMLSKeyPackages(t, b, resolvedBaseUrl)),
  });
}

// ── MLS Group API ─────────────────────────────────────────────────────────────

/**
 * Get the current GroupInfo for a channel's MLS group.
 * Returns null if no group has been created for this channel yet.
 *
 * @param {string} token - JWT
 * @param {string} channelId - Channel UUID
 * @returns {Promise<{ groupInfo: string, epoch: number }|null>}
 */
export async function getMLSGroupInfo(token, channelId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/mls/groups/${encodeURIComponent(channelId)}/info`, {}, baseUrl);
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `getMLSGroupInfo ${res.status}`);
  }
  return res.json();
}

/**
 * Upsert the GroupInfo for a channel's MLS group.
 * Called after creating a group or advancing its epoch.
 *
 * @param {string} token - JWT
 * @param {string} channelId - Channel UUID
 * @param {string} groupInfoBase64 - Base64-encoded serialised GroupInfo
 * @param {number} epoch - Current group epoch
 * @returns {Promise<void>}
 */
export async function putMLSGroupInfo(token, channelId, groupInfoBase64, epoch, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/mls/groups/${encodeURIComponent(channelId)}/info`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupInfo: groupInfoBase64, epoch, ciphersuite: CURRENT_MLS_CIPHERSUITE }),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `putMLSGroupInfo ${res.status}`);
  }
}

/**
 * Post a Commit to the server for distribution to channel members.
 * Also upserts the current GroupInfo so new joiners can catch up.
 *
 * @param {string} token - JWT
 * @param {string} channelId - Channel UUID
 * @param {string} commitBytesBase64 - Base64-encoded commit bytes
 * @param {string} groupInfoBase64 - Base64-encoded updated GroupInfo bytes
 * @param {number} epoch - Epoch after this commit
 * @returns {Promise<void>}
 */
export async function postMLSCommit(token, channelId, commitBytesBase64, groupInfoBase64, epoch, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/mls/groups/${encodeURIComponent(channelId)}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commitBytes: commitBytesBase64,
      groupInfo: groupInfoBase64,
      epoch,
      ciphersuite: CURRENT_MLS_CIPHERSUITE,
    }),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `postMLSCommit ${res.status}`);
  }
}

// ── MLS Voice Group API ────────────────────────────────────────────────────────

/**
 * Get GroupInfo for a channel's voice MLS group.
 * Returns null if no voice group exists for this channel yet.
 *
 * @param {string} token - JWT
 * @param {string} channelId - Channel UUID
 * @returns {Promise<{ groupInfo: string, epoch: number }|null>}
 */
export async function getMLSVoiceGroupInfo(token, channelId, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/mls/groups/${encodeURIComponent(channelId)}/info?type=voice`,
    {},
    baseUrl,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `getMLSVoiceGroupInfo ${res.status}`);
  }
  return res.json();
}

/**
 * Upsert the GroupInfo for a channel's voice MLS group.
 * Called after creating or advancing the voice group epoch.
 *
 * @param {string} token - JWT
 * @param {string} channelId - Channel UUID
 * @param {string} groupInfoBase64 - Base64-encoded serialised GroupInfo
 * @param {number} epoch - Current group epoch
 * @returns {Promise<void>}
 */
export async function putMLSVoiceGroupInfo(token, channelId, groupInfoBase64, epoch, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/mls/groups/${encodeURIComponent(channelId)}/info?type=voice`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupInfo: groupInfoBase64, epoch, ciphersuite: CURRENT_MLS_CIPHERSUITE }),
    },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `putMLSVoiceGroupInfo ${res.status}`);
  }
}

/**
 * Post a Commit to the server for distribution to voice channel participants.
 * Also upserts the current GroupInfo so new joiners can catch up.
 *
 * @param {string} token - JWT
 * @param {string} channelId - Channel UUID
 * @param {string} commitBytesBase64 - Base64-encoded commit bytes
 * @param {number} epoch - Epoch after this commit
 * @param {string} [groupInfoBase64] - Optional Base64-encoded updated GroupInfo
 * @returns {Promise<void>}
 */
export async function postMLSVoiceCommit(token, channelId, commitBytesBase64, epoch, groupInfoBase64, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/mls/groups/${encodeURIComponent(channelId)}/commit?type=voice`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commitBytes: commitBytesBase64,
        groupInfo: groupInfoBase64 ?? '',
        epoch,
        ciphersuite: CURRENT_MLS_CIPHERSUITE,
      }),
    },
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `postMLSVoiceCommit ${res.status}`);
  }
}

/**
 * Fetch Commits that occurred after a given epoch (for catch-up on reconnect).
 *
 * @param {string} token - JWT
 * @param {string} channelId - Channel UUID
 * @param {number} sinceEpoch - Only return commits with epoch > sinceEpoch
 * @param {number} [limit=100] - Max commits to return
 * @returns {Promise<{ commits: Array<{ epoch: number, commitBytes: string, senderId: string }> }>}
 */
export async function getMLSCommitsSinceEpoch(token, channelId, sinceEpoch, limit = 100, baseUrl = '') {
  const params = new URLSearchParams({
    since_epoch: String(sinceEpoch),
    limit: String(limit),
  });
  const res = await fetchWithAuth(
    token,
    `/api/mls/groups/${encodeURIComponent(channelId)}/commits?${params.toString()}`,
    {},
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `getMLSCommitsSinceEpoch ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch pending Welcome messages addressed to the current user.
 * Returns Welcomes that have not yet been acknowledged (processed).
 *
 * @param {string} token - JWT
 * @returns {Promise<{ welcomes: Array<{ id: string, channelId: string, welcomeBytes: string, senderId: string, epoch: number }> }>}
 */
export async function getMLSPendingWelcomes(token, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/mls/pending-welcomes', {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `getMLSPendingWelcomes ${res.status}`);
  }
  return res.json();
}

/**
 * Acknowledge (delete) a pending Welcome after processing it locally.
 * This prevents re-delivery on the next connection.
 *
 * @param {string} token - JWT
 * @param {string} welcomeId - UUID of the pending Welcome record
 * @returns {Promise<void>}
 */
export async function deleteMLSPendingWelcome(token, welcomeId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/mls/pending-welcomes/${encodeURIComponent(welcomeId)}`, {
    method: 'DELETE',
  }, baseUrl);
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `deleteMLSPendingWelcome ${res.status}`);
  }
}

// ── Guild Metadata MLS Group ──────────────────────────────────────────────────

/**
 * Fetch the current GroupInfo for a guild metadata MLS group.
 * Used by members joining the guild to join the metadata group via External Commit.
 *
 * @param {string} token - JWT
 * @param {string} guildId - Guild UUID
 * @returns {Promise<{ groupInfo: string, epoch: number }|null>}
 */
export async function getGuildMetadataGroupInfo(token, guildId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/mls/guilds/${encodeURIComponent(guildId)}/group-info`, {}, baseUrl);
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `getGuildMetadataGroupInfo ${res.status}`);
  }
  return res.json();
}

/**
 * Upload or update the GroupInfo for a guild metadata MLS group.
 * Called by the guild creator after createGuildMetadataGroup and by members
 * after joining via External Commit.
 *
 * @param {string} token - JWT
 * @param {string} guildId - Guild UUID
 * @param {string} groupInfoBase64 - Base64-encoded serialised GroupInfo
 * @param {number} epoch - Current group epoch
 * @returns {Promise<void>}
 */
export async function putGuildMetadataGroupInfo(token, guildId, groupInfoBase64, epoch, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/mls/guilds/${encodeURIComponent(guildId)}/group-info`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupInfo: groupInfoBase64, epoch, ciphersuite: CURRENT_MLS_CIPHERSUITE }),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `putGuildMetadataGroupInfo ${res.status}`);
  }
}

// ── DM and Guild Discovery API ────────────────────────────────────────────────

/**
 * Create or retrieve an existing DM guild between the current user and another user.
 * Idempotent: returns 201 on creation, 200 when the DM already exists.
 *
 * @param {string} token - JWT
 * @param {string} otherUserId - UUID of the other user
 * @param {string} [baseUrl] - Optional base URL for cross-instance calls
 * @returns {Promise<{ id: string, isDm: boolean, otherUser: { id: string, username: string, displayName: string }, channelId: string }>}
 */
export async function createOrFindDM(token, otherUserId, baseUrl = '') {
  const res = await fetchWithAuth(token, '/api/guilds/dm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otherUserId }),
  }, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `createOrFindDM ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch a paginated list of discoverable guilds.
 *
 * @param {string} token - JWT
 * @param {{ category?: string, search?: string, sort?: string, page?: number, pageSize?: number }} [params]
 * @param {string} [baseUrl] - Optional base URL for cross-instance calls
 * @returns {Promise<{ guilds: Array<object>, total: number, page: number, pageSize: number }>}
 */
export async function discoverGuilds(token, params = {}, baseUrl = '') {
  const qs = new URLSearchParams();
  if (params.category) qs.set('category', params.category);
  if (params.search) qs.set('search', params.search);
  if (params.sort) qs.set('sort', params.sort);
  if (params.page != null) qs.set('page', String(params.page));
  if (params.pageSize != null) qs.set('pageSize', String(params.pageSize));
  const query = qs.toString();
  const res = await fetchWithAuth(token, `/api/guilds/discover${query ? `?${query}` : ''}`, {}, baseUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `discoverGuilds ${res.status}`);
  }
  return res.json();
}

/**
 * Search for users by username fragment for the DM recipient picker.
 *
 * @param {string} token - JWT
 * @param {string} query - Username search term
 * @param {string} [baseUrl] - Optional base URL for cross-instance calls
 * @returns {Promise<Array<{ id: string, username: string, displayName: string }>>}
 */
export async function searchUsersForDM(token, query, baseUrl = '') {
  const res = await fetchWithAuth(
    token,
    `/api/guilds/users/search?q=${encodeURIComponent(query)}`,
    {},
    baseUrl,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `searchUsersForDM ${res.status}`);
  }
  return res.json();
}

/**
 * Join an open guild from the explore page.
 * Returns 201 on success, 409 when already a member, 202 for request-policy guilds.
 *
 * @param {string} token - JWT
 * @param {string} serverId - Guild UUID to join
 * @param {string} [baseUrl] - Optional base URL for cross-instance calls
 * @returns {Promise<{ status: number, data: object }>}
 */
export async function joinGuildFromExplore(token, serverId, baseUrl = '') {
  const res = await fetchWithAuth(token, `/api/servers/${encodeURIComponent(serverId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, baseUrl);
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409 && res.status !== 202) {
    throw new Error(data.error || `joinGuildFromExplore ${res.status}`);
  }
  return { status: res.status, data };
}
