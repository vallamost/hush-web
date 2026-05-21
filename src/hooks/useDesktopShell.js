import { useEffect } from 'react';

const PAINT_FRAMES_BEFORE_REVEAL = 2;
const FONT_READY_TIMEOUT_MS = 750;
const DOM_IDLE_BEFORE_REVEAL_MS = 160;
const DOM_IDLE_MAX_WAIT_MS = 2000;

let hasSignaledRendererReady = false;

function isDesktopBridge(api) {
  return api && api.isDesktop === true;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForAnimationFrame() {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function waitForDomIdle() {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
      setTimeout(resolve, DOM_IDLE_BEFORE_REVEAL_MS);
      return;
    }

    let idleTimer = null;
    let maxTimer = null;
    let observer = null;

    const finish = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (maxTimer !== null) clearTimeout(maxTimer);
      observer?.disconnect();
      resolve();
    };

    const armIdleTimer = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, DOM_IDLE_BEFORE_REVEAL_MS);
    };

    observer = new MutationObserver(armIdleTimer);
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    armIdleTimer();
    maxTimer = setTimeout(finish, DOM_IDLE_MAX_WAIT_MS);
  });
}

async function waitForStableFirstPaint() {
  const fonts = typeof document !== 'undefined' ? document.fonts : null;
  if (fonts && fonts.ready && typeof fonts.ready.then === 'function') {
    await Promise.race([
      fonts.ready.catch(() => undefined),
      wait(FONT_READY_TIMEOUT_MS),
    ]);
  }

  for (let frame = 0; frame < PAINT_FRAMES_BEFORE_REVEAL; frame += 1) {
    await waitForAnimationFrame();
  }

  await waitForDomIdle();

  for (let frame = 0; frame < PAINT_FRAMES_BEFORE_REVEAL; frame += 1) {
    await waitForAnimationFrame();
  }
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

    return () => {
      if (previous === null) {
        delete root.dataset.desktop;
      } else {
        root.dataset.desktop = previous;
      }
    };
  }, []);
}

/**
 * Signals Electron only after a real route surface has committed and the
 * browser has had a stable paint opportunity. Keep this separate from
 * `useDesktopShell`: the shell marker mounts before auth boot, redirects,
 * lazy route chunks, and theme/glass vars have settled.
 */
export function DesktopRendererReadySignal({ ready = true } = {}) {
  useEffect(() => {
    if (!ready || hasSignaledRendererReady) return undefined;
    if (typeof window === 'undefined') return undefined;
    if (typeof document === 'undefined') return undefined;

    const api = window.hushDesktop;
    if (!isDesktopBridge(api)) return undefined;

    let cancelled = false;

    void waitForStableFirstPaint().then(() => {
      if (cancelled || hasSignaledRendererReady) return;
      hasSignaledRendererReady = true;
      try {
        notifyRendererReady(api);
      } catch {
        // The preload bridge is best-effort. Main still has a reveal fallback.
      }
    });

    return () => {
      cancelled = true;
    };
  }, [ready]);

  return null;
}

export function __resetDesktopRendererReadyForTests() {
  hasSignaledRendererReady = false;
}
