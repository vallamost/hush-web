import * as React from "react"
import { describe, it, expect } from "vitest"
import { act, render } from "@testing-library/react"

import {
  type ChangeAnnouncementEntry,
  type ChangeAnnouncementStorage,
  SEEN_STORAGE_KEY,
} from "@/lib/changeAnnouncements"
import { useChangeAnnouncement } from "./useChangeAnnouncement"

function createMemoryStorage(
  initial: Record<string, string> = {}
): ChangeAnnouncementStorage {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

interface ProbeResult {
  entry: ChangeAnnouncementEntry | null
  dismiss: () => void
}

function Probe({
  isReady,
  storage,
  entries,
  onResult,
}: {
  isReady: boolean
  storage: ChangeAnnouncementStorage | null
  entries: ChangeAnnouncementEntry[]
  onResult: (value: ProbeResult) => void
}) {
  const result = useChangeAnnouncement({
    isReady,
    storage,
    surface: "web",
    entries,
  })
  React.useEffect(() => {
    onResult(result)
  }, [result, onResult])
  return null
}

const entries: ChangeAnnouncementEntry[] = [
  {
    id: "first",
    version: "v0.1.0",
    title: "First",
    bullets: ["a"],
    surfaces: ["web"],
    enabled: true,
  },
]

describe("useChangeAnnouncement", () => {
  it("does not resolve when isReady is false", () => {
    const storage = createMemoryStorage()
    const capture: { current: ProbeResult | null } = { current: null }
    render(
      <Probe
        isReady={false}
        storage={storage}
        entries={entries}
        onResult={(value) => {
          capture.current = value
        }}
      />
    )
    expect(capture.current?.entry).toBeNull()
  })

  it("resolves the visible entry once isReady becomes true", () => {
    const storage = createMemoryStorage()
    const capture: { current: ProbeResult | null } = { current: null }
    const { rerender } = render(
      <Probe
        isReady={false}
        storage={storage}
        entries={entries}
        onResult={(value) => {
          capture.current = value
        }}
      />
    )
    expect(capture.current?.entry).toBeNull()
    rerender(
      <Probe
        isReady={true}
        storage={storage}
        entries={entries}
        onResult={(value) => {
          capture.current = value
        }}
      />
    )
    expect(capture.current?.entry?.id).toBe("first")
  })

  it("dismiss persists the seen id and clears the entry", () => {
    const storage = createMemoryStorage()
    const capture: { current: ProbeResult | null } = { current: null }
    render(
      <Probe
        isReady={true}
        storage={storage}
        entries={entries}
        onResult={(value) => {
          capture.current = value
        }}
      />
    )
    expect(capture.current?.entry?.id).toBe("first")
    act(() => {
      capture.current?.dismiss()
    })
    expect(capture.current?.entry).toBeNull()
    const seen = JSON.parse(storage.getItem(SEEN_STORAGE_KEY) ?? "[]")
    expect(seen).toContain("first")
  })

  it("refuses to render when persistence is not viable", () => {
    const brokenStorage: ChangeAnnouncementStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota")
      },
    }
    const capture: { current: ProbeResult | null } = { current: null }
    render(
      <Probe
        isReady={true}
        storage={brokenStorage}
        entries={entries}
        onResult={(value) => {
          capture.current = value
        }}
      />
    )
    expect(capture.current?.entry).toBeNull()
  })

  it("returns null when storage itself is unavailable", () => {
    const capture: { current: ProbeResult | null } = { current: null }
    render(
      <Probe
        isReady={true}
        storage={null}
        entries={entries}
        onResult={(value) => {
          capture.current = value
        }}
      />
    )
    expect(capture.current?.entry).toBeNull()
  })
})
