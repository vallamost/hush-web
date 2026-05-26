import { describe, it, expect, vi, beforeEach } from 'vitest';

// jsdom does not provide MediaStream. Polyfill for tests.
if (typeof globalThis.MediaStream === 'undefined') {
  globalThis.MediaStream = class MockMediaStream {
    private _tracks: MediaStreamTrack[];
    constructor(tracks?: MediaStreamTrack[]) { this._tracks = tracks ?? []; }
    getTracks() { return this._tracks; }
    getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
  } as unknown as typeof MediaStream;
}

import { PlaybackManager } from '../playback/PlaybackManager';

function mockMediaStreamTrack(): MediaStreamTrack {
  return {
    kind: 'audio',
    readyState: 'live',
    id: `track-${Math.random().toString(36).slice(2)}`,
  } as unknown as MediaStreamTrack;
}

describe('PlaybackManager', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  // ─── Lifecycle ──────────────────────────────────────

  it('starts with zero tracks and not muted', () => {
    const manager = new PlaybackManager();
    expect(manager.trackCount).toBe(0);
    expect(manager.isMuted).toBe(false);
    expect(manager.isDisposed).toBe(false);
    manager.dispose();
  });

  it('bindContainer attaches pending tracks to the DOM', () => {
    const manager = new PlaybackManager();
    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    expect(container.childElementCount).toBe(0);

    manager.bindContainer(container);
    expect(container.childElementCount).toBe(1);
    expect(container.children[0].tagName).toBe('AUDIO');

    manager.dispose();
  });

  it('unbindContainer removes elements from DOM but keeps them in memory', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);
    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    expect(container.childElementCount).toBe(1);

    manager.unbindContainer();
    expect(container.childElementCount).toBe(0);
    expect(manager.trackCount).toBe(1); // still tracked

    // Re-bind: elements re-attach
    manager.bindContainer(container);
    expect(container.childElementCount).toBe(1);

    manager.dispose();
  });

  // ─── Add / Remove ─────────────────────────────────

  it('addRemoteAudioTrack creates an audio element in the container', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    expect(manager.trackCount).toBe(1);

    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.style.display).toBe('none');
    expect(audio!.autoplay).toBe(true);

    manager.dispose();
  });

  it('addRemoteAudioTrack sets srcObject with the track', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);
    const track = mockMediaStreamTrack();

    manager.addRemoteAudioTrack('t1', track);

    const audio = container.querySelector('audio')!;
    expect(audio.srcObject).toBeInstanceOf(MediaStream);

    manager.dispose();
  });

  it('addRemoteAudioTrack is idempotent for same sid', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    expect(manager.trackCount).toBe(1);
    expect(container.childElementCount).toBe(1);

    manager.dispose();
  });

  it('removeRemoteAudioTrack removes the element from DOM', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    expect(container.childElementCount).toBe(1);

    manager.removeRemoteAudioTrack('t1');
    expect(container.childElementCount).toBe(0);
    expect(manager.trackCount).toBe(0);

    manager.dispose();
  });

  it('removeRemoteAudioTrack clears srcObject', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    const audio = container.querySelector('audio')!;
    expect(audio.srcObject).not.toBeNull();

    manager.removeRemoteAudioTrack('t1');
    expect(audio.srcObject).toBeNull();

    manager.dispose();
  });

  it('removeRemoteAudioTrack is safe for unknown sid', () => {
    const manager = new PlaybackManager();
    manager.removeRemoteAudioTrack('nonexistent'); // should not throw
    manager.dispose();
  });

  // ─── Mute ─────────────────────────────────────────

  it('setRemoteAudioMuted mutes all managed elements', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    manager.addRemoteAudioTrack('t2', mockMediaStreamTrack());

    manager.setRemoteAudioMuted(true);
    expect(manager.isMuted).toBe(true);

    const audios = container.querySelectorAll('audio');
    expect(audios[0].muted).toBe(true);
    expect(audios[1].muted).toBe(true);

    manager.setRemoteAudioMuted(false);
    expect(audios[0].muted).toBe(false);
    expect(audios[1].muted).toBe(false);

    manager.dispose();
  });

  it('new tracks inherit current muted state', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);

    manager.setRemoteAudioMuted(true);
    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());

    const audio = container.querySelector('audio')!;
    expect(audio.muted).toBe(true);

    manager.dispose();
  });

  // ─── Dispose ──────────────────────────────────────

  it('dispose removes all elements and prevents further operations', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    manager.addRemoteAudioTrack('t2', mockMediaStreamTrack());
    expect(container.childElementCount).toBe(2);

    manager.dispose();
    expect(container.childElementCount).toBe(0);
    expect(manager.trackCount).toBe(0);
    expect(manager.isDisposed).toBe(true);

    // Further adds are no-ops
    manager.addRemoteAudioTrack('t3', mockMediaStreamTrack());
    expect(manager.trackCount).toBe(0);
  });

  it('dispose is idempotent', () => {
    const manager = new PlaybackManager();
    manager.dispose();
    manager.dispose();
    expect(manager.isDisposed).toBe(true);
  });

  // ─── Autoplay Retry ───────────────────────────────

  it('addRemoteAudioTrack calls play() on the element', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);

    // Mock HTMLAudioElement.play at prototype level for this test
    const playSpy = vi.spyOn(HTMLAudioElement.prototype, 'play')
      .mockResolvedValue(undefined);

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    expect(playSpy).toHaveBeenCalled();

    playSpy.mockRestore();
    manager.dispose();
  });

  // ─── Blocked Playback (HUSHHQ-78) ─────────────────

  it('appends the element to the container before calling play() when bound', () => {
    const manager = new PlaybackManager();
    manager.bindContainer(container);

    let parentAtPlay: ParentNode | null = 'unset' as unknown as ParentNode | null;
    const playSpy = vi
      .spyOn(HTMLAudioElement.prototype, 'play')
      .mockImplementation(function (this: HTMLAudioElement) {
        parentAtPlay = this.parentNode;
        return Promise.resolve();
      });

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());

    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(parentAtPlay).toBe(container);

    playSpy.mockRestore();
    manager.dispose();
  });

  it('defers play() until bindContainer attaches a track added before binding', () => {
    const manager = new PlaybackManager();

    const playSpy = vi
      .spyOn(HTMLAudioElement.prototype, 'play')
      .mockResolvedValue(undefined);

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    expect(playSpy).not.toHaveBeenCalled();

    manager.bindContainer(container);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(1);

    playSpy.mockRestore();
    manager.dispose();
  });

  it('rejected play() marks blocked playback and fires the callback with true', async () => {
    const events: boolean[] = [];
    const manager = new PlaybackManager({
      onPlaybackBlockedChange: (blocked) => events.push(blocked),
    });
    manager.bindContainer(container);

    const playSpy = vi
      .spyOn(HTMLAudioElement.prototype, 'play')
      .mockRejectedValue(new DOMException('NotAllowedError'));

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    // Let the rejected promise propagate.
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.hasBlockedPlayback).toBe(true);
    expect(events).toEqual([true]);

    playSpy.mockRestore();
    manager.dispose();
  });

  it('resumeBlockedPlayback retries blocked elements and clears state when play() resolves', async () => {
    const events: boolean[] = [];
    const manager = new PlaybackManager({
      onPlaybackBlockedChange: (blocked) => events.push(blocked),
    });
    manager.bindContainer(container);

    const playSpy = vi
      .spyOn(HTMLAudioElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('NotAllowedError'));

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.hasBlockedPlayback).toBe(true);
    expect(events).toEqual([true]);

    playSpy.mockResolvedValueOnce(undefined);
    await manager.resumeBlockedPlayback();

    expect(manager.hasBlockedPlayback).toBe(false);
    expect(events).toEqual([true, false]);

    playSpy.mockRestore();
    manager.dispose();
  });

  it('removing the only blocked track clears blocked state and fires callback with false', async () => {
    const events: boolean[] = [];
    const manager = new PlaybackManager({
      onPlaybackBlockedChange: (blocked) => events.push(blocked),
    });
    manager.bindContainer(container);

    const playSpy = vi
      .spyOn(HTMLAudioElement.prototype, 'play')
      .mockRejectedValue(new DOMException('NotAllowedError'));

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.hasBlockedPlayback).toBe(true);

    manager.removeRemoteAudioTrack('t1');

    expect(manager.hasBlockedPlayback).toBe(false);
    expect(events).toEqual([true, false]);

    playSpy.mockRestore();
    manager.dispose();
  });

  it('setRemoteAudioMuted(true) does not clear blocked playback state', async () => {
    const events: boolean[] = [];
    const manager = new PlaybackManager({
      onPlaybackBlockedChange: (blocked) => events.push(blocked),
    });
    manager.bindContainer(container);

    const playSpy = vi
      .spyOn(HTMLAudioElement.prototype, 'play')
      .mockRejectedValue(new DOMException('NotAllowedError'));

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.hasBlockedPlayback).toBe(true);

    manager.setRemoteAudioMuted(true);

    expect(manager.hasBlockedPlayback).toBe(true);
    expect(events).toEqual([true]);

    playSpy.mockRestore();
    manager.dispose();
  });

  it('dispose clears blocked state', async () => {
    const events: boolean[] = [];
    const manager = new PlaybackManager({
      onPlaybackBlockedChange: (blocked) => events.push(blocked),
    });
    manager.bindContainer(container);

    const playSpy = vi
      .spyOn(HTMLAudioElement.prototype, 'play')
      .mockRejectedValue(new DOMException('NotAllowedError'));

    manager.addRemoteAudioTrack('t1', mockMediaStreamTrack());
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.hasBlockedPlayback).toBe(true);

    manager.dispose();
    expect(manager.hasBlockedPlayback).toBe(false);

    playSpy.mockRestore();
  });
});
