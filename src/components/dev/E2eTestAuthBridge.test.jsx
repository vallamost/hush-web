import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { E2eTestAuthBridge } from './E2eTestAuthBridge.jsx';

// The bridge only triggers the real auth flow; the unit test asserts the
// security-critical property: the test surface is installed ONLY when the
// VITE_E2E_DIAG flag is set, and removed on unmount. It never asserts that a
// fake vault works (there is none).

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    performRegister: vi.fn(),
    setPIN: vi.fn(),
    unlockVault: vi.fn(),
    user: null,
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete window.__hushTestAuth;
});

describe('E2eTestAuthBridge', () => {
  it('does not expose window.__hushTestAuth when VITE_E2E_DIAG is off', () => {
    render(<E2eTestAuthBridge />);
    expect(window.__hushTestAuth).toBeUndefined();
  });

  it('exposes registerAndUnlock only when VITE_E2E_DIAG is set', () => {
    vi.stubEnv('VITE_E2E_DIAG', '1');
    render(<E2eTestAuthBridge />);
    expect(typeof window.__hushTestAuth?.registerAndUnlock).toBe('function');
  });

  it('removes window.__hushTestAuth on unmount', () => {
    vi.stubEnv('VITE_E2E_DIAG', '1');
    const { unmount } = render(<E2eTestAuthBridge />);
    expect(window.__hushTestAuth).toBeDefined();
    unmount();
    expect(window.__hushTestAuth).toBeUndefined();
  });
});
