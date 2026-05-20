/**
 * Orchestrators that wire the chunked-archive crypto helpers in
 * `linkArchive.js` to the HTTP transport in `linkArchiveTransport.js`.
 *
 * `uploadArchiveSession` runs on the OLD device after `/link-resolve` and
 * before `/link-verify`; it returns the archive descriptor that rides in
 * the small relay envelope.
 *
 * `downloadArchiveSession` runs on the NEW device after the small relay
 * envelope has been decrypted; it reassembles the archive plaintext and
 * returns the original `{ historySnapshot, guildMetadataKeySnapshot,
 * transcriptBlob }` triple.
 */
import {
  LINK_ARCHIVE_CHUNK_SIZE,
  LINK_ARCHIVE_NONCE_BASE_LEN,
  buildArchivePlaintext,
  computeManifestHash,
  deriveArchiveKey,
  deriveArchiveKeyForImport,
  decryptArchiveChunk,
  encryptArchiveSlices,
  parseArchivePlaintext,
  sha256,
  splitArchive,
  constantTimeEqual,
} from './linkArchive';
import {
  finalizeArchive,
  initArchive,
  uploadChunk,
  uploadChunkViaPresign,
  downloadChunkViaWindow,
  requestUploadWindow,
  requestDownloadWindow,
  confirmChunk,
  fetchManifest,
  deleteArchive,
} from './linkArchiveTransport';
import { base64ToBytes, bytesToBase64 } from './deviceLinking';
import {
  initCheckpoint,
  loadCheckpoint,
  markChunkCommitted,
  markCheckpointComplete,
  deleteCheckpoint,
  _internals as checkpointInternals,
} from './linkArchiveCheckpointStore';
import {
  CHUNK_ATOMIC_FORMAT,
  buildChunkAtomicArchive,
  consumeChunk as consumeChunkAtomicChunk,
  createParseAccumulator,
  finalizeAccumulator,
} from './linkArchiveChunkAtomic';
import {
  deriveTranscriptKey,
  createFramedTranscriptStreamDecoder,
  createStreamingTranscriptImporter,
  openTranscriptStore,
} from './transcriptVault';
import {
  initExport,
  markChunkConfirmed,
  setExportProgress,
  markExportTerminal,
  deleteExport,
  unwrapUploadToken,
  unwrapDownloadToken,
  listExports,
  listMissingChunks,
  EXPORT_STATUS_TERMINAL,
} from './linkArchiveExportStore';

const UPLOAD_CONCURRENCY = 4;
const DOWNLOAD_CONCURRENCY = 4;

/**
 * Reclaims the server-side quota slot a previous failed transfer left
 * behind. Without this step, a fresh `initArchive` after a failed
 * transfer returns HTTP 409 ("concurrent archive quota exhausted") until
 * the server's 30-minute supersede grace expires — surfaced to the user
 * as a generic `initArchive failed` and impossible to recover from
 * inside one session.
 *
 * For every locally-persisted export row for this `baseUrl` that is
 * either explicitly terminal or whose hard deadline has passed, we:
 *   1. Unwrap the persisted upload + download tokens (requires the
 *      unlocked root key — same trust boundary as resume).
 *   2. Call the server's `DELETE /link-archive/{id}`. The server treats
 *      404 / 410 as a no-op (archive already gone).
 *   3. Drop the local row regardless of the DELETE result — keeping it
 *      around would let the next retry attempt the same dead row.
 *
 * In-progress rows are left untouched so an interrupted upload can
 * still resume via `resumeUploadArchiveSession`. The caller is expected
 * to invoke this before `initArchive` whenever the user is starting a
 * fresh link attempt (not a resume).
 *
 * @param {{ baseUrl: string, rootPrivateKey: Uint8Array }} args
 * @returns {Promise<number>} number of stale exports reclaimed
 */
