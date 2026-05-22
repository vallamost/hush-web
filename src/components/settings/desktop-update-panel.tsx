import * as React from "react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { useDesktopUpdateState } from "@/hooks/useDesktopUpdateState"
import {
  getDesktopBridge,
  type DesktopBridge,
  type DesktopRuntimeInfo,
  type DesktopUpdateState,
} from "@/lib/desktopBridge"

const CHECKING_PHASES = new Set(["checking", "downloading", "preparing"])

export function DesktopUpdatePanel() {
  const desktopBridge = React.useMemo(() => getDesktopBridge(), [])
  const liveState = useDesktopUpdateState() as DesktopUpdateState | null
  const [runtimeInfo, setRuntimeInfo] =
    React.useState<DesktopRuntimeInfo | null>(null)
  const [localState, setLocalState] = React.useState<DesktopUpdateState | null>(
    null
  )
  const [feedback, setFeedback] = React.useState<string | null>(null)
  const [isChecking, setIsChecking] = React.useState(false)
  const [isInstalling, setIsInstalling] = React.useState(false)

  React.useEffect(() => {
    if (!desktopBridge || typeof desktopBridge.getRuntimeInfo !== "function") {
      return
    }
    let cancelled = false
    void desktopBridge
      .getRuntimeInfo()
      .then((info) => {
        if (!cancelled) setRuntimeInfo(info)
      })
      .catch(() => {
        if (!cancelled) setRuntimeInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [desktopBridge])

  const state = liveState ?? localState
  const canCheck =
    desktopBridge !== null &&
    typeof desktopBridge.checkForDesktopUpdates === "function"
  const canInstall =
    desktopBridge !== null &&
    typeof desktopBridge.installDesktopUpdate === "function"
  const isReady = state?.phase === "ready"
  const isBusy =
    isChecking ||
    isInstalling ||
    (state?.phase !== undefined && CHECKING_PHASES.has(state.phase))

  const handleCheck = React.useCallback(async () => {
    if (!canCheck) return
    setIsChecking(true)
    setFeedback(null)
    try {
      const next = await desktopBridge.checkForDesktopUpdates!()
      setLocalState(next)
      setFeedback(buildCheckFeedback(next))
    } catch {
      setFeedback("Could not check for updates. Check your connection and try again.")
    } finally {
      setIsChecking(false)
    }
  }, [canCheck, desktopBridge])

  const handleInstall = React.useCallback(async () => {
    if (!canInstall) return
    setIsInstalling(true)
    setFeedback(null)
    try {
      const next = await desktopBridge.installDesktopUpdate!()
      setLocalState(next)
    } catch {
      setFeedback("Could not restart to install the update.")
      setIsInstalling(false)
    }
  }, [canInstall, desktopBridge])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">General</h2>
        <p className="text-sm text-muted-foreground">
          Inspect the running client and control desktop updates.
        </p>
      </div>

      <Separator />

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          App version
        </h3>
        <div className="rounded-lg border bg-card p-4">
          <FieldGroup>
            <RuntimeFieldGroup
              desktopBridge={desktopBridge}
              runtimeInfo={runtimeInfo}
              updateState={state}
            />

            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>Updates</FieldTitle>
                <FieldDescription>
                  Hush checks for desktop updates at startup and every 12 hours.
                  You can also check manually here.
                </FieldDescription>
                {feedback ? (
                  <span className="text-xs text-muted-foreground">{feedback}</span>
                ) : null}
              </FieldContent>
              <UpdateAction
                canCheck={canCheck}
                canInstall={canInstall}
                isBusy={isBusy}
                isReady={isReady}
                onCheck={handleCheck}
                onInstall={handleInstall}
              />
            </Field>
          </FieldGroup>
        </div>
      </section>
    </div>
  )
}

function RuntimeFieldGroup({
  desktopBridge,
  runtimeInfo,
  updateState,
}: {
  desktopBridge: DesktopBridge | null
  runtimeInfo: DesktopRuntimeInfo | null
  updateState: DesktopUpdateState | null
}) {
  const version = runtimeInfo?.appVersion ?? updateState?.currentVersion ?? "Unknown"
  const platform = runtimeInfo
    ? formatPlatform(runtimeInfo.platform)
    : desktopBridge
      ? formatPlatform(desktopBridge.platform)
      : "Browser"
  const arch = runtimeInfo?.arch ?? desktopBridge?.arch ?? "Unknown"
  const electronVersion = runtimeInfo?.electronVersion ?? null

  return (
    <Field>
      <FieldContent>
        <FieldTitle>Runtime</FieldTitle>
        <FieldDescription>
          {desktopBridge
            ? "Desktop client runtime metadata."
            : "Browser runtime. Desktop updates are managed by the installed app."}
        </FieldDescription>
      </FieldContent>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <RuntimeFact label="Version" value={version} />
        <RuntimeFact label="Platform" value={platform} />
        <RuntimeFact label="Architecture" value={arch} />
        <RuntimeFact label="Electron" value={electronVersion ?? "Not available"} />
        <RuntimeFact
          label="Update state"
          value={<UpdateStateBadge state={updateState} />}
        />
      </dl>
    </Field>
  )
}

function RuntimeFact({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate font-mono text-xs text-foreground">{value}</dd>
    </div>
  )
}

function UpdateStateBadge({ state }: { state: DesktopUpdateState | null }) {
  const label = formatUpdateState(state)
  const variant = state?.phase === "ready" ? "default" : "secondary"
  return <Badge variant={variant}>{label}</Badge>
}

function UpdateAction({
  canCheck,
  canInstall,
  isBusy,
  isReady,
  onCheck,
  onInstall,
}: {
  canCheck: boolean
  canInstall: boolean
  isBusy: boolean
  isReady: boolean
  onCheck: () => void
  onInstall: () => void
}) {
  if (isReady) {
    return (
      <Button
        type="button"
        onClick={onInstall}
        disabled={!canInstall || isBusy}
        className="shrink-0"
      >
        Restart to update
      </Button>
    )
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={onCheck}
      disabled={!canCheck || isBusy}
      className="shrink-0"
    >
      {isBusy ? "Checking..." : "Check for updates"}
    </Button>
  )
}

function buildCheckFeedback(state: DesktopUpdateState): string {
  if (state.phase === "skipped" && state.error === "no-update") {
    return "Hush is up to date."
  }
  if (state.phase === "ready") {
    return "Update ready. Restart Hush to install it."
  }
  if (
    state.phase === "checking" ||
    state.phase === "downloading" ||
    state.phase === "preparing"
  ) {
    return "Update found. Downloading in the background."
  }
  if (state.phase === "skipped" || state.phase === "error") {
    return "Could not check for updates. Check your connection and try again."
  }
  return "Update check started."
}

function formatUpdateState(state: DesktopUpdateState | null): string {
  switch (state?.phase) {
    case "checking":
      return "Checking"
    case "downloading":
    case "preparing":
      return "Downloading"
    case "downloaded":
      return "Restarting"
    case "ready":
      return "Ready"
    case "skipped":
      return state.error === "no-update" ? "Up to date" : "Skipped"
    case "error":
      return "Error"
    case "idle":
    default:
      return "Idle"
  }
}

function formatPlatform(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macOS"
    case "win32":
      return "Windows"
    case "linux":
      return "Linux"
    default:
      return platform
  }
}
