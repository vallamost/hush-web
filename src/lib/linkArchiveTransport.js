/**
 * HTTP transport for the chunked device-link transfer plane.
 *
 * Each call accepts an explicit instance base URL because the OLD-device
 * upload happens on the user's currently-authenticated instance and the
 * NEW-device download targets the instance that issued the small relay
 * envelope. None of these endpoints rely on `getActiveAuthInstanceUrlSync`
 * because they may execute before any persisted instance state exists.
 *
 * Bounded retry (`retryWithBackoff`) keeps the OLD-device upload loop
 * resilient against transient network errors without masking 4xx hard
 * failures (`409 Conflict` on chunk hash collision is surfaced unchanged).
 */
import { bytesToBase64 } from './deviceLinking';
import { sha256 } from './linkArchive';
import { readJsonResponse, readJsonResponseOrNull } from './apiJson';
import {
  parseArchiveFinalizeMissing,
  parseArchiveInitResponse,
  parseArchiveManifest,
  parseArchiveWindowResponse,
} from './linkArchiveSchemas';

const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_ATTEMPTS = 3;

class LinkArchiveError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'LinkArchiveError';
    this.status = status;
    this.body = body;
  }
}

function archiveBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string') return '';
  return baseUrl.replace(/\/$/, '');
}

async function readJson(res) {
  return readJsonResponseOrNull(res, 'link archive error');
}

function shouldRetry(err) {
  // Only retry on TypeError (network failure), AbortError, or 5xx-class
  // errors. 4xx including 409 Conflict are not transient.
  if (err instanceof LinkArchiveError) {
    return err.status >= 500 && err.status <= 599;
  }
  return err instanceof TypeError || (err && err.name === 'AbortError');
}

/**
 * Retries `fn` with capped exponential backoff. The caller controls the
 * idempotency contract — the same call must produce the same on-server
 * effect on retry.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function retryWithBackoff(fn) {
  let attempt = 0;
  let lastErr;
  while (attempt < RETRY_MAX_ATTEMPTS) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (!shouldRetry(err) || attempt >= RETRY_MAX_ATTEMPTS) break;
      const delay = RETRY_BASE_DELAY_MS * (3 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * @param {string} token - JWT
 * @param {{ totalChunks: number, totalBytes: number, chunkSize: number, manifestHash: Uint8Array, archiveSha256: Uint8Array }} body
 * @param {string} baseUrl - Instance base URL.
 * @returns {Promise<{ archiveId: string, uploadToken: string, downloadToken: string, expiresAt: string, hardDeadlineAt: string }>}
 */
export async function initArchive(token, body, baseUrl = '') {
  const url = `${archiveBaseUrl(baseUrl)}/api/auth/link-archive-init`;
  const payload = {
    totalChunks: body.totalChunks,
    totalBytes: body.totalBytes,
    chunkSize: body.chunkSize,
    manifestHash: bytesToBase64(body.manifestHash),
    archiveSha256: bytesToBase64(body.archiveSha256),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new LinkArchiveError('initArchive failed', {
      status: res.status,
      body: await readJson(res),
    });
  }
  return parseArchiveInitResponse(await readJsonResponse(res, 'initArchive'));
}

/**
 * Uploads a single chunk via the in-API endpoint. Used for the
 * postgres_bytea backend; for s3 the OLD device PUTs to a presigned
 * URL via uploadChunkViaPresign instead.
 *
 * The endpoint sits inside the JWT-gated upload plane on the server
 * (see hush-server linkArchiveRoutes; the `RequireAuth` middleware
 * runs before the chunk handler), so the OLD device must send BOTH
 * the upload-token (capability) and the bearer JWT (identity). The
 * sibling endpoints `requestUploadWindow` / `confirmChunk` /
 * `finalizeArchive` already do this; this helper was the outlier
 * and produced spurious 401s during real LinkDevice approval flows.
 *
 * @param {string} archiveId
 * @param {string} uploadToken
 * @param {number} idx
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} chunkHash
 * @param {string} jwt - the OLD device's auth bearer.
 * @param {string} baseUrl
 * @returns {Promise<void>}
 */
