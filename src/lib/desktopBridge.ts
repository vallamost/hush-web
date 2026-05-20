import type { DesktopPlatform, GlassMaterial } from "./appearancePreferences"

/**
 * Narrow shape the web app actually consumes from the Electron preload
 * bridge. Mirrors the methods declared in `hush-desktop/src/shared/desktop-api.ts`
 * but only the ones the renderer code touches. Keeping the shape local
 * here avoids the web build pulling in Electron-only types.
 */
export interface DesktopBridge {
  readonly isDesktop: true
  readonly platform: DesktopPlatform
  setGlassMaterial?: (material: GlassMaterial) => Promise<void>
}

/**
 * Returns the desktop bridge if the renderer is running inside the Hush
 * Electron shell, otherwise `null`. Browser builds never receive the
 * bridge — every caller must tolerate `null`.
 */
export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null
  const candidate = (window as unknown as { hushDesktop?: DesktopBridge })
    .hushDesktop
  if (!candidate) return null
  if (candidate.isDesktop !== true) return null
  return candidate
}
