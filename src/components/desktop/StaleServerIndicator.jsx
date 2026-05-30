import { AlertTriangleIcon } from 'lucide-react';

import { useStaleServerDesktop } from '@/hooks/useStaleServerDesktop';
import { reopenStaleServerDesktop } from '@/lib/staleServerDesktopStore';

/**
 * Persistent stale-server warning triangle in the desktop telemetry cluster
 * (beside E2EE / latency). Stays visible the whole time the instance is stale,
 * including while the dialog is open, so the warning never disappears under
 * the user. Clicking re-opens the notice. `no-drag` so the click is not
 * swallowed by the titlebar drag region.
 */
export function StaleServerIndicator() {
  const { detail } = useStaleServerDesktop();
  if (!detail) return null;

  return (
    <button
      type="button"
      className="hush-desktop-stale-indicator"
      onClick={reopenStaleServerDesktop}
      aria-label="Outdated server warning"
      title="This instance runs an outdated server. Click to read the warning."
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <AlertTriangleIcon
        className="hush-desktop-stale-indicator__icon"
        fill="currentColor"
        aria-hidden
      />
    </button>
  );
}

export default StaleServerIndicator;
