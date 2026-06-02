/**
 * Voice channel join/leave cue sounds (HUSHHQ-119).
 *
 * Local UI playback only: decorative cues played through the user's audio
 * output, never routed into the captured/transmitted mic stream.
 *
 * Triggered from useRoom's LiveKit lifecycle handlers (self/peer connect +
 * disconnect). Switching channels plays leave (old room) then join (new room).
 *
 * Format note: the cues are MP3, not WAV. Electron's bundled Chromium rejects
 * PCM WAV from the media element with a format error (MEDIA_ELEMENT_ERROR), so a
 * WAV cue is silent in the desktop app. MP3 decodes in both the web Chromium and
 * Electron, so it is the portable choice.
 */
import joinSoundUrl from '../assets/sounds/join.mp3';
import leaveSoundUrl from '../assets/sounds/leave.mp3';
import streamStartSoundUrl from '../assets/sounds/streamStart.mp3';
import streamEndSoundUrl from '../assets/sounds/streamEnd.mp3';

const CUE_VOLUME = 0.6;

/**
 * Builds a play() that fires the cue on each call. Clones a preloaded element so
 * rapid overlapping triggers do not cut each other off. Failures are swallowed
 * (autoplay rejection async, no media in jsdom sync); by the time a user is in a
 * voice room they have interacted, so playback is allowed.
 *
 * @param {string} url resolved asset URL for the cue
 * @returns {() => void}
 */
function createCue(url) {
  if (typeof Audio === 'undefined') return () => {};
  const base = new Audio(url);
  base.preload = 'auto';
  return () => {
    try {
      const node = /** @type {HTMLAudioElement} */ (base.cloneNode(true));
      node.volume = CUE_VOLUME;
      const played = node.play();
      if (played && typeof played.catch === 'function') {
        played.catch(() => {});
      }
    } catch {
      // Playback unavailable (autoplay policy, no audio device, jsdom): ignore.
    }
  };
}

export const playVoiceJoinCue = createCue(joinSoundUrl);
export const playVoiceLeaveCue = createCue(leaveSoundUrl);
// Screen-share start/end cues. Fired when the screen-share track actually
// publishes/subscribes (the live stream), not when the source picker opens.
export const playVoiceStreamStartCue = createCue(streamStartSoundUrl);
export const playVoiceStreamEndCue = createCue(streamEndSoundUrl);
