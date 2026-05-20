import { afterEach, describe, expect, it } from "vitest"

import {
  applyAppearancePreferences,
  mapGlassControlToCssPercent,
  normalizeAppearancePreferences,
  snapGlassControlValue,
} from "./appearancePreferences"

describe("appearancePreferences", () => {
  afterEach(() => {
    document.documentElement.classList.remove("light", "dark")
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.glass
    document.documentElement.style.removeProperty("--desktop-glass-opacity")
    document.documentElement.style.removeProperty("--desktop-glass-tint-strength")
    document.documentElement.style.removeProperty("--desktop-glass-transparency")
    document.documentElement.style.removeProperty("--desktop-glass-alpha")
  })

  it("maps user-facing glass controls to the bounded CSS range", () => {
    expect(mapGlassControlToCssPercent(0)).toBe(20)
    expect(mapGlassControlToCssPercent(50)).toBe(50)
    expect(mapGlassControlToCssPercent(100)).toBe(80)
  })

  it("snaps glass controls only near magnetic points", () => {
    expect(snapGlassControlValue(23)).toBe(25)
    expect(snapGlassControlValue(27)).toBe(25)
    expect(snapGlassControlValue(30)).toBe(30)
  })

  it("normalizes missing glass transparency to the default", () => {
    expect(
      normalizeAppearancePreferences({
        theme: "dark",
        glassEnabled: true,
        glassOpacity: 60,
      }).glassTransparency
    ).toBe(50)
  })

  it("applies independent glass tint and transparency variables", () => {
    applyAppearancePreferences({
      theme: "dark",
      glassEnabled: true,
      glassOpacity: 60,
      glassTransparency: 50,
    })

    expect(document.documentElement.dataset.glass).toBe("on")
    expect(
      document.documentElement.style.getPropertyValue(
        "--desktop-glass-tint-strength"
      )
    ).toBe("56%")
    expect(
      document.documentElement.style.getPropertyValue(
        "--desktop-glass-transparency"
      )
    ).toBe("50%")
    expect(
      document.documentElement.style.getPropertyValue("--desktop-glass-alpha")
    ).toBe("50%")
  })
})
