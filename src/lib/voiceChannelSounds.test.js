import { describe, it, expect, vi } from 'vitest';

import { playVoiceJoinCue, playVoiceLeaveCue } from './voiceChannelSounds.js';

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
});
