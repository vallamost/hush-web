import { describe, expect, it, vi } from "vitest"

import {
  BUG_REPORT_TYPES,
  buildBugReportPayload,
  buildBugReportTelemetry,
  submitBugReport,
  validateBugReportInput,
  type BugReportInput,
} from "./bugReport"

function baseTelemetry() {
  return {
    appVersion: "0.7.0-alpha.test",
    clientKind: "web" as const,
    platform: "darwin" as const,
    arch: "arm64" as const,
    lifecycleState: "authorized" as const,
    osRelease: "23.4.0",
    appSurface: "settings.help",
  }
}

function baseInput(overrides: Partial<BugReportInput> = {}): BugReportInput {
  return {
    type: "bug",
    description: "Cards no longer expand when clicked.",
    telemetry: baseTelemetry(),
    ...overrides,
  }
}

describe("buildBugReportTelemetry", () => {
  it("falls back to safe defaults when no bridge is provided", () => {
    const result = buildBugReportTelemetry({})
    expect(result.clientKind).toBe("web")
    expect(result.osRelease).toBe("unknown")
    expect(result.appSurface).toBe("settings.help")
    expect(result.lifecycleState).toBe("unknown")
    expect(result.appVersion.length).toBeGreaterThan(0)
  })

  it("marks desktop telemetry from the bridge", () => {
    const result = buildBugReportTelemetry({
      desktopBridge: {
        isDesktop: true,
        platform: "darwin",
        arch: "arm64",
        osRelease: "23.4.0",
      },
      lifecycleState: "authorized",
      appSurface: "settings.devices",
    })
    expect(result.clientKind).toBe("desktop")
    expect(result.platform).toBe("darwin")
    expect(result.arch).toBe("arm64")
    expect(result.osRelease).toBe("23.4.0")
    expect(result.lifecycleState).toBe("authorized")
    expect(result.appSurface).toBe("settings.devices")
  })

  it("normalises invalid platform / arch reported by the bridge", () => {
    const result = buildBugReportTelemetry({
      desktopBridge: {
        isDesktop: true,
        platform: "freebsd",
        arch: "mips",
      },
    })
    expect(result.platform).toBe("unknown")
    expect(result.arch).toBe("unknown")
  })

  it("rejects unknown lifecycle values rather than letting them through", () => {
    const result = buildBugReportTelemetry({
      lifecycleState: "evil" as never,
    })
    expect(result.lifecycleState).toBe("unknown")
  })
})

describe("validateBugReportInput", () => {
  it("requires a non-empty description", () => {
    const result = validateBugReportInput(baseInput({ description: "   " }))
    expect(result?.field).toBe("description")
  })

  it("requires an allowed type", () => {
    const result = validateBugReportInput(
      baseInput({ type: "ransom" as never })
    )
    expect(result?.field).toBe("type")
  })

  it("rejects an oversized description", () => {
    const result = validateBugReportInput(
      baseInput({ description: "x".repeat(4001) })
    )
    expect(result?.field).toBe("description")
  })

  it("passes for a well-formed payload", () => {
    expect(validateBugReportInput(baseInput())).toBeNull()
  })

  it("flags telemetry tampering before the network hop", () => {
    const input = baseInput()
    ;(input.telemetry as { platform: string }).platform = "haiku"
    expect(validateBugReportInput(input)?.field).toBe("telemetry.platform")
  })
})

describe("buildBugReportPayload", () => {
  it("omits empty title and steps from the wire payload", () => {
    const payload = buildBugReportPayload(baseInput({ title: "", steps: "" }))
    expect("title" in payload).toBe(false)
    expect("steps" in payload).toBe(false)
    expect(payload.type).toBe("bug")
    expect(payload.description).toBe("Cards no longer expand when clicked.")
  })

  it("trims whitespace from each text field", () => {
    const payload = buildBugReportPayload(
      baseInput({
        description: "  whitespace surrounds  ",
        title: "  trimmed title  ",
        steps: "  step one  ",
      })
    )
    expect(payload.description).toBe("whitespace surrounds")
    expect(payload.title).toBe("trimmed title")
    expect(payload.steps).toBe("step one")
  })

  it("never leaks identifier-like keys on the wire", () => {
    const payload = buildBugReportPayload(baseInput())
    const forbidden = [
      "userId",
      "username",
      "publicKey",
      "deviceId",
      "token",
      "channelId",
      "serverId",
      "ipAddress",
      "messageId",
      "logs",
    ]
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk)
        return
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          for (const banned of forbidden) {
            expect(key.toLowerCase()).not.toContain(banned.toLowerCase())
          }
          walk(child)
        }
      }
    }
    walk(payload)
  })
})

describe("submitBugReport", () => {
  it("short-circuits on validation error without calling fetch", async () => {
    const fetcher = vi.fn()
    const outcome = await submitBugReport(
      baseInput({ description: "" }),
      { fetcher: fetcher as unknown as typeof fetch, endpoint: "https://example" }
    )
    expect(outcome.status).toBe("validation_error")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("reports success on a 2xx response", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 202 }))
    const outcome = await submitBugReport(baseInput(), {
      fetcher: fetcher as unknown as typeof fetch,
      endpoint: "https://example",
    })
    expect(outcome.status).toBe("ok")
    expect(fetcher).toHaveBeenCalledWith(
      "https://example",
      expect.objectContaining({ method: "POST" })
    )
  })

  it("maps 503 onto the not-configured outcome", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 503 }))
    const outcome = await submitBugReport(baseInput(), {
      fetcher: fetcher as unknown as typeof fetch,
      endpoint: "https://example",
    })
    expect(outcome.status).toBe("not_configured")
  })

  it("surfaces other non-2xx as rejected with the status code", async () => {
    const fetcher = vi.fn(async () => new Response("bad", { status: 400 }))
    const outcome = await submitBugReport(baseInput(), {
      fetcher: fetcher as unknown as typeof fetch,
      endpoint: "https://example",
    })
    expect(outcome).toMatchObject({ status: "rejected", httpStatus: 400 })
  })

  it("returns network_error when fetch throws", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline")
    })
    const outcome = await submitBugReport(baseInput(), {
      fetcher: fetcher as unknown as typeof fetch,
      endpoint: "https://example",
    })
    expect(outcome).toMatchObject({
      status: "network_error",
      message: "offline",
    })
  })

  it("uses Content-Type application/json", async () => {
    let captured: RequestInit | undefined
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init
      return new Response("", { status: 200 })
    })
    await submitBugReport(baseInput(), {
      fetcher: fetcher as unknown as typeof fetch,
      endpoint: "https://example",
    })
    const headers = captured?.headers as Record<string, string> | undefined
    expect(headers?.["Content-Type"]).toBe("application/json")
    const body = JSON.parse(String(captured?.body))
    expect(body.type).toBe("bug")
    expect(body.telemetry.platform).toBe("darwin")
  })
})

describe("BUG_REPORT_TYPES", () => {
  it("matches the proxy contract", () => {
    expect(BUG_REPORT_TYPES).toEqual([
      "bug",
      "crash",
      "ui",
      "performance",
      "voice",
      "device-linking",
      "other",
    ])
  })
})