export async function reclaimStaleExportArchives({ baseUrl, rootPrivateKey }) {
  if (!(rootPrivateKey instanceof Uint8Array) || rootPrivateKey.byteLength === 0) {
    return 0;
  }
  let rows;
  try {
    rows = await listExports();
  } catch (err) {
    console.warn('[linkArchive] reclaimStaleExportArchives: listExports failed', err);
    return 0;
  }
  let reclaimed = 0;
  const now = Date.now();
  for (const row of rows) {
    if (!row || !row.archiveId) continue;
    if (baseUrl && row.baseUrl && row.baseUrl !== baseUrl) continue;
    const isTerminal = row.status === EXPORT_STATUS_TERMINAL;
    const isPastDeadline = row.hardDeadlineAt
      && new Date(row.hardDeadlineAt).getTime() < now;
    if (!isTerminal && !isPastDeadline) continue;
    let uploadToken = null;
    let downloadToken = null;
    try {
      if (row.uploadTokenWrapped) {
        uploadToken = await unwrapUploadToken(rootPrivateKey, row.uploadTokenWrapped);
      }
      if (row.downloadTokenWrapped) {
        downloadToken = await unwrapDownloadToken(rootPrivateKey, row.downloadTokenWrapped);
      }
    } catch (err) {
      console.warn('[linkArchive] reclaimStaleExportArchives: token unwrap failed', err);
    }
    if (uploadToken || downloadToken) {
      try {
        await deleteArchive(row.archiveId, { uploadToken, downloadToken }, row.baseUrl || baseUrl);
      } catch (err) {
        // deleteArchive already swallows network errors; this catch
        // covers programmer mistakes (bad URL etc.) so the loop never
        // crashes the caller's fresh-attempt path.
        console.warn('[linkArchive] reclaimStaleExportArchives: deleteArchive threw', err);
      }
    }
    try { await deleteExport(row.archiveId); }
    catch (err) { console.warn('[linkArchive] reclaimStaleExportArchives: deleteExport failed', err); }
    reclaimed += 1;
  }
  return reclaimed;
}

/**
 * Bounded-concurrency map. Preserves index order of `tasks`.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Runs the full OLD-device upload pipeline and returns the descriptor that
 * the caller should embed in the small relay envelope.
 *
 * @param {{
 *   token: string,
 *   sessionPublicKeyBase64: string,
 *   baseUrl: string,
 *   historySnapshot: object|null,
 *   guildMetadataKeySnapshot: object|null,
 *   transcriptBlob: Uint8Array|null,
 * }} args
 * @returns {Promise<{
 *   id: string,
 *   downloadToken: string,
 *   uploadToken: string,
 *   totalChunks: number,
 *   totalBytes: number,
 *   chunkSize: number,
 *   manifestHash: string,
 *   archiveSha256: string,
 *   ephPub: string,
 *   nonceBase: string,
 *   transcriptBlobOmitted: boolean,
 * }>}
 */
