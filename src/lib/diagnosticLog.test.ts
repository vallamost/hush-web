import { describe, it, expect, vi, afterEach } from "vitest"

import {
  DEFAULT_DIAGNOSTIC_CAPACITY,
  DiagnosticLog,
  __resetRendererDiagnosticLogForTests,
  getRendererDiagnosticLog,
  installGlobalDiagnosticCapture,
  subscribeToDiagnosticEvents,
} from "./diagnosticLog"
import { recordClientDiagnostic } from "./clientDiagnostics"

afterEach(() => {
  __resetRendererDiagnosticLogForTests()
})

describe("DiagnosticLog ring buffer", () => {
  it("starts empty and reports the configured capacity", () => {
    const log = new DiagnosticLog(50)
    expect(log.size).toBe(0)
    expect(log.capacity).toBe(50)
    expect(log.snapshot()).toEqual([])
  })

  it("uses the default capacity when no argument is given", () => {
    expect(new DiagnosticLog().capacity).toBe(DEFAULT_DIAGNOSTIC_CAPACITY)
  })

  it("evicts the oldest entry once capacity is exceeded", () => {
    const log = new DiagnosticLog(3)
    for (let i = 0; i < 5; i += 1) {
      log.push({
        ts: `t${i}`,
        category: "test",
        event: "n",
        severity: "info",
        details: { i },
      })
    }
    expect(log.size).toBe(3)
    expect(log.snapshot().map((e) => e.details.i)).toEqual([2, 3, 4])
  })

  it("snapshot returns a copy that cannot mutate the buffer", () => {
    const log = new DiagnosticLog(3)
    log.push({
      ts: "t",
      category: "c",
      event: "e",
      severity: "info",
      details: {},
    })
    const snap = log.snapshot()
    snap.length = 0
    expect(log.size).toBe(1)
  })

  it("clear() empties the buffer", () => {
    const log = new DiagnosticLog(3)
    log.push({ ts: "t", category: "c", event: "e", severity: "info", details: {} })
    log.clear()
    expect(log.size).toBe(0)
  })
})

describe("subscribeToDiagnosticEvents", () => {
  it("absorbs hush:diagnostic events emitted via recordClientDiagnostic", () => {
    const log = new DiagnosticLog()
    const dispose = subscribeToDiagnosticEvents(log)
    try {
      recordClientDiagnostic({
        category: "api",
        event: "invalid-json-response",
        severity: "error",
        details: { operation: "verifyDeviceLinkRequest" },
      })
    } finally {
      dispose()
    }
    expect(log.size).toBe(1)
    expect(log.snapshot()[0]).toMatchObject({
      category: "api",
      event: "invalid-json-response",
      severity: "error",
    })
  })

  it("ignores malformed event payloads", () => {
    const log = new DiagnosticLog()
    const dispose = subscribeToDiagnosticEvents(log)
    try {
      globalThis.dispatchEvent(
        new CustomEvent("hush:diagnostic", { detail: { event: "no-category" } })
      )
      globalThis.dispatchEvent(
        new CustomEvent("hush:diagnostic", { detail: null })
      )
    } finally {
      dispose()
    }
    expect(log.size).toBe(0)
  })

  it("disposer removes the listener", () => {
    const log = new DiagnosticLog()
    const dispose = subscribeToDiagnosticEvents(log)
    dispose()
    recordClientDiagnostic({
      category: "api",
      event: "post-dispose",
      severity: "info",
      details: {},
    })
    expect(log.size).toBe(0)
  })
})

describe("installGlobalDiagnosticCapture", () => {
  it("captures console.warn and console.error through redaction", () => {
    const log = new DiagnosticLog()
    const consoleRef = { warn: vi.fn(), error: vi.fn() }
    const dispose = installGlobalDiagnosticCapture({
      log,
      consoleRef,
      target: undefined,
    })
    try {
      consoleRef.warn("alert from /Users/yarin/secret")
      consoleRef.error("token", "Bearer abcdef.123456.zzz")
    } finally {
      dispose()
    }
    expect(log.size).toBe(2)
    const [warn, error] = log.snapshot()
    expect(warn.category).toBe("console")
    expect(warn.severity).toBe("warn")
    expect(String(warn.details.message)).toContain("[path]")
    expect(error.severity).toBe("error")
    expect(String(error.details.message)).not.toContain("abcdef.123456.zzz")
  })

  it("captures window-level error and unhandledrejection events", () => {
    const log = new DiagnosticLog()
    const listeners: Record<string, ((event: Event) => void) | undefined> = {}
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        listeners[type] = listener
      },
      removeEventListener: (type: string) => {
        delete listeners[type]
      },
    }
    const consoleRef = { warn: vi.fn(), error: vi.fn() }
    const dispose = installGlobalDiagnosticCapture({ log, target, consoleRef })
    try {
      listeners.error?.({
        error: new Error("boom"),
        message: "boom",
      } as unknown as Event)
      listeners.unhandledrejection?.({
        reason: new Error("rejected"),
      } as unknown as Event)
    } finally {
      dispose()
    }
    expect(log.size).toBe(2)
    const [errEntry, rejEntry] = log.snapshot()
    expect(errEntry.event).toBe("window.onerror")
    expect(errEntry.severity).toBe("error")
    expect(rejEntry.event).toBe("unhandledrejection")
  })

  it("disposer restores console and removes listeners", () => {
    const log = new DiagnosticLog()
    const originalWarn = vi.fn()
    const originalError = vi.fn()
    const consoleRef = { warn: originalWarn, error: originalError }
    const dispose = installGlobalDiagnosticCapture({
      log,
      consoleRef,
      target: undefined,
    })
    dispose()
    consoleRef.warn("after dispose")
    expect(log.size).toBe(0)
    expect(consoleRef.warn).toBe(originalWarn)
    expect(consoleRef.error).toBe(originalError)
    expect(originalWarn).toHaveBeenCalledWith("after dispose")
  })

  it("still forwards the call to the original console method", () => {
    const log = new DiagnosticLog()
    const originalWarn = vi.fn()
    const originalError = vi.fn()
    const consoleRef = { warn: originalWarn, error: originalError }
    const dispose = installGlobalDiagnosticCapture({
      log,
      consoleRef,
      target: undefined,
    })
    try {
      consoleRef.warn("hi")
      consoleRef.error("boom")
    } finally {
      dispose()
    }
    expect(originalWarn).toHaveBeenCalledWith("hi")
    expect(originalError).toHaveBeenCalledWith("boom")
  })
})

describe("getRendererDiagnosticLog singleton", () => {
  it("returns the same instance on repeat calls", () => {
    const a = getRendererDiagnosticLog()
    const b = getRendererDiagnosticLog()
    expect(a).toBe(b)
  })

  it("captures hush:diagnostic events from the global stream", () => {
    const log = getRendererDiagnosticLog()
    recordClientDiagnostic({
      category: "voice",
      event: "playback-blocked",
      severity: "warn",
      details: { sid: "abc" },
    })
    const snap = log.snapshot()
    expect(snap.length).toBeGreaterThan(0)
    expect(snap[snap.length - 1]).toMatchObject({
      category: "voice",
      event: "playback-blocked",
    })
  })
})
