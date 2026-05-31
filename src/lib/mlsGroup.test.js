/**
 * Tests for mlsGroup.js - chat channel MLS group lifecycle operations.
 *
 * Covers:
 *   - createChannelGroup: creates group, flushes state, stores epoch
 *   - joinChannelGroup: joins via External Commit, posts commit to server
 *   - addMemberToChannel: adds member, posts commit, returns welcomeBytes
 *   - removeMemberFromChannel: removes member, posts commit
 *   - encryptMessage: encrypts plaintext, returns ciphertext + localId
 *   - decryptMessage: decrypts ciphertext, returns plaintext for application messages
 *   - decryptMessage: returns null plaintext for commit messages
 *   - Error propagation: no silent failures in crypto operations
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createChannelGroup,
  joinChannelGroup,
  joinGuildMetadataGroup,
  addMemberToChannel,
  removeMemberFromChannel,
  encryptMessage,
  decryptMessage,
  catchupCommits,
} from './mlsGroup.js';

// ---------------------------------------------------------------------------
// Mock factories - mirrors mlsGroup.voice.test.js pattern
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
    setLocalPlaintext: vi.fn().mockResolvedValue(undefined),
    getLocalPlaintext: vi.fn().mockResolvedValue(null),
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
    exportGroupInfoBytes: vi.fn().mockResolvedValue({
      groupInfoBytes: new Uint8Array([7, 8, 9]),
    }),
    mergePendingCommit: vi.fn().mockResolvedValue({
      groupInfoBytes: new Uint8Array([28, 29, 30]),
      epoch: 2,
    }),
    addMembers: vi.fn().mockResolvedValue({
      commitBytes: new Uint8Array([10, 11, 12]),
      groupInfoBytes: new Uint8Array([13, 14, 15]),
      welcomeBytes: new Uint8Array([16, 17, 18]),
      epoch: 2,
    }),
    removeMembers: vi.fn().mockResolvedValue({
      commitBytes: new Uint8Array([19, 20, 21]),
      groupInfoBytes: new Uint8Array([22, 23, 24]),
      epoch: 3,
    }),
    createMessage: vi.fn().mockResolvedValue({
      messageBytes: new Uint8Array([25, 26, 27]),
    }),
    processMessage: vi.fn().mockResolvedValue({
      type: 'application',
      plaintext: new TextEncoder().encode('hello world'),
      senderIdentity: 'sender-pub-key',
      epoch: 4,
    }),
  };
}

function makeApi() {
  return {
    putMLSGroupInfo: vi.fn().mockResolvedValue(undefined),
    getMLSGroupInfo: vi.fn().mockResolvedValue({
      groupInfo: btoa(String.fromCharCode(1, 2, 3)),
      epoch: 0,
    }),
    postMLSCommit: vi.fn().mockResolvedValue(undefined),
    getMLSCommitsSinceEpoch: vi.fn().mockResolvedValue({ commits: [] }),
    getGuildMetadataGroupInfo: vi.fn().mockResolvedValue({
      groupInfo: btoa(String.fromCharCode(4, 5, 6)),
      epoch: 0,
    }),
    putGuildMetadataGroupInfo: vi.fn().mockResolvedValue(undefined),
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
// createChannelGroup
// ---------------------------------------------------------------------------

describe('createChannelGroup', () => {
  let deps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('calls createGroup with channelId bytes and credential fields', async () => {
    await createChannelGroup(deps, 'ch-1');

    expect(deps.mlsStore.preloadGroupState).toHaveBeenCalledWith(deps.db);
    expect(deps.hushCrypto.createGroup).toHaveBeenCalledWith(
      new TextEncoder().encode('ch-1'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
    );
  });

  it('flushes storage cache after createGroup', async () => {
    await createChannelGroup(deps, 'ch-1');
    expect(deps.mlsStore.flushStorageCache).toHaveBeenCalledWith(deps.db);
  });

  it('stores GroupInfo on the server with the returned epoch', async () => {
    await createChannelGroup(deps, 'ch-1');
    expect(deps.api.putMLSGroupInfo).toHaveBeenCalledWith(
      'test-token',
      'ch-1',
      expect.any(String), // base64 groupInfoBytes
      0,                  // epoch from mock
    );
  });

  it('sets local group epoch after creation', async () => {
    await createChannelGroup(deps, 'ch-1');
    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'ch-1', 0);
  });

  it('returns groupInfoBytes and epoch', async () => {
    const result = await createChannelGroup(deps, 'ch-1');
    expect(result.epoch).toBe(0);
    expect(result.groupInfoBytes).toBeInstanceOf(Uint8Array);
  });

  it('throws when createGroup returns empty groupInfoBytes', async () => {
    deps.hushCrypto.createGroup.mockResolvedValueOnce({
      groupInfoBytes: new Uint8Array(0),
      epoch: 0,
    });

    await expect(createChannelGroup(deps, 'ch-1')).rejects.toThrow(
      'createGroup returned empty groupInfoBytes',
    );
  });

  it('throws when no credential is available', async () => {
    deps.credential = null;
    await expect(createChannelGroup(deps, 'ch-1')).rejects.toThrow(
      'No credential available',
    );
  });
});

// ---------------------------------------------------------------------------
// joinChannelGroup
// ---------------------------------------------------------------------------

describe('joinChannelGroup', () => {
  let deps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('joins via External Commit and posts commit to server', async () => {
    await joinChannelGroup(deps, 'ch-2');

    expect(deps.hushCrypto.joinGroupExternal).toHaveBeenCalled();
    expect(deps.api.postMLSCommit).toHaveBeenCalledWith(
      'test-token',
      'ch-2',
      expect.any(String), // base64 commit
      expect.any(String), // base64 groupInfo
      1,                  // server epoch 0 -> commit advances to epoch 1
    );
  });

  it('merges the pending External Commit locally after posting it', async () => {
    await joinChannelGroup(deps, 'ch-2');
    expect(deps.hushCrypto.mergePendingCommit).toHaveBeenCalledWith(
      new TextEncoder().encode('ch-2'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
    );
  });

  it('sets local group epoch from the merged External Commit', async () => {
    await joinChannelGroup(deps, 'ch-2');
    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'ch-2', 2);
  });

  it('updates server group info with the merged External Commit state', async () => {
    await joinChannelGroup(deps, 'ch-2');

    expect(deps.api.putMLSGroupInfo).toHaveBeenLastCalledWith(
      'test-token',
      'ch-2',
      expect.any(String),
      2,
    );
  });

  it('returns without joining when server has no GroupInfo', async () => {
    deps.api.getMLSGroupInfo.mockResolvedValueOnce(null);
    await joinChannelGroup(deps, 'ch-2');

    // No External Commit should be attempted when no group exists
    expect(deps.hushCrypto.joinGroupExternal).not.toHaveBeenCalled();
  });

  it('returns without joining when groupInfo field is absent', async () => {
    deps.api.getMLSGroupInfo.mockResolvedValueOnce({ groupInfo: null });
    await joinChannelGroup(deps, 'ch-2');

    expect(deps.hushCrypto.joinGroupExternal).not.toHaveBeenCalled();
  });

  it('preloads and flushes storage cache around WASM calls', async () => {
    await joinChannelGroup(deps, 'ch-2');

    expect(deps.mlsStore.preloadGroupState).toHaveBeenCalledWith(deps.db);
    expect(deps.mlsStore.flushStorageCache).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// joinGuildMetadataGroup
// ---------------------------------------------------------------------------

describe('joinGuildMetadataGroup', () => {
  let deps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('finalises the metadata group join locally and updates server group info', async () => {
    await joinGuildMetadataGroup(deps, 'guild-1');

    expect(deps.hushCrypto.joinGroupExternal).toHaveBeenCalled();
    expect(deps.hushCrypto.mergePendingCommit).toHaveBeenCalledWith(
      new TextEncoder().encode('guild-1'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
    );
    expect(deps.api.putGuildMetadataGroupInfo).toHaveBeenLastCalledWith(
      'test-token',
      'guild-1',
      expect.any(String),
      2,
    );
    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'guild-meta:guild-1', 2);
  });

  it('returns without joining when the server has no guild metadata group info', async () => {
    deps.api.getGuildMetadataGroupInfo.mockResolvedValueOnce(null);

    await joinGuildMetadataGroup(deps, 'guild-1');

    expect(deps.hushCrypto.joinGroupExternal).not.toHaveBeenCalled();
    expect(deps.hushCrypto.mergePendingCommit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// addMemberToChannel
// ---------------------------------------------------------------------------

describe('addMemberToChannel', () => {
  let deps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('calls addMembers with key package and posts commit', async () => {
    const keyPackageBytes = new Uint8Array([99, 100, 101]);
    await addMemberToChannel(deps, 'ch-3', keyPackageBytes);

    expect(deps.hushCrypto.addMembers).toHaveBeenCalledWith(
      new TextEncoder().encode('ch-3'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
      expect.stringContaining('['), // JSON array of base64 key packages
    );
    expect(deps.api.postMLSCommit).toHaveBeenCalledWith(
      'test-token',
      'ch-3',
      expect.any(String),
      expect.any(String),
      2, // epoch from addMembers mock
    );
  });

  it('returns welcomeBytes for the new member', async () => {
    const keyPackageBytes = new Uint8Array([1, 2, 3]);
    const result = await addMemberToChannel(deps, 'ch-3', keyPackageBytes);

    expect(result.welcomeBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.welcomeBytes)).toEqual([16, 17, 18]);
  });

  it('updates local group epoch after adding member', async () => {
    const keyPackageBytes = new Uint8Array([1, 2, 3]);
    await addMemberToChannel(deps, 'ch-3', keyPackageBytes);

    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'ch-3', 2);
  });

  it('propagates addMembers error without wrapping in plaintext', async () => {
    deps.hushCrypto.addMembers.mockRejectedValueOnce(new Error('MLS addMembers failed'));
    const keyPackageBytes = new Uint8Array([1]);

    await expect(addMemberToChannel(deps, 'ch-3', keyPackageBytes)).rejects.toThrow(
      'MLS addMembers failed',
    );
  });

  // HUSHHQ-99 regression: the originator must merge its own add-commit before
  // sending any further message. Without it the originator stays at the old
  // epoch, so the just-added member (who joined at the new epoch via the
  // Welcome) cannot decrypt the originator's first message.
  it('merges the pending commit after posting so the originator advances epoch', async () => {
    const keyPackageBytes = new Uint8Array([1, 2, 3]);
    await addMemberToChannel(deps, 'ch-3', keyPackageBytes);

    expect(deps.hushCrypto.mergePendingCommit).toHaveBeenCalledWith(
      new TextEncoder().encode('ch-3'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
    );
    // Post happens before merge.
    const postOrder = deps.api.postMLSCommit.mock.invocationCallOrder[0];
    const mergeOrder = deps.hushCrypto.mergePendingCommit.mock.invocationCallOrder[0];
    expect(postOrder).toBeLessThan(mergeOrder);
  });
});

// ---------------------------------------------------------------------------
// removeMemberFromChannel
// ---------------------------------------------------------------------------

describe('removeMemberFromChannel', () => {
  let deps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('calls removeMembers with member identity and posts commit', async () => {
    await removeMemberFromChannel(deps, 'ch-4', 'member-identity-hex');

    expect(deps.hushCrypto.removeMembers).toHaveBeenCalledWith(
      new TextEncoder().encode('ch-4'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
      expect.stringContaining('member-identity-hex'),
    );
    expect(deps.api.postMLSCommit).toHaveBeenCalledWith(
      'test-token',
      'ch-4',
      expect.any(String),
      expect.any(String),
      3, // epoch from removeMembers mock
    );
  });

  it('updates local group epoch from the merged commit after removing member', async () => {
    // HUSHHQ-99: setGroupEpoch now reflects the merged epoch (the group state
    // actually advances), not the bare removeMembers-reported epoch.
    await removeMemberFromChannel(deps, 'ch-4', 'member-to-remove');
    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'ch-4', 2);
  });

  // HUSHHQ-99 regression: merge the removal commit so the originator advances
  // past the removal before sending. Without it the originator stays at the old
  // epoch where the removed member still holds keys.
  it('merges the pending commit after posting the removal', async () => {
    await removeMemberFromChannel(deps, 'ch-4', 'member-to-remove');
    expect(deps.hushCrypto.mergePendingCommit).toHaveBeenCalledWith(
      new TextEncoder().encode('ch-4'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
    );
  });

  it('propagates removeMembers error', async () => {
    deps.hushCrypto.removeMembers.mockRejectedValueOnce(new Error('member not found'));

    await expect(
      removeMemberFromChannel(deps, 'ch-4', 'unknown-member'),
    ).rejects.toThrow('member not found');
  });
});

// ---------------------------------------------------------------------------
// encryptMessage
// ---------------------------------------------------------------------------

describe('encryptMessage', () => {
  let deps;

  beforeEach(() => {
    deps = makeDeps();
    // Group epoch already set (non-null) so lazy join is skipped
    deps.mlsStore.getGroupEpoch.mockResolvedValue(0);
  });

  it('stores plaintext in local cache before encrypting', async () => {
    await encryptMessage(deps, 'ch-5', 'hello world');

    // setLocalPlaintext must be called before createMessage
    const setOrder = deps.mlsStore.setLocalPlaintext.mock.invocationCallOrder[0];
    const createOrder = deps.hushCrypto.createMessage.mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(createOrder);
  });

  it('returns ciphertext bytes and a localId', async () => {
    const result = await encryptMessage(deps, 'ch-5', 'test');

    expect(result.messageBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.messageBytes)).toEqual([25, 26, 27]);
    expect(typeof result.localId).toBe('string');
    expect(result.localId.length).toBeGreaterThan(0);
  });

  it('calls createMessage with UTF-8 encoded plaintext', async () => {
    await encryptMessage(deps, 'ch-5', 'hello');

    const args = deps.hushCrypto.createMessage.mock.calls[0];
    const plaintextArg = args[4]; // 5th argument is the plaintext bytes
    expect(new TextDecoder().decode(plaintextArg)).toBe('hello');
  });

  it('does not wrap encryption errors in a plaintext envelope', async () => {
    deps.hushCrypto.createMessage.mockRejectedValueOnce(new Error('WASM encrypt error'));

    await expect(encryptMessage(deps, 'ch-5', 'test')).rejects.toThrow('WASM encrypt error');
  });

  it('result never contains _hush_plaintext field (no plaintext fallback)', async () => {
    const result = await encryptMessage(deps, 'ch-5', 'secret');

    expect(result).not.toHaveProperty('_hush_plaintext');
    expect(result).not.toHaveProperty('plaintext');
    expect(JSON.stringify(result)).not.toContain('_hush_plaintext');
  });

  it('different calls produce different localIds (UUID uniqueness)', async () => {
    const r1 = await encryptMessage(deps, 'ch-5', 'msg-1');
    const r2 = await encryptMessage(deps, 'ch-5', 'msg-2');
    expect(r1.localId).not.toBe(r2.localId);
  });

  it('rejoins and retries once when createMessage fails with a "Group not found" desync', async () => {
    deps.mlsStore.getGroupEpoch
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(null);
    deps.hushCrypto.createMessage
      .mockRejectedValueOnce(new Error('Group not found'))
      .mockResolvedValueOnce({ messageBytes: new Uint8Array([90, 91, 92]) });

    const result = await encryptMessage(deps, 'ch-5', 'hello again');

    expect(deps.mlsStore.deleteGroupEpoch).toHaveBeenCalledWith(deps.db, 'ch-5');
    expect(deps.api.getMLSGroupInfo).toHaveBeenCalledWith('test-token', 'ch-5');
    expect(deps.api.putMLSGroupInfo).toHaveBeenLastCalledWith(
      'test-token',
      'ch-5',
      expect.any(String),
      2,
    );
    expect(deps.hushCrypto.createMessage).toHaveBeenCalledTimes(2);
    expect(Array.from(result.messageBytes)).toEqual([90, 91, 92]);
  });

  it('does NOT recover from GroupStateError(UseAfterEviction) — eviction must propagate', async () => {
    // SECURITY: an evicted MLS leaf must not silently rejoin via send
    // recovery. The error must propagate; the rejoin/retry side
    // effects must not run.
    deps.hushCrypto.createMessage.mockRejectedValueOnce(
      new Error('GroupStateError(UseAfterEviction)'),
    );

    await expect(encryptMessage(deps, 'ch-5', 'hello again')).rejects.toThrow(
      /UseAfterEviction/,
    );

    expect(deps.mlsStore.deleteGroupEpoch).not.toHaveBeenCalled();
    expect(deps.api.getMLSGroupInfo).not.toHaveBeenCalled();
    expect(deps.api.putMLSGroupInfo).not.toHaveBeenCalled();
    expect(deps.hushCrypto.createMessage).toHaveBeenCalledTimes(1);
  });

  it('does NOT recover from eviction-shaped variants ("after eviction" / "evicted" / "AfterEviction")', async () => {
    deps.hushCrypto.createMessage.mockRejectedValueOnce(
      new Error('GroupStateError(UseAfterEviction): leaf removed, evicted'),
    );
    await expect(encryptMessage(deps, 'ch-5', 'x')).rejects.toThrow(/evicted/);
    expect(deps.mlsStore.deleteGroupEpoch).not.toHaveBeenCalled();
    expect(deps.api.getMLSGroupInfo).not.toHaveBeenCalled();
    expect(deps.api.putMLSGroupInfo).not.toHaveBeenCalled();
    expect(deps.hushCrypto.createMessage).toHaveBeenCalledTimes(1);

    deps.hushCrypto.createMessage.mockClear();
    deps.mlsStore.deleteGroupEpoch.mockClear();
    deps.api.getMLSGroupInfo.mockClear();
    deps.api.putMLSGroupInfo.mockClear();

    deps.hushCrypto.createMessage.mockRejectedValueOnce(
      new Error('member after eviction'),
    );
    await expect(encryptMessage(deps, 'ch-5', 'y')).rejects.toThrow(
      /after eviction/,
    );
    expect(deps.mlsStore.deleteGroupEpoch).not.toHaveBeenCalled();
    expect(deps.api.getMLSGroupInfo).not.toHaveBeenCalled();
    expect(deps.api.putMLSGroupInfo).not.toHaveBeenCalled();
    expect(deps.hushCrypto.createMessage).toHaveBeenCalledTimes(1);

    deps.hushCrypto.createMessage.mockClear();
    deps.mlsStore.deleteGroupEpoch.mockClear();
    deps.api.getMLSGroupInfo.mockClear();
    deps.api.putMLSGroupInfo.mockClear();

    deps.hushCrypto.createMessage.mockRejectedValueOnce(
      new Error('GroupStateError(MemberAfterEviction)'),
    );
    await expect(encryptMessage(deps, 'ch-5', 'z')).rejects.toThrow(
      /AfterEviction/,
    );
    expect(deps.mlsStore.deleteGroupEpoch).not.toHaveBeenCalled();
    expect(deps.api.getMLSGroupInfo).not.toHaveBeenCalled();
    expect(deps.api.putMLSGroupInfo).not.toHaveBeenCalled();
    expect(deps.hushCrypto.createMessage).toHaveBeenCalledTimes(1);
  });

  it('does NOT recover when a wrapped error mentions both UseAfterEviction and Group not found', async () => {
    // Belt-and-suspenders: an upstream wrap that bundles both
    // strings must still fail closed because of the eviction
    // marker.
    deps.hushCrypto.createMessage.mockRejectedValueOnce(
      new Error('GroupStateError(UseAfterEviction): Group not found'),
    );

    await expect(encryptMessage(deps, 'ch-5', 'hello again')).rejects.toThrow(
      /UseAfterEviction/,
    );

    expect(deps.mlsStore.deleteGroupEpoch).not.toHaveBeenCalled();
    expect(deps.api.getMLSGroupInfo).not.toHaveBeenCalled();
    expect(deps.api.putMLSGroupInfo).not.toHaveBeenCalled();
    expect(deps.hushCrypto.createMessage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// decryptMessage
// ---------------------------------------------------------------------------

describe('decryptMessage', () => {
  let deps;

  beforeEach(() => {
    deps = makeDeps();
    deps.mlsStore.getGroupEpoch.mockResolvedValue(0);
  });

  it('returns decoded plaintext string for application messages', async () => {
    const messageBytes = new Uint8Array([1, 2, 3]);
    const result = await decryptMessage(deps, 'ch-6', messageBytes);

    expect(result.plaintext).toBe('hello world');
    expect(result.type).toBe('application');
    expect(result.senderIdentity).toBe('sender-pub-key');
    expect(typeof result.epoch).toBe('number');
  });

  it('calls processMessage with correct channelId bytes', async () => {
    const messageBytes = new Uint8Array([4, 5, 6]);
    await decryptMessage(deps, 'ch-6', messageBytes);

    expect(deps.hushCrypto.processMessage).toHaveBeenCalledWith(
      new TextEncoder().encode('ch-6'),
      deps.credential.signingPrivateKey,
      deps.credential.signingPublicKey,
      deps.credential.credentialBytes,
      messageBytes,
    );
  });

  it('returns null plaintext for commit messages', async () => {
    deps.hushCrypto.processMessage.mockResolvedValueOnce({
      type: 'commit',
      plaintext: null,
      epoch: 5,
    });

    const result = await decryptMessage(deps, 'ch-6', new Uint8Array([1]));

    expect(result.plaintext).toBeNull();
    expect(result.type).toBe('commit');
  });

  it('updates epoch in store after processing a commit message', async () => {
    deps.hushCrypto.processMessage.mockResolvedValueOnce({
      type: 'commit',
      plaintext: null,
      epoch: 7,
    });

    await decryptMessage(deps, 'ch-6', new Uint8Array([1]));

    expect(deps.mlsStore.setGroupEpoch).toHaveBeenCalledWith(deps.db, 'ch-6', 7);
  });

  it('does not update epoch store for application messages', async () => {
    await decryptMessage(deps, 'ch-6', new Uint8Array([1]));

    // setGroupEpoch must NOT be called for application messages
    expect(deps.mlsStore.setGroupEpoch).not.toHaveBeenCalled();
  });

  it('preloads and flushes storage cache around WASM call', async () => {
    await decryptMessage(deps, 'ch-6', new Uint8Array([1]));

    expect(deps.mlsStore.preloadGroupState).toHaveBeenCalledWith(deps.db);
    expect(deps.mlsStore.flushStorageCache).toHaveBeenCalled();
  });

  it('propagates decryption errors without swallowing them', async () => {
    deps.hushCrypto.processMessage.mockRejectedValueOnce(new Error('decryption failed'));

    await expect(
      decryptMessage(deps, 'ch-6', new Uint8Array([1, 2])),
    ).rejects.toThrow('decryption failed');
  });
});

// ---------------------------------------------------------------------------
// catchupCommits
// ---------------------------------------------------------------------------

describe('catchupCommits', () => {
  let deps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('forwards the trusted baseUrl to api.getMLSCommitsSinceEpoch (PR #13 JWT leak regression)', async () => {
    // Without explicit baseUrl threading, the per-instance JWT was
    // sent to the current origin instead of the issuing instance,
    // leaking it cross-origin. catchupCommits must pass the baseUrl
    // from deps as the 5th argument so the request hits the owning
    // instance.
    deps.baseUrl = 'https://chat.example.com';

    await catchupCommits(deps, 'ch-7');

    expect(deps.api.getMLSCommitsSinceEpoch).toHaveBeenCalledWith(
      'test-token',
      'ch-7',
      0,
      100,
      'https://chat.example.com',
    );
  });

  it('defaults baseUrl to empty string when omitted from deps (backward-compat)', async () => {
    await catchupCommits(deps, 'ch-7');

    expect(deps.api.getMLSCommitsSinceEpoch).toHaveBeenCalledWith(
      'test-token',
      'ch-7',
      0,
      100,
      '',
    );
  });
});
