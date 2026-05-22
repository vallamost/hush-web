import { useState, useRef, useCallback, useEffect } from 'react';
import { Room, RoomEvent, Track, ExternalE2EEKeyProvider } from 'livekit-client';

// Import E2EE worker for LiveKit encryption
// @ts-ignore - Vite will resolve this URL correctly
import E2EEWorker from 'livekit-client/e2ee-worker?worker';

import * as mlsGroupLib from '../lib/mlsGroup';
import * as mlsStoreLib from '../lib/mlsStore';
import * as hushCryptoLib from '../lib/hushCrypto';
import * as apiLib from '../lib/api';
import { getDeviceId } from './useAuth';
import {
  parseVoiceParticipantMlsIdentity,
  isElectedVoiceMlsRemover,
} from '../lib/voiceParticipantMetadata';
import { NOISE_GATE_WORKLET_URL, getMicFilterSettings } from '../lib/micProcessing';
import { CaptureOrchestrator } from '../audio/capture/CaptureOrchestrator';
import { LiveKitRoomAdapter } from '../audio/adapters/LiveKitRoomAdapter';
import { CAPTURE_PROFILES, resolveMode, isMobileWebAudio } from '../audio';
import { PlaybackManager } from '../audio/playback/PlaybackManager';
import { getActiveAuthInstanceUrlSync, normalizeInstanceUrl } from '../lib/authInstanceStore';
import { buildLiveKitWsUrl } from '../lib/livekitUrl';

import {
  attachRemoteTrackListeners,
  preloadNoiseGateWorklet,
  publishScreen as trackPublishScreen,
  unpublishScreen as trackUnpublishScreen,
  switchScreenSource as trackSwitchScreenSource,
  changeQuality as trackChangeQuality,
  publishWebcam as trackPublishWebcam,
  stopLocalMediaTrack,
  unpublishWebcam as trackUnpublishWebcam,
  watchScreen as trackWatchScreen,
  unwatchScreen as trackUnwatchScreen,
} from '../lib/trackManager';
import { DEFAULT_QUALITY, MEDIA_SOURCES } from '../utils/constants';

/**
 * Decode a base64 string to a Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
function fromBase64(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function shouldUseActiveInstanceForVoice() {
  if (typeof window === 'undefined') return false;
  if (window.hushDesktop?.isDesktop) return true;
  const protocol = window.location?.protocol;
  return protocol !== 'http:' && protocol !== 'https:';
}

function resolveVoiceBaseUrl(baseUrl = '') {
  const normalized = normalizeInstanceUrl(baseUrl);
  if (normalized) return normalized;
  return shouldUseActiveInstanceForVoice() ? getActiveAuthInstanceUrlSync() : '';
}

function buildApiUrl(path, baseUrl = '') {
  if (path.startsWith('http')) return path;
  const normalized = normalizeInstanceUrl(baseUrl);
  return normalized ? `${normalized}${path}` : path;
}

function createVoiceMlsApi(baseUrl = '') {
  return {
    getMLSVoiceGroupInfo: (token, channelId) => apiLib.getMLSVoiceGroupInfo(token, channelId, baseUrl),
    putMLSVoiceGroupInfo: (token, channelId, groupInfoBase64, epoch) => apiLib.putMLSVoiceGroupInfo(token, channelId, groupInfoBase64, epoch, baseUrl),
    postMLSVoiceCommit: (token, channelId, commitBytesBase64, epoch, groupInfoBase64) => apiLib.postMLSVoiceCommit(token, channelId, commitBytesBase64, epoch, groupInfoBase64, baseUrl),
  };
}

function buildLiveKitUrl(baseUrl = '', serverUrl = null) {
  // `buildLiveKitWsUrl` parses every input via the URL constructor and
  // accepts only ws:/wss: in the result. Any non-http(s) instance
  // origin or a misconfigured VITE_LIVEKIT_URL throws here rather than
  // silently driving the LiveKit client at an attacker-controlled host.
  return buildLiveKitWsUrl({
    serverUrl,
    envOverride: import.meta.env.VITE_LIVEKIT_URL || null,
    instanceOrigin: normalizeInstanceUrl(baseUrl),
    pageOrigin: typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : null,
  });
}

/**
 * LiveKit-based room connection hook.
 * Voice E2EE is fully MLS-based: frame keys are derived via MLS export_secret
 * (RFC 9420 §8.4) and applied to LiveKit ExternalE2EEKeyProvider.
 *
 * @param {{ wsClient: object, getToken: () => string|null, currentUserId: string, getStore: () => Promise<IDBDatabase>, voiceKeyRotationHours?: number, baseUrl?: string }} deps
 * @returns {Object} Room state and media controls
 */
