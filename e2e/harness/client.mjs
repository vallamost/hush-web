#!/usr/bin/env node
/**
 * Headless voice-MLS E2E client (HUSHHQ-106, Item 2).
 *
 * ONE real-app-code client per OS process. The Go driver
 * (hush-server internal/e2e/voice_convergence_test.go) spawns two of these
 * against one real server and asserts their converged final state. Two
 * processes are mandatory: the hush-crypto WASM module and
 * window.mlsStorageBridge are per-realm singletons, so two clients in one
 * process would share MLS group state and mask the convergence bugs this
 * suite exists to catch (HUSHHQ-104 / 105).
 *
 * This harness runs the REAL src/lib modules (mlsGroup, mlsStore,
 * voiceMlsSession, ws, instanceApi, hush-crypto WASM). It mocks nothing on
 * the protocol path: the only Node-vs-browser shims are environmental
 * (jsdom window, fake-indexeddb, the WASM byte source). The integration seam
 * itself is the unit under test.
 *
 * Protocol: line-delimited JSON.
 *   stdin  - one command object per line: {"cmd":"...", ...}
 *   stdout - one event object per line:   {"event":"...", ...}
 * console.log/info/debug are routed to stderr so stdout carries only events.
 *
 * Usage:
 *   node client.mjs --role creator|joiner --base-url http://h:p --ws-url ws://h:p/ws --channel <uuid>
 *   node client.mjs --selftest        # server-free WASM/IndexedDB bootstrap check
 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { JSDOM } from 'jsdom';

// Route library console.log/info/debug to stderr. stdout is reserved for the
// JSON event protocol; a stray console.log on stdout would corrupt it.
console.log = (...a) => console.error(...a);
console.info = (...a) => console.error(...a);
console.debug = (...a) => console.error(...a);

const WS_OPEN_TIMEOUT_MS = 10_000;
const EPOCH_WAIT_TIMEOUT_MS = 15_000;
const EPOCH_POLL_INTERVAL_MS = 50;
const AES_NONCE_BYTES = 12;

// ---------------------------------------------------------------------------
// Encoding / crypto helpers
// ---------------------------------------------------------------------------

const toBase64 = (u8) => Buffer.from(u8).toString('base64');
const fromBase64 = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
const hexToBytes = (hex) => new Uint8Array(Buffer.from(hex, 'hex'));
const utf8Encode = (s) => new TextEncoder().encode(s);
const utf8Decode = (u8) => new TextDecoder().decode(u8);

/** SHA-256 hex digest of raw bytes. Used to compare frame keys without logging them. */
async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(new Uint8Array(digest)).toString('hex');
}

/** Imports a 32-byte frame key as an AES-256-GCM CryptoKey. */
function importFrameKey(keyBytes) {
  return globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function aesGcmEncrypt(keyBytes, nonce, plaintext) {
  const key = await importFrameKey(keyBytes);
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext);
  return new Uint8Array(ct);
}

async function aesGcmDecrypt(keyBytes, nonce, ciphertext) {
  const key = await importFrameKey(keyBytes);
  const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
  return new Uint8Array(pt);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Event protocol
// ---------------------------------------------------------------------------

function emit(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
}

// ---------------------------------------------------------------------------
// Browser-lite environment bootstrap
// ---------------------------------------------------------------------------

/**
 * Installs the browser globals the real src/lib modules need in Node:
 *   - window/document/navigator via jsdom (ws.js network listeners, mlsStore
 *     bridge assignment, optional navigator.storage probe).
 *   - a live globalThis.mlsStorageBridge getter mirroring window.mlsStorageBridge.
 *     The hush-crypto WASM glue reads a BARE global `mlsStorageBridge`; in a
 *     browser that is a window property (== global var). mlsStore assigns
 *     window.mlsStorageBridge, so the getter keeps that the single source of
 *     truth while exposing it as the bare global the glue resolves.
 * WebSocket/crypto/fetch/atob are left as the Node natives (Node 22+).
 */
function installBrowserGlobals() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://harness.local/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // navigator is a getter-only global in Node 22+; leave the native one. The
  // only consumer (mlsStore) reads navigator.storage?.persist?.(), which is
  // safely undefined on the Node navigator.
  Object.defineProperty(globalThis, 'mlsStorageBridge', {
    configurable: true,
    get() {
      return globalThis.window?.mlsStorageBridge;
    },
  });
}

