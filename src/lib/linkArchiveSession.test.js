import { beforeEach, describe, expect, it, vi } from 'vitest';

const linkArchiveMock = vi.hoisted(() => ({
  LINK_ARCHIVE_CHUNK_SIZE: 4 * 1024 * 1024,
  LINK_ARCHIVE_NONCE_BASE_LEN: 8,
  computeManifestHash: vi.fn(async () => new Uint8Array(32).fill(7)),
  deriveArchiveKey: vi.fn(async () => ({
    key: { mocked: true },
    ephPublicKeyBytes: new Uint8Array(65).fill(9),
  })),
  encryptArchiveSlices: vi.fn(async () => ({
    ciphertexts: [new Uint8Array([5, 4, 3])],
    chunkHashes: [new Uint8Array(32).fill(8)],
  })),
}));

const chunkAtomicMock = vi.hoisted(() => ({
  CHUNK_ATOMIC_FORMAT: 'chunk-atomic-v3',
  buildChunkAtomicArchive: vi.fn(async () => ({
    chunks: [new Uint8Array([1, 2, 3])],
    archiveSha256: new Uint8Array(32).fill(6),
    chunkPlaintextHashes: [new Uint8Array(32).fill(4)],
  })),
}));

const transportMock = vi.hoisted(() => ({
  initArchive: vi.fn(),
  uploadChunk: vi.fn(),
  uploadChunkViaPresign: vi.fn(),
  downloadChunkViaWindow: vi.fn(),
  requestUploadWindow: vi.fn(),
  requestDownloadWindow: vi.fn(),
  confirmChunk: vi.fn(),
  fetchManifest: vi.fn(),
  finalizeArchive: vi.fn(),
  deleteArchive: vi.fn(),
}));

const exportStoreMock = vi.hoisted(() => ({
  initExport: vi.fn(),
  markChunkConfirmed: vi.fn(),
  setExportProgress: vi.fn(),
  markExportTerminal: vi.fn(),
  deleteExport: vi.fn(),
  unwrapUploadToken: vi.fn(),
  unwrapDownloadToken: vi.fn(),
  listExports: vi.fn(),
  listMissingChunks: vi.fn(),
  EXPORT_STATUS_TERMINAL: 'terminal_failure',
}));

vi.mock('./linkArchive', async () => {
  const actual = await vi.importActual('./linkArchive');
  return { ...actual, ...linkArchiveMock };
});
vi.mock('./linkArchiveChunkAtomic', async () => {
  const actual = await vi.importActual('./linkArchiveChunkAtomic');
  return { ...actual, ...chunkAtomicMock };
});
vi.mock('./linkArchiveTransport', () => transportMock);
vi.mock('./linkArchiveExportStore', () => exportStoreMock);

const { uploadArchiveSession, reclaimStaleExportArchives } = await import('./linkArchiveSession');

