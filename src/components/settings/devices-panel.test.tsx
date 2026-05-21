/**
 * DevicesPanel coverage:
 *  - empty + populated list rendering
 *  - "This device" badge resolves via getDeviceId()
 *  - CTA navigates to /link-device (NOT /link-device?mode=new — this
 *    panel runs on an already-authenticated device approving a peer)
 *  - revoke confirm dialog triggers revokeDeviceKey + post-op
 *    transparency reverify when home log public key is provided
 *  - revoke without home log key still succeeds; transparency verify
 *    is skipped (logged) rather than throwing
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest"
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

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

const navigateMock = vi.fn()
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}))

const listDeviceKeys = vi.fn()
const revokeDeviceKey = vi.fn()
vi.mock("@/lib/api", () => ({
  listDeviceKeys: (...args: unknown[]) => listDeviceKeys(...args),
  revokeDeviceKey: (...args: unknown[]) => revokeDeviceKey(...args),
}))

const getDeviceId = vi.fn(() => "device-current")
const getInstanceToken = vi.fn<(url: string) => string | null>(() => null)
vi.mock("@/hooks/useAuth", () => ({
  getDeviceId: () => getDeviceId(),
  getInstanceToken: (url: string) => getInstanceToken(url),
}))

const setTransparencyError = vi.fn()
const identityKeyRef = { current: { publicKey: new Uint8Array([1, 2, 3]) } }
const authState: { token: string | null } = { token: "tok" }
const getReadableDeviceLabel = vi.fn(() => "Chrome on macOS")
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    token: authState.token,
    identityKeyRef,
    setTransparencyError,
  }),
}))

vi.mock("@/lib/deviceLabel", () => ({
  getReadableDeviceLabel: () => getReadableDeviceLabel(),
}))

vi.mock("@/lib/identityVault", () => ({
  bytesToHex: () => "deadbeef",
}))

const verifyOwnKey = vi.fn().mockResolvedValue({ ok: true })
vi.mock("@/lib/transparencyVerifier", () => ({
  TransparencyVerifier: function MockVerifier() {
    return { verifyOwnKey }
  },
}))

// ApproveDeviceLinkFlow has its own dedicated test suite. Stub it
// here so the view-switch coverage in this file does not pull in
// MLS / archive / scanner machinery and so we can assert
// onCancel / onSuccess are wired correctly from DevicesPanel.
vi.mock("@/components/devices/ApproveDeviceLinkFlow.jsx", () => ({
  default: ({ mode, onCancel, onSuccess, onVaultUnlockNeeded }: {
    mode: string
    onCancel: () => void
    onSuccess?: () => void
    onVaultUnlockNeeded: () => void
  }) => (
    <div data-testid="approve-flow-stub" data-mode={mode}>
      <button type="button" onClick={onCancel}>
        stub-cancel
      </button>
      <button type="button" onClick={() => onSuccess?.()}>
        stub-success
      </button>
      <button type="button" onClick={onVaultUnlockNeeded}>
        stub-unlock
      </button>
    </div>
  ),
}))

import { DevicesPanel } from "./devices-panel"

function renderPanel(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  )
}

describe("DevicesPanel", () => {
  beforeEach(() => {
    // Default: explicit homeInstanceUrl resolves to a namespaced token
    // matching the active token so existing assertions stay valid.
    // Cross-instance / missing-token cases override per test.
    getInstanceToken.mockReset()
    getInstanceToken.mockImplementation(() => "tok")
    listDeviceKeys.mockReset()
    revokeDeviceKey.mockReset()
    setTransparencyError.mockReset()
    verifyOwnKey.mockClear()
    verifyOwnKey.mockResolvedValue({ ok: true })
    getDeviceId.mockReturnValue("device-current")
    getReadableDeviceLabel.mockReturnValue("Chrome on macOS")
    authState.token = "tok"
  })

  afterEach(() => {
    cleanup()
    navigateMock.mockReset()
  })

  it("renders the legacy description copy verbatim", () => {
    listDeviceKeys.mockResolvedValueOnce([])

    renderPanel(<DevicesPanel />)

    expect(
      screen.getByText(/On the new device, open/i)
    ).toBeInTheDocument()
    expect(
      screen.getByText("Link to existing device")
    ).toBeInTheDocument()
  })

  it("shows an empty state when the API returns no devices", async () => {
    listDeviceKeys.mockResolvedValueOnce([])

    renderPanel(<DevicesPanel />)

    await waitFor(() =>
      expect(screen.getByText(/no devices registered/i)).toBeInTheDocument()
    )
  })

  it("lists devices and tags the current one with This device", async () => {
    listDeviceKeys.mockResolvedValueOnce([
      {
        id: "row-1",
        deviceId: "device-current",
        label: null,
        certifiedAt: "2026-01-01T00:00:00Z",
        lastSeen: new Date().toISOString(),
      },
      {
        id: "row-2",
        deviceId: "device-other",
        label: "iPhone",
        certifiedAt: "2026-02-01T00:00:00Z",
        lastSeen: new Date().toISOString(),
      },
    ])

    renderPanel(<DevicesPanel />)

    await waitFor(() =>
      expect(screen.getByText(/this device/i)).toBeInTheDocument()
    )
    expect(screen.getByText("Chrome on macOS")).toBeInTheDocument()
    expect(screen.getByText("iPhone")).toBeInTheDocument()
  })

  it("uses the local runtime label for the current device over a stale server label", async () => {
    getReadableDeviceLabel.mockReturnValue("Desktop on macOS")
    listDeviceKeys.mockResolvedValueOnce([
      {
        id: "row-1",
        deviceId: "device-current",
        label: "Chrome on macOS",
        certifiedAt: "2026-01-01T00:00:00Z",
        lastSeen: new Date().toISOString(),
      },
    ])

    renderPanel(<DevicesPanel />)

    await waitFor(() =>
      expect(screen.getByText(/this device/i)).toBeInTheDocument()
    )
    expect(screen.getByText("Desktop on macOS")).toBeInTheDocument()
    expect(screen.queryByText("Chrome on macOS")).not.toBeInTheDocument()
  })

  it("shows a short readable fallback for unlabeled non-current devices", async () => {
    listDeviceKeys.mockResolvedValueOnce([
      {
        id: "row-2",
        deviceId: "abcdef0123456789ffffffffffffffff",
        label: null,
        certifiedAt: "2026-02-01T00:00:00Z",
        lastSeen: new Date().toISOString(),
      },
    ])

    renderPanel(<DevicesPanel />)

    await waitFor(() =>
      expect(
        screen.getByText("Unknown device (abcdef01)")
      ).toBeInTheDocument()
    )
    // Full hash must not be on screen — that was the readability bug.
    expect(
      screen.queryByText("abcdef0123456789ffffffffffffffff")
    ).not.toBeInTheDocument()
  })

  it("CTA opens the embedded approve flow inside the panel", async () => {
    listDeviceKeys.mockResolvedValueOnce([])

    renderPanel(<DevicesPanel />)

    const u = userEvent.setup()
    await u.click(
      await screen.findByRole("button", { name: /link a new device/i })
    )

    // Stays in-modal: no router navigate, ApproveDeviceLinkFlow stub
    // mounts in embedded mode.
    expect(navigateMock).not.toHaveBeenCalled()
    const stub = await screen.findByTestId("approve-flow-stub")
    expect(stub.dataset.mode).toBe("embedded")
  })

  it("Back-to-devices returns to the list and refetches", async () => {
    listDeviceKeys
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "row-1",
          deviceId: "device-other",
          label: "iPhone",
          certifiedAt: "2026-02-01T00:00:00Z",
          lastSeen: new Date().toISOString(),
        },
      ])

    renderPanel(<DevicesPanel />)

    const u = userEvent.setup()
    await u.click(
      await screen.findByRole("button", { name: /link a new device/i })
    )
    await screen.findByTestId("approve-flow-stub")

    await u.click(
      screen.getByRole("button", { name: /back to devices/i })
    )

    // Stub gone, list rendered with the second listDeviceKeys result.
    expect(screen.queryByTestId("approve-flow-stub")).not.toBeInTheDocument()
    await screen.findByText("iPhone")
    expect(listDeviceKeys).toHaveBeenCalledTimes(2)
  })

  it("vault-locked Unlock closes the settings dialog and navigates to root", async () => {
    listDeviceKeys.mockResolvedValueOnce([])
    const onRequestClose = vi.fn()

    renderPanel(<DevicesPanel onRequestClose={onRequestClose} />)

    const u = userEvent.setup()
    await u.click(
      await screen.findByRole("button", { name: /link a new device/i })
    )
    await u.click(screen.getByRole("button", { name: /stub-unlock/i }))

    expect(onRequestClose).toHaveBeenCalledTimes(1)
    expect(navigateMock).toHaveBeenCalledWith("/")
  })

  it("revoke flow calls revokeDeviceKey + transparency verify", async () => {
    listDeviceKeys.mockResolvedValueOnce([
      {
        id: "row-1",
        deviceId: "device-other",
        label: "iPhone",
        certifiedAt: "2026-02-01T00:00:00Z",
        lastSeen: new Date().toISOString(),
      },
    ])
    listDeviceKeys.mockResolvedValueOnce([])
    revokeDeviceKey.mockResolvedValue(undefined)

    renderPanel(
      <DevicesPanel
        homeInstanceUrl="https://i.example.com"
        homeLogPublicKey="abcd"
      />
    )

    const u = userEvent.setup()
    const revokeBtn = await screen.findByRole("button", { name: /^revoke$/i })
    await u.click(revokeBtn)

    const dialog = await screen.findByRole("alertdialog")
    await u.click(
      within(dialog).getByRole("button", { name: /revoke device/i })
    )

    await waitFor(() =>
      expect(revokeDeviceKey).toHaveBeenCalledWith(
        "tok",
        "device-other",
        "https://i.example.com"
      )
    )
    expect(listDeviceKeys).toHaveBeenNthCalledWith(
      1,
      "tok",
      "https://i.example.com"
    )
    expect(verifyOwnKey).toHaveBeenCalledTimes(1)
    expect(setTransparencyError).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(listDeviceKeys).toHaveBeenCalledTimes(2)
    )
  })

  it("does not block transparency verify on the post-revoke device refresh", async () => {
    listDeviceKeys
      .mockResolvedValueOnce([
        {
          id: "row-1",
          deviceId: "device-other",
          label: "iPhone",
          certifiedAt: "2026-02-01T00:00:00Z",
          lastSeen: new Date().toISOString(),
        },
      ])
      .mockImplementationOnce(() => new Promise(() => {}))
    revokeDeviceKey.mockResolvedValue(undefined)

    renderPanel(
      <DevicesPanel
        homeInstanceUrl="https://i.example.com"
        homeLogPublicKey="abcd"
      />
    )

    const u = userEvent.setup()
    await u.click(await screen.findByRole("button", { name: /^revoke$/i }))

    const dialog = await screen.findByRole("alertdialog")
    await u.click(
      within(dialog).getByRole("button", { name: /revoke device/i })
    )

    await waitFor(() =>
      expect(revokeDeviceKey).toHaveBeenCalledWith(
        "tok",
        "device-other",
        "https://i.example.com"
      )
    )
    await waitFor(() => expect(verifyOwnKey).toHaveBeenCalledTimes(1))
    expect(listDeviceKeys).toHaveBeenCalledTimes(2)
  })

  it("skips transparency verify silently when no home log key is provided", async () => {
    listDeviceKeys.mockResolvedValueOnce([
      {
        id: "row-1",
        deviceId: "device-other",
        label: "iPhone",
        certifiedAt: "2026-02-01T00:00:00Z",
        lastSeen: new Date().toISOString(),
      },
    ])
    listDeviceKeys.mockResolvedValueOnce([])
    revokeDeviceKey.mockResolvedValue(undefined)

    renderPanel(<DevicesPanel />)

    const u = userEvent.setup()
    await u.click(await screen.findByRole("button", { name: /^revoke$/i }))

    const dialog = await screen.findByRole("alertdialog")
    await u.click(
      within(dialog).getByRole("button", { name: /revoke device/i })
    )

    await waitFor(() =>
      expect(revokeDeviceKey).toHaveBeenCalledTimes(1)
    )
    expect(revokeDeviceKey).toHaveBeenCalledWith(
      "tok",
      "device-other",
      ""
    )
    expect(verifyOwnKey).not.toHaveBeenCalled()
  })

  it("clears the loading state when token is unavailable", async () => {
    authState.token = null

    renderPanel(<DevicesPanel />)

    await waitFor(() =>
      expect(
        screen.queryByText(/loading devices/i)
      ).not.toBeInTheDocument()
    )
    expect(listDeviceKeys).not.toHaveBeenCalled()
  })

  it("listDeviceKeys uses the home-instance namespaced token, not the active token", async () => {
    // Active session is on a different (federated) instance; the home
    // instance has its own namespaced token. Devices panel calls
    // against `homeInstanceUrl` MUST use the home token.
    authState.token = "active-tok-foreign"
    getInstanceToken.mockImplementation((url: string) =>
      url === "https://home.example.com" ? "home-tok" : null
    )
    listDeviceKeys.mockResolvedValueOnce([])

    renderPanel(<DevicesPanel homeInstanceUrl="https://home.example.com" />)

    await waitFor(() =>
      expect(listDeviceKeys).toHaveBeenCalledWith(
        "home-tok",
        "https://home.example.com"
      )
    )
    expect(listDeviceKeys).not.toHaveBeenCalledWith(
      "active-tok-foreign",
      expect.anything()
    )
  })

  it("does NOT call listDeviceKeys when explicit homeInstanceUrl has no namespaced token", async () => {
    authState.token = "active-tok"
    getInstanceToken.mockImplementation(() => null)

    renderPanel(<DevicesPanel homeInstanceUrl="https://home.example.com" />)

    await waitFor(() =>
      expect(
        screen.queryByText(/loading devices/i)
      ).not.toBeInTheDocument()
    )
    expect(listDeviceKeys).not.toHaveBeenCalled()
  })
})
