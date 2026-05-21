import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../../hooks/useBootController.jsx', () => ({
  useBootController: vi.fn(),
}));

vi.mock('../../contexts/InstanceContext.jsx', () => ({
  useInstanceContext: vi.fn(),
}));

vi.mock('./useInstancePing.js', () => ({
  useInstancePing: vi.fn(),
  PING_INTERVAL_MS: 15_000,
  PING_TIMEOUT_MS: 4_000,
}));

import { useBootController } from '../../hooks/useBootController.jsx';
import { useInstanceContext } from '../../contexts/InstanceContext.jsx';
import { useInstancePing } from './useInstancePing.js';
import { DesktopTopBar } from './DesktopTopBar.jsx';
import { OPEN_COMMAND_PALETTE_EVENT } from './DesktopOmnibar.jsx';
import { PING_STATUS } from './pingStatus.js';

function installBridge(platform = 'darwin') {
  window.hushDesktop = {
    isDesktop: true,
    platform,
    getAppVersion: () => Promise.resolve('1.2.3'),
  };
}

function mockBoot(bootState) {
  useBootController.mockReturnValue({
    bootState,
    user: null,
    mergedGuilds: [],
    guildsLoaded: bootState === 'booted',
  });
}

function mockInstances(instanceUrl = null) {
  useInstanceContext.mockReturnValue({
    mergedGuilds: instanceUrl ? [{ id: 'g1', instanceUrl }] : [],
  });
}

