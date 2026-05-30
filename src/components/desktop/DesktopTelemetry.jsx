import { LockIcon, WifiIcon, WifiOffIcon } from 'lucide-react';
import { useInstancePing } from './useInstancePing.js';
import { formatPingLabel, PING_STATUS } from './pingStatus.js';
import { StaleServerIndicator } from './StaleServerIndicator.jsx';

/**
 * Maps a ping bucket to the existing semantic colour tokens so the badge
 * inherits the theme palette and stays consistent across light/dark.
 */
const PING_COLOR_VAR = Object.freeze({
  [PING_STATUS.LOW]: 'var(--success, oklch(0.7 0.18 150))',
  [PING_STATUS.MID]: 'oklch(0.78 0.16 60)',
  [PING_STATUS.HIGH]: 'oklch(0.7 0.18 30)',
  [PING_STATUS.DOWN]: 'var(--destructive)',
  [PING_STATUS.UNKNOWN]: 'var(--muted-foreground)',
});

/**
 * Compact telemetry cluster: E2EE state plus a live ping readout against
 * the active instance.
 *
 * Truth sources only:
 *   - The E2EE indicator reflects a fixed property of Hush: every
 *     real connection is E2EE, so it stays static. No telemetry is
 *     fabricated to imply per-message verification.
 *   - The ping number is measured against `${instanceUrl}/api/health` by
 *     `useInstancePing`. When no instance is active the readout shows
 *     `-- ms` instead of guessing a value.
 *
 * @param {{ instanceUrl: string | null | undefined }} props
 */
export function DesktopTelemetry({ instanceUrl }) {
  const { ms, status } = useInstancePing(instanceUrl ?? null);
  const label = formatPingLabel(ms, status);
  const color = PING_COLOR_VAR[status];
  const isOffline = status === PING_STATUS.DOWN || status === PING_STATUS.UNKNOWN;
  const WifiGlyph = isOffline ? WifiOffIcon : WifiIcon;

  return (
    <div className="hush-desktop-telemetry" data-ping-status={status}>
      <span
        className="hush-desktop-telemetry__pill"
        title="End-to-end encrypted"
        aria-label="End-to-end encrypted"
      >
        <LockIcon className="hush-desktop-telemetry__glyph" aria-hidden />
        <span>E2EE</span>
      </span>
      <span
        className="hush-desktop-telemetry__pill"
        title={
          instanceUrl
            ? `Round-trip to ${instanceUrl}`
            : 'No active instance'
        }
        aria-label={`Network latency ${label}`}
        style={{ color }}
      >
        <WifiGlyph className="hush-desktop-telemetry__glyph" aria-hidden />
        <span className="hush-desktop-telemetry__ping">{label}</span>
      </span>
      <StaleServerIndicator />
    </div>
  );
}
