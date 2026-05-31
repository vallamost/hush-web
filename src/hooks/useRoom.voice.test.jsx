// jsdom does not provide MediaStream. Polyfill for PlaybackManager tests.
if (typeof globalThis.MediaStream === 'undefined') {
  globalThis.MediaStream = class MockMediaStream {
    constructor(tracks) { this._tracks = tracks ?? []; }
    getTracks() { return this._tracks; }
    getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
  };
}

/**
 * useRoom MLS voice E2EE tests
 *
 * Exercises the MLS voice group lifecycle wired into useRoom.js (M.3-03).
 * Uses dependency-injected mocks for mlsGroup, mlsStore, hushCrypto, api,
 * and the LiveKit ExternalE2EEKeyProvider so no WASM or network is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MEDIA_SOURCES } from '../utils/constants';

// ---------------------------------------------------------------------------
// Stable hoisted mocks - must be created with vi.hoisted() so they exist
// when vi.mock() factory functions run (factories execute before imports).
// ---------------------------------------------------------------------------
const {
  mockCreateVoiceGroup,
  mockJoinVoiceGroup,
  mockExportVoiceFrameKey,
  mockProcessVoiceCommit,
  mockPerformVoiceSelfUpdate,
  mockDestroyVoiceGroup,
  mockRemoveMemberFromVoiceGroup,
  mockGetCredential,
  mockGetMLSVoiceGroupInfo,
  mockSetKey,
  mockE2EEKeyProvider,
  mockOrchestratorMute,
  mockOrchestratorUnmute,
  mockOrchestratorAcquire,
  mockOrchestratorPublishTo,
  mockOrchestratorUnpublish,
  mockOrchestratorTeardown,
  mockOrchestratorUpdateFilterSettings,
  MockCaptureOrchestrator,
  MockLiveKitRoomAdapter,
  mockIsMobileWebAudio,
  mockPutMLSVoiceGroupInfo,
  mockPostMLSVoiceCommit,
  mockSetE2EEEnabled,
} = vi.hoisted(() => {
  const mockSetKey = vi.fn().mockResolvedValue(undefined);
  const mockSetE2EEEnabled = vi.fn().mockResolvedValue(undefined);
  // Must use a regular function (not arrow) so `new ExternalE2EEKeyProvider()` works
  function MockExternalE2EEKeyProvider() {
    this.setKey = mockSetKey;
  }
  const mockE2EEKeyProvider = vi.fn(MockExternalE2EEKeyProvider);

  // CaptureOrchestrator mocks
  const mockOrchestratorAcquire = vi.fn().mockResolvedValue(undefined);
  const mockOrchestratorPublishTo = vi.fn().mockResolvedValue(undefined);
  const mockOrchestratorMute = vi.fn().mockResolvedValue(undefined);
  const mockOrchestratorUnmute = vi.fn().mockResolvedValue(undefined);
  const mockOrchestratorUnpublish = vi.fn().mockResolvedValue(undefined);
  const mockOrchestratorTeardown = vi.fn().mockResolvedValue(undefined);
  const mockOrchestratorUpdateFilterSettings = vi.fn();

  function MockCaptureOrchestrator() {
    this.acquire = mockOrchestratorAcquire;
    this.publishTo = mockOrchestratorPublishTo;
    this.mute = mockOrchestratorMute;
    this.unmute = mockOrchestratorUnmute;
    this.unpublish = mockOrchestratorUnpublish;
    this.teardown = mockOrchestratorTeardown;
    this.updateFilterSettings = mockOrchestratorUpdateFilterSettings;
    this.isLive = false;
    this.session = null;
  }

  function MockLiveKitRoomAdapter() {}

  return {
    mockCreateVoiceGroup: vi.fn().mockResolvedValue({ epoch: 0 }),
    mockJoinVoiceGroup: vi.fn().mockResolvedValue({ epoch: 1 }),
    mockExportVoiceFrameKey: vi.fn().mockResolvedValue({
      frameKeyBytes: new Uint8Array(32).fill(0xab),
      epoch: 1,
    }),
    mockProcessVoiceCommit: vi.fn().mockResolvedValue({ type: 'commit', epoch: 2 }),
    mockPerformVoiceSelfUpdate: vi.fn().mockResolvedValue({ epoch: 3 }),
    mockDestroyVoiceGroup: vi.fn().mockResolvedValue(undefined),
    mockRemoveMemberFromVoiceGroup: vi.fn().mockResolvedValue(undefined),
    mockGetCredential: vi.fn().mockResolvedValue({
      signingPrivateKey: new Uint8Array([1]),
      signingPublicKey: new Uint8Array([2]),
      credentialBytes: new Uint8Array([3]),
    }),
    mockGetMLSVoiceGroupInfo: vi.fn().mockResolvedValue(null),
    mockPutMLSVoiceGroupInfo: vi.fn().mockResolvedValue(undefined),
    mockPostMLSVoiceCommit: vi.fn().mockResolvedValue(undefined),
    mockSetKey,
    mockE2EEKeyProvider,
    mockOrchestratorAcquire,
    mockOrchestratorPublishTo,
    mockOrchestratorMute,
    mockOrchestratorUnmute,
    mockOrchestratorUnpublish,
    mockOrchestratorTeardown,
    mockOrchestratorUpdateFilterSettings,
    MockCaptureOrchestrator,
    MockLiveKitRoomAdapter,
    mockIsMobileWebAudio: vi.fn().mockReturnValue(false),
    mockSetE2EEEnabled,
  };
});

vi.mock('../lib/mlsGroup', () => ({
  createVoiceGroup: mockCreateVoiceGroup,
  joinVoiceGroup: mockJoinVoiceGroup,
  exportVoiceFrameKey: mockExportVoiceFrameKey,
  processVoiceCommit: mockProcessVoiceCommit,
  performVoiceSelfUpdate: mockPerformVoiceSelfUpdate,
  destroyVoiceGroup: mockDestroyVoiceGroup,
  removeMemberFromVoiceGroup: mockRemoveMemberFromVoiceGroup,
  voiceChannelIdToBytes: (id) => new TextEncoder().encode(`voice:${id}`),
}));

vi.mock('../lib/mlsStore', () => ({
  openStore: vi.fn().mockResolvedValue({}),
  getCredential: mockGetCredential,
}));

vi.mock('../lib/hushCrypto', () => ({}));

vi.mock('../lib/api', () => ({
  getMLSVoiceGroupInfo: mockGetMLSVoiceGroupInfo,
  putMLSVoiceGroupInfo: mockPutMLSVoiceGroupInfo,
  postMLSVoiceCommit: mockPostMLSVoiceCommit,
}));

vi.mock('./useAuth', () => ({
  getDeviceId: () => 'device-1',
}));

// Mock livekit-client ExternalE2EEKeyProvider and Room
vi.mock('livekit-client', () => {
  const RoomEvent = {
    ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected',
    Connected: 'connected',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    ActiveSpeakersChanged: 'activeSpeakersChanged',
    TrackPublished: 'trackPublished',
    TrackUnpublished: 'trackUnpublished',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
  };

  class MockRoom {
    constructor() {
      this._handlers = {};
      this.remoteParticipants = new Map();
      this.e2eeEnabled = false;
    }
    on(event, handler) {
      this._handlers[event] = handler;
    }
    off(event) {
      delete this._handlers[event];
    }
    emit(event, ...args) {
      this._handlers[event]?.(...args);
    }
    async connect(...args) { this.connectArgs = args; }
    async disconnect() {}
    async setE2EEEnabled(enabled) {
      await mockSetE2EEEnabled(enabled);
      this.e2eeEnabled = enabled;
    }
  }

  class MockLocalAudioTrack {
    constructor(track) { this._track = track; this.sid = null; }
    mute() { return Promise.resolve(); }
    unmute() { return Promise.resolve(); }
    stop() {}
  }

  return {
    ExternalE2EEKeyProvider: mockE2EEKeyProvider,
    Room: MockRoom,
    RoomEvent,
    Track: { Source: { Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' }, Kind: { Video: 'video' } },
    LocalAudioTrack: MockLocalAudioTrack,
  };
});

// Mock E2EE worker
vi.mock('livekit-client/e2ee-worker?worker', () => ({
  default: class MockWorker {},
}));

// Mock trackManager - no real audio/video in unit tests
vi.mock('../lib/trackManager', () => ({
  attachRemoteTrackListeners: vi.fn(),
  preloadNoiseGateWorklet: vi.fn(),
  publishScreen: vi.fn(),
  unpublishScreen: vi.fn(),
  switchScreenSource: vi.fn(),
  changeQuality: vi.fn(),
  publishWebcam: vi.fn(),
  unpublishWebcam: vi.fn(),
  watchScreen: vi.fn(),
  unwatchScreen: vi.fn(),
  // HUSHHQ-14: deterministic teardown helper. Mirrors the real
  // implementation closely enough — clears every entry in the
  // ref so tests can assert post-teardown state without driving
  // real LiveKit tracks.
  releaseLocalCaptureTracks: vi.fn((localTracksRef) => {
    const map = localTracksRef?.current;
    if (!map || typeof map.clear !== 'function') return;
    map.clear();
  }),
  stopLocalMediaTrack: vi.fn(),
}));

// Mock micProcessing exports used by useRoom
vi.mock('../lib/micProcessing', () => ({
  NOISE_GATE_WORKLET_URL: 'mock://noise-gate-worklet.js',
  getMicFilterSettings: vi.fn().mockReturnValue({
    noiseGateEnabled: true,
    noiseGateThresholdDb: -50,
    echoCancellation: false,
  }),
}));

// Mock CaptureOrchestrator
vi.mock('../audio/capture/CaptureOrchestrator', () => ({
  CaptureOrchestrator: MockCaptureOrchestrator,
}));

// Mock LiveKitRoomAdapter
vi.mock('../audio/adapters/LiveKitRoomAdapter', () => ({
  LiveKitRoomAdapter: MockLiveKitRoomAdapter,
}));

// Mock audio barrel — use real resolveMode + CAPTURE_PROFILES, only mock
// isMobileWebAudio (UA detection) so tests control the platform signal.
vi.mock('../audio', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    isMobileWebAudio: mockIsMobileWebAudio,
  };
});

import { useRoom } from './useRoom';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'ch-test-1';
const ROOM_NAME = `channel-${CHANNEL_ID}`;

function makeWsClient() {
  const handlers = {};
  return {
    on: vi.fn((event, handler) => { handlers[event] = handler; }),
    off: vi.fn((event) => { delete handlers[event]; }),
    subscribeChannel: vi.fn(),
    unsubscribeChannel: vi.fn(),
    _emit: (event, data) => handlers[event]?.(data),
  };
}

function makeGetStore() {
  return vi.fn().mockResolvedValue({});
}

function makeGetToken() {
  return vi.fn().mockReturnValue('test-token');
}

// Stub fetch for LiveKit token endpoint
function stubLivekitFetch(body = { token: 'lk-token' }) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRoom MLS voice E2EE', () => {
  let wsClient;
  let getStore;
  let getToken;

  beforeEach(() => {
    // Clear all mocks FIRST so reassignments below take effect cleanly
    vi.clearAllMocks();

    // Recreate per-test objects after clearing (so their impls are fresh)
    wsClient = makeWsClient();
    getStore = makeGetStore();
    getToken = makeGetToken();
    stubLivekitFetch();

    // Restore default implementations for hoisted mocks after clearAllMocks
    mockCreateVoiceGroup.mockResolvedValue({ epoch: 0 });
    mockJoinVoiceGroup.mockResolvedValue({ epoch: 1 });
    mockExportVoiceFrameKey.mockResolvedValue({
      frameKeyBytes: new Uint8Array(32).fill(0xab),
      epoch: 1,
    });
    mockProcessVoiceCommit.mockResolvedValue({ type: 'commit', epoch: 2 });
    mockPerformVoiceSelfUpdate.mockResolvedValue({ epoch: 3 });
    mockDestroyVoiceGroup.mockResolvedValue(undefined);
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    mockPutMLSVoiceGroupInfo.mockResolvedValue(undefined);
    mockPostMLSVoiceCommit.mockResolvedValue(undefined);
    mockGetCredential.mockResolvedValue({
      signingPrivateKey: new Uint8Array([1]),
      signingPublicKey: new Uint8Array([2]),
      credentialBytes: new Uint8Array([3]),
    });
    mockOrchestratorAcquire.mockResolvedValue(undefined);
    mockOrchestratorPublishTo.mockResolvedValue(undefined);
    mockOrchestratorMute.mockResolvedValue(undefined);
    mockOrchestratorUnmute.mockResolvedValue(undefined);
    mockOrchestratorUnpublish.mockResolvedValue(undefined);
    mockOrchestratorTeardown.mockResolvedValue(undefined);
    mockSetKey.mockResolvedValue(undefined);
    mockSetE2EEEnabled.mockResolvedValue(undefined);
  });

  it('connectRoom creates voice MLS group when no existing group on server (first participant)', async () => {
    // getMLSVoiceGroupInfo returns null when the server has no voice group yet.
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    expect(mockCreateVoiceGroup).toHaveBeenCalledTimes(1);
    expect(mockJoinVoiceGroup).not.toHaveBeenCalled();
  });

  // HUSHHQ-104: without a WS subscription to the voice channel topic, the server
  // drops every mls.commit broadcast (join / rotation / eviction), so peers never
  // converge on an epoch and decryption fails closed with mutual InvalidKey.
  it('connectRoom subscribes to the voice channel WS topic so MLS commits are delivered', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    expect(wsClient.subscribeChannel).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it('disconnectRoom unsubscribes from the voice channel WS topic', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });
    await act(async () => {
      await result.current.disconnectRoom();
    });

    expect(wsClient.unsubscribeChannel).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it('unmount unsubscribes from the voice channel WS topic', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);

    const { result, unmount } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });
    act(() => {
      unmount();
    });

    expect(wsClient.unsubscribeChannel).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it('uses the instance base URL for LiveKit token and websocket in desktop-safe paths', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useRoom({
        wsClient,
        getToken,
        currentUserId: 'u1',
        getStore,
        voiceKeyRotationHours: 2,
        baseUrl: 'https://app.gethush.live',
      }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://app.gethush.live/api/livekit/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(capturedRooms.at(-1).connectArgs[0]).toBe('wss://app.gethush.live/livekit/');
  });

  it('binds all voice MLS API calls to the selected instance base URL', async () => {
    const voiceBaseUrl = 'https://chat.example.com';
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    mockCreateVoiceGroup.mockImplementationOnce(async (deps, channelId) => {
      await deps.api.putMLSVoiceGroupInfo('test-token', channelId, 'group-info-b64', 1);
      await deps.api.postMLSVoiceCommit('test-token', channelId, 'commit-b64', 2, 'next-group-info-b64');
      return { epoch: 1 };
    });

    const { result } = renderHook(() =>
      useRoom({
        wsClient,
        getToken,
        currentUserId: 'u1',
        getStore,
        voiceKeyRotationHours: 2,
        baseUrl: voiceBaseUrl,
      }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    expect(mockGetMLSVoiceGroupInfo).toHaveBeenCalledWith('test-token', CHANNEL_ID, voiceBaseUrl);
    expect(mockPutMLSVoiceGroupInfo).toHaveBeenCalledWith('test-token', CHANNEL_ID, 'group-info-b64', 1, voiceBaseUrl);
    expect(mockPostMLSVoiceCommit).toHaveBeenCalledWith('test-token', CHANNEL_ID, 'commit-b64', 2, 'next-group-info-b64', voiceBaseUrl);
  });

  it('uses the per-instance LiveKit URL returned by the token endpoint', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    stubLivekitFetch({
      token: 'lk-token',
      livekitUrl: 'wss://rtc.example.com/',
    });

    const { result } = renderHook(() =>
      useRoom({
        wsClient,
        getToken,
        currentUserId: 'u1',
        getStore,
        voiceKeyRotationHours: 2,
        baseUrl: 'https://chat.example.com',
      }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://chat.example.com/api/livekit/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(capturedRooms.at(-1).connectArgs[0]).toBe('wss://rtc.example.com/');
  });

  it('connectRoom calls exportVoiceFrameKey and applies key via setKey(frameKeyBytes, epoch % 256)', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    mockExportVoiceFrameKey.mockResolvedValue({
      frameKeyBytes: new Uint8Array(32).fill(0xff),
      epoch: 5,
    });

    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    expect(mockExportVoiceFrameKey).toHaveBeenCalledTimes(1);
    // setKey is called on the ExternalE2EEKeyProvider instance
    expect(mockSetKey).toHaveBeenCalledWith(expect.any(Uint8Array), 5 % 256);
    // voiceEpoch state should reflect the derived epoch
    expect(result.current.voiceEpoch).toBe(5);
    expect(result.current.isE2EEEnabled).toBe(true);
  });

  it('isVoiceReconnecting is false after successful MLS setup, true only during the async gap', async () => {
    // When connectRoom completes successfully, isVoiceReconnecting must be false.
    // The true→false transition happens within connectRoom after the key is applied.
    // We verify the final state here; the Reconnecting indicator is shown in VoiceChannel.jsx.
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    // After successful connect: reconnecting must be false, E2EE must be enabled
    expect(result.current.isVoiceReconnecting).toBe(false);
    expect(result.current.isE2EEEnabled).toBe(true);
  });

  it('mls.commit WS event triggers key re-derivation with new epoch (skips own commits)', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    // Simulate an mls.commit from a different user
    const commitBytes = new Uint8Array([1, 2, 3]);
    const b64 = btoa(String.fromCharCode(...commitBytes));
    mockExportVoiceFrameKey.mockResolvedValue({
      frameKeyBytes: new Uint8Array(32).fill(0xcc),
      epoch: 7,
    });
    mockProcessVoiceCommit.mockResolvedValue({ type: 'commit', epoch: 7 });

    await act(async () => {
      wsClient._emit('mls.commit', {
        group_type: 'voice',
        channel_id: CHANNEL_ID,
        sender_id: 'other-user',
        commit_bytes: b64,
        epoch: 7,
      });
    });

    expect(mockProcessVoiceCommit).toHaveBeenCalledTimes(1);
    expect(mockExportVoiceFrameKey).toHaveBeenCalledTimes(2); // once on connect, once on commit
    expect(result.current.voiceEpoch).toBe(7);
  });

  it('mls.commit WS event skips only same-user commits from the same device', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    const initialCallCount = mockProcessVoiceCommit.mock.calls.length;

    await act(async () => {
      wsClient._emit('mls.commit', {
        group_type: 'voice',
        channel_id: CHANNEL_ID,
        sender_id: 'u1',
        sender_device_id: 'device-1',
        commit_bytes: btoa('abc'),
        epoch: 2,
      });
    });

    // Commits from the current device must not trigger processVoiceCommit
    expect(mockProcessVoiceCommit).toHaveBeenCalledTimes(initialCallCount);
  });

  it('mls.commit WS event processes same-user commits from a different device', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    const initialCallCount = mockProcessVoiceCommit.mock.calls.length;

    await act(async () => {
      wsClient._emit('mls.commit', {
        group_type: 'voice',
        channel_id: CHANNEL_ID,
        sender_id: 'u1',
        sender_device_id: 'device-2',
        commit_bytes: btoa('abc'),
        epoch: 2,
      });
    });

    expect(mockProcessVoiceCommit).toHaveBeenCalledTimes(initialCallCount + 1);
  });

  it('disconnectRoom destroys local voice group state', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    await act(async () => {
      await result.current.disconnectRoom();
    });

    expect(mockDestroyVoiceGroup).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'test-token' }),
      CHANNEL_ID,
    );
    expect(result.current.voiceEpoch).toBeNull();
    expect(result.current.isE2EEEnabled).toBe(false);
    expect(result.current.isVoiceReconnecting).toBe(false);
  });

  it('publishMic creates orchestrator, acquires desktop-standard, and publishes', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
      await result.current.publishMic();
    });

    expect(mockOrchestratorAcquire).toHaveBeenCalledTimes(1);
    const acquireProfile = mockOrchestratorAcquire.mock.calls[0][0];
    expect(acquireProfile.mode).toBe('desktop-standard');
    expect(mockOrchestratorPublishTo).toHaveBeenCalledTimes(1);
  });

  it('muteMic and unmuteMic delegate to orchestrator', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
      await result.current.publishMic();
    });

    await act(async () => {
      await result.current.muteMic();
    });

    expect(mockOrchestratorMute).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.unmuteMic();
    });

    expect(mockOrchestratorUnmute).toHaveBeenCalledTimes(1);
  });

  it('publishMic resolves mobile-web-standard when UA is mobile', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    mockIsMobileWebAudio.mockReturnValue(true);

    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
      await result.current.publishMic();
    });

    expect(mockOrchestratorAcquire).toHaveBeenCalledTimes(1);
    const acquireProfile = mockOrchestratorAcquire.mock.calls[0][0];
    expect(acquireProfile.mode).toBe('mobile-web-standard');

    mockIsMobileWebAudio.mockReturnValue(false);
  });

  it('MLS failure blocks voice entirely - no unencrypted fallback', async () => {
    // Non-404 MLS lookup failures must block voice instead of creating a fresh group.
    mockGetMLSVoiceGroupInfo.mockRejectedValue(new Error('Network error'));
    mockCreateVoiceGroup.mockRejectedValue(new Error('WASM failure'));

    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    // Voice must be blocked - error set with clear message
    expect(result.current.error).toMatch(/encrypted voice|please try again/i);
    // E2EE must NOT be enabled - no unencrypted fallback
    expect(result.current.isE2EEEnabled).toBe(false);
    expect(result.current.isVoiceReconnecting).toBe(false);
  });

  it('connectRoom enables LiveKit per-frame E2EE on the created room before completing', async () => {
    // Configuring `roomOptions.e2ee` only wires the manager. Without an
    // explicit `setE2EEEnabled(true)` call, audio frames would publish in
    // clear. CORE-INVARIANTS Voice Rooms and LiveKit forbids that.
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);

    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    expect(mockSetE2EEEnabled).toHaveBeenCalledWith(true);
    expect(result.current.isReady).toBe(true);
    expect(result.current.isE2EEEnabled).toBe(true);
  });

  it('connectRoom fails closed when setE2EEEnabled rejects', async () => {
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    mockSetE2EEEnabled.mockRejectedValueOnce(new Error('e2ee init failed'));

    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    expect(mockSetE2EEEnabled).toHaveBeenCalledWith(true);
    expect(result.current.isReady).toBe(false);
    expect(result.current.isE2EEEnabled).toBe(false);
    expect(result.current.error).toMatch(/encrypted voice/i);
  });
});

// ---------------------------------------------------------------------------
// ParticipantDisconnected → voice MLS eviction
// ---------------------------------------------------------------------------

/**
 * Wait for queued microtasks + a few macrotask turns. The
 * ParticipantDisconnected handler defers the MLS rotation to
 * `queueMicrotask`, which schedules `await getStore()` and several
 * follow-up awaits before reaching `removeMemberFromVoiceGroup` and
 * `setKey`. A single `setTimeout(0)` is not enough to let all of
 * them resolve, so flush deliberately.
 */
