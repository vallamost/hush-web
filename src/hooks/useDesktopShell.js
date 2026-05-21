import { useEffect } from 'react';

let hasSignaledRendererReady = false;

function isDesktopBridge(api) {
  return api && api.isDesktop === true;
}

function notifyRendererReady(api) {
  if (typeof api.notifyRendererReady !== 'function') return;
  api.notifyRendererReady();
}

export function markDesktopShellDocument(
  api = typeof window === 'undefined' ? undefined : window.hushDesktop,
  root = typeof document === 'undefined' ? undefined : document.documentElement,
) {
  if (!root || !isDesktopBridge(api)) return false;
  const marker = typeof api.platform === 'string' && api.platform.length > 0
    ? api.platform
    : 'true';
  root.dataset.desktop = marker;
  return true;
}

export function signalDesktopRendererReady(
  api = typeof window === 'undefined' ? undefined : window.hushDesktop,
) {
  if (hasSignaledRendererReady || !isDesktopBridge(api)) return false;
  hasSignaledRendererReady = true;
  try {
    notifyRendererReady(api);
    return true;
  } catch {
    hasSignaledRendererReady = false;
    return false;
  }
}

/**
 * Marks the document root with `data-desktop="<platform>"` while running
 * inside the Electron renderer, and removes the marker on unmount. Acts as
 * the single class hook that platform-specific shell rules (e.g. the
 * shell-scroll lock in `global.css`) target.
 *
 * Gated strictly by the existing preload bridge (`window.hushDesktop`).
 * No-op in browser context, on missing bridge, or when `isDesktop` is false.
 *
 * Rendering / hosting consequences are local to the document element; no
 * other state, no event listeners.
 */
export function useDesktopShell() {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (typeof document === 'undefined') return undefined;
    const api = window.hushDesktop;
    if (!isDesktopBridge(api)) return undefined;
    const root = document.documentElement;
    const previous = root.dataset.desktop ?? null;
    markDesktopShellDocument(api, root);
    signalDesktopRendererReady(api);

    return () => {
      if (previous === null) {
        delete root.dataset.desktop;
      } else {
        root.dataset.desktop = previous;
      }
    };
  }, []);
}

export function __resetDesktopRendererReadyForTests() {
  hasSignaledRendererReady = false;
}
