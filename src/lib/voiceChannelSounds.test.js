import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi } from 'vitest';

import {
  playVoiceJoinCue,
  playVoiceLeaveCue,
  playVoiceStreamStartCue,
  playVoiceStreamEndCue,
} from './voiceChannelSounds.js';

const SOUNDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../assets/sounds');
const CUE_FILES = ['join.mp3', 'leave.mp3', 'streamStart.mp3', 'streamEnd.mp3'];
const CUES = [
  playVoiceJoinCue,
  playVoiceLeaveCue,
  playVoiceStreamStartCue,
  playVoiceStreamEndCue,
];

// MPEG-1 Layer III bitrate table (kbps) by header index. hush cues are 48 kHz
// stereo => MPEG-1 Layer III.
const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];

/** Reads the bitrate (kbps) from the first MPEG-1 Layer III frame header. */
function mp3BitrateKbps(buf) {
  let i = 0;
  // Skip an ID3v2 tag if present (syncsafe size at bytes 6-9).
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    i = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  }
  for (; i < buf.length - 3; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (buf[i + 1] >> 3) & 0x03; // 3 = MPEG-1
    const layer = (buf[i + 1] >> 1) & 0x03; // 1 = Layer III
    const brIndex = (buf[i + 2] >> 4) & 0x0f;
    if (version === 3 && layer === 1 && brIndex > 0 && brIndex < 15) {
      return MPEG1_L3_KBPS[brIndex];
    }
  }
  return null;
}

describe('voiceChannelSounds', () => {
  it('exposes join/leave/stream cue players', () => {
    for (const cue of CUES) expect(typeof cue).toBe('function');
  });

  it('does not throw where media playback is unavailable (jsdom/autoplay)', () => {
    // jsdom HTMLMediaElement.play throws synchronously; the cue must swallow it.
    for (const cue of CUES) expect(() => cue()).not.toThrow();
  });

  it('attempts playback on each call', () => {
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play');
    for (const cue of CUES) cue();
    expect(playSpy).toHaveBeenCalledTimes(CUES.length);
    playSpy.mockRestore();
  });

  // Format guard: Electron's bundled Chromium rejects PCM WAV from the media
  // element (silent on desktop), so the cue assets must ship as MP3. Fails CI if
  // anyone swaps in a .wav.
  it('ships every cue asset as MP3, never WAV', () => {
    const files = readdirSync(SOUNDS_DIR);
    for (const name of CUE_FILES) expect(files).toContain(name);
    expect(files.filter((f) => f.toLowerCase().endsWith('.wav'))).toEqual([]);
  });

  // Bitrate guard: Electron's bundled Chromium rejects 320 kbps MP3 with a
  // format error (silent on desktop); 192 kbps and below decode. Keep cues
  // <= 192k. Fails CI if a high-bitrate export slips in.
  it('keeps every cue at <= 192 kbps (Electron rejects 320k MP3)', () => {
    for (const name of CUE_FILES) {
      const kbps = mp3BitrateKbps(readFileSync(join(SOUNDS_DIR, name)));
      expect(kbps, `${name}: could not read MPEG-1 L3 bitrate`).not.toBeNull();
      expect(kbps, `${name}: bitrate must be <= 192k for Electron`).toBeLessThanOrEqual(192);
    }
  });
});
