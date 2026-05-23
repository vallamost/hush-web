/**
 * Remote track subscription, screen share, webcam, and click-to-watch.
 * Mic capture is owned by CaptureOrchestrator; remote audio playback
 * is owned by PlaybackManager. This module retains non-mic track
 * management only.
 */

import { RoomEvent, Track, LocalVideoTrack, LocalAudioTrack } from 'livekit-client';
export { preloadNoiseGateWorklet } from './micProcessing';
import {
  QUALITY_PRESETS,
  DEFAULT_QUALITY,
  MEDIA_SOURCES,
  WEBCAM_PRESET,
  SCREEN_SHARE_MIN_FPS,
} from '../utils/constants';

/**
 * Stop a LiveKit local track and its underlying MediaStreamTrack.
 *
 * LiveKit's wrapper `stop()` should release capture, but Electron/macOS can
 * keep the camera device active for a few seconds if the wrapped native track
 * remains live through a disconnect race. Stopping both layers is idempotent
 * and keeps teardown deterministic.
 *
 * @param {unknown} track
 */
export function stopLocalMediaTrack(track) {
  if (!track || typeof track !== 'object') return;
  const maybeTrack = /** @type {{ stop?: () => void, mediaStreamTrack?: { stop?: () => void }, track?: { stop?: () => void } }} */ (track);
  if (typeof maybeTrack.stop === 'function') {
    try { maybeTrack.stop(); } catch { /* teardown */ }
  }
  if (typeof maybeTrack.mediaStreamTrack?.stop === 'function') {
    try { maybeTrack.mediaStreamTrack.stop(); } catch { /* teardown */ }
  }
  if (typeof maybeTrack.track?.stop === 'function') {
    try { maybeTrack.track.stop(); } catch { /* teardown */ }
  }
}

/**
 * Registers room event listeners for remote track and screen share updates.
 * @param {import('livekit-client').Room} room
 * @param {{ remoteTracksRef: import('react').MutableRefObject<Map>, availableScreensRef: import('react').MutableRefObject<Map>, watchedScreensRef: import('react').MutableRefObject<Set> }} refs
 * @param {() => void} scheduleRemoteTracksUpdate
 * @param {() => void} scheduleScreensUpdate
 */
export function attachRemoteTrackListeners(room, refs, scheduleRemoteTracksUpdate, scheduleScreensUpdate) {
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    refs.remoteTracksRef.current.set(track.sid, {
      track,
      participant,
      kind: track.kind,
      source: publication.source,
    });
    scheduleRemoteTracksUpdate();
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    refs.remoteTracksRef.current.delete(track.sid);
    scheduleRemoteTracksUpdate();
  });

  room.on(RoomEvent.TrackPublished, (publication, participant) => {
    // Screen share video → click-to-watch (don't auto-subscribe)
    if (
      publication.source === Track.Source.ScreenShare &&
      publication.kind === Track.Kind.Video
    ) {
      refs.availableScreensRef.current.set(publication.trackSid, {
        trackSid: publication.trackSid,
        participantId: participant.identity,
        participantName: participant.name || participant.identity,
        kind: publication.kind,
        source: publication.source,
        publication,
      });
      scheduleScreensUpdate();
      return;
    }
    // Screen share audio → don't subscribe until user watches the screen
    if (publication.source === Track.Source.ScreenShareAudio) {
      return;
    }
    // Everything else (webcam, mic) → auto-subscribe
    publication.setSubscribed(true);
  });

  room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
    if (publication.source === Track.Source.ScreenShare) {
      refs.availableScreensRef.current.delete(publication.trackSid);
      refs.watchedScreensRef.current.delete(publication.trackSid);
      scheduleScreensUpdate();
    }
    refs.remoteTracksRef.current.delete(publication.trackSid);
    scheduleRemoteTracksUpdate();
  });
}

/**
 * @param {import('livekit-client').Room} room
 * @param {{ localTracksRef: import('react').MutableRefObject<Map> }} refs
 * @param {{ qualityKey?: string, onTrackEnded?: () => void }} options
 */