export function useRoom({ wsClient, getToken, currentUserId, getStore, voiceKeyRotationHours, baseUrl = '' }) {
  // ─── Connection State ─────────────────────────────────
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState(null);
  const [localTracks, setLocalTracks] = useState(new Map());
  const [remoteTracks, setRemoteTracks] = useState(new Map());
  const [participants, setParticipants] = useState([]);
  const [isE2EEEnabled, setIsE2EEEnabled] = useState(false);
  const [voiceEpoch, setVoiceEpoch] = useState(null);
  const [isVoiceReconnecting, setIsVoiceReconnecting] = useState(false);
  const [voiceReconnectFailed, setVoiceReconnectFailed] = useState(false);
  const [activeSpeakerIds, setActiveSpeakerIds] = useState([]);
  const [localSpeaking, setLocalSpeaking] = useState(false);

  // ─── Click-to-Watch Screen Shares ─────────────────────
  const [availableScreens, setAvailableScreens] = useState(new Map());
  const [watchedScreens, setWatchedScreens] = useState(new Set());
  const [loadingScreens, setLoadingScreens] = useState(new Set());

  // ─── Refs ─────────────────────────────────────────────
  const roomRef = useRef(null);
  const localTracksRef = useRef(new Map());
  const remoteTracksRef = useRef(new Map());
  const availableScreensRef = useRef(new Map());
  const watchedScreensRef = useRef(new Set());
  const loadingScreensRef = useRef(new Set());
  const e2eeKeyProviderRef = useRef(null);
  const voiceEpochRef = useRef(null);
  const voiceMlsApiRef = useRef(null);
  const voiceSelfUpdateTimerRef = useRef(null);
  const voiceWsUnsubscribeRef = useRef(null);
  const roomNameRef = useRef(null);
  const channelIdRef = useRef(null);
  const connectionEpochRef = useRef(0);
  const reconnectAttemptCountRef = useRef(0);

  // ─── Capture Orchestrator ─────────────────────────────
  const orchestratorRef = useRef(null);
  const adapterRef = useRef(null);
  const observerUnsubRef = useRef(null);

  // ─── Playback Manager ───────────────────────────────
  const playbackManagerRef = useRef(new PlaybackManager());

  // ─── Debounced State Updates ──────────────────────────
  const pendingLocalTracksUpdateRef = useRef(false);
  const pendingRemoteTracksUpdateRef = useRef(false);
  const pendingScreensUpdateRef = useRef(false);

  const scheduleLocalTracksUpdate = useCallback(() => {
    if (pendingLocalTracksUpdateRef.current) return;
    pendingLocalTracksUpdateRef.current = true;
    requestAnimationFrame(() => {
      setLocalTracks(new Map(localTracksRef.current));
      pendingLocalTracksUpdateRef.current = false;
    });
  }, []);

  const scheduleRemoteTracksUpdate = useCallback(() => {
    if (pendingRemoteTracksUpdateRef.current) return;
    pendingRemoteTracksUpdateRef.current = true;
    requestAnimationFrame(() => {
      setRemoteTracks(new Map(remoteTracksRef.current));
      pendingRemoteTracksUpdateRef.current = false;
    });
  }, []);

  const scheduleScreensUpdate = useCallback(() => {
    if (pendingScreensUpdateRef.current) return;
    pendingScreensUpdateRef.current = true;
    requestAnimationFrame(() => {
      setAvailableScreens(new Map(availableScreensRef.current));
      setWatchedScreens(new Set(watchedScreensRef.current));
      setLoadingScreens(new Set(loadingScreensRef.current));
      pendingScreensUpdateRef.current = false;
    });
  }, []);

  // ─── Shutdown Mic Capture ─────────────────────────────
  const shutdownMicCapture = useCallback(async () => {
    const orch = orchestratorRef.current;
    const adapter = adapterRef.current;
    if (!orch) return;
    if (adapter && orch.isLive) {
      await orch.unpublish(adapter);
    } else {
      await orch.teardown();
    }
    if (observerUnsubRef.current) {
      observerUnsubRef.current();
      observerUnsubRef.current = null;
    }
    setLocalSpeaking(false);
    orchestratorRef.current = null;
    adapterRef.current = null;
  }, []);

  const syncParticipantsFromRoom = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = Array.from(room.remoteParticipants.values()).map((p) => ({
      id: p.identity,
      displayName: p.name || p.identity,
    }));
    setParticipants((prev) => {
      if (
        prev.length === next.length
        && prev.every((p, i) => p.id === next[i]?.id && p.displayName === next[i]?.displayName)
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  // ─── Connect to LiveKit Room ──────────────────────────
  const connectRoom = useCallback(
    async (roomName, displayName, channelId) => {
      const epoch = ++connectionEpochRef.current;
      const isStale = () => epoch !== connectionEpochRef.current;
      if (!wsClient) {
        setError('WebSocket not connected. Please try again.');
        return;
      }
      setError(null);
      try {
        if (roomRef.current) {
          roomRef.current.disconnect();
          roomRef.current = null;
          // Clear stale playback elements from the previous room session.
          playbackManagerRef.current.dispose();
          playbackManagerRef.current = new PlaybackManager();
        }
        // Cancel any in-flight voice WS listeners from a previous session
        if (voiceWsUnsubscribeRef.current) {
          voiceWsUnsubscribeRef.current();
          voiceWsUnsubscribeRef.current = null;
        }
        if (voiceSelfUpdateTimerRef.current) {
          clearInterval(voiceSelfUpdateTimerRef.current);
          voiceSelfUpdateTimerRef.current = null;
        }

        localTracksRef.current.clear();
        remoteTracksRef.current.clear();
        availableScreensRef.current.clear();
        watchedScreensRef.current.clear();
        setLocalTracks(new Map());
        setRemoteTracks(new Map());
        setAvailableScreens(new Map());
        setWatchedScreens(new Set());
        setParticipants([]);
        setActiveSpeakerIds([]);
        setIsReady(false);
        setIsE2EEEnabled(false);
        setVoiceEpoch(null);
        setVoiceReconnectFailed(false);
        voiceEpochRef.current = null;
        reconnectAttemptCountRef.current = 0;
        roomNameRef.current = roomName;
        channelIdRef.current = channelId || null;

        const accessToken = getToken?.();
        if (!accessToken) {
          throw new Error('Session required. Please sign in again.');
        }

        const voiceBaseUrl = resolveVoiceBaseUrl(baseUrl);
        const voiceMlsApi = createVoiceMlsApi(voiceBaseUrl);
        voiceMlsApiRef.current = voiceMlsApi;
        const response = await fetch(buildApiUrl('/api/livekit/token', voiceBaseUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            roomName,
            participantName: displayName,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const msg = errorData.error || 'Failed to get LiveKit token';
          if (response.status === 401) {
            throw new Error('Session invalid. Please sign in again.');
          }
          if (response.status === 403 && errorData.code === 'muted') {
            throw new Error(msg);
          }
          throw new Error(msg);
        }

        const { token, livekitUrl: serverLiveKitUrl } = await response.json();
        if (isStale()) return;

        // ─── MLS Voice Group Setup ────────────────────────────────────────────
        // Signal state: "Reconnecting..." indicator is shown during the async
        // MLS group join/create flow. Audio is blocked until a valid frame key
        // is derived and applied. No unencrypted audio ever flows.
        setIsVoiceReconnecting(true);

        let keyProvider = null;
        let worker = null;

        try {
          keyProvider = new ExternalE2EEKeyProvider();
          e2eeKeyProviderRef.current = keyProvider;
          worker = new E2EEWorker();

          // Build MLS dependency bundle for this session
          const db = await getStore();
          const credential = await mlsStoreLib.getCredential(db);
          const mlsDeps = {
            db,
            token: accessToken,
            credential,
            mlsStore: mlsStoreLib,
            hushCrypto: hushCryptoLib,
            api: voiceMlsApi,
          };

          // Determine whether to create or join: 404 from server = first participant.
          // Catch GroupAlreadyExists to handle React StrictMode double-fire in dev.
          const existingGroup = await voiceMlsApi.getMLSVoiceGroupInfo(accessToken, channelId);
          if (existingGroup) {
            await mlsGroupLib.joinVoiceGroup(mlsDeps, channelId);
          } else {
            try {
              await mlsGroupLib.createVoiceGroup(mlsDeps, channelId);
            } catch (createErr) {
              const msg = String(createErr?.message ?? createErr);
              if (msg.includes('GroupAlreadyExists') || msg.includes('already exists')) {
                console.warn('[livekit] Voice group already exists locally (StrictMode re-fire), continuing');
              } else {
                throw createErr;
              }
            }
          }

          // Derive frame key from MLS export_secret and apply to LiveKit key provider
          const { frameKeyBytes, epoch: initialEpoch } = await mlsGroupLib.exportVoiceFrameKey(mlsDeps, channelId);
          await keyProvider.setKey(new Uint8Array(frameKeyBytes), initialEpoch % 256);

          setVoiceEpoch(initialEpoch);
          voiceEpochRef.current = initialEpoch;
          setIsE2EEEnabled(true);
          setIsVoiceReconnecting(false);
        } catch (mlsErr) {
          console.error('[livekit] MLS voice group setup failed:', mlsErr);
          setIsVoiceReconnecting(false);
          keyProvider = null;
          worker = null;
        }

        if (!keyProvider || !worker) {
          throw new Error('Could not establish encrypted voice - E2EE is required.');
        }
        if (isStale()) return;

        // ─── LiveKit Room Options ─────────────────────────────────────────────
        const roomOptions = {
          dynacast: true,
          adaptiveStream: true,
          e2ee: {
            keyProvider,
            worker,
          },
        };

        const room = new Room(roomOptions);

        // LiveKit's E2EE manager is configured by `roomOptions.e2ee`, but the
        // per-frame encryption transformer stays dormant until
        // `setE2EEEnabled(true)` runs. Without this, audio frames would be
        // published in clear even though MLS export_secret already derived a
        // frame key. Voice MUST fail closed: any rejection here aborts the
        // connect, tears the half-built room down, and surfaces an error.
        // CORE-INVARIANTS - Voice Rooms and LiveKit: voice media must never
        // run without E2EE when the runtime advertises encrypted voice.
        try {
          await room.setE2EEEnabled(true);
        } catch (e2eeErr) {
          try { await room.disconnect(); } catch { /* noop */ }
          e2eeKeyProviderRef.current = null;
          voiceEpochRef.current = null;
          setVoiceEpoch(null);
          setIsE2EEEnabled(false);
          throw new Error(
            `Could not enable encrypted voice: ${e2eeErr?.message ?? e2eeErr}`,
          );
        }

        // ParticipantConnected: update participant list.
        // In MLS, no per-user key exchange is needed. The new participant joins
        // the MLS group independently via External Commit. The mls.commit WS
        // event (handled below) triggers frame key re-derivation.
        room.on(RoomEvent.ParticipantConnected, (participant) => {
          if (isStale()) return;
          console.log(`[livekit] Participant connected: ${participant.identity}`);
          setParticipants((prev) => {
            if (prev.some((p) => p.id === participant.identity)) return prev;
            return [
              ...prev,
              {
                id: participant.identity,
                displayName: participant.name || participant.identity,
              },
            ];
          });
          queueMicrotask(syncParticipantsFromRoom);
        });

        // ParticipantDisconnected: update list and clean tracks/screens,
        // then rotate the voice MLS group so the departed device's
        // leaf is evicted and a fresh frame key is derived. Removal
        // is the security-critical step — without it the departed
        // device's leaf would linger in the MLS group and still
        // share the voice frame key after it disconnected.
        room.on(RoomEvent.ParticipantDisconnected, (participant) => {
          if (isStale()) return;
          console.log(`[livekit] Participant disconnected: ${participant.identity}`);
          setParticipants((prev) =>
            prev.filter((p) => p.id !== participant.identity),
          );
          queueMicrotask(syncParticipantsFromRoom);
          for (const [trackSid, info] of availableScreensRef.current.entries()) {
            if (info.participantId === participant.identity) {
              availableScreensRef.current.delete(trackSid);
              watchedScreensRef.current.delete(trackSid);
            }
          }
          scheduleScreensUpdate();
          for (const [trackSid, info] of remoteTracksRef.current.entries()) {
            if (info.participant.identity === participant.identity) {
              remoteTracksRef.current.delete(trackSid);
            }
          }
          scheduleRemoteTracksUpdate();

          // Evict the departed device's MLS leaf. Resolve identity
          // STRICTLY from the LiveKit-token metadata (which the
          // server stamps with `userId:deviceId`). LiveKit
          // `participant.identity` is intentionally only the user
          // id — using it as the MLS removal target either misses
          // the leaf or evicts the wrong device's leaf, so never
          // fall back to it.
          const mlsIdentity = parseVoiceParticipantMlsIdentity(participant);
          if (!mlsIdentity) {
            console.warn(
              '[livekit] Participant disconnected without valid MLS metadata; skipping voice MLS eviction',
              { liveKitIdentity: participant.identity },
            );
            return;
          }
          const selfIdentity = currentUserId ? `${currentUserId}:${getDeviceId()}` : null;
          if (selfIdentity && mlsIdentity === selfIdentity) {
            // Local-session self-disconnect: the local teardown
            // path destroys our own group state; no remote
            // eviction to issue.
            return;
          }
          const channelId = channelIdRef.current;
          if (!channelId) return;

          // Single-remover election: with 3+ remaining clients, two
          // or more would otherwise issue concurrent removal commits
          // for the same departed leaf from the same epoch. The
          // election is a pure function of the candidate set (local
          // identity + parsed remote metadata), so every remaining
          // client picks the same remover without coordination. The
          // unelected clients still observe the resulting `mls.commit`
          // through the normal voice MLS stream.
          if (!selfIdentity) {
            console.warn(
              '[livekit] Voice MLS eviction skipped: no local MLS identity available',
              { mlsIdentity },
            );
            return;
          }
          const room = roomRef.current;
          if (!room || typeof room.remoteParticipants?.values !== 'function') {
            console.warn(
              '[livekit] Voice MLS eviction skipped: remaining participant set unavailable',
              { mlsIdentity },
            );
            return;
          }
          const remoteParticipants = room.remoteParticipants.values();
          const elected = isElectedVoiceMlsRemover(
            selfIdentity,
            mlsIdentity,
            remoteParticipants,
          );
          if (!elected) {
            console.debug(
              '[livekit] Voice MLS eviction skipped: another remaining client is elected remover',
              { departed: mlsIdentity, local: selfIdentity },
            );
            return;
          }

          // Defer to a microtask so we do not block LiveKit's
          // event loop while rotating MLS state.
          queueMicrotask(async () => {
            if (isStale()) return;
            try {
              const db = await getStore();
              const credential = await mlsStoreLib.getCredential(db);
              const tok = getToken?.();
              if (!tok) {
                console.error(
                  '[livekit] Voice MLS eviction skipped: no auth token available',
                  { mlsIdentity },
                );
                return;
              }
              const mlsDeps = {
                db,
                token: tok,
                credential,
                mlsStore: mlsStoreLib,
                hushCrypto: hushCryptoLib,
                api: voiceMlsApi,
              };
              await mlsGroupLib.removeMemberFromVoiceGroup(mlsDeps, channelId, mlsIdentity);
              const { frameKeyBytes, epoch } = await mlsGroupLib.exportVoiceFrameKey(
                mlsDeps,
                channelId,
              );
              if (e2eeKeyProviderRef.current) {
                await e2eeKeyProviderRef.current.setKey(
                  new Uint8Array(frameKeyBytes),
                  epoch % 256,
                );
              }
              setVoiceEpoch(epoch);
              voiceEpochRef.current = epoch;
              console.log(
                `[livekit] Evicted ${mlsIdentity} from voice MLS group (epoch ${epoch})`,
              );
            } catch (err) {
              // Failing eviction must NOT disable E2EE or downgrade
              // to unencrypted audio — the existing frame key stays
              // in use until the next successful rotation. Surface
              // the failure loudly so it shows up in diagnostics.
              console.error(
                '[livekit] Voice MLS eviction failed; keeping prior frame key',
                { mlsIdentity, err: err instanceof Error ? err.message : err },
              );
            }
          });
        });

        const trackRefs = {
          remoteTracksRef,
          availableScreensRef,
          watchedScreensRef,
        };
        attachRemoteTrackListeners(room, trackRefs, scheduleRemoteTracksUpdate, scheduleScreensUpdate);

        // Route remote audio tracks to the PlaybackManager.
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === 'audio') {
            playbackManagerRef.current.addRemoteAudioTrack(track.sid, track.mediaStreamTrack);
          }
        });
        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          if (track.kind === 'audio') {
            playbackManagerRef.current.removeRemoteAudioTrack(track.sid);
          }
        });

        // Connected: E2EE key is already applied before room.connect() - no
        // additional setKey call needed here. setIsE2EEEnabled was already set
        // above after MLS key derivation succeeded.
        room.on(RoomEvent.Connected, () => {
          if (isStale()) return;
        });

        // Reconnecting: LiveKit is attempting to re-establish the WebSocket
        // connection (e.g. page refresh, network interruption). Show the
        // overlay and count the attempt so we can surface a Rejoin prompt
        // after 3 failures.
        room.on(RoomEvent.Reconnecting, () => {
          if (isStale()) return;
          reconnectAttemptCountRef.current += 1;
          setIsVoiceReconnecting(true);
          console.log(`[livekit] Reconnecting... (attempt ${reconnectAttemptCountRef.current})`);
        });

        // Reconnected: re-derive the MLS frame key from the current epoch so
        // the E2EE key provider is fresh after the socket was re-established.
        // Re-setting the same key if the epoch is unchanged is idempotent.
        room.on(RoomEvent.Reconnected, async () => {
          if (isStale()) return;
          reconnectAttemptCountRef.current = 0;
          try {
            const db = await getStore();
            const credential = await mlsStoreLib.getCredential(db);
            const tok = getToken();
            const mlsDeps = {
              db,
              token: tok,
              credential,
              mlsStore: mlsStoreLib,
              hushCrypto: hushCryptoLib,
              api: voiceMlsApi,
            };
            const { frameKeyBytes, epoch } = await mlsGroupLib.exportVoiceFrameKey(mlsDeps, channelIdRef.current);
            if (e2eeKeyProviderRef.current) {
              await e2eeKeyProviderRef.current.setKey(new Uint8Array(frameKeyBytes), epoch % 256);
            }
            setVoiceEpoch(epoch);
            voiceEpochRef.current = epoch;
            console.log(`[livekit] Reconnected - frame key re-derived (epoch ${epoch})`);
          } catch (err) {
            console.error('[livekit] Frame key re-derivation after reconnect failed:', err);
          }
          setIsVoiceReconnecting(false);
        });

        room.on(RoomEvent.Disconnected, () => {
          if (isStale()) return;
          console.log('[livekit] Disconnected from room');
          setIsReady(false);
          // If 3 or more reconnect attempts preceded this disconnect, surface the
          // manual "Rejoin" prompt instead of a generic error.
          if (reconnectAttemptCountRef.current >= 3) {
            setVoiceReconnectFailed(true);
            setIsVoiceReconnecting(false);
          } else {
            setError('Disconnected from room');
          }
        });

        room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
          if (isStale()) return;
          setActiveSpeakerIds(speakers.map((s) => s.identity));
        });

        // Browser builds use the current origin. Electron's packaged
        // renderer is app://localhost, so voice must target the active
        // auth instance's /livekit/ reverse proxy instead.
        const livekitUrl = buildLiveKitUrl(voiceBaseUrl, serverLiveKitUrl);
        // autoSubscribe is intentionally `true`: @livekit/components-react's
        // prebuilt grid/tile components mounted via RoomContext.Provider
        // assume tracks are subscribed by the time they observe a remote
        // participant. Switching to `false` would silently drop remote
        // audio + video unless we also wire explicit per-publication
        // subscribe calls in the consumer (voice-channel-view +
        // participant-tile). The privacy/bandwidth trade-off (every
        // participant decrypts every track on join) is real but
        // secondary to functional correctness — track it as a follow-up
        // (selective subscribe + per-track UI focus) rather than
        // flipping the flag here. See PR #4 review item P0 for context.
        await room.connect(livekitUrl, token, { autoSubscribe: true });

        if (isStale()) {
          room.disconnect();
          return;
        }

        roomRef.current = room;

        // ─── Voice MLS WS Listeners ──────────────────────────────────────────
        // Re-derive frame key when a voice commit advances the epoch.
        const handleVoiceCommit = async (data) => {
          if (data.group_type !== 'voice' || data.channel_id !== channelIdRef.current) return;
          // Own commits are already applied locally when we sent them
          if (data.sender_id === currentUserId && data.sender_device_id === getDeviceId()) return;
          try {
            const db = await getStore();
            const credential = await mlsStoreLib.getCredential(db);
            const tok = getToken();
            const mlsDeps = {
              db,
              token: tok,
              credential,
              mlsStore: mlsStoreLib,
              hushCrypto: hushCryptoLib,
              api: voiceMlsApi,
            };
            const commitBytes = fromBase64(data.commit_bytes);
            await mlsGroupLib.processVoiceCommit(mlsDeps, data.channel_id, commitBytes);
            const { frameKeyBytes, epoch } = await mlsGroupLib.exportVoiceFrameKey(mlsDeps, data.channel_id);
            if (e2eeKeyProviderRef.current) {
              await e2eeKeyProviderRef.current.setKey(new Uint8Array(frameKeyBytes), epoch % 256);
            }
            setVoiceEpoch(epoch);
            voiceEpochRef.current = epoch;
          } catch (err) {
            console.error('[livekit] Failed to process voice MLS commit:', err);
          }
        };

        // Clean up local state when the server signals the voice group is gone
        // (last participant left and webhook fired DeleteMLSGroupInfo).
        const handleVoiceGroupDestroyed = async (data) => {
          if (data.channel_id !== channelIdRef.current) return;
          try {
            const db = await getStore();
            const credential = await mlsStoreLib.getCredential(db);
            const mlsDeps = {
              db,
              token: getToken(),
              credential,
              mlsStore: mlsStoreLib,
              hushCrypto: hushCryptoLib,
              api: voiceMlsApi,
            };
            await mlsGroupLib.destroyVoiceGroup(mlsDeps, data.channel_id);
          } catch (err) {
            console.warn('[livekit] voice_group_destroyed cleanup failed:', err);
          }
        };

        wsClient.on('mls.commit', handleVoiceCommit);
        wsClient.on('voice_group_destroyed', handleVoiceGroupDestroyed);
        voiceWsUnsubscribeRef.current = () => {
          wsClient.off('mls.commit', handleVoiceCommit);
          wsClient.off('voice_group_destroyed', handleVoiceGroupDestroyed);
        };

        // ─── Periodic Self-Update (key rotation) ─────────────────────────────
        const rotationMs = (voiceKeyRotationHours ?? 2) * 3600000;
        voiceSelfUpdateTimerRef.current = setInterval(async () => {
          try {
            const db = await getStore();
            const credential = await mlsStoreLib.getCredential(db);
            const tok = getToken();
            const mlsDeps = {
              db,
              token: tok,
              credential,
              mlsStore: mlsStoreLib,
              hushCrypto: hushCryptoLib,
              api: voiceMlsApi,
            };
            await mlsGroupLib.performVoiceSelfUpdate(mlsDeps, channelIdRef.current);
            const { frameKeyBytes, epoch } = await mlsGroupLib.exportVoiceFrameKey(mlsDeps, channelIdRef.current);
            if (e2eeKeyProviderRef.current) {
              await e2eeKeyProviderRef.current.setKey(new Uint8Array(frameKeyBytes), epoch % 256);
            }
            setVoiceEpoch(epoch);
            voiceEpochRef.current = epoch;
          } catch (err) {
            console.warn('[livekit] Periodic voice key rotation failed:', err);
          }
        }, rotationMs);

        // ─── Initial Participants ─────────────────────────────────────────────
        const initialParticipants = [];
        for (const p of room.remoteParticipants.values()) {
          initialParticipants.push({
            id: p.identity,
            displayName: p.name || p.identity,
          });
          for (const [, pub] of p.trackPublications) {
            if (!pub.trackSid) continue;
            if (pub.source === Track.Source.ScreenShare && pub.kind === Track.Kind.Video) {
              availableScreensRef.current.set(pub.trackSid, {
                trackSid: pub.trackSid,
                participantId: p.identity,
                participantName: p.name || p.identity,
                kind: pub.kind,
                source: pub.source,
                publication: pub,
              });
            } else if (pub.source !== Track.Source.ScreenShareAudio) {
              pub.setSubscribed(true);
            }
          }
        }
        scheduleScreensUpdate();
        setParticipants(initialParticipants);

        setIsReady(true);
        preloadNoiseGateWorklet();
        console.log('[livekit] Connected to room:', roomName);
      } catch (err) {
        if (isStale()) return;
        console.error('[livekit] Connection error:', err);
        setError(err.message);
      }
    },
    [scheduleRemoteTracksUpdate, scheduleScreensUpdate, syncParticipantsFromRoom, wsClient, currentUserId, getToken, getStore, voiceKeyRotationHours, baseUrl],
  );

  // ─── Disconnect from Room ─────────────────────────────
  const disconnectRoom = useCallback(async () => {
    connectionEpochRef.current++;
    setError(null);

    // Stop periodic key rotation
    if (voiceSelfUpdateTimerRef.current) {
      clearInterval(voiceSelfUpdateTimerRef.current);
      voiceSelfUpdateTimerRef.current = null;
    }

    // Remove voice MLS WS listeners
    if (voiceWsUnsubscribeRef.current) {
      voiceWsUnsubscribeRef.current();
      voiceWsUnsubscribeRef.current = null;
    }

    const voiceMlsApi = voiceMlsApiRef.current ?? createVoiceMlsApi(resolveVoiceBaseUrl(baseUrl));

    if (!roomRef.current) {
      // Still clean up MLS state even if room already gone
      const chId = channelIdRef.current;
      if (chId) {
        try {
          const db = await getStore();
          const credential = await mlsStoreLib.getCredential(db);
          const mlsDeps = {
            db,
            token: getToken(),
            credential,
            mlsStore: mlsStoreLib,
            hushCrypto: hushCryptoLib,
            api: voiceMlsApi,
          };
          await mlsGroupLib.destroyVoiceGroup(mlsDeps, chId);
        } catch { /* fire-and-forget */ }
      }
      voiceEpochRef.current = null;
      voiceMlsApiRef.current = null;
      reconnectAttemptCountRef.current = 0;
      setVoiceEpoch(null);
      setIsVoiceReconnecting(false);
      setVoiceReconnectFailed(false);
      // Dispose playback even when room ref is already gone.
      playbackManagerRef.current.dispose();
      playbackManagerRef.current = new PlaybackManager();
      return;
    }

    try {
      const localTracksMap = localTracksRef.current;
      if (localTracksMap && typeof localTracksMap.forEach === 'function') {
        localTracksMap.forEach((info) => {
          stopLocalMediaTrack(info?.track);
        });
      }

      await shutdownMicCapture();

      // Dispose playback manager to remove any stale audio elements.
      // A fresh manager is created so subsequent connectRoom calls start clean.
      playbackManagerRef.current.dispose();
      playbackManagerRef.current = new PlaybackManager();

      // Destroy local voice group state (fire-and-forget - server handles group
      // deletion when the last participant leaves via the LiveKit webhook)
      const chId = channelIdRef.current;
      if (chId) {
        try {
          const db = await getStore();
          const credential = await mlsStoreLib.getCredential(db);
          const mlsDeps = {
            db,
            token: getToken(),
            credential,
            mlsStore: mlsStoreLib,
            hushCrypto: hushCryptoLib,
            api: voiceMlsApi,
          };
          await mlsGroupLib.destroyVoiceGroup(mlsDeps, chId);
        } catch { /* fire-and-forget */ }
      }

      await roomRef.current.disconnect();
      roomRef.current = null;
      e2eeKeyProviderRef.current = null;
      voiceEpochRef.current = null;
      voiceMlsApiRef.current = null;
      roomNameRef.current = null;
      channelIdRef.current = null;

      localTracksRef.current.clear();
      remoteTracksRef.current.clear();
      availableScreensRef.current.clear();
      watchedScreensRef.current.clear();

      setLocalTracks(new Map());
      setRemoteTracks(new Map());
      setAvailableScreens(new Map());
      setWatchedScreens(new Set());
      setParticipants([]);
      setIsReady(false);
      setIsE2EEEnabled(false);
      setVoiceEpoch(null);
      setIsVoiceReconnecting(false);
      setVoiceReconnectFailed(false);
      reconnectAttemptCountRef.current = 0;

      console.log('[livekit] Disconnected from room');
    } catch (err) {
      console.error('[livekit] Disconnect error:', err);
    }
  }, [shutdownMicCapture, getStore, getToken]);

  // ─── Unpublish Screen Share ───────────────────────────
  const unpublishScreen = useCallback(async () => {
    if (!roomRef.current) return;
    try {
      await trackUnpublishScreen(roomRef.current, { localTracksRef });
      scheduleLocalTracksUpdate();
    } catch (err) {
      console.error('[livekit] Unpublish screen error:', err);
    }
  }, [scheduleLocalTracksUpdate]);

  // ─── Publish Screen Share ─────────────────────────────
  const publishScreen = useCallback(
    async (qualityKey = DEFAULT_QUALITY) => {
      if (!roomRef.current) throw new Error('Room not connected');
      try {
        const stream = await trackPublishScreen(roomRef.current, { localTracksRef }, {
          qualityKey,
          onTrackEnded: unpublishScreen,
        });
        scheduleLocalTracksUpdate();
        return stream ?? null;
      } catch (err) {
        if (err.name === 'NotAllowedError') return null;
        throw err;
      }
    },
    [unpublishScreen, scheduleLocalTracksUpdate],
  );

  // ─── Switch Screen Source ─────────────────────────────
  const switchScreenSource = useCallback(
    async (qualityKey = DEFAULT_QUALITY) => {
      if (!roomRef.current) throw new Error('Room not connected');
      const result = await trackSwitchScreenSource(
        roomRef.current,
        { localTracksRef },
        qualityKey,
        unpublishScreen,
      );
      scheduleLocalTracksUpdate();
      return result;
    },
    [unpublishScreen, scheduleLocalTracksUpdate],
  );

  // ─── Change Quality ───────────────────────────────────
  const changeQuality = useCallback(
    async (qualityKey) => {
      if (!roomRef.current) return;
      await trackChangeQuality(roomRef.current, { localTracksRef }, qualityKey, {
        onTrackEnded: unpublishScreen,
      });
      scheduleLocalTracksUpdate();
    },
    [unpublishScreen, scheduleLocalTracksUpdate],
  );

  // ─── Publish Webcam ───────────────────────────────────
  const publishWebcam = useCallback(
    async (deviceId = null) => {
      if (!roomRef.current) throw new Error('Room not connected');
      if (roomRef.current.localParticipant === null) {
        throw new Error('Room localParticipant unavailable (mid-connect)');
      }
      await trackPublishWebcam(roomRef.current, { localTracksRef }, deviceId);
      scheduleLocalTracksUpdate();
    },
    [scheduleLocalTracksUpdate],
  );

  // ─── Unpublish Webcam ─────────────────────────────────
  const unpublishWebcam = useCallback(async () => {
    if (!roomRef.current) return;
    await trackUnpublishWebcam(roomRef.current, { localTracksRef });
    scheduleLocalTracksUpdate();
  }, [scheduleLocalTracksUpdate]);

  // ─── Publish Microphone ───────────────────────────────
  const publishMic = useCallback(
    async (deviceId = null) => {
      if (!roomRef.current) throw new Error('Room not connected');
      // livekit-client populates `localParticipant` on connect; before
      // that it is `null`. We bail out only on the explicit-null case
      // (real Room mid-connect) so the test MockRoom (which omits the
      // field entirely) keeps working.
      if (roomRef.current.localParticipant === null) {
        throw new Error('Room localParticipant unavailable (mid-connect)');
      }
      const mode = resolveMode({ isMobileWebAudio: isMobileWebAudio() });
      const profile = CAPTURE_PROFILES[mode];
      try {
        await shutdownMicCapture();
        const orch = new CaptureOrchestrator({
          noiseGateWorkletUrl: NOISE_GATE_WORKLET_URL,
          initialFilterSettings: getMicFilterSettings(),
        });
        orchestratorRef.current = orch;
        await orch.acquire(profile, deviceId);
        const adapter = new LiveKitRoomAdapter(
          roomRef.current.localParticipant,
          localTracksRef,
          scheduleLocalTracksUpdate,
        );
        adapterRef.current = adapter;
        await orch.publishTo(adapter);

        // Subscribe to local speaking state transitions from the observer.
        // The observer is created by the orchestrator after publish succeeds.
        if (orch.observer) {
          observerUnsubRef.current = orch.observer.subscribe((obs) => {
            setLocalSpeaking(obs.isSpeaking);
          });
        }
      } catch (err) {
        await shutdownMicCapture();
        throw err;
      }
    },
    [scheduleLocalTracksUpdate, shutdownMicCapture],
  );

  // ─── Unpublish Microphone ─────────────────────────────
  const unpublishMic = useCallback(async () => {
    await shutdownMicCapture();
    scheduleLocalTracksUpdate();
  }, [scheduleLocalTracksUpdate, shutdownMicCapture]);

  // ─── Mute/Unmute Microphone (keeps track published) ──
  const muteMic = useCallback(async () => {
    if (!roomRef.current) return;
    await orchestratorRef.current?.mute();
  }, []);

  const unmuteMic = useCallback(async () => {
    if (!roomRef.current) return;
    await orchestratorRef.current?.unmute();
  }, []);

  /**
   * Applies updated mic filter settings to the active published microphone
   * without forcing the user to leave and rejoin the room.
   *
   * @param {Partial<{ noiseGateEnabled: boolean, noiseGateThresholdDb: number }>} settings
   */
  const updateMicFilterSettings = useCallback((settings) => {
    orchestratorRef.current?.updateFilterSettings(settings);
  }, []);

  // ─── Watch Screen Share ───────────────────────────────
  const watchScreen = useCallback(
    async (trackSid) => {
      if (!roomRef.current) return;
      try {
        await trackWatchScreen(roomRef.current, {
          availableScreensRef,
          watchedScreensRef,
          loadingScreensRef,
        }, trackSid, scheduleScreensUpdate);
      } catch (err) {
        console.error('[livekit] Watch screen error:', err);
      }
    },
    [scheduleScreensUpdate],
  );

  // ─── Unwatch Screen Share ─────────────────────────────
  const unwatchScreen = useCallback(
    async (trackSid) => {
      if (!roomRef.current) return;
      remoteTracksRef.current.delete(trackSid);
      watchedScreensRef.current.delete(trackSid);
      scheduleRemoteTracksUpdate();
      scheduleScreensUpdate();
      try {
        await trackUnwatchScreen(roomRef.current, {
          availableScreensRef,
          watchedScreensRef,
        }, trackSid, scheduleScreensUpdate);
      } catch (err) {
        console.error('[livekit] Unwatch screen error:', err);
      }
    },
    [scheduleRemoteTracksUpdate, scheduleScreensUpdate],
  );

  // ─── Periodic + visibility sync for participants ──────
  // Safety net for missed SDK events (browser throttling/background tabs).
  useEffect(() => {
    const intervalId = setInterval(() => {
      syncParticipantsFromRoom();
    }, 1500);
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      syncParticipantsFromRoom();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [syncParticipantsFromRoom]);

  // ─── Cleanup on Unmount ───────────────────────────────
  useEffect(() => {
    return () => {
      if (voiceWsUnsubscribeRef.current) {
        voiceWsUnsubscribeRef.current();
        voiceWsUnsubscribeRef.current = null;
      }
      if (voiceSelfUpdateTimerRef.current) {
        clearInterval(voiceSelfUpdateTimerRef.current);
        voiceSelfUpdateTimerRef.current = null;
      }
      const room = roomRef.current;
      const localTracksMap = localTracksRef.current;
      if (room) {
        connectionEpochRef.current++;
        if (localTracksMap && typeof localTracksMap.forEach === 'function') {
          localTracksMap.forEach((info) => {
            if (info?.track && typeof info.track.stop === 'function') {
              info.track.stop();
            }
          });
        }
        room.disconnect();
        roomRef.current = null;
      }
      // Teardown-only: release capture resources without unpublishing
      // or scheduling UI updates. The room is already disconnecting,
      // and setState on an unmounted component is a React anti-pattern.
      orchestratorRef.current?.teardown().catch(() => {});
      orchestratorRef.current = null;
      adapterRef.current = null;
      playbackManagerRef.current.dispose();
    };
  }, []);

  return {
    // Connection state
    isReady,
    error,
    localTracks,
    remoteTracks,
    participants,
    isE2EEEnabled,
    voiceEpoch,
    isVoiceReconnecting,
    voiceReconnectFailed,
    activeSpeakerIds,
    localSpeaking,
    // Room connection
    connectRoom,
    disconnectRoom,
    // Screen sharing
    publishScreen,
    unpublishScreen,
    switchScreenSource,
    changeQuality,
    // Webcam
    publishWebcam,
    unpublishWebcam,
    // Microphone
    publishMic,
    unpublishMic,
    muteMic,
    unmuteMic,
    updateMicFilterSettings,
    // Playback
    playbackManager: playbackManagerRef.current,
    // Click-to-watch
    availableScreens,
    watchedScreens,
    loadingScreens,
    watchScreen,
    unwatchScreen,
    // Underlying livekit-client Room instance. Exposed so the orchestrator
    // can hand it to `@livekit/components-react`'s `RoomContext.Provider`,
    // letting the prebuilt GridLayout / ParticipantTile components read
    // tracks from the same Room we wired the MLS frame transformer into.
    room: roomRef.current,
  };
}
