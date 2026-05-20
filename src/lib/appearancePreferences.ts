export type ThemePreference = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

/**
 * Native window material identifiers shared with the desktop main process.
 *
 * macOS values map to `NSVisualEffectView` materials supported by Electron
 * via the BrowserWindow `vibrancy` option / `setVibrancy()` API. Only a
 * conservative subset of vibrancies is exposed because the chrome must
 * remain legible on every active vibrancy at the bound intensity range.
 *
 * Windows 11 values map to `backgroundMaterial` / `setBackgroundMaterial()`.
 * `acrylic` and `mica` are the supported analogues; `tabbed` is excluded
 * because the renderer does not draw tab strip seams.
 *
 * Linux has no native material API, so it is always reported as `none` and
 * the picker is rendered disabled in the UI.
 */
export const MACOS_GLASS_MATERIALS = [
  "sidebar",
  "under-window",
  "menu",
  "headerView",
] as const
export const WIN32_GLASS_MATERIALS = ["mica", "acrylic"] as const

export type MacosGlassMaterial = (typeof MACOS_GLASS_MATERIALS)[number]
export type Win32GlassMaterial = (typeof WIN32_GLASS_MATERIALS)[number]
export type GlassMaterial = MacosGlassMaterial | Win32GlassMaterial | "auto"

export interface AppearancePreferences {
  theme: ThemePreference
  glassEnabled: boolean
  /**
   * Single user-facing strength control. `0` keeps the chrome maximally
   * legible (close to opaque tint, minimal show-through); `100` lets the
   * most native material bleed through while still preserving a safe
   * floor so server-rail / channel-sidebar / topbar text stays readable.
   */
  glassIntensity: number
  /**
   * Native window material identifier the renderer asks the desktop main
   * process to apply. Defaulted to `"auto"` so the main process keeps
   * shipping its conservative platform pick (menu on macOS, mica on
   * Win11) unless a legacy persisted preference says otherwise.
   */
  glassMaterial: GlassMaterial
}

export const APPEARANCE_STORAGE_KEY = "hush_appearance_preferences_v1"

const LEGACY_THEME_MODE_KEY = "hush_theme_mode"
export const GLASS_INTENSITY_MIN = 0
export const GLASS_INTENSITY_MAX = 100
export const GLASS_INTENSITY_STEP = 1
export const GLASS_INTENSITY_MAGNET_POINTS = [0, 25, 50, 75, 100] as const

/**
 * Safe surface alpha range the intensity slider maps into. Even at the
 * maximum the chrome retains a 35% tinted surface over the native
 * material so channel names, user-menu text, and topbar controls do not
 * dissolve into the desktop wallpaper. At the minimum the surface is
 * 85% opaque, keeping the legacy "almost opaque" look.
 */
const GLASS_SAFE_ALPHA_MIN_PERCENT = 35
const GLASS_SAFE_ALPHA_MAX_PERCENT = 85
/**
 * Tint strength controls how much of the sidebar token bleeds into the
 * background mix before the alpha is applied. Bounded so the tint never
 * collapses to pure background (which would erase the surface) and never
 * saturates to pure sidebar (which would look like the opaque pre-glass
 * shell).
 */
const GLASS_TINT_MIN_PERCENT = 35
const GLASS_TINT_MAX_PERCENT = 75
/**
 * First-install intensity. Aligns with the second magnet point of
 * `GLASS_INTENSITY_MAGNET_POINTS` so a fresh install opens with the
 * subtle "barely-glassed" look the product team picked. Existing users
 * keep whatever value their `hush_appearance_preferences_v1` payload
 * already carries.
 */
const GLASS_INTENSITY_DEFAULT = 25
const GLASS_MAGNET_THRESHOLD = 1

export const GLASS_DEFAULT_MATERIAL: GlassMaterial = "auto"

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  theme: "dark",
  glassEnabled: true,
  glassIntensity: GLASS_INTENSITY_DEFAULT,
  glassMaterial: GLASS_DEFAULT_MATERIAL,
}

