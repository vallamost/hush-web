import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"

import {
  BUG_REPORT_TYPES,
  buildBugReportTelemetry,
  submitBugReport,
  type BugReportInput,
  type BugReportLifecycleState,
  type BugReportSubmitOutcome,
  type BugReportTelemetry,
  type BugReportType,
} from "@/lib/bugReport"
import { getDesktopBridge } from "@/lib/desktopBridge"

const TYPE_LABELS: Record<BugReportType, string> = {
  bug: "Bug",
  crash: "Crash",
  ui: "UI glitch",
  performance: "Performance",
  voice: "Voice / video",
  "device-linking": "Device linking",
  other: "Other",
}

const SUBMITTING_LABEL = "Sending..."
const SEND_LABEL = "Send report"
const SUCCESS_LABEL = "Sent"

export interface BugReportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  lifecycleState?: BugReportLifecycleState | null
  appSurface?: string
}

export function BugReportDialog({
  open,
  onOpenChange,
  lifecycleState,
  appSurface,
}: BugReportDialogProps) {
  const [type, setType] = React.useState<BugReportType>("bug")
  const [title, setTitle] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [steps, setSteps] = React.useState("")
  const [phase, setPhase] =
    React.useState<"idle" | "submitting" | "success" | "error">("idle")
  const [feedback, setFeedback] = React.useState<string | null>(null)
  const [fieldError, setFieldError] =
    React.useState<{ field: string; message: string } | null>(null)

  const telemetry: BugReportTelemetry = React.useMemo(
    () =>
      buildBugReportTelemetry({
        lifecycleState: lifecycleState ?? null,
        appSurface: appSurface ?? null,
        desktopBridge: getDesktopBridge(),
      }),
    [appSurface, lifecycleState]
  )

  const telemetryPreview = React.useMemo(
    () => JSON.stringify(telemetry, null, 2),
    [telemetry]
  )

  React.useEffect(() => {
    if (!open) return
    setType("bug")
    setTitle("")
    setDescription("")
    setSteps("")
    setPhase("idle")
    setFeedback(null)
    setFieldError(null)
  }, [open])

  const submitting = phase === "submitting"
  const succeeded = phase === "success"

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (submitting || succeeded) return
      setPhase("submitting")
      setFeedback(null)
      setFieldError(null)
      const input: BugReportInput = {
        type,
        title: title.trim() || undefined,
        description,
        steps: steps.trim() || undefined,
        telemetry,
      }
      const outcome: BugReportSubmitOutcome = await submitBugReport(input)
      if (outcome.status === "ok") {
        setPhase("success")
        setFeedback("Report sent. Thanks for the heads-up.")
        return
      }
      if (outcome.status === "validation_error") {
        setPhase("idle")
        setFieldError({
          field: outcome.error.field,
          message: outcome.error.message,
        })
        return
      }
      if (outcome.status === "not_configured") {
        setPhase("error")
        setFeedback(
          "The bug-report service is not configured yet. Try again later or open an issue on GitHub."
        )
        return
      }
      if (outcome.status === "network_error") {
        setPhase("error")
        setFeedback(
          "Could not reach the bug-report service. Check your connection and try again."
        )
        return
      }
      setPhase("error")
      setFeedback(
        `Could not submit the report (server returned ${outcome.httpStatus}).`
      )
    },
    [description, steps, submitting, succeeded, telemetry, title, type]
  )

  const dialogDescription = succeeded
    ? "Thanks for the report. You can close this dialog."
    : "Reports are anonymous. We never include account identifiers, message contents, or local file paths."

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Report a bug</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={handleSubmit}
        >
          <ScrollArea className="min-h-0 flex-1 px-6">
            <FieldGroup className="grid gap-4 pb-1 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="bug-report-type">Type</FieldLabel>
                <Select
                  value={type}
                  onValueChange={(value) => setType(value as BugReportType)}
                  disabled={submitting || succeeded}
                >
                  <SelectTrigger id="bug-report-type" aria-label="Report type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" sideOffset={4}>
                    <SelectGroup>
                      {BUG_REPORT_TYPES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {TYPE_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel
                  htmlFor="bug-report-title"
                  className="flex items-baseline justify-between gap-2"
                >
                  <span>Title</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    optional
                  </span>
                </FieldLabel>
                <Input
                  id="bug-report-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  disabled={submitting || succeeded}
                  maxLength={120}
                  placeholder="Short summary"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="bug-report-description">
                  Description
                </FieldLabel>
                <Textarea
                  id="bug-report-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  disabled={submitting || succeeded}
                  required
                  rows={4}
                  maxLength={4000}
                  aria-invalid={fieldError?.field === "description" || undefined}
                  placeholder="What happened? What did you expect to happen?"
                  className="h-28 resize-none overflow-auto [field-sizing:fixed]"
                />
                {fieldError?.field === "description" ? (
                  <FieldError>{fieldError.message}</FieldError>
                ) : null}
              </Field>

              <Field>
                <FieldLabel
                  htmlFor="bug-report-steps"
                  className="flex items-baseline justify-between gap-2"
                >
                  <span>Steps</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    optional
                  </span>
                </FieldLabel>
                <Textarea
                  id="bug-report-steps"
                  value={steps}
                  onChange={(event) => setSteps(event.target.value)}
                  disabled={submitting || succeeded}
                  rows={4}
                  maxLength={2000}
                  placeholder={"1. ...\n2. ...\n3. ..."}
                  className="h-28 resize-none overflow-auto [field-sizing:fixed]"
                />
              </Field>

              <Field className="md:col-span-2">
                <FieldLabel htmlFor="bug-report-telemetry">
                  Anonymous metadata
                </FieldLabel>
                <pre
                  id="bug-report-telemetry"
                  className="max-h-28 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-snug"
                >
                  {telemetryPreview}
                </pre>
              </Field>
            </FieldGroup>
          </ScrollArea>

          <div className="flex shrink-0 flex-col gap-3 border-t px-6 pt-4 pb-6">
            {feedback ? (
              <p
                role={phase === "error" ? "alert" : "status"}
                className={
                  phase === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {feedback}
              </p>
            ) : null}
            <DialogFooter className="p-0">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                {succeeded ? "Close" : "Cancel"}
              </Button>
              <Button type="submit" disabled={submitting || succeeded}>
                {submitting
                  ? SUBMITTING_LABEL
                  : succeeded
                    ? SUCCESS_LABEL
                    : SEND_LABEL}
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
