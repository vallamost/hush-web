/**
 * Durable OLD-device export-resume store for in-flight device-link
 * archive uploads. Survives reload, browser restart, laptop sleep so
 * the OLD-device user can resume an interrupted upload instead of
 * rebuilding the archive from scratch (or worse, leaving the
 * server-side allocation stuck until the supersede grace expires).
 *
 * Trust model
 * -----------
 *
 *   - The archive's chunk ciphertexts are already AES-GCM-encrypted
 *     under a per-link random AES key derived via ECDH from the NEW
 *     device's session public key. That AES key is *deliberately not
 *     persisted*: it has done its job at upload time, and re-uploading
 *     never needs it again. An attacker reading the IDB sees only
 *     ciphertext that nobody (including the user's NEW device after
 *     the link is over) can ever decrypt.
 *
 *   - The upload capability token is the one piece of bearer secret
 *     that *is* needed on resume (it authorises chunk
 *     PUT/confirm/finalize/delete on the server). It is wrapped under
 *     a key derived from the user's root identity private key:
 *
 *         WrapKey = HKDF-SHA256(IKM = rootPrivateKey,
 *                                salt = empty,
 *                                info = "hush-link-archive-export-wrap-v1",
 *                                L = 32 bytes)
 *
 *     Same derivation pattern as `transcriptVault.deriveTranscriptKey`,
 *     scoped to its own HKDF info string so the keys cannot collide.
 *     Resume requires the user's vault to be unlocked (rootPrivateKey
 *     in memory).
 *
 *   - All other persisted fields (archiveId, manifest hash, archiveSha256,
 *     chunk SHA-256s, ephPub, nonceBase, chunk plaintext hashes,
 *     ciphertext bytes, progress bitmap, status timestamps) are public
 *     by the design of the bulk plane: the server already sees them.
 *
 * Schema (single store, version 1):
 *
 *     keyPath: 'archiveId'
 *     record:
 *       {
 *         archiveId, baseUrl, backendKind,
 *         totalChunks, totalBytes, chunkSize,
 *         manifestHash, archiveSha256,
 *         chunkSha256s,             // Uint8Array[] (one per chunk, ciphertext SHA-256)
 *         ciphertextChunks,         // Uint8Array[] (raw AES-GCM ciphertexts)
 *         chunkProgress,            // Uint8Array bitmap (bit i set ⇒ chunk i confirmed)
 *         ephPub, nonceBase,
 *         chunkPlaintextHashes,     // Uint8Array[] (per-chunk plaintext SHA-256, used by NEW-side verification)
 *         uploadTokenWrapped: { nonce, ciphertext },
 *         createdAt, lastTransitionAt, hardDeadlineAt,
 *         status,                   // EXPORT_STATUS_*
 *         lastError?,
 *       }
 *
 * Lifecycle
 * ---------
 *
 *     created (initialised after server returns archiveId)
 *       → in_progress (active upload)
 *       → completed   (finalize ok ⇒ row deleted)
 *       → terminal    (unrecoverable error ⇒ retained until the server
 *                      slot is freed by reclaimStaleExportArchives, or
 *                      until the hard deadline passes)
 *
 * `sweepStaleExports` removes only `completed` rows and rows whose
 * `hardDeadlineAt` is in the past (matches the server's 7-day hard
 * deadline). It must not drop a `terminal_failure` row that may still
 * hold a live server slot; see that function's doc comment.
 */

const DB_NAME = 'hush-link-archive-exports';
const DB_VERSION = 1;
const STORE_NAME = 'exports';
const HKDF_INFO = new TextEncoder().encode('hush-link-archive-export-wrap-v1');
const WRAP_NONCE_LENGTH = 12;
const HARD_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

export const EXPORT_STATUS_IN_PROGRESS = 'in_progress';
export const EXPORT_STATUS_COMPLETED = 'completed';
export const EXPORT_STATUS_TERMINAL = 'terminal_failure';

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('[linkArchiveExportStore] IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'archiveId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('[linkArchiveExportStore] open failed'));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let result;
      Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('[linkArchiveExportStore] tx aborted'));
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Vault-key wrap of upload bearer
// ---------------------------------------------------------------------------

async function deriveExportWrapKey(rootPrivateKey) {
  if (!(rootPrivateKey instanceof Uint8Array) || rootPrivateKey.byteLength === 0) {
    throw new Error('[linkArchiveExportStore] root private key must be a non-empty Uint8Array');
  }
  const ikm = await crypto.subtle.importKey(
    'raw', rootPrivateKey, { name: 'HKDF' }, false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function wrapBearer(rootPrivateKey, bearer) {
  const key = await deriveExportWrapKey(rootPrivateKey);
  const nonce = crypto.getRandomValues(new Uint8Array(WRAP_NONCE_LENGTH));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    new TextEncoder().encode(bearer),
  ));
  return { nonce, ciphertext };
}

