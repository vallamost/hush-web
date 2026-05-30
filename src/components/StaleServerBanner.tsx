import { Button } from "@/components/ui/button";
import { useStaleServer } from "@/hooks/useStaleServer";
import { getDesktopBridge } from "@/lib/desktopBridge";

/**
 * Global, dismissible banner shown when the connected instance runs a Hush
 * server older than this client recommends. Mounted once at the app shell
 * level (see src/App.jsx) and driven by the `hush:server-stale` event.
 *
 * Non-blocking by design: an old but compatible server still serves
 * end-to-end encrypted chat, so this never gates the session. It only advises
 * the user to ask their instance admin to update. Contrast with the blocking
 * UpdateRequiredDialog, which handles incompatible clients.
 */
export function StaleServerBanner() {
  const { detail, dismiss } = useStaleServer();
  // Desktop uses a dialog + persistent titlebar triangle instead, so the
  // notice never meshes with the custom titlebar drag region. See
  // StaleServerDesktopDialog / StaleServerIndicator.
  if (getDesktopBridge()) return null;
  if (!detail) return null;

  const instance = detail.instanceHost ? ` (${detail.instanceHost})` : "";
  const version = detail.serverVersion ? ` version ${detail.serverVersion}` : "";

  return (
    <div
      role="status"
      data-testid="stale-server-banner"
      className="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
      <p className="leading-snug">
        This instance{instance} is running an outdated Hush server{version}.
        Some fixes and improvements are missing. Ask the instance admin to
        update the server.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={dismiss}
        data-testid="stale-server-dismiss"
      >
        Dismiss
      </Button>
    </div>
  );
}

export default StaleServerBanner;
