/**
 * Device linking primitives.
 *
 * Covers:
 *   - Ed25519 device certificate signing / verification
 *   - QR payload encoding for the approval route
 *   - ECDH-based blind relay encryption for transfer bundles
 *   - Transfer bundle serialisation helpers
 */
import * as ed from '@noble/ed25519';
import { z } from 'zod';
import { gunzipBytes, gzipBytes, isGzipBytes, supportsGzipCompression } from './compression';
import { recordClientDiagnostic } from './clientDiagnostics';

const LINKING_CODE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LINKING_CODE_LENGTH = 8;
const LINK_QR_ROUTE = '/link-device';
const LINK_BUNDLE_VERSION = 3;
const ED25519_PRIVATE_KEY_BYTES = 32;
const ED25519_PUBLIC_KEY_BYTES = 32;
const P256_RAW_PUBLIC_KEY_BYTES = 65;
const LEGACY_INLINE_TRANSCRIPT_BLOB_MAX_BYTES = 32 * 1024 * 1024;

const QRPayloadSchema = z.object({
  r: z.string().min(1),
  s: z.string().min(1),
  e: z.string().min(1),
  d: z.string().min(1).optional(),
  k: z.string().min(1).optional(),
}).strict().refine(
  (payload) => Boolean(payload.d) === Boolean(payload.k),
  { message: 'QR payload must include both device and session key commitments or neither.' },
);

const LinkArchiveDescriptorSchema = z.object({
  id: z.string().min(1),
  downloadToken: z.string().min(1),
  // Archive import checkpoints require a positive total chunk count, and the
  // archive plaintext builder rejects empty archives before upload.
  totalChunks: z.number().int().positive(),
  totalBytes: z.number().int().nonnegative(),
  chunkSize: z.number().int().positive(),
  manifestHash: z.string().min(1),
  archiveSha256: z.string().min(1),
  ephPub: z.string().min(1),
  nonceBase: z.string().min(1),
  format: z.string().min(1).optional(),
  chunkPlaintextHashes: z.array(z.string().min(1)).optional(),
  transcriptBlobOmitted: z.boolean(),
}).strict().refine(
  (archive) => (
    !archive.chunkPlaintextHashes
    || archive.chunkPlaintextHashes.length === archive.totalChunks
  ),
  {
    message: 'chunkPlaintextHashes length must match totalChunks.',
    path: ['chunkPlaintextHashes'],
  },
);

const TransferBundleSchema = z.object({
  v: z.number().int().positive().optional(),
  userId: z.string().min(1),
  username: z.string().optional(),
  displayName: z.string().optional(),
  instanceUrl: z.string().optional(),
  exportedAt: z.string().optional(),
  rootPrivateKey: z.string().min(1),
  rootPublicKey: z.string().min(1),
  archive: LinkArchiveDescriptorSchema.nullish(),
  historySnapshot: z.object({}).passthrough().nullish(),
  guildMetadataKeySnapshot: z.object({}).passthrough().nullish(),
  transcriptBlob: z.string().min(1).nullish(),
}).strict();

function createDeviceLinkPayloadError(
  message,
  cause,
  { event = 'invalid-payload', field = null, issues = null } = {},
) {
  const err = new Error(message);
  err.code = 'invalid_device_link_payload';
  if (cause) err.cause = cause;
  recordClientDiagnostic({
    category: 'device-link',
    event,
    severity: 'error',
    details: {
      field,
      message,
      issues,
    },
  });
  return err;
}

function summarizeZodIssues(error) {
  return error?.issues?.slice(0, 8).map((issue) => ({
    code: issue.code,
    path: issue.path,
  })) ?? null;
}

function parseJsonPayload(text, description, event) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw createDeviceLinkPayloadError(`${description}: invalid JSON.`, err, { event });
  }
}

function parseSchemaPayload(schema, value, description, event) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw createDeviceLinkPayloadError(`${description}: invalid shape.`, parsed.error, {
    event,
    issues: summarizeZodIssues(parsed.error),
  });
}

