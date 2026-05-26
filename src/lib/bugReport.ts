import { CLIENT_VERSION } from "./clientVersion"
import { sanitizeDiagnosticDetails } from "./clientDiagnostics"
import {
  BUG_REPORT_ARCH_SET,
  BUG_REPORT_CLIENT_KIND_SET,
  BUG_REPORT_DESCRIPTION_MAX_LEN,
  BUG_REPORT_LIFECYCLE_SET,
  BUG_REPORT_PLATFORM_SET,
  BUG_REPORT_STEPS_MAX_LEN,
  BUG_REPORT_TITLE_MAX_LEN,
  BUG_REPORT_TYPE_SET,
  DEFAULT_BUG_REPORT_APP_SURFACE,
  type BugReportArch,
  type BugReportClientKind,
  type BugReportDiagnosticEntry,
  type BugReportInput,
  type BugReportLifecycleState,
  type BugReportPlatform,
  type BugReportTelemetry,
  type BugReportValidationError,
} from "./bugReportContract"

export {
  BUG_REPORT_ARCHES,
  BUG_REPORT_CLIENT_KINDS,
  BUG_REPORT_LIFECYCLE_STATES,
  BUG_REPORT_PLATFORMS,
  BUG_REPORT_TYPES,
  DEFAULT_BUG_REPORT_APP_SURFACE,
  type BugReportArch,
  type BugReportClientKind,
  type BugReportDiagnosticEntry,
  type BugReportInput,
  type BugReportLifecycleState,
  type BugReportPlatform,
  type BugReportTelemetry,
  type BugReportType,
  type BugReportValidationError,
} from "./bugReportContract"

/**
 * Upper bound on attached diagnostic events. Keeps the payload small
 * even if a future caller forgets to cap the ring buffer.
 */
export const BUG_REPORT_DIAGNOSTIC_MAX_ENTRIES = 200

/**
 * Identifier-like keys that must never leave the device through a bug
 * report. The existing payload contract test enforces this on the
 * top-level payload; we apply the same rule to diagnostic entries so
 * the diagnostic stream cannot reintroduce an identifier leak.
 */
const FORBIDDEN_DIAGNOSTIC_KEY_FRAGMENTS = [
  "userid",
  "username",
  "deviceid",
  "channelid",
  "serverid",
  "messageid",
  "ipaddress",
  "publickey",
  "token",
  "logs",
]

function isIdentifierLikeKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return FORBIDDEN_DIAGNOSTIC_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment)
  )
}

function stripIdentifierLikeKeys(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripIdentifierLikeKeys(entry, seen))
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]"
    seen.add(value)
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (isIdentifierLikeKey(key)) continue
      result[key] = stripIdentifierLikeKeys(entry, seen)
    }
    return result
  }
  return value
}

/**
 * Re-runs every diagnostic entry through the renderer redactor so the
 * payload never escapes with a missed token, mnemonic, signed URL, or
 * local path — even if the original emitter forgot to sanitize. Also
 * strips identifier-like keys (channelId, userId, etc.) at the payload
 * boundary so the diagnostic stream cannot quietly reintroduce them.
 */
export function redactDiagnosticEntriesForUpload(
  entries: readonly BugReportDiagnosticEntry[]
): BugReportDiagnosticEntry[] {
  const limited = entries.slice(-BUG_REPORT_DIAGNOSTIC_MAX_ENTRIES)
  return limited.map((entry) => {
    const sanitized =
      entry.details && typeof entry.details === "object"
        ? (sanitizeDiagnosticDetails(entry.details) as Record<string, unknown>)
        : {}
    return {
      ts: entry.ts,
      category: entry.category,
      event: entry.event,
      severity: entry.severity,
      details: stripIdentifierLikeKeys(sanitized) as Record<string, unknown>,
    }
  })
}

export const BUG_REPORT_ENDPOINT = (() => {
  // Vite injects `import.meta.env.VITE_*` at build time. Typed loosely
  // so the file compiles in repos that have not extended ImportMeta.
  const meta = import.meta as unknown as {
    env?: Record<string, string | undefined>
  }
  const fromEnv = meta?.env?.VITE_BUG_REPORT_ENDPOINT
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv
  return "https://gethush.live/api/bug-reports"
})()

export interface BugReportDesktopBridge {
  readonly isDesktop?: boolean
  readonly platform?: string
  readonly arch?: string
  readonly osRelease?: string
}

export interface BugReportTelemetryContext {
  appVersion?: string | null
  lifecycleState?: BugReportLifecycleState | null
  appSurface?: string | null
  desktopBridge?: BugReportDesktopBridge | null
}

function normalizePlatform(value: unknown): BugReportPlatform {
  if (typeof value !== "string") return "unknown"
  if (BUG_REPORT_PLATFORM_SET.has(value as BugReportPlatform)) {
    return value as BugReportPlatform
  }
  return "unknown"
}

function normalizeArch(value: unknown): BugReportArch {
  if (typeof value !== "string") return "unknown"
  if (BUG_REPORT_ARCH_SET.has(value as BugReportArch)) {
    return value as BugReportArch
  }
  return "unknown"
}

function detectBrowserPlatform(): BugReportPlatform {
  if (typeof navigator === "undefined") return "unknown"
  const ua = navigator.userAgent ?? ""
  if (/Mac/i.test(ua)) return "darwin"
  if (/Win/i.test(ua)) return "win32"
  if (/Android/i.test(ua)) return "android"
  if (/(iPhone|iPad|iPod)/i.test(ua)) return "ios"
  if (/Linux/i.test(ua)) return "linux"
  return "web"
}