export async function publishScreen(room, refs, options = {}) {
  const qualityKey = options.qualityKey ?? DEFAULT_QUALITY;
  const quality = QUALITY_PRESETS[qualityKey];
  // getDisplayMedia does not allow frameRate.min/exact (TypeError); use ideal only.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { cursor: 'always', frameRate: { ideal: quality.frameRate } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  if (!videoTrack || videoTrack.readyState !== 'live') {
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }
  // Hint encoder to prefer framerate over static detail (reduces FPS drops under load).
  if (quality.frameRate >= SCREEN_SHARE_MIN_FPS && typeof videoTrack.contentHint !== 'undefined') {
    videoTrack.contentHint = 'motion';
  }
  const frameRateConstraint =
    quality.frameRate >= SCREEN_SHARE_MIN_FPS
      ? { ideal: quality.frameRate, min: SCREEN_SHARE_MIN_FPS }
      : { ideal: quality.frameRate };
  if (quality.width && quality.height) {
    try {
      // min ensures we get full resolution (e.g. 1080p) when the source supports it, not a lower scale.
      await videoTrack.applyConstraints({
        width: { ideal: quality.width, min: quality.width },
        height: { ideal: quality.height, min: quality.height },
        frameRate: frameRateConstraint,
      });
    } catch (err) {
      console.warn('[livekit] Could not apply track constraints:', err);
    }
  } else if (quality.frameRate >= SCREEN_SHARE_MIN_FPS) {
    try {
      await videoTrack.applyConstraints({ frameRate: frameRateConstraint });
    } catch (err) {
      console.warn('[livekit] Could not apply frameRate constraints:', err);
    }
  }
  const localVideoTrack = new LocalVideoTrack(videoTrack);
  await room.localParticipant.publishTrack(localVideoTrack, {
    source: Track.Source.ScreenShare,
    screenShareEncoding: {
      maxBitrate: quality.bitrate,
      maxFramerate: quality.frameRate,
      ...(quality.frameRate >= SCREEN_SHARE_MIN_FPS && { priority: 'high' }),
    },
    simulcast: false,
    // Keep resolution (1080p); allow framerate to vary under load. maintain-framerate was crushing resolution to 144p.
    degradationPreference: 'maintain-resolution',
  });
  refs.localTracksRef.current.set(localVideoTrack.sid, {
    track: localVideoTrack,
    source: MEDIA_SOURCES.SCREEN,
  });
  if (options.onTrackEnded) {
    videoTrack.addEventListener('ended', options.onTrackEnded);
  }
  if (audioTrack && audioTrack.readyState === 'live') {
    try {
      const localAudioTrack = new LocalAudioTrack(audioTrack);
      await room.localParticipant.publishTrack(localAudioTrack, {
        source: Track.Source.ScreenShareAudio,
      });
      refs.localTracksRef.current.set(localAudioTrack.sid, {
        track: localAudioTrack,
        source: MEDIA_SOURCES.SCREEN_AUDIO,
      });
    } catch (audioErr) {
      console.warn('[livekit] Screen audio publish failed (non-fatal):', audioErr?.message);
    }
  }
  return stream;
}

/**
 * @param {import('livekit-client').Room} room
 * @param {{ localTracksRef: import('react').MutableRefObject<Map> }} refs
 */
export async function unpublishScreen(room, refs) {
  for (const [trackSid, info] of refs.localTracksRef.current.entries()) {
    if (info.source === MEDIA_SOURCES.SCREEN || info.source === MEDIA_SOURCES.SCREEN_AUDIO) {
      stopLocalMediaTrack(info.track);
      await room.localParticipant.unpublishTrack(info.track);
      refs.localTracksRef.current.delete(trackSid);
    }
  }
}

/**
 * Idempotently release every locally captured publication held in
 * `localTracksRef`. Stops both the LiveKit wrapper and the underlying
 * MediaStreamTrack for each entry, then empties the map. Does not
 * touch React state — callers schedule UI updates separately when
 * appropriate. Safe to call from leave / disconnect / unmount paths,
 * including paths that have already cleared the map.
 *
 * @param {{ current: Map }} localTracksRef
 */
export function releaseLocalCaptureTracks(localTracksRef) {
  const map = localTracksRef?.current;
  if (!map || typeof map.forEach !== 'function') return;
  map.forEach((info) => {
    stopLocalMediaTrack(info?.track);
  });
  if (typeof map.clear === 'function') {
    map.clear();
  }
}

/**
 * @param {import('livekit-client').Room} room
 * @param {{ localTracksRef: import('react').MutableRefObject<Map> }} refs
 * @param {string} qualityKey
 * @param {() => Promise<void>} unpublishScreenCb
 */
export async function switchScreenSource(room, refs, qualityKey, unpublishScreenCb) {
  const quality = QUALITY_PRESETS[qualityKey];
  const frameRateConstraint =
    quality.frameRate >= SCREEN_SHARE_MIN_FPS
      ? { ideal: quality.frameRate, min: SCREEN_SHARE_MIN_FPS }
      : { ideal: quality.frameRate };
  const screenEntry = Array.from(refs.localTracksRef.current.entries()).find(
    ([, info]) => info.source === MEDIA_SOURCES.SCREEN,
  );
  if (!screenEntry) throw new Error('No active screen share');
  const [, info] = screenEntry;
  // getDisplayMedia does not allow frameRate.min; use ideal only.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { cursor: 'always', frameRate: { ideal: quality.frameRate } },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const newTrack = stream.getVideoTracks()[0];
  if (quality.frameRate >= SCREEN_SHARE_MIN_FPS && typeof newTrack.contentHint !== 'undefined') {
    newTrack.contentHint = 'motion';
  }
  if (quality.width && quality.height) {
    try {
      await newTrack.applyConstraints({
        width: { ideal: quality.width, min: quality.width },
        height: { ideal: quality.height, min: quality.height },
        frameRate: frameRateConstraint,
      });
    } catch (err) {
      console.warn('[livekit] Could not apply track constraints:', err);
    }
  } else {
    try {
      await newTrack.applyConstraints({ frameRate: frameRateConstraint });
    } catch (err) {
      console.warn('[livekit] Could not apply frameRate constraints:', err);
    }
  }
  await info.track.replaceTrack(newTrack);
  if (unpublishScreenCb) {
    newTrack.addEventListener('ended', unpublishScreenCb);
  }
  return stream;
}

