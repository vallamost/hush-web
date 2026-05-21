import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  __resetDesktopRendererReadyForTests,
  markDesktopShellDocument,
  signalDesktopRendererReady,
  useDesktopShell,
} from './useDesktopShell.js';

function HookHarness() {
  useDesktopShell();
  return null;
}

describe('useDesktopShell', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    __resetDesktopRendererReadyForTests();
    delete window.hushDesktop;
    delete document.documentElement.dataset.desktop;
  });

  it('is a no-op in browser context (no window.hushDesktop bridge)', () => {
    render(<HookHarness />);
    expect(document.documentElement.dataset.desktop).toBeUndefined();
  });

  it('is a no-op when the bridge is present but isDesktop is false', () => {
    window.hushDesktop = { isDesktop: false, platform: 'darwin' };
    render(<HookHarness />);
    expect(document.documentElement.dataset.desktop).toBeUndefined();
  });

  it('sets data-desktop="<platform>" on the document root in macOS desktop context', () => {
    window.hushDesktop = { isDesktop: true, platform: 'darwin' };
    render(<HookHarness />);
    expect(document.documentElement.dataset.desktop).toBe('darwin');
  });

  it('sets data-desktop="win32" on Windows desktop context', () => {
    window.hushDesktop = { isDesktop: true, platform: 'win32' };
    render(<HookHarness />);
    expect(document.documentElement.dataset.desktop).toBe('win32');
  });

  it('sets data-desktop="linux" on Linux (the marker is set; CSS decides what to apply per platform)', () => {
    window.hushDesktop = { isDesktop: true, platform: 'linux' };
    render(<HookHarness />);
    expect(document.documentElement.dataset.desktop).toBe('linux');
  });

  it('can mark the desktop document before React renders', () => {
    window.hushDesktop = { isDesktop: true, platform: 'darwin' };

    expect(markDesktopShellDocument()).toBe(true);

    expect(document.documentElement.dataset.desktop).toBe('darwin');
  });

  it('removes the marker on unmount', () => {
    window.hushDesktop = { isDesktop: true, platform: 'darwin' };
    const { unmount } = render(<HookHarness />);
    expect(document.documentElement.dataset.desktop).toBe('darwin');
    unmount();
    expect(document.documentElement.dataset.desktop).toBeUndefined();
  });

  it('falls back to "true" when platform is missing or empty', () => {
    window.hushDesktop = { isDesktop: true };
    render(<HookHarness />);
    expect(document.documentElement.dataset.desktop).toBe('true');
  });

  it('signals renderer-ready from the shell marker hook', () => {
    const notifyRendererReady = vi.fn();
    window.hushDesktop = { isDesktop: true, platform: 'darwin', notifyRendererReady };

    render(<HookHarness />);

    expect(document.documentElement.dataset.desktop).toBe('darwin');
    expect(notifyRendererReady).toHaveBeenCalledTimes(1);
  });

  it('signals renderer-ready at most once', () => {
    const notifyRendererReady = vi.fn();
    window.hushDesktop = { isDesktop: true, platform: 'darwin', notifyRendererReady };

    const first = render(<HookHarness />);
    first.unmount();
    render(<HookHarness />);

    expect(notifyRendererReady).toHaveBeenCalledTimes(1);
  });

  it('can signal renderer-ready before React renders', () => {
    const notifyRendererReady = vi.fn();
    window.hushDesktop = { isDesktop: true, platform: 'darwin', notifyRendererReady };

    expect(signalDesktopRendererReady()).toBe(true);
    expect(signalDesktopRendererReady()).toBe(false);
    expect(notifyRendererReady).toHaveBeenCalledTimes(1);
  });
});
