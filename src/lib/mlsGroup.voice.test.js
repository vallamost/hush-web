import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createVoiceGroup,
  joinVoiceGroup,
  exportVoiceFrameKey,
  destroyVoiceGroup,
  performVoiceSelfUpdate,
  processVoiceCommit,
  removeMemberFromVoiceGroup,
  voiceChannelIdToBytes,
} from './mlsGroup';
import * as realHushCrypto from './hushCrypto';

// ---------------------------------------------------------------------------
// Shared mock factory
// ---------------------------------------------------------------------------

function makeDb() {
  return {};
}

function makeMlsStore() {
  return {
    preloadGroupState: vi.fn().mockResolvedValue(undefined),
    flushStorageCache: vi.fn().mockResolvedValue(undefined),
    setGroupEpoch: vi.fn().mockResolvedValue(undefined),
    getGroupEpoch: vi.fn().mockResolvedValue(0),
    deleteGroupEpoch: vi.fn().mockResolvedValue(undefined),
  };
}

function makeHushCrypto() {
  return {
    createGroup: vi.fn().mockResolvedValue({
      groupInfoBytes: new Uint8Array([1, 2, 3]),
      epoch: 0,
    }),
    joinGroupExternal: vi.fn().mockResolvedValue({
      commitBytes: new Uint8Array([4, 5, 6]),
      epoch: 1,
    }),
    mergePendingCommit: vi.fn().mockResolvedValue({
      groupInfoBytes: new Uint8Array([7, 8, 9]),
      epoch: 1,
    }),
    selfUpdate: vi.fn().mockResolvedValue({
      commitBytes: new Uint8Array([10, 11, 12]),
      groupInfoBytes: new Uint8Array([13, 14, 15]),
      epoch: 2,
    }),
    processMessage: vi.fn().mockResolvedValue({
      type: 'commit',
      epoch: 3,
    }),
    removeMembers: vi.fn().mockResolvedValue({
      commitBytes: new Uint8Array([16, 17, 18]),
      groupInfoBytes: new Uint8Array([19, 20, 21]),
      epoch: 4,
    }),
    exportVoiceFrameKey: vi.fn().mockResolvedValue({
      frameKeyBytes: new Uint8Array(32).fill(0xab),
      epoch: 1,
    }),
    exportGroupInfoBytes: vi.fn().mockResolvedValue({
      groupInfoBytes: new Uint8Array([91, 92, 93]),
    }),
  };
}

// HUSHHQ-97 regression guard: the hand-rolled hushCrypto mock must only name
// methods that actually exist on the real facade. A typo'd binding name (e.g.
// `exportGroupInfo` instead of `exportGroupInfoBytes`) previously passed CI
// because the mock defined the wrong name, then threw in production.
describe('hushCrypto mock fidelity', () => {
  it('only mocks methods that exist on the real hushCrypto facade', () => {
    for (const name of Object.keys(makeHushCrypto())) {
      expect(
        typeof realHushCrypto[name],
        `hushCrypto.${name} is mocked but does not exist on the real facade`,
      ).toBe('function');
    }
  });
});