function estimateBase64DecodedLength(value) {
  const compact = String(value).replace(/\s+/g, '');
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

function decodeBase64Field(
  value,
  fieldName,
  {
    description = 'Invalid transfer bundle',
    event = 'invalid-bundle',
    expectedLength = null,
    maxBytes = null,
  } = {},
) {
  const estimatedLength = estimateBase64DecodedLength(value);
  if (maxBytes != null && estimatedLength > maxBytes) {
    throw createDeviceLinkPayloadError(
      `${description}: ${fieldName} exceeds ${maxBytes} bytes.`,
      null,
      { event, field: fieldName },
    );
  }

  let bytes;
  try {
    bytes = base64ToBytes(value);
  } catch (err) {
    throw createDeviceLinkPayloadError(
      `${description}: ${fieldName} is not valid base64.`,
      err,
      { event, field: fieldName },
    );
  }
  if (expectedLength != null && bytes.byteLength !== expectedLength) {
    throw createDeviceLinkPayloadError(
      `${description}: ${fieldName} has ${bytes.byteLength} bytes, expected ${expectedLength}.`,
      null,
      { event, field: fieldName },
    );
  }
  if (maxBytes != null && bytes.byteLength > maxBytes) {
    throw createDeviceLinkPayloadError(
      `${description}: ${fieldName} exceeds ${maxBytes} bytes.`,
      null,
      { event, field: fieldName },
    );
  }
  return bytes;
}

/**
 * Encodes raw bytes as a base64 string.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decodes a base64 string into raw bytes.
 *
 * @param {string} value
 * @returns {Uint8Array}
 */
export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Creates a fresh Ed25519 device keypair for account association.
 *
 * The private key is currently only needed for future protocol extensions; the
 * linking flow stores the certified public key on the server.
 *
 * @returns {Promise<{ privateKey: Uint8Array, publicKey: Uint8Array, publicKeyBase64: string }>}
 */
export async function createDeviceIdentity() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return {
    privateKey,
    publicKey,
    publicKeyBase64: bytesToBase64(publicKey),
  };
}

/**
 * Creates a fresh ECDH session keypair used for the blind relay payload.
 *
 * @returns {Promise<{ privateKey: CryptoKey, publicKey: CryptoKey, publicKeyBytes: Uint8Array, publicKeyBase64: string }>}
 */
export async function createSessionKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyBytes,
    publicKeyBase64: bytesToBase64(publicKeyBytes),
  };
}

/**
 * Imports a base64-encoded raw P-256 ECDH public key.
 *
 * @param {string} publicKeyBase64
 * @returns {Promise<CryptoKey>}
 */
