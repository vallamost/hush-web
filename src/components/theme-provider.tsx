import * as React from "react"

import {
  APPEARANCE_STORAGE_KEY,
  applyAppearancePreferences,
  getSystemTheme,
  normalizeAppearancePreferences,
  readAppearancePreferences,
  writeAppearancePreferences,
  type AppearancePreferences,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/appearancePreferences"

type ThemeProviderProps = {
  children: React.ReactNode
  disableTransitionOnChange?: boolean
}

type ThemeProviderState = {
  preferences: AppearancePreferences
  theme: ThemePreference
  resolvedTheme: ResolvedTheme
  glassEnabled: boolean
  glassOpacity: number
  setTheme: (theme: ThemePreference) => void
  setGlassEnabled: (enabled: boolean) => void
  setGlassOpacity: (opacity: number) => void
  setPreferences: (
    next:
      | AppearancePreferences
      | ((current: AppearancePreferences) => AppearancePreferences)
  ) => void
}

const ThemeProviderContext = React.createContext<
  ThemeProviderState | undefined
>(undefined)

function disableTransitionsTemporarily() {
  const style = document.createElement("style")
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}"
    )
  )
  document.head.appendChild(style)

  return () => {
    window.getComputedStyle(document.body)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove()
      })
    })
  }
}

export function ThemeProvider({
  children,
  disableTransitionOnChange = false,
  ...props
}: ThemeProviderProps) {
  const [preferences, setPreferencesState] =
    React.useState<AppearancePreferences>(() => readAppearancePreferences())
  const [systemTheme, setSystemTheme] =
    React.useState<ResolvedTheme>(() => getSystemTheme())
  const hasAppliedPreferencesRef = React.useRef(false)

  const setPreferences = React.useCallback(
    (
      next:
        | AppearancePreferences
        | ((current: AppearancePreferences) => AppearancePreferences)
    ) => {
      setPreferencesState((current) => {
        const resolved =
          typeof next === "function" ? next(current) : next
        const normalized = normalizeAppearancePreferences(resolved)
        writeAppearancePreferences(normalized)
        return normalized
      })
    },
    []
  )

  const setTheme = React.useCallback(
    (theme: ThemePreference) => {
      setPreferences((current) => ({ ...current, theme }))
    },
    [setPreferences]
  )

  const setGlassEnabled = React.useCallback(
    (glassEnabled: boolean) => {
      setPreferences((current) => ({ ...current, glassEnabled }))
    },
    [setPreferences]
  )

  const setGlassOpacity = React.useCallback(
    (glassOpacity: number) => {
      setPreferences((current) => ({ ...current, glassOpacity }))
    },
    [setPreferences]
  )

  React.useEffect(() => {
    const root = document.documentElement
    const restoreTransitions = disableTransitionOnChange
      ? disableTransitionsTemporarily()
      : null
    if (!disableTransitionOnChange && hasAppliedPreferencesRef.current) {
      root.dataset.themeTransition = "on"
    }
    applyAppearancePreferences(preferences)
    hasAppliedPreferencesRef.current = true
    if (restoreTransitions) {
      restoreTransitions()
    }
    if (root.dataset.themeTransition === "on") {
      const timeout = window.setTimeout(() => {
        delete root.dataset.themeTransition
      }, 180)
      return () => window.clearTimeout(timeout)
    }
    return undefined
  }, [disableTransitionOnChange, preferences, systemTheme])

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) {
        return
      }
      if (event.key !== APPEARANCE_STORAGE_KEY) {
        return
      }
      setPreferencesState(readAppearancePreferences())
    }
    window.addEventListener("storage", handleStorageChange)
    return () => {
      window.removeEventListener("storage", handleStorageChange)
    }
  }, [])

  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return undefined
    }

    const query = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => setSystemTheme(getSystemTheme())
    query.addEventListener("change", handleChange)
    return () => query.removeEventListener("change", handleChange)
  }, [])

  const value = React.useMemo(
    () => ({
      preferences,
      theme: preferences.theme,
      resolvedTheme:
        preferences.theme === "system" ? systemTheme : preferences.theme,
      glassEnabled: preferences.glassEnabled,
      glassOpacity: preferences.glassOpacity,
      setTheme,
      setGlassEnabled,
      setGlassOpacity,
      setPreferences,
    }),
    [
      preferences,
      setGlassEnabled,
      setGlassOpacity,
      setPreferences,
      setTheme,
      systemTheme,
    ]
  )

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext)

  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }

  return context
}

export const useAppearancePreferences = useTheme

export const useOptionalTheme = () => React.useContext(ThemeProviderContext)

export type { AppearancePreferences, ThemePreference }
