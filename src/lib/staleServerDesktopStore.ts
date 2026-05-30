// Shared desktop-only state for the stale-server notice.
//
// On desktop the notice is shown first as a dialog, then collapses to a
// persistent warning triangle in the titlebar telemetry cluster so it never
// occupies the drag region and can be re-read on demand. The dialog (app
// shell) and the triangle (deep in the topbar) live in different subtrees, so
// they coordinate through this tiny external store instead of prop threading
// or a context wrapper.
//
// Web keeps the top banner (see StaleServerBanner); this store is inert there.

import {
  STALE_SERVER_EVENT,
  type StaleServerDetail,
} from "./staleServer";

export interface StaleServerDesktopState {
  /** Current stale instance, or null when none / resolved. */
  readonly detail: StaleServerDetail | null;
  /** When true, the dialog is hidden and only the triangle icon shows. */
  readonly collapsed: boolean;
}

const EMPTY: StaleServerDesktopState = { detail: null, collapsed: false };

let state: StaleServerDesktopState = EMPTY;
const listeners = new Set<() => void>();
let started = false;

function emit() {
  for (const l of listeners) l();
}

function setState(next: StaleServerDesktopState) {
  if (next.detail === state.detail && next.collapsed === state.collapsed) return;
  state = next;
  emit();
}

/**
 * Begin listening for stale-server events. Idempotent; safe to call from every
 * mounting consumer. No-op outside the browser.
 */
export function startStaleServerDesktopStore(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener(STALE_SERVER_EVENT, (ev: Event) => {
    const detail = (ev as CustomEvent<StaleServerDetail>).detail;
    if (!detail) return;
    // A fresh event always re-opens the dialog (e.g. reconnect to a still
    // stale instance, or a newly stale one).
    setState({ detail, collapsed: false });
  });
}

export function subscribeStaleServerDesktop(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStaleServerDesktopState(): StaleServerDesktopState {
  return state;
}

/** Collapse the dialog to the persistent triangle icon. */
export function collapseStaleServerDesktop(): void {
  if (!state.detail || state.collapsed) return;
  setState({ detail: state.detail, collapsed: true });
}

/** Re-open the dialog from the triangle icon. */
export function reopenStaleServerDesktop(): void {
  if (!state.detail || !state.collapsed) return;
  setState({ detail: state.detail, collapsed: false });
}

/** Test-only reset. */
export function __resetStaleServerDesktopStore(): void {
  state = EMPTY;
  listeners.clear();
  started = false;
}
