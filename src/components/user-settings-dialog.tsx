import * as React from "react"
import {
  BellIcon,
  CircleUserIcon,
  KeyboardIcon,
  LanguagesIcon,
  LockIcon,
  LogOutIcon,
  MicIcon,
  MonitorSmartphoneIcon,
  PaletteIcon,
  PlugZapIcon,
  ShieldIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react"

import { Separator } from "@/components/ui/separator.tsx"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from "@/components/ui/field"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ConfirmAction } from "@/components/confirm-action"
import { UsernameHandle } from "@/components/identity/username-handle"
import {
  SettingsDialog,
  type SettingsGroup,
  type SettingsSection,
} from "@/components/settings-dialog"
import { useAuth } from "@/contexts/AuthContext"
import { getVaultConfig } from "@/lib/identityVault"
import { DevicesPanel } from "@/components/settings/devices-panel"
import {
  VoiceVideoPanel,
  type VoiceRuntime,
} from "@/components/settings/voice-video-panel"
import {
  useAppearancePreferences,
  type ThemePreference,
} from "@/components/theme-provider"
import { formatUserLabel, sanitizeDisplayName } from "@/lib/userLabel"

interface UserAccountInfo {
  displayName: string
  username: string
}

interface UserSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account?: UserAccountInfo
  onSignOut?: () => void | Promise<void>
  /**
   * URL of the auth (home) instance — the one that issued the JWT and
   * stores the user's device list. Distinct from the currently-selected
   * server's instance, which may be a federated peer.
   */
  homeInstanceUrl?: string | null
  /** Hex transparency log public key for the home instance. */
  homeLogPublicKey?: string | null
  /** Active voice runtime surface — null when the user is not joined
   *  to any voice channel. Lets the Voice & Video panel temporarily
   *  isolate the mic test from the live room and push filter changes
   *  into the published capture graph. */
  voiceRuntime?: VoiceRuntime | null
  /** Instance origin used to scope persisted voice device preferences. */
  voicePrefsScope?: string | null
}

export function UserSettingsDialog({
  open,
  onOpenChange,
  account,
  onSignOut,
  homeInstanceUrl,
  homeLogPublicKey,
  voiceRuntime,
  voicePrefsScope,
}: UserSettingsDialogProps) {
  // Keep unfinished surfaces visible but disabled so the settings map
  // stays recognizable while only wired panels are reachable.
  const groups: SettingsGroup[] = [
    { id: "account", label: "Account" },
    { id: "app", label: "App settings" },
    { id: "session", label: "Session" },
  ]

  const sections: SettingsSection[] = [
    {
      id: "account",
      groupId: "account",
      label: "My account",
      icon: <UserIcon />,
      content: <AccountPanel account={account} />,
    },
    {
      id: "profile",
      groupId: "account",
      label: "Profile",
      icon: <CircleUserIcon />,
      disabled: true,
      content: <PlaceholderPanel title="Profile" />,
    },
    {
      id: "privacy",
      groupId: "account",
      label: "Privacy & safety",
      icon: <ShieldIcon />,
      disabled: true,
      content: <PlaceholderPanel title="Privacy & safety" />,
    },
    {
      id: "security",
      groupId: "account",
      label: "Security",
      icon: <LockIcon />,
      content: <SecurityPanel />,
    },
    {
      id: "devices",
      groupId: "account",
      label: "Devices",
      icon: <MonitorSmartphoneIcon />,
      content: (
        <DevicesPanel
          homeInstanceUrl={homeInstanceUrl}
          homeLogPublicKey={homeLogPublicKey}
          onRequestClose={() => onOpenChange(false)}
        />
      ),
    },
    {
      id: "appearance",
      groupId: "app",
      label: "Appearance",
      icon: <PaletteIcon />,
      content: <AppearancePanel />,
    },
    {
      id: "voice",
      groupId: "app",
      label: "Voice & video",
      icon: <MicIcon />,
      content: (
        <VoiceVideoPanel
          voiceRuntime={voiceRuntime ?? null}
          prefsScope={voicePrefsScope ?? null}
        />
      ),
    },
    {
      id: "notifications",
      groupId: "app",
      label: "Notifications",
      icon: <BellIcon />,
      disabled: true,
      content: <PlaceholderPanel title="Notifications" />,
    },
    {
      id: "keybinds",
      groupId: "app",
      label: "Keybinds",
      icon: <KeyboardIcon />,
      disabled: true,
      content: <PlaceholderPanel title="Keybinds" />,
    },
    {
      id: "language",
      groupId: "app",
      label: "Language",
      icon: <LanguagesIcon />,
      disabled: true,
      content: <PlaceholderPanel title="Language" />,
    },
    {
      id: "integrations",
      groupId: "app",
      label: "Integrations",
      icon: <PlugZapIcon />,
      disabled: true,
      content: <PlaceholderPanel title="Integrations" />,
    },
    {
      id: "advanced",
      groupId: "app",
      label: "Advanced",
      icon: <WrenchIcon />,
      disabled: true,
      content: <PlaceholderPanel title="Advanced" />,
    },
    {
      id: "logout",
      groupId: "session",
      label: "Log out",
      icon: <LogOutIcon />,
      destructive: true,
      content: <LogoutPanel onSignOut={onSignOut} />,
    },
  ]

  return (
    <SettingsDialog
      open={open}
      onOpenChange={onOpenChange}
      title="User settings"
      description="Manage your account and app preferences"
      sections={sections}
      groups={groups}
      defaultSectionId="account"
    />
  )
}

