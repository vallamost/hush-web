import { useEffect, useState } from "react";

import {
  STALE_SERVER_EVENT,
  type StaleServerDetail,
  type StaleServerStorage,
  isStaleDismissed,
  markStaleDismissed,
} from "@/lib/staleServer";

interface UseStaleServerState {
  /** Detail of the stale instance to surface, or null when nothing to show. */
  detail: StaleServerDetail | null;
  /** Dismiss the current notice and remember it for this instance + version. */
  dismiss: () => void;
}

/**
 * localStorage wrapper that never throws (private mode, disabled storage,
 * quota). Returns null in non-browser contexts so the hook degrades to a
 * session-only, in-memory notice.
 */
function browserStorage(): StaleServerStorage | null {
  if (typeof window === "undefined") return null;
  try {
    const ls = window.localStorage;
    if (!ls) return null;
    return {
      getItem: (k) => {
        try {
          return ls.getItem(k);
        } catch {
          return null;
        }
      },
      setItem: (k, v) => {
        try {
          ls.setItem(k, v);
        } catch {
          /* best-effort */
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Subscribe to the global `hush:server-stale` event and expose the current
 * dismissible notice. Already-dismissed scopes (instance host + recommended
 * version) are ignored so the banner does not nag on every reconnect.
 *
 * Non-blocking by design: this hook drives a banner, never a gate. It pairs
 * with the blocking Update Required path (useUpdateRequired) but is fully
 * independent of it.
 */
export function useStaleServer(): UseStaleServerState {
  const [detail, setDetail] = useState<StaleServerDetail | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    function onStale(ev: Event) {
      const next = (ev as CustomEvent<StaleServerDetail>).detail;
      if (!next) return;
      const storage = browserStorage();
      if (storage && isStaleDismissed(next, storage)) return;
      setDetail(next);
    }

    window.addEventListener(STALE_SERVER_EVENT, onStale);
    return () => window.removeEventListener(STALE_SERVER_EVENT, onStale);
  }, []);

  function dismiss() {
    setDetail((current) => {
      if (current) {
        const storage = browserStorage();
        if (storage) markStaleDismissed(current, storage);
      }
      return null;
    });
  }

  return { detail, dismiss };
}