/**
 * Initialises the REAL hush-crypto WASM from local bytes. The web-target glue's
 * no-arg default() fetches a relative URL, which Node cannot fetch; initSync
 * with the file bytes sets the module's internal wasm instance so the
 * hushCrypto.init() wrapper's later default() call early-returns. Byte source
 * only: init path and the single-threaded module stay byte-identical to prod.
 */
async function initWasm() {
  const require = createRequire(import.meta.url);
  const pkgEntry = require.resolve('@gethush/hush-crypto');
  const wasmPath = join(dirname(pkgEntry), 'hush_crypto_bg.wasm');
  const crypto = await import('@gethush/hush-crypto');
  crypto.initSync({ module: readFileSync(wasmPath) });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { role: null, baseUrl: null, wsUrl: null, channel: null, username: null, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--selftest') args.selftest = true;
    else if (flag === '--role') args.role = argv[++i];
    else if (flag === '--base-url') args.baseUrl = argv[++i];
    else if (flag === '--ws-url') args.wsUrl = argv[++i];
    else if (flag === '--channel') args.channel = argv[++i];
    else if (flag === '--username') args.username = argv[++i];
  }
  return args;
}

// ---------------------------------------------------------------------------
// Real-module loading (after globals are installed)
// ---------------------------------------------------------------------------

