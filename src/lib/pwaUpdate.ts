// Service Worker registration shim.
//
// vite-plugin-pwa generates the virtual module `virtual:pwa-register` at
// build time. Vitest resolves it through a test-only alias in vitest.config.js
// so the production import stays static and Vite can bundle it correctly.
//
// Side effects: when invoked, this function asks the browser to register the
// SW. When the plugin reports `onNeedRefresh`, we:
//   * Stash the updater callback in the global update-required store so the
//     Update Required dialog can activate the new SW on click.
//   * Dispatch the global `hush:update-required` event so the dialog opens.
//
// The PWA layer is the ONLY place that touches the SW lifecycle. It does NOT
// read or write IndexedDB, localStorage, MLS state, vault state, or any
// authentication material.

import {
  requestUpdate,
  setWaitingUpdateSW,
} from "./updateRequired";
import { registerSW } from "virtual:pwa-register";
import { recordClientDiagnostic } from "./clientDiagnostics";

/**
 * Register the Service Worker via vite-plugin-pwa. Idempotent — calling it
 * twice is safe; the plugin internally guards re-registration.
 *
 * In environments where the SW is unavailable (vitest, SSR, browsers without
 * SW support) this is a no-op.
 */
let hasRegistered = false;

function isDesktopRenderer(): boolean {
  if (typeof window === "undefined") return false;

  const desktopWindow = window as typeof window & {
    hushDesktop?: { isDesktop?: boolean };
  };

  return desktopWindow.hushDesktop?.isDesktop === true
    || window.location.protocol === "app:";
}

export function registerPWA(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (isDesktopRenderer()) return;
  if (hasRegistered) return;

  try {
    hasRegistered = true;
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        // Stash the activator so the Update Required dialog can invoke it.
        setWaitingUpdateSW(async () => {
          await updateSW(true);
        });
        recordClientDiagnostic({
          category: "update",
          event: "sw-need-refresh",
          severity: "info",
          details: {},
        });
        requestUpdate({ reason: "sw-need-refresh" });
      },
      onRegisterError(err: unknown) {
        // SW registration failure is non-fatal for the app. Log and move on.
        recordClientDiagnostic({
          category: "update",
          event: "sw-register-failed",
          severity: "warn",
          details: { message: err instanceof Error ? err.message : String(err) },
        });
        // eslint-disable-next-line no-console
        console.warn("[pwa] registration failed", err);
      },
    } as never);
  } catch (err) {
    hasRegistered = false;
    // Registration failure is non-fatal for the app.
    // eslint-disable-next-line no-console
    console.warn("[pwa] registration failed", err);
  }
}