function makeApi() {
  return {
    getMLSVoiceGroupInfo: vi.fn().mockResolvedValue({
      groupInfo: btoa(String.fromCharCode(1, 2, 3)),
      epoch: 0,
    }),
    putMLSVoiceGroupInfo: vi.fn().mockResolvedValue(undefined),
    postMLSVoiceCommit: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCredential() {
  return {
    signingPrivateKey: new Uint8Array([1]),
    signingPublicKey: new Uint8Array([2]),
    credentialBytes: new Uint8Array([3]),
  };
}

function makeDeps(overrides = {}) {
  return {
    db: makeDb(),
    token: 'test-token',
    credential: makeCredential(),
    mlsStore: makeMlsStore(),
    hushCrypto: makeHushCrypto(),
    api: makeApi(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// voiceChannelIdToBytes
// ---------------------------------------------------------------------------

describe('voiceChannelIdToBytes', () => {
  it('prefixes channelId with "voice:"', () => {
    const bytes = voiceChannelIdToBytes('ch-1');
    expect(new TextDecoder().decode(bytes)).toBe('voice:ch-1');
  });

  it('is distinct from plain channelIdToBytes', () => {
    const voice = voiceChannelIdToBytes('ch-1');
    const plain = new TextEncoder().encode('ch-1');
    expect(voice).not.toEqual(plain);
  });
});

// ---------------------------------------------------------------------------
// createVoiceGroup
// ---------------------------------------------------------------------------

describe('mlsGroup voice lifecycle', () => {
  let deps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('createVoiceGroup creates a voice MLS group and returns epoch', async () => {
    const result = await createVoiceGroup(deps, 'ch-1');

    expect(result).toEqual({ epoch: 0 });
    expect(deps.mlsStore.preloadGroupState).toHaveBeenCalledWith(deps.db);
    expect(deps.hushCrypto.createGroup).toHaveBeenCalledWith(
      voiceChannelIdToBytes('ch-1'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
    );
    expect(deps.mlsStore.flushStorageCache).toHaveBeenCalledWith(deps.db);
    expect(deps.api.putMLSVoiceGroupInfo).toHaveBeenCalledWith(
      'test-token',
      'ch-1',
      expect.any(String), // base64 groupInfoBytes
      0,
    );
    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'voice:ch-1', 0);
  });

  // HUSHHQ-97 regression: on rejoin after the server cleaned up the voice
  // group (room emptied), the local voice group still exists, so createGroup
  // throws GroupAlreadyExists. createVoiceGroup must adopt the existing local
  // group and republish its GroupInfo, NOT silently continue without a PUT.
  // Without this, two participants diverge and LiveKit reports InvalidKey.
  it('createVoiceGroup adopts and republishes an existing local group on GroupAlreadyExists', async () => {
    deps.hushCrypto.createGroup.mockRejectedValueOnce(new Error('GroupAlreadyExists'));
    deps.mlsStore.getGroupEpoch.mockResolvedValueOnce(5);

    const result = await createVoiceGroup(deps, 'ch-1');

    // Adopted the existing group via exportGroupInfoBytes (read-only).
    expect(deps.hushCrypto.exportGroupInfoBytes).toHaveBeenCalledWith(
      voiceChannelIdToBytes('ch-1'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
    );
    // Republished it to the server so other participants converge.
    expect(deps.api.putMLSVoiceGroupInfo).toHaveBeenCalledWith(
      'test-token',
      'ch-1',
      expect.any(String),
      5,
    );
    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'voice:ch-1', 5);
    expect(result).toEqual({ epoch: 5 });
    // Read-only adoption path must not flush (no MLS state mutation).
    expect(deps.mlsStore.flushStorageCache).not.toHaveBeenCalled();
  });

  it('createVoiceGroup rethrows a non-already-exists createGroup error', async () => {
    deps.hushCrypto.createGroup.mockRejectedValueOnce(new Error('storage backend offline'));
    await expect(createVoiceGroup(deps, 'ch-1')).rejects.toThrow('storage backend offline');
    expect(deps.api.putMLSVoiceGroupInfo).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // joinVoiceGroup
  // ---------------------------------------------------------------------------

  it('joinVoiceGroup joins existing voice group via External Commit', async () => {
    const result = await joinVoiceGroup(deps, 'ch-1');

    // External Commit path (groupInfo exists on server)
    expect(deps.hushCrypto.joinGroupExternal).toHaveBeenCalled();
    expect(deps.api.postMLSVoiceCommit).toHaveBeenCalledWith(
      'test-token',
      'ch-1',
      expect.any(String), // base64 commitBytes
      1, // joinResult.epoch
    );
    expect(deps.hushCrypto.mergePendingCommit).toHaveBeenCalled();
    expect(deps.api.putMLSVoiceGroupInfo).toHaveBeenCalled();
    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'voice:ch-1', 1);
    expect(result).toEqual({ epoch: 1 });
  });

  it('joinVoiceGroup falls back to createVoiceGroup when server returns null', async () => {
    deps.api.getMLSVoiceGroupInfo = vi.fn().mockResolvedValue(null);

    const result = await joinVoiceGroup(deps, 'ch-1');

    expect(deps.hushCrypto.createGroup).toHaveBeenCalled();
    expect(deps.hushCrypto.joinGroupExternal).not.toHaveBeenCalled();
    expect(result).toEqual({ epoch: 0 });
  });

  it('joinVoiceGroup falls back to createVoiceGroup when groupInfo field is absent', async () => {
    deps.api.getMLSVoiceGroupInfo = vi.fn().mockResolvedValue({ epoch: 0 });

    const result = await joinVoiceGroup(deps, 'ch-1');

    expect(deps.hushCrypto.createGroup).toHaveBeenCalled();
    expect(result).toEqual({ epoch: 0 });
  });

  // ---------------------------------------------------------------------------
  // exportVoiceFrameKey
  // ---------------------------------------------------------------------------

  it('exportVoiceFrameKey returns 32-byte key and epoch number', async () => {
    const result = await exportVoiceFrameKey(deps, 'ch-1');

    expect(deps.mlsStore.preloadGroupState).toHaveBeenCalledWith(deps.db);
    expect(deps.hushCrypto.exportVoiceFrameKey).toHaveBeenCalledWith(
      voiceChannelIdToBytes('ch-1'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
    );
    // Export is read-only - flush must NOT be called.
    expect(deps.mlsStore.flushStorageCache).not.toHaveBeenCalled();
    expect(result.frameKeyBytes).toBeInstanceOf(Uint8Array);
    expect(result.frameKeyBytes.length).toBe(32);
    expect(result.epoch).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // destroyVoiceGroup
  // ---------------------------------------------------------------------------

  it('destroyVoiceGroup clears local voice group state', async () => {
    await destroyVoiceGroup(deps, 'ch-1');

    expect(deps.mlsStore.deleteGroupEpoch).toHaveBeenCalledWith(deps.db, 'voice:ch-1');
    // No server call - server handles cleanup via LiveKit webhook.
    expect(deps.api.putMLSVoiceGroupInfo).not.toHaveBeenCalled();
    expect(deps.api.postMLSVoiceCommit).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // performVoiceSelfUpdate
  // ---------------------------------------------------------------------------

  it('performVoiceSelfUpdate advances epoch via self_update', async () => {
    const result = await performVoiceSelfUpdate(deps, 'ch-1');

    expect(deps.hushCrypto.selfUpdate).toHaveBeenCalledWith(
      voiceChannelIdToBytes('ch-1'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
    );
    expect(deps.api.postMLSVoiceCommit).toHaveBeenCalled();
    expect(deps.hushCrypto.mergePendingCommit).toHaveBeenCalled();
    expect(deps.api.putMLSVoiceGroupInfo).toHaveBeenCalled();
    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'voice:ch-1', 1);
    expect(result).toEqual({ epoch: 1 });
  });

  // ---------------------------------------------------------------------------
  // processVoiceCommit
  // ---------------------------------------------------------------------------

  it('processVoiceCommit processes incoming voice commit and updates epoch', async () => {
    const commitBytes = new Uint8Array([20, 21, 22]);
    const result = await processVoiceCommit(deps, 'ch-1', commitBytes);

    expect(deps.mlsStore.preloadGroupState).toHaveBeenCalledWith(deps.db);
    expect(deps.hushCrypto.processMessage).toHaveBeenCalledWith(
      voiceChannelIdToBytes('ch-1'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
      commitBytes,
    );
    expect(deps.mlsStore.flushStorageCache).toHaveBeenCalledWith(deps.db);
    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'voice:ch-1', 3);
    expect(result).toEqual({ type: 'commit', epoch: 3 });
  });

  // -------------------------------------------------------------------------
  // removeMemberFromVoiceGroup
  // -------------------------------------------------------------------------

  describe('removeMemberFromVoiceGroup', () => {
    it('removes a leaf by `userId:deviceId` and posts the commit via the injected voice API', async () => {
      await removeMemberFromVoiceGroup(deps, 'ch-1', 'u-leaver:d-leaver');

      // Crypto is invoked against the voice group id, NOT the bare
      // channel id, so the text-channel group state is never
      // touched by a voice eviction.
      expect(deps.hushCrypto.removeMembers).toHaveBeenCalledTimes(1);
      const args = deps.hushCrypto.removeMembers.mock.calls[0];
      expect(args[0]).toEqual(voiceChannelIdToBytes('ch-1'));
      expect(args[1]).toBe(deps.credential.signingPrivateKey);
      expect(args[2]).toBe(deps.credential.signingPublicKey);
      expect(args[3]).toBe(deps.credential.credentialBytes);
      // memberIdentitiesJson is the device-scoped identity, not a
      // bare user id. This is the load-bearing assertion that
      // closes PR #40's incorrect `participant.identity` removal
      // target.
      expect(args[4]).toBe(JSON.stringify(['u-leaver:d-leaver']));

      // Commit must reach the server through the deps-injected
      // (instance-scoped) voice API, never a raw apiLib call.
      expect(deps.api.postMLSVoiceCommit).toHaveBeenCalledTimes(1);
      const [token, channelId, commitB64, epoch, groupInfoB64] =
        deps.api.postMLSVoiceCommit.mock.calls[0];
      expect(token).toBe('test-token');
      expect(channelId).toBe('ch-1');
      expect(typeof commitB64).toBe('string');
      expect(typeof groupInfoB64).toBe('string');
      expect(epoch).toBe(4);

      // Persist under the voice-scoped epoch key so text-channel
      // epoch storage is unaffected.
      expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'voice:ch-1', 4);
    });

    it('throws before invoking crypto when memberIdentity is a bare user id (no colon)', async () => {
      await expect(
        removeMemberFromVoiceGroup(deps, 'ch-1', 'u-leaver-only'),
      ).rejects.toThrow(/userId:deviceId/);
      expect(deps.hushCrypto.removeMembers).not.toHaveBeenCalled();
      expect(deps.api.postMLSVoiceCommit).not.toHaveBeenCalled();
    });

    it('throws before invoking crypto when memberIdentity is missing the deviceId half', async () => {
      await expect(
        removeMemberFromVoiceGroup(deps, 'ch-1', 'u-leaver:'),
      ).rejects.toThrow(/userId:deviceId/);
      expect(deps.hushCrypto.removeMembers).not.toHaveBeenCalled();
    });

    it('throws when memberIdentity is empty', async () => {
      await expect(
        removeMemberFromVoiceGroup(deps, 'ch-1', ''),
      ).rejects.toThrow(/memberIdentity required/);
      expect(deps.hushCrypto.removeMembers).not.toHaveBeenCalled();
    });
  });
});
