/**
 * Change announcement engine.
 *
 * Drives the small "What's new" popup that can surface concise release
 * notes after selected updates. The popup is opt-in per release: an
 * entry only renders when explicitly enabled in `CHANGE_ANNOUNCEMENTS`,
 * its `surfaces` set covers the current runtime (web or desktop), and
 * the local "seen" marker for its `id` is absent.
 *
 * Pure logic + a defensive localStorage wrapper. UI lives in
 * `components/change-announcement-dialog.tsx`. React glue lives in
 * `hooks/useChangeAnnouncement.ts`.
 *
 * Telemetry: none. Seen markers are local-only, anonymous, and never
 * leave the device.
 */

import { getDesktopBridge } from "@/lib/desktopBridge"

export type ChangeAnnouncementSurface = "web" | "desktop"

export interface ChangeAnnouncementLink {
  readonly label: string
  readonly href: string
}

/** Surface-aware external changelog target (web vs desktop client). */
export interface ChangeAnnouncementChangelog {
  readonly web: string
  readonly desktop: string
}

export interface ChangeAnnouncementEntry {
  /** Stable id used as the local "seen" marker. Never reused. */
  readonly id: string
  /** Subdued label shown in the dialog header, e.g. `v0.1.38-mvp`. */
  readonly version: string
  /**
   * Optional short title shown above the body. Omit it when the dialog
   * header ("What's new") already conveys the heading, so the text does not
   * repeat "What's new".
   */
  readonly title?: string
  /** Optional 1-line body shown below the title. */
  readonly body?: string
  /**
   * Optional caution shown as a warning block between the body and the
   * bullets (e.g. the desktop auto-update caveat).
   */
  readonly warning?: string
  /** Concise bullets. Keep to <=5 entries, each one short sentence. */
  readonly bullets: readonly string[]
  /** Runtime surfaces this entry should appear on. */
  readonly surfaces: readonly ChangeAnnouncementSurface[]
  /** Hard switch. Disabled entries are ignored even if unseen. */
  readonly enabled: boolean
  /** Optional external changelog link, resolved per surface in the dialog. */
  readonly changelog?: ChangeAnnouncementChangelog
  /** Optional external download link. */
  readonly download?: ChangeAnnouncementLink
  /** Legacy single quiet link. Retained for older (disabled) entries. */
  readonly link?: ChangeAnnouncementLink
}

/** Storage key holding the JSON array of seen entry ids. */
export const SEEN_STORAGE_KEY = "hush.changeAnnouncements.seen"

/**
 * Window event asking the app shell to re-open the latest "What's new" note,
 * even if it was already dismissed. Dispatched by the persistent What's new
 * affordance in the desktop topbar; handled where the dialog is owned.
 */
export const OPEN_WHATS_NEW_EVENT = "hush:open-whats-new"

/**
 * Authored list of announcements.
 *
 * Ordering is significant: the resolver picks the last matching entry,
 * so newest must be appended at the bottom. Disable entries instead of
 * deleting them so the seen marker keeps protecting users that already
 * dismissed an older variant.
 *
 * The sample below ships disabled. To enable a future entry: flip
 * `enabled` to `true`, bump `id` (never reuse), and update `version`
 * to match the targeted release.
 */