export async function uploadArchiveSession({
  token,
  sessionPublicKeyBase64,
  baseUrl,
  historySnapshot,
  guildMetadataKeySnapshot,
  transcriptBlob,
  rootPrivateKey = null,
}) {
  // 1. Build the chunk-atomic archive. Each chunk is independently
  // AEAD-decryptable, gunzippable, and parseable; the NEW device can
  // process one chunk at a time without buffering the whole archive.
  // No degraded path: an archive that exceeds the operator-configured
  // staging cap is rejected at /link-archive-init by the server (503
  // + Retry-After). The OLD device never silently drops user state.
  const built = await buildChunkAtomicArchive({
    historySnapshot,
    guildMetadataKeySnapshot,
    transcriptBlob,
    chunkSize: LINK_ARCHIVE_CHUNK_SIZE,
  });
  const transcriptBlobOmitted = false;

  // archiveSha256 carries the chunk-atomic-v1 binding: it is
  // sha256(concat(per-chunk-plaintext-sha256)) so the NEW device can
  // verify it incrementally as it decrypts + gunzips chunks one at a
  // time, without holding the full plaintext in memory.
  const archiveSha256 = built.archiveSha256;

  // 2. Encrypt the per-chunk gzip outputs. Each ciphertext_i =
  // AES-GCM(gzip(plaintext_chunk_i)) — chunk-atomic at every layer.
  const { key, ephPublicKeyBytes } = await deriveArchiveKey(sessionPublicKeyBase64);
  const nonceBase = crypto.getRandomValues(new Uint8Array(LINK_ARCHIVE_NONCE_BASE_LEN));
  const { ciphertexts, chunkHashes } = await encryptArchiveSlices(built.chunks, key, nonceBase);
  const manifestHash = await computeManifestHash(chunkHashes);

  const totalBytes = ciphertexts.reduce((sum, c) => sum + c.byteLength, 0);

  // 3a. Reclaim any server-side archive a prior failed transfer left
  // behind. Doing this before init means an immediate retry after a
  // failure does not collide with the per-user concurrent quota — the
  // server would otherwise hold the old slot open for up to 30 minutes
  // and reject this init with HTTP 409 ("initArchive failed").
  if (rootPrivateKey instanceof Uint8Array && rootPrivateKey.byteLength > 0) {
    try {
      await reclaimStaleExportArchives({ baseUrl, rootPrivateKey });
    } catch (err) {
      console.warn('[linkArchive] reclaimStaleExportArchives failed', err);
    }
  }

  // 3b. Init: server returns archive id, capability tokens, backend
  // kind, and the first presigned-URL upload window.
  let init;
  try {
    init = await initArchive(token, {
      totalChunks: ciphertexts.length,
      totalBytes,
      chunkSize: LINK_ARCHIVE_CHUNK_SIZE,
      manifestHash,
      archiveSha256,
    }, baseUrl);
  } catch (err) {
    if (err && err.status === 409) {
      throw Object.assign(
        new Error(
          'A previous device-link transfer is still occupying the server slot. Wait a minute or close any other linking session, then try again.',
        ),
        { cause: err, status: 409 },
      );
    }
    throw err;
  }

  const backendKind = init.backendKind || 'postgres_bytea';
  const totalChunks = ciphertexts.length;

  // Persist a durable export record so a tab close / reload can resume
  // the same archive instead of allocating a fresh one. Failure to
  // persist is best-effort: the upload still proceeds in volatile
  // memory; we just lose resume on this attempt. (Typical failure mode
  // is "no rootPrivateKey was passed" — an opt-in: callers that want
  // resume must pass the unlocked vault root key.)
  let exportPersisted = false;
  if (rootPrivateKey instanceof Uint8Array && rootPrivateKey.byteLength > 0) {
    try {
      await initExport({
        rootPrivateKey,
        archiveId: init.archiveId,
        uploadToken: init.uploadToken,
        downloadToken: init.downloadToken,
        baseUrl,
        backendKind,
        totalChunks,
        totalBytes,
        chunkSize: LINK_ARCHIVE_CHUNK_SIZE,
        manifestHash,
        archiveSha256,
        chunkSha256s: chunkHashes,
        ciphertextChunks: ciphertexts,
        ephPub: ephPublicKeyBytes,
        nonceBase,
        chunkPlaintextHashes: built.chunkPlaintextHashes,
      });
      exportPersisted = true;
    } catch (err) {
      console.warn('[linkArchive] export persistence init failed; resume disabled for this attempt', err);
    }
  }

  // putViaWindow uploads one ciphertext via the URL provided by the
  // server's window response. Branches on backendKind: postgres_bytea
  // talks to the in-API endpoint with X-Upload-Token + X-Chunk-Sha256
  // headers; s3 PUTs to a real presigned URL with the
  // x-amz-checksum-sha256 header set.
  async function putViaWindow(entry, idx) {
    if (backendKind === 'postgres_bytea') {
      await uploadChunk(init.archiveId, init.uploadToken, idx, ciphertexts[idx], chunkHashes[idx], token, baseUrl);
    } else {
      await uploadChunkViaPresign(entry, ciphertexts[idx], chunkHashes[idx], baseUrl);
    }
    await confirmChunk(init.archiveId, init.uploadToken, idx, chunkHashes[idx], ciphertexts[idx].byteLength, token, baseUrl);
    if (exportPersisted) {
      try { await markChunkConfirmed(init.archiveId, idx); }
      catch (err) { console.warn('[linkArchive] markChunkConfirmed failed', err); }
    }
  }

  try {
    // 4. Upload via sliding windows.
    let window = init.uploadWindow;
    while (window && window.from < totalChunks) {
      const tasks = window.urls.map((entry, i) => async () => {
        await putViaWindow(entry, window.from + i);
      });
      await runWithConcurrency(tasks, UPLOAD_CONCURRENCY);
      if (window.to >= totalChunks) break;
      const nextFrom = window.to;
      const nextTo = Math.min(nextFrom + window.urls.length, totalChunks);
      window = await requestUploadWindow(init.archiveId, init.uploadToken, nextFrom, nextTo, token, baseUrl);
    }

    // 5. Finalize, retransmit any missing chunks once.
    let finalizeResult = await finalizeArchive(init.archiveId, init.uploadToken, token, baseUrl);
    if (finalizeResult.status === 'missing') {
      const missing = finalizeResult.missing;
      // Mint a window covering exactly the missing indices (capped to
      // server window size). For larger gaps we loop.
      let cursor = 0;
      while (cursor < missing.length) {
        const slice = missing.slice(cursor, cursor + (init.uploadWindow?.urls?.length || 8));
        const from = slice[0];
        const to = slice[slice.length - 1] + 1;
        const retryWindow = await requestUploadWindow(init.archiveId, init.uploadToken, from, to, token, baseUrl);
        const tasks = retryWindow.urls.map((entry) => async () => {
          await putViaWindow(entry, entry.idx);
        });
        await runWithConcurrency(tasks, UPLOAD_CONCURRENCY);
        cursor += slice.length;
      }
      finalizeResult = await finalizeArchive(init.archiveId, init.uploadToken, token, baseUrl);
      if (finalizeResult.status !== 'ok') {
        throw new Error('[linkArchive] finalize failed after retransmit');
      }
    }
  } catch (err) {
    if (exportPersisted) {
      try { await markExportTerminal(init.archiveId, err?.message ?? String(err)); }
      catch (cleanupErr) { console.warn('[linkArchive] markExportTerminal failed', cleanupErr); }
    }
    try {
      await deleteArchive(init.archiveId, {
        uploadToken: init.uploadToken,
        downloadToken: init.downloadToken,
      }, baseUrl);
    } catch (cleanupErr) {
      console.warn('[linkArchive] deleteArchive after upload failure failed', cleanupErr);
    }
    // Caller is expected to fire deleteArchive on failure; surface the error.
    throw err;
  }

  if (exportPersisted) {
    try { await deleteExport(init.archiveId); }
    catch (err) { console.warn('[linkArchive] deleteExport on success failed', err); }
  }

  return {
    id: init.archiveId,
    downloadToken: init.downloadToken,
    uploadToken: init.uploadToken,
    totalChunks: ciphertexts.length,
    totalBytes,
    chunkSize: LINK_ARCHIVE_CHUNK_SIZE,
    manifestHash: bytesToBase64(manifestHash),
    archiveSha256: bytesToBase64(archiveSha256),
    ephPub: bytesToBase64(ephPublicKeyBytes),
    nonceBase: bytesToBase64(nonceBase),
    // Per-chunk plaintext SHA-256, base64. Carried in the small relay
    // envelope so the NEW device can verify each chunk's plaintext
    // hash incrementally rather than buffering the whole archive.
    chunkPlaintextHashes: built.chunkPlaintextHashes.map((h) => bytesToBase64(h)),
    format: CHUNK_ATOMIC_FORMAT,
    transcriptBlobOmitted,
  };
}

