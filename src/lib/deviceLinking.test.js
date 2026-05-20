import { describe, it, expect } from 'vitest';
import {
  buildLinkApprovalUrl,
  certifyDevice,
  createDeviceIdentity,
  createSessionKeyPair,
  decodeQRPayload,
  decodeTransferBundle,
  decryptRelayPayload,
  encodeQRPayload,
  encodeTransferBundle,
  encryptRelayPayload,
  generateLinkingCode,
  verifyCertificate,
  claimMatchesPayloadKeys,
} from './deviceLinking.js';

function bytesToTestBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function buildRawTransferBundle(identity, overrides = {}) {
  return new TextEncoder().encode(JSON.stringify({
    v: 3,
    userId: 'user-1',
    rootPrivateKey: bytesToTestBase64(identity.privateKey),
    rootPublicKey: bytesToTestBase64(identity.publicKey),
    archive: null,
    ...overrides,
  }));
}

function collectDiagnostics() {
  const events = [];
  const handler = (event) => events.push(event.detail);
  globalThis.addEventListener('hush:diagnostic', handler);
  return {
    events,
    stop: () => globalThis.removeEventListener('hush:diagnostic', handler),
  };
}

describe('device certificates', () => {
  it('creates and verifies a valid certificate', async () => {
    const existing = await createDeviceIdentity();
    const linked = await createDeviceIdentity();

    const certificate = await certifyDevice(linked.publicKey, existing.privateKey);

    expect(certificate).toBeInstanceOf(Uint8Array);
    expect(certificate).toHaveLength(64);
    await expect(
      verifyCertificate(linked.publicKey, certificate, existing.publicKey),
    ).resolves.toBe(true);
  });

  it('rejects a certificate signed by the wrong device', async () => {
    const signer = await createDeviceIdentity();
    const impostor = await createDeviceIdentity();
    const linked = await createDeviceIdentity();

    const certificate = await certifyDevice(linked.publicKey, signer.privateKey);

    await expect(
      verifyCertificate(linked.publicKey, certificate, impostor.publicKey),
    ).resolves.toBe(false);
  });
});

