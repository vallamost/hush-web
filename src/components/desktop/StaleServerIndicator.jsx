import { AlertTriangleIcon } from 'lucide-react';

import { useStaleServerDesktop } from '@/hooks/useStaleServerDesktop';
import { reopenStaleServerDesktop } from '@/lib/staleServerDesktopStore';

/**
 * Persistent stale-server warning triangle, shown in the desktop telemetry
 * cluster (beside E2EE / latency) once the user dismisses the dialog. Clicking
 * re-opens the notice. Renders nothing until the dialog has been collapsed, so
 * it never duplicates the dialog. `no-drag` so the click is not swallowed by
 * the titlebar drag region.
 */
export function StaleServerIndicator() {
  const { detail, collapsed } = useStaleServerDesktop();
  if (!detail || !collapsed) return null;

  return (
    <button
      type="button"
      className="hush-desktop-stale-indicator"
      onClick={reopenStaleServerDesktop}
      aria-label="Outdated server warning"
      title="This instance runs an outdated server. Click to read the warning."
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <AlertTriangleIcon className="hush-desktop-stale-indicator__icon" aria-hidden />
    </button>
  );
}

export default StaleServerIndicator;
