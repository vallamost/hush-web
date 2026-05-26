/**
 * React glue for the change-announcement engine.
 *
 * Resolves the visible entry once the host has signalled the
 * authenticated shell is mounted and idle, then surfaces dismissal back
 * to the storage layer. The hook deliberately does no auth gating of
 * its own — callers pass `isReady` only after they have cleared seed
 * entry, login, PIN unlock, device linking, and other recovery flows.
 */

import * as React from "react"

import {
  type ChangeAnnouncementEntry,
  type ChangeAnnouncementStorage,
  type ChangeAnnouncementSurface,
  detectSurface,
  getBrowserStorage,
  isPersistenceAvailable,
  markAnnouncementSeen,
  resolveVisibleAnnouncement,
} from "@/lib/changeAnnouncements"

export interface UseChangeAnnouncementOptions {
  /** Set to `true` only when the authenticated shell is mounted and idle. */
  readonly isReady: boolean
  /** Override hooks for testing. */
  readonly storage?: ChangeAnnouncementStorage | null
  readonly surface?: ChangeAnnouncementSurface
  readonly entries?: readonly ChangeAnnouncementEntry[]
}

export interface UseChangeAnnouncementResult {
  readonly entry: ChangeAnnouncementEntry | null
  readonly dismiss: () => void
}

export function useChangeAnnouncement(
  options: UseChangeAnnouncementOptions
): UseChangeAnnouncementResult {
  const { isReady } = options

  const storage = React.useMemo<ChangeAnnouncementStorage | null>(() => {
    if (options.storage !== undefined) return options.storage
    return getBrowserStorage()
  }, [options.storage])

  const surface = React.useMemo<ChangeAnnouncementSurface>(() => {
    return options.surface ?? detectSurface()
  }, [options.surface])

  const [entry, setEntry] = React.useState<ChangeAnnouncementEntry | null>(null)

  React.useEffect(() => {
    if (!isReady) return
    if (!storage) return
    if (!isPersistenceAvailable(storage)) return

    const next = resolveVisibleAnnouncement({
      surface,
      entries: options.entries,
      storage,
    })
    setEntry(next)
  }, [isReady, storage, surface, options.entries])

  const dismiss = React.useCallback(() => {
    setEntry((current) => {
      if (!current) return null
      if (storage) markAnnouncementSeen(current.id, storage)
      return null
    })
  }, [storage])

  return { entry, dismiss }
}