describe('QR payload helpers', () => {
  it('round-trips requestId, secret, and expiresAt (legacy payload — committed key fields default to null)', () => {
    const original = {
      requestId: 'request-1',
      secret: 'secret-1',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };

    const encoded = encodeQRPayload(original);
    const decoded = decodeQRPayload(encoded);

    // Legacy payload — no committed key material, both fields null.
    expect(decoded).toEqual({
      ...original,
      devicePublicKey: null,
      sessionPublicKey: null,
    });
  });

  it('round-trips devicePublicKey and sessionPublicKey commitments', async () => {
    const deviceIdentity = await createDeviceIdentity();
    const session = await createSessionKeyPair();
    const original = {
      requestId: 'request-2',
      secret: 'secret-2',
      expiresAt: '2026-05-16T00:00:00Z',
      devicePublicKey: deviceIdentity.publicKeyBase64,
      sessionPublicKey: session.publicKeyBase64,
    };

    const encoded = encodeQRPayload(original);
    const decoded = decodeQRPayload(encoded);

    expect(decoded).toEqual(original);
  });

  it('encodes a small payload when commitment fields are omitted (QR-safe length)', () => {
    const legacy = encodeQRPayload({
      requestId: 'r',
      secret: 's',
      expiresAt: '2026-01-01T00:00:00Z',
    });
    // Empty optional fields must NOT add `d:""` / `k:""` to the JSON.
    const decoded = atob(legacy);
    expect(decoded).not.toContain('"d"');
    expect(decoded).not.toContain('"k"');
  });

  it('builds an approval URL on the link-device route', () => {
    const url = buildLinkApprovalUrl('https://app.gethush.live', {
      requestId: 'request-1',
      secret: 'secret-1',
      expiresAt: '2026-03-29T00:00:00Z',
    });

    expect(url).toContain('https://app.gethush.live/link-device?payload=');
  });

  it('throws a descriptive error for truncated base64 QR payloads', () => {
    // Truncate valid base64 to produce malformed JSON after decode
    const valid = encodeQRPayload({ requestId: 'r', secret: 's', expiresAt: '2026-01-01T00:00:00Z' });
    const truncated = valid.slice(0, Math.floor(valid.length / 2));
    expect(() => decodeQRPayload(truncated)).toThrow();
  });

  it('throws for an empty QR payload string', () => {
    expect(() => decodeQRPayload('')).toThrow();
  });

  it('rejects QR payloads with partial key commitments', () => {
    const encoded = btoa(JSON.stringify({
      r: 'request-1',
      s: 'secret-1',
      e: '2026-05-19T00:00:00Z',
      d: 'device-pub',
    }));

    expect(() => decodeQRPayload(encoded)).toThrow(/invalid shape/i);
    try {
      decodeQRPayload(encoded);
    } catch (err) {
      expect(err).toMatchObject({ code: 'invalid_device_link_payload' });
    }
  });

  it('rejects QR payloads with unexpected fields', () => {
    const encoded = btoa(JSON.stringify({
      r: 'request-1',
      s: 'secret-1',
      e: '2026-05-19T00:00:00Z',
      x: 'unexpected',
    }));

    expect(() => decodeQRPayload(encoded)).toThrow(/invalid shape/i);
  });

  it('rejects QR payload key commitments with invalid key sizes', () => {
    const encoded = btoa(JSON.stringify({
      r: 'request-1',
      s: 'secret-1',
      e: '2026-05-19T00:00:00Z',
      d: btoa('short'),
      k: btoa('also-short'),
    }));

    expect(() => decodeQRPayload(encoded)).toThrow(/devicePublicKey has/i);
  });

  it('emits a structured diagnostic for invalid QR payloads', () => {
    const diagnostics = collectDiagnostics();
    try {
      expect(() => decodeQRPayload('')).toThrow();
      expect(diagnostics.events).toContainEqual(expect.objectContaining({
        category: 'device-link',
        event: 'invalid-qr',
        severity: 'error',
      }));
    } finally {
      diagnostics.stop();
    }
  });
});

describe('blind relay encryption', () => {
  it('decrypts a relay envelope with the matching session private key', async () => {
    const receiver = await createSessionKeyPair();
    const plaintext = new TextEncoder().encode('linked-device-transfer');

    const envelope = await encryptRelayPayload(plaintext, receiver.publicKeyBase64);
    const decrypted = await decryptRelayPayload(envelope, receiver.privateKey);

    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });
});

