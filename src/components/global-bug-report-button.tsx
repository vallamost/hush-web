import * as React from "react"
import { BugIcon } from "lucide-react"

import { BugReportDialog } from "@/components/bug-report-dialog"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useOptionalAuth } from "@/contexts/AuthContext"
import { deriveLifecycleStateFromAuth } from "@/lib/bugReportLifecycle"

export interface GlobalBugReportButtonProps {
  appSurface?: string
  className?: string
}

export function GlobalBugReportButton({
  appSurface = "chrome.bottom-dock",
  className,
}: GlobalBugReportButtonProps) {
  const auth = useOptionalAuth()
  const lifecycleState = React.useMemo(
    () => deriveLifecycleStateFromAuth(auth),
    [auth]
  )
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Report a bug"
            data-slot="bottom-dock-bug-report"
            onClick={() => setOpen(true)}
            className={className}
          >
            <BugIcon className="size-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Report a bug</TooltipContent>
      </Tooltip>
      <BugReportDialog
        open={open}
        onOpenChange={setOpen}
        lifecycleState={lifecycleState}
        appSurface={appSurface}
      />
    </>
  )
}