export const CHANGE_ANNOUNCEMENTS: readonly ChangeAnnouncementEntry[] = [
  {
    id: "sample-2026-05-26",
    version: "v0.1.38-mvp",
    title: "Hush has been updated",
    bullets: [
      "Desktop updates can now be checked from Settings.",
      "Bug reports include clearer anonymous diagnostics.",
      "Voice capture cleanup is more predictable after leaving a channel.",
    ],
    surfaces: ["web", "desktop"],
    enabled: false,
  },
  {
    // Superseded by whats-new-2026-05-29b (richer content). Kept disabled so
    // its seen marker still protects users who dismissed this variant.
    id: "founder-note-2026-05-29",
    version: "v0.7.0-alpha.19",
    title: "A note from the founder",
    body: "Hush is a solo project, and traffic is booming. Thank you for trying it.",
    bullets: [
      "I'm working through your reports and issues in the evenings after my day job.",
      "Please be patient: fixes are on the way.",
      "I'm looking for collaborators and active maintainers. Reach out if you're interested.",
      "All the love xx",
    ],
    surfaces: ["web", "desktop"],
    enabled: false,
  },
  {
    // Superseded by whats-new-2026-06-02. Kept disabled so its seen marker
    // still protects users who dismissed this variant.
    id: "whats-new-2026-05-29b",
    version: "v0.7.0-alpha.19",
    title: "What's new",
    body: "A note from the founder: Hush is a solo project and traffic is booming. Thank you for trying it, and please be patient while I work through your reports after my day job.",
    bullets: [
      "Invite links opened in a browser now show clear join instructions instead of a confusing server message.",
      "Hush now tells you when the instance you are on runs an outdated server, so you can ask its admin to update.",
      "The Windows desktop app cannot auto-update yet. If it asks to restart but stays on the old version, download the latest manually from the releases page.",
      "Looking for collaborators and active maintainers. Reach out if you are interested. All the love xx",
    ],
    surfaces: ["web", "desktop"],
    enabled: false,
    link: {
      label: "Download the latest desktop release",
      href: "https://github.com/hushhq/hush-desktop/releases/latest",
    },
  },
  {
    id: "whats-new-2026-06-02",
    version: "v0.7.0-alpha.27",
    // FOUNDER NOTE - DO NOT REMOVE OR PARAPHRASE without the founder's say-so.
    // This is intentional copy from the founder and must stay verbatim.
    body:
      "A note from the founder: Hush is a solo project and traffic is booming. " +
      "Thank you for trying it, and please be patient while I work through your " +
      "reports after my day job.",
    warning:
      "The Windows and Linux desktop app cannot auto-update yet. If it asks to " +
      "restart but stays on the old version, download the latest manually.",
    bullets: [
      "Voice channels now play a sound when someone joins or leaves, and when a screen-share starts or ends.",
      "Screen sharing now works on the macOS desktop app.",
      "Fixed voice and video calls where people sometimes could not hear or see each other.",
      "Device linking now recovers from a stuck \"transfer slot occupied\" error.",
    ],
    surfaces: ["web", "desktop"],
    enabled: true,
    changelog: {
      web: "https://github.com/hushhq/hush-web/blob/main/CHANGELOG.md",
      desktop: "https://github.com/hushhq/hush-desktop/releases",
    },
    download: {
      label: "Download",
      href: "https://gethush.live/#downloads",
    },
  },
]

/**
 * Minimal subset of the `Storage` interface the resolver needs. Keeping
 * the contract narrow lets tests inject an in-memory fake without
 * stubbing the entire DOM `localStorage`.
 */
export interface ChangeAnnouncementStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Wraps `window.localStorage` so a hostile environment (private mode,
 * disabled storage, quota exceptions) never crashes the renderer.
 *
 * Failure semantics:
 *   - reads return `null` so the resolver treats every entry as unseen
 *     **only if** writes also work; the caller must verify with
 *     {@link isPersistenceAvailable} before showing the popup, because
 *     showing a popup that cannot persist its dismissal would re-prompt
 *     the user on every refresh.
 *   - writes silently swallow exceptions; the hook checks persistence
 *     and refuses to render when writes are not viable.
 */
export function getBrowserStorage(): ChangeAnnouncementStorage | null {
  if (typeof window === "undefined") return null
  try {
    const candidate = window.localStorage
    if (!candidate) return null
    return {
      getItem(key) {
        try {
          return candidate.getItem(key)
        } catch {
          return null
        }
      },
      setItem(key, value) {
        try {
          candidate.setItem(key, value)
        } catch {
          /* swallow: caller already gated on isPersistenceAvailable */
        }
      },
    }
  } catch {
    return null
  }
}

