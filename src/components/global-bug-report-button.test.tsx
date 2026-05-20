import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import { GlobalBugReportButton } from "./global-bug-report-button"

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ vaultState: "unlocked" }),
  useOptionalAuth: () => ({ vaultState: "unlocked" }),
}))
vi.mock("@/lib/desktopBridge", () => ({
  getDesktopBridge: () => null,
}))
vi.mock("@/components/bug-report-dialog", () => ({
  BugReportDialog: ({
    open,
    lifecycleState,
    appSurface,
  }: {
    open: boolean
    lifecycleState?: string | null
    appSurface?: string
  }) =>
    open ? (
      <div
        data-testid="bug-report-dialog"
        data-lifecycle={lifecycleState ?? ""}
        data-surface={appSurface ?? ""}
      >
        dialog
      </div>
    ) : null,
}))

describe("GlobalBugReportButton", () => {
  afterEach(() => cleanup())

  it("renders an icon-only trigger with an accessible label", () => {
    renderWithProviders(<GlobalBugReportButton />)
    const trigger = screen.getByRole("button", { name: /report a bug/i })
    expect(trigger).toBeInTheDocument()
    expect(trigger.textContent).toBe("")
  })

  it("opens the dialog with the derived lifecycle and chrome surface", async () => {
    renderWithProviders(<GlobalBugReportButton />)
    expect(
      screen.queryByTestId("bug-report-dialog")
    ).not.toBeInTheDocument()

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /report a bug/i }))

    const dialog = screen.getByTestId("bug-report-dialog")
    expect(dialog.getAttribute("data-lifecycle")).toBe("authorized")
    expect(dialog.getAttribute("data-surface")).toBe("chrome.bottom-dock")
  })

  it("respects an explicit appSurface override", async () => {
    renderWithProviders(<GlobalBugReportButton appSurface="chrome.command-bar" />)
    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /report a bug/i }))
    expect(
      screen.getByTestId("bug-report-dialog").getAttribute("data-surface")
    ).toBe("chrome.command-bar")
  })
})