/**
 * Apply new screen-share quality by re-publishing the screen track so encoder
 * options (e.g. maxBitrate) and capture match the preset. Unpublishes then
 * publishes with the new qualityKey; user may need to re-select source in the
 * browser picker.
 *
 * @param {import('livekit-client').Room} room
 * @param {{ localTracksRef: import('react').MutableRefObject<Map> }} refs
 * @param {string} qualityKey
 * @param {{ onTrackEnded?: () => void }} [options]
 */
export async function changeQuality(room, refs, qualityKey, options = {}) {
  const quality = QUALITY_PRESETS[qualityKey];
  if (!quality) return;
  const screenEntry = Array.from(refs.localTracksRef.current.entries()).find(
    ([, info]) => info.source === MEDIA_SOURCES.SCREEN,
  );
  if (!screenEntry) return;

  await unpublishScreen(room, refs);
  await publishScreen(room, refs, {
    qualityKey,
    onTrackEnded: options.onTrackEnded,
  });
}

/**
 * @param {import('livekit-client').Room} room
 * @param {{ localTracksRef: import('react').MutableRefObject<Map> }} refs
 * @param {string|null} deviceId
 */
export async function publishWebcam(room, refs, deviceId = null) {
  const preset = WEBCAM_PRESET;
  const videoConstraints = {
    width: { ideal: preset.width },
    height: { ideal: preset.height },
    frameRate: { ideal: preset.frameRate },
  };
  if (deviceId) videoConstraints.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
  const videoTrack = stream.getVideoTracks()[0];
  const localVideoTrack = new LocalVideoTrack(videoTrack);
  await room.localParticipant.publishTrack(localVideoTrack, {
    source: Track.Source.Camera,
    videoEncoding: { maxBitrate: preset.bitrate, maxFramerate: preset.frameRate },
    simulcast: false,
  });
  refs.localTracksRef.current.set(localVideoTrack.sid, {
    track: localVideoTrack,
    source: MEDIA_SOURCES.WEBCAM,
  });
}

/**
 * @param {import('livekit-client').Room} room
 * @param {{ localTracksRef: import('react').MutableRefObject<Map> }} refs
 */
export async function unpublishWebcam(room, refs) {
  for (const [trackSid, info] of refs.localTracksRef.current.entries()) {
    if (info.source === MEDIA_SOURCES.WEBCAM) {
      stopLocalMediaTrack(info.track);
      await room.localParticipant.unpublishTrack(info.track);
      refs.localTracksRef.current.delete(trackSid);
    }
  }
}

// Mic publish/unpublish removed — now owned by CaptureOrchestrator via useRoom.

/**
 * @param {import('livekit-client').Room} room
 * @param {{ availableScreensRef: import('react').MutableRefObject<Map>, watchedScreensRef: import('react').MutableRefObject<Set>, loadingScreensRef: import('react').MutableRefObject<Set> }} refs
 * @param {string} trackSid
 * @param {() => void} scheduleScreensUpdate
 */
export async function watchScreen(room, refs, trackSid, scheduleScreensUpdate) {
  const screenInfo = refs.availableScreensRef.current.get(trackSid);
  if (!screenInfo) return;
  refs.loadingScreensRef.current.add(trackSid);
  scheduleScreensUpdate?.();
  try {
    await screenInfo.publication.setSubscribed(true);
    const participant = Array.from(room.remoteParticipants.values()).find(
      (p) => p.identity === screenInfo.participantId,
    );
    if (participant) {
      for (const [, pub] of participant.audioTrackPublications) {
        if (pub.source === Track.Source.ScreenShareAudio) {
          await pub.setSubscribed(true);
          break;
        }
      }
    }
    refs.watchedScreensRef.current.add(trackSid);
  } finally {
    refs.loadingScreensRef.current.delete(trackSid);
    scheduleScreensUpdate?.();
  }
}

/**
 * @param {import('livekit-client').Room} room
 * @param {{ availableScreensRef: import('react').MutableRefObject<Map>, watchedScreensRef: import('react').MutableRefObject<Set> }} refs
 * @param {string} trackSid
 * @param {() => void} [scheduleScreensUpdate]
 */
export async function unwatchScreen(room, refs, trackSid, scheduleScreensUpdate) {
  const screenInfo = refs.availableScreensRef.current.get(trackSid);
  if (!screenInfo) return;
  await screenInfo.publication.setSubscribed(false);
  const participant = Array.from(room.remoteParticipants.values()).find(
    (p) => p.identity === screenInfo.participantId,
  );
  if (participant) {
    for (const [, pub] of participant.audioTrackPublications) {
      if (pub.source === Track.Source.ScreenShareAudio) {
        await pub.setSubscribed(false);
        break;
      }
    }
  }
  refs.watchedScreensRef.current.delete(trackSid);
  scheduleScreensUpdate?.();
}