describe('transfer bundle serialisation', () => {
  it('round-trips root keys and the archive descriptor', async () => {
    const identity = await createDeviceIdentity();
    const archive = {
      id: 'arch-1',
      downloadToken: 'dtok',
      totalChunks: 2,
      totalBytes: 8200,
      chunkSize: 4096,
      manifestHash: 'bWFuaWZlc3RoYXNo',
      archiveSha256: 'YXJjaGl2ZXNoYTI1Ng==',
      ephPub: 'ZXBocHViYnl0ZXM=',
      nonceBase: 'bm9uY2ViYXNl',
      format: 'chunk-atomic-v1',
      chunkPlaintextHashes: ['Y2h1bmstaGFzaC0x', 'Y2h1bmstaGFzaC0y'],
      transcriptBlobOmitted: false,
    };
    const bytes = await encodeTransferBundle({
      userId: 'user-1',
      username: 'alice',
      displayName: 'Alice',
      instanceUrl: 'https://app.gethush.live',
      rootPrivateKey: identity.privateKey,
      rootPublicKey: identity.publicKey,
      archive,
    });

    const decoded = await decodeTransferBundle(bytes);

    expect(decoded.userId).toBe('user-1');
    expect(decoded.username).toBe('alice');
    expect(decoded.displayName).toBe('Alice');
    expect(decoded.instanceUrl).toBe('https://app.gethush.live');
    expect(decoded.rootPrivateKey).toEqual(identity.privateKey);
    expect(decoded.rootPublicKey).toEqual(identity.publicKey);
    expect(decoded.archive).toEqual(archive);
    // v3 small bundle no longer carries inline snapshots.
    expect(decoded.historySnapshot).toBeNull();
    expect(decoded.guildMetadataKeySnapshot).toBeNull();
    expect(decoded.transcriptBlob).toBeNull();
  });

  it('decodes legacy uncompressed transfer bundle bytes', async () => {
    const identity = await createDeviceIdentity();
    const legacyBytes = new TextEncoder().encode(JSON.stringify({
      v: 2,
      userId: 'user-legacy',
      username: 'alice',
      displayName: 'Alice',
      instanceUrl: 'https://app.gethush.live',
      exportedAt: '2026-04-26T00:00:00.000Z',
      rootPrivateKey: btoa(String.fromCharCode(...identity.privateKey)),
      rootPublicKey: btoa(String.fromCharCode(...identity.publicKey)),
      historySnapshot: { version: 1, stores: {} },
      guildMetadataKeySnapshot: null,
      transcriptBlob: null,
    }));

    const decoded = await decodeTransferBundle(legacyBytes);
    expect(decoded.userId).toBe('user-legacy');
    expect(decoded.rootPrivateKey).toEqual(identity.privateKey);
  });

  it('rejects transfer bundles whose root key fields have the wrong length', async () => {
    const identity = await createDeviceIdentity();
    const badBytes = buildRawTransferBundle(identity, {
      rootPrivateKey: btoa('short'),
    });

    await expect(decodeTransferBundle(badBytes)).rejects.toMatchObject({
      code: 'invalid_device_link_payload',
      message: expect.stringContaining('rootPrivateKey has'),
    });
  });

  it.each([
    ['id', ''],
    ['downloadToken', ''],
    ['totalChunks', 0],
    ['totalBytes', -1],
    ['chunkSize', 0],
    ['manifestHash', ''],
    ['archiveSha256', ''],
    ['ephPub', ''],
    ['nonceBase', ''],
    ['transcriptBlobOmitted', 'false'],
  ])('rejects transfer bundles with malformed archive descriptor field %s', async (field, value) => {
    const identity = await createDeviceIdentity();
    const archive = {
      id: 'arch-1',
      downloadToken: 'dtok',
      totalChunks: 2,
      totalBytes: 8200,
      chunkSize: 4096,
      manifestHash: 'bWFuaWZlc3RoYXNo',
      archiveSha256: 'YXJjaGl2ZXNoYTI1Ng==',
      ephPub: 'ZXBocHViYnl0ZXM=',
      nonceBase: 'bm9uY2ViYXNl',
      transcriptBlobOmitted: false,
      [field]: value,
    };
    const badBytes = buildRawTransferBundle(identity, { archive });

    await expect(decodeTransferBundle(badBytes)).rejects.toMatchObject({
      code: 'invalid_device_link_payload',
      message: expect.stringContaining('invalid shape'),
    });
  });

  it('rejects archive descriptors whose chunk hash count does not match totalChunks', async () => {
    const identity = await createDeviceIdentity();
    const archive = {
      id: 'arch-1',
      downloadToken: 'dtok',
      totalChunks: 2,
      totalBytes: 8200,
      chunkSize: 4096,
      manifestHash: 'bWFuaWZlc3RoYXNo',
      archiveSha256: 'YXJjaGl2ZXNoYTI1Ng==',
      ephPub: 'ZXBocHViYnl0ZXM=',
      nonceBase: 'bm9uY2ViYXNl',
      format: 'chunk-atomic-v1',
      chunkPlaintextHashes: ['Y2h1bmstaGFzaC0x'],
      transcriptBlobOmitted: false,
    };
    const badBytes = buildRawTransferBundle(identity, { archive });

    await expect(decodeTransferBundle(badBytes)).rejects.toMatchObject({
      code: 'invalid_device_link_payload',
      message: expect.stringContaining('invalid shape'),
    });
  });

  it('rejects transfer bundles with unexpected top-level fields', async () => {
    const identity = await createDeviceIdentity();
    const badBytes = buildRawTransferBundle(identity, {
      unexpected: 'field',
    });

    await expect(decodeTransferBundle(badBytes)).rejects.toMatchObject({
      code: 'invalid_device_link_payload',
      message: expect.stringContaining('invalid shape'),
    });
  });

  it('rejects legacy inline snapshots that are not objects', async () => {
    const identity = await createDeviceIdentity();
    const badBytes = buildRawTransferBundle(identity, {
      historySnapshot: 42,
    });

    await expect(decodeTransferBundle(badBytes)).rejects.toMatchObject({
      code: 'invalid_device_link_payload',
      message: expect.stringContaining('invalid shape'),
    });
  });

  it('rejects non-JSON transfer bundle bytes with a boundary error', async () => {
    const badBytes = new TextEncoder().encode('<!DOCTYPE html>');

    await expect(decodeTransferBundle(badBytes)).rejects.toMatchObject({
      code: 'invalid_device_link_payload',
      message: expect.stringContaining('invalid JSON'),
    });
  });

  it('emits a structured diagnostic for invalid transfer bundles', async () => {
    const diagnostics = collectDiagnostics();
    try {
      await expect(
        decodeTransferBundle(new TextEncoder().encode('<!DOCTYPE html>')),
      ).rejects.toMatchObject({ code: 'invalid_device_link_payload' });
      expect(diagnostics.events).toContainEqual(expect.objectContaining({
        category: 'device-link',
        event: 'invalid-bundle',
        severity: 'error',
      }));
    } finally {
      diagnostics.stop();
    }
  });
});