async function loadModules() {
  const [mlsStore, hushCrypto, mlsGroup, voiceSession, instanceApi, ws, bip39] = await Promise.all([
    import('../../src/lib/mlsStore.js'),
    import('../../src/lib/hushCrypto.js'),
    import('../../src/lib/mlsGroup.js'),
    import('../../src/lib/voiceMlsSession.js'),
    import('../../src/lib/instanceApi.js'),
    import('../../src/lib/ws.js'),
    import('../../src/lib/bip39Identity.js'),
  ]);
  return { mlsStore, hushCrypto, mlsGroup, voiceSession, instanceApi, ws, bip39 };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Provisions identity + session + MLS credential + WS connection for one
 * client and returns the live handles the command loop operates on.
 */
async function bootstrapClient(args, mods) {
  const { mlsStore, hushCrypto, mlsGroup, voiceSession, instanceApi, ws, bip39 } = mods;

  const mnemonic = bip39.generateIdentityMnemonic();
  const { publicKey } = await bip39.mnemonicToIdentityKey(mnemonic);

  const sessionRes = await fetch(`${args.baseUrl}/api/test/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Empty username lets the server mint a unique `e2e-<uuid>` so repeated
    // runs against a persistent test DB never collide on the unique username.
    body: JSON.stringify({ username: args.username ?? '', publicKey: toBase64(publicKey) }),
  });
  if (!sessionRes.ok) {
    throw new Error(`test/session ${sessionRes.status}: ${await sessionRes.text()}`);
  }
  const { token, userId, deviceId } = await sessionRes.json();
  let currentToken = token;

  const db = await mlsStore.openStore(userId, deviceId);
  const credential = await hushCrypto.generateCredential(`${userId}:${deviceId}`);
  await mlsStore.setCredential(db, credential);

  const voiceApi = instanceApi.createInstanceApi(args.baseUrl, () => currentToken);
  const wsClient = ws.createWsClient({ url: args.wsUrl, getToken: () => currentToken });
  await openWebSocket(wsClient);

  const buildMlsDeps = () => ({ db, token: currentToken, credential, mlsStore, hushCrypto, api: voiceApi });

  return {
    userId,
    deviceId,
    db,
    wsClient,
    voiceApi,
    mlsGroup,
    voiceSession,
    buildMlsDeps,
    getToken: () => currentToken,
    setToken: (t) => {
      currentToken = t;
    },
  };
}

function openWebSocket(wsClient) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), WS_OPEN_TIMEOUT_MS);
    wsClient.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    wsClient.on('error', () => {});
    wsClient.connect();
  });
}

/**
 * Wires the real voiceMlsSession (the extracted HUSHHQ-104 dispatch). Its
 * subscribeChannel call is the exact line whose absence caused 104, and the
 * onFrameKey callback is where converged epoch + frame key surface.
 */
function startVoiceSession(client, channelId, frameState) {
  const { wsClient, voiceApi, mlsGroup, voiceSession, db } = client;
  return voiceSession.createVoiceMlsSession({
    wsClient,
    channelId,
    getActiveChannelId: () => channelId,
    currentUserId: client.userId,
    getDeviceId: () => client.deviceId,
    getStore: async () => db,
    getToken: client.getToken,
    mlsStore: client.buildMlsDeps().mlsStore,
    hushCrypto: client.buildMlsDeps().hushCrypto,
    mlsGroup,
    voiceApi,
    onFrameKey: async (frameKeyBytes, epoch) => {
      frameState.epoch = epoch;
      frameState.frameKeyBytes = frameKeyBytes;
      emit('frame_key', { epoch, frameKeyHash: await sha256Hex(frameKeyBytes) });
    },
    onCommitError: (err) => emit('commit_error', { error: String(err?.message ?? err) }),
    onDestroyError: (err) => emit('destroy_error', { error: String(err?.message ?? err) }),
  });
}

/**
 * Text-channel MLS session for the chat-delivery scenario. Mirrors the voice
 * session: subscribe the channel WS topic, advance the local text group on peer
 * commits, and decrypt incoming `message.new` ciphertext into plaintext. Own
 * echoes are skipped on the device-precise (sender_id, sender_device_id) pair so
 * the harness never masks a multi-device bug. Assertions live on the decrypted
 * plaintext outcome (`text_received`), never on these handlers firing.
 */
function startTextSession(client, channelId) {
  const { wsClient, mlsGroup } = client;
  const isOwnEcho = (data) =>
    data.sender_id === client.userId && data.sender_device_id === client.deviceId;

  const handleCommit = async (data) => {
    if (data.group_type === 'voice' || data.channel_id !== channelId || isOwnEcho(data)) return;
    try {
      await mlsGroup.processCommit(client.buildMlsDeps(), channelId, fromBase64(data.commit_bytes));
    } catch (err) {
      emit('text_commit_error', { error: String(err?.message ?? err) });
    }
  };

  const handleMessage = async (data) => {
    if (data.channel_id !== channelId || isOwnEcho(data)) return;
    try {
      const res = await mlsGroup.decryptMessage(client.buildMlsDeps(), channelId, fromBase64(data.ciphertext));
      if (res.plaintext != null) {
        emit('text_received', { plaintext: res.plaintext, senderId: data.sender_id, epoch: res.epoch });
      }
    } catch (err) {
      emit('text_decrypt_error', { error: String(err?.message ?? err) });
    }
  };

  wsClient.on('mls.commit', handleCommit);
  wsClient.on('message.new', handleMessage);
  wsClient.subscribeChannel(channelId);

  return {
    dispose() {
      wsClient.off('mls.commit', handleCommit);
      wsClient.off('message.new', handleMessage);
      wsClient.unsubscribeChannel(channelId);
    },
  };
}

/** Reads the locally stored MLS epoch for a text channel group (0 when unset). */
async function readGroupEpoch(client, channelId) {
  const deps = client.buildMlsDeps();
  const epoch = await deps.mlsStore.getGroupEpoch(deps.db, channelId);
  return Number(epoch ?? 0);
}

/** Polls until the local text group epoch reaches target (advanced by peer commits). */
async function waitForTextEpoch(client, channelId, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while ((await readGroupEpoch(client, channelId)) !== target) {
    if (Date.now() > deadline) {
      throw new Error(`text epoch ${target} not reached (current ${await readGroupEpoch(client, channelId)})`);
    }
    await sleep(EPOCH_POLL_INTERVAL_MS);
  }
}

/** Polls until the local converged epoch reaches target (set async by onFrameKey). */
async function waitForEpoch(frameState, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (frameState.epoch !== target) {
    if (Date.now() > deadline) {
      throw new Error(`epoch ${target} not reached (current ${frameState.epoch})`);
    }
    await sleep(EPOCH_POLL_INTERVAL_MS);
  }
}

/** Refreshes frameState from the current MLS epoch (after a local create/join/remove). */
async function refreshFrameKey(client, channelId, frameState) {
  const { frameKeyBytes, epoch } = await client.mlsGroup.exportVoiceFrameKey(client.buildMlsDeps(), channelId);
  frameState.epoch = epoch;
  frameState.frameKeyBytes = frameKeyBytes;
  return { epoch, frameKeyHash: await sha256Hex(frameKeyBytes) };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleCommand(cmd, ctx) {
  const { client, channelId, frameState } = ctx;
  switch (cmd.cmd) {
    case 'start': {
      ctx.session = startVoiceSession(client, channelId, frameState);
      emit('started', {});
      return;
    }
    case 'create': {
      await client.mlsGroup.createVoiceGroup(client.buildMlsDeps(), channelId);
      emit('created', await refreshFrameKey(client, channelId, frameState));
      return;
    }
    case 'join': {
      await client.mlsGroup.joinVoiceGroup(client.buildMlsDeps(), channelId);
      emit('joined', await refreshFrameKey(client, channelId, frameState));
      return;
    }
    case 'await_epoch': {
      await waitForEpoch(frameState, cmd.epoch, cmd.timeoutMs ?? EPOCH_WAIT_TIMEOUT_MS);
      emit('epoch_reached', { epoch: frameState.epoch, frameKeyHash: await sha256Hex(frameState.frameKeyBytes) });
      return;
    }
    case 'remove': {
      await client.mlsGroup.removeMemberFromVoiceGroup(client.buildMlsDeps(), channelId, cmd.identity);
      emit('removed', await refreshFrameKey(client, channelId, frameState));
      return;
    }
    case 'encrypt': {
      const nonce = hexToBytes(cmd.nonceHex);
      const ct = await aesGcmEncrypt(frameState.frameKeyBytes, nonce, utf8Encode(cmd.plaintext));
      emit('ciphertext', { b64: toBase64(ct), epoch: frameState.epoch });
      return;
    }
    case 'decrypt': {
      const nonce = hexToBytes(cmd.nonceHex);
      try {
        const pt = await aesGcmDecrypt(frameState.frameKeyBytes, nonce, fromBase64(cmd.b64));
        emit('decrypted', { ok: true, plaintext: utf8Decode(pt), epoch: frameState.epoch });
      } catch (err) {
        emit('decrypted', { ok: false, error: String(err?.message ?? err), epoch: frameState.epoch });
      }
      return;
    }
    case 'text_start': {
      ctx.textSession = startTextSession(client, channelId);
      emit('text_started', {});
      return;
    }
    case 'text_create': {
      await client.mlsGroup.createChannelGroup(client.buildMlsDeps(), channelId);
      emit('text_created', { epoch: await readGroupEpoch(client, channelId) });
      return;
    }
    case 'text_join': {
      await client.mlsGroup.joinChannelGroup(client.buildMlsDeps(), channelId);
      emit('text_joined', { epoch: await readGroupEpoch(client, channelId) });
      return;
    }
    case 'text_await_epoch': {
      await waitForTextEpoch(client, channelId, cmd.epoch, cmd.timeoutMs ?? EPOCH_WAIT_TIMEOUT_MS);
      emit('text_epoch_reached', { epoch: await readGroupEpoch(client, channelId) });
      return;
    }
    case 'send_text': {
      const { messageBytes, localId } = await client.mlsGroup.encryptMessage(client.buildMlsDeps(), channelId, cmd.plaintext);
      client.wsClient.send('message.send', { channel_id: channelId, ciphertext: toBase64(messageBytes), local_id: localId });
      emit('text_sent', { localId });
      return;
    }
    case 'text_remove': {
      await client.mlsGroup.removeMemberFromChannel(client.buildMlsDeps(), channelId, cmd.identity);
      emit('text_removed', { epoch: await readGroupEpoch(client, channelId) });
      return;
    }
    case 'exit': {
      if (ctx.session) ctx.session.dispose();
      if (ctx.textSession) ctx.textSession.dispose();
      client.wsClient.disconnect();
      emit('bye', {});
      process.exit(0);
      return;
    }
    default:
      emit('error', { error: `unknown command: ${cmd.cmd}` });
  }
}

// ---------------------------------------------------------------------------
// Self-test (server-free): proves the WASM + IndexedDB + window bridge path
// works headless in Node without needing a running server or test DB.
// ---------------------------------------------------------------------------

async function runSelftest() {
  installBrowserGlobals();
  await initWasm();
  const mods = await loadModules();
  const { mlsStore, hushCrypto, mlsGroup } = mods;

  const userId = '11111111-1111-1111-1111-111111111111';
  const deviceId = '22222222-2222-2222-2222-222222222222';
  const channelId = '33333333-3333-3333-3333-333333333333';

  const db = await mlsStore.openStore(userId, deviceId);
  const credential = await hushCrypto.generateCredential(`${userId}:${deviceId}`);
  await mlsStore.setCredential(db, credential);

  const groupIdBytes = mlsGroup.voiceChannelIdToBytes(channelId);
  await mlsStore.preloadGroupState(db);
  await hushCrypto.createGroup(groupIdBytes, credential.signingPrivateKey, credential.signingPublicKey, credential.credentialBytes);
  await mlsStore.flushStorageCache(db);

  const { frameKeyBytes, epoch } = await hushCrypto.exportVoiceFrameKey(
    groupIdBytes,
    credential.signingPrivateKey,
    credential.signingPublicKey,
    credential.credentialBytes,
  );

  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(AES_NONCE_BYTES));
  const probe = utf8Encode('selftest');
  const ct = await aesGcmEncrypt(frameKeyBytes, nonce, probe);
  const pt = await aesGcmDecrypt(frameKeyBytes, nonce, ct);
  if (utf8Decode(pt) !== 'selftest') throw new Error('aes round-trip mismatch');

  emit('selftest_ok', { epoch, frameKeyHash: await sha256Hex(frameKeyBytes) });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) {
    await runSelftest();
    process.exit(0);
  }
  if (!args.role || !args.baseUrl || !args.wsUrl || !args.channel) {
    throw new Error('required: --role --base-url --ws-url --channel');
  }

  installBrowserGlobals();
  await initWasm();
  const mods = await loadModules();
  const client = await bootstrapClient(args, mods);

  const ctx = { client, channelId: args.channel, frameState: { epoch: null, frameKeyBytes: null }, session: null, textSession: null };
  emit('setup_done', { userId: client.userId, deviceId: client.deviceId });

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      emit('error', { error: `invalid command json: ${trimmed}` });
      continue;
    }
    try {
      await handleCommand(cmd, ctx);
    } catch (err) {
      emit('error', { cmd: cmd.cmd, error: String(err?.message ?? err) });
    }
  }
}

main().catch((err) => {
  emit('fatal', { error: String(err?.stack ?? err?.message ?? err) });
  process.exit(1);
});