const PERSISTENCE_PROBE_KEY = `${SEEN_STORAGE_KEY}.__probe__`

/**
 * Verifies a real round-trip write works. Required because some browsers
 * expose `localStorage` but throw on `setItem` (private mode, full
 * quota, blocked third-party storage). The probe is cleaned up before
 * returning, leaving no residue.
 */
export function isPersistenceAvailable(
  storage: ChangeAnnouncementStorage | null
): boolean {
  if (!storage) return false
  const probeValue = String(Date.now())
  try {
    storage.setItem(PERSISTENCE_PROBE_KEY, probeValue)
    const echo = storage.getItem(PERSISTENCE_PROBE_KEY)
    if (echo !== probeValue) return false
    storage.setItem(PERSISTENCE_PROBE_KEY, "")
    return true
  } catch {
    return false
  }
}

function readSeenIds(storage: ChangeAnnouncementStorage): ReadonlySet<string> {
  const raw = storage.getItem(SEEN_STORAGE_KEY)
  if (!raw) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set()
  }
  if (!Array.isArray(parsed)) return new Set()
  const ids = new Set<string>()
  for (const value of parsed) {
    if (typeof value === "string" && value.length > 0) ids.add(value)
  }
  return ids
}

function writeSeenIds(
  storage: ChangeAnnouncementStorage,
  ids: ReadonlySet<string>
): void {
  storage.setItem(SEEN_STORAGE_KEY, JSON.stringify(Array.from(ids)))
}

/**
 * Detects whether the renderer is running inside the Electron shell.
 * Reuses the canonical bridge so the rest of the app keeps a single
 * source of truth for desktop detection.
 */
export function detectSurface(): ChangeAnnouncementSurface {
  return getDesktopBridge() ? "desktop" : "web"
}

export interface ResolveOptions {
  readonly surface: ChangeAnnouncementSurface
  readonly entries?: readonly ChangeAnnouncementEntry[]
  readonly storage: ChangeAnnouncementStorage
}

/**
 * Returns the entry that should be shown, or `null` if nothing
 * qualifies. Resolution rules (applied in order):
 *
 *   1. Drop disabled entries.
 *   2. Drop entries whose `surfaces` do not include the current surface.
 *   3. Drop entries already in the seen set.
 *   4. From whatever remains, pick the last one in array order so the
 *      newest unseen entry wins.
 */
export function resolveVisibleAnnouncement(
  options: ResolveOptions
): ChangeAnnouncementEntry | null {
  const { surface, storage } = options
  const entries = options.entries ?? CHANGE_ANNOUNCEMENTS
  const seen = readSeenIds(storage)

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry.enabled) continue
    if (!entry.surfaces.includes(surface)) continue
    if (seen.has(entry.id)) continue
    return entry
  }
  return null
}

/**
 * Returns the newest enabled entry for `surface`, ignoring the seen set.
 *
 * Used by the manual "What's new" re-open affordance: the auto-resolver only
 * surfaces unseen entries, but a user clicking the persistent icon expects to
 * re-read the latest note even after dismissing it. Returns null when no
 * enabled entry targets the surface.
 */
export function getLatestAnnouncement(
  surface: ChangeAnnouncementSurface,
  entries: readonly ChangeAnnouncementEntry[] = CHANGE_ANNOUNCEMENTS
): ChangeAnnouncementEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry.enabled) continue
    if (!entry.surfaces.includes(surface)) continue
    return entry
  }
  return null
}

/**
 * Persists the seen marker for `id`. Idempotent.
 */
export function markAnnouncementSeen(
  id: string,
  storage: ChangeAnnouncementStorage
): void {
  if (!id) return
  const current = readSeenIds(storage)
  if (current.has(id)) return
  const next = new Set(current)
  next.add(id)
  writeSeenIds(storage, next)
}
