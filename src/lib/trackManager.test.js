import { describe, expect, it, vi } from 'vitest';

import { releaseLocalCaptureTracks, stopLocalMediaTrack } from './trackManager';

describe('stopLocalMediaTrack', () => {
  it('stops both LiveKit wrapper and underlying media stream track', () => {
    const wrapperStop = vi.fn();
    const mediaStop = vi.fn();
    const track = {
      stop: wrapperStop,
      mediaStreamTrack: { stop: mediaStop },
    };

    stopLocalMediaTrack(track);

    expect(wrapperStop).toHaveBeenCalledTimes(1);
    expect(mediaStop).toHaveBeenCalledTimes(1);
  });

  it('also stops legacy nested track handles when present', () => {
    const nestedStop = vi.fn();

    stopLocalMediaTrack({ track: { stop: nestedStop } });

    expect(nestedStop).toHaveBeenCalledTimes(1);
  });

  it('swallows teardown errors', () => {
    expect(() =>
      stopLocalMediaTrack({
        stop: () => {
          throw new Error('already stopped');
        },
        mediaStreamTrack: {
          stop: () => {
            throw new Error('already stopped');
          },
        },
      }),
    ).not.toThrow();
  });
});

describe('releaseLocalCaptureTracks', () => {
  it('stops every local track and clears the ref map', () => {
    const webcamStop = vi.fn();
    const screenWrapperStop = vi.fn();
    const screenNativeStop = vi.fn();
    const localTracksRef = {
      current: new Map([
        ['webcam', { track: { stop: webcamStop } }],
        [
          'screen',
          {
            track: {
              stop: screenWrapperStop,
              mediaStreamTrack: { stop: screenNativeStop },
            },
          },
        ],
      ]),
    };

    releaseLocalCaptureTracks(localTracksRef);

    expect(webcamStop).toHaveBeenCalledTimes(1);
    expect(screenWrapperStop).toHaveBeenCalledTimes(1);
    expect(screenNativeStop).toHaveBeenCalledTimes(1);
    expect(localTracksRef.current.size).toBe(0);
  });

  it('is safe when the ref is missing or already empty', () => {
    expect(() => releaseLocalCaptureTracks(null)).not.toThrow();
    expect(() => releaseLocalCaptureTracks({ current: new Map() })).not.toThrow();
  });
});
