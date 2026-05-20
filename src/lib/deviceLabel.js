/**
 * Derives a human-readable device label from a browser user agent string.
 *
 * Examples:
 *   - Chrome on macOS
 *   - Safari on iPhone
 *   - Firefox on Windows
 *   - Desktop on macOS  (packaged Electron client)
 *
 * The Electron packaged app is distinguished from a regular browser via
 * two complementary signals: the desktop preload bridge
 * (`window.hushDesktop`) when invoked from the renderer, and the
 * `Electron/` token in the user-agent string when the function is
 * called with an explicit `userAgentOverride`.
 *
 * @param {string|null} userAgentOverride
 * @returns {string}
 */
export function getReadableDeviceLabel(userAgentOverride = null) {
  const userAgent = resolveUserAgent(userAgentOverride);
  const platform = detectPlatformName(userAgent);
  if (isPackagedDesktopRuntime(userAgent, userAgentOverride)) {
    return `Desktop on ${platform}`;
  }
  const browser = detectBrowserName(userAgent);
  return `${browser} on ${platform}`;
}

function isPackagedDesktopRuntime(userAgent, userAgentOverride) {
  if (userAgentOverride == null) {
    if (typeof window !== 'undefined') {
      const bridge = window.hushDesktop;
      if (bridge && bridge.isDesktop === true) return true;
    }
  }
  return /Electron\//.test(userAgent);
}

function resolveUserAgent(userAgentOverride) {
  if (typeof userAgentOverride === 'string' && userAgentOverride.trim() !== '') {
    return userAgentOverride;
  }
  if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
    return navigator.userAgent;
  }
  return '';
}

function detectBrowserName(userAgent) {
  if (/(EdgiOS|EdgA|Edg)\//.test(userAgent)) return 'Edge';
  if (/OPR\//.test(userAgent) || /Opera\//.test(userAgent)) return 'Opera';
  if (/SamsungBrowser\//.test(userAgent)) return 'Samsung Internet';
  if (/FxiOS\//.test(userAgent) || /Firefox\//.test(userAgent)) return 'Firefox';
  if (/CriOS\//.test(userAgent) || /Chrome\//.test(userAgent) || /Chromium\//.test(userAgent)) {
    return 'Chrome';
  }
  if (/Safari\//.test(userAgent) && /Version\//.test(userAgent)) return 'Safari';
  return 'Browser';
}

export function detectPlatformName(userAgent) {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Macintosh/.test(userAgent) && /Mobile/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android';
  if (/CrOS/.test(userAgent)) return 'ChromeOS';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'macOS';
  if (/Windows NT/.test(userAgent)) return 'Windows';
  if (/Linux/.test(userAgent)) return 'Linux';
  return 'device';
}