async function flushMicrotasks(turns = 5) {
  for (let i = 0; i < turns; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
}

function makeRemoteParticipant({ userId, deviceId, identityOverride }) {
  return {
    identity: identityOverride ?? userId,
    metadata: JSON.stringify({
      userId,
      deviceId,
      mlsIdentity: `${userId}:${deviceId}`,
    }),
  };
}

describe('useRoom voice MLS eviction on participant disconnect', () => {
  let wsClient;
  let getStore;
  let getToken;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedRooms.length = 0;

    wsClient = makeWsClient();
    getStore = makeGetStore();
    getToken = makeGetToken();
    stubLivekitFetch();

    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    mockCreateVoiceGroup.mockResolvedValue({ epoch: 0 });
    mockJoinVoiceGroup.mockResolvedValue({ epoch: 1 });
    mockExportVoiceFrameKey.mockResolvedValue({
      frameKeyBytes: new Uint8Array(32).fill(0xab),
      epoch: 1,
    });
    mockRemoveMemberFromVoiceGroup.mockResolvedValue(undefined);
    mockGetCredential.mockResolvedValue({
      signingPrivateKey: new Uint8Array([1]),
      signingPublicKey: new Uint8Array([2]),
      credentialBytes: new Uint8Array([3]),
    });
    mockSetKey.mockResolvedValue(undefined);
  });

  it('rotates voice MLS when a remote participant with valid metadata disconnects', async () => {
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });
    const room = capturedRooms[capturedRooms.length - 1];
    expect(room).toBeDefined();

    // exportVoiceFrameKey was called once for initial connect; the
    // post-rotation call needs to return a fresh key+epoch so we can
    // assert it propagated to setKey.
    mockExportVoiceFrameKey.mockResolvedValueOnce({
      frameKeyBytes: new Uint8Array(32).fill(0xcd),
      epoch: 7,
    });

    room.emit('participantDisconnected', makeRemoteParticipant({
      userId: 'u-leaver',
      deviceId: 'd-leaver',
    }));
    await flushMicrotasks();

    expect(mockRemoveMemberFromVoiceGroup).toHaveBeenCalledTimes(1);
    const [, channelArg, identityArg] = mockRemoveMemberFromVoiceGroup.mock.calls[0];
    expect(channelArg).toBe(CHANNEL_ID);
    expect(identityArg).toBe('u-leaver:d-leaver');

    // After the rotation, the listener must re-derive and apply a
    // fresh frame key so the departed device cannot continue
    // decrypting voice frames with the old key.
    const lastSetKey = mockSetKey.mock.calls[mockSetKey.mock.calls.length - 1];
    expect(lastSetKey[0]).toBeInstanceOf(Uint8Array);
    expect(lastSetKey[0][0]).toBe(0xcd);
    expect(lastSetKey[1]).toBe(7 % 256);
  });

  it('skips MLS eviction (and does NOT remove a bare user id) when metadata is missing or malformed', async () => {
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );
    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });
    const room = capturedRooms[capturedRooms.length - 1];

    // No metadata at all (legacy LiveKit token / pre-fix server).
    room.emit('participantDisconnected', { identity: 'u-leaver' });
    // Garbage JSON.
    room.emit('participantDisconnected', { identity: 'u-leaver', metadata: '{not-json' });
    // Mismatched mlsIdentity.
    room.emit('participantDisconnected', {
      identity: 'u-leaver',
      metadata: JSON.stringify({
        userId: 'u-leaver',
        deviceId: 'd-leaver',
        mlsIdentity: 'u-leaver:d-OTHER',
      }),
    });
    await flushMicrotasks();

    // The load-bearing assertion: we MUST NOT have called
    // removeMemberFromVoiceGroup with the bare LiveKit identity
    // (which was the PR #40 bug).
    expect(mockRemoveMemberFromVoiceGroup).not.toHaveBeenCalled();
  });

  it('skips MLS eviction when the disconnected participant is this device', async () => {
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );
    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });
    const room = capturedRooms[capturedRooms.length - 1];

    // The mocked `getDeviceId()` returns 'device-1' (see top-of-file
    // useAuth mock), and currentUserId is 'u1'. The self identity is
    // therefore 'u1:device-1'.
    room.emit('participantDisconnected', makeRemoteParticipant({
      userId: 'u1',
      deviceId: 'device-1',
    }));
    await flushMicrotasks();

    expect(mockRemoveMemberFromVoiceGroup).not.toHaveBeenCalled();
  });

  it('processes eviction for the same user on a different device', async () => {
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );
    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });
    const room = capturedRooms[capturedRooms.length - 1];

    room.emit('participantDisconnected', makeRemoteParticipant({
      userId: 'u1',
      deviceId: 'd-other',
    }));
    await flushMicrotasks();

    expect(mockRemoveMemberFromVoiceGroup).toHaveBeenCalledTimes(1);
    expect(mockRemoveMemberFromVoiceGroup.mock.calls[0][2]).toBe('u1:d-other');
  });

  it('with another remaining participant elected (lexicographic smallest), local skips the removal', async () => {
    // 3-participant room: local 'u1:device-1', remote elector
    // 'u-aaa:d-1' (smaller than local), departed 'u-leaver:d-leaver'.
    // 'u-aaa:d-1' wins the election so local must NOT call
    // removeMemberFromVoiceGroup — that would race the elector.
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );
    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });
    const room = capturedRooms[capturedRooms.length - 1];

    // Seed remoteParticipants with a smaller-identity peer so the
    // election sees a real candidate set.
    const otherElector = makeRemoteParticipant({ userId: 'u-aaa', deviceId: 'd-1' });
    room.remoteParticipants.set('u-aaa', otherElector);

    room.emit('participantDisconnected', makeRemoteParticipant({
      userId: 'u-leaver',
      deviceId: 'd-leaver',
    }));
    await flushMicrotasks();

    expect(mockRemoveMemberFromVoiceGroup).not.toHaveBeenCalled();
  });

  it('with local elected as smallest remaining identity, removal runs exactly once', async () => {
    // 3-participant room. Pick identities so local sorts strictly
    // first: local 'u-aaa:device-1', remote 'u-zzz:d-1' (larger),
    // departed 'u-leaver:d-leaver'. Election picks local; removal
    // must run exactly once.
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u-aaa', getStore, voiceKeyRotationHours: 2 }),
    );
    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });
    const room = capturedRooms[capturedRooms.length - 1];

    const otherLoser = makeRemoteParticipant({ userId: 'u-zzz', deviceId: 'd-1' });
    room.remoteParticipants.set('u-zzz', otherLoser);

    room.emit('participantDisconnected', makeRemoteParticipant({
      userId: 'u-leaver',
      deviceId: 'd-leaver',
    }));
    await flushMicrotasks();

    expect(mockRemoveMemberFromVoiceGroup).toHaveBeenCalledTimes(1);
    expect(mockRemoveMemberFromVoiceGroup.mock.calls[0][2]).toBe('u-leaver:d-leaver');
  });

  it('uses the deps-injected scoped voice MLS API (selected instance base URL)', async () => {
    const voiceBaseUrl = 'https://chat.example.com';
    const { result } = renderHook(() =>
      useRoom({
        wsClient,
        getToken,
        currentUserId: 'u1',
        getStore,
        voiceKeyRotationHours: 2,
        baseUrl: voiceBaseUrl,
      }),
    );
    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });
    const room = capturedRooms[capturedRooms.length - 1];

    room.emit('participantDisconnected', makeRemoteParticipant({
      userId: 'u-leaver',
      deviceId: 'd-leaver',
    }));
    await flushMicrotasks();

    // The deps passed into removeMemberFromVoiceGroup must carry the
    // instance-scoped voice MLS API created from `voiceBaseUrl`.
    // Force a postMLSVoiceCommit through that api so the per-instance
    // base URL leaks all the way down to the API mock and proves the
    // scoping is preserved end to end.
    expect(mockRemoveMemberFromVoiceGroup).toHaveBeenCalledTimes(1);
    const depsArg = mockRemoveMemberFromVoiceGroup.mock.calls[0][0];
    await depsArg.api.postMLSVoiceCommit(
      'test-token',
      CHANNEL_ID,
      'commit-b64',
      9,
      'group-info-b64',
    );
    expect(mockPostMLSVoiceCommit).toHaveBeenCalledWith(
      'test-token',
      CHANNEL_ID,
      'commit-b64',
      9,
      'group-info-b64',
      voiceBaseUrl,
    );
  });
});