export async function importSessionPublicKey(publicKeyBase64) {
  return crypto.subtle.importKey(
    'raw',
    base64ToBytes(publicKeyBase64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}

/**
 * Derives an AES-256-GCM key from a local ECDH private key and remote public key.
 *
 * @param {CryptoKey} privateKey
 * @param {CryptoKey} publicKey
 * @returns {Promise<CryptoKey>}
 */
async function deriveRelayKey(privateKey, publicKey) {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256,
  );
  return crypto.subtle.importKey(
    'raw',
    sharedBits,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypts a transfer bundle for the new device's ECDH session public key.
 *
 * The sender generates a one-shot ECDH keypair, derives a shared AES key, and
 * returns the ephemeral relay public key alongside the AES-GCM envelope.
 *
 * @param {Uint8Array} plaintextBytes
 * @param {string} targetSessionPublicKeyBase64
 * @returns {Promise<{ relayPublicKey: string, relayIv: string, relayCiphertext: string }>}
 */
export async function encryptRelayPayload(plaintextBytes, targetSessionPublicKeyBase64) {
  const relaySession = await createSessionKeyPair();
  const targetPublicKey = await importSessionPublicKey(targetSessionPublicKeyBase64);
  const relayKey = await deriveRelayKey(relaySession.privateKey, targetPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    relayKey,
    plaintextBytes,
  );

  return {
    relayPublicKey: relaySession.publicKeyBase64,
    relayIv: bytesToBase64(iv),
    relayCiphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypts a blind-relayed bundle using the new device's ECDH session private key.
 *
 * @param {{ relayCiphertext: string, relayIv: string, relayPublicKey: string }} envelope
 * @param {CryptoKey} sessionPrivateKey
 * @returns {Promise<Uint8Array>}
 */
export async function decryptRelayPayload(envelope, sessionPrivateKey) {
  const relayPublicKey = await importSessionPublicKey(envelope.relayPublicKey);
  const relayKey = await deriveRelayKey(sessionPrivateKey, relayPublicKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.relayIv) },
    relayKey,
    base64ToBytes(envelope.relayCiphertext),
  );
  return new Uint8Array(plaintext);
}

/**
 * Creates a device certificate by signing the new device's public key with
 * the existing device's private key.
 *
 * @param {Uint8Array} newDevicePublicKey
 * @param {Uint8Array} existingDevicePrivateKey
 * @returns {Promise<Uint8Array>}
 */
export async function certifyDevice(newDevicePublicKey, existingDevicePrivateKey) {
  return ed.signAsync(newDevicePublicKey, existingDevicePrivateKey);
}

/**
 * Verifies a device certificate.
 *
 * @param {Uint8Array} newDevicePublicKey
 * @param {Uint8Array} certificate
 * @param {Uint8Array} signingDevicePublicKey
 * @returns {Promise<boolean>}
 */
export async function verifyCertificate(
  newDevicePublicKey,
  certificate,
  signingDevicePublicKey,
) {
  return ed.verifyAsync(certificate, newDevicePublicKey, signingDevicePublicKey);
}

/**
 * Encode the device-link approval payload carried in the QR / fallback
 * URL.
 *
 * The new device commits to its `devicePublicKey` and `sessionPublicKey`
 * inside the QR payload so the approving device can verify, after
 * resolving a claim from the server, that the server-returned key
 * material matches what the new device originally published. Without
 * this commitment a malicious or compromised server could substitute
 * the resolved claim's key material and receive sensitive transfer
 * material. See `claimMatchesPayloadKeys` for the verification.
 *
 * CORE-INVARIANTS - Authentication, Vault, and Device Identity:
 * "no device-link export route that trusts untrusted claim URLs for
 * bearer-token requests"; the same principle applies to the keys the
 * approving device encrypts inherited material to.
 *
 * The shorthand keys (`r`, `s`, `e`, `d`, `k`) keep the encoded
 * payload short enough for QR codes.
 *
 * @param {{
 *   requestId: string,
 *   secret: string,
 *   expiresAt: string,
 *   devicePublicKey?: string|null,
 *   sessionPublicKey?: string|null,
 * }} payload
 * @returns {string}
 */
export function encodeQRPayload({
  requestId,
  secret,
  expiresAt,
  devicePublicKey = null,
  sessionPublicKey = null,
}) {
  const body = {
    r: requestId,
    s: secret,
    e: expiresAt,
  };
  if (devicePublicKey) body.d = devicePublicKey;
  if (sessionPublicKey) body.k = sessionPublicKey;
  return btoa(JSON.stringify(body));
}

/**
 * Decodes a QR payload back into its request handle fields.
 *
 * Throws a descriptive error if the input is not a valid QR payload.
 *
 * @param {string} encoded
 * @returns {{ requestId: string, secret: string, expiresAt: string }}
 * @throws {Error} When the input is empty, not valid base64, or not a valid QR payload JSON.
 */
export function decodeQRPayload(encoded) {
  if (!encoded) {
    throw createDeviceLinkPayloadError('Invalid QR payload: input is empty.', null, {
      event: 'invalid-qr',
    });
  }
  let json;
  try {
    json = atob(encoded);
  } catch (err) {
    throw createDeviceLinkPayloadError('Invalid QR payload: not valid base64.', err, {
      event: 'invalid-qr',
    });
  }
  const parsed = parseSchemaPayload(
    QRPayloadSchema,
    parseJsonPayload(json, 'Invalid QR payload', 'invalid-qr'),
    'Invalid QR payload',
    'invalid-qr',
  );
  if (parsed.d) {
    decodeBase64Field(parsed.d, 'devicePublicKey', {
      description: 'Invalid QR payload',
      event: 'invalid-qr',
      expectedLength: ED25519_PUBLIC_KEY_BYTES,
    });
    decodeBase64Field(parsed.k, 'sessionPublicKey', {
      description: 'Invalid QR payload',
      event: 'invalid-qr',
      expectedLength: P256_RAW_PUBLIC_KEY_BYTES,
    });
  }
  const { r, s, e, d, k } = parsed;
  return {
    requestId: r,
    secret: s,
    expiresAt: e,
    // Optional commitment fields added by the new device. Legacy
    // payloads that pre-date the commitment carry no `d` / `k`, in
    // which case the approving device falls back to the
    // existing-session-only contract (no claim/payload comparison
    // possible, but no regression vs the legacy code path).
    devicePublicKey: typeof d === 'string' && d ? d : null,
    sessionPublicKey: typeof k === 'string' && k ? k : null,
  };
}

/**
 * Pure helper: returns true iff the server-resolved claim's key
 * material matches the commitment encoded in the decoded QR payload.
 *
 * The approving device MUST call this with the decoded payload after
 * resolving a claim. A legacy payload has neither commitment field
 * and passes for backward compatibility. A modern payload must carry
 * both fields, and both must match exactly. A partial commitment is
 * invalid because it would leave one key under server control.
 *
 * Fail-closed example: the approving UI must not predecrypt, export
 * history, or call approve APIs when this returns `false`.
 *
 * @param {{ devicePublicKey?: string|null, sessionPublicKey?: string|null }} payload
 * @param {{ devicePublicKey?: string|null, sessionPublicKey?: string|null }} claim
 * @returns {boolean}
 */
export function claimMatchesPayloadKeys(payload, claim) {
  if (!payload || !claim) return false;
  const hasDevicePublicKey = Boolean(payload.devicePublicKey);
  const hasSessionPublicKey = Boolean(payload.sessionPublicKey);
  if (!hasDevicePublicKey && !hasSessionPublicKey) return true;
  if (!hasDevicePublicKey || !hasSessionPublicKey) return false;
  return (
    payload.devicePublicKey === claim.devicePublicKey &&
    payload.sessionPublicKey === claim.sessionPublicKey
  );
}

/**
 * Builds the approval URL encoded into the QR code.
 *
 * @param {string} origin
 * @param {{ requestId: string, secret: string, expiresAt: string }} payload
 * @returns {string}
 */
export function buildLinkApprovalUrl(origin, payload) {
  const url = new URL(LINK_QR_ROUTE, origin);
  url.searchParams.set('payload', encodeQRPayload(payload));
  return url.toString();
}

/**
 * Generates a random 8-character alphanumeric fallback code.
 *
 * @returns {string}
 */
export function generateLinkingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(LINKING_CODE_LENGTH));
  return Array.from(bytes)
    .map((value) => LINKING_CODE_CHARSET[value % LINKING_CODE_CHARSET.length])
    .join('');
}

/**
 * Serialises a transfer bundle into UTF-8 JSON bytes.
 *
 * v3 bundles carry the small relay envelope only: identity + an optional
 * archive descriptor. History snapshot, metadata snapshot, and transcript
 * blob have moved into the chunked archive plane and are no longer inline.
 * Legacy v2 bundles with inline history are still accepted by
 * `decodeTransferBundle` so that an OLD device that has not yet been
 * upgraded continues to work for one release cycle.
 *
 * @param {{
 *   userId: string,
 *   username?: string,
 *   displayName?: string,
 *   instanceUrl?: string,
 *   rootPrivateKey: Uint8Array,
 *   rootPublicKey: Uint8Array,
 *   archive?: {
 *     id: string,
 *     downloadToken: string,
 *     totalChunks: number,
 *     totalBytes: number,
 *     chunkSize: number,
 *     manifestHash: string,
 *     archiveSha256: string,
 *     ephPub: string,
 *     nonceBase: string,
 *     transcriptBlobOmitted: boolean,
 *   } | null,
 *   exportedAt?: string,
 * }} bundle
 * @returns {Uint8Array}
 */
export async function encodeTransferBundle(bundle) {
  const payload = {
    v: LINK_BUNDLE_VERSION,
    userId: bundle.userId,
    username: bundle.username ?? '',
    displayName: bundle.displayName ?? '',
    instanceUrl: bundle.instanceUrl ?? '',
    exportedAt: bundle.exportedAt ?? new Date().toISOString(),
    rootPrivateKey: bytesToBase64(bundle.rootPrivateKey),
    rootPublicKey: bytesToBase64(bundle.rootPublicKey),
    archive: bundle.archive ?? null,
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  if (!supportsGzipCompression()) {
    return jsonBytes;
  }
  // Compress the whole transfer bundle before relay encryption. This shrinks
  // the history snapshot + metadata snapshot significantly on normal clients,
  // while decodeTransferBundle still accepts legacy uncompressed JSON.
  return gzipBytes(jsonBytes);
}

/**
 * Parses a transfer bundle from UTF-8 JSON bytes.
 *
 * @param {Uint8Array} bytes
 * @returns {{
 *   version: number,
 *   userId: string,
 *   username: string,
 *   displayName: string,
 *   instanceUrl: string,
 *   exportedAt: string,
 *   rootPrivateKey: Uint8Array,
 *   rootPublicKey: Uint8Array,
 *   historySnapshot: object|null,
 *   guildMetadataKeySnapshot: object|null,
 * }}
 */
export async function decodeTransferBundle(bytes) {
  const decodedBytes = isGzipBytes(bytes) ? await gunzipBytes(bytes) : bytes;
  const text = new TextDecoder().decode(decodedBytes);
  const parsed = parseSchemaPayload(
    TransferBundleSchema,
    parseJsonPayload(text, 'Invalid transfer bundle', 'invalid-bundle'),
    'Invalid transfer bundle',
    'invalid-bundle',
  );
  const rootPrivateKey = decodeBase64Field(
    parsed.rootPrivateKey,
    'rootPrivateKey',
    { expectedLength: ED25519_PRIVATE_KEY_BYTES },
  );
  const rootPublicKey = decodeBase64Field(
    parsed.rootPublicKey,
    'rootPublicKey',
    { expectedLength: ED25519_PUBLIC_KEY_BYTES },
  );
  return {
    version: parsed.v ?? 1,
    userId: parsed.userId,
    username: parsed.username ?? '',
    displayName: parsed.displayName ?? '',
    instanceUrl: parsed.instanceUrl ?? '',
    exportedAt: parsed.exportedAt ?? '',
    rootPrivateKey,
    rootPublicKey,
    // v3: archive descriptor for chunked-transfer plane. v2 and earlier
    // ship history/metadata/transcript inline. The new device's
    // completeDeviceLink prefers `archive` when present.
    archive: parsed.archive ?? null,
    historySnapshot: parsed.historySnapshot ?? null,
    guildMetadataKeySnapshot: parsed.guildMetadataKeySnapshot ?? null,
    transcriptBlob: parsed.transcriptBlob
      ? decodeBase64Field(parsed.transcriptBlob, 'transcriptBlob', {
        maxBytes: LEGACY_INLINE_TRANSCRIPT_BLOB_MAX_BYTES,
      })
      : null,
  };
}
