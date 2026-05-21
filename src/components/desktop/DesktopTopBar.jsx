import { useBootController } from '../../hooks/useBootController.jsx';
import { useInstanceContext } from '../../contexts/InstanceContext.jsx';
import { DesktopOmnibar } from './DesktopOmnibar.jsx';
import { DesktopTelemetry } from './DesktopTelemetry.jsx';

/**
 * Reads the desktop bridge synchronously. The preload script runs before
 * any renderer JS, so `window.hushDesktop` is observable on first render.
 *
 * @returns {{ isDesktop: true, platform: NodeJS.Platform } | null}
 */
function readDesktopApi() {
  if (typeof window === 'undefined') return null;
  const api = window.hushDesktop;
  if (!api || api.isDesktop !== true) return null;
  return api;
}

/**
 * Boot states that mean the user has cleared auth and the topbar can
 * surface the operative-app controls (omnibar, telemetry, ping).
 */
const AUTHENTICATED_BOOT_STATES = new Set(['ready', 'booted']);

/** macOS `hiddenInset` traffic-light cluster width + breathing margin. */
const MAC_TRAFFIC_LIGHT_INSET_PX = 78;

/**
 * Fallback width for the Windows `titleBarOverlay` controls when the
 * `env(titlebar-area-*)` custom variables are not exposed by the host
 * (older Electron / non-overlay platforms). Matches the default Win11
 * caption-button cluster width.
 */
const WIN_OVERLAY_FALLBACK_PX = 140;

function computeSafeAreaVars(platform) {
  if (platform === 'darwin') {
    return { '--desktop-left-safe-area': `${MAC_TRAFFIC_LIGHT_INSET_PX}px` };
  }
  if (platform === 'win32') {
    return {
      '--desktop-right-safe-area':
        `calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - ${WIN_OVERLAY_FALLBACK_PX}px)))`,
    };
  }
  return {};
}

/**
 * Picks the first connected instance URL we can ping. Falls back to the
 * first known guild's `instanceUrl` so the readout still works while the
 * WebSocket session is rehydrating after a reload.
 *
 * @param {Array<{ instanceUrl?: string | null }>} mergedGuilds
 * @returns {string | null}
 */
function pickActiveInstanceUrl(mergedGuilds) {
  if (!Array.isArray(mergedGuilds)) return null;
  for (const guild of mergedGuilds) {
    if (guild && typeof guild.instanceUrl === 'string' && guild.instanceUrl.length > 0) {
      return guild.instanceUrl;
    }
  }
  return null;
}

/**
 * Compact fixed-height desktop window topbar (see `--desktop-topbar-h`,
 * currently 32px).
 *
 * Composition (post-login):
 *   - macOS  : [drag-safe area + traffic lights] [omnibar centered] [telemetry]
 *   - Win32  : [telemetry]                       [omnibar centered] [drag + overlay safe]
 *
 * Pre-login the omnibar and telemetry are hidden: the underlying command
 * palette and instance ping endpoint are not meaningfully available yet,
 * so showing them would amount to dead chrome.
 *
 * Skipped entirely on Linux because the native window frame already
 * supplies drag affordance — drawing a second titlebar would create
 * double-chrome.
 *
 * `WebkitAppRegion: 'drag'` is applied inline on the root so the entire
 * background is a window-drag handle. Every interactive child uses
 * `WebkitAppRegion: 'no-drag'` inline so the contract travels with the
 * component itself, not just CSS.
 */
export function DesktopTopBar() {
  const api = readDesktopApi();
  const { bootState } = useBootController();
  const { mergedGuilds } = useInstanceContext();

  if (!api) return null;
  if (api.platform === 'linux') return null;

  const isAuthenticated = AUTHENTICATED_BOOT_STATES.has(bootState);
  const safeAreaVars = computeSafeAreaVars(api.platform);
  const isMac = api.platform === 'darwin';
  const instanceUrl = isAuthenticated ? pickActiveInstanceUrl(mergedGuilds) : null;

  // Match the bar's bg to whatever surface it borders so the topbar
  // fuses with the screen instead of reading as a separate stripe:
  //   - Authenticated shell: bordered by the rail + channel sidebar →
  //     `var(--desktop-chrome-bg)`, which resolves to the solid sidebar
  //     tint in the browser and to a translucent mix on Electron
  //     builds that enable native window material.
  //   - Auth screens (login / link-device / pin-unlock / pin-setup):
  //     bordered by the auth wrapper's `bg-background` → `var(--background)`.
  // Driven through a CSS custom property so the value tracks the active
  // theme tokens automatically.
  const topbarBgVar = isAuthenticated
    ? 'var(--desktop-chrome-bg)'
    : 'var(--background)';

  return (
    <header
      className="hush-desktop-topbar"
      data-platform={api.platform}
      data-bg-mode={isAuthenticated ? 'sidebar' : 'background'}
      role="banner"
      style={{
        WebkitAppRegion: 'drag',
        '--desktop-topbar-bg': topbarBgVar,
        ...safeAreaVars,
      }}
    >
      <div className="hush-desktop-topbar__cluster hush-desktop-topbar__cluster--left">
        {/* macOS keeps the left column empty so the traffic lights have a
            full drag-safe gutter. Windows/Linux place telemetry here so it
            sits opposite the OS-drawn controls. */}
        {!isMac && isAuthenticated && (
          <DesktopTelemetry instanceUrl={instanceUrl} />
        )}
      </div>

      <div className="hush-desktop-topbar__cluster hush-desktop-topbar__cluster--center">
        {isAuthenticated && <DesktopOmnibar platform={api.platform} />}
      </div>

      <div className="hush-desktop-topbar__cluster hush-desktop-topbar__cluster--right">
        {isMac && isAuthenticated && (
          <DesktopTelemetry instanceUrl={instanceUrl} />
        )}
      </div>
    </header>
  );
}