// ---------------------------------------------------------------------------
// Reconnect lifecycle tests
// ---------------------------------------------------------------------------

/**
 * Helper: connect a hook and return the MockRoom instance so we can emit
 * RoomEvent.Reconnecting / RoomEvent.Reconnected in tests.
 */
async function connectAndGetRoom(result) {
  await act(async () => {
    await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
  });
  // The room is stored internally; we get it from the last MockRoom constructed.
  // Since MockRoom.connect is a no-op, the room ref is set after connect() returns.
  // We can retrieve it via the module-level MockRoom instances tracked by the mock.
  return result;
}

// We need access to the MockRoom instance. The simplest approach: capture it
// via a module-scoped variable in the mock factory using vi.hoisted.
const { capturedRooms } = vi.hoisted(() => {
  const capturedRooms = [];
  return { capturedRooms };
});

// Re-register the Room mock to capture instances
vi.mock('livekit-client', () => {
  const RoomEvent = {
    ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected',
    Connected: 'connected',
    Disconnected: 'disconnected',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    ActiveSpeakersChanged: 'activeSpeakersChanged',
    TrackPublished: 'trackPublished',
    TrackUnpublished: 'trackUnpublished',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
  };

  class MockRoom {
    constructor() {
      this._handlers = {};
      this.remoteParticipants = new Map();
      this.e2eeEnabled = false;
      capturedRooms.push(this);
    }
    on(event, handler) {
      this._handlers[event] = handler;
    }
    off(event) {
      delete this._handlers[event];
    }
    emit(event, ...args) {
      this._handlers[event]?.(...args);
    }
    async connect(...args) { this.connectArgs = args; }
    async disconnect() {}
    async setE2EEEnabled(enabled) {
      await mockSetE2EEEnabled(enabled);
      this.e2eeEnabled = enabled;
    }
  }

  class MockLocalAudioTrack {
    constructor(track) { this._track = track; this.sid = null; }
    mute() { return Promise.resolve(); }
    unmute() { return Promise.resolve(); }
    stop() {}
  }

  return {
    ExternalE2EEKeyProvider: mockE2EEKeyProvider,
    Room: MockRoom,
    RoomEvent,
    Track: { Source: { Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' }, Kind: { Video: 'video' } },
    LocalAudioTrack: MockLocalAudioTrack,
  };
});

describe('useRoom voice reconnect', () => {
  let wsClient;
  let getStore;
  let getToken;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedRooms.length = 0;

    wsClient = makeWsClient();
    getStore = makeGetStore();
    getToken = makeGetToken();
    stubLivekitFetch();

    // Restore default mock implementations
    mockCreateVoiceGroup.mockResolvedValue({ epoch: 0 });
    mockJoinVoiceGroup.mockResolvedValue({ epoch: 1 });
    mockExportVoiceFrameKey.mockResolvedValue({
      frameKeyBytes: new Uint8Array(32).fill(0xab),
      epoch: 1,
    });
    mockProcessVoiceCommit.mockResolvedValue({ type: 'commit', epoch: 2 });
    mockPerformVoiceSelfUpdate.mockResolvedValue({ epoch: 3 });
    mockDestroyVoiceGroup.mockResolvedValue(undefined);
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    mockGetCredential.mockResolvedValue({
      signingPrivateKey: new Uint8Array([1]),
      signingPublicKey: new Uint8Array([2]),
      credentialBytes: new Uint8Array([3]),
    });
    mockSetKey.mockResolvedValue(undefined);
    mockSetE2EEEnabled.mockResolvedValue(undefined);
  });

  it('RoomEvent.Reconnected triggers frame key re-derivation via exportVoiceFrameKey', async () => {
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    const callsBeforeReconnect = mockExportVoiceFrameKey.mock.calls.length;
    const setKeyCallsBeforeReconnect = mockSetKey.mock.calls.length;

    // Simulate LiveKit reconnected event
    const room = capturedRooms[capturedRooms.length - 1];
    mockExportVoiceFrameKey.mockResolvedValue({
      frameKeyBytes: new Uint8Array(32).fill(0xde),
      epoch: 9,
    });

    await act(async () => {
      room.emit('reconnected');
    });

    // exportVoiceFrameKey should be called once more on reconnect
    expect(mockExportVoiceFrameKey.mock.calls.length).toBeGreaterThan(callsBeforeReconnect);
    // setKey should be called with the new frame key
    expect(mockSetKey.mock.calls.length).toBeGreaterThan(setKeyCallsBeforeReconnect);
    expect(result.current.isVoiceReconnecting).toBe(false);
  });

  it('3 failed reconnect attempts set voiceReconnectFailed to true', async () => {
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    const room = capturedRooms[capturedRooms.length - 1];

    // Simulate 3 reconnect attempts without success
    await act(async () => {
      room.emit('reconnecting');
    });
    await act(async () => {
      room.emit('reconnecting');
    });
    await act(async () => {
      room.emit('reconnecting');
    });

    // After 3 attempts, disconnected fires without a Reconnected in between
    await act(async () => {
      room.emit('disconnected');
    });

    expect(result.current.voiceReconnectFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Playback integration tests
// ---------------------------------------------------------------------------

describe('useRoom playback manager integration', () => {
  let wsClient;
  let getStore;
  let getToken;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedRooms.length = 0;

    wsClient = makeWsClient();
    getStore = makeGetStore();
    getToken = makeGetToken();
    stubLivekitFetch();

    mockCreateVoiceGroup.mockResolvedValue({ epoch: 0 });
    mockExportVoiceFrameKey.mockResolvedValue({
      frameKeyBytes: new Uint8Array(32).fill(0xab),
      epoch: 1,
    });
    mockGetMLSVoiceGroupInfo.mockResolvedValue(null);
    mockGetCredential.mockResolvedValue({
      signingPrivateKey: new Uint8Array([1]),
      signingPublicKey: new Uint8Array([2]),
      credentialBytes: new Uint8Array([3]),
    });
    mockSetKey.mockResolvedValue(undefined);
    mockSetE2EEEnabled.mockResolvedValue(undefined);
    mockOrchestratorAcquire.mockResolvedValue(undefined);
    mockOrchestratorPublishTo.mockResolvedValue(undefined);
    mockOrchestratorTeardown.mockResolvedValue(undefined);
  });

  it('TrackSubscribed adds remote audio track to playback manager', async () => {
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    const room = capturedRooms[capturedRooms.length - 1];
    expect(result.current.playbackManager.trackCount).toBe(0);

    // Simulate a remote audio track subscription
    await act(async () => {
      room.emit('trackSubscribed', {
        sid: 'remote-audio-1',
        kind: 'audio',
        mediaStreamTrack: { kind: 'audio', readyState: 'live' },
      }, { source: 'microphone' }, { identity: 'alice' });
    });

    expect(result.current.playbackManager.trackCount).toBe(1);
  });

  it('TrackUnsubscribed removes remote audio track from playback manager', async () => {
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    const room = capturedRooms[capturedRooms.length - 1];

    await act(async () => {
      room.emit('trackSubscribed', {
        sid: 'remote-audio-1',
        kind: 'audio',
        mediaStreamTrack: { kind: 'audio', readyState: 'live' },
      }, { source: 'microphone' }, { identity: 'alice' });
    });
    expect(result.current.playbackManager.trackCount).toBe(1);

    await act(async () => {
      room.emit('trackUnsubscribed', {
        sid: 'remote-audio-1',
        kind: 'audio',
      }, {}, { identity: 'alice' });
    });
    expect(result.current.playbackManager.trackCount).toBe(0);
  });

  it('disconnectRoom disposes playback manager and creates a fresh one', async () => {
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    const room = capturedRooms[capturedRooms.length - 1];

    // Add a remote track
    await act(async () => {
      room.emit('trackSubscribed', {
        sid: 'remote-audio-1',
        kind: 'audio',
        mediaStreamTrack: { kind: 'audio', readyState: 'live' },
      }, { source: 'microphone' }, { identity: 'alice' });
    });

    const managerBefore = result.current.playbackManager;
    expect(managerBefore.trackCount).toBe(1);

    await act(async () => {
      await result.current.disconnectRoom();
    });

    // Old manager is disposed
    expect(managerBefore.isDisposed).toBe(true);
    // New manager is fresh
    expect(result.current.playbackManager).not.toBe(managerBefore);
    expect(result.current.playbackManager.trackCount).toBe(0);
    expect(result.current.playbackManager.isDisposed).toBe(false);
  });

  it('video tracks are not added to playback manager', async () => {
    const { result } = renderHook(() =>
      useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
    );

    await act(async () => {
      await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
    });

    const room = capturedRooms[capturedRooms.length - 1];

    await act(async () => {
      room.emit('trackSubscribed', {
        sid: 'remote-video-1',
        kind: 'video',
        mediaStreamTrack: { kind: 'video', readyState: 'live' },
      }, { source: 'camera' }, { identity: 'alice' });
    });

    expect(result.current.playbackManager.trackCount).toBe(0);
  });

  // ─── HUSHHQ-78: blocked playback surfacing ──────────

  it('rejected audio play() surfaces isRemoteAudioPlaybackBlocked=true through the hook', async () => {
    const playSpy = vi
      .spyOn(HTMLAudioElement.prototype, 'play')
      .mockRejectedValue(new DOMException('NotAllowedError'));
    try {
      const { result } = renderHook(() =>
        useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
      );

      await act(async () => {
        await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
      });

      // Bind a real container so the manager appends + plays.
      const container = document.createElement('div');
      document.body.appendChild(container);
      await act(async () => {
        result.current.playbackManager.bindContainer(container);
      });

      const room = capturedRooms[capturedRooms.length - 1];
      await act(async () => {
        room.emit(
          'trackSubscribed',
          {
            sid: 'remote-audio-1',
            kind: 'audio',
            mediaStreamTrack: { kind: 'audio', readyState: 'live' },
          },
          { source: 'microphone' },
          { identity: 'alice' },
        );
        // Let the rejected play() promise drain through React state.
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.isRemoteAudioPlaybackBlocked).toBe(true);
    } finally {
      playSpy.mockRestore();
    }
  });

  it('resumeRemoteAudioPlayback retries and clears the blocked flag when play() resolves', async () => {
    const playSpy = vi
      .spyOn(HTMLAudioElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('NotAllowedError'));
    try {
      const { result } = renderHook(() =>
        useRoom({ wsClient, getToken, currentUserId: 'u1', getStore, voiceKeyRotationHours: 2 }),
      );

      await act(async () => {
        await result.current.connectRoom(ROOM_NAME, 'TestUser', CHANNEL_ID);
      });

      const container = document.createElement('div');
      document.body.appendChild(container);
      await act(async () => {
        result.current.playbackManager.bindContainer(container);
      });

      const room = capturedRooms[capturedRooms.length - 1];
      await act(async () => {
        room.emit(
          'trackSubscribed',
          {
            sid: 'remote-audio-1',
            kind: 'audio',
            mediaStreamTrack: { kind: 'audio', readyState: 'live' },
          },
          { source: 'microphone' },
          { identity: 'alice' },
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.isRemoteAudioPlaybackBlocked).toBe(true);

      playSpy.mockResolvedValueOnce(undefined);
      await act(async () => {
        await result.current.resumeRemoteAudioPlayback();
      });

      expect(result.current.isRemoteAudioPlaybackBlocked).toBe(false);
    } finally {
      playSpy.mockRestore();
    }
  });
});
