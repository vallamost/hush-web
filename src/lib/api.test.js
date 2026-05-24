/**
 * Tests for api.js client functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkUsernameAvailable,
  certifyNewDevice,
  consumeDeviceLinkResult,
  createDeviceLinkRequest,
  federatedVerify,
  fetchWithAuth,
  getChannelMessages,
  leaveGuild,
  listDeviceKeys,
  getHandshake,
  normalizeAudience,
  registerWithPublicKey,
  requestChallenge,
  requestGuestSession,
  resolveDeviceLinkRequest,
  resolveAuthAudience,
  revokeDeviceKey,
  updateInstance,
  updateInstanceConfig,
  uploadMLSCredential,
  uploadMLSKeyPackages,
  getKeyPackageCount,
  uploadKeyPackagesAfterAuth,
  verifyChallenge,
  verifyDeviceLinkRequest,
} from './api';

// ── leaveGuild ────────────────────────────────────────────────────────────────

describe('leaveGuild', () => {
  const TOKEN = 'test-jwt';
  const SERVER_ID = 'server-uuid-123';

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.hushDesktop;
  });

  it('calls POST /api/servers/:id/leave with auth header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', mockFetch);

    await leaveGuild(TOKEN, SERVER_ID);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/servers/${SERVER_ID}/leave`);
    expect(opts.method).toBe('POST');
    expect(opts.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('throws on non-ok response with server error message', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'guild owner cannot leave' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(leaveGuild(TOKEN, SERVER_ID)).rejects.toThrow('guild owner cannot leave');
  });

  it('throws fallback message when error response has no error field', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(leaveGuild(TOKEN, SERVER_ID)).rejects.toThrow('leave guild failed: 500');
  });

  it('routes relative API calls to the active instance in desktop runtime', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', mockFetch);
    Object.defineProperty(window, 'hushDesktop', {
      configurable: true,
      value: { isDesktop: true },
    });
    localStorage.setItem('hush_auth_instance_default_origin_migrated_v1', '1');
    sessionStorage.setItem('hush_auth_instance_active', 'https://app.gethush.live');

    await leaveGuild(TOKEN, SERVER_ID);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(`https://app.gethush.live/api/servers/${SERVER_ID}/leave`);
  });
});

// ── getHandshake ──────────────────────────────────────────────────────────────

describe('getHandshake', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls GET /api/handshake without Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key_package_low_threshold: 10 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await getHandshake();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/handshake');
    // getHandshake passes a timeout signal but no Authorization header
    expect(opts).toEqual({ signal: expect.any(AbortSignal) });
  });

  it('returns parsed JSON from the handshake endpoint', async () => {
    const payload = {
      server_version: '1.0.0',
      api_version: 'v1',
      min_client_version: '0.9.0',
      key_package_low_threshold: 10,
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await getHandshake();

    expect(result).toEqual(payload);
    expect(result.key_package_low_threshold).toBe(10);
  });

  it('normalizes camelCase registrationMode for existing consumers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        registrationMode: 'closed',
        capabilities: {
          'e2ee.chat': true,
          'e2ee.media': true,
        },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await getHandshake('https://chat.example.com');

    expect(result.registrationMode).toBe('closed');
    expect(result.registration_mode).toBe('closed');
    expect(result.capabilities).toEqual({
      'e2ee.chat': true,
      'e2ee.media': true,
    });
  });

  it('normalizes camelCase screenShareResolutionCap for existing consumers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        screenShareResolutionCap: '720p',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await getHandshake('https://chat.example.com');

    expect(result.screenShareResolutionCap).toBe('720p');
    expect(result.screen_share_resolution_cap).toBe('720p');
  });

  it('normalizes camelCase maxAttachmentBytes for existing consumers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        maxAttachmentBytes: 1048576,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await getHandshake('https://chat.example.com');

    expect(result.maxAttachmentBytes).toBe(1048576);
    expect(result.max_attachment_bytes).toBe(1048576);
  });

  it('throws when handshake endpoint returns non-ok status', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', mockFetch);

    await expect(getHandshake()).rejects.toThrow('handshake failed: 503');
  });

  it('logs and enriches network failures for handshake requests', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));

    await expect(getHandshake('https://chat.example.com')).rejects.toThrow(
      'handshake failed. Could not reach https://chat.example.com/api/handshake.',
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[api] handshake failed',
      expect.objectContaining({
        url: 'https://chat.example.com/api/handshake',
      }),
    );
  });
});

// ── checkUsernameAvailable ───────────────────────────────────────────────────

describe('checkUsernameAvailable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when the username is available', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ available: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      checkUsernameAvailable('alice', 'https://chat.example.com'),
    ).resolves.toBe(true);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://chat.example.com/api/auth/check-username/alice',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('aborts when the caller signal is cancelled', async () => {
    const controller = new AbortController();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockFetch = vi.fn().mockImplementation((_url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', mockFetch);

    const pending = checkUsernameAvailable('alice', 'https://chat.example.com', controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow(
      'check username availability failed for https://chat.example.com/api/auth/check-username/alice',
    );
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });
});

// ── MLS API functions ─────────────────────────────────────────────────────────

describe('uploadMLSCredential', () => {
  const TOKEN = 'jwt-token';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls POST /api/mls/credentials with correct body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', mockFetch);

    const body = {
      deviceId: 'dev-1',
      credentialBytes: [1, 2, 3],
      signingPublicKey: [4, 5, 6],
    };
    await uploadMLSCredential(TOKEN, body);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/mls/credentials');
    expect(opts.method).toBe('POST');
    expect(opts.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    // Server requires the current MLS ciphersuite on every write; the API
    // wrapper injects it from the shared constant.
    expect(JSON.parse(opts.body)).toEqual({ ...body, ciphersuite: 77 });
  });

  it('does not let callers override the current ciphersuite', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', mockFetch);

    await uploadMLSCredential(TOKEN, {
      deviceId: 'dev-1',
      credentialBytes: [1, 2, 3],
      signingPublicKey: [4, 5, 6],
      ciphersuite: 1,
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body).ciphersuite).toBe(77);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'bad request' }),
    }));

    await expect(uploadMLSCredential(TOKEN, {})).rejects.toThrow('bad request');
  });
});

describe('uploadMLSKeyPackages', () => {
  const TOKEN = 'jwt-token';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls POST /api/mls/key-packages with correct body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', mockFetch);

    const body = {
      deviceId: 'dev-1',
      keyPackages: [[1, 2, 3], [4, 5, 6]],
      expiresAt: '2026-04-17T00:00:00Z',
    };
    await uploadMLSKeyPackages(TOKEN, body);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/mls/key-packages');
    expect(opts.method).toBe('POST');
    expect(opts.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(opts.body)).toEqual({ ...body, ciphersuite: 77 });
  });

  it('does not let callers override the current ciphersuite', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', mockFetch);

    await uploadMLSKeyPackages(TOKEN, {
      deviceId: 'dev-1',
      keyPackages: [[1, 2, 3]],
      expiresAt: '2026-04-17T00:00:00Z',
      ciphersuite: 1,
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body).ciphersuite).toBe(77);
  });

  it('sends lastResort: true when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', mockFetch);

    const body = { deviceId: 'dev-1', keyPackages: [[1]], lastResort: true };
    await uploadMLSKeyPackages(TOKEN, body);

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body).lastResort).toBe(true);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    }));

    await expect(uploadMLSKeyPackages(TOKEN, {})).rejects.toThrow();
  });
});

describe('getKeyPackageCount', () => {
  const TOKEN = 'jwt-token';
  const DEVICE_ID = 'dev-1';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls GET /api/mls/key-packages/count with deviceId query param', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ count: 42 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const count = await getKeyPackageCount(TOKEN, DEVICE_ID);

    expect(count).toBe(42);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/mls/key-packages/count');
    expect(url).toContain(`deviceId=${encodeURIComponent(DEVICE_ID)}`);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'unauthorized' }),
    }));

    await expect(getKeyPackageCount(TOKEN, DEVICE_ID)).rejects.toThrow();
  });
});

describe('uploadKeyPackagesAfterAuth (api.js wrapper)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('delegates to uploadKeyPackagesAfterAuthImpl with injected deps', async () => {
    // Inject all deps so no real WASM or IndexedDB is touched.
    const TOKEN = 'tok';
    const userId = 'u1';
    const deviceId = 'd1';

    const mockCred = {
      signingPublicKey: new Uint8Array(32).fill(1),
      signingPrivateKey: new Uint8Array(64).fill(2),
      credentialBytes: new Uint8Array(64).fill(3),
    };
    const mockKP = {
      keyPackageBytes: new Uint8Array([1]),
      privateKeyBytes: new Uint8Array(64).fill(4),
      hashRefBytes: new Uint8Array(32).fill(5),
    };

    const mockMlsStore = {
      openStore: vi.fn().mockResolvedValue({}),
      getCredential: vi.fn().mockResolvedValue(null),
      setCredential: vi.fn().mockResolvedValue(undefined),
      setKeyPackage: vi.fn().mockResolvedValue(undefined),
      setLastResort: vi.fn().mockResolvedValue(undefined),
    };
    const mockCrypto = {
      init: vi.fn().mockResolvedValue(undefined),
      generateCredential: vi.fn().mockResolvedValue(mockCred),
      generateKeyPackage: vi.fn().mockResolvedValue(mockKP),
    };

    await uploadKeyPackagesAfterAuth(TOKEN, userId, deviceId, {
      mlsStore: mockMlsStore,
      crypto: mockCrypto,
      uploadCredential: vi.fn().mockResolvedValue(undefined),
      uploadKeyPackages: vi.fn().mockResolvedValue(undefined),
    });

    expect(mockMlsStore.openStore).toHaveBeenCalledWith(userId, deviceId);
    expect(mockCrypto.generateCredential).toHaveBeenCalled();
  });

  it('uploads MLS bootstrap material to the selected auth instance by default', async () => {
    localStorage.setItem('hush_auth_instance_selected', 'https://chat.example.com');

    const TOKEN = 'tok';
    const userId = 'u1';
    const deviceId = 'd1';

    const mockCred = {
      signingPublicKey: new Uint8Array(32).fill(1),
      signingPrivateKey: new Uint8Array(64).fill(2),
      credentialBytes: new Uint8Array(64).fill(3),
    };
    const mockKP = {
      keyPackageBytes: new Uint8Array([1]),
      privateKeyBytes: new Uint8Array(64).fill(4),
      hashRefBytes: new Uint8Array(32).fill(5),
    };

    const mockMlsStore = {
      openStore: vi.fn().mockResolvedValue({}),
      getCredential: vi.fn().mockResolvedValue(null),
      setCredential: vi.fn().mockResolvedValue(undefined),
      setKeyPackage: vi.fn().mockResolvedValue(undefined),
      setLastResort: vi.fn().mockResolvedValue(undefined),
    };
    const mockCrypto = {
      init: vi.fn().mockResolvedValue(undefined),
      generateCredential: vi.fn().mockResolvedValue(mockCred),
      generateKeyPackage: vi.fn().mockResolvedValue(mockKP),
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    await uploadKeyPackagesAfterAuth(TOKEN, userId, deviceId, {
      mlsStore: mockMlsStore,
      crypto: mockCrypto,
    });

    // The first fetch is the pre-flight handshake call. uploadKeyPackagesAfterAuth
    // verifies the server's advertised MLS ciphersuite matches the client constant
    // before generating any MLS material; this call is part of the public
    // contract because failing closed here is what stops a legacy client from
    // poisoning current-suite tables.
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://chat.example.com/api/handshake',
      expect.anything(),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://chat.example.com/api/mls/credentials',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      'https://chat.example.com/api/mls/key-packages',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      4,
      'https://chat.example.com/api/mls/key-packages',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });
});

describe('registerWithPublicKey', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds a human-readable device label to the registration body', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'jwt', user: { id: 'u1' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await registerWithPublicKey('alice', 'Alice', 'pub-key', 'device-1');

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toMatchObject({
      deviceId: 'device-1',
      label: 'Chrome on macOS',
    });
  });
});

describe('createDeviceLinkRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds a human-readable device label when the caller does not provide one', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ requestId: 'req-1', secret: 'sec-1', code: 'ABCD1234', expiresAt: '2026-03-29T00:05:00Z' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await createDeviceLinkRequest({
      devicePublicKey: 'pub',
      sessionPublicKey: 'session',
      deviceId: 'device-1',
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toMatchObject({
      deviceId: 'device-1',
      label: 'Safari on iPhone',
    });
  });
});

describe('auth instance routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('uses the selected auth instance for challenge requests when no baseUrl is passed', async () => {
    localStorage.setItem('hush_auth_instance_selected', 'https://chat.example.com');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ nonce: 'abc123' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await requestChallenge('public-key');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://chat.example.com/api/auth/challenge',
      expect.any(Object),
    );
  });

  it('routes auth-only fetches to the active auth instance', async () => {
    sessionStorage.setItem('hush_auth_instance_active', 'https://alpha.example.com');

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    vi.stubGlobal('fetch', mockFetch);

    await fetchWithAuth('jwt-token', '/api/auth/devices');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://alpha.example.com/api/auth/devices',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it('routes pre-auth requests to the selected auth instance even when another instance is active', async () => {
    localStorage.setItem('hush_auth_instance_selected', 'https://chat.example.com');
    sessionStorage.setItem('hush_auth_instance_active', 'https://alpha.example.com');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ nonce: 'abc123' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await requestChallenge('public-key');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://chat.example.com/api/auth/challenge',
      expect.any(Object),
    );
  });

  it('requestChallenge honors an explicit baseUrl over the selected instance', async () => {
    // Regression for the original PR #39 over-correction: that diff
    // collapsed baseUrl to same-origin and broke selected-instance
    // sign-in. The explicit baseUrl must always win.
    localStorage.setItem('hush_auth_instance_selected', 'https://selected.example.com');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ nonce: 'abc123' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await requestChallenge('public-key', 'https://chat.example.com');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://chat.example.com/api/auth/challenge',
      expect.any(Object),
    );
  });

  it('verifyChallenge honors an explicit baseUrl and sends the v2 audience + challengeVersion', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'jwt', user: { id: 'u1' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await verifyChallenge(
      'pk',
      'deadbeef',
      'sigb64',
      'dev-1',
      'https://chat.example.com',
      'https://chat.example.com',
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://chat.example.com/api/auth/verify');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      publicKey: 'pk',
      nonce: 'deadbeef',
      signature: 'sigb64',
      deviceId: 'dev-1',
      label: 'Chrome on macOS',
      audience: 'https://chat.example.com',
      challengeVersion: 2,
    });
  });

  it('verifyChallenge omits v2 fields when no audience is provided (legacy path)', async () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'jwt', user: { id: 'u1' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await verifyChallenge('pk', 'deadbeef', 'sigb64', 'dev-1', 'https://chat.example.com');

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.label).toBe('Chrome on macOS');
    expect(body.audience).toBeUndefined();
    expect(body.challengeVersion).toBeUndefined();
  });

  it('verifyChallenge rejects malformed success responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: '', user: {} }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      verifyChallenge('pk', 'deadbeef', 'sigb64', 'dev-1', 'https://chat.example.com'),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('runtime response schemas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checkUsernameAvailable rejects HTML success responses at the API boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      checkUsernameAvailable('alice', 'https://chat.example.com'),
    ).rejects.toMatchObject({
      code: 'invalid_json_response',
      operation: 'checkUsernameAvailable',
    });
  });

  it('requestChallenge rejects malformed success responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ nonce: '' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(requestChallenge('public-key')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('requestChallenge rejects HTML success responses at the API boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(requestChallenge('public-key')).rejects.toMatchObject({
      code: 'invalid_json_response',
      operation: 'requestChallenge',
    });
  });

  it('requestChallenge attaches status to HTTP errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'challenge disabled' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(requestChallenge('public-key')).rejects.toMatchObject({
      message: 'challenge disabled',
      status: 429,
    });
  });

  it('verifyChallenge rejects HTML success responses at the API boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      verifyChallenge('pk', 'deadbeef', 'sigb64', 'dev-1', 'https://chat.example.com'),
    ).rejects.toMatchObject({
      code: 'invalid_json_response',
      operation: 'verifyChallenge',
    });
  });

  it('verifyChallenge attaches status to HTTP errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'challenge expired' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      verifyChallenge('pk', 'deadbeef', 'sigb64', 'dev-1', 'https://chat.example.com'),
    ).rejects.toMatchObject({
      message: 'challenge expired',
      status: 401,
    });
  });

  it('registerWithPublicKey rejects HTML success responses at the API boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      registerWithPublicKey('alice', 'Alice', 'pub-key', 'device-1'),
    ).rejects.toMatchObject({
      code: 'invalid_json_response',
      operation: 'registerWithPublicKey',
    });
  });

  it('registerWithPublicKey attaches status to HTTP errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'username taken' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      registerWithPublicKey('alice', 'Alice', 'pub-key', 'device-1'),
    ).rejects.toMatchObject({
      message: 'username taken',
      status: 409,
    });
  });

  it('requestGuestSession rejects malformed success responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'guest-jwt' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(requestGuestSession()).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('requestGuestSession attaches status to HTTP errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'guest disabled' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(requestGuestSession()).rejects.toMatchObject({
      message: 'guest disabled',
      status: 403,
    });
  });

  it('federatedVerify rejects malformed success responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'jwt', federatedIdentity: null }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      federatedVerify('pk', 'nonce', 'sig', 'https://home.example.com', 'alice', 'Alice'),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('federatedVerify attaches status to HTTP errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'federation disabled' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      federatedVerify('pk', 'nonce', 'sig', 'https://home.example.com', 'alice', 'Alice'),
    ).rejects.toMatchObject({
      message: 'federation disabled',
      status: 403,
    });
  });

  it('certifyNewDevice preserves structured error messages', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'certificate rejected' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      certifyNewDevice('jwt', 'new-pub', 'cert', 'device-new', 'device-old'),
    ).rejects.toMatchObject({
      message: 'certificate rejected',
      status: 400,
    });
  });

  it('certifyNewDevice keeps HTTP status as source of truth for HTML error responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>bad gateway</title>', {
        status: 502,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      certifyNewDevice('jwt', 'new-pub', 'cert', 'device-new', 'device-old'),
    ).rejects.toMatchObject({
      message: 'certifyNewDevice 502',
      status: 502,
    });
  });

  it('listDeviceKeys rejects non-array success responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ devices: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(listDeviceKeys('jwt')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('listDeviceKeys rejects HTML success responses at the API boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(listDeviceKeys('jwt')).rejects.toMatchObject({
      code: 'invalid_json_response',
      operation: 'listDeviceKeys',
    });
  });

  it('listDeviceKeys keeps HTTP status as source of truth for HTML error responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>bad gateway</title>', {
        status: 502,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(listDeviceKeys('jwt')).rejects.toMatchObject({
      message: 'listDeviceKeys 502',
      status: 502,
    });
  });

  it('listDeviceKeys preserves structured error messages', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'devices forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(listDeviceKeys('jwt')).rejects.toMatchObject({
      message: 'devices forbidden',
      status: 403,
    });
  });

  it('revokeDeviceKey preserves structured error messages', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'device already revoked' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(revokeDeviceKey('jwt', 'device-1')).rejects.toMatchObject({
      message: 'device already revoked',
      status: 409,
    });
  });

  it('revokeDeviceKey keeps HTTP status as source of truth for HTML error responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>bad gateway</title>', {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(revokeDeviceKey('jwt', 'device-1')).rejects.toMatchObject({
      message: 'revokeDeviceKey 503',
      status: 503,
    });
  });

  it('updateInstance accepts empty success responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      updateInstance('jwt', { name: 'Hush' }, 'https://chat.example.com'),
    ).resolves.toBeUndefined();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://chat.example.com/api/instance');
    expect(opts.method).toBe('PUT');
    expect(opts.headers.get('Authorization')).toBe('Bearer jwt');
    expect(JSON.parse(opts.body)).toEqual({ name: 'Hush' });
  });

  it('updateInstance rejects HTML success responses at the API boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(updateInstance('jwt', { name: 'Hush' })).rejects.toMatchObject({
      code: 'invalid_json_response',
      operation: 'updateInstance',
    });
  });

  it('updateInstance preserves structured error messages', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'owner only' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(updateInstance('jwt', { name: 'Hush' })).rejects.toMatchObject({
      message: 'owner only',
      status: 403,
    });
  });

  it('updateInstance keeps HTTP status as source of truth for HTML error responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>bad gateway</title>', {
        status: 502,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(updateInstance('jwt', { name: 'Hush' })).rejects.toMatchObject({
      message: 'update instance 502',
      status: 502,
    });
  });

  it('updateInstanceConfig accepts empty success responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      updateInstanceConfig('jwt', { maxAttachmentBytes: 1048576 }),
    ).resolves.toBeUndefined();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/instance');
    expect(opts.method).toBe('PUT');
    expect(opts.headers.get('Authorization')).toBe('Bearer jwt');
    expect(JSON.parse(opts.body)).toEqual({ maxAttachmentBytes: 1048576 });
  });

  it('updateInstanceConfig rejects HTML success responses at the API boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      updateInstanceConfig('jwt', { maxAttachmentBytes: 1048576 }),
    ).rejects.toMatchObject({
      code: 'invalid_json_response',
      operation: 'updateInstanceConfig',
    });
  });

  it('updateInstanceConfig preserves structured error messages', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'config locked' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      updateInstanceConfig('jwt', { maxAttachmentBytes: 1048576 }),
    ).rejects.toMatchObject({
      message: 'config locked',
      status: 409,
    });
  });

  it('updateInstanceConfig keeps HTTP status as source of truth for HTML error responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>bad gateway</title>', {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      updateInstanceConfig('jwt', { maxAttachmentBytes: 1048576 }),
    ).rejects.toMatchObject({
      message: 'Config update failed',
      status: 503,
    });
  });

  it('createDeviceLinkRequest rejects malformed success responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ requestId: 'req-1' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      createDeviceLinkRequest({
        devicePublicKey: 'pub',
        sessionPublicKey: 'session',
        deviceId: 'device-1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('schema-failure rejections emit a redacted invalid-response-schema diagnostic', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          requestId: 'req-1',
          // missing required `secret`, `code`, `expiresAt`. Server contract
          // requires all three. Diagnostic must capture the field paths
          // without echoing the raw payload.
        }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const listener = vi.fn();
    globalThis.addEventListener('hush:diagnostic', listener);

    try {
      await expect(
        createDeviceLinkRequest({
          devicePublicKey: 'pub',
          sessionPublicKey: 'session',
          deviceId: 'device-1',
        }),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      expect(listener).toHaveBeenCalled();
      const detail = listener.mock.calls[0][0].detail;
      expect(detail).toMatchObject({
        category: 'api',
        event: 'invalid-response-schema',
        severity: 'error',
        details: {
          operation: 'createDeviceLinkRequest',
        },
      });
      expect(Array.isArray(detail.details.issues)).toBe(true);
      expect(detail.details.issues.length).toBeGreaterThan(0);
      detail.details.issues.forEach((issue) => {
        expect(typeof issue.path).toBe('string');
        expect(typeof issue.code).toBe('string');
      });
      // No raw payload in the diagnostic.
      expect(detail.details).not.toHaveProperty('payload');
      expect(detail.details).not.toHaveProperty('data');
      expect(detail.details).not.toHaveProperty('body');
    } finally {
      globalThis.removeEventListener('hush:diagnostic', listener);
    }
  });

  it('schema-failure diagnostic does not echo the raw response payload', async () => {
    // Sensitive content reaches the parser via the body bytes, not via
    // issue paths/codes. The diagnostic must surface only field paths
    // and Zod codes — never the raw payload, the original body string,
    // or sibling fields the server happened to send.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            relayCiphertext: 'CIPHER-LEAK-CHECK',
            relayPublicKey: 'PUBKEY-LEAK-CHECK',
            // missing relayIv + deviceId so schema fails on ready branch
          }),
      }),
    );

    const listener = vi.fn();
    globalThis.addEventListener('hush:diagnostic', listener);

    try {
      await expect(
        consumeDeviceLinkResult({ requestId: 'r', secret: 's' }),
      ).rejects.toMatchObject({ code: 'invalid_response' });

      const diag = listener.mock.calls
        .map((c) => c[0].detail)
        .find((d) => d.event === 'invalid-response-schema');
      expect(diag).toBeTruthy();

      const serialized = JSON.stringify(diag);
      expect(serialized).not.toContain('CIPHER-LEAK-CHECK');
      expect(serialized).not.toContain('PUBKEY-LEAK-CHECK');
    } finally {
      globalThis.removeEventListener('hush:diagnostic', listener);
    }
  });

  it('createDeviceLinkRequest rejects HTML success responses at the API boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      createDeviceLinkRequest({
        devicePublicKey: 'pub',
        sessionPublicKey: 'session',
        deviceId: 'device-1',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_json_response',
      operation: 'createDeviceLinkRequest',
    });
  });

  it('resolveDeviceLinkRequest accepts the server claim contract', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        claimToken: 'claim-1',
        requestId: 'req-1',
        deviceId: 'device-1',
        devicePublicKey: 'device-pub',
        sessionPublicKey: 'session-pub',
        label: 'Chrome on macOS',
        instanceUrl: 'https://app.example.com',
        expiresAt: '2026-05-19T12:00:00Z',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await resolveDeviceLinkRequest('jwt', { code: 'ABCD1234' });

    expect(result).toMatchObject({
      claimToken: 'claim-1',
      requestId: 'req-1',
      deviceId: 'device-1',
      devicePublicKey: 'device-pub',
      sessionPublicKey: 'session-pub',
      expiresAt: '2026-05-19T12:00:00Z',
    });
  });

  it('resolveDeviceLinkRequest rejects HTML success responses at the API boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>not found</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      resolveDeviceLinkRequest('jwt', { code: 'ABCD1234' }),
    ).rejects.toMatchObject({
      code: 'invalid_json_response',
      operation: 'resolveDeviceLinkRequest',
    });
  });

  it('verifyDeviceLinkRequest accepts the server 201 empty success contract', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('', { status: 201 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      verifyDeviceLinkRequest('jwt', {
        claimToken: 'claim-1',
        certificate: 'cert',
        signingDeviceId: 'device-old',
        relayCiphertext: 'cipher',
        relayIv: 'iv',
        relayPublicKey: 'relay-pub',
      }),
    ).resolves.toBeUndefined();
  });

  it('verifyDeviceLinkRequest rejects HTML success responses at the API boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('<!DOCTYPE html><title>not found</title>', {
        status: 201,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      verifyDeviceLinkRequest('jwt', {
        claimToken: 'claim-1',
        certificate: 'cert',
        signingDeviceId: 'device-old',
        relayCiphertext: 'cipher',
        relayIv: 'iv',
        relayPublicKey: 'relay-pub',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_json_response',
      operation: 'verifyDeviceLinkRequest',
    });
  });

  it('consumeDeviceLinkResult rejects malformed ready responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ relayCiphertext: 'cipher' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      consumeDeviceLinkResult({ requestId: 'req-1', secret: 'sec-1' }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('consumeDeviceLinkResult rejects unexpected fields in ready responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        relayCiphertext: 'cipher',
        relayIv: 'iv',
        relayPublicKey: 'relay-pub',
        deviceId: 'device-1',
        extra: 'unexpected',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      consumeDeviceLinkResult({ requestId: 'req-1', secret: 'sec-1' }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('normalizeAudience', () => {
  it.each([
    ['https://Home.Example.com', 'https://home.example.com'],
    ['https://home.example.com/', 'https://home.example.com'],
    ['https://home.example.com/path?q=1#frag', 'https://home.example.com'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['https://home.example.com:443', 'https://home.example.com'],
    ['http://home.example.com:80', 'http://home.example.com'],
    ['  https://home.example.com  ', 'https://home.example.com'],
    ['', ''],
    ['app://localhost', ''],
    ['not-a-url', ''],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeAudience(input)).toBe(expected);
  });
});

describe('resolveAuthAudience', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('uses the explicit baseUrl when provided', () => {
    expect(resolveAuthAudience('https://chat.example.com/'))
      .toBe('https://chat.example.com');
  });

  it('falls back to the selected auth instance when baseUrl is empty', () => {
    localStorage.setItem('hush_auth_instance_selected', 'https://selected.example.com');
    expect(resolveAuthAudience('')).toBe('https://selected.example.com');
  });
});

// getChannelMessages

describe('getChannelMessages', () => {
  const TOKEN = 'jwt-token';
  const SERVER_ID = 'srv-1';
  const CHANNEL_ID = 'ch-1';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes after query param when opts.after is provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal('fetch', mockFetch);

    await getChannelMessages(TOKEN, SERVER_ID, CHANNEL_ID, {
      after: '2026-04-01T12:00:00.000Z',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('after=2026-04-01T12%3A00%3A00.000Z');
  });

  it('includes before query param when opts.before is provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal('fetch', mockFetch);

    await getChannelMessages(TOKEN, SERVER_ID, CHANNEL_ID, {
      before: '2026-04-01T12:00:00.000Z',
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('before=2026-04-01T12%3A00%3A00.000Z');
  });

  it('omits before and after when not provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal('fetch', mockFetch);

    await getChannelMessages(TOKEN, SERVER_ID, CHANNEL_ID, { limit: 50 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain('before=');
    expect(url).not.toContain('after=');
  });
});

// ── Slice-13 device-revoke fix: 401 'device revoked' fires window event
describe('fetchWithAuth — device revocation surface', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('dispatches hush_auth_invalid on a 401 response whose body is "device revoked"', async () => {
    const body = { error: 'device revoked' };
    const mockFetch = vi.fn().mockResolvedValue({
      status: 401, ok: false,
      clone() { return this; },
      json: () => Promise.resolve(body),
    });
    vi.stubGlobal('fetch', mockFetch);

    const events = [];
    const handler = (e) => events.push(e?.detail?.reason || null);
    window.addEventListener('hush_auth_invalid', handler);

    const res = await fetchWithAuth('jwt', '/api/auth/me');
    expect(res.status).toBe(401);
    expect(events).toContain('device_revoked');

    window.removeEventListener('hush_auth_invalid', handler);
  });

  it('does not dispatch hush_auth_invalid on a generic 401 (e.g. expired session)', async () => {
    const body = { error: 'session not found or expired' };
    const mockFetch = vi.fn().mockResolvedValue({
      status: 401, ok: false,
      clone() { return this; },
      json: () => Promise.resolve(body),
    });
    vi.stubGlobal('fetch', mockFetch);

    const events = [];
    const handler = (e) => events.push(e?.detail?.reason || null);
    window.addEventListener('hush_auth_invalid', handler);

    await fetchWithAuth('jwt', '/api/auth/me');
    expect(events).toEqual([]);

    window.removeEventListener('hush_auth_invalid', handler);
  });
});