function asUint8(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  return null;
}

async function unwrapBearer(rootPrivateKey, wrapped) {
  if (!wrapped) throw new Error('[linkArchiveExportStore] wrapped bearer shape invalid');
  const nonce = asUint8(wrapped.nonce);
  const ciphertext = asUint8(wrapped.ciphertext);
  if (!nonce || !ciphertext) {
    throw new Error('[linkArchiveExportStore] wrapped bearer shape invalid');
  }
  const key = await deriveExportWrapKey(rootPrivateKey);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    ciphertext,
  ));
  return new TextDecoder().decode(plaintext);
}

/** Backwards-compatible export: unwrap the upload token from a record's
 *  `uploadTokenWrapped` field. */
export async function unwrapUploadToken(rootPrivateKey, wrapped) {
  return unwrapBearer(rootPrivateKey, wrapped);
}

/** Unwrap the download token from a record's `downloadTokenWrapped` field. */
export async function unwrapDownloadToken(rootPrivateKey, wrapped) {
  return unwrapBearer(rootPrivateKey, wrapped);
}

// ---------------------------------------------------------------------------
// Bitmap helpers
// ---------------------------------------------------------------------------

function emptyBitmap(totalChunks) {
  return new Uint8Array(Math.ceil(Math.max(totalChunks, 0) / 8));
}

function setBit(bitmap, idx) {
  const byte = idx >>> 3;
  const bit = idx & 7;
  if (byte >= bitmap.byteLength) {
    const grown = new Uint8Array(byte + 1);
    grown.set(bitmap);
    bitmap = grown;
  }
  bitmap[byte] |= 1 << bit;
  return bitmap;
}

export function isChunkConfirmed(bitmap, idx) {
  const view = bitmap instanceof Uint8Array ? bitmap : asUint8(bitmap);
  if (!view) return false;
  const byte = idx >>> 3;
  if (byte >= view.byteLength) return false;
  return (view[byte] & (1 << (idx & 7))) !== 0;
}

export function listMissingChunks(bitmap, totalChunks) {
  const out = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!isChunkConfirmed(bitmap, i)) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export record CRUD
// ---------------------------------------------------------------------------

/**
 * Persist an in-progress export record. Called by uploadArchiveSession
 * immediately after the server returns archiveId + uploadToken and the
 * client has built the per-chunk ciphertexts.
 *
 * @param {{
 *   rootPrivateKey: Uint8Array,
 *   archiveId: string,
 *   uploadToken: string,
 *   baseUrl: string,
 *   backendKind: string,
 *   totalChunks: number,
 *   totalBytes: number,
 *   chunkSize: number,
 *   manifestHash: Uint8Array,
 *   archiveSha256: Uint8Array,
 *   chunkSha256s: Uint8Array[],
 *   ciphertextChunks: Uint8Array[],
 *   ephPub: Uint8Array,
 *   nonceBase: Uint8Array,
 *   chunkPlaintextHashes: Uint8Array[],
 * }} init
 * @returns {Promise<object>}
 */
export async function initExport(init) {
  if (!init?.archiveId) throw new Error('[linkArchiveExportStore] archiveId required');
  if (!Number.isInteger(init.totalChunks) || init.totalChunks <= 0) {
    throw new Error('[linkArchiveExportStore] totalChunks must be a positive integer');
  }
  const uploadTokenWrapped = await wrapBearer(init.rootPrivateKey, init.uploadToken);
  const downloadTokenWrapped = init.downloadToken
    ? await wrapBearer(init.rootPrivateKey, init.downloadToken)
    : null;
  const now = Date.now();
  const record = {
    archiveId: init.archiveId,
    baseUrl: init.baseUrl,
    backendKind: init.backendKind,
    totalChunks: init.totalChunks,
    totalBytes: init.totalBytes,
    chunkSize: init.chunkSize,
    manifestHash: init.manifestHash,
    archiveSha256: init.archiveSha256,
    chunkSha256s: init.chunkSha256s,
    ciphertextChunks: init.ciphertextChunks,
    chunkProgress: emptyBitmap(init.totalChunks),
    ephPub: init.ephPub,
    nonceBase: init.nonceBase,
    chunkPlaintextHashes: init.chunkPlaintextHashes,
    uploadTokenWrapped,
    downloadTokenWrapped,
    createdAt: new Date(now).toISOString(),
    lastTransitionAt: new Date(now).toISOString(),
    hardDeadlineAt: new Date(now + HARD_DEADLINE_MS).toISOString(),
    status: EXPORT_STATUS_IN_PROGRESS,
  };
  await withStore('readwrite', (store) => store.put(record));
  return record;
}

