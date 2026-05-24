/**
 * Pure runtime-config readers extracted from `authenticated-app.tsx`
 * (HUSHHQ-19). The component used to derive `activeMaxAttachmentBytes`
 * and `voiceScreenShareResolutionCap` inline from
 * `connectedInstances[].handshakeData`. The full-tree render is hard to
 * unit-test, so the derivation lives here and `authenticated-app.tsx`
 * delegates to these helpers.
 *
 * Both helpers accept the union of camelCase (`maxAttachmentBytes`,
 * `screenShareResolutionCap`) and snake_case
 * (`max_attachment_bytes`, `screen_share_resolution_cap`) keys so the
 * legacy `handshakeData` mirror, the TanStack Query cache, and the
 * `instance_updated` WS payload all work without per-call translation.
 *
 * Defaults are deliberately part of this module rather than the
 * consuming component:
 *   - attachment max default = 25 MiB
 *   - screen-share cap default = "1080p"
 */

export type ScreenShareResolutionCap = "1080p" | "720p"

export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const DEFAULT_SCREEN_SHARE_RESOLUTION_CAP: ScreenShareResolutionCap =
  "1080p"

/**
 * Shape accepted by `readMaxAttachmentBytes` / `readScreenShareResolutionCap`.
 * Both alias spellings are optional; helpers tolerate either or neither.
 */
export interface InstanceRuntimeConfig {
  max_attachment_bytes?: number | null
  maxAttachmentBytes?: number | null
  screen_share_resolution_cap?: string | null
  screenShareResolutionCap?: string | null
  [key: string]: unknown
}

/**
 * Returns the configured screen-share resolution cap or the safe
 * default ("1080p"). Any value other than "720p" or "1080p" is treated
 * as the default — a malformed server payload must never broaden the
 * cap beyond what the client knows how to enforce.
 */
export function readScreenShareResolutionCap(
  config: InstanceRuntimeConfig | null | undefined
): ScreenShareResolutionCap {
  const value =
    config?.screen_share_resolution_cap ?? config?.screenShareResolutionCap
  return value === "720p" || value === "1080p"
    ? (value as ScreenShareResolutionCap)
    : DEFAULT_SCREEN_SHARE_RESOLUTION_CAP
}

/**
 * Returns the configured max attachment size in bytes or the safe
 * default (25 MiB). Non-numeric / non-positive / NaN values fall back
 * to the default so a broken server payload cannot disable the limit.
 */
export function readMaxAttachmentBytes(
  config: InstanceRuntimeConfig | null | undefined
): number {
  const value = config?.max_attachment_bytes ?? config?.maxAttachmentBytes
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MAX_ATTACHMENT_BYTES
}

/**
 * Picks the TanStack query result when present, otherwise falls back to
 * the legacy `handshakeData` mirror. Used by consumers during the
 * incremental migration: HUSHHQ-18 writers always seed the cache, but
 * existing consumers may still pass the legacy mirror to keep
 * downstream behavior stable if the cache entry is briefly missing
 * (e.g. mid-disconnect race).
 *
 * Pure: no React, no TanStack imports. Easy to unit-test.
 */
export function pickInstanceConfig(
  queryConfig: InstanceRuntimeConfig | null | undefined,
  fallbackConfig: InstanceRuntimeConfig | null | undefined
): InstanceRuntimeConfig | null {
  if (queryConfig && typeof queryConfig === "object") return queryConfig
  if (fallbackConfig && typeof fallbackConfig === "object") {
    return fallbackConfig
  }
  return null
}
