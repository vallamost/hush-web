/**
 * TanStack Query ownership for per-instance runtime config (HUSHHQ-18).
 *
 * Server-owned runtime config (instance name, attachment limits, screen
 * share cap, registration mode, guild discovery, ...) used to live in a
 * mutable `instancesRef` map keyed by URL. There was no named query key
 * for it, so it could not be centrally invalidated or reused by future
 * settings surfaces. This module gives it one.
 *
 * The shape is intentionally an open object: the server's handshake +
 * `instance_updated` payload schema evolves, and downstream consumers
 * (`authenticated-app.tsx` voice screen-share cap, attachment uploader
 * limit) still read both camelCase and snake_case keys. The normalizer
 * keeps both variants in lock-step so existing consumers do not need
 * to change.
 *
 * Per-instance isolation: every read/write is keyed by the normalized
 * instance origin. Cross-instance writes are forbidden by construction —
 * the merge helpers always require an `instanceUrl`.
 */

import { normalizeInstanceUrl } from './authInstanceStore.js';

/** Stable query key root so non-React paths can invalidate by prefix. */
export const INSTANCE_CONFIG_QUERY_ROOT = 'instance-config';

/**
 * Returns the TanStack Query key for a single instance's runtime config.
 *
 * Falls back to a sentinel when the URL cannot be normalized so callers
 * never accidentally share a key across distinct origins; an unnormalized
 * URL collapses to its own "unknown" bucket instead of mixing with a real
 * instance.
 *
 * @param {string|null|undefined} instanceUrl
 * @returns {readonly [string, string]}
 */
export function instanceConfigQueryKey(instanceUrl) {
  const normalized = normalizeInstanceUrl(instanceUrl) ?? '__unknown__';
  return Object.freeze([INSTANCE_CONFIG_QUERY_ROOT, normalized]);
}

/**
 * Field pairs that must stay in sync across the two naming conventions
 * the server uses today. Adding a new alias only requires extending this
 * table; downstream consumers automatically see both spellings.
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const COMPAT_ALIASES = Object.freeze([
  Object.freeze(['registrationMode', 'registration_mode']),
  Object.freeze(['screenShareResolutionCap', 'screen_share_resolution_cap']),
  Object.freeze(['maxAttachmentBytes', 'max_attachment_bytes']),
  Object.freeze(['iconUrl', 'icon_url']),
]);

/**
 * Drops the WS discriminator and any nullish values from a raw payload.
 *
 * Returned object never includes `type`, `undefined`, or `null` values.
 * Other keys (including unknown ones) pass through so the cache can host
 * forward-compatible fields the client does not consume yet.
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function sanitizePayload(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'type') continue;
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Mirrors compat-alias pairs so consumers reading either casing see the
 * same value. When both keys are present, the camelCase variant wins (it
 * matches the GET /api/handshake response shape); when only one side is
 * provided, the other side is filled in.
 *
 * Pure: does not touch the input.
 *
 * @param {Record<string, unknown>} input
 * @returns {Record<string, unknown>}
 */
export function normalizeInstanceConfig(input) {
  const sanitized = sanitizePayload(input);
  for (const [camel, snake] of COMPAT_ALIASES) {
    const camelDefined = Object.prototype.hasOwnProperty.call(sanitized, camel);
    const snakeDefined = Object.prototype.hasOwnProperty.call(sanitized, snake);
    if (camelDefined) {
      // camelCase wins because GET /api/handshake returns it as primary;
      // the snake_case alias is a back-compat mirror.
      sanitized[snake] = sanitized[camel];
    } else if (snakeDefined) {
      sanitized[camel] = sanitized[snake];
    }
  }
  return sanitized;
}

/**
 * Writes the seed (handshake) value into the per-instance config cache.
 *
 * Idempotent. Safe to call on reboot/reconnect; the value is replaced,
 * not merged, because the handshake represents the authoritative current
 * snapshot at boot time. Use `mergeInstanceConfigUpdate` for incremental
 * `instance_updated` payloads instead.
 *
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 * @param {string} instanceUrl
 * @param {Record<string, unknown>|null|undefined} handshakeData
 * @returns {Record<string, unknown>} normalized value written to the cache
 */
export function seedInstanceConfigQuery(queryClient, instanceUrl, handshakeData) {
  const normalized = normalizeInstanceConfig(handshakeData ?? {});
  queryClient.setQueryData(instanceConfigQueryKey(instanceUrl), normalized);
  return normalized;
}

/**
 * Merges an `instance_updated` payload into the per-instance config cache.
 *
 * Behavior:
 * - `type` is always stripped (it is the WS discriminator, never config).
 * - `null` / `undefined` payload fields are ignored so a partial update
 *   cannot blank existing keys by accident.
 * - Compat aliases are kept in lock-step (camelCase ⇄ snake_case).
 * - Only the cache for the supplied `instanceUrl` is touched.
 *
 * Returns the merged value (or `null` when the input is structurally
 * invalid) so callers can mirror the merged shape into other state.
 *
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 * @param {string} instanceUrl
 * @param {Record<string, unknown>|null|undefined} payload
 * @returns {Record<string, unknown>|null}
 */
export function mergeInstanceConfigUpdate(queryClient, instanceUrl, payload) {
  if (!payload || typeof payload !== 'object') return null;
  // Normalize the incoming payload FIRST so any alias spelling it
  // carries is mirrored into both casings before the merge. Without
  // this, a snake_case-only update could be silently overwritten by
  // the camelCase value already in the previous cached snapshot when
  // the alias mirror runs after the spread.
  const incoming = normalizeInstanceConfig(payload);
  const key = instanceConfigQueryKey(instanceUrl);
  const previous = /** @type {Record<string, unknown>|undefined} */ (
    queryClient.getQueryData(key)
  );
  const merged = normalizeInstanceConfig({
    ...(previous ?? {}),
    ...incoming,
  });
  queryClient.setQueryData(key, merged);
  return merged;
}

/**
 * Removes the per-instance config cache entry. Used during disconnect /
 * logout / revoke to keep stale config from leaking into a future boot
 * of a different instance under the same URL.
 *
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 * @param {string} instanceUrl
 */
export function removeInstanceConfigQuery(queryClient, instanceUrl) {
  queryClient.removeQueries({ queryKey: instanceConfigQueryKey(instanceUrl) });
}
