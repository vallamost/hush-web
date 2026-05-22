import { describe, expect, it, vi } from 'vitest';

import { stopLocalMediaTrack } from './trackManager';

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