/**
 * Resume a previously-interrupted OLD-device upload. The caller hands
 * over the persisted export record (typically from
 * `findResumableExport`) plus the current JWT and the unlocked vault
 * root key. Behaviour:
 *
 *   1. Unwrap the upload bearer using the root-key-derived wrap key.
 *   2. Probe server progress by calling /link-archive-finalize. The
 *      server returns either { status: 'ok' } (everything already
 *      uploaded — finalize succeeded), or { status: 'missing', missing }
 *      with the indices the server has not yet seen.
 *   3. For every missing index, mint a fresh upload window (server
 *      caps each window at linkArchiveWindowSize), retransmit the
 *      ciphertext from persisted state, and confirm. The server
 *      rejects 4xx if the archive has been GC'd or the token is
 *      invalid; on rejection we mark terminal + delete + throw.
 *   4. Re-finalize. Both retransmit and finalize are idempotent.
 *   5. Delete the export record.
 *   6. Return the same descriptor shape as `uploadArchiveSession` so
 *      the caller can carry on with /link-verify.
 *
 * @param {{
 *   token: string,
 *   baseUrl: string,
 *   rootPrivateKey: Uint8Array,
 *   exportRecord: object,
 * }} args
 * @returns {Promise<object>} archive descriptor (same shape as uploadArchiveSession)
 */
