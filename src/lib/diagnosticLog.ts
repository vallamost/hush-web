/**
 * Diagnostic ring buffer for bug reports (HUSHHQ-79).
 *
 * Subscribes to the `hush:diagnostic` CustomEvent stream that
 * `clientDiagnostics.recordClientDiagnostic` already dispatches, plus a
 * narrow set of global capture sources (console.warn / console.error,
 * window error and unhandled rejection). Entries are bounded; the
 * oldest fall off when capacity is exceeded.
 *
 * Redaction policy:
 *   - Emit-time: `recordClientDiagnostic` already passes `details`
 *     through `sanitizeDiagnosticDetails`, which now covers tokens,
 *     JWTs, mnemonics, key blobs, signed-URL parameters, local paths,
 *     and emails (see clientDiagnostics.js).
 *   - Ring buffer: messages from console / error / rejection capture
 *     are re-run through the same sanitizer before they enter the
 *     buffer. Defense in depth in case a future caller forgets to
 *     redact at the source.
 *   - Pre-upload: `snapshot()` returns an already-redacted view. The
 *     bug-report dialog calls it directly and previews the same bytes
 *     that get sent.
 *
 * The buffer never leaves the device unless the user explicitly opts
 * into attaching it to a bug report.
 */

import {
  DIAGNOSTIC_EVENT_NAME,
  sanitizeDiagnosticDetails,
} from "./clientDiagnostics"

export type DiagnosticSeverity = "info" | "warn" | "error"

export interface DiagnosticEntry {
  readonly ts: string
  readonly category: string
  readonly event: string
  readonly severity: DiagnosticSeverity
  readonly details: Record<string, unknown>
}

export const DEFAULT_DIAGNOSTIC_CAPACITY = 200

/**
 * Bounded FIFO. Pure container — has no dependency on `window`, so it
 * is safely instantiated in jsdom tests and SSR.
 */
export class DiagnosticLog {
  private _entries: DiagnosticEntry[] = []
  private _capacity: number

  constructor(capacity: number = DEFAULT_DIAGNOSTIC_CAPACITY) {
    this._capacity = Math.max(1, Math.floor(capacity))
  }

  get capacity(): number {
    return this._capacity
  }

  get size(): number {
    return this._entries.length
  }

  push(entry: DiagnosticEntry): void {
    this._entries.push(entry)
    while (this._entries.length > this._capacity) {
      this._entries.shift()
    }
  }

  snapshot(): DiagnosticEntry[] {
    return this._entries.slice()
  }

  clear(): void {
    this._entries.length = 0
  }
}

type EventTargetLike = {
  addEventListener: (
    type: string,
    listener: (event: Event) => void
  ) => void
  removeEventListener: (
    type: string,
    listener: (event: Event) => void
  ) => void
}

interface DiagnosticDetailShape {
  ts?: unknown
  category?: unknown
  event?: unknown
  severity?: unknown
  details?: unknown
}

function normalizeSeverity(value: unknown): DiagnosticSeverity {
  if (value === "warn" || value === "error") return value
  return "info"
}

function coerceEntry(detail: unknown): DiagnosticEntry | null {
  if (!detail || typeof detail !== "object") return null
  const d = detail as DiagnosticDetailShape
  if (typeof d.category !== "string" || d.category.length === 0) return null
  if (typeof d.event !== "string" || d.event.length === 0) return null
  const ts =
    typeof d.ts === "string" && d.ts.length > 0
      ? d.ts
      : new Date().toISOString()
  const details =
    d.details && typeof d.details === "object"
      ? (d.details as Record<string, unknown>)
      : {}
  return {
    ts,
    category: d.category,
    event: d.event,
    severity: normalizeSeverity(d.severity),
    details,
  }
}

/**
 * Subscribes `log` to the global `hush:diagnostic` CustomEvent stream.
 * Returns a disposer.
 */
export function subscribeToDiagnosticEvents(
  log: DiagnosticLog,
  target: EventTargetLike = globalThis as unknown as EventTargetLike
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail
    const entry = coerceEntry(detail)
    if (entry) log.push(entry)
  }
  target.addEventListener(DIAGNOSTIC_EVENT_NAME, listener)
  return () => {
    target.removeEventListener(DIAGNOSTIC_EVENT_NAME, listener)
  }
}

