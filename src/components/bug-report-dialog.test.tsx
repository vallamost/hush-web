import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { BugReportDialog } from "./bug-report-dialog"
import {
  __resetRendererDiagnosticLogForTests,
  getRendererDiagnosticLog,
} from "@/lib/diagnosticLog"

const submitBugReportMock = vi.fn()

vi.mock("@/lib/bugReport", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bugReport")>(
    "@/lib/bugReport"
  )
  return {
    ...actual,
    submitBugReport: (...args: unknown[]) => submitBugReportMock(...args),
  }
})

vi.mock("@/lib/desktopBridge", () => ({
  getDesktopBridge: () => null,
}))

describe("BugReportDialog", () => {
  beforeEach(() => {
    submitBugReportMock.mockReset()
  })

  afterEach(() => {
    cleanup()
    __resetRendererDiagnosticLogForTests()
  })

  it("renders telemetry preview as JSON before submission", () => {
    render(<BugReportDialog open onOpenChange={() => {}} />)
    const preview = screen.getByText(/"appSurface"/)
    expect(preview.textContent).toContain("\"clientKind\": \"web\"")
  })

  it("submits the report and shows success copy", async () => {
    submitBugReportMock.mockResolvedValueOnce({ status: "ok" })
    const onOpenChange = vi.fn()
    render(<BugReportDialog open onOpenChange={onOpenChange} />)

    const u = userEvent.setup()
    const description = screen.getByLabelText(/^description$/i)
    await u.type(description, "Clicking the avatar does nothing.")
    await u.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() =>
      expect(
        screen.getByText(/report sent\. thanks for the heads-up/i)
      ).toBeInTheDocument()
    )
    const [payload] = submitBugReportMock.mock.calls[0] as [
      { type: string; telemetry: { clientKind: string } }
    ]
    expect(payload.type).toBe("bug")
    expect(payload.telemetry.clientKind).toBe("web")
  })

  it("renders a not-configured message on 503", async () => {
    submitBugReportMock.mockResolvedValueOnce({ status: "not_configured" })
    render(<BugReportDialog open onOpenChange={() => {}} />)

    const u = userEvent.setup()
    await u.type(
      screen.getByLabelText(/^description$/i),
      "Voice cuts out on join."
    )
    await u.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() =>
      expect(
        screen.getByText(/bug-report service is not configured/i)
      ).toBeInTheDocument()
    )
  })

  it("renders the validation_error feedback returned by the submitter", async () => {
    submitBugReportMock.mockResolvedValueOnce({
      status: "validation_error",
      error: {
        field: "description",
        message: "Describe what happened before sending.",
      },
    })
    render(<BugReportDialog open onOpenChange={() => {}} />)

    const u = userEvent.setup()
    // The textarea has `required`, so we type something to clear the
    // browser-native check. The mocked submitter still returns a
    // validation error so the dialog can render its inline message.
    await u.type(
      screen.getByLabelText(/^description$/i),
      "placeholder to clear required"
    )
    await u.click(screen.getByRole("button", { name: /send report/i }))

    await waitFor(() =>
      expect(
        screen.getByText(/describe what happened before sending\./i)
      ).toBeInTheDocument()
    )
  })

  // HUSHHQ-79: opt-in diagnostic log.
  describe("diagnostic log opt-in", () => {
    function seedDiagnostic() {
      const log = getRendererDiagnosticLog()
      log.push({
        ts: "2026-05-26T12:00:00.000Z",
        category: "voice",
        event: "livekit-disconnected",
        severity: "info",
        details: { reconnectAttempts: 2 },
      })
    }

    it("attaches the captured diagnostic snapshot when the toggle is on (default)", async () => {
      seedDiagnostic()
      submitBugReportMock.mockResolvedValueOnce({ status: "ok" })
      render(<BugReportDialog open onOpenChange={() => {}} />)

      const u = userEvent.setup()
      await u.type(
        screen.getByLabelText(/^description$/i),
        "Voice dropped after reconnect."
      )
      await u.click(screen.getByRole("button", { name: /send report/i }))

      await waitFor(() => expect(submitBugReportMock).toHaveBeenCalled())
      const [payload] = submitBugReportMock.mock.calls[0] as [
        {
          diagnosticLog?: Array<{ category: string; event: string }>
        }
      ]
      expect(payload.diagnosticLog).toBeTruthy()
      expect(payload.diagnosticLog?.[0]).toMatchObject({
        category: "voice",
        event: "livekit-disconnected",
      })
    })

    it("omits the diagnostic log when the toggle is off", async () => {
      seedDiagnostic()
      submitBugReportMock.mockResolvedValueOnce({ status: "ok" })
      render(<BugReportDialog open onOpenChange={() => {}} />)

      const u = userEvent.setup()
      await u.click(
        screen.getByRole("switch", { name: /attach diagnostic log/i })
      )
      await u.type(
        screen.getByLabelText(/^description$/i),
        "Submitting without diagnostics."
      )
      await u.click(screen.getByRole("button", { name: /send report/i }))

      await waitFor(() => expect(submitBugReportMock).toHaveBeenCalled())
      const [payload] = submitBugReportMock.mock.calls[0] as [
        { diagnosticLog?: unknown }
      ]
      expect(payload.diagnosticLog).toBeUndefined()
    })

    it("preview shows the same diagnostic entries that get sent", async () => {
      seedDiagnostic()
      submitBugReportMock.mockResolvedValueOnce({ status: "ok" })
      render(<BugReportDialog open onOpenChange={() => {}} />)

      const u = userEvent.setup()
      await u.click(
        screen.getByRole("button", { name: /preview what gets sent/i })
      )

      const preview = await screen.findByTestId(
        "bug-report-diagnostic-preview"
      )
      expect(preview.textContent).toContain("livekit-disconnected")

      await u.type(
        screen.getByLabelText(/^description$/i),
        "Diagnostic preview check."
      )
      await u.click(screen.getByRole("button", { name: /send report/i }))
      await waitFor(() => expect(submitBugReportMock).toHaveBeenCalled())
      const [payload] = submitBugReportMock.mock.calls[0] as [
        { diagnosticLog?: Array<{ event: string }> }
      ]
      const previewParsed = JSON.parse(preview.textContent ?? "[]")
      expect(payload.diagnosticLog).toEqual(previewParsed)
    })

    it("disables the toggle when the diagnostic buffer is empty", () => {
      render(<BugReportDialog open onOpenChange={() => {}} />)
      const toggle = screen.getByRole("switch", {
        name: /attach diagnostic log/i,
      })
      expect(toggle).toBeDisabled()
      expect(
        screen.getByText(/no recent diagnostic events were recorded/i)
      ).toBeInTheDocument()
    })
  })
})
