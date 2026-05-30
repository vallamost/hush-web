import * as React from "react"

import {
  OPEN_WHATS_NEW_EVENT,
  type ChangeAnnouncementEntry,
  type ChangeAnnouncementSurface,
  detectSurface,
  getLatestAnnouncement,
} from "@/lib/changeAnnouncements"

export interface UseWhatsNewReopenResult {
  /** Entry to show in a re-open dialog, or null when closed. */
  readonly entry: ChangeAnnouncementEntry | null
  /** Close the re-open dialog. Does not touch the seen marker. */
  readonly close: () => void
}

/**
 * Manual "What's new" re-open path. Listens for {@link OPEN_WHATS_NEW_EVENT}
 * and surfaces the latest enabled announcement for the current surface,
 * ignoring the seen set so a user can re-read it after dismissal.
 *
 * Independent of {@link useChangeAnnouncement}, which only auto-shows unseen
 * entries. Closing here never marks the entry seen: re-reading is read-only.
 */
export function useWhatsNewReopen(
  surface?: ChangeAnnouncementSurface
): UseWhatsNewReopenResult {
  const [entry, setEntry] = React.useState<ChangeAnnouncementEntry | null>(null)

  const resolvedSurface = React.useMemo<ChangeAnnouncementSurface>(
    () => surface ?? detectSurface(),
    [surface]
  )

  React.useEffect(() => {
    if (typeof window === "undefined") return
    function onOpen() {
      setEntry(getLatestAnnouncement(resolvedSurface))
    }
    window.addEventListener(OPEN_WHATS_NEW_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_WHATS_NEW_EVENT, onOpen)
  }, [resolvedSurface])

  const close = React.useCallback(() => setEntry(null), [])

  return { entry, close }
}
