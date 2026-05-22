import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DesktopUpdateState } from "@/lib/desktopBridge"

const mockUseDesktopUpdateState = vi.fn<() => DesktopUpdateState | null>()

vi.mock("@/hooks/useDesktopUpdateState", () => ({
  useDesktopUpdateState: () => mockUseDesktopUpdateState(),
}))

import { DesktopUpdatePanel } from "./desktop-update-panel"

const idleState: DesktopUpdateState = {
  phase: "idle",
  currentVersion: "0.1.35-mvp",
  targetVersion: null,
  progress: null,
  error: null,
}

describe("DesktopUpdatePanel", () => {
  afterEach(() => {
    cleanup()
    mockUseDesktopUpdateState.mockReset()
    delete (window as unknown as { hushDesktop?: unknown }).hushDesktop
  })

  it("renders desktop runtime metadata and runs a manual update check", async () => {
    const checkForDesktopUpdates = vi.fn().mockResolvedValue({
      ...idleState,
      phase: "skipped",
      error: "no-update",
    })
    ;(window as unknown as { hushDesktop: unknown }).hushDesktop = {
      isDesktop: true,
      platform: "win32",
      arch: "x64",
      getRuntimeInfo: vi.fn().mockResolvedValue({
        appVersion: "0.1.35-mvp",
        platform: "win32",
        arch: "x64",
        osRelease: "10.0.22631",
        electronVersion: "39.2.6",
      }),
      checkForDesktopUpdates,
    }
    mockUseDesktopUpdateState.mockReturnValue(idleState)

    render(<DesktopUpdatePanel />)

    expect(await screen.findByText("0.1.35-mvp")).toBeInTheDocument()
    expect(screen.getByText("Windows")).toBeInTheDocument()
    expect(screen.getByText("39.2.6")).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole("button", { name: /check for updates/i })
    )

    expect(checkForDesktopUpdates).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/hush is up to date/i)).toBeInTheDocument()
  })

  it("shows restart action when a downloaded update is ready", async () => {
    const installDesktopUpdate = vi.fn().mockResolvedValue({
      ...idleState,
      phase: "downloaded",
      targetVersion: "0.1.36-mvp",
    })
    ;(window as unknown as { hushDesktop: unknown }).hushDesktop = {
      isDesktop: true,
      platform: "darwin",
      arch: "arm64",
      getRuntimeInfo: vi.fn().mockResolvedValue({
        appVersion: "0.1.35-mvp",
        platform: "darwin",
        arch: "arm64",
        osRelease: "25.5.0",
        electronVersion: "39.2.6",
      }),
      installDesktopUpdate,
    }
    mockUseDesktopUpdateState.mockReturnValue({
      ...idleState,
      phase: "ready",
      targetVersion: "0.1.36-mvp",
    })

    render(<DesktopUpdatePanel />)

    await userEvent.click(
      screen.getByRole("button", { name: /restart to update/i })
    )

    await waitFor(() => {
      expect(installDesktopUpdate).toHaveBeenCalledTimes(1)
    })
  })
})