describe('uploadArchiveSession', () => {
  beforeEach(() => {
    transportMock.initArchive.mockReset();
    transportMock.uploadChunk.mockReset();
    transportMock.deleteArchive.mockReset();
    transportMock.confirmChunk.mockReset();
    transportMock.finalizeArchive.mockReset();
    exportStoreMock.listExports.mockReset();
    exportStoreMock.listExports.mockResolvedValue([]);
    exportStoreMock.deleteExport.mockReset();
    exportStoreMock.deleteExport.mockResolvedValue(undefined);
    exportStoreMock.unwrapUploadToken.mockReset();
    exportStoreMock.unwrapDownloadToken.mockReset();

    transportMock.initArchive.mockResolvedValue({
      archiveId: 'arch-1',
      uploadToken: 'upload-token',
      downloadToken: 'download-token',
      backendKind: 'postgres_bytea',
      uploadWindow: {
        from: 0,
        to: 1,
        urls: [{ idx: 0, url: '', method: 'PUT', headers: {} }],
      },
    });
    transportMock.uploadChunk.mockRejectedValue(new Error('upload boom'));
    transportMock.deleteArchive.mockResolvedValue(true);
  });

  it('best-effort deletes the server archive when upload fails after init', async () => {
    await expect(uploadArchiveSession({
      token: 'jwt',
      sessionPublicKeyBase64: 'session-pub',
      baseUrl: 'https://api.example.com',
      historySnapshot: { version: 1 },
      guildMetadataKeySnapshot: null,
      transcriptBlob: null,
    })).rejects.toThrow('upload boom');

    expect(transportMock.deleteArchive).toHaveBeenCalledWith(
      'arch-1',
      { uploadToken: 'upload-token', downloadToken: 'download-token' },
      'https://api.example.com',
    );
  });

  it('reclaims a stale terminal export before allocating a new archive', async () => {
    // A prior failed transfer left a terminal-status row behind plus a
    // live server-side allocation. Without reclaim, the upcoming init
    // would hit HTTP 409 ("initArchive failed") until the server's
    // 30-min grace expires.
    exportStoreMock.listExports.mockResolvedValueOnce([
      {
        archiveId: 'stale-arch',
        baseUrl: 'https://api.example.com',
        status: 'terminal_failure',
        uploadTokenWrapped: { nonce: new Uint8Array(12), ciphertext: new Uint8Array(48) },
        downloadTokenWrapped: { nonce: new Uint8Array(12), ciphertext: new Uint8Array(48) },
      },
    ]);
    exportStoreMock.unwrapUploadToken.mockResolvedValueOnce('stale-up-token');
    exportStoreMock.unwrapDownloadToken.mockResolvedValueOnce('stale-down-token');
    // initArchive succeeds the second pass — we don't even reach upload here.
    transportMock.initArchive.mockResolvedValueOnce({
      archiveId: 'arch-2',
      uploadToken: 'upload-token-2',
      downloadToken: 'download-token-2',
      backendKind: 'postgres_bytea',
      uploadWindow: {
        from: 0,
        to: 1,
        urls: [{ idx: 0, url: '', method: 'PUT', headers: {} }],
      },
    });
    transportMock.uploadChunk.mockResolvedValue(undefined);
    transportMock.confirmChunk.mockResolvedValue(undefined);
    transportMock.finalizeArchive.mockResolvedValueOnce({ status: 'ok' });

    await uploadArchiveSession({
      token: 'jwt',
      sessionPublicKeyBase64: 'session-pub',
      baseUrl: 'https://api.example.com',
      historySnapshot: null,
      guildMetadataKeySnapshot: null,
      transcriptBlob: null,
      rootPrivateKey: new Uint8Array(32).fill(1),
    });

    expect(transportMock.deleteArchive).toHaveBeenCalledWith(
      'stale-arch',
      { uploadToken: 'stale-up-token', downloadToken: 'stale-down-token' },
      'https://api.example.com',
    );
    expect(exportStoreMock.deleteExport).toHaveBeenCalledWith('stale-arch');
    expect(transportMock.initArchive).toHaveBeenCalledTimes(1);
  });

  it('surfaces a user-facing message instead of "initArchive failed" on 409', async () => {
    transportMock.initArchive.mockReset();
    const conflict = Object.assign(new Error('initArchive failed'), { status: 409 });
    transportMock.initArchive.mockRejectedValueOnce(conflict);

    await expect(uploadArchiveSession({
      token: 'jwt',
      sessionPublicKeyBase64: 'session-pub',
      baseUrl: 'https://api.example.com',
      historySnapshot: null,
      guildMetadataKeySnapshot: null,
      transcriptBlob: null,
    })).rejects.toThrowError(
      /previous device-link transfer is still occupying the server slot/i,
    );
  });
});

describe('reclaimStaleExportArchives', () => {
  beforeEach(() => {
    transportMock.deleteArchive.mockReset();
    transportMock.deleteArchive.mockResolvedValue(undefined);
    exportStoreMock.listExports.mockReset();
    exportStoreMock.deleteExport.mockReset();
    exportStoreMock.deleteExport.mockResolvedValue(undefined);
    exportStoreMock.unwrapUploadToken.mockReset();
    exportStoreMock.unwrapDownloadToken.mockReset();
  });

  it('leaves in-progress rows alone so resume still works', async () => {
    exportStoreMock.listExports.mockResolvedValueOnce([
      { archiveId: 'live-arch', baseUrl: 'https://api.example.com', status: 'in_progress' },
    ]);

    const reclaimed = await reclaimStaleExportArchives({
      baseUrl: 'https://api.example.com',
      rootPrivateKey: new Uint8Array(32).fill(2),
    });

    expect(reclaimed).toBe(0);
    expect(transportMock.deleteArchive).not.toHaveBeenCalled();
    expect(exportStoreMock.deleteExport).not.toHaveBeenCalled();
  });

  it('keeps the local row when the server DELETE fails so cleanup can retry', async () => {
    exportStoreMock.listExports.mockResolvedValueOnce([
      {
        archiveId: 'gone-arch',
        baseUrl: 'https://api.example.com',
        status: 'terminal_failure',
        uploadTokenWrapped: { nonce: new Uint8Array(12), ciphertext: new Uint8Array(48) },
      },
    ]);
    exportStoreMock.unwrapUploadToken.mockResolvedValueOnce('gone-up-token');
    transportMock.deleteArchive.mockResolvedValueOnce(false);

    await expect(reclaimStaleExportArchives({
      baseUrl: 'https://api.example.com',
      rootPrivateKey: new Uint8Array(32).fill(3),
    })).rejects.toThrow(/could not be cleaned up/i);

    expect(exportStoreMock.deleteExport).not.toHaveBeenCalled();
  });

  it('is a no-op when no rootPrivateKey is supplied', async () => {
    const reclaimed = await reclaimStaleExportArchives({
      baseUrl: 'https://api.example.com',
      rootPrivateKey: null,
    });

    expect(reclaimed).toBe(0);
    expect(exportStoreMock.listExports).not.toHaveBeenCalled();
  });
});