const THEME_VALUES = new Set<ThemePreference>(["system", "light", "dark"])
const VALID_MATERIALS = new Set<GlassMaterial>([
  "auto",
  ...MACOS_GLASS_MATERIALS,
  ...WIN32_GLASS_MATERIALS,
])

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && THEME_VALUES.has(value as ThemePreference)
}

function isGlassMaterial(value: unknown): value is GlassMaterial {
  return typeof value === "string" && VALID_MATERIALS.has(value as GlassMaterial)
}

function clampIntensity(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(
    GLASS_INTENSITY_MAX,
    Math.max(GLASS_INTENSITY_MIN, Math.round(value))
  )
}

export function snapGlassIntensity(value: number): number {
  const clamped = clampIntensity(value, GLASS_INTENSITY_DEFAULT)
  const nearest = GLASS_INTENSITY_MAGNET_POINTS.reduce((best, point) => {
    return Math.abs(point - clamped) < Math.abs(best - clamped) ? point : best
  }, GLASS_INTENSITY_MAGNET_POINTS[0])

  return Math.abs(nearest - clamped) <= GLASS_MAGNET_THRESHOLD
    ? nearest
    : clamped
}

/**
 * Maps the user-facing 0..100 intensity to the safe sidebar tint strength
 * used in the CSS `color-mix` of the chrome. Higher intensity = thinner
 * tint over the native material (more wallpaper bleed); lower intensity =
 * stronger tint (more like the opaque legacy chrome).
 */
export function mapGlassIntensityToTintPercent(value: number): number {
  const clamped = clampIntensity(value, GLASS_INTENSITY_DEFAULT)
  const ratio = clamped / GLASS_INTENSITY_MAX
  return Math.round(
    GLASS_TINT_MAX_PERCENT -
      (GLASS_TINT_MAX_PERCENT - GLASS_TINT_MIN_PERCENT) * ratio
  )
}

/**
 * Maps the user-facing 0..100 intensity to the surface alpha applied
 * over the native window material. The range is bounded by a safe floor
 * so the chrome stays legible at the maximum value.
 */
export function mapGlassIntensityToSurfaceAlpha(value: number): number {
  const clamped = clampIntensity(value, GLASS_INTENSITY_DEFAULT)
  const ratio = clamped / GLASS_INTENSITY_MAX
  return Math.round(
    GLASS_SAFE_ALPHA_MAX_PERCENT -
      (GLASS_SAFE_ALPHA_MAX_PERCENT - GLASS_SAFE_ALPHA_MIN_PERCENT) * ratio
  )
}

interface LegacyAppearanceShape {
  theme?: ThemePreference
  glassEnabled?: boolean
  glassOpacity?: number
  glassTransparency?: number
  glassIntensity?: number
  glassMaterial?: GlassMaterial
}

/**
 * Pre-Intensity preferences exposed `glassOpacity` (tint strength, 0..100,
 * default 60) and `glassTransparency` (surface alpha, 0..100, default 50).
 * Translate them into the new single-knob model so users do not lose their
 * pick on upgrade.
 *
 * The mapping favours readability: legacy users who pushed transparency
 * high are clamped into the new safe envelope rather than left with the
 * old illegible chrome.
 */
function migrateLegacyGlassControls(
  value: LegacyAppearanceShape
): number | null {
  if (typeof value.glassIntensity === "number") return null
  const hasLegacy =
    typeof value.glassOpacity === "number" ||
    typeof value.glassTransparency === "number"
  if (!hasLegacy) return null
  const transparency =
    typeof value.glassTransparency === "number"
      ? clampIntensity(value.glassTransparency, GLASS_INTENSITY_DEFAULT)
      : GLASS_INTENSITY_DEFAULT
  // Legacy transparency was the dominant show-through knob; map it
  // straight onto intensity. Legacy tint is dropped because the new model
  // owns both tint and alpha from a single value.
  return transparency
}

