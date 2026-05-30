import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useStaleServerDesktop } from "@/hooks/useStaleServerDesktop"
import { collapseStaleServerDesktop } from "@/lib/staleServerDesktopStore"

/**
 * Desktop-only stale-server notice, shown as a dialog (never a titlebar
 * banner, which would mesh with the drag region). Dismissing collapses it to
 * a persistent warning triangle in the telemetry cluster
 * (StaleServerIndicator), so the warning stays re-readable without occupying
 * a fixed layout slot. Web keeps the inline banner (StaleServerBanner).
 *
 * Non-blocking: an old but compatible server still serves chat.
 */
export function StaleServerDesktopDialog() {
  const { detail, collapsed } = useStaleServerDesktop()
  const open = Boolean(detail) && !collapsed
  if (!detail) return null

  const instance = detail.instanceHost ? ` (${detail.instanceHost})` : ""
  const version = detail.serverVersion ? ` version ${detail.serverVersion}` : ""

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) collapseStaleServerDesktop()
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="stale-server-dialog">
        <DialogHeader>
          <DialogTitle>Outdated server</DialogTitle>
          <DialogDescription>
            This instance{instance} is running an outdated Hush server{version}.
            Some fixes and improvements are missing. Ask the instance admin to
            update the server. You can keep using it in the meantime.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            onClick={collapseStaleServerDesktop}
            data-testid="stale-server-dialog-dismiss"
          >
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default StaleServerDesktopDialog
