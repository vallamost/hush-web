import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';
import {
  __resetDesktopRendererReadyForTests,
  DesktopRendererReadySignal,
  markDesktopShellDocument,
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
    delete document.documentElement.dataset.desktopReveal;
    delete window.requestAnimationFrame;
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
    expect(document.documentElement.dataset.desktopReveal).toBe('ready');
  });

  it('sets data-desktop="win32" on Windows desktop context', () => {
    window.hushDesktop = { isDesktop: true, platform: 'win32' };
    render(<HookHarness />);
    expect(document.documentElement.dataset.desktop).toBe('win32');
    expect(document.documentElement.dataset.desktopReveal).toBe('ready');
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
    expect(document.documentElement.dataset.desktopReveal).toBe('ready');
  });

  it('keeps chrome in solid reveal mode until the desktop window is visible', () => {
    let revealListener = null;
    window.hushDesktop = {
      isDesktop: true,
      platform: 'darwin',
      onWindowRevealed: (listener) => {
        revealListener = listener;
        return vi.fn();
      },
    };

    render(<HookHarness />);

    expect(document.documentElement.dataset.desktopReveal).toBe('pending');
    revealListener();
    expect(document.documentElement.dataset.desktopReveal).toBe('ready');
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

  it('does not signal renderer-ready from the shell marker hook', () => {
    const notifyRendererReady = vi.fn();
    window.hushDesktop = { isDesktop: true, platform: 'darwin', notifyRendererReady };

    render(<HookHarness />);

    expect(document.documentElement.dataset.desktop).toBe('darwin');
    expect(notifyRendererReady).not.toHaveBeenCalled();
  });
});

describe('DesktopRendererReadySignal', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    __resetDesktopRendererReadyForTests();
    delete window.hushDesktop;
    delete document.documentElement.dataset.desktopReveal;
    delete window.requestAnimationFrame;
  });

  it('waits for stable paint and DOM idle before notifying main', async () => {
    vi.useFakeTimers();
    const notifyRendererReady = vi.fn();
    window.hushDesktop = { isDesktop: true, platform: 'darwin', notifyRendererReady };
    window.requestAnimationFrame = (callback) => {
      setTimeout(() => callback(performance.now()), 0);
      return 1;
    };

    render(<DesktopRendererReadySignal />);

    expect(notifyRendererReady).not.toHaveBeenCalled();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(notifyRendererReady).toHaveBeenCalledTimes(1);
  });

  it('does not notify while ready is false', async () => {
    vi.useFakeTimers();
    const notifyRendererReady = vi.fn();
    window.hushDesktop = { isDesktop: true, platform: 'darwin', notifyRendererReady };

    render(<DesktopRendererReadySignal ready={false} />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(notifyRendererReady).not.toHaveBeenCalled();
  });

  it('notifies at most once across remounts', async () => {
    vi.useFakeTimers();
    const notifyRendererReady = vi.fn();
    window.hushDesktop = { isDesktop: true, platform: 'darwin', notifyRendererReady };

    const first = render(<DesktopRendererReadySignal />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    first.unmount();
    render(<DesktopRendererReadySignal />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(notifyRendererReady).toHaveBeenCalledTimes(1);
  });
});