describe('DesktopTopBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBoot('booted');
    mockInstances('https://hush.example.com');
    useInstancePing.mockReturnValue({ ms: 42, status: PING_STATUS.LOW });
  });

  afterEach(() => {
    cleanup();
    delete window.hushDesktop;
    vi.restoreAllMocks();
  });

  it('renders nothing in a browser context (no preload bridge)', () => {
    const { container } = render(<DesktopTopBar />);
    expect(container.querySelector('.hush-desktop-topbar')).toBeNull();
  });

  it('renders nothing on Linux (native frame already supplies drag)', () => {
    installBridge('linux');
    const { container } = render(<DesktopTopBar />);
    expect(container.querySelector('.hush-desktop-topbar')).toBeNull();
  });

  it('renders a draggable header with the platform marker on macOS', () => {
    installBridge('darwin');
    const { container } = render(<DesktopTopBar />);
    const bar = container.querySelector('.hush-desktop-topbar');
    expect(bar).not.toBeNull();
    expect(bar.dataset.platform).toBe('darwin');
    expect(bar.style.WebkitAppRegion).toBe('drag');
  });

  it('reserves the macOS left safe area for the traffic-light cluster', () => {
    installBridge('darwin');
    const { container } = render(<DesktopTopBar />);
    const bar = container.querySelector('.hush-desktop-topbar');
    expect(bar.style.getPropertyValue('--desktop-left-safe-area')).toBe('78px');
    expect(bar.style.paddingLeft).toBe('');
    expect(bar.style.paddingRight).toBe('');
  });

  it('reserves the Windows right safe area for the titleBarOverlay controls', () => {
    installBridge('win32');
    const { container } = render(<DesktopTopBar />);
    const bar = container.querySelector('.hush-desktop-topbar');
    expect(bar.dataset.platform).toBe('win32');
    expect(bar.style.getPropertyValue('--desktop-right-safe-area')).toContain('titlebar-area-x');
    expect(bar.style.getPropertyValue('--desktop-right-safe-area')).toContain('titlebar-area-width');
    expect(bar.style.getPropertyValue('--desktop-right-safe-area')).toContain('140px');
    expect(bar.style.paddingRight).toBe('');
    expect(bar.style.paddingLeft).toBe('');
  });

  it('places the telemetry cluster on the right on macOS (away from traffic lights)', () => {
    installBridge('darwin');
    const { container } = render(<DesktopTopBar />);
    const right = container.querySelector('.hush-desktop-topbar__cluster--right');
    const left = container.querySelector('.hush-desktop-topbar__cluster--left');
    expect(right?.querySelector('.hush-desktop-telemetry')).not.toBeNull();
    expect(left?.querySelector('.hush-desktop-telemetry')).toBeNull();
  });

  it('places the telemetry cluster on the left on Windows (opposite the overlay)', () => {
    installBridge('win32');
    const { container } = render(<DesktopTopBar />);
    const left = container.querySelector('.hush-desktop-topbar__cluster--left');
    const right = container.querySelector('.hush-desktop-topbar__cluster--right');
    expect(left?.querySelector('.hush-desktop-telemetry')).not.toBeNull();
    expect(right?.querySelector('.hush-desktop-telemetry')).toBeNull();
  });

  it('renders the omnibar with the macOS shortcut label on darwin', () => {
    installBridge('darwin');
    const { container } = render(<DesktopTopBar />);
    const shortcut = container.querySelector('.hush-desktop-omnibar__shortcut');
    expect(shortcut?.textContent).toBe('⌘K');
  });

  it('renders the omnibar with the Ctrl K shortcut label on win32', () => {
    installBridge('win32');
    const { container } = render(<DesktopTopBar />);
    const shortcut = container.querySelector('.hush-desktop-omnibar__shortcut');
    expect(shortcut?.textContent).toBe('Ctrl K');
  });

  it('hides the omnibar and telemetry pre-login (boot state still in auth flow)', () => {
    installBridge('darwin');
    mockBoot('needs_login');
    const { container } = render(<DesktopTopBar />);
    expect(container.querySelector('.hush-desktop-topbar')).not.toBeNull();
    expect(container.querySelector('.hush-desktop-omnibar')).toBeNull();
    expect(container.querySelector('.hush-desktop-telemetry')).toBeNull();
  });

  it('opens the command palette via window event when the omnibar is clicked', () => {
    installBridge('darwin');
    const listener = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, listener);
    const { container } = render(<DesktopTopBar />);
    fireEvent.click(container.querySelector('.hush-desktop-omnibar'));
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, listener);
  });

  it('paints the sidebar tint when the user is authenticated (matches rail + channel sidebar)', () => {
    installBridge('darwin');
    const { container } = render(<DesktopTopBar />);
    const bar = container.querySelector('.hush-desktop-topbar');
    expect(bar.dataset.bgMode).toBe('sidebar');
    // Inline custom property drives the `background-color: var(--desktop-topbar-bg)`
    // declaration in the stylesheet, so theme tokens still resolve at runtime.
    expect(bar.style.getPropertyValue('--desktop-topbar-bg')).toBe('var(--desktop-chrome-bg)');
  });

  it('paints the background tint on auth screens (matches auth-wrapper bg)', () => {
    installBridge('darwin');
    mockBoot('needs_login');
    const { container } = render(<DesktopTopBar />);
    const bar = container.querySelector('.hush-desktop-topbar');
    expect(bar.dataset.bgMode).toBe('background');
    expect(bar.style.getPropertyValue('--desktop-topbar-bg')).toBe('var(--background)');
  });

  it('does not paint a visible bottom-divider line (quiet desktop chrome)', () => {
    installBridge('darwin');
    const { container } = render(<DesktopTopBar />);
    const bar = container.querySelector('.hush-desktop-topbar');
    // The CSS class drops `border-bottom` in favour of a subtle background
    // tint. Inline `borderBottom` must remain empty so nothing else on the
    // page can sneak a hairline divider back via override.
    expect(bar.style.borderBottom).toBe('');
    expect(bar.style.borderBottomWidth).toBe('');
  });

  it('marks every interactive child of the topbar with -webkit-app-region: no-drag', () => {
    installBridge('darwin');
    const { container } = render(<DesktopTopBar />);
    const interactives = container.querySelectorAll(
      '.hush-desktop-topbar button, .hush-desktop-topbar a, .hush-desktop-topbar [role="button"], .hush-desktop-topbar [role="link"]',
    );
    expect(interactives.length).toBeGreaterThan(0);
    interactives.forEach((el) => {
      // The omnibar carries the inline contract; the telemetry pills get
      // the rule via the global stylesheet rather than inline style, so we
      // only enforce inline on the clickable controls (buttons + links).
      if (el.tagName === 'BUTTON' || el.tagName === 'A') {
        expect(el.style.WebkitAppRegion).toBe('no-drag');
      }
    });
  });
});
