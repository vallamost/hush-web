export type ThemePreference = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

export interface AppearancePreferences {
  theme: ThemePreference
  glassEnabled: boolean
  glassOpacity: number
  glassTransparency: number
}

export const APPEARANCE_STORAGE_KEY = "hush_appearance_preferences_v1"

const LEGACY_THEME_MODE_KEY = "hush_theme_mode"
export const GLASS_CONTROL_MIN = 0
export const GLASS_CONTROL_MAX = 100
export const GLASS_CONTROL_STEP = 1
export const GLASS_CONTROL_MAGNET_POINTS = [0, 25, 50, 75, 100] as const

const GLASS_TINT_CSS_MIN = 20
const GLASS_TINT_CSS_MAX = 80
const GLASS_MAX_SURFACE_ALPHA = 80
const GLASS_CONTROL_DEFAULT_OPACITY = 60
const GLASS_CONTROL_DEFAULT_TRANSPARENCY = 50
const GLASS_MAGNET_THRESHOLD = 1

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  theme: "system",
  glassEnabled: true,
  glassOpacity: GLASS_CONTROL_DEFAULT_OPACITY,
  glassTransparency: GLASS_CONTROL_DEFAULT_TRANSPARENCY,
}

const THEME_VALUES = new Set<ThemePreference>(["system", "light", "dark"])

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && THEME_VALUES.has(value as ThemePreference)
}

function clampGlassControl(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(GLASS_CONTROL_MAX, Math.max(GLASS_CONTROL_MIN, Math.round(value)))
}

export function snapGlassControlValue(value: number): number {
  const clamped = clampGlassControl(value, GLASS_CONTROL_DEFAULT_OPACITY)
  const nearest = GLASS_CONTROL_MAGNET_POINTS.reduce((best, point) => {
    return Math.abs(point - clamped) < Math.abs(best - clamped) ? point : best
  }, GLASS_CONTROL_MAGNET_POINTS[0])

  return Math.abs(nearest - clamped) <= GLASS_MAGNET_THRESHOLD
    ? nearest
    : clamped
}

export function mapGlassControlToCssPercent(value: number): number {
  const clamped = clampGlassControl(value, GLASS_CONTROL_DEFAULT_OPACITY)
  const ratio = clamped / GLASS_CONTROL_MAX
  return (
    GLASS_TINT_CSS_MIN +
    Math.round((GLASS_TINT_CSS_MAX - GLASS_TINT_CSS_MIN) * ratio)
  )
}

export function mapGlassTransparencyToSurfaceAlpha(value: number): number {
  const clamped = clampGlassControl(value, GLASS_CONTROL_DEFAULT_TRANSPARENCY)
  const transparencyRatio = clamped / GLASS_CONTROL_MAX
  return Math.round(GLASS_MAX_SURFACE_ALPHA * (1 - transparencyRatio))
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
    glassOpacity: clampGlassControl(
      value?.glassOpacity,
      DEFAULT_APPEARANCE_PREFERENCES.glassOpacity
    ),
    glassTransparency: clampGlassControl(
      value?.glassTransparency,
      DEFAULT_APPEARANCE_PREFERENCES.glassTransparency
    ),
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
  const tintStrength = mapGlassControlToCssPercent(normalized.glassOpacity)
  const surfaceAlpha = mapGlassTransparencyToSurfaceAlpha(
    normalized.glassTransparency
  )
  root.style.setProperty("--desktop-glass-opacity", `${tintStrength}%`)
  root.style.setProperty("--desktop-glass-tint-strength", `${tintStrength}%`)
  root.style.setProperty(
    "--desktop-glass-transparency",
    `${normalized.glassTransparency}%`
  )
  root.style.setProperty("--desktop-glass-alpha", `${surfaceAlpha}%`)
}

export function applyStoredAppearancePreferences(): AppearancePreferences {
  const preferences = readAppearancePreferences()
  applyAppearancePreferences(preferences)
  return preferences
}
