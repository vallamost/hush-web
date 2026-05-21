import { useEffect } from 'react';

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
    if (!api || api.isDesktop !== true) return undefined;
    const root = document.documentElement;
    const marker = typeof api.platform === 'string' && api.platform.length > 0
      ? api.platform
      : 'true';
    const previous = root.dataset.desktop ?? null;
    root.dataset.desktop = marker;

    // Signal the main process that the desktop shell is mounted and the
    // base classes are applied, so it can reveal the cold-launch window
    // without a flash of unstyled UI. Fire-and-forget: main is idempotent
    // and a missing method (older desktop builds) silently degrades to
    // the legacy `ready-to-show` reveal path.
    if (typeof api.notifyRendererReady === 'function') {
      try {
        api.notifyRendererReady();
      } catch {
        // ignore preload bridge errors
      }
    }
    return () => {
      if (previous === null) {
        delete root.dataset.desktop;
      } else {
        root.dataset.desktop = previous;
      }
    };
  }, []);
}
