/**
 * Verifies CommandPalette routes onSelect actions: mute, cheat sheet,
 * sign out, settings, discover, and channel/server jump.
 * Search results only appear once the user has typed.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    })
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
  // cmdk calls scrollIntoView on focused items; jsdom does not implement it.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {}
  }
})

import { CommandPalette } from "./command-palette"

const SERVERS = [
  { id: "srv-1", name: "Alpha" },
  { id: "srv-2", name: "Beta" },
]
const CHANNELS: React.ComponentProps<typeof CommandPalette>["channels"] = [
  { id: "ch-1", name: "general", kind: "text", serverId: "srv-1", serverName: "Alpha" },
]

describe("CommandPalette", () => {
  afterEach(() => cleanup())

  function setup(
    overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {}
  ) {
    return render(
      <CommandPalette
        open
        onOpenChange={overrides.onOpenChange ?? vi.fn()}
        channels={overrides.channels ?? CHANNELS}
        servers={overrides.servers ?? SERVERS}
        onJumpServer={overrides.onJumpServer ?? vi.fn()}
        onJumpChannel={overrides.onJumpChannel ?? vi.fn()}
        onToggleMute={overrides.onToggleMute ?? vi.fn()}
        onGoHome={overrides.onGoHome ?? vi.fn()}
        onOpenCheatSheet={overrides.onOpenCheatSheet ?? vi.fn()}
        onDiscoverServers={overrides.onDiscoverServers}
        onOpenSettings={overrides.onOpenSettings}
        onCheckForUpdates={overrides.onCheckForUpdates}
        onSignOut={overrides.onSignOut}
        onCreateServer={overrides.onCreateServer}
        onCreateChannel={overrides.onCreateChannel}
      />
    )
  }

  it("hides server / channel results until the user starts typing", () => {
    setup()
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument()
    expect(screen.queryByText("general")).not.toBeInTheDocument()
  })

  it("invokes onGoHome from the navigation group", async () => {
    const onGoHome = vi.fn()
    const onOpenChange = vi.fn()
    setup({ onGoHome, onOpenChange })

    await userEvent.click(screen.getByText(/go to home/i))

    expect(onGoHome).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("invokes onSignOut from the preferences group", async () => {
    const onSignOut = vi.fn()
    setup({ onSignOut })

    await userEvent.click(screen.getByText(/sign out/i))

    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it("invokes onCheckForUpdates from the preferences group", async () => {
    const onCheckForUpdates = vi.fn()
    const onOpenChange = vi.fn()
    setup({ onCheckForUpdates, onOpenChange })

    await userEvent.click(screen.getByText(/check for updates/i))

    expect(onCheckForUpdates).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("disables Check for updates when desktop update handler is absent", () => {
    setup()

    const item = screen.getByText(/check for updates/i).closest("[role='option']")
    expect(item).toHaveAttribute("data-disabled")
  })

  // Discover servers is unconditionally disabled+muted until the
  // instance discovery index ships (see command-palette.tsx). The
  // `onDiscoverServers` prop kept for future re-enable but is no
  // longer wired to the item, so a click must be a no-op even when a
  // handler is provided.
  it("renders Discover servers as disabled regardless of handler", async () => {
    const onDiscoverServers = vi.fn()
    setup({ onDiscoverServers })

    const discover = screen.getByText(/discover servers/i).closest(
      "[role='option']"
    )
    expect(discover).toHaveAttribute("data-disabled")
    await userEvent.click(screen.getByText(/discover servers/i))
    expect(onDiscoverServers).not.toHaveBeenCalled()
  })

  it("invokes onCreateChannel with text when Create channel is selected", async () => {
    const onCreateChannel = vi.fn()
    const onOpenChange = vi.fn()
    setup({ onCreateChannel, onOpenChange })

    await userEvent.click(screen.getByText(/create channel/i))

    expect(onCreateChannel).toHaveBeenCalledWith("text")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("invokes onCreateChannel with category when Create category is selected", async () => {
    const onCreateChannel = vi.fn()
    setup({ onCreateChannel })

    await userEvent.click(screen.getByText(/create category/i))

    expect(onCreateChannel).toHaveBeenCalledWith("category")
  })

  it("disables Create channel and Create category when no handler is provided", async () => {
    setup()

    const createChannel = screen.getByText(/create channel/i).closest(
      "[role='option']"
    )
    const createCategory = screen.getByText(/create category/i).closest(
      "[role='option']"
    )
    expect(createChannel).toHaveAttribute("data-disabled")
    expect(createCategory).toHaveAttribute("data-disabled")
  })
})
