import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi } from 'vitest';

import { playVoiceJoinCue, playVoiceLeaveCue } from './voiceChannelSounds.js';

const SOUNDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../assets/sounds');

describe('voiceChannelSounds', () => {
  it('exposes join and leave cue players', () => {
    expect(typeof playVoiceJoinCue).toBe('function');
    expect(typeof playVoiceLeaveCue).toBe('function');
  });

  it('does not throw where media playback is unavailable (jsdom/autoplay)', () => {
    // jsdom HTMLMediaElement.play throws synchronously; the cue must swallow it.
    expect(() => playVoiceJoinCue()).not.toThrow();
    expect(() => playVoiceLeaveCue()).not.toThrow();
  });

  it('attempts playback on each call', () => {
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play');
    playVoiceJoinCue();
    playVoiceLeaveCue();
    expect(playSpy).toHaveBeenCalledTimes(2);
    playSpy.mockRestore();
  });

  // Format guard: Electron's bundled Chromium rejects PCM WAV from the media
  // element (silent on desktop), so the cue assets must ship as MP3. Fails CI if
  // anyone swaps in a .wav.
  it('ships the cue assets as MP3, never WAV', () => {
    const files = readdirSync(SOUNDS_DIR);
    expect(files).toContain('join.mp3');
    expect(files).toContain('leave.mp3');
    expect(files.filter((f) => f.toLowerCase().endsWith('.wav'))).toEqual([]);
  });
});
