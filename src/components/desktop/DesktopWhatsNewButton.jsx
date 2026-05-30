import { SparklesIcon } from 'lucide-react';

import { OPEN_WHATS_NEW_EVENT } from '@/lib/changeAnnouncements';

function dispatchOpenWhatsNew() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_WHATS_NEW_EVENT));
}

/**
 * Persistent "What's new" affordance in the desktop topbar, sat beside the
 * omnibar. Clicking re-opens the latest release note even after the user
 * dismissed it (handled by the app shell via OPEN_WHATS_NEW_EVENT).
 *
 * `no-drag` so the click is not swallowed by the titlebar drag region.
 */
export function DesktopWhatsNewButton() {
  return (
    <button
      type="button"
      className="hush-desktop-whatsnew"
      onClick={dispatchOpenWhatsNew}
      aria-label="What's new"
      title="What's new"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <SparklesIcon className="hush-desktop-whatsnew__icon" aria-hidden />
    </button>
  );
}
