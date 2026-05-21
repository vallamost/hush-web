/**
 * Verifies UserSettingsDialog surfaces account info, exposes only
 * wired settings sections, routes Log out through confirmation, and
 * persists the Security → Vault timeout choice through useAuth.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "@/components/theme-provider"
import type { GlassCapabilities } from "@/lib/appearancePreferences"

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
})

const mockUseAuth = vi.fn()
const mockGetVaultConfig = vi.fn()

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => mockUseAuth(),
}))
vi.mock("@/lib/identityVault", () => ({
  getVaultConfig: (...args: unknown[]) => mockGetVaultConfig(...args),
  bytesToHex: () => "deadbeef",
}))

// DevicesPanel pulls api + router + transparency + device label. Stub
// at the module boundary so the dialog suite can assert section
// presence without hauling in those concerns.
vi.mock("@/lib/api", () => ({
  listDeviceKeys: vi.fn().mockResolvedValue([]),
  revokeDeviceKey: vi.fn(),
}))
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}))
vi.mock("@/lib/deviceLabel", () => ({
  getReadableDeviceLabel: () => "Chrome on macOS",
}))
vi.mock("@/lib/transparencyVerifier", () => ({
  TransparencyVerifier: function MockVerifier() {
    return { verifyOwnKey: vi.fn() }
  },
}))
vi.mock("@/hooks/useAuth", () => ({
  getDeviceId: () => "device-current",
  HOME_INSTANCE_KEY: "hush_home_instance",
}))

import { UserSettingsDialog } from "./user-settings-dialog"

describe("UserSettingsDialog", () => {
  afterEach(() => {
    cleanup()
    mockUseAuth.mockReset()
    mockGetVaultConfig.mockReset()
    delete (window as unknown as { hushDesktop?: unknown }).hushDesktop
    localStorage.clear()
    document.documentElement.classList.remove("light", "dark")
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.glass
    document.documentElement.style.removeProperty("--desktop-glass-tint-strength")
    document.documentElement.style.removeProperty("--desktop-glass-alpha")
  })

  it("renders username + display name from the account prop", () => {
    render(
      <UserSettingsDialog
        open
        onOpenChange={() => {}}
        account={{ displayName: "Yarin", username: "yarin" }}
      />
    )

    expect(screen.getByText("Yarin")).toBeInTheDocument()
    expect(screen.getByText("yarin")).toBeInTheDocument()
  })

  it("does not use username as the account display-name field fallback", () => {
    render(
      <UserSettingsDialog
        open
        onOpenChange={() => {}}
        account={{ displayName: "", username: "yarin" }}
      />
    )

    expect(screen.getByText("Not set")).toBeInTheDocument()
    expect(screen.getByText("yarin")).toBeInTheDocument()
  })

  it("normalizes legacy @username display names", () => {
    render(
      <UserSettingsDialog
        open
        onOpenChange={() => {}}
        account={{ displayName: "@yarin", username: "yarin" }}
      />
    )

    expect(screen.getAllByText("yarin")).toHaveLength(2)
  })

  it("removes AI assistant and disables unwired settings sections", async () => {
    render(
      <UserSettingsDialog
        open
        onOpenChange={() => {}}
        account={{ displayName: "Yarin", username: "yarin" }}
      />
    )

    expect(
      screen.queryByRole("button", { name: /ai assistant/i })
    ).not.toBeInTheDocument()

    const disabledSections = [
      /^profile$/i,
      /^privacy & safety$/i,
      /^notifications$/i,
      /^keybinds$/i,
      /^language$/i,
      /^integrations$/i,
      /^advanced$/i,
    ]

    for (const name of disabledSections) {
      expect(screen.getByRole("button", { name })).toBeDisabled()
    }

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /^profile$/i }))

    expect(
      screen.getByRole("heading", { name: /^my account$/i })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: /^profile$/i })
    ).not.toBeInTheDocument()
  })

  it("enables Appearance theme and glass controls", async () => {
    render(
      <ThemeProvider disableTransitionOnChange={false}>
        <UserSettingsDialog
          open
          onOpenChange={() => {}}
          account={{ displayName: "Yarin", username: "yarin" }}
        />
      </ThemeProvider>
    )

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /^appearance$/i }))

    expect(
      screen.getByRole("heading", { name: /^appearance$/i })
    ).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /^dark$/i })).toHaveAttribute(
      "data-state",
      "active"
    )

    await u.click(screen.getByRole("tab", { name: /^light$/i }))
    expect(document.documentElement).toHaveClass("light")

    const glassSwitch = screen.getByRole("switch", {
      name: /enable glass effect/i,
    })
    expect(glassSwitch).toBeChecked()
    expect(
      screen.getByRole("slider", { name: /glass intensity/i })
    ).toBeEnabled()
    expect(
      screen.queryByRole("slider", { name: /glass tint/i })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("slider", { name: /glass transparency/i })
    ).not.toBeInTheDocument()

    await u.click(glassSwitch)
    expect(document.documentElement.dataset.glass).toBe("off")
    expect(
      screen.getByRole("slider", { name: /glass intensity/i })
    ).toHaveAttribute("aria-disabled", "true")
  })

  it("hides the material picker outside the Electron shell", async () => {
    render(
      <ThemeProvider disableTransitionOnChange={false}>
        <UserSettingsDialog
          open
          onOpenChange={() => {}}
          account={{ displayName: "Yarin", username: "yarin" }}
        />
      </ThemeProvider>
    )

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /^appearance$/i }))

    expect(
      screen.queryByRole("combobox", { name: /glass material/i })
    ).not.toBeInTheDocument()
  })

  it("does not reset a stored desktop material while capabilities are loading", async () => {
    const setGlassMaterial = vi.fn().mockResolvedValue(undefined)
    let resolveCapabilities: (value: GlassCapabilities) => void = () => {}
    const capabilitiesPromise = new Promise<GlassCapabilities>((resolve) => {
      resolveCapabilities = resolve
    })
    Object.defineProperty(window, "hushDesktop", {
      configurable: true,
      value: {
        isDesktop: true,
        platform: "darwin",
        setGlassMaterial,
        getGlassCapabilities: vi.fn(() => capabilitiesPromise),
      },
    })
    localStorage.setItem(
      "hush_appearance_preferences_v1",
      JSON.stringify({
        theme: "dark",
        glassEnabled: true,
        glassIntensity: 50,
        glassMaterial: "menu",
      })
    )

    render(
      <ThemeProvider disableTransitionOnChange={false}>
        <UserSettingsDialog
          open
          onOpenChange={() => {}}
          account={{ displayName: "Yarin", username: "yarin" }}
        />
      </ThemeProvider>
    )

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /^appearance$/i }))

    expect(
      JSON.parse(localStorage.getItem("hush_appearance_preferences_v1") ?? "{}")
        .glassMaterial
    ).toBe("menu")

    resolveCapabilities({
      platform: "darwin",
      materialSwitchingSupported: true,
      materials: ["auto", "sidebar", "under-window", "menu", "headerView"],
      unsupportedReason: null,
    })

    await waitFor(() => {
      expect(setGlassMaterial).toHaveBeenCalledWith("menu")
    })
    expect(
      JSON.parse(localStorage.getItem("hush_appearance_preferences_v1") ?? "{}")
        .glassMaterial
    ).toBe("menu")
  })

  it("invokes onSignOut after the destructive confirm", async () => {
    const onSignOut = vi.fn()
    render(
      <UserSettingsDialog
        open
        onOpenChange={() => {}}
        account={{ displayName: "Yarin", username: "yarin" }}
        onSignOut={onSignOut}
      />
    )

    const u = userEvent.setup()
    await u.click(screen.getAllByText(/log out/i)[0])
    const triggerBtn = screen
      .getAllByRole("button", { name: /log out/i })
      .find((b) => b.classList.contains("bg-destructive"))
    if (!triggerBtn) throw new Error("Log out trigger not found")
    await u.click(triggerBtn)

    const confirm = await screen.findByRole("button", { name: /^log out$/i })
    await u.click(confirm)

    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it("seeds the Security vault-timeout select from the stored config", async () => {
    mockUseAuth.mockReturnValue({
      user: { id: "u1" },
      updateVaultTimeout: vi.fn(),
    })
    mockGetVaultConfig.mockReturnValue({ timeout: 60, pinType: "pin" })

    render(
      <UserSettingsDialog
        open
        onOpenChange={() => {}}
        account={{ displayName: "Yarin", username: "yarin" }}
      />
    )

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /^security$/i }))

    expect(mockGetVaultConfig).toHaveBeenCalledWith("u1")
    // The trigger renders the matching option label; "1 hour" maps to
    // numeric 60 in the legacy vault config.
    expect(
      screen.getByRole("combobox", { name: /vault timeout/i })
    ).toHaveTextContent(/1 hour/i)
  })

  it("uses desktop copy for vault timeout labels inside the desktop shell", async () => {
    Object.defineProperty(window, "hushDesktop", {
      configurable: true,
      value: { isDesktop: true, platform: "darwin" },
    })
    mockUseAuth.mockReturnValue({
      user: { id: "u1" },
      updateVaultTimeout: vi.fn(),
    })
    mockGetVaultConfig.mockReturnValue({ timeout: "browser_close", pinType: "pin" })

    render(
      <UserSettingsDialog
        open
        onOpenChange={() => {}}
        account={{ displayName: "Yarin", username: "yarin" }}
      />
    )

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /^security$/i }))

    expect(
      screen.getByRole("combobox", { name: /vault timeout/i })
    ).toHaveTextContent(/on app close/i)
    expect(screen.getByText(/locks on closing hush/i)).toBeInTheDocument()
    expect(screen.queryByText(/browser close/i)).not.toBeInTheDocument()
  })

  it("exposes a Devices section under Account that activates DevicesPanel", async () => {
    mockUseAuth.mockReturnValue({
      user: { id: "u1" },
      token: "tok",
      identityKeyRef: { current: { publicKey: new Uint8Array() } },
      setTransparencyError: vi.fn(),
    })
    mockGetVaultConfig.mockReturnValue({ timeout: 60, pinType: "pin" })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <UserSettingsDialog
          open
          onOpenChange={() => {}}
          account={{ displayName: "Yarin", username: "yarin" }}
        />
      </QueryClientProvider>
    )

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /^devices$/i }))

    expect(
      screen.getByRole("heading", { name: /^devices$/i })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /link a new device/i })
    ).toBeInTheDocument()
  })

  it("warns when the vault timeout is set to Never", async () => {
    mockUseAuth.mockReturnValue({
      user: { id: "u1" },
      updateVaultTimeout: vi.fn(),
    })
    mockGetVaultConfig.mockReturnValue({ timeout: "never", pinType: "pin" })

    render(
      <UserSettingsDialog
        open
        onOpenChange={() => {}}
        account={{ displayName: "Yarin", username: "yarin" }}
      />
    )

    const u = userEvent.setup()
    await u.click(screen.getByRole("button", { name: /^security$/i }))

    expect(
      screen.getByText(/non-extractable wrapping key stays on this device/i)
    ).toBeInTheDocument()
  })

  it("disables the Log out button when no handler is provided", async () => {
    render(
      <UserSettingsDialog
        open
        onOpenChange={() => {}}
        account={{ displayName: "Yarin", username: "yarin" }}
      />
    )

    const u = userEvent.setup()
    await u.click(screen.getAllByText(/log out/i)[0])

    const triggerBtn = screen
      .getAllByRole("button", { name: /log out/i })
      .find((b) => b.classList.contains("bg-destructive"))
    expect(triggerBtn).toBeDefined()
    expect(triggerBtn).toBeDisabled()
  })
})