export async function resumeUploadArchiveSession({ token, baseUrl, rootPrivateKey, exportRecord }) {
  if (!exportRecord || !exportRecord.archiveId) {
    throw new Error('[linkArchive] resumeUploadArchiveSession: invalid exportRecord');
  }
  const archiveId = exportRecord.archiveId;
  const uploadToken = await unwrapUploadToken(rootPrivateKey, exportRecord.uploadTokenWrapped);
  const downloadToken = exportRecord.downloadTokenWrapped
    ? await unwrapDownloadToken(rootPrivateKey, exportRecord.downloadTokenWrapped)
    : null;
  const backendKind = exportRecord.backendKind;
  const totalChunks = exportRecord.totalChunks;
  const ciphertextChunks = exportRecord.ciphertextChunks.map((c) => (c instanceof Uint8Array ? c : new Uint8Array(c)));
  const chunkSha256s = exportRecord.chunkSha256s.map((c) => (c instanceof Uint8Array ? c : new Uint8Array(c)));

  async function putAt(entry, idx) {
    if (backendKind === 'postgres_bytea') {
      await uploadChunk(archiveId, uploadToken, idx, ciphertextChunks[idx], chunkSha256s[idx], token, baseUrl);
    } else {
      await uploadChunkViaPresign(entry, ciphertextChunks[idx], chunkSha256s[idx], baseUrl);
    }
    await confirmChunk(archiveId, uploadToken, idx, chunkSha256s[idx], ciphertextChunks[idx].byteLength, token, baseUrl);
    try { await markChunkConfirmed(archiveId, idx); } catch { /* tolerate */ }
  }

  // Probe the server to discover which chunks the OLD device thought
  // it had uploaded but the server never saw, plus any chunks that
  // were uploaded after the local checkpoint stopped getting refreshed.
  let result;
  try {
    result = await finalizeArchive(archiveId, uploadToken, token, baseUrl);
  } catch (err) {
    // Treat 404 / 410 (archive gone) as terminal — the local export is
    // useless without a live server-side counterpart.
    if (err?.status === 404 || err?.status === 410) {
      await markExportTerminal(archiveId, `server archive gone (${err.status})`);
      await deleteExport(archiveId);
    }
    throw err;
  }

  if (result.status === 'missing') {
    // Server is authoritative: only the indices it reports as missing
    // are retransmitted. Already-confirmed chunks are not re-uploaded.
    // Update the local progress bitmap to mirror server truth so a
    // second crash mid-resume does not re-process the chunks the
    // server already accepted before this resume started.
    const missingSet = new Set(result.missing);
    let bitmap = new Uint8Array(Math.ceil(totalChunks / 8));
    for (let i = 0; i < totalChunks; i++) {
      if (!missingSet.has(i)) {
        bitmap[i >>> 3] |= 1 << (i & 7);
      }
    }
    await setExportProgress(archiveId, bitmap);

    const missing = result.missing.slice();
    let cursor = 0;
    while (cursor < missing.length) {
      const slice = missing.slice(cursor, cursor + 8); // matches server window cap
      const from = slice[0];
      const to = slice[slice.length - 1] + 1;
      const win = await requestUploadWindow(archiveId, uploadToken, from, to, token, baseUrl);
      const tasks = win.urls
        .filter((entry) => slice.includes(entry.idx))
        .map((entry) => async () => { await putAt(entry, entry.idx); });
      await runWithConcurrency(tasks, UPLOAD_CONCURRENCY);
      cursor += slice.length;
    }
    result = await finalizeArchive(archiveId, uploadToken, token, baseUrl);
    if (result.status !== 'ok') {
      const msg = `[linkArchive] resume finalize failed (${result.status})`;
      await markExportTerminal(archiveId, msg);
      throw new Error(msg);
    }
  }

  await deleteExport(archiveId);

  return {
    id: archiveId,
    downloadToken,
    uploadToken,
    totalChunks,
    totalBytes: exportRecord.totalBytes,
    chunkSize: exportRecord.chunkSize,
    manifestHash: bytesToBase64(exportRecord.manifestHash),
    archiveSha256: bytesToBase64(exportRecord.archiveSha256),
    ephPub: bytesToBase64(exportRecord.ephPub),
    nonceBase: bytesToBase64(exportRecord.nonceBase),
    chunkPlaintextHashes: exportRecord.chunkPlaintextHashes.map((h) => bytesToBase64(h)),
    format: CHUNK_ATOMIC_FORMAT,
    transcriptBlobOmitted: false,
  };
}

