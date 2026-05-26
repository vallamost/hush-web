import { describe, it, expect, beforeEach } from "vitest"

import {
  type ChangeAnnouncementEntry,
  type ChangeAnnouncementStorage,
  SEEN_STORAGE_KEY,
  getBrowserStorage,
  isPersistenceAvailable,
  markAnnouncementSeen,
  resolveVisibleAnnouncement,
} from "./changeAnnouncements"

function createMemoryStorage(initial: Record<string, string> = {}): ChangeAnnouncementStorage {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    getItem(key) {
      return map.has(key) ? (map.get(key) as string) : null
    },
    setItem(key, value) {
      map.set(key, value)
    },
  }
}

const baseEntry: ChangeAnnouncementEntry = {
  id: "e1",
  version: "v0.1.0",
  title: "First",
  bullets: ["a"],
  surfaces: ["web", "desktop"],
  enabled: true,
}

describe("resolveVisibleAnnouncement", () => {
  it("returns null when every entry is disabled", () => {
    const storage = createMemoryStorage()
    const entries: ChangeAnnouncementEntry[] = [
      { ...baseEntry, id: "d1", enabled: false },
      { ...baseEntry, id: "d2", enabled: false },
    ]
    const result = resolveVisibleAnnouncement({ surface: "web", entries, storage })
    expect(result).toBeNull()
  })

  it("skips entries whose surface set excludes the current surface", () => {
    const storage = createMemoryStorage()
    const entries: ChangeAnnouncementEntry[] = [
      { ...baseEntry, id: "desktop-only", surfaces: ["desktop"] },
    ]
    expect(
      resolveVisibleAnnouncement({ surface: "web", entries, storage })
    ).toBeNull()
    expect(
      resolveVisibleAnnouncement({ surface: "desktop", entries, storage })?.id
    ).toBe("desktop-only")
  })

  it("skips entries already in the seen list", () => {
    const storage = createMemoryStorage({
      [SEEN_STORAGE_KEY]: JSON.stringify(["seen-1"]),
    })
    const entries: ChangeAnnouncementEntry[] = [
      { ...baseEntry, id: "seen-1" },
    ]
    expect(
      resolveVisibleAnnouncement({ surface: "web", entries, storage })
    ).toBeNull()
  })

  it("picks the newest (last) qualifying entry when several are unseen", () => {
    const storage = createMemoryStorage()
    const entries: ChangeAnnouncementEntry[] = [
      { ...baseEntry, id: "old" },
      { ...baseEntry, id: "newer" },
      { ...baseEntry, id: "newest" },
    ]
    const result = resolveVisibleAnnouncement({ surface: "web", entries, storage })
    expect(result?.id).toBe("newest")
  })

  it("treats malformed seen JSON as empty", () => {
    const storage = createMemoryStorage({ [SEEN_STORAGE_KEY]: "{not valid" })
    const entries: ChangeAnnouncementEntry[] = [baseEntry]
    expect(
      resolveVisibleAnnouncement({ surface: "web", entries, storage })?.id
    ).toBe("e1")
  })
})

describe("markAnnouncementSeen", () => {
  it("persists the id and is idempotent", () => {
    const storage = createMemoryStorage()
    markAnnouncementSeen("entry-a", storage)
    markAnnouncementSeen("entry-a", storage)
    const raw = storage.getItem(SEEN_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual(["entry-a"])
  })

  it("appends without dropping previous ids", () => {
    const storage = createMemoryStorage({
      [SEEN_STORAGE_KEY]: JSON.stringify(["entry-a"]),
    })
    markAnnouncementSeen("entry-b", storage)
    const parsed = JSON.parse(storage.getItem(SEEN_STORAGE_KEY) as string)
    expect(new Set(parsed)).toEqual(new Set(["entry-a", "entry-b"]))
  })

  it("ignores empty ids", () => {
    const storage = createMemoryStorage()
    markAnnouncementSeen("", storage)
    expect(storage.getItem(SEEN_STORAGE_KEY)).toBeNull()
  })
})

describe("storage hardening", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("returns null storage when localStorage throws on access", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked")
      },
    })
    try {
      expect(getBrowserStorage()).toBeNull()
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original)
    }
  })

  it("isPersistenceAvailable is false when setItem throws", () => {
    const broken: ChangeAnnouncementStorage = {
      getItem() {
        return null
      },
      setItem() {
        throw new Error("quota")
      },
    }
    expect(isPersistenceAvailable(broken)).toBe(false)
  })

  it("isPersistenceAvailable is true for a working in-memory store", () => {
    expect(isPersistenceAvailable(createMemoryStorage())).toBe(true)
  })

  it("getBrowserStorage swallows setItem exceptions so callers never crash", () => {
    const original = Object.getOwnPropertyDescriptor(
      window.localStorage,
      "setItem"
    )
    try {
      const proto = Object.getPrototypeOf(window.localStorage) as Storage
      Object.defineProperty(proto, "setItem", {
        configurable: true,
        value: () => {
          throw new Error("quota")
        },
      })
      const storage = getBrowserStorage()
      expect(storage).not.toBeNull()
      expect(() => storage?.setItem("k", "v")).not.toThrow()
    } finally {
      if (original) {
        const proto = Object.getPrototypeOf(window.localStorage) as Storage
        Object.defineProperty(proto, "setItem", original)
      }
    }
  })
})