function LogoutPanel({
  onSignOut,
}: {
  onSignOut?: () => void | Promise<void>
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Log out</h2>
        <p className="text-sm text-muted-foreground">
          End your session on this device. Active voice calls will disconnect.
        </p>
      </div>
      <Separator />
      <div className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Sign out</span>
          <span className="text-xs text-muted-foreground">
            You can sign back in any time with your recovery phrase.
          </span>
        </div>
        <ConfirmAction
          title="Log out?"
          description="You will be signed out on this device. Active voice calls will disconnect."
          confirmLabel="Log out"
          onConfirm={() => {
            void onSignOut?.()
          }}
          trigger={
            <button
              type="button"
              disabled={!onSignOut}
              className="shrink-0 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Log out
            </button>
          }
        />
      </div>
    </div>
  )
}

// Vault timeout policy — controls when the in-memory identity-vault
// wrapping key (PIN/passphrase-derived) is wiped, forcing the user to
// re-authenticate. The MLS group keys are downstream of this: locking
// the vault drops the wrapping key, which makes the encrypted at-rest
// vault blob unusable until the next unlock. Values mirror the shape
// `useAuth.updateVaultTimeout` accepts; the labels match what the
// legacy UserSettingsModal exposed so returning users see the same
// choices.
type VaultTimeoutValue =
  | "browser_close"
  | "refresh"
  | "1m"
  | "15m"
  | "30m"
  | "1h"
  | "4h"
  | "never"

