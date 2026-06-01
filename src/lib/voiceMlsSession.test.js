import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createVoiceMlsSession } from './voiceMlsSession.js';

/**
 * Fast, server-free regression guard for the HUSHHQ-104 integration seam.
 *
 * The voice channel WS subscription is owned by voiceMlsSession, NOT by the
 * text-channel sync hook (useGuildChannelIds is text-only by design). HUSHHQ-104
 * shipped because the voice path registered an mls.commit handler but never
 * subscribed to the channel topic, so the server never fanned the joiner's
 * commit to the creator. These tests lock that subscription in place and pin the
 * own-commit skip + voice/channel filtering that the dispatch depends on.
 *
 * The converged-state proof lives in the two-process e2e
 * (hush-server internal/e2e/voice_convergence_test.go); this is the cheap unit
 * net that runs on every PR.
 */
describe('createVoiceMlsSession', () => {
  const CHANNEL_ID = 'chan-1';
  const USER_ID = 'user-self';
  const DEVICE_ID = 'device-self';

  let wsClient;
  let handlers;
  let mlsGroup;
  let mlsStore;
  let onFrameKey;
  let onCommitError;

  function buildDeps(overrides = {}) {
    return {
      wsClient,
      channelId: CHANNEL_ID,
      getActiveChannelId: () => CHANNEL_ID,
      currentUserId: USER_ID,
      getDeviceId: () => DEVICE_ID,
      getStore: vi.fn(async () => ({})),
      getToken: () => 'token',
      mlsStore,
      hushCrypto: {},
      mlsGroup,
      voiceApi: {},
      onFrameKey,
      onCommitError,
      ...overrides,
    };
  }

  function voiceCommit(overrides = {}) {
    return {
      group_type: 'voice',
      channel_id: CHANNEL_ID,
      sender_id: 'user-other',
      sender_device_id: 'device-other',
      commit_bytes: btoa('commit'),
      ...overrides,
    };
  }

  beforeEach(() => {
    handlers = {};
    wsClient = {
      on: vi.fn((type, cb) => {
        handlers[type] = cb;
      }),
      off: vi.fn(),
      subscribeChannel: vi.fn(),
      unsubscribeChannel: vi.fn(),
    };
    mlsGroup = {
      processVoiceCommit: vi.fn(async () => ({ type: 'commit', epoch: 1 })),
      exportVoiceFrameKey: vi.fn(async () => ({ frameKeyBytes: new Uint8Array([1, 2, 3]), epoch: 1 })),
      destroyVoiceGroup: vi.fn(async () => {}),
    };
    mlsStore = { getCredential: vi.fn(async () => ({})) };
    onFrameKey = vi.fn(async () => {});
    onCommitError = vi.fn();
  });

  it('subscribes to the voice channel topic on creation (HUSHHQ-104 lock-in)', () => {
    createVoiceMlsSession(buildDeps());
    expect(wsClient.subscribeChannel).toHaveBeenCalledTimes(1);
    expect(wsClient.subscribeChannel).toHaveBeenCalledWith(CHANNEL_ID);
    expect(wsClient.on).toHaveBeenCalledWith('mls.commit', expect.any(Function));
    expect(wsClient.on).toHaveBeenCalledWith('voice_group_destroyed', expect.any(Function));
  });

  it('unsubscribes and removes listeners on dispose', () => {
    const session = createVoiceMlsSession(buildDeps());
    session.dispose();
    expect(wsClient.unsubscribeChannel).toHaveBeenCalledWith(CHANNEL_ID);
    expect(wsClient.off).toHaveBeenCalledWith('mls.commit', expect.any(Function));
    expect(wsClient.off).toHaveBeenCalledWith('voice_group_destroyed', expect.any(Function));
  });

  it('processes a foreign voice commit and re-derives the frame key', async () => {
    createVoiceMlsSession(buildDeps());
    await handlers['mls.commit'](voiceCommit());
    expect(mlsGroup.processVoiceCommit).toHaveBeenCalledTimes(1);
    expect(mlsGroup.exportVoiceFrameKey).toHaveBeenCalledTimes(1);
    expect(onFrameKey).toHaveBeenCalledWith(expect.any(Uint8Array), 1);
  });

  it('skips the client own commit (no self-reprocess)', async () => {
    createVoiceMlsSession(buildDeps());
    await handlers['mls.commit'](voiceCommit({ sender_id: USER_ID, sender_device_id: DEVICE_ID }));
    expect(mlsGroup.processVoiceCommit).not.toHaveBeenCalled();
    expect(onFrameKey).not.toHaveBeenCalled();
  });

  it('ignores non-voice commits', async () => {
    createVoiceMlsSession(buildDeps());
    await handlers['mls.commit'](voiceCommit({ group_type: 'text' }));
    expect(mlsGroup.processVoiceCommit).not.toHaveBeenCalled();
  });

  it('ignores commits for a different channel', async () => {
    createVoiceMlsSession(buildDeps());
    await handlers['mls.commit'](voiceCommit({ channel_id: 'other-channel' }));
    expect(mlsGroup.processVoiceCommit).not.toHaveBeenCalled();
  });

  it('does not re-derive after dispose even if a commit lands late', async () => {
    const session = createVoiceMlsSession(buildDeps());
    session.dispose();
    await handlers['mls.commit'](voiceCommit());
    // processVoiceCommit may run, but the stale-session guard must suppress the
    // frame-key application so a disposed session never mutates LiveKit state.
    expect(onFrameKey).not.toHaveBeenCalled();
  });

  it('reports a commit processing failure through onCommitError', async () => {
    mlsGroup.processVoiceCommit.mockRejectedValueOnce(new Error('boom'));
    createVoiceMlsSession(buildDeps());
    await handlers['mls.commit'](voiceCommit());
    expect(onCommitError).toHaveBeenCalledTimes(1);
    expect(onFrameKey).not.toHaveBeenCalled();
  });
});