interface ConsoleLike {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

interface GlobalCaptureOptions {
  readonly log: DiagnosticLog
  readonly target?: EventTargetLike
  readonly consoleRef?: ConsoleLike
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`
  }
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function entryFromConsole(
  severity: "warn" | "error",
  args: unknown[]
): DiagnosticEntry {
  const message = args.map(stringifyArg).join(" ")
  return {
    ts: new Date().toISOString(),
    category: "console",
    event: severity,
    severity,
    details: sanitizeDiagnosticDetails({ message }),
  }
}

function entryFromError(error: unknown, source: string): DiagnosticEntry {
  let message: string
  let stack: string | undefined
  if (error instanceof Error) {
    message = `${error.name}: ${error.message}`
    stack = typeof error.stack === "string" ? error.stack : undefined
  } else {
    message = stringifyArg(error)
  }
  const details: Record<string, unknown> = { source, message }
  if (stack) details.stack = stack
  return {
    ts: new Date().toISOString(),
    category: "global",
    event: source,
    severity: "error",
    details: sanitizeDiagnosticDetails(details),
  }
}

/**
 * Installs console.warn / console.error wrappers and window-level
 * `error` / `unhandledrejection` listeners that funnel entries into
 * the supplied log. Idempotent; calling it twice has the same effect
 * as calling it once. Returns a disposer that restores the originals.
 *
 * In a server-side or test context with no window, only the console
 * wrappers are installed.
 */
export function installGlobalDiagnosticCapture(
  options: GlobalCaptureOptions
): () => void {
  const { log } = options
  const consoleRef: ConsoleLike =
    options.consoleRef ?? (globalThis.console as ConsoleLike)
  const target: EventTargetLike | null =
    options.target ?? (typeof window === "undefined" ? null : (window as unknown as EventTargetLike))

  const originalWarn = consoleRef.warn
  const originalError = consoleRef.error

  const warnPatch = (...args: unknown[]) => {
    log.push(entryFromConsole("warn", args))
    originalWarn.apply(consoleRef, args)
  }
  const errorPatch = (...args: unknown[]) => {
    log.push(entryFromConsole("error", args))
    originalError.apply(consoleRef, args)
  }

  consoleRef.warn = warnPatch
  consoleRef.error = errorPatch

  const errorListener = (event: Event) => {
    const e = event as ErrorEvent
    log.push(entryFromError(e.error ?? e.message, "window.onerror"))
  }
  const rejectionListener = (event: Event) => {
    const e = event as PromiseRejectionEvent
    log.push(entryFromError(e.reason, "unhandledrejection"))
  }

  if (target) {
    target.addEventListener("error", errorListener)
    target.addEventListener("unhandledrejection", rejectionListener)
  }

  return () => {
    consoleRef.warn = originalWarn
    consoleRef.error = originalError
    if (target) {
      target.removeEventListener("error", errorListener)
      target.removeEventListener("unhandledrejection", rejectionListener)
    }
  }
}

// ─── Singleton renderer log ────────────────────────────────────────────

let rendererLog: DiagnosticLog | null = null
let rendererSubscriptions: Array<() => void> = []

/**
 * Returns the renderer-wide diagnostic log. Lazily initialized on first
 * call so tests can opt out by importing only `DiagnosticLog`.
 */
export function getRendererDiagnosticLog(): DiagnosticLog {
  if (!rendererLog) {
    rendererLog = new DiagnosticLog()
    if (typeof window !== "undefined") {
      rendererSubscriptions.push(subscribeToDiagnosticEvents(rendererLog))
      rendererSubscriptions.push(
        installGlobalDiagnosticCapture({ log: rendererLog })
      )
    }
  }
  return rendererLog
}

/**
 * Tear-down helper for tests. Disposes any active capture/subscription
 * installed by `getRendererDiagnosticLog` and clears the singleton.
 */
export function __resetRendererDiagnosticLogForTests(): void {
  for (const dispose of rendererSubscriptions) {
    try {
      dispose()
    } catch {
      // Capture errors during teardown should not crash tests.
    }
  }
  rendererSubscriptions = []
  rendererLog = null
}
