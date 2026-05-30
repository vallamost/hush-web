import * as React from "react"

import {
  type StaleServerDesktopState,
  getStaleServerDesktopState,
  startStaleServerDesktopStore,
  subscribeStaleServerDesktop,
} from "@/lib/staleServerDesktopStore"

/**
 * Subscribe to the shared desktop stale-server store. Starts the underlying
 * event listener on first mount (idempotent). Returns the live snapshot.
 */
export function useStaleServerDesktop(): StaleServerDesktopState {
  React.useEffect(() => {
    startStaleServerDesktopStore()
  }, [])

  return React.useSyncExternalStore(
    subscribeStaleServerDesktop,
    getStaleServerDesktopState,
    getStaleServerDesktopState
  )
}
