import * as React from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useDesktopUpdateState } from "@/hooks/useDesktopUpdateState"

/** Where users download a build that the app cannot self-apply. */
const RELEASES_URL = "https://github.com/hushhq/hush-desktop/releases/latest"

interface UpdateStateLike {
  readonly phase?: string | null
  readonly targetVersion?: string | null
}

/**
 * Non-blocking prompt shown when the desktop updater reports `manual-required`
 * (today: Windows, whose unsigned builds cannot self-apply an update). The
 * main process never downloads or restarts in this case, so the only honest
 * action is to tell the user to download the new version manually.
 *
 * Self-gating: `useDesktopUpdateState` returns null off-desktop, and the
 * prompt only renders for the `manual-required` phase, so this is inert
 * everywhere else. It never blocks the app shell (unlike the update gate).
 */
export function DesktopManualUpdatePrompt() {
  const state = useDesktopUpdateState() as UpdateStateLike | null
  const [dismissed, setDismissed] = React.useState(false)

  const isManualRequired = state?.phase === "manual-required"

  // Re-arm the prompt if a newer manual-required target appears later.
  const targetVersion = state?.targetVersion ?? null
  React.useEffect(() => {
    if (isManualRequired) setDismissed(false)
  }, [targetVersion, isManualRequired])

  if (!isManualRequired || dismissed) return null

  const version = targetVersion ? ` (version ${targetVersion})` : ""

  return (
    <Dialog open onOpenChange={(next) => { if (!next) setDismissed(true) }}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="manual-update-prompt"
      >
        <DialogHeader>
          <DialogTitle>Update available</DialogTitle>
          <DialogDescription>
            A new version of Hush{version} is available. This Windows build
            cannot update itself yet, so the app will not restart into the new
            version automatically. Download the latest installer manually to
            update.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setDismissed(true)}
            data-testid="manual-update-later"
          >
            Later
          </Button>
          <Button asChild data-testid="manual-update-download">
            <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
              Download update
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default DesktopManualUpdatePrompt