/** Mark a chunk confirmed (server accepted ciphertext + matching hash). */
export async function markChunkConfirmed(archiveId, idx) {
  await withStore('readwrite', (store) => new Promise((resolve, reject) => {
    const req = store.get(archiveId);
    req.onsuccess = () => {
      const row = req.result;
      if (!row) { resolve(); return; } // already removed; tolerate
      const existing = asUint8(row.chunkProgress);
      row.chunkProgress = setBit(
        existing ? new Uint8Array(existing) : new Uint8Array(0),
        idx,
      );
      row.lastTransitionAt = new Date().toISOString();
      const put = store.put(row);
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    };
    req.onerror = () => reject(req.error);
  }));
}

/** Replace the export record's chunkProgress bitmap wholesale. */
export async function setExportProgress(archiveId, bitmap) {
  await withStore('readwrite', (store) => new Promise((resolve, reject) => {
    const req = store.get(archiveId);
    req.onsuccess = () => {
      const row = req.result;
      if (!row) { resolve(); return; }
      const incoming = asUint8(bitmap);
      row.chunkProgress = incoming ? new Uint8Array(incoming) : new Uint8Array(0);
      row.lastTransitionAt = new Date().toISOString();
      const put = store.put(row);
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    };
    req.onerror = () => reject(req.error);
  }));
}

/** Mark export terminal (unrecoverable failure). The row is then GC-eligible. */
export async function markExportTerminal(archiveId, errorMessage) {
  await withStore('readwrite', (store) => new Promise((resolve, reject) => {
    const req = store.get(archiveId);
    req.onsuccess = () => {
      const row = req.result;
      if (!row) { resolve(); return; }
      row.status = EXPORT_STATUS_TERMINAL;
      row.lastError = errorMessage ?? null;
      row.lastTransitionAt = new Date().toISOString();
      const put = store.put(row);
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    };
    req.onerror = () => reject(req.error);
  }));
}

/** Remove an export record. Called on successful finalize / explicit abort. */
export async function deleteExport(archiveId) {
  if (!archiveId) return;
  await withStore('readwrite', (store) => store.delete(archiveId));
}

/** Load a single export record by archiveId, or null. */
export async function loadExport(archiveId) {
  if (!archiveId) return null;
  return withStore('readonly', (store) => new Promise((resolve, reject) => {
    const req = store.get(archiveId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  }));
}

/** List every record currently in the store. */
export async function listExports() {
  return withStore('readonly', (store) => new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error);
  }));
}

/**
 * Find an in-progress export for the given baseUrl. Returns the most
 * recently created one (in case the store somehow holds more than one).
 *
 * @param {string} baseUrl
 * @returns {Promise<object|null>}
 */
export async function findResumableExport(baseUrl) {
  const all = await listExports();
  const eligible = all
    .filter((r) => r.status === EXPORT_STATUS_IN_PROGRESS)
    .filter((r) => !baseUrl || r.baseUrl === baseUrl)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return eligible[0] ?? null;
}

/**
 * Remove records that can no longer hold a live server-side archive slot.
 * Called on app start (or LinkDevice page mount) so abandoned exports do
 * not pile up in IDB.
 *
 * A record is reaped only when:
 *   - it is `completed` (finalize released the slot already), or
 *   - its `hardDeadlineAt` has passed (the server has hard-expired the
 *     archive regardless of local state).
 *
 * A `terminal_failure` row whose hard deadline is still in the future is
 * deliberately RETAINED. Such a row may still be holding a server slot
 * when the in-session `deleteArchive` could not reach the server. sweep
 * runs without the unlocked root key and so cannot unwrap the capability
 * token to free the slot itself; deleting the row here would orphan the
 * slot until the server's supersede grace expires, surfacing on the next
 * link attempt as HTTP 409. `reclaimStaleExportArchives` (which has the
 * key) frees the server side first, then drops the row.
 *
 * @returns {Promise<number>} number of records removed
 */
export async function sweepStaleExports() {
  const all = await listExports();
  const now = Date.now();
  let removed = 0;
  for (const row of all) {
    const past = row.hardDeadlineAt && new Date(row.hardDeadlineAt).getTime() < now;
    const completed = row.status === EXPORT_STATUS_COMPLETED;
    if (past || completed) {
      await deleteExport(row.archiveId);
      removed += 1;
    }
  }
  return removed;
}

/** Test helper: wipe the entire export store. */
export async function _clearAll() {
  await withStore('readwrite', (store) => store.clear());
}

export const _internals = {
  emptyBitmap, setBit, deriveExportWrapKey, HKDF_INFO,
};
