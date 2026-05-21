/**
 * App.test.jsx - Two-tab detection via BroadcastChannel
 *
 * Tests the useSingleTab hook behavior:
 * 1. isBlockedTab becomes true when session_active is received within 500ms of session_ping
 * 2. isBlockedTab remains false when no session_active received within 500ms (tab is primary)
 * 3. isBlockedTab becomes true when session_takeover is received (old tab yields)
 * 4. BroadcastChannel unavailability degrades gracefully (isBlockedTab = false, app renders)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Mock all heavy dependencies that App.jsx transitively pulls in.
// These mocks must appear BEFORE the App/useSingleTab imports so the factory
// functions run first (Vitest hoists vi.mock() calls to the top of the file).
// ---------------------------------------------------------------------------

vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  // useAuth is a `vi.fn()` so individual tests can override its return
  // for the new transparency-hard-fail surface. Default keeps the
  // pre-existing public-route shape.
  useAuth: vi.fn(() => ({
    vaultState: 'locked',
    isAuthenticated: false,
    loading: false,
    transparencyError: null,
  })),
}));

vi.mock('./contexts/InstanceContext', () => ({
  InstanceProvider: ({ children }) => children,
  useInstanceContext: () => ({ mergedGuilds: [], guildsLoaded: true }),
}));

// Mock useBootController so we can control bootState in App tests
vi.mock('./hooks/useBootController.jsx', () => ({
  BootProvider: ({ children }) => children,
  useBootController: vi.fn(() => ({
    bootState: 'needs_login',
    user: null,
    mergedGuilds: [],
    guildsLoaded: true,
    setPinSetupPending: vi.fn(),
    clearPinSetupPending: vi.fn(),
  })),
}));

vi.mock('./lib/slugify', () => ({
  slugify: (s) => s,
  buildGuildRouteRef: (name, guildId) => `${name}--${guildId}`,
}));

vi.mock('./components/AppBackground', () => ({ default: () => null }));

// Mock useSingleTab so we can control the blocked-tab state in App tests
vi.mock('./hooks/useSingleTab', () => ({
  useSingleTab: vi.fn(() => ({ isBlockedTab: false, takeOver: vi.fn() })),
}));

// jsdom doesn't implement matchMedia - provide a minimal stub so FaviconThemeSync
// doesn't throw when the normal app renders (isBlockedTab = false path).
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

// Mock all lazy-loaded pages so Suspense doesn't need to resolve them
vi.mock('./components/auth/unauthenticated-shell', () => ({
  UnauthenticatedShell: () => <div>Home</div>,
}));
vi.mock('./components/authenticated-app', () => ({
  AuthenticatedApp: () => <div>ServerLayout</div>,
}));
vi.mock('./components/roadmap-page', () => ({
  RoadmapPage: () => <div>Roadmap</div>,
}));
vi.mock('./pages/Invite', () => ({ default: () => <div>Invite</div> }));
vi.mock('./pages/LinkDevice.jsx', () => ({ default: () => <div>LinkDevice</div> }));
vi.mock('./pages/ServerLayout', () => ({ default: () => <div>ServerLayout</div> }));
vi.mock('./pages/ExplorePage', () => ({ default: () => <div>ExplorePage</div> }));

import App from './App';
import { useSingleTab } from './hooks/useSingleTab';
import { useBootController } from './hooks/useBootController.jsx';
import { useAuth } from './contexts/AuthContext';
import { cleanup } from '@testing-library/react';

// ---------------------------------------------------------------------------
// BroadcastChannel mock infrastructure - used by useSingleTab unit tests
// ---------------------------------------------------------------------------

/**
 * A minimal BroadcastChannel mock that wires all instances sharing the same
 * channel name together so messages actually propagate between them.
 */
class MockBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.closed = false;
    MockBroadcastChannel._instances.push(this);
  }

  postMessage(data) {
    if (this.closed) return;
    for (const other of MockBroadcastChannel._instances) {
      if (other !== this && other.name === this.name && !other.closed && other.onmessage) {
        other.onmessage({ data });
      }
    }
  }

  close() {
    this.closed = true;
  }

  static _instances = [];

  static reset() {
    MockBroadcastChannel._instances = [];
  }
}

// ---------------------------------------------------------------------------
// useSingleTab hook unit tests (import the real hook directly)
// ---------------------------------------------------------------------------

// Import the real hook for unit-level tests in a sub-describe block.
// The vi.mock('./hooks/useSingleTab') above affects App, but we can
// still import and test the real hook by importing it directly below.
// Note: vi.mock hoisting replaces the module in all describe blocks that
// import via './hooks/useSingleTab'. To test the actual hook implementation
// we must bypass the mock using importActual.
const { useSingleTab: realUseSingleTab } = await vi.importActual('./hooks/useSingleTab');

let originalBroadcastChannel;

describe('useSingleTab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockBroadcastChannel.reset();
    originalBroadcastChannel = global.BroadcastChannel;
    global.BroadcastChannel = MockBroadcastChannel;
    // Clear sessionStorage so each test starts with a fresh tab ID.
    sessionStorage.removeItem('hush_tab_id');
  });

  afterEach(() => {
    vi.useRealTimers();
    global.BroadcastChannel = originalBroadcastChannel;
    sessionStorage.removeItem('hush_tab_id');
  });

  it('isBlockedTab is true when session_active from a DIFFERENT tab ID (duplicate tab)', async () => {
    const { result } = renderHook(() => realUseSingleTab());

    await act(async () => {
      const hookChannel = MockBroadcastChannel._instances[0];
      if (hookChannel?.onmessage) {
        hookChannel.onmessage({ data: { type: 'session_active', tabId: 'other-tab-id' } });
      }
    });

    expect(result.current.isBlockedTab).toBe(true);
  });

  it('isBlockedTab is false when session_active from the SAME tab ID (refresh)', async () => {
    const { result } = renderHook(() => realUseSingleTab());

    // Read the tab ID that the hook just stored in sessionStorage
    const ownTabId = sessionStorage.getItem('hush_tab_id');
    expect(ownTabId).toBeTruthy();

    await act(async () => {
      const hookChannel = MockBroadcastChannel._instances[0];
      if (hookChannel?.onmessage) {
        // Same tab ID - simulates pre-refresh page responding
        hookChannel.onmessage({ data: { type: 'session_active', tabId: ownTabId } });
      }
    });

    // Should NOT be blocked - it's the same tab refreshing
    expect(result.current.isBlockedTab).toBe(false);
  });

  it('isBlockedTab is false when no session_active received within 500ms (primary tab)', async () => {
    const { result } = renderHook(() => realUseSingleTab());

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current.isBlockedTab).toBe(false);
  });

  it('isBlockedTab becomes true when session_takeover is received (old tab yields)', async () => {
    const { result } = renderHook(() => realUseSingleTab());

    // Advance past ping timeout so it becomes the primary tab
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.isBlockedTab).toBe(false);

    // New tab sends session_takeover
    await act(async () => {
      const hookChannel = MockBroadcastChannel._instances[0];
      if (hookChannel?.onmessage) {
        hookChannel.onmessage({ data: { type: 'session_takeover' } });
      }
    });

    expect(result.current.isBlockedTab).toBe(true);
  });

  it('primary tab responds to ping with its own tabId', async () => {
    renderHook(() => realUseSingleTab());

    // Become primary
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    // Simulate another tab's ping - the primary tab should respond
    const primaryChannel = MockBroadcastChannel._instances[0];

    // Create a "new tab" channel to receive the response
    const newTabChannel = new MockBroadcastChannel('hush_session');
    const received = [];
    newTabChannel.onmessage = (e) => received.push(e.data);

    // Send ping from the new tab channel
    await act(async () => {
      newTabChannel.postMessage({ type: 'session_ping', tabId: 'new-tab-id' });
    });

    expect(received).toEqual([
      expect.objectContaining({ type: 'session_active', tabId: expect.any(String) }),
    ]);
    // The response tabId should be the primary tab's ID, not the sender's
    expect(received[0].tabId).not.toBe('new-tab-id');
  });

  it('isBlockedTab is false when BroadcastChannel is unavailable (graceful degradation)', async () => {
    global.BroadcastChannel = function () {
      throw new Error('BroadcastChannel is not supported');
    };

    const { result } = renderHook(() => realUseSingleTab());

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current.isBlockedTab).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// App integration: blocked-tab overlay rendering
// ---------------------------------------------------------------------------

describe('App - blocked-tab overlay', () => {
  beforeEach(() => {
    vi.useRealTimers();
    cleanup();
    delete window.hushDesktop;
    delete window.requestAnimationFrame;
  });

  afterEach(() => {
    cleanup();
    delete window.hushDesktop;
    delete window.requestAnimationFrame;
  });

  it('renders the blocked-tab overlay when isBlockedTab is true', () => {
    useSingleTab.mockReturnValue({ isBlockedTab: true, takeOver: vi.fn() });

    render(<MemoryRouter><App /></MemoryRouter>);

    expect(screen.getByText(/already open in another tab/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use this one instead/i })).toBeInTheDocument();
  });

  it('shows device-link specific blocked-tab copy on the approval route', () => {
    useSingleTab.mockReturnValue({ isBlockedTab: true, takeOver: vi.fn() });

    render(
      <MemoryRouter initialEntries={['/link-device?payload=abc']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText(/approve this device here, take over this tab/i)).toBeInTheDocument();
  });

  it('shows invite-specific blocked-tab copy on invite routes', () => {
    useSingleTab.mockReturnValue({ isBlockedTab: true, takeOver: vi.fn() });

    render(
      <MemoryRouter initialEntries={['/invite/abc123']}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText(/continue this invite here, take over this tab/i)).toBeInTheDocument();
  });

  it('renders Home when bootState is needs_login', async () => {
    useSingleTab.mockReturnValue({ isBlockedTab: false, takeOver: vi.fn() });
    useBootController.mockReturnValue({ bootState: 'needs_login', user: null, mergedGuilds: [], guildsLoaded: true });

    render(<MemoryRouter><App /></MemoryRouter>);

    expect(screen.queryByText(/already open in another tab/i)).not.toBeInTheDocument();
    expect(await screen.findByText('Home')).toBeInTheDocument();
  });

  it('renders Home when bootState is needs_pin', async () => {
    useSingleTab.mockReturnValue({ isBlockedTab: false, takeOver: vi.fn() });
    useBootController.mockReturnValue({ bootState: 'needs_pin', user: null, mergedGuilds: [], guildsLoaded: false });

    render(<MemoryRouter><App /></MemoryRouter>);

    expect(await screen.findByText('Home')).toBeInTheDocument();
  });

  it('redirects to the requested returnTo route after unlock/login recovery', async () => {
    useSingleTab.mockReturnValue({ isBlockedTab: false, takeOver: vi.fn() });
    useBootController.mockReturnValue({ bootState: 'ready', user: null, mergedGuilds: [], guildsLoaded: true });

    render(
      <MemoryRouter initialEntries={['/?returnTo=%2Flink-device%3Fpayload%3Dabc']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('LinkDevice')).toBeInTheDocument();
  });

  it('resumes a queued invite after login', async () => {
    useSingleTab.mockReturnValue({ isBlockedTab: false, takeOver: vi.fn() });
    useBootController.mockReturnValue({ bootState: 'ready', user: null, mergedGuilds: [], guildsLoaded: true });
    sessionStorage.setItem(
      'hush_pending_invite',
      `${window.location.origin}/invite/abc123#name=Secret%20Guild`,
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Invite')).toBeInTheDocument();
    expect(sessionStorage.getItem('hush_pending_invite')).toBeNull();
  });

  it('ignores invalid returnTo values and falls back to the normal post-login route', async () => {
    useSingleTab.mockReturnValue({ isBlockedTab: false, takeOver: vi.fn() });
    useBootController.mockReturnValue({ bootState: 'ready', user: null, mergedGuilds: [], guildsLoaded: true });

    render(
      <MemoryRouter initialEntries={['/?returnTo=%2F%2Fevil.example']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('ServerLayout')).toBeInTheDocument();
  });

  it('keeps the device-link route public while login is required', async () => {
    useSingleTab.mockReturnValue({ isBlockedTab: false, takeOver: vi.fn() });
    useBootController.mockReturnValue({ bootState: 'needs_login', user: null, mergedGuilds: [], guildsLoaded: false });

    render(
      <MemoryRouter initialEntries={['/link-device?mode=new']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('LinkDevice')).toBeInTheDocument();
  });

  it('renders blank fallback when bootState is loading', () => {
    useSingleTab.mockReturnValue({ isBlockedTab: false, takeOver: vi.fn() });
    useBootController.mockReturnValue({ bootState: 'loading', user: null, mergedGuilds: [], guildsLoaded: false });

    const { container } = render(<MemoryRouter><App /></MemoryRouter>);

    // No Home, no overlay - just blank.
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
    expect(screen.queryByText(/already open/i)).not.toBeInTheDocument();
    expect(container.querySelector('[style]')).toBeTruthy();
  });

  it('calls takeOver when "Use this one instead" button is clicked', async () => {
    const takeOver = vi.fn();
    useSingleTab.mockReturnValue({ isBlockedTab: true, takeOver });

    render(<MemoryRouter><App /></MemoryRouter>);

    const buttons = screen.getAllByRole('button', { name: /use this one instead/i });
    await userEvent.click(buttons[0]);

    expect(takeOver).toHaveBeenCalledTimes(1);
  });
});

describe('App - transparency hard-fail gate', () => {
  beforeEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the blocking security failure screen when bootState is transparency_error', () => {
    useSingleTab.mockReturnValue({ isBlockedTab: false, takeOver: vi.fn() });
    useBootController.mockReturnValue({
      bootState: 'transparency_error',
      user: { id: 'u1' },
      mergedGuilds: [],
      guildsLoaded: true,
    });
    useAuth.mockReturnValue({
      vaultState: 'unlocked',
      isAuthenticated: true,
      loading: false,
      transparencyError: 'Key mismatch detected. Your account may be compromised.',
    });

    render(<MemoryRouter><App /></MemoryRouter>);

    const alert = screen.getByTestId('transparency-error-screen');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute('role', 'alert');
    expect(
      screen.getByText(/Key mismatch detected\. Your account may be compromised\./i),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /security check failed/i })).toBeInTheDocument();
    expect(screen.queryByText('ServerLayout')).not.toBeInTheDocument();
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
  });

  it('uses a generic fallback message when transparencyError is set but empty', () => {
    useSingleTab.mockReturnValue({ isBlockedTab: false, takeOver: vi.fn() });
    useBootController.mockReturnValue({
      bootState: 'transparency_error',
      user: { id: 'u1' },
      mergedGuilds: [],
      guildsLoaded: true,
    });
    useAuth.mockReturnValue({
      vaultState: 'unlocked',
      isAuthenticated: true,
      loading: false,
      transparencyError: '',
    });

    render(<MemoryRouter><App /></MemoryRouter>);

    expect(screen.getByTestId('transparency-error-screen')).toBeInTheDocument();
    expect(
      screen.getByText(/Do not continue on this device/i),
    ).toBeInTheDocument();
  });
});
