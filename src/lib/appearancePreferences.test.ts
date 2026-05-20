import { afterEach, describe, expect, it } from "vitest"

import {
  NO_GLASS_SUPPORT,
  applyAppearancePreferences,
  mapGlassIntensityToSurfaceAlpha,
  mapGlassIntensityToTintPercent,
  normalizeAppearancePreferences,
  normalizeGlassMaterialForCapabilities,
  snapGlassIntensity,
  type GlassCapabilities,
} from "./appearancePreferences"

const darwinCapabilities: GlassCapabilities = {
  platform: "darwin",
  materialSwitchingSupported: true,
  materials: ["auto", "sidebar", "under-window", "menu", "headerView"],
  unsupportedReason: null,
}

const win22h2Capabilities: GlassCapabilities = {
  platform: "win32",
  materialSwitchingSupported: true,
  materials: ["auto", "mica", "acrylic"],
  unsupportedReason: null,
}

const win10Capabilities: GlassCapabilities = {
  platform: "win32",
  materialSwitchingSupported: false,
  materials: [],
  unsupportedReason: "win32-pre-22h2",
}

const linuxCapabilities: GlassCapabilities = {
  platform: "linux",
  materialSwitchingSupported: false,
  materials: [],
  unsupportedReason: "linux-no-native-material",
}

describe("appearancePreferences", () => {
  afterEach(() => {
    document.documentElement.classList.remove("light", "dark")
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.glass
    document.documentElement.style.removeProperty(
      "--desktop-glass-tint-strength"
    )
    document.documentElement.style.removeProperty("--desktop-glass-alpha")
  })

  it("maps intensity into the safe tint strength envelope", () => {
    expect(mapGlassIntensityToTintPercent(0)).toBe(75)
    expect(mapGlassIntensityToTintPercent(50)).toBe(55)
    expect(mapGlassIntensityToTintPercent(100)).toBe(35)
  })

  it("maps intensity into a surface alpha bounded by the legibility floor", () => {
    expect(mapGlassIntensityToSurfaceAlpha(0)).toBe(85)
    expect(mapGlassIntensityToSurfaceAlpha(50)).toBe(60)
    expect(mapGlassIntensityToSurfaceAlpha(100)).toBe(35)
  })

  it("never lets the surface alpha collapse below the legibility floor", () => {
    for (let intensity = 0; intensity <= 100; intensity += 1) {
      expect(mapGlassIntensityToSurfaceAlpha(intensity)).toBeGreaterThanOrEqual(
        35
      )
    }
  })

  it("snaps intensity only near magnetic points", () => {
    expect(snapGlassIntensity(24)).toBe(25)
    expect(snapGlassIntensity(26)).toBe(25)
    expect(snapGlassIntensity(23)).toBe(23)
    expect(snapGlassIntensity(30)).toBe(30)
  })

  it("normalizes missing intensity to the default", () => {
    expect(
      normalizeAppearancePreferences({
        theme: "dark",
        glassEnabled: true,
      }).glassIntensity
    ).toBe(25)
  })

  it("defaults new installs to dark theme + glass enabled at magnet point 2 (25)", () => {
    expect(normalizeAppearancePreferences(null)).toMatchObject({
      theme: "dark",
      glassEnabled: true,
      glassIntensity: 25,
      glassMaterial: "auto",
    })
  })

  it("migrates legacy glassOpacity/glassTransparency into a single intensity", () => {
    const result = normalizeAppearancePreferences({
      theme: "dark",
      glassEnabled: true,
      glassOpacity: 60,
      glassTransparency: 80,
    })
    expect(result.glassIntensity).toBe(80)
    expect("glassOpacity" in result).toBe(false)
    expect("glassTransparency" in result).toBe(false)
  })

  it("applies safe glass CSS variables on the root", () => {
    applyAppearancePreferences({
      theme: "dark",
      glassEnabled: true,
      glassIntensity: 50,
      glassMaterial: "auto",
    })

    expect(document.documentElement.dataset.glass).toBe("on")
    expect(
      document.documentElement.style.getPropertyValue(
        "--desktop-glass-tint-strength"
      )
    ).toBe("55%")
    expect(
      document.documentElement.style.getPropertyValue("--desktop-glass-alpha")
    ).toBe("60%")
  })

  it("rejects unknown glass material identifiers", () => {
    const result = normalizeAppearancePreferences({
      theme: "dark",
      glassEnabled: true,
      glassIntensity: 50,
      glassMaterial: "obviously-fake" as never,
    })
    expect(result.glassMaterial).toBe("auto")
  })

  it("falls back to auto when material switching is unsupported", () => {
    expect(
      normalizeGlassMaterialForCapabilities("mica", linuxCapabilities)
    ).toBe("auto")
    expect(
      normalizeGlassMaterialForCapabilities("sidebar", win10Capabilities)
    ).toBe("auto")
    expect(normalizeGlassMaterialForCapabilities("sidebar", null)).toBe("auto")
  })

  it("collapses stale cross-platform stored materials onto auto", () => {
    expect(
      normalizeGlassMaterialForCapabilities("mica", darwinCapabilities)
    ).toBe("auto")
    expect(
      normalizeGlassMaterialForCapabilities("sidebar", win22h2Capabilities)
    ).toBe("auto")
  })

  it("keeps a supported material untouched", () => {
    expect(
      normalizeGlassMaterialForCapabilities("under-window", darwinCapabilities)
    ).toBe("under-window")
    expect(
      normalizeGlassMaterialForCapabilities("acrylic", win22h2Capabilities)
    ).toBe("acrylic")
  })
})