export async function uploadChunk(archiveId, uploadToken, idx, ciphertext, chunkHash, jwt, baseUrl = '') {
  const url = `${archiveBaseUrl(baseUrl)}/api/auth/link-archive-chunk/${archiveId}/${idx}`;
  await retryWithBackoff(async () => {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${jwt}`,
        'X-Upload-Token': uploadToken,
        'X-Chunk-Sha256': bytesToBase64(chunkHash),
      },
      body: ciphertext,
    });
    if (res.status === 204) return;
    if (res.status === 409) {
      // Hash collision for an already-stored chunk. Hard failure.
      throw new LinkArchiveError('chunk hash conflict', {
        status: 409,
        body: await readJson(res),
      });
    }
    throw new LinkArchiveError(`uploadChunk failed (${res.status})`, {
      status: res.status,
      body: await readJson(res),
    });
  });
}

/**
 * Uploads a single chunk to a presigned URL. Used for the s3 backend.
 * The presigned URL bakes in auth + bucket + key + TTL; the client
 * just PUTs the body and forwards the SHA-256 header the server
 * declared.
 *
 * @param {{ url: string, method: string, headers: object, contentSha256Header?: string }} entry
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} chunkHash
 * @returns {Promise<void>}
 */
export async function uploadChunkViaPresign(entry, ciphertext, chunkHash, baseUrl = '') {
  // Symmetrical with downloadChunkViaWindow: tolerate a path-only
  // `entry.url` by prepending the caller-supplied baseUrl. s3 always
  // returns absolute URLs so this is a no-op for the s3 path; only
  // matters if the postgres_bytea path is ever routed through the
  // presign helper (defensive — current call graph routes that
  // backend through `uploadChunk` instead).
  const url = entry.url.startsWith('/')
    ? `${archiveBaseUrl(baseUrl)}${entry.url}`
    : entry.url;
  await retryWithBackoff(async () => {
    const headers = { ...(entry.headers || {}) };
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream';
    if (entry.contentSha256Header) {
      headers[entry.contentSha256Header] = bytesToBase64(chunkHash);
    }
    const res = await fetch(url, {
      method: entry.method || 'PUT',
      headers,
      body: ciphertext,
    });
    if (res.ok) return;
    throw new LinkArchiveError(`presigned upload failed (${res.status})`, {
      status: res.status,
      body: null,
    });
  });
}

/**
 * Requests a fresh presigned-URL window for [from, to). Used by the
 * OLD device when it has uploaded the chunks issued by the previous
 * window. The server caps to_-_from to its window-size constant.
 *
 * @param {string} archiveId
 * @param {string} uploadToken
 * @param {number} from
 * @param {number} to
 * @param {string} jwt - the OLD device's auth bearer (the upload-window
 *   endpoint is JWT-gated).
 * @param {string} baseUrl
 * @returns {Promise<object>}
 */
export async function requestUploadWindow(archiveId, uploadToken, from, to, jwt, baseUrl = '') {
  const url = `${archiveBaseUrl(baseUrl)}/api/auth/link-archive-upload-window/${archiveId}`;
  return retryWithBackoff(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        'X-Upload-Token': uploadToken,
      },
      body: JSON.stringify({ from, to }),
    });
    if (!res.ok) {
      throw new LinkArchiveError(`requestUploadWindow failed (${res.status})`, {
        status: res.status,
        body: await readJson(res),
      });
    }
    return parseArchiveWindowResponse(
      await readJsonResponse(res, 'requestUploadWindow'),
      'requestUploadWindow',
    );
  });
}

/**
 * Symmetrical helper for the NEW device.
 *
 * @param {string} archiveId
 * @param {string} downloadToken
 * @param {number} from
 * @param {number} to
 * @param {string} baseUrl
 * @returns {Promise<object>}
 */
export async function requestDownloadWindow(archiveId, downloadToken, from, to, baseUrl = '') {
  const url = `${archiveBaseUrl(baseUrl)}/api/auth/link-archive-download-window/${archiveId}`;
  return retryWithBackoff(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Download-Token': downloadToken,
      },
      body: JSON.stringify({ from, to }),
    });
    if (!res.ok) {
      throw new LinkArchiveError(`requestDownloadWindow failed (${res.status})`, {
        status: res.status,
        body: await readJson(res),
      });
    }
    return parseArchiveWindowResponse(
      await readJsonResponse(res, 'requestDownloadWindow'),
      'requestDownloadWindow',
    );
  });
}

/**
 * Confirms a single uploaded chunk so the server verifies the
 * stored SHA-256 against the client-declared value and writes the
 * chunk row. For the postgres_bytea backend this is a no-op accept;
 * for s3 the server reads the object's native checksum and rejects
 * 422 on mismatch. Either way the client always calls this after
 * uploading.
 *
 * @param {string} archiveId
 * @param {string} uploadToken
 * @param {number} idx
 * @param {Uint8Array} chunkHash
 * @param {number} chunkSize
 * @param {string} jwt
 * @param {string} baseUrl
 * @returns {Promise<void>}
 */
export async function confirmChunk(archiveId, uploadToken, idx, chunkHash, chunkSize, jwt, baseUrl = '') {
  const url = `${archiveBaseUrl(baseUrl)}/api/auth/link-archive-confirm-chunk/${archiveId}/${idx}`;
  await retryWithBackoff(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        'X-Upload-Token': uploadToken,
      },
      body: JSON.stringify({
        chunkSha256: bytesToBase64(chunkHash),
        chunkSize,
      }),
    });
    if (res.status === 204) return;
    if (res.status === 409 || res.status === 422) {
      // Hard failure: hash mismatch. Do not retry.
      throw new LinkArchiveError(`confirmChunk rejected (${res.status})`, {
        status: res.status,
        body: await readJson(res),
      });
    }
    throw new LinkArchiveError(`confirmChunk failed (${res.status})`, {
      status: res.status,
      body: await readJson(res),
    });
  });
}

/**
 * Downloads a chunk from a presigned URL (s3 backend). The
 * postgres_bytea backend's window URL points at the in-API endpoint
 * and works with the same code path because both URLs resolve to a
 * GET that returns octet-stream bytes.
 *
 * `entry.url` may be either:
 *   - an absolute URL (s3 presigned URLs always are), or
 *   - a path-only string of the form `/api/auth/link-archive-chunk/...`
 *     (postgres_bytea backend's `inAPIChunkURL` returns this shape).
 *
 * In a normal browser the path-only form resolves against the page
 * origin and works. In an Electron renderer hosted under `app://`,
 * the page origin is `app://localhost/` and a relative `/api/...`
 * fetch resolves to the renderer's own protocol handler instead of
 * the real backend — surfacing as `Failed to fetch`. Prepending the
 * caller-supplied baseUrl when entry.url starts with `/` makes this
 * helper origin-safe for both transports.
 *
 * @param {{ url: string, method?: string, headers?: object }} entry
 * @param {string} baseUrl - Instance base URL; only consulted when
 *   `entry.url` is path-only.
 * @param {string} downloadToken - Required only for path-only in-API
 *   URLs; absolute object-store presigned URLs already carry auth in
 *   the URL/signature and must not receive Hush API headers.
 * @returns {Promise<Uint8Array>}
 */
export async function downloadChunkViaWindow(entry, baseUrl = '', downloadToken = '') {
  const isInAPIUrl = entry.url.startsWith('/');
  const url = isInAPIUrl
    ? `${archiveBaseUrl(baseUrl)}${entry.url}`
    : entry.url;
  return retryWithBackoff(async () => {
    const headers = { ...(entry.headers || {}) };
    if (isInAPIUrl && downloadToken) {
      headers['X-Download-Token'] = downloadToken;
    }
    const res = await fetch(url, {
      method: entry.method || 'GET',
      headers,
    });
    if (!res.ok) {
      throw new LinkArchiveError(`presigned download failed (${res.status})`, {
        status: res.status,
        body: null,
      });
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  });
}

/**
 * Finalises the archive on the server. Returns the missing-index list when
 * the server reports 409.
 *
 * @param {string} archiveId
 * @param {string} uploadToken
 * @param {string} jwt
 * @param {string} baseUrl
 * @returns {Promise<{ status: 'ok' } | { status: 'missing', missing: number[] }>}
 */
export async function finalizeArchive(archiveId, uploadToken, jwt, baseUrl = '') {
  const url = `${archiveBaseUrl(baseUrl)}/api/auth/link-archive-finalize/${archiveId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'X-Upload-Token': uploadToken,
    },
  });
  if (res.status === 200) return { status: 'ok' };
  const body = await readJson(res);
  if (res.status === 409 && body) {
    const parsed = parseArchiveFinalizeMissing(body);
    return { status: 'missing', missing: parsed.missing };
  }
  throw new LinkArchiveError(`finalizeArchive failed (${res.status})`, {
    status: res.status,
    body,
  });
}

/**
 * @param {string} archiveId
 * @param {string} downloadToken
 * @param {string} baseUrl
 * @returns {Promise<{ totalChunks: number, chunkSize: number, totalBytes: number, manifestHash: string, archiveSha256: string, chunkHashes: string[], expiresAt: string }>}
 */
export async function fetchManifest(archiveId, downloadToken, baseUrl = '') {
  const url = `${archiveBaseUrl(baseUrl)}/api/auth/link-archive-manifest/${archiveId}`;
  return retryWithBackoff(async () => {
    const res = await fetch(url, {
      headers: { 'X-Download-Token': downloadToken },
    });
    if (!res.ok) {
      throw new LinkArchiveError(`fetchManifest failed (${res.status})`, {
        status: res.status,
        body: await readJson(res),
      });
    }
    return parseArchiveManifest(await readJsonResponse(res, 'fetchManifest'));
  });
}

/**
 * Downloads a single chunk. Caller verifies the SHA-256 against the manifest;
 * a transient mismatch can be retried by the caller by calling this function
 * again. Network/5xx is auto-retried here.
 *
 * @param {string} archiveId
 * @param {string} downloadToken
 * @param {number} idx
 * @param {string} baseUrl
 * @returns {Promise<Uint8Array>}
 */
export async function downloadChunk(archiveId, downloadToken, idx, baseUrl = '') {
  const url = `${archiveBaseUrl(baseUrl)}/api/auth/link-archive-chunk/${archiveId}/${idx}`;
  return retryWithBackoff(async () => {
    const res = await fetch(url, {
      headers: { 'X-Download-Token': downloadToken },
    });
    if (!res.ok) {
      throw new LinkArchiveError(`downloadChunk failed (${res.status})`, {
        status: res.status,
        body: await readJson(res),
      });
    }
    const arrayBuffer = await res.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  });
}

/**
 * Best-effort delete; non-fatal on failure (the server purger reaps).
 * Returns whether the archive is known to be gone. Existing callers may
 * ignore the boolean when deletion is only opportunistic; retry paths
 * that need to free the single per-user archive slot must inspect it.
 *
 * @param {string} archiveId
 * @param {{ uploadToken?: string, downloadToken?: string }} tokens
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function deleteArchive(archiveId, tokens, baseUrl = '') {
  const url = `${archiveBaseUrl(baseUrl)}/api/auth/link-archive/${archiveId}`;
  const headers = {};
  if (tokens.uploadToken) headers['X-Upload-Token'] = tokens.uploadToken;
  if (tokens.downloadToken) headers['X-Download-Token'] = tokens.downloadToken;
  try {
    const res = await fetch(url, { method: 'DELETE', headers });
    return res.ok || res.status === 404 || res.status === 410;
  } catch {
    // Non-fatal; purger handles cleanup.
    return false;
  }
}

/**
 * Verifies that the chunkHash header value (base64) matches sha256(bytes).
 * Used by callers that want to double-check round-tripped data outside of
 * the encrypt/decrypt path.
 *
 * @param {Uint8Array} bytes
 * @param {string} expectedBase64
 * @returns {Promise<boolean>}
 */
export async function ciphertextMatchesHash(bytes, expectedBase64) {
  const actual = await sha256(bytes);
  return bytesToBase64(actual) === expectedBase64;
}

export { LinkArchiveError };
