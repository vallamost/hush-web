import * as React from "react"

import { BugReportDialog } from "@/components/bug-report-dialog"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { useAuth } from "@/contexts/AuthContext"
import type { BugReportLifecycleState } from "@/lib/bugReport"

function deriveLifecycleStateFromAuth(auth: unknown): BugReportLifecycleState {
  if (!auth || typeof auth !== "object") return "unknown"

  const record = auth as { vaultState?: unknown; token?: unknown }
  const vaultState =
    typeof record.vaultState === "string" ? record.vaultState : null

  if (vaultState === "unlocked") return "authorized"
  if (vaultState === "locked") return "locked"
  if (vaultState === "none") return "anonymous"
  return "unknown"
}

export function HelpPanel() {
  const auth = useAuth()
  const lifecycleState = deriveLifecycleStateFromAuth(auth)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Help</h2>
        <p className="text-sm text-muted-foreground">
          Report a problem or request a change. Reports are anonymous.
        </p>
      </div>

      <Separator />

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Feedback
        </h3>
        <div className="rounded-lg border bg-card p-4">
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>Report a bug</FieldTitle>
                <FieldDescription>
                  Send an anonymous report with safe metadata. The dialog
                  shows exactly what will be submitted before you confirm.
                </FieldDescription>
              </FieldContent>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(true)}
              >
                Open report
              </Button>
            </Field>
          </FieldGroup>
        </div>
      </section>

      <BugReportDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        lifecycleState={lifecycleState}
        appSurface="settings.help"
      />
    </div>
  )
}