describe('linking code generation', () => {
  it('returns an 8-character uppercase alphanumeric string', () => {
    const code = generateLinkingCode();
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
  });
});

describe('claimMatchesPayloadKeys', () => {
  it('returns true when both commitment fields match the claim', () => {
    const payload = { devicePublicKey: 'd1', sessionPublicKey: 's1' };
    const claim = { devicePublicKey: 'd1', sessionPublicKey: 's1' };
    expect(claimMatchesPayloadKeys(payload, claim)).toBe(true);
  });

  it('returns false when devicePublicKey differs', () => {
    const payload = { devicePublicKey: 'd1', sessionPublicKey: 's1' };
    const claim = { devicePublicKey: 'd-evil', sessionPublicKey: 's1' };
    expect(claimMatchesPayloadKeys(payload, claim)).toBe(false);
  });

  it('returns false when sessionPublicKey differs', () => {
    const payload = { devicePublicKey: 'd1', sessionPublicKey: 's1' };
    const claim = { devicePublicKey: 'd1', sessionPublicKey: 's-evil' };
    expect(claimMatchesPayloadKeys(payload, claim)).toBe(false);
  });

  it('returns true when payload commitment fields are absent (legacy/fallback flow)', () => {
    const payload = { devicePublicKey: null, sessionPublicKey: null };
    const claim = { devicePublicKey: 'd1', sessionPublicKey: 's1' };
    expect(claimMatchesPayloadKeys(payload, claim)).toBe(true);
  });

  it('returns false for partial commitments', () => {
    // Modern QR payloads must commit both keys. A one-key payload
    // would leave the other key controlled by the resolved claim.
    expect(
      claimMatchesPayloadKeys(
        { devicePublicKey: 'd1' },
        { devicePublicKey: 'd1', sessionPublicKey: 'anything' },
      ),
    ).toBe(false);
    expect(
      claimMatchesPayloadKeys(
        { sessionPublicKey: 's1' },
        { devicePublicKey: 'anything', sessionPublicKey: 's1' },
      ),
    ).toBe(false);
  });

  it('returns false when either side is null/undefined', () => {
    expect(claimMatchesPayloadKeys(null, { devicePublicKey: 'd1' })).toBe(false);
    expect(claimMatchesPayloadKeys({ devicePublicKey: 'd1' }, null)).toBe(false);
    expect(claimMatchesPayloadKeys(undefined, undefined)).toBe(false);
  });
});