export function normalizeAppearancePreferences(
  value: Partial<AppearancePreferences> | LegacyAppearanceShape | null | undefined
): AppearancePreferences {
  const legacyIntensity = value
    ? migrateLegacyGlassControls(value as LegacyAppearanceShape)
    : null
  const intensitySource =
    legacyIntensity ??
    (value && "glassIntensity" in value
      ? (value as AppearancePreferences).glassIntensity
      : DEFAULT_APPEARANCE_PREFERENCES.glassIntensity)
  return {
    theme: isThemePreference(value?.theme)
      ? value.theme
      : DEFAULT_APPEARANCE_PREFERENCES.theme,
    glassEnabled:
      typeof value?.glassEnabled === "boolean"
        ? value.glassEnabled
        : DEFAULT_APPEARANCE_PREFERENCES.glassEnabled,
    glassIntensity: clampIntensity(
      intensitySource,
      DEFAULT_APPEARANCE_PREFERENCES.glassIntensity
    ),
    glassMaterial: isGlassMaterial((value as { glassMaterial?: unknown })?.glassMaterial)
      ? (value as { glassMaterial: GlassMaterial }).glassMaterial
      : DEFAULT_APPEARANCE_PREFERENCES.glassMaterial,
  }
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
  const tintStrength = mapGlassIntensityToTintPercent(normalized.glassIntensity)
  const surfaceAlpha = mapGlassIntensityToSurfaceAlpha(normalized.glassIntensity)
  root.style.setProperty("--desktop-glass-tint-strength", `${tintStrength}%`)
  root.style.setProperty("--desktop-glass-alpha", `${surfaceAlpha}%`)
}

export function applyStoredAppearancePreferences(): AppearancePreferences {
  const preferences = readAppearancePreferences()
  applyAppearancePreferences(preferences)
  return preferences
}

/**
 * Local mirror of the subset of `NodeJS.Platform` we care about. Kept
 * here so the renderer does not need to pull `@types/node` into the
 * web build only for a single string union.
 */
export type DesktopPlatform = "darwin" | "win32" | "linux" | (string & {})

export type GlassUnsupportedReason =
  | "linux-no-native-material"
  | "win32-pre-22h2"
  | "win32-unparseable-release"

/**
 * Renderer mirror of the desktop `GlassCapabilities` payload. Computed
 * by the main process and fetched once at mount via the preload bridge
 * (`getGlassCapabilities`). Browser builds do not have access to a
 * desktop bridge and therefore receive the synthetic `NO_GLASS_SUPPORT`
 * fallback returned by {@link buildBrowserGlassCapabilities}.
 */
export interface GlassCapabilities {
  readonly platform: DesktopPlatform
  readonly materialSwitchingSupported: boolean
  readonly materials: readonly GlassMaterial[]
  readonly unsupportedReason: GlassUnsupportedReason | null
}

/**
 * Capability payload used when no desktop bridge is reachable. Materials
 * are empty because browser builds cannot apply a native window
 * material; the renderer still treats the Intensity slider as fully
 * functional because it only drives CSS.
 */
export const NO_GLASS_SUPPORT: GlassCapabilities = {
  platform: "web",
  materialSwitchingSupported: false,
  materials: [],
  unsupportedReason: null,
}

/**
 * Normalizes a stored or user-provided material against the host
 * capability set. Stale cross-platform values (e.g. `mica` loaded on
 * macOS after a profile sync) collapse to `auto` so the IPC layer never
 * receives a material the host cannot honour. The Material UI is hidden
 * today, but old persisted preferences can still exist.
 */
export function normalizeGlassMaterialForCapabilities(
  material: GlassMaterial,
  capabilities: GlassCapabilities | null
): GlassMaterial {
  if (!capabilities || !capabilities.materialSwitchingSupported) return "auto"
  return capabilities.materials.includes(material) ? material : "auto"
}
