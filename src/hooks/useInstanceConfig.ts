import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import {
  instanceConfigQueryKey,
  normalizeInstanceConfig,
} from "@/lib/instanceConfigQuery"
import {
  pickInstanceConfig,
  type InstanceRuntimeConfig,
} from "@/lib/instanceRuntimeConfig"

/**
 * React reader for the per-instance runtime config cache (HUSHHQ-19).
 *
 * Subscribes to the TanStack Query cache for
 * `instanceConfigQueryKey(instanceUrl)`. Does NOT fetch — HUSHHQ-18
 * writers (`useInstances` boot + `instance_updated` WS handler) own
 * seeding and updating the cache. The hook exists only to give
 * components a single, stable, normalized read surface.
 *
 * `fallbackConfig` is a compatibility seam for the incremental
 * migration: consumers may still hold the legacy
 * `connectedInstances[].handshakeData` value. The cache wins whenever
 * it has data; the fallback is used only while the cache is empty
 * (e.g. immediately after disconnect, before the next boot seeds it
 * again). Both sources flow through `normalizeInstanceConfig` so
 * downstream readers see both casings (`maxAttachmentBytes` ⇄
 * `max_attachment_bytes`, etc.) regardless of origin.
 *
 * Returns `null` when both sources are empty so consumers can apply
 * their own defaults at the call site (see
 * `instanceRuntimeConfig.ts`).
 */
export function useInstanceConfig(
  instanceUrl: string | null | undefined,
  fallbackConfig?: InstanceRuntimeConfig | null
): InstanceRuntimeConfig | null {
  const queryClient = useQueryClient()
  const queryKey = React.useMemo(
    () => instanceConfigQueryKey(instanceUrl ?? ""),
    [instanceUrl]
  )

  // External-store subscription. TanStack v5 requires a `queryFn` for
  // `useQuery`, but we are a reader-only consumer — the cache is owned
  // by HUSHHQ-18 writers. Subscribing to the cache directly avoids
  // declaring a no-op fetcher that would otherwise risk overwriting
  // freshly seeded data with `undefined` on the first render.
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const cache = queryClient.getQueryCache()
      const unsubscribe = cache.subscribe((event) => {
        // Match by serialized key prefix so any update to the specific
        // instance triggers a notification. Unrelated keys are ignored.
        const eventKey = event?.query?.queryKey
        if (!Array.isArray(eventKey)) return
        if (eventKey.length < queryKey.length) return
        for (let i = 0; i < queryKey.length; i++) {
          if (eventKey[i] !== queryKey[i]) return
        }
        onChange()
      })
      return unsubscribe
    },
    [queryClient, queryKey]
  )

  const getSnapshot = React.useCallback(
    () => queryClient.getQueryData<InstanceRuntimeConfig>(queryKey),
    [queryClient, queryKey]
  )

  // `useSyncExternalStore` is the React-blessed way to read external
  // stores so concurrent rendering and `useTransition` see consistent
  // values without tearing.
  const cached = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const picked = pickInstanceConfig(cached, fallbackConfig ?? null)
  if (!picked) return null
  return normalizeInstanceConfig(picked)
}
