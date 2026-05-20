import { describe, expect, it } from 'vitest';
import { getReadableDeviceLabel } from './deviceLabel';

describe('getReadableDeviceLabel', () => {
  it('detects Chrome on macOS', () => {
    expect(
      getReadableDeviceLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
  });

  it('detects Safari on iPhone', () => {
    expect(
      getReadableDeviceLabel(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iPhone');
  });

  it('detects Firefox on Windows', () => {
    expect(
      getReadableDeviceLabel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
      ),
    ).toBe('Firefox on Windows');
  });

  it('detects Chrome on Android', () => {
    expect(
      getReadableDeviceLabel(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
  });

  it('falls back to a generic device label when the user agent is unknown', () => {
    expect(getReadableDeviceLabel('CustomAgent/1.0')).toBe('Browser on device');
  });

  it('distinguishes the packaged desktop client via the Electron UA token', () => {
    expect(
      getReadableDeviceLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Hush/0.1.30-mvp Chrome/132.0.0.0 Electron/34.0.0 Safari/537.36',
      ),
    ).toBe('Desktop on macOS');
    expect(
      getReadableDeviceLabel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Electron/34.0.0 Safari/537.36',
      ),
    ).toBe('Desktop on Windows');
  });
});
