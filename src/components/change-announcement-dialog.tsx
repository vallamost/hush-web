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
import { AlertTriangle, ArrowUpRight } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { ChangeAnnouncementEntry } from "@/lib/changeAnnouncements"
import { detectSurface } from "@/lib/changeAnnouncements"
import { CLIENT_VERSION } from "@/lib/clientVersion"
import { getDesktopBridge } from "@/lib/desktopBridge"

/**
 * Quiet external-link action. The trailing up-right arrow signals that the
 * link opens an external page (changelog, download site) in a new tab,
 * distinguishing it from the in-dialog "Got it" dismiss action.
 */
function ExternalLinkButton({
  href,
  label,
}: {
  readonly href: string
  readonly label: string
}) {
  return (
    <Button variant="ghost" size="sm" asChild>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1"
      >
        {label}
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
      </a>
    </Button>
  )
}

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
  const changelogHref = entry?.changelog?.[detectSurface()] ?? null

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
          {entry.title ? (
            <p className="text-foreground text-sm font-medium">{entry.title}</p>
          ) : null}
          {entry.body ? (
            <p className="text-muted-foreground text-sm">{entry.body}</p>
          ) : null}
          {entry.warning ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p className="text-xs leading-snug">{entry.warning}</p>
            </div>
          ) : null}
          {entry.bullets.length > 0 ? (
            <ul className="text-foreground/90 list-disc space-y-1.5 pl-5 text-sm">
              {entry.bullets.map((bullet, index) => (
                <li key={`${entry.id}-${index}`}>{bullet}</li>
              ))}
            </ul>
          ) : null}
        </div>

        {/*
          Footer hierarchy: "Got it" is the only real action (dismiss), so it is
          the primary button. The changelog and download are external links
          (new tab, signalled by the up-right arrow), grouped as quiet secondary
          actions to the left.
        */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          {changelogHref || entry.download ? (
            <div className="flex flex-col gap-1 sm:mr-auto sm:flex-row sm:items-center sm:gap-1">
              {changelogHref ? (
                <ExternalLinkButton href={changelogHref} label="Changelog" />
              ) : null}
              {entry.download ? (
                <ExternalLinkButton
                  href={entry.download.href}
                  label={entry.download.label}
                />
              ) : null}
            </div>
          ) : null}
          <Button onClick={onDismiss} autoFocus>
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
