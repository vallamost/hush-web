export type ThemePreference = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

export interface AppearancePreferences {
  theme: ThemePreference
  glassEnabled: boolean
  glassOpacity: number
}

export const APPEARANCE_STORAGE_KEY = "hush_appearance_preferences_v1"

const LEGACY_THEME_MODE_KEY = "hush_theme_mode"
const MIN_GLASS_OPACITY = 40
const MAX_GLASS_OPACITY = 100
const DEFAULT_GLASS_OPACITY = 60

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  theme: "system",
  glassEnabled: true,
  glassOpacity: DEFAULT_GLASS_OPACITY,
}

const THEME_VALUES = new Set<ThemePreference>(["system", "light", "dark"])

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && THEME_VALUES.has(value as ThemePreference)
}

function clampGlassOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GLASS_OPACITY
  }
  return Math.min(MAX_GLASS_OPACITY, Math.max(MIN_GLASS_OPACITY, Math.round(value)))
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark"
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function resolveThemePreference(theme: ThemePreference): ResolvedTheme {
  return theme === "system" ? getSystemTheme() : theme
}

export function normalizeAppearancePreferences(
  value: Partial<AppearancePreferences> | null | undefined
): AppearancePreferences {
  return {
    theme: isThemePreference(value?.theme)
      ? value.theme
      : DEFAULT_APPEARANCE_PREFERENCES.theme,
    glassEnabled:
      typeof value?.glassEnabled === "boolean"
        ? value.glassEnabled
        : DEFAULT_APPEARANCE_PREFERENCES.glassEnabled,
    glassOpacity: clampGlassOpacity(value?.glassOpacity),
  }
}

function readLegacyThemePreference(storage: Storage): ThemePreference | null {
  const legacyTheme = storage.getItem(LEGACY_THEME_MODE_KEY)
  return isThemePreference(legacyTheme) ? legacyTheme : null
}

export function readAppearancePreferences(): AppearancePreferences {
  const storage = getLocalStorage()
  if (!storage) {
    return DEFAULT_APPEARANCE_PREFERENCES
  }

  const stored = storage.getItem(APPEARANCE_STORAGE_KEY)
  if (stored) {
    try {
      return normalizeAppearancePreferences(JSON.parse(stored))
    } catch {
      return DEFAULT_APPEARANCE_PREFERENCES
    }
  }

  const legacyTheme = readLegacyThemePreference(storage)
  if (!legacyTheme) {
    return DEFAULT_APPEARANCE_PREFERENCES
  }

  return normalizeAppearancePreferences({
    ...DEFAULT_APPEARANCE_PREFERENCES,
    theme: legacyTheme,
  })
}

export function writeAppearancePreferences(preferences: AppearancePreferences): void {
  const storage = getLocalStorage()
  if (!storage) {
    return
  }
  storage.setItem(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify(normalizeAppearancePreferences(preferences))
  )
}

export function applyAppearancePreferences(
  preferences: AppearancePreferences,
  root: HTMLElement | null = typeof document === "undefined"
    ? null
    : document.documentElement
): void {
  if (!root) {
    return
  }

  const normalized = normalizeAppearancePreferences(preferences)
  const resolvedTheme = resolveThemePreference(normalized.theme)

  root.dataset.theme = resolvedTheme
  root.classList.remove("light", "dark")
  root.classList.add(resolvedTheme)
  root.dataset.glass = normalized.glassEnabled ? "on" : "off"
  root.style.setProperty("--desktop-glass-opacity", `${normalized.glassOpacity}%`)
}

export function applyStoredAppearancePreferences(): AppearancePreferences {
  const preferences = readAppearancePreferences()
  applyAppearancePreferences(preferences)
  return preferences
}
