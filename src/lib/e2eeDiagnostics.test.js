import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('e2eeDiagnostics', () => {
  beforeEach(() => {
    delete globalThis.window;
    globalThis.window = {};
    vi.resetModules();
  });

  it('does not attach __hushE2eeStats when the diag flag is off', async () => {
    const { installE2eeDiagnostics } = await import('./e2eeDiagnostics.js');
    installE2eeDiagnostics(false);
    expect(window.__hushE2eeStats).toBeUndefined();
  });

  it('attaches counters/epoch/index only when the flag is on', async () => {
    const { installE2eeDiagnostics, recordKeyEpoch, recordDecryptFailure } =
      await import('./e2eeDiagnostics.js');
    installE2eeDiagnostics(true);
    expect(window.__hushE2eeStats).toEqual({
      decryptFailures: 0,
      mediaKeyEpoch: -1,
      keyIndex: -1,
      lastError: null,
    });

    recordKeyEpoch(5);
    expect(window.__hushE2eeStats.mediaKeyEpoch).toBe(5);
    expect(window.__hushE2eeStats.keyIndex).toBe(5 % 256);

    recordDecryptFailure('InvalidKey');
    expect(window.__hushE2eeStats.decryptFailures).toBe(1);
    expect(window.__hushE2eeStats.lastError).toBe('InvalidKey');
  });

  it('never exposes a key field', async () => {
    const { installE2eeDiagnostics, recordKeyEpoch } = await import('./e2eeDiagnostics.js');
    installE2eeDiagnostics(true);
    recordKeyEpoch(3);
    const keys = Object.keys(window.__hushE2eeStats);
    expect(keys.sort()).toEqual(['decryptFailures', 'keyIndex', 'lastError', 'mediaKeyEpoch']);
  });
});