/**
 * Runs the full NEW-device download pipeline. Returns the original
 * `{ historySnapshot, guildMetadataKeySnapshot, transcriptBlob }` triple.
 *
 * @param {{
 *   archive: {
 *     id: string,
 *     downloadToken: string,
 *     totalChunks: number,
 *     chunkSize: number,
 *     manifestHash: string,
 *     archiveSha256: string,
 *     ephPub: string,
 *     nonceBase: string,
 *   },
 *   sessionPrivateKey: CryptoKey,
 *   baseUrl: string,
 * }} args
 * @returns {Promise<{ historySnapshot: object|null, guildMetadataKeySnapshot: object|null, transcriptBlob: Uint8Array|null }>}
 */
export async function downloadArchiveSession({ archive, sessionPrivateKey, baseUrl, rootPrivateKey = null, userId = null }) {
  const manifest = await fetchManifest(archive.id, archive.downloadToken, baseUrl);

  // Re-verify manifest hash binding to the descriptor that came over the
  // relay envelope; the server must agree with what the OLD device sealed.
  const declaredManifestHash = base64ToBytes(archive.manifestHash);
  const manifestServerHash = base64ToBytes(manifest.manifestHash);
  if (!constantTimeEqual(declaredManifestHash, manifestServerHash)) {
    throw new Error('[linkArchive] server manifest hash differs from descriptor');
  }
  if (manifest.totalChunks !== archive.totalChunks) {
    throw new Error('[linkArchive] server totalChunks differs from descriptor');
  }
  const expectedHashes = manifest.chunkHashes.map((h) => base64ToBytes(h));

  const ephPubBytes = base64ToBytes(archive.ephPub);
  const nonceBase = base64ToBytes(archive.nonceBase);
  const key = await deriveArchiveKeyForImport(ephPubBytes, sessionPrivateKey);

  // Durable per-archive checkpoint. On reload the NEW device picks up
  // here and skips chunks already committed.
  let checkpoint = await loadCheckpoint(archive.id);
  if (!checkpoint || checkpoint.totalChunks !== archive.totalChunks) {
    checkpoint = await initCheckpoint({
      archiveId: archive.id,
      role: 'import',
      instanceUrl: baseUrl,
      totalChunks: archive.totalChunks,
      status: 'in_progress',
    });
  }

  const slices = new Array(archive.totalChunks);
  // Walk download windows. The server caps each window at its
  // window-size constant; the client makes as many round trips as
  // necessary. For every chunk in a window the URL is presigned (s3)
  // or in-API (postgres_bytea); both resolve to a GET that returns
  // octet-stream bytes, so the same downloadChunkViaWindow helper
  // works for both.
  const windowSize = 8;
  // Branch on archive descriptor format. The chunk-atomic-v1 path
  // processes each chunk independently (decrypt → gunzip → parse →
  // commit) and never buffers the whole archive ciphertext. The
  // legacy monolithic path stays in place for one release window so
  // OLD devices that still ship the v3 descriptor can still link.
  const isChunkAtomic = archive.format === CHUNK_ATOMIC_FORMAT;
  let parsed;
  if (isChunkAtomic) {
    // Streaming-transcript path. When the caller hands us the unlocked
    // root private key (NEW-device link flow), construct a framed
    // transcript decoder and feed TRANS_PART payloads to it as they
    // arrive. The chunk-atomic accumulator does NOT retain transcript
    // bytes, so peak memory is bounded by one frame's plaintext +
    // accumulating rows array (no whole-blob ciphertext / decompressed
    // JSON / parsed-rows multi-buffer peak).
    let transcriptStreamConsumer = null;
    let framedDecoder = null;
    let streamingImporter = null;       // populated only when wire+at-rest streaming is engaged
    let streamingImporterDb = null;
    let transcriptKey = null;
    if (rootPrivateKey instanceof Uint8Array && rootPrivateKey.byteLength > 0) {
      transcriptKey = await deriveTranscriptKey(rootPrivateKey);
      if (userId) {
        // End-to-end streaming: each decoded wire frame goes straight
        // into a per-frame at-rest IDB write (and into the in-memory
        // cache via beginTranscriptCacheStream). The decoder's rows
        // accumulator is replaced by the importer's appendFrame
        // callback, so no whole-rows array materialises on import.
        streamingImporterDb = await openTranscriptStore(userId);
        streamingImporter = createStreamingTranscriptImporter({
          db: streamingImporterDb,
          key: transcriptKey,
          userId,
        });
        framedDecoder = createFramedTranscriptStreamDecoder(transcriptKey, {
          onFrameRows: (rows) => streamingImporter.appendFrame(rows),
        });
      } else {
        // rootPrivateKey only — fall back to slice-9 behaviour
        // (decoder accumulates rows; caller does the at-rest write).
        framedDecoder = createFramedTranscriptStreamDecoder(transcriptKey);
      }
      transcriptStreamConsumer = (bytes) => framedDecoder.feed(bytes);
    }
    const acc = createParseAccumulator({ transcriptStreamConsumer });
    const expectedPlaintextHashes = Array.isArray(archive.chunkPlaintextHashes)
      ? archive.chunkPlaintextHashes.map((h) => base64ToBytes(h))
      : null;

    // Sequential per-chunk processing keeps memory bounded: only one
    // chunk's ciphertext + plaintext is in flight at a time. Window
    // requests still batch network round trips.
    for (let from = 0; from < archive.totalChunks; from += windowSize) {
      const to = Math.min(from + windowSize, archive.totalChunks);
      const window = await requestDownloadWindow(archive.id, archive.downloadToken, from, to, baseUrl);
      // Process chunks in increasing index order to honour record-
      // ordering invariants (META first, END last).
      const sortedEntries = [...window.urls].sort((a, b) => a.idx - b.idx);
      for (const entry of sortedEntries) {
        const ciphertext = await downloadChunkViaWindow(entry, baseUrl, archive.downloadToken);
        const gzippedPlaintext = await decryptArchiveChunk(
          ciphertext, expectedHashes[entry.idx], key, nonceBase, entry.idx,
        );
        const expected = expectedPlaintextHashes ? expectedPlaintextHashes[entry.idx] : null;
        await consumeChunkAtomicChunk(gzippedPlaintext, acc, expected);
        const result = await markChunkCommitted(archive.id, entry.idx);
        checkpoint.chunkProgress = checkpointInternals.setBit(checkpoint.chunkProgress, entry.idx);
        checkpoint.highestContiguous = result.highestContiguous;
      }
    }
    const expectedArchiveSha256 = base64ToBytes(archive.archiveSha256);
    parsed = await finalizeAccumulator(acc, expectedArchiveSha256);
    // When a streaming consumer was installed, finalize the framed
    // decoder to obtain the rows. parsed.transcriptBlob is null in
    // this mode; we expose `transcriptRows` instead so the caller
    // can hand them to the at-rest re-encryption path without ever
    // holding a whole-blob ciphertext buffer.
    if (framedDecoder) {
      try {
        const finishResult = await framedDecoder.finish();
        if (streamingImporter) {
          // Streaming-importer mode: appendFrame already wrote every
          // frame to IDB and seeded the cache. finish() returned an
          // empty array (or undefined) because the decoder's onFrameRows
          // callback dispatched rows directly; commit atomically swaps
          // the at-rest visibility and finalises the cache.
          await streamingImporter.commit();
          parsed.transcriptBlob = null;
          parsed.transcriptRows = null;
          parsed.transcriptPersistedAtRest = true;
        } else {
          // Slice-9 path: decoder accumulated rows, caller writes them
          // to at-rest via importAndReprotectTranscriptRows.
          parsed.transcriptRows = finishResult;
        }
      } catch (err) {
        if (streamingImporter) {
          try { await streamingImporter.abort(); } catch { /* best-effort */ }
        }
        throw err;
      } finally {
        if (streamingImporterDb) {
          try { streamingImporterDb.close(); } catch { /* ignore */ }
        }
      }
    }
  } else {
    // Legacy monolithic-archive path (descriptor format unset or
    // explicitly 'monolithic-v3'). Removed in the release after
    // every still-running OLD device has been upgraded.
    for (let from = 0; from < archive.totalChunks; from += windowSize) {
      const to = Math.min(from + windowSize, archive.totalChunks);
      const window = await requestDownloadWindow(archive.id, archive.downloadToken, from, to, baseUrl);
      const tasks = window.urls.map((entry) => async () => {
        const ciphertext = await downloadChunkViaWindow(entry, baseUrl, archive.downloadToken);
        slices[entry.idx] = await decryptArchiveChunk(ciphertext, expectedHashes[entry.idx], key, nonceBase, entry.idx);
        const result = await markChunkCommitted(archive.id, entry.idx);
        checkpoint.chunkProgress = checkpointInternals.setBit(checkpoint.chunkProgress, entry.idx);
        checkpoint.highestContiguous = result.highestContiguous;
      });
      await runWithConcurrency(tasks, DOWNLOAD_CONCURRENCY);
    }

    const expectedArchiveSha256 = base64ToBytes(archive.archiveSha256);
    let totalLen = 0;
    for (const slice of slices) totalLen += slice.byteLength;
    const plaintext = new Uint8Array(totalLen);
    let offset = 0;
    for (const slice of slices) {
      plaintext.set(slice, offset);
      offset += slice.byteLength;
    }
    const actualHash = await sha256(plaintext);
    if (!constantTimeEqual(actualHash, expectedArchiveSha256)) {
      throw new Error('[linkArchive] reassembled plaintext sha256 mismatch');
    }
    parsed = await parseArchivePlaintext(plaintext);
  }
  // Mark the durable checkpoint complete and remove it. Failures
  // here are non-fatal — the next link will overwrite the row by
  // archiveId, and the row otherwise gets cleaned up the next time
  // the user starts an import.
  try {
    await markCheckpointComplete(archive.id);
    await deleteCheckpoint(archive.id);
  } catch {
    // ignore checkpoint cleanup errors
  }
  return parsed;
}