const VAULT_TIMEOUT_OPTIONS: { value: VaultTimeoutValue; label: string }[] = [
  { value: "browser_close", label: "On browser close" },
  { value: "refresh", label: "On refresh" },
  { value: "1m", label: "1 minute" },
  { value: "15m", label: "15 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
  { value: "never", label: "Never" },
]

const LEGACY_VAULT_TIMEOUT_KEY = "hush_vault_timeout"

const THEME_TABS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

const GLASS_OPACITY_MIN = 40
const GLASS_OPACITY_MAX = 100
const GLASS_OPACITY_STEP = 5

function formatVaultTimeoutValue(
  timeout: string | number | null | undefined
): VaultTimeoutValue {
  if (typeof timeout === "number") {
    if (timeout === 60) return "1h"
    if (timeout === 240) return "4h"
    if (timeout === 1) return "1m"
    if (timeout === 15) return "15m"
    if (timeout === 30) return "30m"
    return "browser_close"
  }
  if (
    timeout === "browser_close" ||
    timeout === "refresh" ||
    timeout === "never"
  ) {
    return timeout
  }
  return "browser_close"
}

function parseVaultTimeoutValue(
  value: VaultTimeoutValue
): "browser_close" | "refresh" | "never" | number {
  switch (value) {
    case "browser_close":
    case "refresh":
    case "never":
      return value
    case "1m":
      return 1
    case "15m":
      return 15
    case "30m":
      return 30
    case "1h":
      return 60
    case "4h":
      return 240
  }
}

function AppearancePanel() {
  const {
    theme,
    glassEnabled,
    glassOpacity,
    setTheme,
    setGlassEnabled,
    setGlassOpacity,
  } = useAppearancePreferences()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Appearance</h2>
        <p className="text-sm text-muted-foreground">
          Control the app theme and desktop window material.
        </p>
      </div>

      <Separator />

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Theme
        </h3>
        <div className="rounded-lg border bg-card p-4">
          <FieldGroup>
            <Field>
              <FieldContent>
                <FieldTitle>Color mode</FieldTitle>
                <FieldDescription>
                  System follows the current operating system preference.
                </FieldDescription>
              </FieldContent>
              <Tabs
                value={theme}
                onValueChange={(value) => setTheme(value as ThemePreference)}
                className="w-full"
              >
                <TabsList className="grid w-full grid-cols-3">
                  {THEME_TABS.map((item) => (
                    <TabsTrigger key={item.value} value={item.value}>
                      {item.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </Field>
          </FieldGroup>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Desktop glass
        </h3>
        <div className="rounded-lg border bg-card p-4">
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>Glass effect</FieldTitle>
                <FieldDescription>
                  Use the native desktop material behind the server rail,
                  channel list, and top bar.
                </FieldDescription>
              </FieldContent>
              <Switch
                aria-label="Enable glass effect"
                checked={glassEnabled}
                onCheckedChange={setGlassEnabled}
              />
            </Field>

            <Field data-disabled={!glassEnabled ? true : undefined}>
              <FieldContent>
                <div className="flex items-center justify-between gap-3">
                  <FieldTitle>Opacity</FieldTitle>
                  <span className="text-xs text-muted-foreground">
                    {glassOpacity}%
                  </span>
                </div>
                <FieldDescription>
                  Higher values make the chrome more solid. Lower values reveal
                  more of the native desktop material.
                </FieldDescription>
              </FieldContent>
              <Slider
                aria-label="Glass opacity"
                disabled={!glassEnabled}
                min={GLASS_OPACITY_MIN}
                max={GLASS_OPACITY_MAX}
                step={GLASS_OPACITY_STEP}
                value={[glassOpacity]}
                onValueChange={(value) => {
                  const next = value[0]
                  if (typeof next === "number") {
                    setGlassOpacity(next)
                  }
                }}
              />
            </Field>
          </FieldGroup>
        </div>
      </section>
    </div>
  )
}

function readStoredVaultTimeout(userId: string | undefined): VaultTimeoutValue {
  const config = userId ? getVaultConfig(userId) : null
  if (config?.timeout !== undefined && config.timeout !== null) {
    return formatVaultTimeoutValue(config.timeout)
  }
  return formatVaultTimeoutValue(
    localStorage.getItem(LEGACY_VAULT_TIMEOUT_KEY)
  )
}

function SecurityPanel() {
  const { user, updateVaultTimeout } = useAuth() as {
    user: { id?: string } | null
    updateVaultTimeout?: (
      timeout: "browser_close" | "refresh" | "never" | number
    ) => void
  }
  const userId = user?.id
  const [vaultTimeout, setVaultTimeout] = React.useState<VaultTimeoutValue>(
    () => readStoredVaultTimeout(userId)
  )

  // Refresh when the active user changes (account switch within a session).
  React.useEffect(() => {
    setVaultTimeout(readStoredVaultTimeout(userId))
  }, [userId])

  const handleChange = (next: string) => {
    const value = next as VaultTimeoutValue
    setVaultTimeout(value)
    if (typeof updateVaultTimeout === "function") {
      updateVaultTimeout(parseVaultTimeoutValue(value))
      return
    }
    localStorage.setItem(LEGACY_VAULT_TIMEOUT_KEY, value)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Security</h2>
        <p className="text-sm text-muted-foreground">
          Control how long your unlocked vault survives across reloads
          and tab closes before requiring your PIN or passphrase again.
        </p>
      </div>

      <Separator />

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Vault
        </h3>
        <div className="rounded-lg border bg-card">
          <div className="flex flex-col gap-3 px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Vault timeout</span>
              <span className="text-xs text-muted-foreground">
                When the vault locks and requires re-entry.
              </span>
            </div>
            <Select value={vaultTimeout} onValueChange={handleChange}>
              <SelectTrigger
                aria-label="Vault timeout"
                className="w-full sm:w-72"
              >
                <SelectValue placeholder="Select timeout" />
              </SelectTrigger>
              <SelectContent>
                {VAULT_TIMEOUT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              {describeVaultTimeoutPolicy(vaultTimeout)}
            </span>
            {vaultTimeout === "never" ? (
              <span className="text-xs text-destructive">
                A non-extractable wrapping key stays on this device until
                you sign out, lock the vault, or change your PIN.
              </span>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  )
}

/**
 * Per-policy guarantee copy for the Vault timeout select. Phrased as
 * positive promises ("survives X, locks on Y") rather than "drops on
 * Z" so a returning user can read what the picked option actually
 * delivers without having to mentally invert.
 */
function describeVaultTimeoutPolicy(value: VaultTimeoutValue): string {
  switch (value) {
    case "never":
      return "Survives reloads, tab closes, and mobile background. Locks only on sign out, manual lock, or PIN change."
    case "browser_close":
      return "Survives soft refresh in the same tab. Locks when the last tab of this account closes."
    case "refresh":
      return "Locks on every reload — re-enter your PIN each time the page refreshes."
    case "1m":
    case "15m":
    case "30m":
    case "1h":
    case "4h": {
      const label = VAULT_TIMEOUT_OPTIONS.find((o) => o.value === value)?.label
      return `Locks after ${label?.toLowerCase() ?? "the configured idle time"} of inactivity. Survives reloads while inside the deadline.`
    }
    default:
      return ""
  }
}

function PlaceholderPanel({ title }: { title: string }) {
  // Body-shape parity with the prototype so the panel looks like
  // real shipping content rather than an empty area. Backend-blocked
  // panels swap in real controls section-by-section as endpoints land.
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">
          Shipping soon. Controls land when the backend exposes them.
        </p>
      </div>
      <Separator />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="aspect-video rounded-lg bg-muted/50"
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  )
}

function AccountPanel({ account }: { account?: UserAccountInfo }) {
  const displayName = sanitizeDisplayName(
    account?.displayName,
    account?.username
  ) || "Not set"
  const username = formatUserLabel({ username: account?.username, fallback: "" })
  // TODO(yarin, 2026-05-04): backend lacks email/phone/password endpoints
  // — identity is currently mnemonic-derived. Edit actions deferred until
  // profile-update API lands.
  const fields: { label: string; value: React.ReactNode }[] = [
    { label: "Display name", value: displayName },
    {
      label: "Username",
      value: (
        <UsernameHandle
          username={username}
          className="text-sm"
          fallback={<span>Not set</span>}
        />
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">My account</h2>
        <p className="text-sm text-muted-foreground">
          Identity is derived from your recovery phrase. Profile editing
          requires backend support. Shipping soon.
        </p>
      </div>

      <Separator />

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Identity
        </h3>
        <div className="rounded-lg border bg-card">
          {fields.map((field, idx) => (
            <div
              key={field.label}
              className={
                "flex items-center justify-between gap-4 px-4 py-3 " +
                (idx < fields.length - 1 ? "border-b" : "")
              }
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {field.label}
                </span>
                <span className="text-sm">{field.value}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