function detectBrowserArch(): BugReportArch {
  if (typeof navigator === "undefined") return "unknown"
  const ua = navigator.userAgent ?? ""
  if (/arm64|aarch64/i.test(ua)) return "arm64"
  if (/x86_64|Win64|x64/i.test(ua)) return "x64"
  return "unknown"
}

export function buildBugReportTelemetry(
  context: BugReportTelemetryContext = {}
): BugReportTelemetry {
  const bridge = context.desktopBridge ?? null
  const isDesktop = Boolean(bridge?.isDesktop)
  const clientKind: BugReportClientKind = isDesktop ? "desktop" : "web"

  const platform: BugReportPlatform = isDesktop
    ? normalizePlatform(bridge?.platform)
    : detectBrowserPlatform()

  const arch: BugReportArch = isDesktop
    ? normalizeArch(bridge?.arch)
    : detectBrowserArch()

  const osRelease =
    typeof bridge?.osRelease === "string" && bridge.osRelease.length > 0
      ? bridge.osRelease
    : "unknown"

  const lifecycleState: BugReportLifecycleState =
    context.lifecycleState && BUG_REPORT_LIFECYCLE_SET.has(context.lifecycleState)
      ? context.lifecycleState
      : "unknown"

  const appVersion =
    typeof context.appVersion === "string" && context.appVersion.length > 0
      ? context.appVersion
      : CLIENT_VERSION || "unknown"

  const appSurface =
    typeof context.appSurface === "string" && context.appSurface.length > 0
      ? context.appSurface
      : DEFAULT_BUG_REPORT_APP_SURFACE

  return {
    appVersion,
    clientKind,
    platform,
    arch,
    lifecycleState,
    osRelease,
    appSurface,
  }
}

export function validateBugReportInput(
  input: BugReportInput
): BugReportValidationError | null {
  if (!BUG_REPORT_TYPE_SET.has(input.type)) {
    return { field: "type", message: "Pick a report type." }
  }
  if (
    typeof input.description !== "string" ||
    input.description.trim().length === 0
  ) {
    return {
      field: "description",
      message: "Describe what happened before sending.",
    }
  }
  if (input.description.length > BUG_REPORT_DESCRIPTION_MAX_LEN) {
    return {
      field: "description",
      message: `Description must be ${BUG_REPORT_DESCRIPTION_MAX_LEN} characters or less.`,
    }
  }
  if (typeof input.title === "string" && input.title.length > BUG_REPORT_TITLE_MAX_LEN) {
    return {
      field: "title",
      message: `Title must be ${BUG_REPORT_TITLE_MAX_LEN} characters or less.`,
    }
  }
  if (typeof input.steps === "string" && input.steps.length > BUG_REPORT_STEPS_MAX_LEN) {
    return {
      field: "steps",
      message: `Steps must be ${BUG_REPORT_STEPS_MAX_LEN} characters or less.`,
    }
  }
  const t = input.telemetry
  if (typeof t?.appVersion !== "string" || t.appVersion.length === 0) {
    return { field: "telemetry.appVersion", message: "Missing app version." }
  }
  if (!BUG_REPORT_CLIENT_KIND_SET.has(t.clientKind)) {
    return { field: "telemetry.clientKind", message: "Invalid client kind." }
  }
  if (!BUG_REPORT_PLATFORM_SET.has(t.platform)) {
    return { field: "telemetry.platform", message: "Invalid platform." }
  }
  if (!BUG_REPORT_ARCH_SET.has(t.arch)) {
    return { field: "telemetry.arch", message: "Invalid architecture." }
  }
  if (!BUG_REPORT_LIFECYCLE_SET.has(t.lifecycleState)) {
    return {
      field: "telemetry.lifecycleState",
      message: "Invalid lifecycle state.",
    }
  }
  if (typeof t.osRelease !== "string" || t.osRelease.length === 0) {
    return { field: "telemetry.osRelease", message: "Missing OS release." }
  }
  if (typeof t.appSurface !== "string" || t.appSurface.length === 0) {
    return { field: "telemetry.appSurface", message: "Missing app surface." }
  }
  return null
}

export function buildBugReportPayload(input: BugReportInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: input.type,
    description: input.description.trim(),
    telemetry: input.telemetry,
  }
  if (typeof input.title === "string" && input.title.trim().length > 0) {
    payload.title = input.title.trim()
  }
  if (typeof input.steps === "string" && input.steps.trim().length > 0) {
    payload.steps = input.steps.trim()
  }
  if (Array.isArray(input.diagnosticLog) && input.diagnosticLog.length > 0) {
    payload.diagnosticLog = redactDiagnosticEntriesForUpload(input.diagnosticLog)
  }
  return payload
}

export type BugReportSubmitOutcome =
  | { status: "ok" }
  | { status: "validation_error"; error: BugReportValidationError }
  | { status: "not_configured" }
  | { status: "rejected"; httpStatus: number; body: string }
  | { status: "network_error"; message: string }

interface SubmitDeps {
  fetcher?: typeof fetch
  endpoint?: string
}

export async function submitBugReport(
  input: BugReportInput,
  deps: SubmitDeps = {}
): Promise<BugReportSubmitOutcome> {
  const validation = validateBugReportInput(input)
  if (validation) {
    return { status: "validation_error", error: validation }
  }
  const fetcher = deps.fetcher ?? fetch
  const endpoint = deps.endpoint ?? BUG_REPORT_ENDPOINT
  let response: Response
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBugReportPayload(input)),
    })
  } catch (err) {
    return {
      status: "network_error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
  if (response.ok) {
    return { status: "ok" }
  }
  if (response.status === 503) {
    return { status: "not_configured" }
  }
  let body = ""
  try {
    body = await response.text()
  } catch {
    // Some runtimes throw on text() after the request stream closes.
    // The status code alone is enough for the dialog copy.
  }
  return { status: "rejected", httpStatus: response.status, body }
}
