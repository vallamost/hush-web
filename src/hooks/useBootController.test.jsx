/**
 * useBootController tests.
 *
 * Verifies the boot state machine derives the correct state from
 * useAuth (vault/session) and useInstances (guild loading).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../contexts/InstanceContext.jsx', () => ({
  useInstanceContext: vi.fn(),
}));

import { useAuth } from '../contexts/AuthContext.jsx';
import { useInstanceContext } from '../contexts/InstanceContext.jsx';
import { BootProvider, useBootController } from './useBootController.jsx';

function mockState({
  authLoading = false,
  needsUnlock = false,
  hasSession = false,
  needsPinSetup = false,
  transparencyError = null,
  guildsLoaded = false,
  // Default lifecycle matches `unauthenticated` semantics — caller can
  // override to drive the HUSHHQ-15 gates.
  lifecycle = 'unauthenticated',
} = {}) {
  useAuth.mockReturnValue({
    loading: authLoading,
    needsUnlock,
    hasSession,
    needsPinSetup,
    transparencyError,
    lifecycle,
    user: hasSession ? { id: 'u1' } : null,
  });
  useInstanceContext.mockReturnValue({ guildsLoaded, mergedGuilds: guildsLoaded ? [{ id: 'g1' }] : [] });
}

function wrapper({ children }) {
  return <BootProvider>{children}</BootProvider>;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useBootController', () => {
  it('returns loading while auth is rehydrating', () => {
    mockState({ authLoading: true });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('loading');
  });

  it('returns needs_pin when vault is locked', () => {
    mockState({ needsUnlock: true });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('needs_pin');
  });

  it('returns needs_login when not authenticated and no vault', () => {
    mockState({ needsUnlock: false, hasSession: false });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('needs_login');
  });

  it('returns ready when authenticated but guilds not loaded yet', () => {
    mockState({ hasSession: true, guildsLoaded: false });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('ready');
  });

  it('returns booted when authenticated and guilds loaded', () => {
    mockState({ hasSession: true, guildsLoaded: true });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('booted');
  });

  it('returns ready when vaultState=none but isAuthenticated (no PIN configured)', () => {
    mockState({ hasSession: true, guildsLoaded: false });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('ready');
  });

  it('needs_pin takes priority over isAuthenticated=true', () => {
    mockState({ needsUnlock: true, hasSession: true });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('needs_pin');
  });

  it('returns pin_setup when auth reports pending pin setup', () => {
    mockState({ hasSession: true, needsPinSetup: true, guildsLoaded: true });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('pin_setup');
  });

  it('needs_pin takes priority over pending pin setup', () => {
    mockState({ needsUnlock: true, hasSession: true, needsPinSetup: true, guildsLoaded: true });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('needs_pin');
  });

  it('returns transparency_error when authenticated, unlocked, and transparencyError is set', () => {
    mockState({
      hasSession: true,
      guildsLoaded: true,
      transparencyError: 'Key mismatch detected.',
    });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('transparency_error');
  });

  it('transparency_error preempts ready when guilds are still loading', () => {
    mockState({
      hasSession: true,
      guildsLoaded: false,
      transparencyError: 'No transparency log entries found for your key.',
    });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('transparency_error');
  });

  it('needs_pin takes priority over transparency_error', () => {
    mockState({
      needsUnlock: true,
      hasSession: true,
      transparencyError: 'Key mismatch detected.',
    });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('needs_pin');
  });

  // HUSHHQ-15: destructive / recovery-required lifecycle states must
  // not let the authenticated route tree render, regardless of any
  // legacy boolean lag.
  describe('lifecycle gating (HUSHHQ-15)', () => {
    it('routes revoked to needs_login even if guilds are loaded', () => {
      mockState({
        hasSession: false,
        guildsLoaded: true,
        lifecycle: 'revoked',
      });
      const { result } = renderHook(() => useBootController(), { wrapper });
      expect(result.current.bootState).toBe('needs_login');
    });

    it('routes recovery_required to needs_login', () => {
      mockState({
        hasSession: false,
        guildsLoaded: true,
        lifecycle: 'recovery_required',
      });
      const { result } = renderHook(() => useBootController(), { wrapper });
      expect(result.current.bootState).toBe('needs_login');
    });

    it('routes wiped to needs_login', () => {
      mockState({
        hasSession: false,
        guildsLoaded: true,
        lifecycle: 'wiped',
      });
      const { result } = renderHook(() => useBootController(), { wrapper });
      expect(result.current.bootState).toBe('needs_login');
    });

    it('routes wiping to loading so neither auth tree nor PIN screen renders', () => {
      mockState({
        // Even if a stale local boolean reports a vault, wiping wins.
        needsUnlock: true,
        hasSession: true,
        guildsLoaded: true,
        lifecycle: 'wiping',
      });
      const { result } = renderHook(() => useBootController(), { wrapper });
      expect(result.current.bootState).toBe('loading');
    });

    it('revoked lifecycle outranks an in-memory authenticated session', () => {
      // Tripwire: if useAuth still has a stale token/user when revoked
      // fires, the boot controller must still gate the auth tree.
      mockState({
        hasSession: true,
        guildsLoaded: true,
        lifecycle: 'revoked',
      });
      const { result } = renderHook(() => useBootController(), { wrapper });
      expect(result.current.bootState).toBe('needs_login');
    });

    it('falls through to legacy booted when lifecycle is authorized', () => {
      mockState({
        hasSession: true,
        guildsLoaded: true,
        lifecycle: 'authorized',
      });
      const { result } = renderHook(() => useBootController(), { wrapper });
      expect(result.current.bootState).toBe('booted');
    });
  });

  it('pin_setup takes priority over transparency_error', () => {
    mockState({
      hasSession: true,
      needsPinSetup: true,
      transparencyError: 'Key mismatch detected.',
      guildsLoaded: true,
    });
    const { result } = renderHook(() => useBootController(), { wrapper });
    expect(result.current.bootState).toBe('pin_setup');
  });
});
