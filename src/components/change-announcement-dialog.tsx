/**
 * Small "What's new" dialog rendered after selected updates.
 *
 * Owned by `AuthenticatedApp` and gated by `useChangeAnnouncement`, so
 * this component never decides whether to show itself, it only renders
 * the entry it is given and signals dismissal back upstream. Keeping
 * the decision logic out of the view layer is what lets the engine be
 * unit-tested without DOM.
 *
 * Visual contract:
 *   - Small dialog (max-w-sm), not full-screen.
 *   - Title `What's new`, subdued version label below.
 *   - Concise bullets, bounded scroll if content grows.
 *   - Primary action `Got it`. Optional secondary quiet link.
 *   - Reduced-motion friendly: relies on the shared dialog primitive
 *     which respects `prefers-reduced-motion`.
 */

import * as React from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { ChangeAnnouncementEntry } from "@/lib/changeAnnouncements"
import { CLIENT_VERSION } from "@/lib/clientVersion"
import { getDesktopBridge } from "@/lib/desktopBridge"

/**
 * Version label shown in the dialog: the actual running build, not the
 * entry's target version. On desktop the version comes from the async
 * `getAppVersion()` bridge IPC (the preload does not expose a sync field);
 * web (and desktop before the IPC resolves) uses the bundled client version.
 */
function useRunningClientVersion(): string {
  const [version, setVersion] = React.useState<string>(CLIENT_VERSION)

  React.useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge || typeof bridge.getAppVersion !== "function") return
    let cancelled = false
    bridge
      .getAppVersion()
      .then((v) => {
        if (!cancelled && typeof v === "string" && v.length > 0) setVersion(v)
      })
      .catch(() => {
        /* keep the client-version fallback */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return version
}

interface ChangeAnnouncementDialogProps {
  readonly entry: ChangeAnnouncementEntry | null
  readonly onDismiss: () => void
}

export function ChangeAnnouncementDialog({
  entry,
  onDismiss,
}: ChangeAnnouncementDialogProps) {
  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) onDismiss()
    },
    [onDismiss]
  )
  const runningVersion = useRunningClientVersion()

  if (!entry) return null

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        aria-labelledby="change-announcement-title"
      >
        <DialogHeader>
          <DialogTitle id="change-announcement-title">What's new</DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs">
            {runningVersion}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto pr-1">
          <p className="text-foreground text-sm font-medium">{entry.title}</p>
          {entry.body ? (
            <p className="text-muted-foreground text-sm">{entry.body}</p>
          ) : null}
          {entry.bullets.length > 0 ? (
            <ul className="text-foreground/90 list-disc space-y-1.5 pl-5 text-sm">
              {entry.bullets.map((bullet, index) => (
                <li key={`${entry.id}-${index}`}>{bullet}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {entry.link ? (
            <Button
              variant="ghost"
              asChild
              className="sm:mr-auto"
            >
              <a
                href={entry.link.href}
                target="_blank"
                rel="noreferrer noopener"
              >
                {entry.link.label}
              </a>
            </Button>
          ) : null}
          <Button onClick={onDismiss} autoFocus>
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
