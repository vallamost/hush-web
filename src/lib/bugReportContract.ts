export const BUG_REPORT_TYPES = [
  "bug",
  "crash",
  "ui",
  "performance",
  "voice",
  "device-linking",
  "other",
] as const

export const BUG_REPORT_CLIENT_KINDS = [
  "desktop",
  "web",
  "mobile",
  "unknown",
] as const

export const BUG_REPORT_PLATFORMS = [
  "darwin",
  "win32",
  "linux",
  "ios",
  "android",
  "web",
  "unknown",
] as const

export const BUG_REPORT_ARCHES = [
  "arm64",
  "x64",
  "ia32",
  "universal",
  "unknown",
] as const

export const BUG_REPORT_LIFECYCLE_STATES = [
  "anonymous",
  "locked",
  "authorized",
  "linking",
  "syncing",
  "revoked",
  "unknown",
] as const

export type BugReportType = (typeof BUG_REPORT_TYPES)[number]
export type BugReportClientKind = (typeof BUG_REPORT_CLIENT_KINDS)[number]
export type BugReportPlatform = (typeof BUG_REPORT_PLATFORMS)[number]
export type BugReportArch = (typeof BUG_REPORT_ARCHES)[number]
export type BugReportLifecycleState =
  (typeof BUG_REPORT_LIFECYCLE_STATES)[number]

export interface BugReportTelemetry {
  appVersion: string
  clientKind: BugReportClientKind
  platform: BugReportPlatform
  arch: BugReportArch
  lifecycleState: BugReportLifecycleState
  osRelease: string
  appSurface: string
}

export interface BugReportInput {
  type: BugReportType
  title?: string
  description: string
  steps?: string
  telemetry: BugReportTelemetry
}

export interface BugReportValidationError {
  field:
    | "type"
    | "description"
    | "title"
    | "steps"
    | "telemetry.appVersion"
    | "telemetry.clientKind"
    | "telemetry.platform"
    | "telemetry.arch"
    | "telemetry.lifecycleState"
    | "telemetry.osRelease"
    | "telemetry.appSurface"
  message: string
}

export const BUG_REPORT_TYPE_SET = new Set<BugReportType>(BUG_REPORT_TYPES)
export const BUG_REPORT_CLIENT_KIND_SET = new Set<BugReportClientKind>(
  BUG_REPORT_CLIENT_KINDS
)
export const BUG_REPORT_PLATFORM_SET = new Set<BugReportPlatform>(
  BUG_REPORT_PLATFORMS
)
export const BUG_REPORT_ARCH_SET = new Set<BugReportArch>(BUG_REPORT_ARCHES)
export const BUG_REPORT_LIFECYCLE_SET = new Set<BugReportLifecycleState>(
  BUG_REPORT_LIFECYCLE_STATES
)

export const DEFAULT_BUG_REPORT_APP_SURFACE = "settings.help"
export const BUG_REPORT_TITLE_MAX_LEN = 120
export const BUG_REPORT_DESCRIPTION_MAX_LEN = 4000
export const BUG_REPORT_STEPS_MAX_LEN = 2000
